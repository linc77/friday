import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';

class ControlledExecutor implements Executor {
  calls: string[] = [];
  releases: (() => void)[] = [];
  async run(request: ExecutionRequest) {
    this.calls.push(request.task.id);
    await request.update({ kind: 'session', threadId: `thread-${request.task.id}` });
    await request.update({ kind: 'output', text: 'Working' });
    await new Promise<void>((resolve, reject) => {
      this.releases.push(resolve);
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return 'Verified result';
  }
  async answer() {}
  async steer() {}
}
async function until(engine: Engine, predicate: (value: Workspace) => boolean) {
  const limit = Date.now() + 5000;
  while (Date.now() < limit) { const value = await engine.snapshot(); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 15)); }
  throw new Error('State transition timed out');
}
const input = (requestId: string) => ({ agent: 'codex' as const, prompt: 'Inspect this project', mode: 'research' as const, projectId: null, requestId });

test('Durable deduplicates submissions, serializes execution, and retains artifacts across restarts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-'));
  const executor = new ControlledExecutor(); let engine = await new Engine(directory, executor).open();
  try {
    const first = await engine.createTask(input('first'));
    assert.equal(await engine.createTask(input('first')), first);
    const second = await engine.createTask(input('second'));
    await until(engine, s => s.tasks.find(t => t.id === first)?.threadId !== null);
    assert.deepEqual(executor.calls, [first]);
    await engine.steer(first, 'Please include the verification result', 'legacy-steer');
    assert.equal((await engine.snapshot()).tasks[0].messages?.at(-1)?.text, 'Please include the verification result');
    executor.releases[0]();
    await until(engine, s => s.tasks.find(t => t.id === second)?.threadId !== null);
    assert.deepEqual(executor.calls, [first, second]);
    executor.releases[1]();
    await until(engine, s => s.tasks.every(t => t.status === 'completed'));
    assert.match(await engine.artifact(first), /Verified result/);
    await engine.close(); engine = await new Engine(directory, executor).open();
    assert.equal((await engine.snapshot()).tasks.length, 2);
    assert.equal((await engine.snapshot()).tasks[0].status, 'completed');
    assert.equal(await engine.createTask(input('first')), first);
    assert.equal(executor.calls.length, 2);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Interrupted external work is never replayed automatically; a queued task still resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-'));
  const executor = new ControlledExecutor(); let engine = await new Engine(directory, executor).open();
  try {
    const first = await engine.createTask(input('interrupt'));
    await until(engine, s => s.tasks[0].threadId !== null);
    const second = await engine.createTask(input('queued'));
    await engine.close(); engine = await new Engine(directory, executor).open();
    const state = await until(engine, s => s.tasks.find(t => t.id === second)?.threadId !== null);
    assert.equal(state.tasks.find(t => t.id === first)?.status, 'interrupted');
    assert.equal(executor.calls.filter(id => id === first).length, 1);
    executor.releases.at(-1)!();
    await until(engine, s => s.tasks.find(t => t.id === second)?.status === 'completed');
    await engine.createTask({ ...input('resume-explicit'), continueId: first });
    await until(engine, s => s.tasks[0].status === 'running');
    await engine.cancel(first);
    assert.equal((await engine.snapshot()).tasks[0].status, 'cancelled');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Codex item snapshots persist once and unfinished items terminalize on recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-items-'));
  const executor = new ControlledExecutor(); let engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('items'));
    await until(engine, s => s.tasks[0].threadId !== null);
    await engine.updateExecution(id, { kind: 'turn', turnId: 'turn-items' });
    const item = { id: 'codex:turn-items:command', itemId: 'command', turnId: 'turn-items', kind: 'command', text: 'pnpm test', at: '2026-10-07T10:00:00.000Z', status: 'running' as const };
    await engine.updateExecution(id, { kind: 'item', item });
    await engine.updateExecution(id, { kind: 'item', item: { ...item, at: '2026-10-07T10:00:01.000Z', detail: 'streamed output' } });
    let work = (await engine.snapshot()).tasks[0];
    assert.equal(work.events.filter(e => e.itemId === 'command').length, 1);
    assert.equal(work.events.find(e => e.itemId === 'command')?.at, item.at);
    assert.equal(work.messages?.[0].turnId, 'turn-items');
    await engine.close(); engine = await new Engine(directory, executor).open();
    work = (await until(engine, s => s.tasks[0].status === 'interrupted')).tasks[0];
    assert.equal(work.events.find(e => e.itemId === 'command')?.status, 'interrupted');
    assert.equal(work.events.find(e => e.itemId === 'command')?.detail, 'streamed output');
    assert.equal(executor.calls.length, 1, 'UI transcript recovery must not replay external work');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Continuing an older task stays in FIFO order with new tasks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-'));
  const executor = new ControlledExecutor(); const engine = await new Engine(directory, executor).open();
  try {
    const first = await engine.createTask(input('old'));
    await until(engine, s => s.tasks[0].threadId !== null); executor.releases[0]();
    await until(engine, s => s.tasks[0].status === 'completed');
    const second = await engine.createTask(input('new'));
    await until(engine, s => s.tasks[1].threadId !== null);
    await engine.createTask({ ...input('continue-old'), continueId: first });
    const third = await engine.createTask(input('newer'));
    executor.releases[1]();
    await until(engine, s => s.tasks[0].status === 'running');
    assert.deepEqual(executor.calls, [first, second, first]);
    assert.equal((await engine.snapshot()).tasks[2].status, 'queued');
    executor.releases[2]();
    await until(engine, s => s.tasks[2].threadId !== null);
    assert.deepEqual(executor.calls, [first, second, first, third]);
    await engine.cancel(third);
    await engine.updateExecution(third, { kind: 'approvalResolved', id: 'late-reply' });
    assert.equal((await engine.snapshot()).tasks[2].status, 'cancelled');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('SSE delivers snapshots after changes and closes when a device is revoked', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-'));
  const engine = await new Engine(directory, new ControlledExecutor()).open(); const auth = new Auth(directory);
  const pairing = auth.createPairing(); const device = auth.pair(pairing.code, 'test', 'test');
  const app = createAPI(engine, auth);
  const response = await app.request('/api/events', { headers: { Authorization: `Bearer ${device.token}` } });
  const reader = response.body!.getReader();
  try {
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: snapshot/);
    await engine.mutate(s => { s.memories.push({ id: 'test', text: 'SSE persistence', updatedAt: new Date().toISOString() }); });
    let text = '';
    while (!text.includes('SSE persistence')) text += new TextDecoder().decode((await reader.read()).value);
    auth.revoke(device.id);
    let result = await reader.read(); while (!result.done) result = await reader.read();
    assert.equal(engine.listenerCount('change'), 0);
  } finally { await reader.cancel(); await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Only one process may own a Durable data directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-')); const engine = await new Engine(directory).open();
  try { await assert.rejects(new Engine(directory).open(), /已有 Friday/); }
  finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A plain conversation can wait for a project across restarts, release the queue, and resume the same history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-chat-'));
  const calls: ExecutionRequest[] = [];
  const executor: Executor = {
    async run(request) {
      calls.push(request);
      if (!request.task.threadId) await request.update({ kind: 'session', threadId: 'retained-thread' });
      if (request.task.prompt === 'Create a file' && !request.task.projectId) {
        await request.update({ kind: 'workspace', reason: '请选择工作目录' }); return '要处理哪个项目？';
      }
      if (request.task.prompt === 'Only save an idea') {
        await request.update({ kind: 'idea', id: 'captured', text: '只记录不执行' }); return '记下了。';
      }
      return 'Done';
    }, async answer() {}, async steer() {},
  };
  let engine = await new Engine(directory, executor).open(); const auth = new Auth(directory);
  let app = createAPI(engine, auth, () => [{ id: 'codex', name: 'Codex', installed: true, executable: '/fake', executableSupported: true, description: '' }]);
  const request = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await request('/api/ideas', { id: 'idea', text: 'Create a file' });
    const created = await request('/api/tasks', { agent: 'codex', prompt: 'Create a file', ideaId: 'idea', requestId: 'chat-create' });
    assert.equal(created.status, 201); const { id } = await created.json();
    assert.equal((await (await request('/api/tasks', { agent: 'codex', prompt: 'Create a file', ideaId: 'idea', requestId: 'second-click' })).json()).id, id);
    await until(engine, s => s.tasks[0].status === 'needs_project');
    const next = await request('/api/tasks', { agent: 'codex', prompt: 'Only save an idea', requestId: 'capture' }); const nextId = (await next.json()).id;
    await until(engine, s => s.tasks.find(t => t.id === nextId)?.status === 'completed');
    assert.equal((await engine.snapshot()).ideas.find(i => i.id === 'captured')?.taskId, null);
    await engine.close(); engine = await new Engine(directory, executor).open();
    app = createAPI(engine, auth);
    assert.equal((await engine.snapshot()).tasks[0].status, 'needs_project');
    assert.equal(calls.length, 2);
    assert.equal((await request(`/api/tasks/${id}/workspace`, { path: 'relative', requestId: 'invalid' })).status, 400);
    const selected = { path: directory, requestId: 'selected-directory' };
    assert.equal((await request(`/api/tasks/${id}/workspace`, selected)).status, 200);
    assert.equal((await request(`/api/tasks/${id}/workspace`, selected)).status, 200);
    await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(calls.length, 3); assert.equal(calls[2].task.threadId, 'retained-thread'); assert.equal(calls[2].task.cwd, await realpath(directory));
    const state = await engine.snapshot();
    assert.equal(state.tasks[0].workspaceRequest, null);
    assert.deepEqual(state.tasks[0].messages?.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(state.tasks[0].messages?.[1].text, '要处理哪个项目？');
    assert.equal(state.ideas.find(i => i.id === 'idea')?.taskId, id);
    assert.equal((await request(`/api/tasks/${nextId}/workspace`, { path: directory, requestId: 'not-pending' })).status, 400);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('API authentication, pairing, revocation, validation and persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-')); const executor = new ControlledExecutor();
  const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => [{ id: 'codex', name: 'Codex', installed: true, executable: '/fake', executableSupported: true, description: '' }]);
  const request = (path: string, body?: unknown, token = auth.token, method = body ? 'POST' : 'GET') => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  try {
    assert.equal((await request('/api/state', undefined, '')).status, 401);
    assert.equal((await app.request('/api/state', { headers: { Origin: 'https://hostile.example' } })).status, 403);
    const pairing = await (await request('/api/pairing', {})).json();
    const paired = await (await request('/pair', { code: pairing.code, name: 'iPhone' }, '')).json();
    assert.equal((await request('/api/state', undefined, paired.token)).status, 200);
    assert.equal((await request('/pair', { code: pairing.code, name: 'replay' }, '')).status, 400);
    assert.equal((await request('/api/pairing', {}, paired.token)).status, 403);
    await request(`/api/devices/${paired.id}`, undefined, auth.token, 'DELETE');
    assert.equal((await request('/api/state', undefined, paired.token)).status, 401);
    assert.equal((await request('/api/projects', { name: 'Bad', path: 'relative' })).status, 400);
    assert.equal((await request('/api/tasks', { ...input('bad'), mode: 'code' })).status, 400);
    assert.equal((await request('/api/tasks', { ...input('bad'), agent: 'hermes' })).status, 400);
    const idea = { id: 'stable-idea', text: 'Investigate this repository' };
    await request('/api/ideas', idea); await request('/api/ideas', idea);
    await request('/api/memories', { text: 'Prefer Chinese reports' });
    const response = await request('/api/tasks', { ...input('api-task'), ideaId: idea.id });
    assert.equal(response.status, 201);
    const id = (await response.json()).id;
    const state = await (await request('/api/state')).json();
    assert.equal(state.ideas.length, 1); assert.equal(state.ideas[0].taskId, id);
    assert.equal(state.memories[0].text, 'Prefer Chinese reports');
    await until(engine, s => s.tasks[0].threadId !== null);
    await request(`/api/tasks/${id}/cancel`, {});
    assert.equal((await engine.snapshot()).tasks[0].status, 'cancelled');
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
