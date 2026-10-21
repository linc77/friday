import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { IdeaImages } from '../src/ideas.js';
import type { ChatMessage, Executor, NativeForkRequest, NativeRewindRequest, TaskEvent, TaskRun, WorkItem } from '../src/types.js';

const at = (n: number) => new Date(Date.UTC(2026, 9, 18) + n * 10).toISOString();
class HistoryExecutor implements Executor {
  async run(): Promise<string> { throw new Error('History reads must not start a model turn'); }
  async answer() {} async steer() {}
  async fork(request: NativeForkRequest) { await request.started(); await request.candidate('fork-native'); return { threadId: 'fork-native', turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, id])), headIds: {} }; }
  async rewind(request: NativeRewindRequest) { const keep = request.keepTurns ?? []; await request.started({ threadId: request.task.threadId!, turns: [...keep, ...request.removeTurns], keep }); return { state: 'applied' as const, threadId: request.task.threadId, turns: keep }; }
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, turns = 60) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-conversation-'))); const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(directory, new HistoryExecutor()).open();
  const messages: ChatMessage[] = []; const runs: TaskRun[] = []; const events: TaskEvent[] = [];
  for (let index = 0; index < turns; index++) {
    const runId = 'run-' + index; const turnId = 'turn-' + index;
    messages.push({ id: 'user-' + index, role: 'user', text: 'Request ' + index, at: at(index * 2000), runId, turnId },
      { id: 'answer-' + index, role: 'assistant', text: 'Answer ' + index, at: at(index * 2000 + 1900), runId, turnId });
    runs.push({ id: runId, durableId: null, messageId: 'user-' + index, requestId: 'request-' + index, cwd, at: at(index * 2000), status: 'completed',
      completedAt: at(index * 2000 + 1900), threadId: 'native', turnId, mode: 'research', interactionMode: 'default' });
    const tools = index === turns - 1 ? 900 : 10;
    for (let tool = 0; tool < tools; tool++) events.push({ id: `event-${index}-${tool}`, itemId: `item-${index}-${tool}`, runId, turnId,
      kind: 'command', text: `Read ${index}/${tool}`, detail: `Output ${index}/${tool} 🚀`, at: at(index * 2000 + tool + 1), status: 'completed', exitCode: 0 });
    events.push({ id: 'status-' + index, kind: 'status', text: 'Internal status', at: at(index * 2000) });
  }
  const task: WorkItem = { id: 'task', title: 'Long conversation', prompt: 'Request 0', projectId: 'project', cwd, agent: 'codex', mode: 'research',
    status: 'completed', createdAt: at(0), updatedAt: at(turns * 2000), durableId: null, threadId: 'native', turnId: 'turn-' + (turns - 1),
    result: 'Answer ' + (turns - 1), error: null, events: [], approvals: [], artifact: null, lastRequestId: 'request-' + (turns - 1),
    messages, runs, currentRunId: 'run-' + (turns - 1), eventArchive: { count: 0, version: 0, coverage: 'complete', recent: [] } };
  await engine.mutate(state => { state.tasks.push(task); state.projects.push({ id: 'project', path: cwd, name: 'Project', context: '' }); });
  await engine.patchTask('task', task => task.events.push(...events));
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { get engine() { return engine; }, directory, turns, async reopen() { await engine.close(); engine = await new Engine(directory, new HistoryExecutor()).open(); } };
}
async function bounded(engine: Engine) { const state = await engine.snapshot(); return (await engine.conversationHistory.snapshot(state)).tasks[0]; }
async function until(engine: Engine, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const task = (await engine.snapshot()).tasks[0]; if (predicate(task)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Conversation history operation timed out');
}

test('Opt-in snapshots keep ten complete user turns, including a 900-item turn, while legacy clients keep the full message list', async t => {
  const { engine, directory } = await setup(t); const auth = new Auth(directory); t.after(() => auth.close()); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: 'Bearer ' + auth.token };
  const legacy = await (await app.request('/api/state', { headers })).json(); const state = await (await app.request('/api/state?history=turns', { headers })).json();
  assert.equal(legacy.tasks[0].messages.length, 120); assert.equal(legacy.tasks[0].events.length, 600);
  const task = state.tasks[0]; assert.equal(task.messages.length, 20); assert.equal(task.conversationHistory.from, 100); assert.equal(task.conversationHistory.to, 120);
  assert.equal(task.events.filter((event: TaskEvent) => event.runId === 'run-59').length, 900, 'An ordinary turn is not cut off by the former live-event limit');
  assert.ok(task.events.some((event: TaskEvent) => event.id === 'event-59-0')); assert.ok(task.events.some((event: TaskEvent) => event.id === 'event-59-899'));
  assert.equal(task.runs.length, 60, 'Control metadata is independent of the visible timeline'); assert.equal(task.eventArchive, undefined);
  assert.ok(task.messages.every((message: ChatMessage) => message.historyOrder! >= 100));
  const response = await app.request('/api/events?history=turns', { headers }); const reader = response.body!.getReader();
  try {
    const first = new TextDecoder().decode((await reader.read()).value);
    const stream = JSON.parse(first.split('\n').find(line => line.startsWith('data: '))!.slice(6));
    assert.equal(stream.tasks[0].messages.length, 20); assert.equal(stream.tasks[0].conversationHistory.from, 100);
    assert.equal(stream.tasks[0].events.filter((event: TaskEvent) => event.runId === 'run-59').length, 900);
  } finally { await reader.cancel(); }
});

