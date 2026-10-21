import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { historyEncodedBytes, historyEntries, selectHistoryEntries } from '../src/task-history-window.js';
import type { ChatMessage, Executor, TaskEvent, WorkItem } from '../src/types.js';

const at = (value: number) => new Date(Date.UTC(2026, 9, 18) + value * 1000).toISOString();
class ReadOnlyExecutor implements Executor {
  async run(): Promise<string> { throw new Error('History projection must not start a model'); }
  async answer() {} async steer() {}
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, input: { messages?: ChatMessage[]; events?: TaskEvent[] } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-history-fallback-')));
  const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(directory, new ReadOnlyExecutor()).open();
  const task: WorkItem = { id: 'task', title: 'Imported history', prompt: '', result: '', error: null, artifact: null, projectId: null, cwd,
    agent: 'codex', mode: 'research', status: 'completed', createdAt: at(0), updatedAt: at(100_000), durableId: null, threadId: 'native', turnId: null,
    lastRequestId: 'original', events: [], approvals: [], ...(input.messages ? { messages: input.messages } : {}), eventArchive: { count: 0, version: 0, coverage: 'legacy', recent: [] } };
  await engine.mutate(state => { state.tasks.push(task); });
  await engine.patchTask('task', task => { task.events.push(...(input.events ?? [])); });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { get engine() { return engine; }, directory, async reopen() { await engine.close(); engine = await new Engine(directory, new ReadOnlyExecutor()).open(); } };
}
const message = (index: number, text = 'Assistant ' + index): ChatMessage => ({ id: 'message-' + index, role: 'assistant', text, at: at(index * 2 + 1) });
const event = (index: number): TaskEvent => ({ id: 'event-' + index, kind: 'message', phase: 'commentary', text: 'Activity ' + index, at: at(index * 2) });
async function project(engine: Engine, compact = false) { const state = await engine.snapshot(); return engine.conversationHistory.project(state.tasks[0], state.revision, compact); }

test('Histories without user starts page 75 mixed items, including cold Durable events, without losing or duplicating entries', async t => {
  const f = await setup(t, { messages: Array.from({ length: 180 }, (_, index) => message(index)), events: Array.from({ length: 900 }, (_, index) => event(index)) });
  const auth = new Auth(f.directory); t.after(() => auth.close()); const app = createAPI(f.engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token };
  const legacy = await (await app.request('/api/state', { headers })).json();
  assert.equal(legacy.tasks[0].messages.length, 180); assert.equal(legacy.tasks[0].events.length, 600);
  const olderClient = await (await app.request('/api/state?history=turns', { headers })).json();
  assert.equal(olderClient.tasks[0].conversationHistory, undefined); assert.equal(olderClient.tasks[0].messages.length, 180);
  const olderDetail = (await (await app.request('/api/tasks/task/snapshot', { headers })).json()).task;
  assert.equal(olderDetail.conversationHistory, undefined); assert.equal(olderDetail.messages.length, 180); assert.equal(olderDetail.events.length, 600);
  const response = await app.request('/api/tasks/task/snapshot?itemHistory=1', { headers }); assert.equal(response.status, 200);
  const live: WorkItem = (await response.json()).task;
  assert.equal(live.conversationHistory?.kind, 'items'); assert.equal(live.conversationHistory?.count, 1080);
  assert.equal(live.messages!.length + live.events.length, 75); assert.equal(live.conversationHistory?.payloadBudgetExceeded, false);
  assert.deepEqual(live.conversationHistory?.visibleMessageIds, live.messages!.map(message => message.id));
  for (const [route, count] of [['/api/tasks/task/events?itemHistory=1', 75], ['/api/tasks/task/events', 780]] as const) {
    const response = await app.request(route, { headers }); const reader = response.body!.getReader();
    try {
      const first = new TextDecoder().decode((await reader.read()).value);
      const frame = JSON.parse(first.split('\n').find(line => line.startsWith('data: '))!.slice(6));
      assert.equal(frame.task.messages.length + frame.task.events.length, count);
    } finally { await reader.cancel(); }
  }
  const selected: string[] = [...live.messages!.map(value => 'm:' + value.id), ...live.events.map(value => 'e:' + value.id)];
  let cursor = live.conversationHistory!.nextCursor;
  while (cursor) {
    const page = await f.engine.conversationHistory.page('task', cursor);
    assert.equal(page.beforeCursor, cursor); assert.ok(page.messages.length + page.events.length <= 75);
    selected.push(...page.messages.map(value => 'm:' + value.id), ...page.events.map(value => 'e:' + value.id)); cursor = page.nextCursor;
  }
  assert.equal(selected.length, 1080); assert.equal(new Set(selected).size, 1080);
  const target = await f.engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!, 'event-700');
  assert.equal(target.messages.length + target.events.length, 150, 'Seeking an older entry doubles the fallback item budget');
  assert.ok(target.events.some(event => event.id === 'event-700'));
  await f.reopen(); const saved = await project(f.engine); assert.equal(saved.conversationHistory?.nextCursor, live.conversationHistory?.nextCursor);
  const page = await f.engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!); assert.equal(page.to, 1005);
});

