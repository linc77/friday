import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { canSnoozeTask, reconcileTaskSnooze, taskIsSnoozed, taskSnoozeWakeAt } from '../src/task-snooze.js';
import { applyTaskMetadata, taskMetadataChange } from '../src/task-metadata.js';
import { taskSettlementAt, taskSettlementDefaults } from '../src/task-settlement.js';
import { taskSidebarSection } from '../src/task-sidebar-order.js';
import { taskSummary } from '../src/task-stream.js';
import type { Executor, TaskRun, WorkItem } from '../src/types.js';

const NOW = Date.now(); const DAY = 86_400_000;
const iso = (offset: number) => new Date(NOW + offset).toISOString();
const item = (overrides: Partial<WorkItem> = {}): WorkItem => ({ id: 'thread', title: 'Thread', agent: 'codex', mode: 'research', cwd: '/owned-fixture', projectId: null,
  prompt: 'Original input', result: 'Original result', status: 'completed', createdAt: iso(-10 * DAY), updatedAt: iso(-5 * DAY),
  durableId: null, threadId: 'native-thread', turnId: 'native-turn', error: null, artifact: null, lastRequestId: 'original', events: [], approvals: [], ...overrides });
const run = (overrides: Partial<TaskRun> = {}): TaskRun => ({ id: 'run', durableId: null, messageId: 'message', requestId: 'request', cwd: '/owned-fixture',
  at: iso(-DAY), startedAt: iso(-DAY), status: 'completed', completedAt: iso(1_000), mode: 'research', interactionMode: 'default', ...overrides });
const pending = { id: 'question', method: 'requestUserInput', title: 'Question', detail: 'Private question', questions: [], state: 'pending' as const };
const metadata = (task: WorkItem, body: unknown, at = iso(0)) => applyTaskMetadata(task, taskMetadataChange(body), at);

test('Snooze permits adopted execution but rejects pending approval/input, unadopted work and invalid receipts', () => {
  const task = item({ status: 'running' }); metadata(task, { snoozedUntil: iso(DAY) });
  assert.equal(task.snoozedAt, iso(0)); assert.equal(taskIsSnoozed(task, NOW), true);
  assert.equal(taskSidebarSection(task, iso(0), true), 'snoozed', 'Running work stays in the Snoozed shelf');
  for (const blocked of [item({ status: 'queued' }), item({ status: 'needs_project' }), item({ approvals: [pending] }),
    item({ currentRunId: 'run', runs: [run({ workspacePreparation: { status: 'preparing', attempt: 1, startedAt: iso(0) } })] })]) {
    assert.equal(canSnoozeTask(blocked), false); assert.throws(() => metadata(blocked, { snoozedUntil: iso(DAY) }));
  }
  for (const body of [{ seenWakeAt: iso(0) }, { read: false, seenWakeAt: iso(0) }, { read: true, seenWakeAt: 'invalid' }, { snoozedAt: iso(0) }, { snoozeWakeAt: iso(0) }, { snoozed: true }]) assert.throws(() => taskMetadataChange(body));
});

test('Completion wakes early once, keeping the same notification after more output and the original deadline', () => {
  const task = item({ status: 'running', currentRunId: 'run', runs: [run({ status: 'running', completedAt: undefined })] });
  metadata(task, { snoozedUntil: iso(DAY) });
  task.status = 'completed'; task.updatedAt = iso(1_000); task.runs![0].status = 'completed'; task.runs![0].completedAt = iso(1_000);
  assert.equal(reconcileTaskSnooze(task, NOW + 1_000), true);
  assert.equal(task.snoozeWakeAt, iso(1_000)); assert.equal(task.lastSnoozeWakeAt, iso(1_000));
  metadata(task, { read: true, seenWakeAt: iso(1_000) }, iso(2_000));
  task.updatedAt = iso(3_000); task.runs![0].completedAt = iso(3_000);
  assert.equal(reconcileTaskSnooze(task, NOW + 3_000), false);
  assert.equal(taskSnoozeWakeAt(task, NOW + 2 * DAY), iso(1_000)); assert.equal(task.seenSnoozeWakeAt, iso(1_000));
  assert.equal(taskIsSnoozed(task, NOW + 3_000), false); assert.equal(taskSidebarSection(task, iso(3_000)), 'active');
});

