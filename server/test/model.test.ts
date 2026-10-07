import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, symlink, readlink, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { ModelCredentials } from '../src/model.js';
import { CodexConnection } from '../src/codex-provider.js';
import { defaultCodexSettings, parseLaunchArgs, saveCodexSettings, codexRuntime } from '../src/codex-settings.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Workspace } from '../src/types.js';

const binaryPath = fileURLToPath(new URL('fixtures/codex-provider.mjs', import.meta.url));
const config = (homePath: string) => ({ ...defaultCodexSettings, binaryPath, homePath, displayName: 'Personal Codex', model: 'second', reasoningEffort: 'high', launchArgs: '-c \'example="two words"\'', environment: [{ name: 'RUNTIME_TEST', value: 'private-test-value' }] });
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  for (let i = 0; i < 500; i++) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Task did not settle');
}

test('Codex probe paginates models, detects auth, redacts environment and preserves previous credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-codex-provider-')); const connection = new CodexConnection(directory);
  try {
    const credentials = new ModelCredentials(join(directory, 'model-auth.json'));
    await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'old-key' }));
    const state = await connection.save(config(directory));
    assert.equal(state.provider, 'Codex'); assert.equal(state.version, '0.160.0'); assert.equal(state.connected, true);
    assert.equal(state.account?.email, 'test@example.com'); assert.deepEqual(state.models.map(m => m.id), ['first', 'second']);
    assert.equal(state.model, 'second'); assert.ok(!JSON.stringify(state).includes('private-test-value'));
    assert.equal((await connection.status()).settings, null); assert.equal((await connection.status()).account?.email, null);
    assert.equal((await stat(join(directory, 'codex-provider.json'))).mode & 0o777, 0o600);
    assert.equal((await credentials.read('deepseek') as any).key, 'old-key');
    await connection.save({ ...state.settings, environment: [{ name: 'RUNTIME_TEST', value: null }] });
    assert.equal((await connection.runtime()).env.RUNTIME_TEST, 'private-test-value');
    const wire = await readFile(join(directory, 'wire.jsonl'), 'utf8'); assert.match(wire, /"cursor":"next"/);
    const before = await readFile(join(directory, 'codex-provider.json'), 'utf8');
    await assert.rejects(connection.save({ ...config(directory), launchArgs: '--listen tcp://example' }), /--listen/);
    assert.equal(await readFile(join(directory, 'codex-provider.json'), 'utf8'), before);
    await connection.save({ ...config(directory), enabled: false }); await assert.rejects(connection.ready(), /启用/);
    await connection.save({ ...config(directory), environment: [{ name: 'FRIDAY_TEST_AUTH', value: 'none' }] });
    await assert.rejects(connection.ready(), /尚未登录/);
    const login = await connection.login(); assert.equal(new URL(login.url).hostname, 'auth.openai.com');
    assert.equal((await connection.status()).loginPending, true);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Codex shadow home shares config and sessions while protecting independent credentials and existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'friday-shadow-')); const shared = join(root, 'shared'); const shadow = join(root, 'shadow');
  try {
    await mkdir(shared); await mkdir(join(shared, 'sessions')); await writeFile(join(shared, 'config.toml'), 'model="test"'); await writeFile(join(shared, 'auth.json'), 'secret');
    await codexRuntime({ ...config(shared), shadowHomePath: shadow });
    assert.equal(await readlink(join(shadow, 'config.toml')), join(shared, 'config.toml'));
    await assert.rejects(stat(join(shadow, 'auth.json')), { code: 'ENOENT' });
    await symlink(join(shared, 'auth.json'), join(shadow, 'auth.json'));
    await assert.rejects(codexRuntime({ ...config(shared), shadowHomePath: shadow }), /独立保存/);
    await rm(join(shadow, 'auth.json')); await rm(join(shadow, 'config.toml')); await writeFile(join(shadow, 'config.toml'), 'personal');
    await assert.rejects(codexRuntime({ ...config(shared), shadowHomePath: shadow }), /不会覆盖/);
    assert.equal(await readFile(join(shadow, 'config.toml'), 'utf8'), 'personal');
    assert.deepEqual(parseLaunchArgs('-c \'key="two words"\' "$(echo safe)"'), ['-c', 'key="two words"', '$(echo safe)']);
    assert.throws(() => parseLaunchArgs("'unclosed"), /未闭合/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Local tool settings are owner-only and drive independent durable tasks, continuation and model selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-codex-loop-')); let engine = await new Engine(directory).open(); const auth = new Auth(directory);
  try {
    await saveCodexSettings(directory, config(directory));
    const app = createAPI(engine, auth, () => []); const paired = auth.pair(auth.createPairing().code, 'phone', 'test');
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const remote = { ...headers, Authorization: `Bearer ${paired.token}` };
    for (const path of ['settings', 'login', 'check']) assert.equal((await app.request('/api/agents/codex/' + path, { method: path === 'settings' ? 'PUT' : 'POST', headers: remote, body: '{}' })).status, 403);
    assert.equal((await app.request('/api/model', { headers })).status, 200);
    const publicState = await (await app.request('/api/agents/codex', { headers: remote })).json(); assert.equal(publicState.settings, null); assert.equal(publicState.account.email, null);
    await engine.mutate(s => { s.projects.push({ id: 'project', name: 'Project', path: directory, context: '' }); });
    const id = await engine.createTask({ prompt: '你好', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'first', model: 'first', reasoningEffort: 'high' });
    let state = await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(state.tasks[0].threadId, 'provider-thread'); assert.equal(state.tasks[0].codexHome, directory);
    assert.match(state.tasks[0].result, /private-test-value/);
    await engine.close(); engine = await new Engine(directory).open();
    await engine.createTask({ prompt: '请记住我喜欢中文回答', projectId: 'project', mode: 'code', requestId: 'second', continueId: id, model: 'second', reasoningEffort: 'low' });
    state = await until(engine, s => ['completed', 'failed'].includes(s.tasks[0].status)); assert.equal(state.tasks[0].status, 'completed', state.tasks[0].error ?? '');
    assert.equal(state.memories[0].text, '喜欢中文回答'); assert.equal(state.tasks[0].messages?.filter(m => m.role === 'user').length, 2);
    const lines = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.find(m => m.method === 'thread/start').params.model, 'first');
    assert.equal(lines.find(m => m.method === 'turn/start').params.effort, 'high'); assert.ok(lines.some(m => m.method === 'thread/resume'));
    assert.equal(lines.findLast(m => m.method === 'turn/start').params.model, 'second');
    assert.equal(lines.findLast(m => m.method === 'turn/start').params.effort, 'low');
    assert.equal(state.tasks[0].model, 'second'); assert.equal(state.tasks[0].reasoningEffort, 'low');
    await engine.mutate(s => { s.ideas.push({ id: 'idea', text: '整理工作笔记', createdAt: '', taskId: null }); });
    await engine.createTask({ prompt: '读取想法并保存笔记', projectId: 'project', mode: 'code', requestId: 'note', continueId: id });
    state = await until(engine, s => ['completed', 'failed'].includes(s.tasks[0].status)); assert.equal(state.tasks[0].status, 'completed', state.tasks[0].error ?? '');
    const note = (await readdir(join(directory, 'artifacts'))).find(name => name.startsWith('note-'))!;
    assert.match(await readFile(join(directory, 'artifacts', note), 'utf8'), /整理工作笔记/);
    await engine.createTask({ prompt: 'wait-for-cancel', projectId: 'project', mode: 'code', requestId: 'wait', continueId: id });
    await until(engine, s => s.tasks[0].status === 'running');
    const activeAPI = createAPI(engine, auth, () => []);
    assert.equal((await activeAPI.request('/api/agents/codex/settings', { method: 'PUT', headers, body: JSON.stringify(config(directory)) })).status, 409);
    await engine.cancel(id);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Default main conversation stays Friday even when Codex is configured and installed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-provider-boundary-'));
  const faux = fauxProvider({ tokensPerSecond: 100000 });
  faux.setResponses([fauxAssistantMessage('Friday 的回复'), fauxAssistantMessage('Friday 继续回复')]);
  let codexCalls = 0;
  const executor = { run: async () => { codexCalls++; throw new Error('Main chat must not invoke Codex'); }, answer: async () => {}, steer: async () => {} };
  const open = async () => {
    const engine = new Engine(directory, executor);
    engine.modelConnection.models.setProvider(faux.provider);
    Object.assign(engine.modelConnection.model, { provider: faux.getModel().provider, modelId: faux.getModel().id });
    engine.modelConnection.ready = async () => {};
    return engine.open();
  };
  let engine = await open();
  try {
    await saveCodexSettings(directory, config(directory));
    const id = await engine.createTask({ prompt: '你好', projectId: null, mode: 'auto', requestId: 'main' });
    let state = await until(engine, s => s.tasks[0].status === 'completed');
    const conversationId = state.tasks[0].conversationId;
    assert.equal(state.tasks[0].agent, 'friday'); assert.ok(conversationId); assert.equal(state.tasks[0].threadId, null);
    await engine.close(); engine = await open();
    await engine.createTask({ prompt: '继续', projectId: null, mode: 'auto', requestId: 'next', continueId: id });
    state = await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(state.tasks[0].agent, 'friday'); assert.equal(state.tasks[0].conversationId, conversationId);
    assert.equal(state.tasks[0].messages?.filter(m => m.role === 'user').length, 2); assert.equal(codexCalls, 0);
    assert.ok(!('account' in await engine.modelConnection.status()));
    assert.equal((await engine.modelConnection.status()).provider, 'DeepSeek API');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A local task running does not block Friday main conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-separate-lanes-'));
  const faux = fauxProvider({ tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('Friday 仍然可以回复')]);
  const executor = {
    run: async ({ signal, update }: import('../src/types.js').ExecutionRequest) => {
      await update({ kind: 'session', threadId: 'independent-local-thread' });
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      return '';
    }, answer: async () => {}, steer: async () => {},
  };
  const engine = await new Engine(directory, executor, { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }).open();
  try {
    const local = await engine.createTask({ prompt: 'Inspect', projectId: null, mode: 'research', agent: 'codex', requestId: 'local' });
    await until(engine, s => s.tasks.find(t => t.id === local)?.threadId === 'independent-local-thread');
    const main = await engine.createTask({ prompt: '你好 Friday', projectId: null, mode: 'auto', requestId: 'main' });
    const state = await until(engine, s => s.tasks.find(t => t.id === main)?.status === 'completed');
    assert.equal(state.tasks.find(t => t.id === local)?.status, 'running');
    assert.equal(state.tasks.find(t => t.id === main)?.agent, 'friday');
    assert.equal(state.tasks.find(t => t.id === main)?.threadId, null);
    await engine.cancel(local);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
