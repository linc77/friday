import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { CodexEvents } from '../src/codex-events.js';
import { ClaudeEvents } from '../src/claude-events.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { compactTaskEvent, taskEventDetail, type TaskCommandOutputFrame } from '../src/task-output.js';
import { taskHistoryEpoch } from '../src/task-history.js';
import type { Executor, NativeForkRequest, TaskEvent, WorkItem } from '../src/types.js';

const at = '2026-10-18T00:00:00.000Z';
const output = 'START 你好 🚀\n' + 'public output line\n'.repeat(30_000) + 'END\n';
class OutputExecutor implements Executor {
  async run(): Promise<string> { throw new Error('A read of output may never start a model'); }
  async answer() {} async steer() {}
  async fork(request: NativeForkRequest) {
    await request.started(); await request.candidate('child-native');
    return { threadId: 'child-native', turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, id])), headIds: {} };
  }
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-output-'))); const data = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(data, new OutputExecutor()).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  const task: WorkItem = { id: 'task', title: 'Outputs', prompt: 'Inspect', projectId: null, cwd, agent: 'codex', mode: 'research', status: 'running', createdAt: at, updatedAt: at,
    durableId: null, threadId: 'native', turnId: 'turn', currentRunId: 'run', result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'input',
    eventArchive: { count: 0, version: 0, coverage: 'complete', recent: [] },
    messages: [{ id: 'input', role: 'user', text: 'Inspect', at, runId: 'run', turnId: 'turn' }],
    runs: [{ id: 'run', durableId: null, requestId: 'input', messageId: 'input', cwd, at, status: 'running', mode: 'research', interactionMode: 'default', threadId: 'native', turnId: 'turn' }] };
  await engine.mutate(state => { state.tasks.push(task); });
  const item = (id = 'cmd', detail = '', status: TaskEvent['status'] = 'running'): TaskEvent => ({ id, kind: 'command', text: 'pnpm check', at, status, detail, turnId: 'turn', itemId: id });
  return { get engine() { return engine; }, data, item,
    epoch: async () => taskHistoryEpoch((await engine.snapshot()).tasks[0]),
    reopen: async () => { await engine.close(); engine = await new Engine(data, new OutputExecutor()).open(); },
    completed: async () => engine.patchTask('task', task => { task.status = 'completed'; task.runs![0].status = 'completed'; task.runs![0].completedAt = at; task.messages!.push({ id: 'answer', role: 'assistant', text: 'Done', runId: 'run', turnId: 'turn', at }); }),
  };
}

test('Long Codex public messages and summaries survive streaming without a completion body, while final command and tool output is retained whole', async () => {
  const items = new Map<string, TaskEvent>(); const deltas: string[] = [];
  const events = new CodexEvents(async update => { if (update.kind === 'item') items.set(update.item.id, update.item); if (update.kind === 'commandOutput') deltas.push(update.delta); });
  for (const [id, type, method] of [['answer', 'agentMessage', 'item/agentMessage/delta'], ['summary', 'reasoning', 'item/reasoning/summaryTextDelta'], ['plan', 'plan', 'item/plan/delta']]) {
    await events.handle('item/started', { item: { id, type, ...(id === 'answer' ? { phase: 'final_answer' } : {}) } }, 'turn');
    await events.handle(method, { itemId: id, delta: output.slice(0, 90_000) }, 'turn');
    await events.handle(method, { itemId: id, delta: output.slice(90_000) }, 'turn');
    await events.handle('item/completed', { item: { id, type } }, 'turn');
    assert.equal(items.get(`codex:turn:${id}`)?.text, output);
  }
  await events.handle('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'check' } }, 'turn');
  await events.handle('item/commandExecution/outputDelta', { itemId: 'cmd', delta: output }, 'turn');
  assert.deepEqual(deltas, [output]);
  await events.handle('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'check', aggregatedOutput: output, exitCode: 0 } }, 'turn');
  assert.equal(items.get('codex:turn:cmd')?.detail, output); assert.equal(items.get('codex:turn:cmd')?.detailTruncated, undefined);
  await events.handle('item/completed', { item: { id: 'tool', type: 'mcpToolCall', server: 'test', tool: 'read', result: { content: [{ type: 'text', text: output }, { type: 'image', data: 'private-image-bytes' }] } } }, 'turn');
  assert.equal(items.get('codex:turn:tool')?.detail, output);
  await events.finishTurn('turn', 'completed'); assert.equal(events.result, output);
  assert.ok(!JSON.stringify([...items.values()]).includes('private-image-bytes'));
});

test('Claude keeps complete readable tool inputs and results, without serializing image bytes as text', async () => {
  const items = new Map<string, TaskEvent>();
  const events = new ClaudeEvents('turn', async update => { if (update.kind === 'item') items.set(update.item.id, update.item); });
  await events.handle({ type: 'assistant', message: { id: 'message', content: [{ type: 'text', text: output }, { type: 'tool_use', id: 'tool', name: 'Read', input: { file_path: 'large.txt', note: output } }] } } as any);
  assert.equal(items.get('claude:turn:message:0')?.text, output); assert.equal(JSON.parse(items.get('claude:turn:tool')!.detail!).note, output);
  await events.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'text', text: output }, { type: 'image', source: { data: 'private-image-bytes' } }] }] } } as any);
  assert.equal(items.get('claude:turn:tool')?.detail, output);
  await events.finish('completed', output); assert.equal(events.result, output);
  assert.ok(!JSON.stringify([...items.values()]).includes('private-image-bytes'));
});

