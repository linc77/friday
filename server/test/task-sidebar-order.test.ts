import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { Engine } from '../src/engine.js';
import { applyTaskSidebarMove, generateSpreadPinOrderKeys, pinOrderKeyBetween, planPinnedReorder, sidebarTaskScope, sortSidebarSection, taskSidebarMove, taskSidebarSection, type TaskSidebarMove } from '../src/task-sidebar-order.js';
import { taskOverview } from '../src/task-stream.js';
import type { Executor, WorkItem, Workspace } from '../src/types.js';

const now = '2026-10-18T12:00:00Z';
const item = (id: string, values: Partial<WorkItem> = {}): WorkItem => ({ id, title: id, prompt: 'Private prompt', result: 'Private result', agent: 'codex', mode: 'code',
  status: 'completed', createdAt: '2026-10-18T01:00:00Z', updatedAt: now, projectId: 'a', cwd: '/project/a', events: [], approvals: [], durableId: null, threadId: 'native-' + id,
  turnId: 'turn-' + id, error: null, artifact: null, lastRequestId: 'task-' + id, autoSettle: false, ...values });
const workspace = (tasks: WorkItem[]): Workspace => ({ revision: 0, tasks, requests: {}, ideas: [], memories: [],
  projects: [{ id: 'a', name: 'A', path: '/project/a', context: '' }, { id: 'b', name: 'B', path: '/project/b', context: '' }] });
function move(state: Workspace, id: string, section: TaskSidebarMove['section'], ids: string[], requestId = 'move', projectId: string | null = 'a'): TaskSidebarMove {
  const rows = sidebarTaskScope(state, projectId); const task = rows.find(task => task.id === id)!;
  return taskSidebarMove({ requestId, projectId, source: taskSidebarSection(task, new Date().toISOString()), section, orderedIds: ids,
    expected: sortSidebarSection(rows.filter(task => taskSidebarSection(task, new Date().toISOString()) === section), section)
      .map(task => ({ key: (section === 'pinned' ? task.pinOrderKey : section === 'active' ? task.activeOrderKey : null) ?? null, id: task.id })) });
}

test('T3 fractional keys support repeated edge inserts, corrupt-key repair and reserved keys in hidden Workspaces', () => {
  assert.equal(pinOrderKeyBetween(null, null), 'n'); assert.equal(pinOrderKeyBetween('m', 'n'), 'mn');
  for (const pair of [['ma', 'n'], ['z', 'b'], ['', 'a0'], ['x', 'xa']]) assert.equal(pinOrderKeyBetween(pair[0], pair[1]), null);
  let head: string | null = null;
  for (let i = 0; i < 500; i++) { const next: string = pinOrderKeyBetween(null, head)!; assert.ok(next && (head === null || next < head)); head = next; }
  const spread = generateSpreadPinOrderKeys(1_000); assert.equal(new Set(spread).size, 1_000); assert.deepEqual([...spread].sort(), spread); assert.ok(spread.every(key => !key.endsWith('a')));
  const keys = new Map([['a', 'g'], ['b', 't'], ['hidden', 'd']]);
  const assignments = planPinnedReorder({ orderedIds: ['b', 'a'], keysById: keys, movedId: 'b' });
  assert.equal(assignments.length, 1); assert.equal(assignments[0].id, 'b'); assert.ok(assignments[0].orderKey < 'g'); assert.notEqual(assignments[0].orderKey, 'd');
  const repaired = planPinnedReorder({ orderedIds: ['b', 'a'], keysById: new Map([['a', 'corrupt0'], ['b', null], ['hidden', 'ij']]), movedId: 'b' });
  assert.deepEqual(repaired.map(entry => entry.id), ['b', 'a']); assert.ok(repaired[0].orderKey < repaired[1].orderKey); assert.ok(repaired.every(entry => entry.orderKey !== 'ij'));
});