test('Approval/input and new failures wake early; preexisting failures and reverted/excluded runs do not', () => {
  const original = item({ status: 'failed', updatedAt: iso(-1_000), snoozedUntil: iso(DAY), snoozedAt: iso(0) });
  assert.equal(taskIsSnoozed(original, NOW), true);
  original.updatedAt = iso(1_000); assert.equal(taskSnoozeWakeAt(original, NOW + 1_000), iso(1_000));
  const question = item({ status: 'waiting', updatedAt: iso(1_000), snoozedUntil: iso(DAY), snoozedAt: iso(0), approvals: [pending] });
  assert.equal(reconcileTaskSnooze(question, NOW + 1_000), true);
  question.approvals = []; question.updatedAt = iso(2_000); question.status = 'running';
  assert.equal(taskIsSnoozed(question, NOW + 2_000), false, 'Answering does not silently put the thread back to sleep');
  assert.equal(taskSnoozeWakeAt(question, NOW + 2 * DAY), iso(1_000));
  for (const ignored of [run({ revertedAt: iso(2_000) }), run({ executionExcludedAt: iso(2_000) })]) {
    assert.equal(taskIsSnoozed(item({ snoozedUntil: iso(DAY), snoozedAt: iso(0), runs: [ignored] }), NOW + 3_000), true);
  }
  assert.equal(taskSnoozeWakeAt(item({ snoozedUntil: 'broken' }), NOW), null);
  assert.equal(taskIsSnoozed(item({ snoozedUntil: iso(DAY) }), NaN), false);
});

test('Repeat Snooze is idempotent; a new generation rejects stale wake receipts and preserves unseen output', () => {
  const task = item({ unread: true }); metadata(task, { snoozedUntil: iso(10_000) });
  metadata(task, { snoozedUntil: iso(10_000) }, iso(1_000)); assert.equal(task.snoozedAt, iso(0));
  reconcileTaskSnooze(task, NOW + 10_000); metadata(task, { read: true, seenWakeAt: iso(10_000) }, iso(11_000));
  assert.equal(task.unread, true, 'Dismissing Woke alone never acknowledges output'); assert.equal(task.readAt, undefined);
  metadata(task, { snoozedUntil: iso(30_000) }, iso(20_000)); assert.equal(task.snoozedAt, iso(20_000)); assert.equal(task.snoozeWakeAt, null);
  reconcileTaskSnooze(task, NOW + 30_000); task.updatedAt = iso(31_000);
  metadata(task, { read: true, seenWakeAt: iso(10_000), seenAt: iso(10_000) }, iso(32_000));
  assert.equal(task.seenSnoozeWakeAt, iso(10_000)); assert.equal(task.unread, true);
  metadata(task, { read: true, seenWakeAt: iso(30_000), seenAt: iso(29_000) }, iso(32_000));
  assert.equal(task.seenSnoozeWakeAt, iso(30_000)); assert.equal(task.unread, true, 'The displayed wake can be acknowledged independently of later output');
  metadata(task, { read: true, seenAt: iso(31_000) }, iso(32_000)); assert.equal(task.unread, false);
  metadata(task, { read: true, seenWakeAt: iso(99_000) }, iso(32_000)); assert.equal(task.seenSnoozeWakeAt, iso(30_000));
});

test('Manual wake/pin/settle clear Snooze; archive preserves it and expired deadlines restart inactivity', () => {
  for (const change of [{ snoozedUntil: null }, { pinned: true }, { settled: true }]) {
    const task = item(); metadata(task, { snoozedUntil: iso(DAY) }); metadata(task, change, iso(1_000));
    assert.equal(task.snoozedUntil, null); assert.equal(task.snoozedAt, null); assert.equal(taskSnoozeWakeAt(task, NOW + 2 * DAY), null);
    assert.equal(task.updatedAt, iso(-5 * DAY)); assert.equal(task.threadId, 'native-thread'); assert.equal(task.result, 'Original result');
  }
  const archived = item(); metadata(archived, { snoozedUntil: iso(DAY) }); metadata(archived, { archived: true }, iso(1_000));
  assert.equal(archived.snoozedUntil, iso(DAY)); assert.equal(taskSnoozeWakeAt(archived, NOW + 2 * DAY), null, 'An archive is hidden without erasing its deadline');
  metadata(archived, { archived: false }, iso(2_000)); assert.equal(archived.snoozedUntil, iso(DAY));
  const task = item({ snoozedAt: iso(-2 * DAY), snoozedUntil: iso(DAY), snoozeWakeAt: iso(-DAY), lastSnoozeWakeAt: iso(-DAY) });
  assert.equal(taskSettlementAt(task, NOW, 3), null);
  assert.equal(taskSettlementAt(task, NOW + 3 * DAY, 3), iso(-DAY), 'An early wake does not stay protected by its former future deadline');
  assert.equal(taskSettlementAt(item({ snoozedUntil: iso(-DAY) }), NOW, 3), null);
  const alreadyWoke = item({ snoozedAt: iso(-6 * DAY), snoozedUntil: iso(-4 * DAY), snoozeWakeAt: iso(-4 * DAY), lastSnoozeWakeAt: iso(-4 * DAY) });
  metadata(alreadyWoke, { pinned: true }); metadata(alreadyWoke, { pinned: false });
  assert.equal(alreadyWoke.lastSnoozeWakeAt, iso(0)); assert.equal(taskSettlementAt(alreadyWoke, NOW, 3), null, 'Explicitly waking an old notification restarts inactivity');
});