test('Older pages load twenty whole turns and retained images, reach a selected boundary, and enumerate the entire history without duplicates', async t => {
  const { engine, directory } = await setup(t);
  const image = await new IdeaImages(directory).save({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lYQAAAAASUVORK5CYII=', name: 'original.png' });
  await engine.mutate(state => { state.tasks[0].messages![10].images = [image]; });
  const live = await bounded(engine); const first = await engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!);
  assert.equal(first.messages.length, 40); assert.equal(first.from, 60); assert.equal(first.to, 100); assert.equal(first.messages[0].id, 'user-30');
  const targeted = await engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!, 'event-10-0');
  assert.equal(targeted.from, 20, 'A targeted read admits up to forty user turns');
  const assistantTarget = await engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!, 'answer-10');
  assert.equal(assistantTarget.from, 20, 'A target inside a turn includes that turn start');
  const messages = [...live.messages!]; const events = live.events.filter(event => event.kind === 'command'); let cursor = live.conversationHistory!.nextCursor;
  while (cursor) { const page = await engine.conversationHistory.page('task', cursor); messages.unshift(...page.messages); events.unshift(...page.events.filter(event => event.kind === 'command')); cursor = page.nextCursor; }
  assert.equal(messages.length, 120); assert.equal(new Set(messages.map(message => message.id)).size, 120);
  assert.deepEqual(messages.find(message => message.id === 'user-5')?.images, [image]);
  assert.equal(events.length, 1490); assert.equal(new Set(events.map(event => event.id)).size, 1490);
});

test('Appending output does not shift a saved cursor; a projected rewind rejects it and cannot resurrect removed turns', async t => {
  const { engine } = await setup(t); const live = await bounded(engine); const cursor = live.conversationHistory!.nextCursor!;
  await engine.mutate(state => { state.tasks[0].messages!.push({ id: 'late-question', role: 'user', text: 'A later request', at: at(200_000) }); });
  const page = await engine.conversationHistory.page('task', cursor); assert.equal(page.to, 100); assert.equal(page.from, 60);
  const options = await engine.taskRewinds.options('task', 'user-58');
  await engine.taskRewinds.start('task', { requestId: 'rewind', messageId: 'user-58', fingerprint: options.fingerprint, restoreFiles: false });
  await until(engine, task => task.rewindOperation?.status === 'completed');
  await assert.rejects(engine.conversationHistory.page('task', cursor), /历史已改变/);
  const rewound = await bounded(engine); assert.ok(rewound.messages?.every(message => !['user-58', 'user-59', 'late-question'].includes(message.id)));
  assert.ok(rewound.events.every(event => !['run-58', 'run-59'].includes(event.runId ?? '')));
});