test('Compact transport omits public tool bodies without mutating storage or clipping user-visible prose; detail limits preserve UTF-8 boundaries', async t => {
  const fixture = await setup(t); const { engine, data } = fixture;
  await engine.updateExecution('task', { kind: 'item', item: fixture.item('cmd', output, 'completed') }, 'run');
  await engine.updateExecution('task', { kind: 'item', item: { ...fixture.item('tool', output, 'completed'), kind: 'tool' } }, 'run');
  await engine.updateExecution('task', { kind: 'item', item: { ...fixture.item('reply', '', 'completed'), kind: 'message', text: output, phase: 'final_answer' } }, 'run');
  const auth = new Auth(data); t.after(async () => auth.close()); const app = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}` };
  const compact = await (await app.request('/api/state?history=turns&compactItems=1', { headers })).json();
  assert.equal(compact.tasks[0].events.find((item: TaskEvent) => item.id === 'cmd').detailOmitted, true);
  assert.equal(compact.tasks[0].events.find((item: TaskEvent) => item.id === 'cmd').detail, undefined);
  assert.equal(compact.tasks[0].events.find((item: TaskEvent) => item.id === 'reply').text, output);
  const old = await (await app.request('/api/state', { headers })).json(); assert.equal(old.tasks[0].events.find((item: TaskEvent) => item.id === 'cmd').detail, output);
  const epoch = await fixture.epoch(); const route = `/api/tasks/task/history/items/tool?epoch=${epoch}`;
  assert.equal((await app.request(route)).status, 401);
  const detail = await (await app.request(route, { headers })).json(); assert.equal(detail.event.detailTruncated, true); assert.ok(Buffer.byteLength(detail.event.detail) <= 256 * 1024); assert.ok(output.startsWith(detail.event.detail));
  assert.equal((await engine.taskHistory.eventItems('task', ['cmd', 'tool'])).events[1].detail, output);
  const genuineReplacement = taskEventDetail({ ...fixture.item(), detail: 'a'.repeat(262_141) + '\uFFFDtail' });
  assert.ok(genuineReplacement.detail!.endsWith('\uFFFD'), 'A real replacement character at the byte boundary is retained');
  const splitEmoji = taskEventDetail({ ...fixture.item(), detail: 'a'.repeat(262_141) + '🚀tail' });
  assert.equal(splitEmoji.detail, 'a'.repeat(262_141));
  assert.deepEqual(compactTaskEvent({ ...fixture.item(), kind: 'reasoning', text: output, detail: output }).text, output);
});

test('Raw command chunks do not write Workspace or replay execution, keep redraws and split escapes, and ignore stale run ownership', async t => {
  const fixture = await setup(t); const { engine } = fixture;
  await engine.updateExecution('task', { kind: 'item', item: fixture.item() }, 'run');
  const revision = (await engine.snapshot()).revision; const epoch = await fixture.epoch();
  for (const delta of ['\u001b[3', '1mStarting\u001b[0m\r', '\u001b[2KDone 🚀\n']) await engine.updateExecution('task', { kind: 'commandOutput', eventId: 'cmd', delta }, 'run');
  const frame = await engine.commandOutputs.frame('task', 'cmd', epoch);
  assert.equal(frame.running, true); assert.match(frame.text, /Done 🚀/); assert.ok(!frame.text.includes('Starting'));
  await engine.updateExecution('task', { kind: 'commandOutput', eventId: 'cmd', delta: 'stale bytes' }, 'older-run');
  assert.equal((await engine.commandOutputs.frame('task', 'cmd', epoch)).text, frame.text);
  for (let i = 0; i < 100; i++) await engine.updateExecution('task', { kind: 'commandOutput', eventId: 'cmd', delta: output }, 'run');
  const tail = await engine.commandOutputs.frame('task', 'cmd', epoch); assert.ok(tail.text.length <= 65_536); assert.equal(tail.truncated, true);
  await engine.updateExecution('task', { kind: 'commandOutput', eventId: 'cmd', delta: 'replacement file\n', reset: true, truncated: true }, 'run');
  const reset = await engine.commandOutputs.frame('task', 'cmd', epoch); assert.equal(reset.text, 'replacement file\n'); assert.equal(reset.truncated, true);
  assert.equal((await engine.snapshot()).revision, revision);
  const transcript = new CodexEvents(update => engine.updateExecution('task', update, 'run'));
  await transcript.handle('item/started', { item: { id: 'protocol-command', type: 'commandExecution', command: 'build' } }, 'turn');
  const beforeDeltas = (await engine.snapshot()).revision;
  await transcript.handle('item/commandExecution/outputDelta', { itemId: 'protocol-command', delta: 'live protocol output' }, 'turn');
  assert.equal((await engine.snapshot()).revision, beforeDeltas, 'The provider translator must also bypass Durable on every command chunk');
  assert.equal((await engine.commandOutputs.frame('task', 'codex:turn:protocol-command', epoch)).text, 'live protocol output');
  await transcript.handle('item/completed', { item: { id: 'protocol-command', type: 'commandExecution', command: 'build', aggregatedOutput: '', exitCode: 0 } }, 'turn');
  assert.equal((await engine.commandOutputs.frame('task', 'codex:turn:protocol-command', epoch)).text, '', 'An authoritative empty result does not fall back to old live bytes');
});

test('Final output survives restart, historical paging and fork ownership independently from the source task', async t => {
  const fixture = await setup(t);
  await fixture.engine.updateExecution('task', { kind: 'item', item: fixture.item('cmd', output, 'completed') }, 'run');
  await fixture.completed();
  await fixture.engine.patchTask('task', task => { for (let i = 0; i < 700; i++) task.events.push({ ...fixture.item('small-' + i, 'done', 'completed'), runId: 'run' }); });
  await fixture.reopen();
  assert.equal((await fixture.engine.taskHistory.eventItems('task', ['cmd'])).events[0].detail, output);
  const auth = new Auth(fixture.data); t.after(async () => auth.close()); const app = createAPI(fixture.engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}` };
  const page = await (await app.request(`/api/tasks/task/history?beforePosition=1&limit=1&compactItems=1&epoch=${await fixture.epoch()}`, { headers })).json();
  assert.equal(page.events[0].id, 'cmd'); assert.equal(page.events[0].detailOmitted, true); assert.equal(page.events[0].detail, undefined);
  const live = await app.request('/api/events?history=turns&compactItems=1', { headers }); const liveReader = live.body!.getReader();
  const first = await liveReader.read(); const wire = new TextDecoder().decode(first.value);
  assert.ok(!wire.includes('START 你好')); assert.ok(wire.includes('detailOmitted')); await liveReader.cancel();
  const childID = await fixture.engine.taskForks.start('task', { requestId: 'fork', runId: 'run' });
  const deadline = Date.now() + 10_000;
  while ((await fixture.engine.snapshot()).tasks.find(task => task.id === childID)?.forkOperation?.status !== 'completed') { if (Date.now() > deadline) throw new Error('Fork timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const child = (await fixture.engine.snapshot()).tasks.find(task => task.id === childID)!;
  const event = (await fixture.engine.taskHistory.events(child)).find(event => event.detail === output)!; assert.ok(event);
  await fixture.engine.deleteTask('task');
  assert.equal((await fixture.engine.taskHistory.eventItems(childID, [event.id])).events[0].detail, output);
  const frame = await fixture.engine.commandOutputs.frame(childID, event.id, taskHistoryEpoch(child)); assert.equal(frame.running, false); assert.equal(frame.truncated, true); assert.ok(frame.text.endsWith('END\n'));
});