test('Compact summaries carry authoritative Snooze and eligibility without exposing approval content', () => {
  const task = item({ approvals: [pending], snoozed: false, canSnooze: false, snoozedUntil: iso(DAY), snoozedAt: iso(-1_000), snoozeWakeAt: iso(0) });
  const summary = taskSummary(task, 7);
  assert.equal(summary.canSnooze, false); assert.equal(summary.snoozed, false); assert.equal(summary.snoozeWakeAt, iso(0));
  assert.equal(summary.approvals.length, 0); assert.equal(JSON.stringify(summary).includes('Private question'), false);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-snooze-')); let calls = 0;
  const executor: Executor = { async run() { calls++; return 'Owned fixture'; }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor).open();
  await engine.mutate(state => { state.taskSettlementSettings = taskSettlementDefaults(); state.taskSettlementSettings.defaults.sidebarAutoSettleAfterDays = null; });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine; }, get calls() { return calls; }, async reopen() { await engine.close(); engine = await new Engine(directory, executor).open(); } };
}

test('Resident timer wakes precisely with auto-settlement disabled, persists across restart and emits no idle writes', async t => {
  const f = await fixture(t); await f.engine.mutate(state => { state.tasks.push(item()); });
  const until = new Date(Date.now() + 250).toISOString(); await f.engine.updateTaskMetadata('thread', { snoozedUntil: until });
  assert.equal((await f.engine.snapshot()).tasks[0].snoozed, true);
  const limit = Date.now() + 5_000;
  while ((await f.engine.snapshot()).tasks[0].lastSnoozeWakeAt !== until) { assert.ok(Date.now() < limit, 'The resident deadline must run without a window or minute poll'); await new Promise(resolve => setTimeout(resolve, 10)); }
  let task = (await f.engine.snapshot()).tasks[0]; assert.equal(task.snoozeWakeAt, until); assert.equal(task.snoozed, false); assert.equal(task.settledAt, undefined);
  assert.equal(task.updatedAt, iso(-5 * DAY)); assert.equal(f.calls, 0);
  await f.engine.updateTaskMetadata('thread', { read: true, seenWakeAt: until }); await f.reopen();
  task = (await f.engine.snapshot()).tasks[0]; assert.equal(task.seenSnoozeWakeAt, until); assert.equal(task.snoozeWakeAt, until);
  const revision = (await f.engine.snapshot()).revision; await f.engine.taskSettlement.sweep(); await f.engine.taskSettlement.sweep(); assert.equal((await f.engine.snapshot()).revision, revision);
});

test('Restart catches up to the scheduled timestamp and pending input commits its first early wake atomically', async t => {
  const f = await fixture(t); const until = iso(-1_000);
  await f.engine.mutate(state => { state.tasks.push(item({ snoozedUntil: until, snoozedAt: iso(-2_000) })); });
  await f.reopen(); let task = (await f.engine.snapshot()).tasks[0];
  assert.equal(task.lastSnoozeWakeAt, until); assert.equal(task.snoozeWakeAt, until, 'Restart time is not a replacement for the missed deadline');
  await f.engine.updateTaskMetadata('thread', { snoozedUntil: iso(DAY) });
  await f.engine.patchTask('thread', task => { task.status = 'waiting'; task.approvals.push(pending); });
  task = (await f.engine.snapshot()).tasks[0]; const firstWake = task.lastSnoozeWakeAt;
  assert.ok(firstWake); assert.equal(task.snoozed, false); assert.equal(task.canSnooze, false);
  await f.engine.patchTask('thread', task => { task.approvals = []; task.status = 'running'; });
  assert.equal((await f.engine.snapshot()).tasks[0].lastSnoozeWakeAt, firstWake); assert.equal(f.calls, 0);
});
