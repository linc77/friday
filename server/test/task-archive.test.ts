import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, WorkItem } from '../src/types.js';

const stamp = '2026-10-01T00:00:00.000Z';
const idle = (cwd: string): WorkItem => ({ id: 'task', title: 'Kept title', prompt: 'Kept prompt', result: 'Kept answer', agent: 'codex', mode: 'research', projectId: 'project', cwd,
  status: 'completed', durableId: null, threadId: 'kept-thread', turnId: null, artifact: null, error: null, events: [], approvals: [], createdAt: stamp, updatedAt: stamp, lastRequestId: 'first' });
async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 8000;
  while (true) { const value = await read(); if (matches(value)) return value; assert(Date.now() < deadline, 'Archive fixture did not reach its expected state'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
class Resident implements Executor {
  calls = 0; closes: string[] = []; alive = false; closeGate?: () => Promise<void>; entered?: () => void;
  async run(request: ExecutionRequest): Promise<string> {
    this.calls++; this.alive = true;
    await request.update({ kind: 'session', threadId: 'owned-thread', executionSessionId: 'owned-session' });
    await request.update({ kind: 'turn', turnId: 'owned-turn' }); await request.update({ kind: 'output', text: 'Kept partial answer' });
    await request.update({ kind: 'ready', canSteer: true });
    await new Promise<never>((_, reject) => { if (request.signal.aborted) reject(new Error('aborted')); else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    throw new Error('An aborted resident run cannot return a reply');
  }
  hasSession() { return this.alive; }
  async stopNativeSession(id: string, session: string) { if (!this.alive || session !== 'owned-session') return; this.closes.push(id + ':' + session); this.entered?.(); await this.closeGate?.(); this.alive = false; }
  async answer() {} async steer() {}
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-archive-')), project = join(directory, 'project'), data = join(directory, 'data'); await mkdir(project);
  const executor = new Resident(), options = { changeRequestSyncIntervalMs: 0 }; let engine = await new Engine(data, executor, undefined, options).open(); const auth = new Auth(data); let api = createAPI(engine, auth, () => []);
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Owned workspace', path: project, context: '' }]; });
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine; }, executor, project, data,
    task: async (id: string) => (await engine.snapshot()).tasks.find(task => task.id === id)!,
    patch: (id: string, body: object, authorized = true) => api.request('/api/tasks/' + id, { method: 'PATCH', headers: authorized ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    async reopen() { await engine.close(); engine = await new Engine(data, executor, undefined, options).open(); api = createAPI(engine, auth, () => []); },
  };
}

test('T3 archive retains pin position, Snooze, conversation and files; unarchive and restart never run a provider or a setup script', async t => {
  const f = await fixture(t); await writeFile(join(f.project, 'user-file'), 'Kept dirty data');
  await f.engine.mutate(state => { state.tasks = [{ ...idle(f.project), pinnedAt: stamp, pinOrderKey: 'm', activeOrderKey: 'j', snoozedAt: stamp, snoozedUntil: '2099-01-01T00:00:00.000Z' }]; });
  assert.equal((await f.patch('task', { archived: true }, false)).status, 401);
  assert.equal((await f.patch('task', { archived: true })).status, 200);
  const archived = await f.task('task'); assert(archived.archivedAt); assert.equal(archived.archiveCleanup?.status, 'completed');
  assert.equal(archived.pinnedAt, stamp); assert.equal(archived.pinOrderKey, 'm'); assert.equal(archived.activeOrderKey, 'j'); assert.equal(archived.snoozedUntil, '2099-01-01T00:00:00.000Z');
  assert.equal(archived.result, 'Kept answer'); assert.equal(archived.updatedAt, stamp); assert.equal(await readFile(join(f.project, 'user-file'), 'utf8'), 'Kept dirty data');
  await f.reopen(); assert.equal((await f.patch('task', { archived: true })).status, 200); assert.equal((await f.task('task')).archiveCleanup?.id, archived.archiveCleanup?.id);
  assert.equal((await f.patch('task', { archived: false })).status, 200); const restored = await f.task('task');
  assert.equal(restored.archivedAt, null); assert.equal(restored.pinnedAt, stamp); assert.equal(restored.pinOrderKey, 'm'); assert.equal(restored.snoozedUntil, archived.snoozedUntil);
  assert.equal(f.executor.calls, 0); assert.equal((await f.engine.snapshot()).projectScriptRuns?.length ?? 0, 0);
});

test('Archive cancels owned execution and queued input, closes the terminal while keeping its tail, and rejects late callbacks after restoration', async t => {
  const f = await fixture(t), id = await f.engine.createTask({ agent: 'codex', mode: 'research', projectId: 'project', prompt: 'Owned running request', requestId: 'owned' });
  const live = await until(() => f.task(id), task => task.canSteer === true);
  await f.engine.taskQueue.enqueue(id, { text: 'Must never run after archive' }, 'cancelled-queue');
  await f.engine.terminals.lifecycle(id, { action: 'open', terminalId: 'owned-terminal', requestId: 'open-owned-terminal', shell: '/bin/sh' });
  await until(async () => f.engine.terminals.summaries(id), rows => rows.some(row => row.status === 'running'));
  await f.engine.terminals.write(id, 'owned-terminal', { requestId: 'owned-stdin', generation: 1, data: Buffer.from("printf 'archive-tail\\n'\n").toString('base64') });
  await until(async () => f.engine.terminals.snapshot(id, 'owned-terminal'), frame => Buffer.from(frame.history ?? '', 'base64').toString().includes('archive-tail'));
  assert.equal((await f.patch(id, { archived: true })).status, 200); const archived = await f.task(id);
  assert.equal(archived.status, 'cancelled'); assert.equal(archived.queue?.messages[0].status, 'cancelled'); assert.deepEqual(f.executor.closes, [id + ':owned-session']); assert.equal(f.executor.calls, 1);
  assert.equal(f.engine.terminals.snapshot(id, 'owned-terminal').terminal!.status, 'closed'); assert.match(Buffer.from(f.engine.terminals.snapshot(id, 'owned-terminal').history ?? '', 'base64').toString(), /archive-tail/);
  assert.equal((await f.patch(id, { archived: false })).status, 200);
  await f.engine.updateExecution(id, { kind: 'output', text: 'Stale reply' }, live.currentRunId); assert.equal((await f.task(id)).result, 'Kept partial answer');
  await f.reopen(); assert.equal(f.executor.calls, 1); assert.equal((await f.task(id)).queue?.messages[0].status, 'cancelled');
});

test('Restoring during cleanup preserves the restore but cannot launch a new run until the captured session has closed', async t => {
  const f = await fixture(t), id = await f.engine.createTask({ agent: 'codex', mode: 'research', projectId: 'project', prompt: 'Owned request', requestId: 'running' });
  await until(() => f.task(id), task => task.canSteer === true);
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  f.executor.closeGate = () => gate; f.executor.entered = entered; t.after(async () => { release(); });
  const archive = f.patch(id, { archived: true }); await started;
  try {
    assert.equal((await f.task(id)).archiveCleanup?.status, 'pending'); assert.equal((await f.patch(id, { archived: false })).status, 200);
    await assert.rejects(f.engine.createTask({ continueId: id, projectId: 'project', mode: 'research', prompt: 'Too early', requestId: 'new-run' }), /归档/);
  } finally { release(); }
  assert.equal((await archive).status, 200); const restored = await f.task(id);
  assert.equal(restored.archivedAt, null); assert.equal(restored.archiveCleanup?.status, 'completed'); assert.equal(f.executor.calls, 1); assert.equal(f.executor.closes.length, 1);
});

test('The durable archive claim defeats a deferred native start and restoration cannot revive the cancelled launch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-archive-before-start-')); let calls = 0, entered!: () => void;
  const initialized = new Promise<void>(resolve => { entered = resolve; });
  const executor: Executor = { deferredStart: () => true, async run(request) {
    await request.update({ kind: 'session', threadId: 'initializing-thread', executionSessionId: 'initializing-session' }); entered();
    await new Promise<never>((_, reject) => { if (request.signal.aborted) reject(new Error('aborted')); else request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    await request.beforeStart?.(); calls++; return 'Must not start';
  }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const id = await engine.createTask({ prompt: 'Deferred start', agent: 'codex', mode: 'research', projectId: null, requestId: 'deferred' }); await initialized;
  await engine.updateTaskMetadata(id, { archived: true }); await engine.updateTaskMetadata(id, { archived: false });
  assert.equal(calls, 0); assert.equal((await engine.snapshot()).tasks[0].status, 'cancelled');
  await engine.close(); engine = await new Engine(directory, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  assert.equal(calls, 0); assert.equal((await engine.snapshot()).tasks[0].status, 'cancelled');
});

test('Undo pin and settle restore the captured ordering key atomically; malformed keys and mixed archive requests leave state intact', async t => {
  const f = await fixture(t); await f.engine.mutate(state => { state.tasks = [{ ...idle(f.project), pinnedAt: stamp, pinOrderKey: 'm' }, { ...idle(f.project), id: 'other', pinnedAt: stamp, pinOrderKey: 'j' }]; });
  await f.patch('task', { pinned: false }); const pin = await f.patch('task', { pinned: true, pinOrderKey: 'm' }); assert.equal(pin.status, 200, await pin.text()); assert.equal((await f.task('task')).pinOrderKey, 'm');
  await f.patch('task', { settled: true }); assert.equal((await f.patch('task', { settled: false, pinned: true, pinOrderKey: 'm', snoozedUntil: '2099-01-01T00:00:00Z' })).status, 200);
  const restored = await f.task('task'); assert.equal(restored.settledAt, null); assert.equal(restored.pinOrderKey, 'm'); assert.equal(restored.snoozedUntil, '2099-01-01T00:00:00.000Z');
  for (const key of ['a0', 'legacy/key', 'x'.repeat(1025)]) {
    assert.equal((await f.patch('task', { pinned: true, pinOrderKey: key })).status, 200); assert.equal((await f.task('task')).pinOrderKey, key);
  }
  for (const body of [{ pinOrderKey: 'm' }, { pinned: true, pinOrderKey: '' }, { pinned: true, pinOrderKey: '   ' }, { archived: true, pinned: true }]) {
    assert.equal((await f.patch('task', body)).status, 400); assert.equal((await f.task('task')).archivedAt, undefined);
  }
});

test('A lost archive or restore reply cannot stop a newer run or reopen a newly archived task; receipts bind payloads and survive restart', async t => {
  const f = await fixture(t), id = await f.engine.createTask({ agent: 'codex', mode: 'research', projectId: 'project', prompt: 'First owned run', requestId: 'receipt-first-run' });
  const first = await until(() => f.task(id), task => task.canSteer === true);
  const archive = { archived: true, requestId: 'archive-once' }, restore = { archived: false, requestId: 'restore-once' };
  assert.deepEqual(await (await f.patch(id, archive)).json(), { ok: true, applied: true });
  assert.deepEqual(await (await f.patch(id, restore)).json(), { ok: true, applied: true });
  await f.engine.createTask({ continueId: id, projectId: 'project', mode: 'research', prompt: 'Newer owned run', requestId: 'receipt-newer-run' });
  await until(() => f.task(id), task => task.currentRunId !== first.currentRunId && task.canSteer === true);
  assert.deepEqual(await (await f.patch(id, { requestId: archive.requestId, archived: true })).json(), { ok: true, applied: false });
  assert.equal((await f.task(id)).archivedAt, null); assert.equal((await f.task(id)).status, 'running'); assert.equal(f.executor.closes.length, 1);
  assert.equal((await f.patch(id, { ...archive, title: 'Changed payload' })).status, 400);
  assert.equal((await f.patch(id, { archived: true, requestId: 'new-explicit-archive' })).status, 200);
  assert.deepEqual(await (await f.patch(id, restore)).json(), { ok: true, applied: false }); assert((await f.task(id)).archivedAt);
  await f.reopen(); assert.deepEqual(await (await f.patch(id, archive)).json(), { ok: true, applied: false }); assert((await f.task(id)).archivedAt);
  assert.equal(f.executor.closes.length, 2); assert.equal(f.executor.calls, 2);
});

test('A new explicit Snooze of the same deadline restarts its generation; replaying its receipt does not erase a later wake', async t => {
  const f = await fixture(t); await f.engine.mutate(state => { state.tasks = [idle(f.project)]; });
  const input = { snoozedUntil: '2099-01-01T00:00:00Z', requestId: 'snooze-first' };
  assert.equal((await f.patch('task', input)).status, 200); const initial = await f.task('task');
  const wake = new Date().toISOString(); await f.engine.mutate(state => { state.tasks[0].snoozeWakeAt = wake; state.tasks[0].lastSnoozeWakeAt = wake; });
  assert.deepEqual(await (await f.patch('task', input)).json(), { ok: true, applied: false }); assert.equal((await f.task('task')).snoozeWakeAt, wake);
  await new Promise(resolve => setTimeout(resolve, 4)); assert.equal((await f.patch('task', { ...input, requestId: 'snooze-new-intent' })).status, 200);
  const next = await f.task('task'); assert.notEqual(next.snoozedAt, initial.snoozedAt); assert.equal(next.snoozeWakeAt, null);
});