async function outputStream(app: ReturnType<typeof createAPI>, route: string, headers: Record<string, string>) {
  const response = await app.request(route, { headers }); assert.equal(response.status, 200);
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = '';
  const next = async (): Promise<TaskCommandOutputFrame> => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const record = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const name = record.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (name === 'error') throw new Error(JSON.parse(data).error);
        if (name === 'output') return JSON.parse(data);
      } else { const chunk = await reader.read(); if (chunk.done) throw new Error('Output stream ended before its final frame'); buffer += decoder.decode(chunk.value, { stream: true }); }
    }
    throw new Error('Output stream timed out');
  };
  return { reader, next };
}

test('An expanded command receives a bounded live stream, coalesces bursts and finishes with the authoritative saved output', async t => {
  const fixture = await setup(t); const { engine, data } = fixture;
  await engine.updateExecution('task', { kind: 'item', item: fixture.item('cmd:with:identity') }, 'run');
  const auth = new Auth(data); t.after(async () => auth.close()); const app = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}` };
  const route = `/api/tasks/task/history/items/cmd%3Awith%3Aidentity/output?epoch=${await fixture.epoch()}`;
  const stream = await outputStream(app, route, headers); t.after(async () => stream.reader.cancel());
  assert.equal((await stream.next()).running, true);
  for (let i = 0; i < 200; i++) await engine.updateExecution('task', { kind: 'commandOutput', eventId: 'cmd:with:identity', delta: `line-${i}\n` }, 'run');
  const live = await stream.next(); assert.equal(live.running, true); assert.ok(live.text.endsWith('line-199\n'));
  await engine.updateExecution('task', { kind: 'item', item: fixture.item('cmd:with:identity', 'authoritative final\n', 'completed') }, 'run');
  let final = await stream.next(); if (final.running) final = await stream.next();
  assert.equal(final.running, false); assert.equal(final.text, 'authoritative final\n'); assert.equal((await stream.reader.read()).done, true);
});

test('Output access rejects missing or reverted items and stale projection epochs; a stream closes when its history is removed', async t => {
  const fixture = await setup(t); const { engine, data } = fixture;
  await engine.updateExecution('task', { kind: 'item', item: fixture.item() }, 'run');
  const epoch = await fixture.epoch(); const auth = new Auth(data); t.after(async () => auth.close()); const app = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}` };
  const route = `/api/tasks/task/history/items/cmd/output?epoch=${epoch}`;
  assert.equal((await app.request(route)).status, 401);
  assert.equal((await app.request(route.replace(epoch, '0'.repeat(64)), { headers })).status, 400);
  assert.equal((await app.request(route.replace('/cmd/', '/missing/'), { headers })).status, 400);
  const stream = await outputStream(app, route, headers); t.after(async () => stream.reader.cancel()); await stream.next();
  await engine.patchTask('task', task => { task.runs![0].revertedAt = at; });
  await assert.rejects(stream.next(), /当前任务历史/);
  assert.equal((await app.request(`/api/tasks/task/history/items/cmd?epoch=${epoch}`, { headers })).status, 404);
});

test('Revoking a paired viewer closes its expanded output stream and denies later detail reads', async t => {
  const fixture = await setup(t); const { engine, data } = fixture;
  await engine.updateExecution('task', { kind: 'item', item: fixture.item() }, 'run');
  const auth = new Auth(data); t.after(async () => auth.close());
  const viewer = auth.pair(auth.createPairing().code, 'Viewer', 'local-test'); const app = createAPI(engine, auth, () => []);
  const route = `/api/tasks/task/history/items/cmd/output?epoch=${await fixture.epoch()}`;
  const stream = await outputStream(app, route, { Authorization: `Bearer ${viewer.token}` }); t.after(async () => stream.reader.cancel());
  assert.equal((await stream.next()).running, true); auth.revoke(viewer.id);
  await assert.rejects(stream.next(), /ended|abort/i);
  assert.equal((await app.request(route.replace('/output?', '?'), { headers: { Authorization: `Bearer ${viewer.token}` } })).status, 401);
});
