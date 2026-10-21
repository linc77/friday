import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { CodexExecutor } from '../src/codex.js';
import type { ExecutionRequest, Executor, WorkItem } from '../src/types.js';

const at = (i: number) => new Date(Date.UTC(2026, 9, 18) + i * 1000).toISOString();
class NoWork implements Executor {
  calls = 0;
  async run(_input: ExecutionRequest): Promise<string> { this.calls++; throw new Error('A subscription must never execute a model'); }
  async answer() {} async steer() {}
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, executor: Executor = new NoWork()) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-task-stream-'))); const cwd = join(base, 'project'); const data = join(base, 'data'); await mkdir(cwd);
  let engine = await new Engine(data, executor).open(); const auth = new Auth(data);
  t.after(async () => { await engine.close(); auth.close(); await rm(base, { recursive: true, force: true }); });
  const make = (id: string): WorkItem => ({ id, title: id, prompt: 'PRIVATE PROMPT ' + id, projectId: 'project', cwd, agent: 'codex', mode: 'research', status: 'completed', autoSettle: false, createdAt: at(0), updatedAt: at(30), durableId: null,
    threadId: id + '-native', turnId: id + '-turn-12', result: 'PRIVATE ANSWER ' + id, error: null, events: [], approvals: [{ id: id + '-approval', method: 'test', title: 'Check', detail: 'PRIVATE APPROVAL ' + id, questions: [], state: 'answered' }], artifact: null, lastRequestId: id + '-request', currentRunId: id + '-run-12',
    eventArchive: { count: 0, version: 0, coverage: 'complete', recent: [] },
    runs: Array.from({ length: 13 }, (_, i) => ({ id: id + '-run-' + i, messageId: id + '-user-' + i, requestId: id + '-request-' + i, durableId: null, cwd, at: at(i * 2), status: 'completed', threadId: id + '-native', turnId: id + '-turn-' + i, mode: 'research', interactionMode: 'default' })),
    messages: Array.from({ length: 13 }, (_, i) => [{ id: id + '-user-' + i, role: 'user' as const, text: 'PRIVATE INPUT ' + id + i, at: at(i * 2), runId: id + '-run-' + i }, { id: id + '-answer-' + i, role: 'assistant' as const, text: 'PRIVATE RESPONSE ' + id + i, at: at(i * 2 + 1), runId: id + '-run-' + i }]).flat(),
  });
  await engine.mutate(state => { state.tasks.push(make('a'), make('b')); state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }); });
  await engine.patchTask('a', task => {
    task.events.push({ id: 'a-tool', itemId: 'tool', kind: 'tool', text: 'Read', detail: 'PRIVATE TOOL BODY '.repeat(20_000), at: at(25), runId: 'a-run-12', status: 'completed' });
    task.queue = { paused: true, dispatcherId: null, messages: [{ id: 'queued', dispatchId: 'queued-dispatch', text: 'PRIVATE QUEUED BODY', images: [{ id: 'image', name: 'private image', mediaType: 'image/png' }], createdAt: at(31), status: 'queued' }] };
  });
  let app = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token };
  return { get engine() { return engine; }, get app() { return app; }, auth, headers,
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor).open(); app = createAPI(engine, auth, () => []); } };
}
async function subscribe(response: Response) {
  assert.equal(response.status, 200); const reader = response.body!.getReader(); const frames: { type: string; data: any }[] = []; let ended = false; let buffer = ''; const decoder = new TextDecoder();
  const pump = (async () => {
    try { while (true) {
      const chunk = await reader.read(); if (chunk.done) break; buffer += decoder.decode(chunk.value, { stream: true });
      let end: number; while ((end = buffer.indexOf('\n\n')) >= 0) {
        const record = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const type = record.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
        const data = record.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (type && data) frames.push({ type, data: JSON.parse(data) });
      }
    } } finally { ended = true; }
  })(); void pump.catch(() => {});
  return { frames, get ended() { return ended; }, close: async () => { await reader.cancel(); await pump; },
    next: async (type: string, from = 0) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) { const frame = frames.slice(from).find(frame => frame.type === type); if (frame) return frame.data; if (ended) throw new Error('Stream ended'); await new Promise(resolve => setTimeout(resolve, 10)); }
      const roots = frames.filter(frame => frame.type === 'snapshot').map(frame => frame.data);
      const changed = roots.length > 1 ? [...new Set([...Object.keys(roots[0]), ...Object.keys(roots.at(-1))])]
        .filter(key => !['tasks', 'revision', 'taskStreamSerial'].includes(key) && JSON.stringify(roots[0][key]) !== JSON.stringify(roots.at(-1)[key])) : [];
      throw new Error('No ' + type + ' frame; received ' + frames.map(frame => frame.type).join(', ') + '; changed root fields: ' + changed.join(', '));
    } };
}