test('UTF-8 encoded bytes cap pages at 1 MiB and an oversized item remains whole and advances the cursor', async t => {
  const text = '🚀'.repeat(90_000); const f = await setup(t, { messages: Array.from({ length: 7 }, (_, index) => message(index, text)) });
  const live = await project(f.engine); assert.equal(live.messages?.length, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(live), 'utf8') < historyEncodedBytes); assert.equal(live.conversationHistory?.payloadBudgetExceeded, false);
  const older = await f.engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!);
  assert.equal(older.messages.length, 2); assert.ok(Buffer.byteLength(JSON.stringify(older), 'utf8') < historyEncodedBytes);
  const oversized = '字'.repeat(400_000);
  await f.engine.patchTask('task', task => { task.messages!.push(message(7, oversized)); });
  const huge = await project(f.engine); assert.equal(huge.messages?.length, 1); assert.equal(huge.messages?.[0].text, oversized);
  assert.equal(huge.conversationHistory?.payloadBudgetExceeded, true); assert.ok(huge.conversationHistory?.nextCursor);
  const next = await f.engine.conversationHistory.page('task', huge.conversationHistory!.nextCursor!);
  assert.equal(next.messages.length, 2); assert.ok(next.messages.every(message => message.id !== 'message-7'));
});

test('Compact command bodies are charged at their wire size; full output stays in Durable and old transports keep it', async t => {
  const detail = 'Output 🌏'.repeat(180_000);
  const f = await setup(t, { events: Array.from({ length: 90 }, (_, index) => ({ ...event(index), kind: 'command', detail: index === 89 ? detail : 'small output', status: 'completed' })) });
  const legacy = await project(f.engine); assert.equal(legacy.events.length, 1); assert.equal(legacy.events[0].detail, detail);
  assert.equal(legacy.conversationHistory?.payloadBudgetExceeded, true);
  const auth = new Auth(f.directory); t.after(() => auth.close()); const app = createAPI(f.engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token };
  const live: WorkItem = (await (await app.request('/api/tasks/task/snapshot?itemHistory=1', { headers })).json()).task;
  assert.equal(live.events.length, 75); assert.equal(live.events.at(-1)?.detail, undefined); assert.equal(live.events.at(-1)?.detailOmitted, true);
  assert.equal(live.conversationHistory?.payloadBudgetExceeded, false); assert.ok(Buffer.byteLength(JSON.stringify(live), 'utf8') < historyEncodedBytes);
  const stored = await f.engine.taskHistory.eventItems('task', ['event-89']); assert.equal(stored.events[0].detail, detail);
  const normal = await (await app.request('/api/state?history=turns&itemHistory=1', { headers })).json(); assert.equal(normal.tasks[0].events.length, 1);
  const compact = await (await app.request('/api/state?history=turns&compactItems=1&itemHistory=1', { headers })).json(); assert.equal(compact.tasks[0].events.length, 75);
});

