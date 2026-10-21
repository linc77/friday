import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defaultGrokSettings } from '../src/grok-provider.js';
import { compactTask } from '../src/task-compaction.js';

const binary = fileURLToPath(new URL('./fixtures/grok.mjs', import.meta.url));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const end = Date.now() + 10_000;
  for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > end) throw new Error('Grok Durable fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-grok-engine-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), wire = join(root, 'wire.jsonl'); await mkdir(cwd); await chmod(binary, 0o755);
  let engine: Engine | undefined = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  await engine.grokConnection.save({ ...defaultGrokSettings, enabled: true, binaryPath: binary, homePath: join(root, 'grok-home'), environment: [{ name: 'GROK_TEST_WIRE', value: wire }] });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Grok fixture', path: cwd, context: '' }]; });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, cwd, wire, trace, current: () => engine!, close: async () => { await engine!.close(); engine = undefined; }, reopen: async () => engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open() };
}
test('Grok Durable creation, command receipts and service restart preserve one native session without duplicating prompts', async t => {
  const fixture = await setup(t); let engine = fixture.current();
  const input = { prompt: 'reply', title: 'Grok fixture', projectId: 'project', mode: 'code' as const, agent: 'grok' as const, model: 'grok-fast', reasoningEffort: 'high', requestId: 'grok-create' };
  const id = await engine.createTask(input);
  let task = await until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => ['completed', 'failed', 'interrupted'].includes(value.status));
  assert.equal(task.status, 'completed', task.error ?? 'Task failed'); const threadId = task.threadId; assert.ok(threadId && task.grokHome); assert.equal(task.result, 'Grok reply café\u2028line\u2029end');
  assert.equal(await engine.createTask(input), id); assert.equal((await fixture.trace()).filter(value => value.method === 'session/prompt').length, 1);
  await compactTask(engine, id, { requestId: 'compact', threadId });
  task = await until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => value.status === 'completed');
  assert.equal(task.threadId, threadId); assert.equal(task.result, 'Grok reply café\u2028line\u2029end');
  await compactTask(engine, id, { requestId: 'compact', threadId });
  const prompts = (await fixture.trace()).filter(value => value.method === 'session/prompt'); assert.equal(prompts.length, 2); assert.deepEqual(prompts[1].params.prompt, [{ type: 'text', text: '/compact' }]);
  await fixture.close(); engine = await fixture.reopen();
  await engine.createTask({ ...input, continueId: id, requestId: 'grok-continue', prompt: 'reply again' });
  task = await until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => value.status === 'completed');
  assert.equal(task.threadId, threadId); assert.ok((await fixture.trace()).some(value => value.method === 'session/load' && value.params.sessionId === threadId));
});
test('Grok API protects host settings, redacts device credentials and queues even an explicit Steer while Grok is running', async t => {
  const fixture = await setup(t), engine = fixture.current(), auth = new Auth(fixture.directory); t.after(async () => auth.close());
  const api = createAPI(engine, auth, () => []), headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const device = auth.pair(auth.createPairing().code, 'fixture-device', '127.0.0.1'), paired = { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' };
  assert.equal((await api.request('/api/agents/grok')).status, 401);
  const response = await api.request('/api/agents/grok', { headers }); assert.equal(response.status, 200); const status = await response.json(); assert.equal(status.models[0].id, 'grok-fast');
  const deviceStatus = await (await api.request('/api/agents/grok', { headers: paired })).json(); assert.equal(deviceStatus.settings, null);
  assert.equal((await api.request('/api/agents/grok/settings', { method: 'PUT', headers: paired, body: JSON.stringify(status.settings) })).status, 403);
  assert.equal((await api.request('/api/agents/grok/check', { method: 'POST', headers: paired, body: '{}' })).status, 403);
  const id = await engine.createTask({ prompt: 'hold', title: 'Grok fixture', projectId: 'project', mode: 'code', agent: 'grok', requestId: 'grok-hold' });
  await until(fixture.trace, values => values.some(value => value.child));
  assert.equal((await engine.snapshot()).tasks.find(task => task.id === id)!.canSteer, false);
  const replay = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: 'grok', prompt: 'hold', projectId: 'project', mode: 'code', requestId: 'grok-hold' }) }); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), { id });
  const denied = await api.request('/api/agents/grok/settings', { method: 'PUT', headers, body: JSON.stringify(status.settings) }); assert.equal(denied.status, 409);
  for (let index = 0; index < 2; index++) assert.equal((await api.request(`/api/tasks/${id}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'After hold', dispatchMode: 'steer', requestId: 'grok-queue' }) })).status, 200);
  let task = (await engine.snapshot()).tasks.find(task => task.id === id)!; assert.equal(task.queue?.messages.length, 1); assert.equal(task.queue?.messages[0]!.status, 'queued');
  assert.equal((await fixture.trace()).filter(value => value.method === 'session/prompt').length, 1);
  await engine.cancel(id); task = (await engine.snapshot()).tasks.find(task => task.id === id)!; assert.equal(task.status, 'cancelled');
  await engine.taskQueue.resume(id, 'resume-queued');
  task = await until(async () => (await engine.snapshot()).tasks.find(task => task.id === id)!, value => value.status === 'completed' && value.queue?.dispatcherId === null);
  assert.equal(task.queue?.messages[0]!.status, 'completed'); assert.equal((await fixture.trace()).filter(value => value.method === 'session/prompt').length, 2);
});
test('A real service crash after Grok dispatch preserves its native session and never replays the uncertain side effect', { timeout: 20_000 }, async t => {
  const fixture = await setup(t); await fixture.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/grok-engine-crash.ts', import.meta.url)), fixture.directory, fixture.wire], { stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000); const code = await new Promise<number | null>(resolve => child.once('exit', resolve)); clearTimeout(timeout); assert.equal(code, 93);
  const records = await fixture.trace(), prompt = records.find(value => value.prompt === 'hold'); assert.ok(prompt?.pid && prompt.sessionId);
  try { process.kill(-prompt.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  const engine = await fixture.reopen();
  const task = await until(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'interrupted');
  assert.equal(task.threadId, prompt.sessionId); assert.ok(task.grokHome); assert.match(task.error ?? '', /服务曾中断/);
  assert.equal((await fixture.trace()).filter(value => value.method === 'session/prompt').length, 1);
  await engine.createTask({ continueId: task.id, prompt: 'reply', projectId: 'project', mode: 'code', agent: 'grok', requestId: 'explicit-continuation' });
  const resumed = await until(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'completed'); assert.equal(resumed.threadId, prompt.sessionId);
});
