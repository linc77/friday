import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall, type Credential } from '@earendil-works/pi-ai';
import { Engine } from '../src/engine.js';
import { ModelCredentials } from '../src/model.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Executor, Workspace } from '../src/types.js';

const noCodex: Executor = { run: async () => { throw new Error('Codex must not run'); }, answer: async () => {}, steer: async () => {} };
const input = (requestId: string) => ({ prompt: '请记住我喜欢中文回答，并收集下周整理读书笔记的想法', mode: 'assistant' as const, projectId: null, requestId });
async function until(engine: Engine, predicate: (s: Workspace) => boolean) {
  const limit = Date.now() + 8000;
  while (Date.now() < limit) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('State transition timed out: ' + JSON.stringify((await engine.snapshot()).tasks.map(t => ({ status: t.status, error: t.error }))));
}
function model() {
  const faux = fauxProvider({ tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } };
}
test('Friday owns the model/tool loop and persistent conversation without a Codex installation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-native-')); const { faux, options } = model();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('remember', { text: '喜欢中文回答' }), fauxToolCall('save_idea', { text: '下周整理读书笔记' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('记住了，想法也已保存。'),
    ctx => { assert.ok(JSON.stringify(ctx).includes('记住了，想法也已保存。')); return fauxAssistantMessage('之前你让我记住中文偏好。'); },
  ]);
  let engine = await new Engine(directory, noCodex, options).open();
  const auth = new Auth(directory);
  try {
    const app = createAPI(engine, auth, () => []);
    const response = await app.request('/api/tasks', { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input('native')) });
    assert.equal(response.status, 201);
    const id = (await response.json()).id;
    let state = await until(engine, s => s.tasks[0]?.status === 'completed');
    assert.equal(state.tasks[0].agent, 'friday'); assert.equal(state.tasks[0].threadId, null);
    assert.ok(state.tasks[0].conversationId); assert.equal(state.memories[0].text, '喜欢中文回答'); assert.equal(state.ideas.length, 1);
    assert.equal(faux.state.callCount, 2); assert.equal(await engine.createTask(input('native')), id);
    assert.equal(state.tasks[0].messages?.filter(m => m.role === 'user').length, 1);
    const conversationId = state.tasks[0].conversationId;
    await engine.close(); engine = await new Engine(directory, noCodex, options).open();
    await engine.createTask({ ...input('continue-native'), prompt: '我之前说过什么？', continueId: id });
    state = await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(state.tasks[0].conversationId, conversationId);
    assert.equal(state.tasks[0].messages?.filter(m => m.role === 'user').length, 2);
    assert.match(await engine.artifact(id), /中文偏好/);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Native file tools enforce project boundaries and persist explicit approval before writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-files-')); const project = await mkdtemp(join(tmpdir(), 'friday-project-')); const outside = await mkdtemp(join(tmpdir(), 'friday-outside-'));
  await writeFile(join(outside, 'secret.txt'), 'private'); await symlink(outside, join(project, 'escape'));
  const { faux, options } = model();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'escape/secret.txt' }), { stopReason: 'toolUse' }),
    ctx => { const data = JSON.stringify(ctx); assert.match(data, /路径超出关联项目/); assert.ok(!data.includes('private')); return fauxAssistantMessage(fauxToolCall('write_file', { path: 'hello.md', content: 'Hello Friday' }), { stopReason: 'toolUse' }); },
    fauxAssistantMessage('文件写好了。'),
  ]);
  const engine = await new Engine(directory, noCodex, options).open();
  try {
    await engine.mutate(s => { s.projects.push({ id: 'project', name: 'Project', path: project, context: '' }); });
    const id = await engine.createTask({ ...input('write'), mode: 'code', projectId: 'project' });
    const state = await until(engine, s => s.tasks[0]?.status === 'waiting');
    await assert.rejects(readFile(join(project, 'hello.md')), /ENOENT/);
    const approval = state.tasks[0].approvals.find(a => a.state === 'pending')!;
    assert.equal(approval.detail, 'Hello Friday');
    await engine.answer(id, approval.id, 'accept', {});
    await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(await readFile(join(project, 'hello.md'), 'utf8'), 'Hello Friday');
  } finally { await engine.close(); await Promise.all([directory, project, outside].map(p => rm(p, { recursive: true, force: true }))); }
});