test('Control messages remain available outside the fallback window and a large control block reports its budget overflow', async t => {
  const messages = Array.from({ length: 200 }, (_, index) => ({ ...message(index), runId: 'run-' + index }));
  const f = await setup(t, { messages });
  await f.engine.patchTask('task', task => {
    task.runs = [3, 199].map(index => ({ id: 'run-' + index, messageId: 'message-' + index, requestId: 'request-' + index, durableId: null,
      cwd: task.cwd, at: at(index * 2 + 1), status: index === 3 ? 'running' : 'completed', mode: 'research', interactionMode: 'default' }));
    task.currentRunId = 'run-3';
  });
  const live = await project(f.engine); assert.equal(live.conversationHistory?.visibleMessageIds?.length, 75); assert.equal(live.messages?.length, 76);
  assert.ok(live.messages?.some(message => message.id === 'message-3')); assert.ok(!live.conversationHistory?.visibleMessageIds?.includes('message-3'));
  await f.engine.patchTask('task', task => { task.error = 'Long control error '.repeat(80_000); });
  const heavy = await project(f.engine); assert.equal(heavy.conversationHistory?.payloadBudgetExceeded, true);
  assert.equal(heavy.conversationHistory?.visibleMessageIds?.length, 1, 'At least one item remains available even when control data already exceeds the budget');
});

test('A legacy prefix and its cursors survive new user turns; ordinary turns are never split by fallback item or byte budgets', async t => {
  const f = await setup(t, { events: Array.from({ length: 820 }, (_, index) => event(index)) });
  const original = await project(f.engine); const cursor = original.conversationHistory!.nextCursor!;
  assert.equal(original.messages, undefined, 'Old prompt/result fallback remains available when the stored message list is absent');
  await f.engine.patchTask('task', task => {
    task.messages = []; task.runs = [];
    for (let index = 0; index < 12; index++) {
      const runId = 'run-' + index; const date = at(2000 + index * 1000);
      task.messages.push({ id: 'user-' + index, role: 'user', text: 'Request ' + index, at: date, runId },
        { id: 'answer-' + index, role: 'assistant', text: 'Answer ' + index, at: at(2000 + index * 1000 + 950), runId });
      task.runs.push({ id: runId, durableId: null, messageId: 'user-' + index, requestId: 'request-' + index, cwd: task.cwd, at: date,
        status: 'completed', mode: 'research', interactionMode: 'default' });
      if (index === 11) for (let item = 0; item < 900; item++) task.events.push({ ...event(1000 + item), id: 'tool-' + item, kind: 'command', runId, at: at(13001 + item) });
    }
  });
  const live = await project(f.engine); assert.equal(live.conversationHistory?.kind, 'items'); assert.equal(live.messages?.length, 20);
  assert.equal(live.events.filter(event => event.id.startsWith('tool-')).length, 900);
  assert.ok(live.conversationHistory!.from > 800); assert.equal(live.conversationHistory?.visibleMessageIds?.[0], 'user-2');
  const retained = await f.engine.conversationHistory.page('task', cursor); assert.equal(retained.to, 745); assert.equal(retained.events.length, 75);
  await f.engine.mutate(state => { delete state.tasks[0].eventArchive!.firstTimelineAt; });
  await f.reopen(); const restored = await project(f.engine); assert.equal(restored.conversationHistory?.kind, 'items');
  assert.equal(restored.events.filter(event => event.id.startsWith('tool-')).length, 900, 'The prefix index upgrades independently from an existing run-page index');
});

