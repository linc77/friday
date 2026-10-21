import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, WorkItem } from '../src/types.js';

const at = '2026-10-01T00:00:00.000Z';
const idle = (cwd: string): WorkItem => ({ id: 'task', title: 'Kept title', prompt: 'Kept prompt', result: 'Kept answer', agent: 'codex', mode: 'research', projectId: 'project', cwd, status: 'completed', durableId: null, currentRunId: 'old-run', executionSessionId: 'old-session', threadId: 'native', turnId: 'old-turn', artifact: null, error: null, events: [], approvals: [], createdAt: at, updatedAt: at, lastRequestId: 'old' });
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const end = Date.now() + 5_000;
  for (;;) { const value = await read(); if (ready(value)) return value; assert(Date.now() < end, 'Settle fixture did not reach the expected boundary'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
class Owner implements Executor {
  calls = 0; closes: string[] = []; entered?: () => void; gate?: () => Promise<void>;
  async run(request: ExecutionRequest) { this.calls++; await request.update({ kind: 'session', threadId: 'native', executionSessionId: 'new-session' }); return 'New answer'; }
  hasSession() { return true; }
  async stopNativeSession(_id: string, session: string) { this.closes.push(session); this.entered?.(); await this.gate?.(); }
  async answer() {} async steer() {}
}
async function fixture(t: { after: (body: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-settle-lifecycle-')), cwd = join(directory, 'project'), data = join(directory, 'data'); await mkdir(cwd);
  const owner = new Owner(), options = { changeRequestSyncIntervalMs: 0 }; let engine = await new Engine(data, owner, undefined, options).open(); const auth = new Auth(data); let app = createAPI(engine, auth, () => []);
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Project', path: cwd, context: '' }]; state.taskSettlementSettings = { version: 0, defaults: { sidebarAutoSettleAfterDays: null, sidebarAutoSettleOnMerge: false }, projects: {} }; state.tasks = [idle(cwd)]; });
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine; }, owner, cwd, task: async () => (await engine.snapshot()).tasks[0],
    patch: (body: object, authorized = true) => app.request('/api/tasks/task', { method: 'PATCH', headers: authorized ? { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    async reopen() { await engine.close(); engine = await new Engine(data, owner, undefined, options).open(); app = createAPI(engine, auth, () => []); },
  };
}

test('Settle rejects active runs, approvals and human queues in the same transaction, while queued automatic notifications may be cancelled', async t => {
  const f = await fixture(t); assert.equal((await f.patch({ settled: true }, false)).status, 401);
  const variants: Partial<WorkItem>[] = [
    { status: 'running' }, { status: 'waiting' }, { status: 'queued' }, { status: 'needs_project' },
    { approvals: [{ id: 'a', method: 'item/tool/requestUserInput', title: 'Question', detail: '', questions: [], state: 'pending' }] },
    { queue: { paused: true, dispatcherId: null, messages: [{ id: 'human', dispatchId: 'human', text: 'Keep', images: [], createdAt: at, status: 'queued' }] } },
    { messages: [{ id: 'uncertain', role: 'user', text: 'Keep', delivery: 'uncertain' }] },
  ];
  for (const fields of variants) {
    await f.engine.mutate(state => { state.tasks = [{ ...idle(f.cwd), ...fields }]; });
    assert.equal((await f.task()).canSettle, false); assert.equal((await f.patch({ settled: true })).status, 400);
    const task = await f.task(); assert.equal(task.settledAt, undefined); assert.equal(task.settleCleanup, undefined);
  }
  assert.equal(f.owner.closes.length, 0); assert.equal(f.owner.calls, 0);
  await f.engine.mutate(state => { state.tasks = [{ ...idle(f.cwd), queue: { paused: true, dispatcherId: null, messages: [{ id: 'monitor', dispatchId: 'monitor', text: 'Kept automatic notification', images: [], createdAt: at, status: 'queued', creationSource: 'monitor' }] } }]; });
  assert.equal((await f.patch({ settled: true })).status, 200); const task = await f.task();
  assert.equal(task.queue!.messages[0].status, 'cancelled'); assert.equal(task.queue!.messages[0].text, 'Kept automatic notification'); assert.equal(task.settleCleanup?.status, 'completed');
});

test('An early Undo may restore metadata but no new execution can replace the idle provider before detach completes; replay cannot close the later session', async t => {
  const f = await fixture(t); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), stopping = new Promise<void>(resolve => { entered = resolve; }); f.owner.gate = () => gate; f.owner.entered = entered;
  await f.engine.mutate(state => { Object.assign(state.tasks[0], { pinnedAt: at, pinOrderKey: 'a0', snoozedUntil: '2099-01-01T00:00:00.000Z' }); });
  const pending = f.patch({ settled: true, requestId: 'settle-once' });
  try {
    await stopping; assert.equal((await f.task()).settleCleanup?.status, 'pending');
    assert.equal((await f.patch({ settled: false, pinned: true, pinOrderKey: 'a0', snoozedUntil: '2099-01-01T00:00:00.000Z' })).status, 200);
    await assert.rejects(f.engine.createTask({ continueId: 'task', projectId: 'project', agent: 'codex', mode: 'research', prompt: 'new', requestId: 'new' }), /清理/);
    assert.equal(f.owner.calls, 0);
  } finally { release(); }
  assert.equal((await pending).status, 200); let task = await f.task();
  assert.equal(task.settledAt, null); assert.equal(task.pinOrderKey, 'a0'); assert.equal(task.snoozedUntil, '2099-01-01T00:00:00.000Z'); assert.equal(task.result, 'Kept answer');
  await f.engine.createTask({ continueId: 'task', projectId: 'project', agent: 'codex', mode: 'research', prompt: 'new', requestId: 'new' });
  await until(f.task, task => task.result === 'New answer');
  const replay = await f.patch({ settled: true, requestId: 'settle-once' }); assert.deepEqual(await replay.json(), { ok: true, applied: false });
  assert.deepEqual(f.owner.closes, ['old-session']); assert.equal((await f.task()).settledAt, null);
  await f.reopen(); assert.equal((await f.task()).settledAt, null); assert.equal(f.owner.calls, 1);
});

test('Settle preserves interactive terminals and recovery never starts or resumes an idle native provider', async t => {
  const f = await fixture(t);
  await f.engine.terminals.lifecycle('task', { action: 'open', terminalId: 'terminal', requestId: 'terminal', cols: 80, rows: 24, shell: '/bin/sh' });
  await until(async () => f.engine.terminals.snapshot('task', 'terminal'), frame => frame.terminal?.status === 'running');
  assert.equal((await f.patch({ settled: true, requestId: 'settle' })).status, 200);
  assert.equal(f.engine.terminals.snapshot('task', 'terminal').terminal?.status, 'running');
  assert.equal((await f.task()).result, 'Kept answer'); assert.equal((await f.task()).updatedAt, at);
  await f.reopen(); assert.equal(f.owner.calls, 0); assert.deepEqual(f.owner.closes, ['old-session']);
});

test('Headless automatic Settle detaches its idle owner while retaining the backdated activity time and never launching a provider', async t => {
  const f = await fixture(t);
  await f.engine.mutate(state => { state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 1; });
  await f.engine.taskSettlement.sweep(); const task = await f.task();
  assert.equal(task.settledAt, at); assert.equal(task.updatedAt, at); assert.equal(task.result, 'Kept answer');
  assert.equal(task.settleCleanup?.status, 'completed'); assert.deepEqual(f.owner.closes, ['old-session']); assert.equal(f.owner.calls, 0);
});

test('A cross-group sidebar Settle uses the same native detach and its old receipt cannot close a later run', async t => {
  const f = await fixture(t); await f.engine.mutate(state => { Object.assign(state.tasks[0], { pinnedAt: at, pinOrderKey: 'm' }); });
  const move = { projectId: 'project', source: 'pinned', section: 'settled', requestId: 'drag-settle', expected: [], orderedIds: ['task'] } as const;
  assert.equal(await f.engine.moveTaskInSidebar('task', { ...move, expected: [], orderedIds: ['task'] }), true);
  assert.equal((await f.task()).settleCleanup?.status, 'completed'); assert.deepEqual(f.owner.closes, ['old-session']);
  await f.engine.updateTaskMetadata('task', { settled: false });
  await f.engine.createTask({ continueId: 'task', projectId: 'project', agent: 'codex', mode: 'research', prompt: 'new', requestId: 'after-drag' });
  await until(f.task, task => task.result === 'New answer');
  assert.equal(await f.engine.moveTaskInSidebar('task', { ...move, expected: [], orderedIds: ['task'] }), false);
  assert.equal((await f.task()).settledAt, null); assert.deepEqual(f.owner.closes, ['old-session']);
});

test('An automatic queued run with no native start is cancelled by Settle, while a normal queued run is retained and rejected', async t => {
  const f = await fixture(t);
  for (const monitor of [false, true]) {
    await f.engine.mutate(state => { state.tasks = [{ ...idle(f.cwd), status: 'queued', messages: [{ id: 'queued-user', role: 'user', text: 'Keep notification', ...(monitor ? { creationSource: 'monitor' as const } : {}) }], runs: [{ id: 'old-run', durableId: null, requestId: 'queued', messageId: 'queued-user', status: 'queued', mode: 'research', interactionMode: 'default', cwd: f.cwd, at }] }]; });
    const response = await f.patch({ settled: true }); assert.equal(response.status, monitor ? 200 : 400);
    const task = await f.task(); assert.equal(task.runs![0].status, monitor ? 'cancelled' : 'queued'); assert.equal(task.messages![0].text, 'Keep notification');
  }
  assert.equal(f.owner.calls, 0); assert.deepEqual(f.owner.closes, ['old-session']);
});
