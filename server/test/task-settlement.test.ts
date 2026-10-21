import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { Engine } from '../src/engine.js';
import { resolveTaskSettlement, TaskSettlement, taskSettlementAt, taskSettlementChange, taskSettlementDefaults } from '../src/task-settlement.js';
import { taskSidebarSection } from '../src/task-sidebar-order.js';
import type { Executor, TaskGitOperation, TaskRun, WorkItem, Workspace } from '../src/types.js';

const DAY = 86_400_000; const NOW = Date.now(); const iso = (offset: number) => new Date(NOW + offset).toISOString();
const item = (id: string, values: Partial<WorkItem> = {}): WorkItem => ({ id, title: id, prompt: 'Original input', result: 'Original result', projectId: 'project', cwd: '/project', agent: 'codex', mode: 'research',
  status: 'completed', createdAt: iso(-10 * DAY), updatedAt: iso(-4 * DAY), durableId: null, threadId: 'native-' + id, turnId: 'turn-' + id, events: [], approvals: [], artifact: null, error: null, lastRequestId: id, ...values });
const run = (values: Partial<TaskRun> = {}): TaskRun => ({ id: 'run', durableId: null, messageId: 'message', requestId: 'request', cwd: '/project', at: iso(-5 * DAY), startedAt: iso(-5 * DAY),
  completedAt: iso(-4 * DAY), status: 'completed', mode: 'research', interactionMode: 'default', ...values });
const workspace = (): Workspace => ({ revision: 0, tasks: [], requests: {}, ideas: [], memories: [], projects: [] });

test('Auto-settle settings preserve T3 defaults, fractional API bounds, null inheritance and strict patch scope', () => {
  assert.equal(taskSettlementDefaults().defaults.sidebarAutoSettleAfterDays, 3);
  assert.equal(resolveTaskSettlement(workspace(), null).effective.sidebarAutoSettleAfterDays, 3);
  for (const days of [1, 1.5, 90, null]) assert.equal(taskSettlementChange({ projectId: null, expectedVersion: 0, changes: { sidebarAutoSettleAfterDays: days } }).changes.sidebarAutoSettleAfterDays, days);
  for (const bad of [undefined, NaN, Infinity, -1, 0, 90.1, '3', false]) assert.throws(() => taskSettlementChange({ projectId: null, expectedVersion: 0, changes: { sidebarAutoSettleAfterDays: bad } }));
  for (const bad of [null, {}, { projectId: '__proto__', expectedVersion: 0, reset: ['sidebarAutoSettleAfterDays'] }, { projectId: null, expectedVersion: -1, reset: ['sidebarAutoSettleAfterDays'] },
    { projectId: null, expectedVersion: 0, changes: { unknown: true } }, { projectId: null, expectedVersion: 0, reset: ['sidebarAutoSettleAfterDays', 'sidebarAutoSettleAfterDays'] },
    { projectId: null, expectedVersion: 0, changes: { sidebarAutoSettleAfterDays: null }, reset: ['sidebarAutoSettleAfterDays'] }]) assert.throws(() => taskSettlementChange(bad));
});

test('Inactivity uses real user/run activity with a strict day boundary and valid legacy fallback, never incidental output updates', () => {
  const task = item('timed', { updatedAt: iso(0), messages: [{ id: 'message', role: 'user', text: 'Input', at: iso(-5 * DAY) }], runs: [run()] });
  assert.equal(taskSettlementAt(task, NOW, 3), iso(-4 * DAY));
  assert.equal(taskSettlementAt(task, NOW - DAY, 3), null); assert.equal(taskSettlementAt(task, NOW - DAY + 1, 3), iso(-4 * DAY));
  assert.equal(taskSettlementAt(task, NOW, null), null);
  task.runs!.push(run({ id: 'rolled-back', completedAt: iso(0), revertedAt: iso(0) })); assert.equal(taskSettlementAt(task, NOW, 3), iso(-4 * DAY));
  assert.equal(taskSettlementAt(item('legacy'), NOW, 3), iso(-4 * DAY));
  assert.equal(taskSettlementAt(item('no-activity', { messages: [], runs: [] }), NOW, 3), null);
});

