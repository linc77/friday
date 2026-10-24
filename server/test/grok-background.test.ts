import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { defaultGrokSettings } from '../src/grok-provider.js';
import { backgroundCommandActivity } from '../src/task-background-commands.js';
import type { WorkItem } from '../src/types.js';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (matches(value)) return value; assert.ok(Date.now() < deadline, 'Grok background fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-grok-background-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), home = join(root, 'grok'), wire = join(root, 'wire.jsonl');
  await mkdir(cwd); const binaryPath = fileURLToPath(new URL('./fixtures/grok.mjs', import.meta.url)); await chmod(binaryPath, 0o755);
  const open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open(); let engine: Engine | undefined = await open(), id = '';
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  await engine.grokConnection.save({ ...defaultGrokSettings, enabled: true, binaryPath, homePath: home, environment: [{ name: 'GROK_TEST_WIRE', value: wire }, { name: 'GROK_TEST_MCP_HTTP', value: '1' }] });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Grok background', path: cwd, context: '' }]; });
  const task = async () => (await engine!.snapshot()).tasks.find(task => task.id === id)!;
  const wait = (matches: (task: WorkItem) => boolean) => until(task, task => !!task && matches(task));
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, current: () => engine!, task, wait, trace, wake: () => writeFile(join(home, 'emit-wake'), 'wake'),
    start: async (prompt = 'background') => { id = await engine!.createTask({ projectId: 'project', title: 'Grok background', agent: 'grok', mode: 'code', prompt, requestId: 'first' }); return wait(task => ['completed', 'failed'].includes(task.status)); },
    reopen: async () => { await engine!.close(); engine = undefined; engine = await open(); return engine; } };
}
test('Grok persistent monitor survives its parent result and its native completion creates one observed reply without another prompt', async t => {
  const f = await fixture(t), first = await f.start(); assert.equal(first.status, 'completed', first.error ?? '');
  assert.equal(first.nativeBackgroundWork![0]!.kind, 'monitor'); assert.equal(first.nativeBackgroundWork![0]!.holdsCompletion, false);
  await f.wake(); const done = await f.wait(task => task.status === 'completed' && task.result === 'Grok native wake result');
  assert.equal(done.executionSessionId, first.executionSessionId); assert.equal(done.runs!.length, 2); assert.equal(done.messages!.filter(value => value.role === 'user').length, 1);
  assert.equal(done.nativeBackgroundWork![0]!.status, 'completed');
  assert.equal((await f.trace()).filter(value => value.method === 'session/prompt').length, 1);
  assert.equal(Object.values((await f.current().snapshot()).nativeTurnRequests ?? {})[0]!.provider, 'grok');
});
test('Grok finite monitor holds the foreground completion until genuine native termination, then admits its native wake', async t => {
  const f = await fixture(t), completion = f.start('background finite');
  const active = await f.wait(task => task.result === 'Grok parent reply' && task.nativeBackgroundWork?.some(value => value.status === 'running') === true);
  assert.equal(active.status, 'running'); assert.equal(active.nativeBackgroundWork![0]!.holdsCompletion, true);
  await f.wake(); await completion; await f.wait(task => task.status === 'completed' && task.result === 'Grok native wake result');
  assert.equal((await f.trace()).filter(value => value.method === 'session/prompt').length, 1);
});
test('Grok retained MCP waits for the native wake receipt and reads only the admitted run', async t => {
  const f = await fixture(t), first = await f.start('background mcp'); assert.equal(first.status, 'completed', first.error ?? '');
  const engine = f.current(), update = engine.nativeTurns.update.bind(engine.nativeTurns);
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  try { await f.wake(); await entering; assert.ok(!(await f.trace()).some(value => value.wakeMcp)); } finally { release(); }
  await f.wait(task => task.status === 'completed' && task.result === 'Grok native wake result');
  const call = (await f.trace()).find(value => value.wakeMcp).wakeMcp; assert.equal(call.status, 200); assert.equal(call.body.result.isError, false);
});
test('Grok permissions received before wake admission wait for the right native turn and are answered exactly once', async t => {
  const f = await fixture(t), first = await f.start('background approval'); await f.wake();
  const waiting = await f.wait(task => task.status === 'waiting'), approval = waiting.approvals.find(value => value.state === 'pending')!;
  await f.current().answer(first.id, approval.id, 'accept', {}, 'native-wake-answer');
  await f.wait(task => task.status === 'completed' && task.result === 'Grok native wake result');
  const trace = await f.trace(); assert.equal(trace.filter(value => value.wakePermission).length, 1); assert.equal(trace.find(value => value.wakePermission).wakePermission.outcome.optionId, 'wake-allow');
});
test('Grok settled Stop closes the owned monitor and its real process group; instance changes remain blocked until Stop', async t => {
  const f = await fixture(t), first = await f.start(), child = (await f.trace()).find(value => value.backgroundChild).backgroundChild;
  assert.equal(backgroundCommandActivity(first).canStop, true);
  await assert.rejects(f.current().providerInstances.change({ operation: 'upsert', instanceId: 'grok', instance: { driver: 'grok', displayName: 'Grok', enabled: false } }), /停止/);
  await f.current().cancel(first.id, { runId: first.currentRunId!, sessionId: first.executionSessionId! });
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.nativeBackgroundWork![0]!.status, 'interrupted'); assert.equal(done.result, first.result);
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  assert.equal((await f.trace()).filter(value => value.method === 'session/prompt').length, 1);
});
test('Grok observed Stop and service restart preserve the native interrupted result without replay', async t => {
  const f = await fixture(t), first = await f.start('background hold-wake'); await f.wake();
  const active = await f.wait(task => task.status === 'running' && task.result === 'Grok native wake result');
  await f.current().cancel(first.id, { runId: active.currentRunId!, sessionId: active.executionSessionId! });
  await f.wait(task => ['cancelled', 'interrupted'].includes(task.status)); await f.reopen();
  const restored = await f.task(); assert.equal(restored.result, 'Grok native wake result'); assert.equal(restored.messages!.filter(value => value.role === 'user').length, 1);
  assert.equal((await f.trace()).filter(value => value.method === 'session/prompt').length, 1);
});
