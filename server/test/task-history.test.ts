import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Engine } from '../src/engine.js';
import { WorkspaceDoc } from '../src/state.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Executor, NativeForkRequest, NativeRewindRequest, TaskEvent, WorkItem, Workspace } from '../src/types.js';

const at = (n: number) => new Date(Date.UTC(2026, 9, 18) + n).toISOString();
const events = (from: number, to: number): TaskEvent[] => Array.from({ length: to - from }, (_, offset) => {
  const n = from + offset; return { id: `event-${n}`, itemId: `item-${n}`, runId: n < 1000 ? 'run-1' : 'run-2', turnId: n < 1000 ? 'turn-1' : 'turn-2', kind: 'command', text: `command ${n}`, detail: `完整输出 ${n} 🚀`, at: at(n), status: 'completed', exitCode: 0 };
});
class HistoryExecutor implements Executor {
  async run() { return 'not used'; } async answer() {} async steer() {}
  async fork(request: NativeForkRequest) { await request.started(); await request.candidate('fork-native'); return { threadId: 'fork-native', turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, id])), headIds: {} }; }
  async rewind(request: NativeRewindRequest) { const keep = request.keepTurns ?? []; await request.started({ threadId: request.task.threadId!, turns: [...keep, ...request.removeTurns], keep }); await request.candidate(request.task.threadId!); return { state: 'applied' as const, threadId: request.task.threadId, turns: keep }; }
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, size = 2000) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-history-'))); const data = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(data, new HistoryExecutor()).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const task: WorkItem = { id: 'task', title: 'History', prompt: 'First', projectId: 'project', cwd, agent: 'codex', mode: 'research', status: 'completed', createdAt: at(0), updatedAt: at(2001), durableId: null, threadId: 'native', turnId: 'turn-2', result: 'Second answer', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'second', currentRunId: 'run-2', eventArchive: { count: 0, version: 0, coverage: 'complete', recent: [] },
    runs: [1, 2].map(i => ({ id: `run-${i}`, durableId: null, requestId: `request-${i}`, messageId: `user-${i}`, cwd, at: at((i - 1) * 1000), completedAt: at(i * 1000), status: 'completed', threadId: 'native', turnId: `turn-${i}`, mode: 'research', interactionMode: 'default' })),
    messages: [{ id: 'user-1', role: 'user', text: 'First', at: at(0), runId: 'run-1', turnId: 'turn-1' }, { id: 'answer-1', role: 'assistant', text: 'First answer', at: at(999), runId: 'run-1', turnId: 'turn-1' }, { id: 'user-2', role: 'user', text: 'Second', at: at(1000), runId: 'run-2', turnId: 'turn-2' }, { id: 'answer-2', role: 'assistant', text: 'Second answer', at: at(2001), runId: 'run-2', turnId: 'turn-2' }] };
  await engine.mutate(state => { state.tasks.push(task); state.projects.push({ id: 'project', path: cwd, name: 'Project', context: '' }); });
  if (size) await engine.patchTask('task', task => { task.events.push(...events(0, size)); });
  return { get engine() { return engine; }, data, cwd, reopen: async () => { await engine.close(); engine = await new Engine(data, new HistoryExecutor()).open(); } };
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('History operation timed out');
}

test('Durable history pages retain all events beyond the live window and survive a service restart without expanding state snapshots', async t => {
  const fixture = await setup(t); let task = (await fixture.engine.snapshot()).tasks[0];
  assert.equal(task.events.length, 600); assert.equal(task.history?.count, 1400); assert.equal(task.history?.coverage, 'complete'); assert.equal(task.history?.recent.length, 128);
  assert.ok(!task.events.some(event => event.id === 'event-0'));
  const seen: TaskEvent[] = []; let cursor: string | undefined;
  do { const page = await fixture.engine.taskHistory.page('task', cursor, 73); assert.ok(page.events.length <= 73); seen.unshift(...page.events); cursor = page.nextCursor ?? undefined; } while (cursor);
  assert.equal(seen.length, 1400); assert.deepEqual(seen.map(event => event.id), events(0, 1400).map(event => event.id)); assert.equal(seen[0].detail, '完整输出 0 🚀');
  await fixture.reopen(); task = (await fixture.engine.snapshot()).tasks[0];
  const all = await fixture.engine.taskHistory.events(task); assert.equal(all.length, 2000); assert.equal(new Set(all.map(event => event.id)).size, 2000); assert.equal(task.events.length, 600);
});