test('Overview omits other task bodies while the selected snapshot retains its complete turn window and legacy state stays compatible', async t => {
  const fixture = await setup(t); const { engine, app, headers } = fixture;
  let projections: string[] = []; const project = engine.conversationHistory.project.bind(engine.conversationHistory);
  engine.conversationHistory.project = async (task, sequence, compactItems, itemHistory) => { projections.push(task.id); return project(task, sequence, compactItems, itemHistory); };
  assert.equal((await app.request('/api/overview')).status, 401);
  const overview = await (await app.request('/api/overview', { headers })).json();
  assert.equal(typeof overview.taskStreamSession, 'string'); assert.equal(overview.tasks.length, 2); assert.deepEqual(projections, []);
  assert.equal(overview.tasks[0].contentOmitted, true); assert.equal(overview.tasks[0].prompt, ''); assert.equal(overview.tasks[0].result, ''); assert.deepEqual(overview.tasks[0].events, []); assert.deepEqual(overview.tasks[0].approvals, []);
  assert.equal(overview.tasks[0].queue.messages[0].text, ''); assert.deepEqual(overview.tasks[0].queue.messages[0].images, []); assert.equal(overview.tasks[0].queue.messages[0].status, 'queued');
  assert.equal(overview.tasks[0].activityStartedAt, at(24));
  assert.ok(!JSON.stringify(overview).includes('PRIVATE'));
  const detail = await (await app.request('/api/tasks/a/snapshot', { headers })).json();
  assert.deepEqual(projections, ['a']); assert.equal(detail.taskId, 'a'); assert.equal(detail.task.messages.length, 20); assert.equal(detail.task.messages[0].id, 'a-user-3');
  assert.equal(detail.task.result, 'PRIVATE ANSWER a'); assert.equal(detail.task.approvals[0].detail, 'PRIVATE APPROVAL a'); assert.equal(detail.task.events[0].detailOmitted, true); assert.equal(detail.task.events[0].detail, undefined);
  assert.ok(!JSON.stringify(detail).includes('PRIVATE ANSWER b')); assert.equal(detail.version.length, 64); assert.equal(detail.task.contentVersion, detail.version);
  const old = await (await app.request('/api/state', { headers })).json(); assert.equal(old.tasks[0].prompt, 'PRIVATE PROMPT a'); assert.ok(old.tasks[0].events[0].detail.length > 100_000);
  assert.equal(old.projectScriptSettles, undefined); assert.equal(overview.projectScriptSettles, undefined);
  assert.equal((await engine.snapshot()).tasks[0].contentOmitted, undefined);
});

test('Overview emits changed summaries and deletion order without retransmitting task bodies or internal execution receipts', async t => {
  const { engine, app, headers } = await setup(t);
  const stream = await subscribe(await app.request('/api/overview/events', { headers })); t.after(() => stream.close()); await stream.next('snapshot');
  await engine.updateTaskMetadata('a', { title: 'Renamed' });
  const patch = await stream.next('taskSummaries'); assert.deepEqual(patch.tasks.map((task: WorkItem) => task.id), ['a']); assert.equal(patch.tasks[0].title, 'Renamed'); assert.ok(!JSON.stringify(patch).includes('PRIVATE'));
  const before = stream.frames.length;
  await engine.mutate(state => {
    state.requests['internal-only'] = 'a';
    state.taskMetadataRequests = { 'metadata:internal-only': { taskId: 'a', digest: 'private-metadata-receipt' } };
    state.projectScriptSettles = { 'internal-settle-watermark': at(35) };
  }); await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(stream.frames.slice(before).filter(frame => ['snapshot', 'taskSummaries'].includes(frame.type)).length, 0);
  await engine.mutate(state => { state.ideas.push({ id: 'note', text: 'Visible note', createdAt: at(0), taskId: null }); });
  const root = await stream.next('snapshot', before); assert.equal(root.ideas[0].text, 'Visible note'); assert.ok(!JSON.stringify(root).includes('PRIVATE'));
  assert.equal(root.taskMetadataRequests, undefined); assert.ok(!JSON.stringify(root).includes('private-metadata-receipt'));
  assert.equal(root.projectScriptSettles, undefined); assert.ok(!JSON.stringify(root).includes('internal-settle-watermark'));
  const position = stream.frames.length; await engine.deleteTask('b');
  const deletion = await stream.next('taskSummaries', position); assert.deepEqual(deletion.removed, ['b']); assert.deepEqual(deletion.order, ['a']);
});