test('Item cursors follow their identity through older insertions and reject forged scopes, missing anchors and changed projections', async t => {
  const f = await setup(t, { messages: Array.from({ length: 200 }, (_, index) => message(index)) });
  const original = await project(f.engine); const cursor = original.conversationHistory!.nextCursor!;
  await f.engine.patchTask('task', task => { task.messages!.push({ id: 'inserted', role: 'assistant', text: 'Late historical entry', at: at(10) }); });
  const page = await f.engine.conversationHistory.page('task', cursor);
  assert.equal(page.to, 126); assert.equal(page.beforeCursor, cursor); assert.equal(page.messages.length, 75);
  const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const change of [{ taskId: 'other' }, { epoch: 'other' }, { anchor: 'missing' }, { before: -1 }, { before: 1.5 }]) {
    const forged = Buffer.from(JSON.stringify({ ...value, ...change })).toString('base64url');
    await assert.rejects(f.engine.conversationHistory.page('task', forged), /历史已改变/);
  }
  await f.engine.deleteTask('task'); await assert.rejects(f.engine.conversationHistory.page('task', cursor), /任务不存在/);
});

test('Wake starts use T3 raw-turn limits while Steer and tool activity keep their ordinary turn intact', async t => {
  const task = { id: 'task', createdAt: at(0), updatedAt: at(10_000), messages: [{ id: 'user', role: 'user', text: 'Start', at: at(0), runId: 'run' },
    { id: 'steer', role: 'user', text: 'Steer', at: at(1), runId: 'run', delivery: 'sent' }], runs: [{ id: 'run', messageId: 'user' }] } as WorkItem;
  const events: TaskEvent[] = Array.from({ length: 170 }, (_, index) => ({ id: 'wake-' + index, kind: 'notification', text: 'Background completion', at: at(index * 10 + 10), runId: 'wake-run-' + index }));
  events.push({ id: 'same-run-notification', kind: 'notification', text: 'Same run', at: at(2), runId: 'run' });
  for (let index = 0; index < 900; index++) events.push({ id: 'tool-' + index, kind: 'command', text: 'Tool', at: at(2000 + index), runId: 'wake-run-169' });
  const entries = historyEntries(task, events); const selected = selectHistoryEntries(entries, entries.length, { userTurns: 10, maxItems: 1, maxBytes: 1 });
  assert.equal(selected.entries.filter(entry => entry.turnStart).length, 150); assert.equal(selected.entries.filter(entry => entry.event?.kind === 'command').length, 900);
  assert.equal(selected.entries.filter(entry => entry.event?.kind === 'notification').length, 150);
  const f = await setup(t, { messages: task.messages, events });
  await f.engine.mutate(state => { state.tasks[0].runs = [{ id: 'run', messageId: 'user', requestId: 'user', durableId: null, cwd: state.tasks[0].cwd,
    at: at(0), status: 'completed', mode: 'research', interactionMode: 'default' }]; });
  const live = await project(f.engine);
  assert.equal(live.conversationHistory?.kind, 'items', 'Notification starts use item coordinates even when the task already had a user turn');
  assert.equal(live.events.filter(event => event.kind === 'notification').length, 150); assert.equal(live.events.filter(event => event.kind === 'command').length, 900);
});

test('Untimed legacy answers keep their place before the next user request instead of entering the current tail', async t => {
  const messages: ChatMessage[] = [{ id: 'old-answer', role: 'assistant', text: 'An untimed imported answer' },
    ...Array.from({ length: 12 }, (_, index): ChatMessage => ({ id: 'user-' + index, role: 'user', text: 'Request ' + index, at: at(100 + index) }))];
  const f = await setup(t, { messages }); const live = await project(f.engine);
  assert.equal(live.conversationHistory?.kind, 'items'); assert.equal(live.messages?.length, 10); assert.equal(live.messages?.[0].id, 'user-2');
  assert.ok(!live.messages?.some(message => message.id === 'old-answer'));
  const older = await f.engine.conversationHistory.page('task', live.conversationHistory!.nextCursor!);
  assert.deepEqual(older.visibleMessageIds, ['old-answer', 'user-0', 'user-1']);
});
