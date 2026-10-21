import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { taskSidebarActivity } from '../src/task-sidebar-activity.js';
import { applyTaskSidebarMove, sortSidebarSection, taskSidebarMove, taskSidebarSection } from '../src/task-sidebar-order.js';
import { taskOverview, taskSummary } from '../src/task-stream.js';
import type { Executor, TaskRun, WorkItem, Workspace } from '../src/types.js';

const at = (hour: number) => `2026-10-18T${String(hour).padStart(2, '0')}:00:00.000Z`;
const item = (id: string, values: Partial<WorkItem> = {}): WorkItem => ({ id, title: id, prompt: 'Private original prompt', result: '', agent: 'codex', mode: 'research', status: 'running',
  projectId: 'project', cwd: '/project', createdAt: at(1), updatedAt: at(12), durableId: null, threadId: 'thread-' + id, turnId: 'turn-' + id,
  events: [], approvals: [], error: null, artifact: null, lastRequestId: 'request-' + id, autoSettle: false, ...values });
const run = (id: string, requested: string, values: Partial<TaskRun> = {}): TaskRun => ({ id, messageId: 'message-' + id, requestId: 'request-' + id, durableId: null, cwd: '/project', at: requested,
  status: 'running', mode: 'research', interactionMode: 'default', ...values });
const state = (tasks: WorkItem[]): Workspace => ({ revision: 0, tasks, projects: [{ id: 'project', name: 'Project', path: '/project', context: '' }], ideas: [], memories: [], requests: {} });

test('Working activity keeps pending approvals, questions, plans, failures and workspace requests in the inbox', () => {
  const active = item('active'); assert.equal(taskSidebarActivity(active).working, true);
  for (const method of ['command', 'file', 'question']) {
    const waiting = item('approval', { status: 'waiting', approvals: [{ id: 'approval', method, title: 'SECRET_TITLE', detail: 'SECRET_BODY', questions: [], state: 'pending' }] });
    assert.equal(taskSidebarActivity(waiting).working, false); assert.equal(taskSidebarSection(waiting, at(12), true), 'active');
    waiting.approvals[0].state = 'answered'; assert.equal(taskSidebarSection(waiting, at(12), true), 'working');
  }
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'needs_project'] as const) assert.equal(taskSidebarActivity(item(status, { status })).working, false);
  assert.equal(taskSidebarActivity(item('plan', { status: 'completed', interactionMode: 'plan', events: [{ id: 'proposal', kind: 'proposal', text: '# Plan', at: at(11), status: 'completed' }] })).working, false);
  assert.equal(taskSidebarActivity(item('between', { status: 'completed', queue: { dispatcherId: 1, paused: false, messages: [] } })).working, true);
  assert.equal(taskSidebarSection(item('pin', { pinnedAt: at(2) }), at(12), true), 'pinned');
  assert.equal(taskSidebarSection(item('settled', { settledAt: at(2) }), at(12), true), 'settled');
  assert.equal(taskSidebarSection(active, at(12)), 'active'); assert.equal(taskSidebarSection(active, at(12), true), 'working');
});

test('Working sorts by actual human send time, including queued input, rather than later runs or output', () => {
  const queued = item('queued', { messages: [{ id: 'queued-user', role: 'user', text: 'Private queued text', at: at(9) }],
    queue: { dispatcherId: 2, paused: false, messages: [{ id: 'queued-user', dispatchId: 'dispatch', text: 'Private queued text', images: [], createdAt: at(3), status: 'running' }] },
    runs: [run('late-run', at(9), { messageId: 'queued-user' })] });
  const latest = item('latest', { messages: [{ id: 'latest-user', role: 'user', text: 'Later send', at: at(5) }] });
  const launched = item('launched', { messages: [], runs: [run('automatic-run', at(11))] });
  assert.equal(taskSidebarActivity(queued).latestUserAuthoredMessageAt, at(3));
  assert.equal(taskSidebarActivity(queued).latestRunRequestedAt, at(3), 'A delayed queue activation retains the accepted request date');
  assert.equal(taskSidebarActivity(launched).latestUserAuthoredMessageAt, null);
  assert.deepEqual(sortSidebarSection([queued, launched, latest], 'working').map(task => task.id), ['latest', 'queued', 'launched']);
  queued.messages!.push({ id: 'reverted', role: 'user', text: 'Ignore reverted input', at: at(12), revertedAt: at(12) });
  assert.equal(taskSidebarActivity(queued).latestUserAuthoredMessageAt, at(3));
  queued.queue!.messages.push({ id: 'pending-user', dispatchId: 'pending', text: 'Pending human input', images: [], createdAt: at(6), status: 'queued' });
  assert.equal(taskSidebarActivity(queued).latestUserAuthoredMessageAt, at(6), 'Accepted input counts before its future run starts');
  queued.queue!.messages[1].status = 'cancelled';
  assert.equal(taskSidebarActivity(queued).latestUserAuthoredMessageAt, at(3));
  queued.messages![0].revertedAt = at(12);
  assert.equal(taskSidebarActivity(queued).latestUserAuthoredMessageAt, null, 'Retained queue receipts cannot resurrect reverted sends');
});