test('A selected task stream ignores another task, resumes an unchanged version and supplies changed content plus an explicit removal', async t => {
  const { engine, app, headers } = await setup(t);
  const first = await (await app.request('/api/tasks/a/snapshot', { headers })).json();
  const stream = await subscribe(await app.request(`/api/tasks/a/events?session=${first.sessionId}&version=${first.version}`, { headers })); t.after(() => stream.close()); await stream.next('heartbeat');
  await engine.patchTask('b', task => { task.result = 'unrelated answer'; }); await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(stream.frames.filter(frame => frame.type === 'taskSnapshot').length, 0);
  await engine.patchTask('a', task => { task.result = 'Updated selected answer'; });
  const changed = await stream.next('taskSnapshot'); assert.equal(changed.task.result, 'Updated selected answer'); assert.notEqual(changed.version, first.version);
  await engine.patchTask('a', task => { task.queue = undefined; }); await engine.deleteTask('a');
  const removed = await stream.next('taskRemoved'); assert.equal(removed.taskId, 'a'); assert.equal((await app.request('/api/tasks/a/snapshot', { headers })).status, 404);
  const missing = await (await app.request('/api/tasks/a/snapshot', { headers })).json(); assert.equal(missing.removed, true); assert.equal(missing.sessionId, first.sessionId); assert.equal(missing.taskId, 'a');
});

test('Task versions cannot suppress the initial snapshot of another service session, and invalid or unknown scopes are rejected', async t => {
  const fixture = await setup(t); const first = await (await fixture.app.request('/api/tasks/a/snapshot', { headers: fixture.headers })).json();
  assert.equal((await fixture.app.request('/api/tasks/a/snapshot')).status, 401);
  assert.equal((await fixture.app.request('/api/tasks/missing/events', { headers: fixture.headers })).status, 404);
  assert.equal((await fixture.app.request('/api/tasks/a/events?version=invalid', { headers: fixture.headers })).status, 400);
  await fixture.reopen();
  const stream = await subscribe(await fixture.app.request(`/api/tasks/a/events?session=${first.sessionId}&version=${first.version}`, { headers: fixture.headers })); t.after(() => stream.close());
  const frame = await stream.next('taskSnapshot'); assert.notEqual(frame.sessionId, first.sessionId); assert.equal(frame.taskId, 'a');
});