test('Direct conversation requests a workspace, releases the queue, and resumes the same native conversation after selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-native-workspace-')); const project = await mkdtemp(join(tmpdir(), 'friday-native-project-'));
  const { faux, options } = model(); let codexCalls = 0;
  const executor: Executor = { ...noCodex, run: async () => { codexCalls++; throw new Error('Unexpected delegation'); } };
  faux.setResponses([
    ctx => { assert.match(JSON.stringify(ctx), /explicitly delegated/); return fauxAssistantMessage(fauxToolCall('read_file', { projectId: 'existing', path: 'draft.md' }), { stopReason: 'toolUse' }); },
    ctx => { assert.match(JSON.stringify(ctx), /等待用户选择工作目录/); return fauxAssistantMessage([{ type: 'text', text: '请选择要保存文件的目录。' }, fauxToolCall('friday_request_workspace', { reason: '需要你选择保存文件的目录' })], { stopReason: 'toolUse' }); },
    fauxAssistantMessage(fauxToolCall('save_idea', { text: '下周整理笔记，先不执行' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('记下了。'),
    ctx => { const data = JSON.stringify(ctx); assert.match(data, /请创建 draft.md/); assert.ok(data.includes(project)); return fauxAssistantMessage(fauxToolCall('write_file', { path: 'draft.md', content: 'Friday owns this conversation.' }), { stopReason: 'toolUse' }); },
    fauxAssistantMessage('已创建 draft.md。'),
  ]);
  let engine = await new Engine(directory, executor, options).open(); const auth = new Auth(directory);
  let app = createAPI(engine, auth, () => []);
  const request = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await engine.mutate(s => { s.projects.push({ id: 'existing', name: 'Project', path: project, context: '' }); });
    await request('/api/ideas', { id: 'delegated', text: '请创建 draft.md' });
    const created = await request('/api/tasks', { prompt: '请创建 draft.md', ideaId: 'delegated', requestId: 'direct' });
    assert.equal(created.status, 201); const id = (await created.json()).id;
    assert.equal((await (await request('/api/tasks', { prompt: '请创建 draft.md', ideaId: 'delegated', requestId: 'second-click' })).json()).id, id);
    let state = await until(engine, s => s.tasks[0]?.status === 'needs_project');
    const conversationId = state.tasks[0].conversationId;
    assert.equal(state.tasks[0].mode, 'auto'); assert.equal(state.tasks[0].artifact, null); assert.equal(faux.state.callCount, 2);
    await engine.close(); engine = await new Engine(directory, executor, options).open(); app = createAPI(engine, auth, () => []);
    const capture = await request('/api/tasks', { prompt: '下周整理笔记，先记下不要执行', requestId: 'capture' });
    const captureId = (await capture.json()).id;
    await until(engine, s => s.tasks.find(t => t.id === captureId)?.status === 'completed');
    const selection = { projectId: 'existing', requestId: 'select' };
    assert.equal((await request(`/api/tasks/${id}/workspace`, selection)).status, 200);
    assert.equal((await request(`/api/tasks/${id}/workspace`, selection)).status, 200);
    state = await until(engine, s => s.tasks[0].status === 'waiting');
    await assert.rejects(readFile(join(project, 'draft.md')), /ENOENT/);
    await engine.answer(id, state.tasks[0].approvals.find(a => a.state === 'pending')!.id, 'accept', {});
    state = await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(state.tasks[0].conversationId, conversationId); assert.equal(state.tasks[0].workspaceRequest, null);
    assert.equal(state.tasks[0].messages?.filter(m => m.role === 'user').length, 2);
    assert.equal(state.ideas.length, 2); assert.equal(state.ideas.find(i => i.id !== 'delegated')?.taskId, null);
    assert.equal(await readFile(join(project, 'draft.md'), 'utf8'), 'Friday owns this conversation.');
    assert.equal(codexCalls, 0); assert.equal(faux.state.callCount, 6);
  } finally { await engine.close(); auth.close(); await Promise.all([directory, project].map(p => rm(p, { recursive: true, force: true }))); }
});