test('Default sidebar sorting follows independent pin keys, creation/resume anchors and settlement time rather than live output', () => {
  const rows = [item('keyless-old', { createdAt: '2026-10-17T01:00:00Z' }), item('second', { pinOrderKey: 't', activeOrderKey: 't' }),
    item('first', { pinOrderKey: 'g', activeOrderKey: 'g' }), item('keyless-new', { createdAt: '2026-10-18T11:00:00Z' })];
  assert.deepEqual(sortSidebarSection(rows, 'pinned').map(task => task.id), ['first', 'second', 'keyless-new', 'keyless-old']);
  assert.deepEqual(sortSidebarSection(rows, 'active').map(task => task.id), ['keyless-new', 'keyless-old', 'first', 'second']);
  rows[0].unsettledAt = '2026-10-18T11:30:00Z'; rows[1].updatedAt = '2099-01-01T00:00:00Z';
  assert.deepEqual(sortSidebarSection(rows, 'active').map(task => task.id), ['keyless-old', 'keyless-new', 'first', 'second']);
  const settled = [item('old', { settledAt: '2026-10-18T01:00:00Z', updatedAt: '2099-01-01T00:00:00Z' }), item('new', { settledAt: '2026-10-18T11:00:00Z' })];
  assert.deepEqual(sortSidebarSection(settled, 'settled').map(task => task.id), ['new', 'old']);
  assert.equal(taskSidebarSection(item('manual', { status: 'running', settledAt: now, pinnedAt: now }), now), 'settled');
  assert.equal(taskSidebarSection(item('expired', { autoSettle: true, updatedAt: '2026-10-01T01:00:00Z' }), now), 'active', 'The service must persist settlement before the sidebar changes groups');
  assert.equal(taskSidebarSection(item('between-turns', { autoSettle: true, updatedAt: '2026-10-01T01:00:00Z', queue: { dispatcherId: 1, paused: false, messages: [] } }), now), 'active');
});

test('Move validation rejects unknown sections, duplicates, foreign tasks and obsolete lifecycle without partial writes', () => {
  const valid = { requestId: 'move', projectId: 'a', source: 'active', section: 'pinned', orderedIds: ['a'], expected: [] };
  for (const invalid of [null, {}, { ...valid, projectId: '__proto__' }, { ...valid, source: ['active'] }, { ...valid, section: 'snoozed' }, { ...valid, orderedIds: ['a', 'a'] }, { ...valid, expected: [{ id: 'a' }] }, { ...valid, extra: true }]) assert.throws(() => taskSidebarMove(invalid));
  const state = workspace([item('a'), item('b', { projectId: 'b', cwd: '/project/b' }), item('gone', { projectId: 'missing' }), item('friday', { agent: 'friday' })]);
  assert.deepEqual(sidebarTaskScope(state, 'a').map(task => task.id), ['a']); assert.deepEqual(sidebarTaskScope(state, null).map(task => task.id), ['a', 'b']);
  assert.throws(() => applyTaskSidebarMove(state, 'a', { ...taskSidebarMove(valid), orderedIds: ['a', 'b'] }, now), /范围已改变/);
  assert.equal(state.tasks[0].pinnedAt, undefined); assert.equal(state.sidebarRequests, undefined);
  state.tasks[0].settledAt = now; assert.throws(() => applyTaskSidebarMove(state, 'a', taskSidebarMove(valid), now), /其他设备/);
});