test('Pinned, explicit, pending, uncertain, running and known open-PR threads are never auto-settled', () => {
  const pr: TaskGitOperation = { id: 'git', durableId: 1, action: 'create_pr', status: 'completed', cwd: '/project', root: '/project', createdAt: iso(-5 * DAY), updatedAt: iso(-4 * DAY), phase: 'pr', steps: [], branch: 'feature', head: 'head', contentFingerprint: 'fingerprint', files: [],
    pullRequest: { number: 1, url: 'https://github.com/example/repository/pull/1', title: 'PR', state: 'open', base: 'main', head: 'feature' } };
  for (const values of [{ pinnedAt: iso(-5 * DAY) }, { archivedAt: iso(-5 * DAY) }, { autoSettle: false }, { settledAt: iso(-5 * DAY) }, { settledOverride: 'active' as const }, { settledOverride: 'settled' as const },
    { agent: 'friday' }, { status: 'running' as const }, { status: 'waiting' as const }, { status: 'needs_project' as const }, { gitOperation: pr },
    { approvals: [{ id: 'a', method: 'question', title: 'Input', detail: '', questions: [], state: 'pending' as const }] },
    { messages: [{ id: 'uncertain', role: 'user' as const, text: 'Input', at: iso(-4 * DAY), delivery: 'uncertain' as const }] },
    { queue: { dispatcherId: null, paused: true, messages: [{ id: 'pending', dispatchId: 'dispatch', text: 'Input', images: [], createdAt: iso(-4 * DAY), status: 'queued' as const }] } }]) {
    assert.equal(taskSettlementAt(item('protected', values), NOW, 3), null, JSON.stringify(values));
  }
});

test('Snooze wake restarts inactivity, including expired timers, without using unread or metadata update times', () => {
  const sleeping = item('asleep', { snoozedUntil: iso(DAY) }); assert.equal(taskSettlementAt(sleeping, NOW, 3), null);
  const awake = item('awake', { snoozedUntil: iso(-DAY) }); assert.equal(taskSettlementAt(awake, NOW, 3), null);
  assert.equal(taskSettlementAt(awake, NOW + 2 * DAY, 3), null); assert.equal(taskSettlementAt(awake, NOW + 2 * DAY + 1, 3), iso(-DAY));
  assert.equal(taskSettlementAt(item('manual-wake', { lastSnoozeWakeAt: iso(-DAY) }), NOW, 3), null);
});

async function setup(t: { after: (callback: () => Promise<unknown>) => void }) {
  const base = await mkdtemp(join(tmpdir(), 'friday-auto-settle-')); const cwd = join(base, 'project'); const directory = join(base, 'data'); await mkdir(cwd);
  let calls = 0; const executor: Executor = { async run(request) { calls++; await request.update({ kind: 'session', threadId: request.task.threadId ?? 'native' }); return 'New answer'; }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor).open(); const auth = new Auth(directory); let app = createAPI(engine, auth, () => []);
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Project', path: cwd, context: '' }]; state.taskSettlementSettings = { version: 0, defaults: { sidebarAutoSettleAfterDays: null }, projects: {} }; });
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { cwd, directory, auth, get app() { return app; }, get engine() { return engine; }, get calls() { return calls; },
    reopen: async () => { await engine.close(); engine = await new Engine(directory, executor).open(); app = createAPI(engine, auth, () => []); },
    change: async (days: number | null, projectId: string | null = null) => engine.taskSettlement.save({ projectId, expectedVersion: (await engine.snapshot()).taskSettlementSettings?.version ?? 0, changes: { sidebarAutoSettleAfterDays: days } }),
  };
}