test('Archival and live trimming commit atomically; an aborted write leaves neither phantom records nor unusable index positions', async t => {
  const { engine } = await setup(t, 0);
  await assert.rejects(engine.root.commit(async tx => { const state = await tx.doc(WorkspaceDoc); state.tasks[0].events.push(...events(0, 900)); await engine.taskHistory.persist(tx, state.tasks[0]); throw new Error('abort archival'); }, context), /abort archival/);
  assert.equal((await engine.snapshot()).tasks[0].events.length, 0); assert.equal((await engine.taskHistory.page('task')).events.length, 0);
  await engine.patchTask('task', task => { task.events.push(...events(0, 900)); });
  assert.equal((await engine.taskHistory.page('task')).count, 300); assert.equal((await engine.taskHistory.events((await engine.snapshot()).tasks[0])).length, 900);
});

test('A late update replaces its original archived event and a concurrently growing archive does not shift old cursors or duplicate records', async t => {
  const { engine } = await setup(t, 1600); const original = await engine.taskHistory.page('task', undefined, 50);
  await engine.patchTask('task', task => { task.events.push({ ...events(0, 1)[0], detail: 'late authoritative output', status: 'failed', exitCode: 2 }); }, ['event-0']);
  await engine.patchTask('task', task => { task.events.push(...events(1600, 1800)); });
  const next = await engine.taskHistory.page('task', original.nextCursor!, 50); assert.equal(next.to, original.from); assert.equal(next.events[0].id, 'event-900');
  const all = await engine.taskHistory.events((await engine.snapshot()).tasks[0]); assert.equal(all.length, 1800); assert.equal(all.find(event => event.id === 'event-0')?.detail, 'late authoritative output'); assert.equal(all.find(event => event.id === 'event-0')?.exitCode, 2);
});

test('Rewinds invalidate old cursors and project reverted state onto archived events instead of resurrecting their old visible bodies', async t => {
  const { engine } = await setup(t); const before = await engine.taskHistory.page('task'); const options = await engine.taskRewinds.options('task', 'user-2');
  await engine.taskRewinds.start('task', { requestId: 'rewind', messageId: 'user-2', fingerprint: options.fingerprint, restoreFiles: false });
  await until(engine, state => state.tasks[0].rewindOperation?.status === 'completed');
  await assert.rejects(engine.taskHistory.page('task', before.nextCursor!), /历史已改变/);
  const all = await engine.taskHistory.events((await engine.snapshot()).tasks[0]); assert.equal(all.filter(event => !event.revertedAt).length, 1000); assert.ok(all.filter(event => event.runId === 'run-2').every(event => event.revertedAt));
});

test('Forks copy complete archived prefixes into their own Durable pages and keep them after source updates and deletion', async t => {
  const { engine } = await setup(t); const id = await engine.taskForks.start('task', { requestId: 'fork', runId: 'run-1' });
  const state = await until(engine, state => state.tasks.find(task => task.id === id)?.forkOperation?.status === 'completed'); const child = state.tasks.find(task => task.id === id)!;
  assert.equal(child.eventArchive?.count, 400); assert.equal(child.events.length, 600);
  let all = await engine.taskHistory.events(child); assert.equal(all.length, 1000); assert.ok(all.every(event => event.turnId === 'turn-1' && event.runId === child.runs![0].id));
  await engine.patchTask('task', task => { task.events.push({ ...events(0, 1)[0], detail: 'source changed later' }); }, ['event-0']); await engine.deleteTask('task');
  all = await engine.taskHistory.events((await engine.snapshot()).tasks.find(task => task.id === id)!); assert.equal(all[0].detail, '完整输出 0 🚀'); assert.equal(all.length, 1000);
});

test('History APIs require authentication and bind opaque cursors to the task and projection, with bounded page sizes', async t => {
  const { engine, data } = await setup(t, 900); const auth = new Auth(data); t.after(() => auth.close()); const app = createAPI(engine, auth, () => []);
  assert.equal((await app.request('http://localhost/api/tasks/task/history')).status, 401);
  const headers = { Authorization: `Bearer ${auth.token}` }; const response = await app.request('http://localhost/api/tasks/task/history?limit=7', { headers }); assert.equal(response.status, 200); const page = await response.json(); assert.equal(page.events.length, 7);
  assert.equal((await app.request(`http://localhost/api/tasks/missing/history?before=${page.nextCursor}`, { headers })).status, 400);
  assert.equal((await app.request('http://localhost/api/tasks/task/history?limit=129', { headers })).status, 400); assert.equal((await app.request('http://localhost/api/tasks/task/history?before=malformed', { headers })).status, 400);
  assert.equal((await app.request('http://localhost/api/tasks/task/history?before=' + Buffer.from(JSON.stringify({ v: 1, taskId: 'other', epoch: page.epoch, before: 10 })).toString('base64url'), { headers })).status, 400);
});