async function setup(t: { after: (callback: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-sidebar-order-'));
  const executor: Executor = { async run() { throw new Error('Sidebar moves cannot start execution'); }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor).open(); const auth = new Auth(directory); let app = createAPI(engine, auth, () => []);
  const device = auth.pair(auth.createPairing().code, 'Phone', 'fixture');
  const headers = { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' };
  await engine.mutate(state => Object.assign(state, workspace([item('a', { pinnedAt: now, pinOrderKey: 'g' }), item('b', { pinnedAt: now, pinOrderKey: 't' }), item('c'),
    item('hidden', { projectId: 'b', cwd: '/project/b', pinnedAt: now, pinOrderKey: 'd' })])));
  t.after(async () => { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine; }, get app() { return app; }, auth, device, headers,
    post: (id: string, body: unknown) => app.request('/api/tasks/' + id + '/sidebar/move', { method: 'POST', headers, body: JSON.stringify(body) }),
    reopen: async () => { await engine.close(); engine = await new Engine(directory, executor).open(); app = createAPI(engine, auth, () => []); } };
}

test('Paired sidebar moves persist, reserve hidden keys, publish compact order metadata and deduplicate stale retries after a later move', async t => {
  const f = await setup(t); const before = await f.engine.snapshot(); const first = move(before, 'b', 'pinned', ['b', 'a']);
  assert.equal((await f.app.request('/api/tasks/b/sidebar/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(first) })).status, 401);
  assert.equal((await f.post('b', first)).status, 200); let state = await f.engine.snapshot();
  assert.deepEqual(sortSidebarSection(sidebarTaskScope(state, 'a').filter(task => task.pinnedAt), 'pinned').map(task => task.id), ['b', 'a']);
  assert.equal(state.tasks[3].pinOrderKey, 'd'); assert.notEqual(state.tasks[1].pinOrderKey, 'd');
  assert.equal(state.tasks[1].updatedAt, before.tasks[1].updatedAt); assert.equal(state.tasks[1].result, before.tasks[1].result); assert.equal(state.tasks[1].threadId, before.tasks[1].threadId);
  const second = move(state, 'a', 'pinned', ['a', 'b'], 'later'); assert.equal((await f.post('a', second)).status, 200);
  await f.reopen(); const key = (await f.engine.snapshot()).tasks[0].pinOrderKey;
  assert.equal((await f.post('b', first)).status, 200); state = await f.engine.snapshot(); assert.equal(state.tasks[0].pinOrderKey, key);
  assert.deepEqual(sortSidebarSection(sidebarTaskScope(state, 'a').filter(task => task.pinnedAt), 'pinned').map(task => task.id), ['a', 'b']);
  assert.equal((await f.post('b', { ...first, orderedIds: ['a', 'b'] })).status, 400);
  const overview = taskOverview(state, 'service'); assert.equal(overview.sidebarRequests, undefined); assert.equal(overview.taskSidebarOrderingSupported, true);
  assert.equal(overview.tasks[0].pinOrderKey, key); assert.equal(overview.tasks[0].prompt, '');
  f.auth.revoke(f.device.id); assert.equal((await f.post('b', first)).status, 401);
});

test('Cross-shelf drops clear snooze, pin and settlement atomically and a later live-output update does not invalidate order', async t => {
  const f = await setup(t); let state = await f.engine.snapshot();
  const order = move(state, 'c', 'pinned', ['c', 'a', 'b']);
  await f.engine.mutate(state => { state.tasks[0].updatedAt = new Date().toISOString(); state.tasks[0].events.push({ id: 'output', kind: 'reasoning', text: 'New output', at: now }); });
  assert.equal((await f.post('c', order)).status, 200); state = await f.engine.snapshot(); assert.ok(state.tasks[2].pinOrderKey);
  assert.equal((await f.post('c', move(state, 'c', 'settled', ['c'], 'settle'))).status, 200); state = await f.engine.snapshot();
  assert.equal(state.tasks[2].pinnedAt, null); assert.equal(state.tasks[2].pinOrderKey, null); assert.equal(state.tasks[2].activeOrderKey, null); assert.ok(state.tasks[2].settledAt);
  assert.equal((await f.post('c', move(state, 'c', 'active', ['c'], 'wake'))).status, 200); state = await f.engine.snapshot();
  assert.equal(state.tasks[2].settledAt, null); assert.ok(state.tasks[2].unsettledAt); assert.ok(state.tasks[2].activeOrderKey);
  await f.engine.updateTaskMetadata('c', { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }); state = await f.engine.snapshot();
  assert.equal((await f.post('c', move(state, 'c', 'pinned', ['c', 'a', 'b'], 'snooze-pin'))).status, 200);
  state = await f.engine.snapshot(); assert.equal(state.tasks[2].snoozedUntil, null); assert.ok(state.tasks[2].pinnedAt);
  await f.engine.updateTaskMetadata('c', { settled: true, snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }); state = await f.engine.snapshot();
  assert.equal(taskSidebarSection(state.tasks[2], new Date().toISOString()), 'snoozed');
  assert.equal((await f.post('c', move(state, 'c', 'active', ['c'], 'wake-settled-snooze'))).status, 200);
  state = await f.engine.snapshot(); assert.equal(state.tasks[2].settledAt, null); assert.equal(state.tasks[2].snoozedUntil, null);
});

test('Concurrent moves reject stale destination keys and an archived or foreign source cannot move through a stale view', async t => {
  const f = await setup(t); const state = await f.engine.snapshot();
  const responses = await Promise.all([f.post('a', move(state, 'a', 'pinned', ['b', 'a'], 'one')), f.post('b', move(state, 'b', 'pinned', ['b', 'a'], 'two'))]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const fresh = await f.engine.snapshot(); const archived = move(fresh, 'c', 'pinned', ['c', ...sortSidebarSection(fresh.tasks.filter(task => task.projectId === 'a' && task.pinnedAt), 'pinned').map(task => task.id)], 'archived');
  await f.engine.updateTaskMetadata('c', { archived: true }); assert.equal((await f.post('c', archived)).status, 400);
  assert.equal((await f.post('hidden', { ...archived, requestId: 'foreign' })).status, 400);
});

test('Menu pinning allocates a top key, clears snooze and settlement and keeps existing pins stable on retries', async t => {
  const f = await setup(t); await f.engine.updateTaskMetadata('c', { settled: true }); await f.engine.updateTaskMetadata('c', { pinned: true });
  let state = await f.engine.snapshot(); const key = state.tasks[2].pinOrderKey; assert.ok(key && key < 'd'); assert.equal(state.tasks[2].settledAt, null);
  await f.engine.updateTaskMetadata('c', { pinned: true }); assert.equal((await f.engine.snapshot()).tasks[2].pinOrderKey, key);
  await f.engine.updateTaskMetadata('c', { pinned: false }); state = await f.engine.snapshot(); assert.equal(state.tasks[2].pinOrderKey, null);
  await f.engine.updateTaskMetadata('c', { pinned: true, settled: true }); state = await f.engine.snapshot(); assert.equal(state.tasks[2].pinOrderKey, null); assert.equal(state.tasks[2].activeOrderKey, null);
});

test('Continuing a manually or automatically settled task clears its old active key and restores its creation/resume anchor', async t => {
  const base = await mkdtemp(join(tmpdir(), 'friday-sidebar-resume-')); const cwd = join(base, 'project'); await mkdir(cwd);
  let calls = 0; const executor: Executor = { async run(request) { calls++; await request.update({ kind: 'session', threadId: request.task.threadId! }); return 'Continued'; }, async answer() {}, async steer() {} };
  const engine = await new Engine(join(base, 'data'), executor).open(); t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => { state.projects = [{ id: 'a', name: 'A', path: cwd, context: '' }]; state.tasks = [
    item('auto', { cwd, autoSettle: true, updatedAt: new Date(Date.now() - 4 * 86_400_000).toISOString(), activeOrderKey: 'm' }),
    item('manual', { cwd, settledAt: new Date().toISOString(), activeOrderKey: 't' }),
  ]; });
  await engine.taskSettlement.sweep();
  for (const id of ['auto', 'manual']) {
    assert.equal(await engine.createTask({ continueId: id, requestId: 'resume-' + id, agent: 'codex', projectId: 'a', mode: 'research', prompt: 'Continue' }), id);
    const deadline = Date.now() + 5_000;
    while ((await engine.snapshot()).tasks.find(task => task.id === id)?.status !== 'completed') { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    const task = (await engine.snapshot()).tasks.find(task => task.id === id)!;
    assert.equal(task.activeOrderKey, null); assert.equal(task.settledAt, null); assert.ok(task.unsettledAt); assert.equal(task.result, 'Continued');
  }
  assert.equal(calls, 2);
});

test('Logical project scopes reorder only their members, preserve hidden project keys and reject changed group membership',()=>{
 const state=workspace([item('a1',{activeOrderKey:'g'}),item('b1',{projectId:'b',cwd:'/project/b',activeOrderKey:'t'}),item('hidden',{projectId:'c',cwd:'/project/c',activeOrderKey:'d'})]);state.projects.push({id:'c',name:'C',path:'/project/c',context:''});
 const request=taskSidebarMove({requestId:'group-move',projectId:null,projectIds:['b','a'],source:'active',section:'active',expected:[{id:'a1',key:'g'},{id:'b1',key:'t'}],orderedIds:['b1','a1']});assert.deepEqual(request.projectIds,['a','b']);
 const hidden=structuredClone(state.tasks[2]);applyTaskSidebarMove(state,'b1',request,now);assert.deepEqual(state.tasks[2],hidden);assert.deepEqual(sortSidebarSection(sidebarTaskScope(state,null,['a','b']),'active').map(t=>t.id),['b1','a1']);
 applyTaskSidebarMove(state,'b1',request,now);assert.deepEqual(state.tasks[2],hidden);
 assert.throws(()=>taskSidebarMove({...request,projectId:'a'}),/范围无效/);assert.throws(()=>taskSidebarMove({...request,projectIds:['a','a']}),/范围无效/);
 const before=structuredClone(state);assert.throws(()=>applyTaskSidebarMove(state,'b1',{...request,requestId:'missing',projectIds:['a','gone']},now),/分组已改变/);assert.deepEqual(state,before);
 state.tasks.push(item('scratch',{projectId:null,cwd:'/scratch'}));assert.deepEqual(sidebarTaskScope(state,null,[]).map(t=>t.id),['scratch']);
});
test('The No-project scope includes registered scratch threads and legacy unassociated threads without altering hidden project order',()=>{
 const state=workspace([item('scratch',{projectId:'a',activeOrderKey:'g'}),item('legacy',{projectId:null,cwd:'/unassociated',activeOrderKey:'t'}),item('hidden',{projectId:'b',cwd:'/project/b',activeOrderKey:'d'})]);const request=taskSidebarMove({requestId:'scratch-scope',projectId:null,projectIds:['a'],includeUnassociated:true,source:'active',section:'active',expected:[{id:'scratch',key:'g'},{id:'legacy',key:'t'}],orderedIds:['legacy','scratch']});
 assert.equal(request.includeUnassociated,true);const hidden=structuredClone(state.tasks[2]);applyTaskSidebarMove(state,'legacy',request,now);assert.deepEqual(state.tasks[2],hidden);assert.deepEqual(sortSidebarSection(sidebarTaskScope(state,null,['a'],true),'active').map(task=>task.id),['legacy','scratch']);assert.throws(()=>taskSidebarMove({...request,projectIds:undefined}),/排序范围无效/);
});