test('Paired settings save with CAS, preserve explicit disable versus inheritance and clear overrides on Workspace deletion', async t => {
  const f = await setup(t); const device = f.auth.pair(f.auth.createPairing().code, 'Phone', 'fixture'); const headers = { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' };
  const patch = (body: object) => f.app.request('/api/task-settlement/settings', { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await f.app.request('/api/task-settlement/settings')).status, 401);
  const body = { projectId: null, expectedVersion: 0, changes: { sidebarAutoSettleAfterDays: 5 } }; assert.equal((await patch(body)).status, 200); assert.equal((await patch(body)).status, 409);
  await f.change(null, 'project'); let settings = await f.engine.taskSettlement.snapshot('project'); assert.equal(settings.effective.sidebarAutoSettleAfterDays, null); assert.equal(settings.source, 'workspace');
  await f.reopen(); settings = await f.engine.taskSettlement.snapshot('project'); assert.equal(settings.overrides.sidebarAutoSettleAfterDays, null);
  assert.equal((await patch({ projectId: 'project', expectedVersion: settings.version, reset: ['sidebarAutoSettleAfterDays'] })).status, 200);
  settings = await f.engine.taskSettlement.snapshot('project'); assert.deepEqual(settings.overrides, {}); assert.equal(settings.effective.sidebarAutoSettleAfterDays, 5);
  await f.change(1.5, 'project');
  const overview = await (await f.app.request('/api/overview', { headers })).json(); assert.equal(overview.taskAutoSettlementSupported, true); assert.equal(overview.taskSettlementSettingsVersion, settings.version + 1);
  assert.equal((await f.app.request('/api/projects/project', { method: 'DELETE', headers })).status, 200);
  assert.deepEqual((await f.engine.snapshot()).taskSettlementSettings?.projects, {});
  assert.equal((await f.app.request('/api/task-settlement/settings?projectId=project', { headers })).status, 400);
  f.auth.revoke(device.id); assert.equal((await patch({ ...body, expectedVersion: 4 })).status, 401);
});

test('Headless sweeps persist backdated settlement once and retain native identity, output and activity time across restart', async t => {
  const f = await setup(t); const original = item('thread', { cwd: f.cwd, activeOrderKey: 'm', messages: [{ id: 'message', role: 'user', text: 'Input', at: iso(-5 * DAY) }], runs: [run()] });
  await f.engine.mutate(state => { state.tasks.push(original); state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 3; });
  assert.equal(taskSidebarSection((await f.engine.snapshot()).tasks[0], iso(0)), 'active', 'Time alone does not fabricate persisted settlement');
  await f.reopen(); const task = (await f.engine.snapshot()).tasks[0];
  assert.equal(task.settledAt, iso(-4 * DAY)); assert.equal(task.settledOverride, 'settled'); assert.equal(task.activeOrderKey, null); assert.equal(task.settlementManaged, true);
  assert.equal(task.updatedAt, original.updatedAt); assert.equal(task.threadId, original.threadId); assert.equal(task.result, original.result); assert.equal(f.calls, 0);
  const before = (await f.engine.snapshot()).revision; await f.engine.taskSettlement.sweep(NOW + DAY); await f.engine.taskSettlement.sweep(NOW + 2 * DAY); assert.equal((await f.engine.snapshot()).revision, before, 'Idle and repeated sweeps create no heartbeat writes');
});

test('Manual restore remains active until new activity, repeated commands are idempotent and a resumed native turn restores automatic rules', async t => {
  const f = await setup(t); await f.engine.mutate(state => { state.tasks.push(item('thread', { cwd: f.cwd, settledAt: iso(-4 * DAY), settledOverride: 'settled' })); state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 3; });
  await f.engine.updateTaskMetadata('thread', { settled: false }); const restored = (await f.engine.snapshot()).tasks[0].unsettledAt;
  await f.engine.updateTaskMetadata('thread', { settled: false }); assert.equal((await f.engine.snapshot()).tasks[0].unsettledAt, restored);
  await f.engine.taskSettlement.sweep(NOW + 10 * DAY); assert.equal((await f.engine.snapshot()).tasks[0].settledAt, null);
  await f.engine.createTask({ continueId: 'thread', projectId: 'project', requestId: 'continue', agent: 'codex', mode: 'research', prompt: 'Continue' });
  const deadline = Date.now() + 5_000; while ((await f.engine.snapshot()).tasks[0].status !== 'completed') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal((await f.engine.snapshot()).tasks[0].settledOverride, null); await f.engine.taskSettlement.sweep(Date.now() + 4 * DAY);
  assert.equal((await f.engine.snapshot()).tasks[0].settledOverride, 'settled'); assert.equal(f.calls, 1);
});

test('The transaction rechecks execution and scope choices, protecting new activity and Workspace-specific disable', async t => {
  const f = await setup(t); await f.engine.mutate(state => {
    state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 1;
    state.taskSettlementSettings!.projects.project = { sidebarAutoSettleAfterDays: null };
    state.tasks = [item('scoped', { cwd: f.cwd }), item('running', { projectId: null, status: 'running' }), item('recent', { projectId: null, updatedAt: iso(0) })];
  });
  await f.engine.taskSettlement.sweep(NOW); assert.ok((await f.engine.snapshot()).tasks.every(task => !task.settledAt));
  const settings = await f.engine.taskSettlement.snapshot(null);
  const replies = await Promise.allSettled([2, 3].map(days => f.engine.taskSettlement.save({ projectId: null, expectedVersion: settings.version, changes: { sidebarAutoSettleAfterDays: days } })));
  assert.equal(replies.filter(reply => reply.status === 'fulfilled').length, 1); assert.equal(replies.filter(reply => reply.status === 'rejected').length, 1);
});

test('The resident reconciliation timer settles without a window and drains cleanly when stopped', async t => {
  const f = await setup(t); const worker = new TaskSettlement(f.engine, 15);
  try {
    await worker.start();
    await f.engine.mutate(state => { state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 3; state.tasks.push(item('timer', { cwd: f.cwd })); });
    const deadline = Date.now() + 2_000;
    while (!(await f.engine.snapshot()).tasks[0].settledAt) { assert.ok(Date.now() < deadline, 'The actual timer must fire'); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(f.calls, 0);
  } finally { await worker.close(); }
  await f.engine.mutate(state => state.tasks.push(item('after-stop', { cwd: f.cwd })));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await f.engine.snapshot()).tasks[1].settledAt, undefined, 'A stopped timer cannot commit after its service owner drains');
});

