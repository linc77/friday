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
import { defaultPiSettings } from '../src/pi-provider.js';
import { compactTask } from '../src/task-compaction.js';

const binary = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const end = Date.now() + 10_000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > end) throw new Error('Pi Durable fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-pi-engine-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), wire = join(root, 'wire.jsonl'); await mkdir(cwd); await chmod(binary, 0o755);
  let engine: Engine | undefined = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  await engine.piConnection.save({ ...defaultPiSettings, enabled: true, binaryPath: binary, homePath: join(root, 'pi-home'), environment: [{ name: 'PI_TEST_WIRE', value: wire }] });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Pi fixture', path: cwd, context: '' }]; });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, cwd, wire, trace, current: () => engine!, close: async () => { await engine!.close(); engine = undefined; }, reopen: async () => engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open() };
}
test('Pi task creation, idempotent compaction and service restart retain the same native session through Pi Durable', async t => {
  const fixture = await setup(t); let engine = fixture.current();
  const input = { prompt: 'reply', title: 'Pi fixture', projectId: 'project', mode: 'code' as const, agent: 'pi' as const, model: 'fixture/small', requestId: 'pi-create' };
  const id = await engine.createTask(input);
  let task = await waitFor(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => ['completed', 'failed', 'interrupted'].includes(value.status));
  assert.equal(task.status, 'completed', task.error ?? 'Task failed'); const threadId = task.threadId; assert.ok(threadId && task.piHome); assert.equal(task.result, 'Pi reply café\u2028line\u2029end');
  assert.equal(await engine.createTask(input), id); assert.equal((await fixture.trace()).filter(value => value.type === 'prompt').length, 1);
  await compactTask(engine, id, { requestId: 'compact', threadId });
  task = await waitFor(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => value.status === 'completed');
  assert.equal(task.threadId, threadId); assert.equal(task.result, 'Pi reply café\u2028line\u2029end');
  await compactTask(engine, id, { requestId: 'compact', threadId });
  const compactions = (await fixture.trace()).filter(value => value.type === 'compact'); assert.equal(compactions.length, 1); assert.equal(compactions[0].customInstructions, undefined, 'Workflow context is not a compaction instruction');
  await fixture.close(); engine = await fixture.reopen();
  await engine.createTask({ ...input, continueId: id, requestId: 'pi-continue', prompt: 'reply again' });
  task = await waitFor(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => value.status === 'completed');
  assert.equal(task.threadId, threadId); assert.ok((await fixture.trace()).some(value => value.type === 'switch_session' && value.sessionPath === threadId));
});
test('Pi API respects owner authentication, returns its real model inventory and blocks account edits during native execution', async t => {
  const fixture = await setup(t), engine = fixture.current(), auth = new Auth(fixture.directory); t.after(async () => auth.close());
  const api = createAPI(engine, auth, () => []), headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  assert.equal((await api.request('/api/agents/pi')).status, 401);
  const response = await api.request('/api/agents/pi', { headers }); assert.equal(response.status, 200); const status = await response.json(); assert.equal(status.provider, 'pi'); assert.equal(status.models[1].id, 'fixture/small');
  const bad = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: 'unknown', prompt: 'bad', projectId: 'project', mode: 'code', requestId: 'bad-agent' }) }); assert.equal(bad.status, 400);
  const id = await engine.createTask({ prompt: 'hold', title: 'Pi fixture', projectId: 'project', mode: 'code', agent: 'pi', requestId: 'pi-hold' });
  await waitFor(fixture.trace, values => values.some(value => value.child));
  const replay = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: 'pi', prompt: 'hold', projectId: 'project', mode: 'code', requestId: 'pi-hold' }) }); assert.equal(replay.status, 201); assert.deepEqual(await replay.json(), { id });
  const denied = await api.request('/api/agents/pi/settings', { method: 'PUT', headers, body: JSON.stringify(status.settings) }); assert.equal(denied.status, 409);
  await engine.cancel(id); assert.equal((await engine.snapshot()).tasks.find(value => value.id === id)!.status, 'cancelled');
});
test('A real service crash after Pi prompt preserves the session and never replays the uncertain native effect', { timeout: 20_000 }, async t => {
  const fixture = await setup(t); await fixture.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/pi-engine-crash.ts', import.meta.url)), fixture.directory, fixture.wire], { stdio: 'ignore' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000); const code = await new Promise<number | null>(resolve => child.once('exit', resolve)); clearTimeout(timeout); assert.equal(code, 92);
  const records = await fixture.trace(), prompt = records.find(value => value.type === 'prompt' && value.fixturePrompt === 'hold'); assert.ok(prompt?.pid && prompt.sessionFile);
  try { process.kill(-prompt.pid, 'SIGTERM'); } catch { /* The fixture has already exited. */ }
  const engine = await fixture.reopen();
  const task = await waitFor(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'interrupted');
  assert.equal(task.threadId, prompt.sessionFile); assert.ok(task.piHome); assert.match(task.error ?? '', /服务曾中断/);
  assert.equal((await fixture.trace()).filter(value => value.type === 'prompt').length, 1);
  await engine.createTask({ continueId: task.id, prompt: 'reply', projectId: 'project', mode: 'code', agent: 'pi', requestId: 'explicit-continuation' });
  const resumed = await waitFor(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'completed'); assert.equal(resumed.threadId, prompt.sessionFile);
});