test('Late updates outside the recent window publish change metadata and batch reads return the current archived body', async t => {
  const { engine } = await setup(t); const old = (await engine.taskHistory.eventItems('task', ['event-5-0'])).events[0];
  await engine.patchTask('task', task => { task.events.push({ ...old, detail: 'Updated old output', status: 'failed', exitCode: 7 }); }, ['event-5-0']);
  const live = await bounded(engine); assert.ok(!live.events.some(event => event.id === old.id));
  assert.ok(live.conversationHistory!.touches.some(value => value.id === old.id && value.digest !== old.historyDigest));
  const refreshed = await engine.taskHistory.eventItems('task', [old.id, 'missing', old.id]);
  assert.equal(refreshed.events.length, 1); assert.equal(refreshed.events[0].detail, 'Updated old output'); assert.equal(refreshed.events[0].exitCode, 7); assert.deepEqual(refreshed.missing, ['missing']);
  await engine.patchTask('task', task => { task.messages![10].delivery = 'sent'; engine.taskHistory.messageChanged(task, 'user-5'); });
  const updated = await bounded(engine); assert.ok(!updated.messages!.some(message => message.id === 'user-5'));
  assert.deepEqual(updated.conversationHistory!.messageTouches, ['user-5']); assert.equal(updated.conversationHistory!.messageVersion, 1);
  const receipt = await engine.taskHistory.eventItems('task', ['user-5']);
  assert.equal(receipt.messages[0].delivery, 'sent'); assert.equal(receipt.messages[0].historyOrder, 10); assert.deepEqual(receipt.missing, []);
});

test('Steering messages do not consume user-turn slots and an active older run retains its context without replacing the recent window', async t => {
  const { engine } = await setup(t);
  await engine.mutate(state => {
    const task = state.tasks[0]; const index = task.messages!.findIndex(message => message.id === 'answer-59');
    task.messages!.splice(index, 0, ...Array.from({ length: 12 }, (_, i): ChatMessage => ({ id: 'steer-' + i, role: 'user', text: 'Supplement ' + i, delivery: 'sent', runId: 'run-59', at: at(59 * 2000 + 1000 + i) })));
    task.status = 'running'; task.currentRunId = 'run-3'; task.runs![3].status = 'running';
  });
  const live = await bounded(engine);
  assert.equal(live.conversationHistory!.from, 100); assert.equal(live.messages!.filter(message => message.role === 'user' && !message.delivery && message.historyOrder! >= 100).length, 10);
  assert.equal(live.messages!.filter(message => message.delivery === 'sent').length, 12);
  assert.ok(live.messages!.some(message => message.id === 'user-3' && message.historyOrder === 6));
  assert.ok(live.events.some(event => event.runId === 'run-3'));
});

test('Range indexes rebuild after upgrade and restart while preserving archived history and fork independence', async t => {
  const f = await setup(t); await f.engine.mutate(state => { delete state.tasks[0].eventArchive!.runPages; });
  await f.reopen(); const live = await bounded(f.engine); assert.equal(live.events.filter(event => event.runId === 'run-59').length, 900);
  const id = await f.engine.taskForks.start('task', { requestId: 'fork', runId: 'run-35' });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const child = (await f.engine.snapshot()).tasks.find(task => task.id === id); if (child?.forkOperation?.status === 'completed') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const state = await f.engine.snapshot(); const child = state.tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed'); await f.engine.deleteTask('task');
  const projection = await f.engine.conversationHistory.project(child, state.revision); assert.equal(projection.messages?.filter(message => message.role === 'user').length, 10);
  const older = await f.engine.conversationHistory.page(id, projection.conversationHistory!.nextCursor!); assert.equal(older.messages.filter(message => message.role === 'user').length, 20);
  assert.ok(older.events.some(event => event.text === 'Read 10/0')); assert.ok(older.events.filter(event => event.runId).every(event => event.runId!.startsWith('fork-')));
});

test('Conversation and batch-history routes require authentication and reject malformed, oversized and cross-task ranges', async t => {
  const { engine, directory } = await setup(t, 15); const auth = new Auth(directory); t.after(() => auth.close()); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }; const cursor = (await bounded(engine)).conversationHistory!.nextCursor!;
  const path = '/api/tasks/task/conversation-history?before=' + encodeURIComponent(cursor);
  assert.equal((await app.request(path)).status, 401); assert.equal((await app.request(path, { headers })).status, 200);
  assert.equal((await app.request(path.replace('/task/', '/other/'), { headers })).status, 400);
  for (const invalid of ['bad', Buffer.from('null').toString('base64url'), Buffer.from('{}').toString('base64url')]) assert.equal((await app.request('/api/tasks/task/conversation-history?before=' + invalid, { headers })).status, 400);
  const batch = (ids: unknown, authorized = true) => app.request('/api/tasks/task/history/events', { method: 'POST', headers: authorized ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  assert.equal((await batch(['event-0-0'], false)).status, 401);
  for (const ids of [undefined, {}, [null], Array.from({ length: 129 }, () => 'event')]) assert.equal((await batch(ids)).status, 400);
  assert.equal((await batch(['event-0-0'])).status, 200);
});