test('Pinning a snoozed task records its wake, so a later unpin does not immediately settle old activity', async t => {
  const f = await setup(t); await f.engine.mutate(state => { state.taskSettlementSettings!.defaults.sidebarAutoSettleAfterDays = 3; state.tasks.push(item('wake-pin', { cwd: f.cwd, snoozedUntil: iso(DAY) })); });
  await f.engine.updateTaskMetadata('wake-pin', { pinned: true }); let task = (await f.engine.snapshot()).tasks[0];
  assert.equal(task.snoozedUntil, null); assert.ok(task.lastSnoozeWakeAt);
  await f.engine.updateTaskMetadata('wake-pin', { pinned: false }); await f.engine.taskSettlement.sweep(); task = (await f.engine.snapshot()).tasks[0];
  assert.equal(task.settledAt, null); assert.equal(task.updatedAt, iso(-4 * DAY));
});


function endedPR(number=1, state: 'open'|'closed'|'merged'='merged', end=iso(-DAY), linkedAt=iso(-3*DAY)) {
 return {number,url:`https://github.com/owner/repo/pull/${number}`,provider:'github' as const,host:'github.com',repository:'owner/repo',title:'PR '+number,state,head:'feature/'+number,base:'main',linkedAt,
  snapshot:{state,title:'PR '+number,headBranch:'feature/'+number,baseBranch:'main',isDraft:false,updatedAt:end,syncedAt:iso(0),mergedAt:state==='merged'?end:null,closedAt:state==='closed'?end:null}};
}
test('Merge settlement is independent from inactivity, requires every effective link to be terminal, and backdates real activity',()=>{
 const t=item('merged',{messages:[{id:'user',role:'user',text:'Work',at:iso(-5*DAY)}],runs:[run()],changeRequests:[endedPR()]});
 assert.equal(taskSettlementAt(t,NOW,null),iso(-4*DAY));assert.equal(taskSettlementAt(t,NOW,null,{sidebarAutoSettleOnMerge:false}),null);
 t.changeRequests!.push(endedPR(2,'open'));assert.equal(taskSettlementAt(t,NOW,null),null);
 t.changeRequests![1]={...t.changeRequests![1],dismissedAt:iso(0)};assert.equal(taskSettlementAt(t,NOW,null),iso(-4*DAY));
 t.changeRequests=[endedPR(1,'closed')];assert.equal(taskSettlementAt(t,NOW,null,{sidebarAutoSettleOnMerge:false}),iso(-4*DAY));
});
test('A terminal link adopted after its result, a missing merge time and a new user requirement cannot trigger immediate settlement',()=>{
 const t=item('new-work',{messages:[{id:'user',role:'user',text:'Work',at:iso(-5*DAY)}],runs:[run()],changeRequests:[endedPR(1,'merged',iso(-2*DAY),iso(-DAY))]});
 assert.equal(taskSettlementAt(t,NOW,null),null);
 t.changeRequests=[endedPR()];t.changeRequests[0].snapshot!.mergedAt=null;assert.equal(taskSettlementAt(t,NOW,null),null);
 t.changeRequests=[endedPR()];t.messages!.push({id:'new',role:'user',text:'New requirement',at:iso(-DAY/2)});assert.equal(taskSettlementAt(t,NOW,null),null);
 t.changeRequests=[{...endedPR(),snapshot:undefined} as any];assert.equal(taskSettlementAt(t,NOW,1),null);
});
test('Keeping PR tasks affects inactivity while eligible terminal outcomes still settle, and queued turn grace is two minutes',()=>{
 const t=item('kept',{messages:[{id:'user',role:'user',text:'Work',at:iso(-5*DAY)}],runs:[run()],changeRequests:[endedPR()]});
 assert.equal(taskSettlementAt(t,NOW,3,{sidebarAutoSettleOnMerge:false,sidebarAutoSettleKeepPullRequests:true}),null);
 assert.equal(taskSettlementAt(t,NOW,3,{sidebarAutoSettleOnMerge:true,sidebarAutoSettleKeepPullRequests:true}),iso(-4*DAY));
 t.messages![0].at=iso(-30_000);t.changeRequests=[endedPR(1,'merged',iso(1000))];assert.equal(taskSettlementAt(t,NOW,null),null);
 t.status='failed';assert.equal(taskSettlementAt(t,NOW,null),iso(-30_000));
});
test('Branch-only references can age normally while Keep PR tasks and explicit open links retain them',()=>{
 const t=item('branch-only',{messages:[{id:'user',role:'user',text:'Work',at:iso(-5*DAY)}],runs:[run()],branchPullRequest:endedPR(1,'open')});
 assert.equal(taskSettlementAt(t,NOW,3,{allowBranchOutcome:false}),iso(-4*DAY));
 assert.equal(taskSettlementAt(t,NOW,3,{sidebarAutoSettleKeepPullRequests:true,allowBranchOutcome:false}),null);
 t.changeRequests=[endedPR(1,'open')];assert.equal(taskSettlementAt(t,NOW,3),null);
});
test('Settlement settings preserve explicit false overrides and reset each field independently across devices and restart',async t=>{
 const f=await setup(t);let settings=await f.engine.taskSettlement.snapshot(null);assert.equal(settings.effective.sidebarAutoSettleOnMerge,true);assert.equal(settings.effective.sidebarAutoSettleKeepPullRequests,false);
 settings=await f.engine.taskSettlement.save({projectId:null,expectedVersion:settings.version,changes:{sidebarAutoSettleOnMerge:false,sidebarAutoSettleKeepPullRequests:true}});
 let project=await f.engine.taskSettlement.save({projectId:'project',expectedVersion:settings.version,changes:{sidebarAutoSettleOnMerge:true,sidebarAutoSettleKeepPullRequests:false}});assert.equal(project.sources.sidebarAutoSettleOnMerge,'workspace');assert.equal(project.effective.sidebarAutoSettleKeepPullRequests,false);
 await f.reopen();project=await f.engine.taskSettlement.snapshot('project');assert.equal(project.overrides.sidebarAutoSettleKeepPullRequests,false);
 project=await f.engine.taskSettlement.save({projectId:'project',expectedVersion:project.version,reset:['sidebarAutoSettleOnMerge']});assert.equal(project.effective.sidebarAutoSettleOnMerge,false);assert.equal(project.overrides.sidebarAutoSettleKeepPullRequests,false);
 for(const invalid of [null,'false',0])assert.throws(()=>taskSettlementChange({projectId:null,expectedVersion:0,changes:{sidebarAutoSettleOnMerge:invalid}}));
});