test('Friday resumes a pending question after restart and cancels its own model run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-question-')); const { faux, options } = model();
  faux.setResponses([fauxAssistantMessage(fauxToolCall('ask_user', { question: '哪天整理？' }), { stopReason: 'toolUse' }), fauxAssistantMessage('周六整理。'), fauxAssistantMessage(fauxToolCall('ask_user', { question: '还要做什么？' }), { stopReason: 'toolUse' })]);
  let engine = await new Engine(directory, noCodex, options).open();
  try {
    const id = await engine.createTask(input('question'));
    const waiting = await until(engine, s => s.tasks[0]?.status === 'waiting');
    const approvalId = waiting.tasks[0].approvals[0].id;
    await engine.close(); engine = await new Engine(directory, noCodex, options).open();
    await until(engine, s => s.tasks[0].status === 'waiting');
    await engine.answer(id, approvalId, 'accept', { answer: ['周六'] });
    await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(faux.state.callCount, 2);
    await engine.createTask({ ...input('cancel'), continueId: id });
    await until(engine, s => s.tasks[0].status === 'waiting');
    await engine.cancel(id); assert.equal((await engine.snapshot()).tasks[0].status, 'cancelled');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Credential storage stays private and paired devices cannot change the model key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-oauth-')); const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  try {
    const file = join(directory, 'test-auth.json'); const store = new ModelCredentials(file);
    const credential: Credential = { type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: 100 };
    await store.modify('openai', async () => credential);
    await Promise.all(Array.from({ length: 3 }, () => store.modify('openai', async value => ({ ...credential, expires: Number((value as any).expires) + 1 }))));
    assert.equal((await store.read('openai') as any).expires, 103); assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await store.list(), [{ providerId: 'openai', type: 'oauth' }]);
    const app = createAPI(engine, auth, () => []); const paired = auth.pair(auth.createPairing().code, 'phone', 'test');
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' };
    const state = await (await app.request('/api/model', { headers })).json();
    assert.equal(state.connected, false); assert.equal(state.login, undefined);
    assert.equal((await app.request('/api/model/key', { method: 'PUT', headers, body: '{}' })).status, 403);
    await assert.rejects(engine.createTask(input('no-login')), /DeepSeek API Key/);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Interrupted delegated side effects are not replayed by the native loop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-delegation-')); const { faux, options } = model();
  let calls = 0;
  const executor: Executor = { ...noCodex, run: async request => {
    calls++; await request.update({ kind: 'session', threadId: 'persist-before-work' });
    await writeFile(join(directory, 'side-effect'), 'already done');
    request.signal.throwIfAborted();
    await new Promise<void>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
    return 'unreachable';
  } };
  faux.setResponses([fauxAssistantMessage(fauxToolCall('delegate_codex', { task: 'Implement the requested change' }), { stopReason: 'toolUse' }),
    ctx => { assert.match(JSON.stringify(ctx), /interrupted/i); return fauxAssistantMessage('外部调用已中断，需要先核对结果。'); }]);
  let engine = await new Engine(directory, executor, options).open();
  try {
    await engine.mutate(s => { s.projects.push({ id: 'project', name: 'Project', path: directory, context: '' }); });
    const id = await engine.createTask({ ...input('delegate'), mode: 'code', projectId: 'project' });
    const waiting = await until(engine, s => s.tasks[0]?.status === 'waiting');
    assert.equal(calls, 0);
    await engine.answer(id, waiting.tasks[0].approvals[0].id, 'accept', {});
    await until(engine, s => s.tasks[0].threadId === 'persist-before-work');
    await engine.close(); engine = await new Engine(directory, executor, options).open();
    await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(calls, 1); assert.equal(await readFile(join(directory, 'side-effect'), 'utf8'), 'already done');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A project edit made while approval is pending is preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-edit-race-')); const { faux, options } = model();
  const file = join(directory, 'draft.md'); await writeFile(file, 'original');
  faux.setResponses([fauxAssistantMessage(fauxToolCall('write_file', { path: 'draft.md', content: 'proposed replacement' }), { stopReason: 'toolUse' }),
    ctx => { assert.match(JSON.stringify(ctx), /等待授权期间文件发生变化/); return fauxAssistantMessage('保留了你的最新修改。'); }]);
  const engine = await new Engine(directory, noCodex, options).open();
  try {
    await engine.mutate(s => { s.projects.push({ id: 'project', name: 'Project', path: directory, context: '' }); });
    const id = await engine.createTask({ ...input('edit-race'), mode: 'code', projectId: 'project' });
    const state = await until(engine, s => s.tasks[0]?.status === 'waiting');
    await writeFile(file, 'new user content');
    await engine.answer(id, state.tasks[0].approvals[0].id, 'accept', {});
    await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(await readFile(file, 'utf8'), 'new user content');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