test('Revoking a paired viewer ends overview and detail subscriptions and denies subsequent reads', async t => {
  const { engine, app, auth } = await setup(t); const device = auth.pair(auth.createPairing().code, 'Viewer', 'test'); const headers = { Authorization: 'Bearer ' + device.token };
  const overview = await subscribe(await app.request('/api/overview/events', { headers })); const detail = await subscribe(await app.request('/api/tasks/a/events', { headers }));
  t.after(async () => { await overview.close(); await detail.close(); }); await overview.next('snapshot'); await detail.next('taskSnapshot');
  auth.revoke(device.id); await engine.patchTask('a', task => { task.result = 'after revocation'; });
  const deadline = Date.now() + 2500; while ((!overview.ended || !detail.ended) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(overview.ended && detail.ended); assert.ok(!JSON.stringify(overview.frames).includes('after revocation')); assert.ok(!JSON.stringify(detail.frames).includes('after revocation'));
  assert.equal((await app.request('/api/tasks/a/snapshot', { headers })).status, 401);
});

test('Closing a task viewer leaves its running Durable execution and provider ownership intact', async t => {
  let finish: (() => void) | undefined; let liveSignal: AbortSignal | undefined;
  class Controlled extends NoWork {
    async run({ update, signal }: ExecutionRequest) { this.calls++; liveSignal = signal; await update({ kind: 'session', threadId: 'resident-native' }); await update({ kind: 'turn', turnId: 'resident-turn' });
      await new Promise<void>((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); return 'Resident result'; }
  }
  const executor = new Controlled(); const { engine, app, headers } = await setup(t, executor);
  const id = await engine.createTask({ prompt: 'Run independently', projectId: 'project', agent: 'codex', mode: 'research', requestId: 'resident-request' });
  const deadline = Date.now() + 8000; while (!finish && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(finish);
  const stream = await subscribe(await app.request(`/api/tasks/${id}/events`, { headers })); await stream.next('taskSnapshot'); await stream.close();
  assert.equal(liveSignal?.aborted, false); assert.equal((await engine.snapshot()).tasks.find(task => task.id === id)?.status, 'running');
  finish!();
  while ((await engine.snapshot()).tasks.find(task => task.id === id)?.status !== 'completed') { if (Date.now() > deadline) throw new Error('Resident task did not complete'); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(executor.calls, 1); assert.equal((await engine.snapshot()).tasks.find(task => task.id === id)?.result, 'Resident result');
});

test('A paused Codex token burst reaches the selected task before completion and survives viewer reconnection without another turn', async t => {
  const command = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url)); await chmod(command, 0o755);
  const { engine, app, headers } = await setup(t, new CodexExecutor(command));
  const cwd = (await engine.snapshot()).projects[0].path;
  const id = await engine.createTask({ prompt: 'paused-live-output-protocol', title: 'Live streaming regression', projectId: 'project', agent: 'codex', mode: 'research', requestId: 'live-output' });
  const stream = await subscribe(await app.request(`/api/tasks/${id}/events?itemHistory=1`, { headers })); t.after(() => stream.close());
  const waitFor = async (read: () => boolean, label: string) => {
    const deadline = Date.now() + 8000;
    while (!read()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const publicText = (frame: any) => frame?.task?.events?.some((event: any) => event.kind === 'reasoning' && event.text === 'Checking the project')
    && frame?.task?.events?.some((event: any) => event.phase === 'commentary' && event.text === '正在检查项目 🚀');
  await waitFor(() => stream.frames.some(frame => frame.type === 'taskSnapshot' && frame.data.task.status === 'running' && publicText(frame.data)), 'Paused text did not reach the running task stream');
  const running = (await engine.snapshot()).tasks.find(task => task.id === id)!;
  assert.equal(running.status, 'running'); assert.equal(running.result, '', 'commentary and summaries are not a final answer');
  assert.equal(running.events.find(event => event.phase === 'commentary')?.status, 'running');
  assert.ok(!stream.frames.some(frame => frame.data.task?.status === 'completed'));
  const overview = await (await app.request('/api/overview', { headers })).json();
  assert.ok(!JSON.stringify(overview).includes('Checking the project')); assert.ok(!JSON.stringify(overview).includes('正在检查项目'));
  await stream.close();
  const resumed = await subscribe(await app.request(`/api/tasks/${id}/events?itemHistory=1`, { headers })); t.after(() => resumed.close());
  const restored = await resumed.next('taskSnapshot');
  assert.ok(publicText(restored)); assert.equal(restored.task.status, 'running');
  await writeFile(join(cwd, 'release-stream-output'), 'complete');
  await waitFor(() => resumed.frames.some(frame => frame.type === 'taskSnapshot' && frame.data.task.status === 'completed'), 'Completion did not reach the reconnected viewer');
  const complete = resumed.frames.findLast(frame => frame.type === 'taskSnapshot' && frame.data.task.status === 'completed')!.data;
  assert.ok(publicText(complete)); assert.equal(complete.task.result, 'Live output verified.');
  const wire = (await readFile(join(cwd, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(wire.filter(entry => entry.method === 'turn/start').length, 1, 'reconnecting a viewer must not execute the task again');
  assert.equal(wire.find(entry => entry.method === 'turn/start').params.summary, 'detailed');
});