test('The time-ordered inbox uses completion, request and resume timestamps and never destroys the saved manual order', () => {
  const created = item('created', { status: 'completed', createdAt: at(8), activeOrderKey: 'z' });
  const finished = item('finished', { status: 'completed', runs: [run('done', at(2), { status: 'completed', completedAt: at(11) })], activeOrderKey: 'm' });
  const resumed = item('resumed', { status: 'completed', unsettledAt: at(10), activeOrderKey: 'a' });
  assert.deepEqual(sortSidebarSection([created, finished, resumed], 'active', true).map(task => task.id), ['finished', 'resumed', 'created']);
  assert.deepEqual(sortSidebarSection([created, finished, resumed], 'active').map(task => task.id), ['resumed', 'finished', 'created']);
  assert.deepEqual([created.activeOrderKey, finished.activeOrderKey, resumed.activeOrderKey], ['z', 'm', 'a']);
});

test('Time-ordered cross-shelf moves accept client-observed return order, ignore manual key drift and preserve keys for the default mode', () => {
  const inbox = item('inbox', { status: 'completed', activeOrderKey: 'm' });
  const approval = item('approval', { status: 'waiting', activeOrderKey: 't', approvals: [{ id: 'q', method: 'question', title: 'Question', detail: '', questions: [], state: 'pending' }] });
  const pin = item('pin', { status: 'completed', pinnedAt: at(2), pinOrderKey: 'n', activeOrderKey: 'q' });
  const workspace = state([inbox, approval, pin, item('working')]);
  const move = taskSidebarMove({ requestId: 'time-move', projectId: 'project', source: 'pinned', section: 'active', workingShelfEnabled: true,
    expected: [{ id: 'approval', key: 't' }, { id: 'inbox', key: 'm' }], orderedIds: ['approval', 'pin', 'inbox'] });
  inbox.activeOrderKey = 'g'; applyTaskSidebarMove(workspace, 'pin', move, at(12));
  assert.equal(pin.pinnedAt, null); assert.equal(pin.activeOrderKey, 'q'); assert.equal(inbox.activeOrderKey, 'g'); assert.equal(approval.activeOrderKey, 't');
  assert.deepEqual(sortSidebarSection([inbox, approval, pin], 'active').map(task => task.id), ['inbox', 'pin', 'approval']);
  for (const flag of ['true', null, 1]) assert.throws(() => taskSidebarMove({ ...move, workingShelfEnabled: flag }));
  assert.throws(() => taskSidebarMove({ ...move, section: 'working' }));
  const legacy = { ...move, workingShelfEnabled: undefined }; delete legacy.workingShelfEnabled;
  assert.equal(Object.hasOwn(taskSidebarMove(legacy), 'workingShelfEnabled'), false);
  assert.equal(Object.hasOwn(taskSidebarMove({ ...legacy, workingShelfEnabled: false }), 'workingShelfEnabled'), false, 'Legacy receipt digests must survive an explicit default');
});

test('Activity summaries carry only classification and timestamps, with current-run and reverted-run boundaries intact', () => {
  const task = item('task', { currentRunId: 'current', messages: [{ id: 'm', role: 'user', text: 'SECRET_MESSAGE', at: at(4) }],
    runs: [run('current', at(4)), run('reverted', at(12), { revertedAt: at(12), completedAt: at(12) })],
    approvals: [{ id: 'approval', method: 'question', title: 'SECRET_APPROVAL', detail: 'SECRET_INPUT', questions: [], state: 'pending' }] });
  const summary = taskSummary(task, 1); assert.equal(summary.sidebarActivity?.working, false);
  assert.equal(summary.sidebarActivity?.latestRunRequestedAt, at(4)); assert.equal(summary.sidebarActivity?.latestRunCompletedAt, null);
  assert.doesNotMatch(JSON.stringify(summary), /SECRET_MESSAGE|SECRET_APPROVAL|SECRET_INPUT/);
  assert.equal(taskOverview(state([task]), 'service').tasks[0].sidebarActivity?.working, false);
});

test('Engine and authenticated move API expose Working capability and revalidate the time-ordered partition after an approval transition', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-working-')); const executor: Executor = { async run() { throw new Error('Metadata cannot start execution'); }, async answer() {}, async steer() {} };
  const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory); t.after(async () => { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const app = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  await engine.mutate(value => Object.assign(value, state([item('worker'), item('pin', { status: 'completed', pinnedAt: at(2), pinOrderKey: 'n' })])));
  const snapshot = await engine.snapshot(); assert.equal(snapshot.taskSidebarWorkingSupported, true); assert.equal(snapshot.tasks[0].sidebarActivity?.working, true);
  const overview = await (await app.request('/api/overview', { headers })).json(); assert.equal(overview.taskSidebarWorkingSupported, true); assert.equal(overview.tasks[0].sidebarActivity.working, true);
  const body = { requestId: 'old-inbox', projectId: 'project', source: 'pinned', section: 'active', workingShelfEnabled: true, expected: [], orderedIds: ['pin'] };
  await engine.mutate(value => value.tasks[0].approvals.push({ id: 'approval', method: 'question', title: 'Input', detail: '', questions: [], state: 'pending' }));
  const post = (body: object) => app.request('/api/tasks/pin/sidebar/move', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(body)).status, 409, 'A thread returning for approval changes the partition and must be re-read');
  assert.equal((await engine.snapshot()).tasks[1].pinnedAt, at(2));
  assert.equal((await post({ ...body, requestId: 'fresh-inbox', expected: [{ id: 'worker', key: null }], orderedIds: ['worker', 'pin'] })).status, 200);
  const after = await engine.snapshot(); assert.equal(after.tasks[0].sidebarActivity?.working, false); assert.equal(after.tasks[1].activeOrderKey, undefined);
});
