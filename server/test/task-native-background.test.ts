import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defaultClaudeSettings } from '../src/claude-provider.js';
import { taskSidebarActivity } from '../src/task-sidebar-activity.js';
import { taskSummary } from '../src/task-stream.js';
import type { WorkItem } from '../src/types.js';
import { sidebarTaskScope } from '../src/task-sidebar-order.js';
import { WorkspaceDoc } from '../src/state.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const binaryPath = fileURLToPath(new URL('fixtures/claude-background.mjs', import.meta.url));
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-native-background-')); const cwd = join(directory, 'project'); const data = join(directory, 'data');
  await mkdir(cwd); await chmod(binaryPath, 0o755); let engine = await new Engine(data).open(); const auth = new Auth(data); let app = createAPI(engine, auth);
  await engine.claudeConnection.save({ ...defaultClaudeSettings, binaryPath, homePath: data, permissionMode: 'default', environment: [{ name: 'CLAUDE_CODE_TMPDIR', value: join(directory, 'tmp') }] });
  await engine.mutate(state => { state.projects.push({ id: 'p', name: 'Owned native fixture', path: cwd, context: '' }); });
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const task = async () => (await engine.snapshot()).tasks[0];
  const wait = async (predicate: (value: WorkItem) => boolean) => {
    const deadline = Date.now() + 6_000;
    while (true) { const value = await task(); if (value && predicate(value)) return value; assert.ok(Date.now() < deadline, 'Native fixture did not reach expected state: ' + JSON.stringify(value && { status: value.status, error: value.error, result: value.result, background: value.nativeBackgroundWork })); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const start = async (prompt = 'background-command') => {
    await engine.createTask({ projectId: 'p', title: 'Owned native task', agent: 'claude', mode: 'code', model: 'sonnet', reasoningEffort: 'high', prompt, requestId: 'first' });
    return wait(task => !!task.nativeBackgroundWork?.length && (task.status === 'completed' || task.status === 'failed' || task.backgroundWaiting === true));
  };
  return { get engine() { return engine; }, get app() { return app; }, task, wait, start, cwd, data,
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, marker: (name: string) => writeFile(join(data, name), ''),
    wire: async () => (await readFile(join(data, 'native-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    async reopen() { await engine.close(); engine = await new Engine(data).open(); app = createAPI(engine, auth); },
  };
}
async function output(f: Awaited<ReturnType<typeof fixture>>, workId: string, token: string, includes: string) {
  const deadline = Date.now() + 4_000;
  while (true) { const frame = await f.engine.commandOutputs.nativeFrame((await f.task()).id, workId, token); if (frame.text.includes(includes)) return frame; assert.ok(Date.now() < deadline, 'Native output was not captured'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function childTask(f: Awaited<ReturnType<typeof fixture>>, id: string, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 4_000;
  while (true) { const value = (await f.engine.snapshot()).tasks.find(task => task.id === id); if (value && predicate(value)) return value; assert.ok(Date.now() < deadline, 'Child conversation did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('Native background commands keep their output and process through the next human turn', async t => {
  const f = await fixture(t); const first = await f.start('background-command level-first'); const work = first.nativeBackgroundWork![0]; const firstRun = first.currentRunId;
  assert.equal(first.status, 'completed'); assert.equal(work.kind, 'command'); assert.equal(work.transportId, first.executionSessionId); assert.equal(taskSidebarActivity(first).working, false);
  await output(f, work.id, work.transportId, 'first café 🚀');
  const revision = (await f.engine.snapshot()).revision;
  await f.marker('emit-output'); await output(f, work.id, work.transportId, 'late output'); assert.equal((await f.engine.snapshot()).revision, revision, 'Raw output is a view-only tail');
  await f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'second', requestId: 'second' });
  const second = await f.wait(task => task.currentRunId !== firstRun && !!task.turnId); await f.marker('finish-work');
  let task = await f.wait(task => task.nativeBackgroundWork![0].status === 'completed');
  assert.equal(task.currentRunId, second.currentRunId); assert.equal(task.status, 'running');
  const frame = await output(f, work.id, work.transportId, 'last bytes'); assert.equal(frame.running, false); assert.match(frame.text, /first café 🚀\nlate output\nlast bytes\n/);
  const event = (await f.engine.taskHistory.eventItems(task.id, [work.origin!.eventId])).events[0]; assert.equal(event.runId, firstRun); assert.equal(event.status, 'completed'); assert.match(event.detail!, /last bytes/);
  await f.marker('finish-second'); task = await f.wait(task => task.status === 'completed' && task.result === 'Second answer');
  assert.equal((await f.wire()).filter(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).length, 1); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 2);
});

test('Monitor and subagent membership hold completion; ambient watchers do not', async t => {
  for (const kind of ['monitor', 'subagent', 'ambient']) await t.test(kind, async t => {
    const f = await fixture(t); let task = await f.start(kind); const work = task.nativeBackgroundWork![0];
    assert.equal(work.kind, kind === 'subagent' ? 'subagent' : kind === 'monitor' ? 'monitor' : 'command');
    if (kind === 'ambient') { assert.equal(task.status, 'completed'); assert.equal(task.backgroundActivity?.commands, 0); }
    else { assert.equal(task.status, 'waiting'); assert.equal(task.backgroundWaiting, true); assert.equal(taskSidebarActivity(task).working, false); }
    await f.marker('finish-work'); task = await f.wait(task => task.status === 'completed' && task.nativeBackgroundWork![0].status === 'completed');
    assert.equal(task.backgroundWaiting, false); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
  });
});

for (const action of ['archived', 'settled'] as const) test(action + ' the installed SDK session closes its owned ambient work without sending another prompt, and restoration stays passive', async t => {
  const f = await fixture(t), first = await f.start('ambient');
  const response = await f.app.request('/api/tasks/' + first.id, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ [action]: true }) });
  assert.equal(response.status, 200, await response.text()); const archived = await f.task();
  assert(archived[action === 'archived' ? 'archivedAt' : 'settledAt']); assert.equal(archived[action === 'archived' ? 'archiveCleanup' : 'settleCleanup']?.status, 'completed'); assert.equal(archived.nativeBackgroundConnected, false);
  assert(archived.nativeBackgroundWork?.every(work => ['completed', 'failed', 'stopped', 'interrupted'].includes(work.status)));
  const restore = await f.app.request('/api/tasks/' + first.id, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ [action]: false }) });
  assert.equal(restore.status, 200); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Idle and immediate native wakes become Durable observations without sending another prompt', async t => {
  for (const immediate of [false, true]) await t.test(String(immediate), async t => {
    const f = await fixture(t); await f.start('background-command' + (immediate ? ' immediate-wake' : '')); if (!immediate) await f.marker('emit-wake');
    const task = await f.wait(task => task.status === 'completed' && task.result === (immediate ? 'Immediate native answer' : 'Background wake'));
    const state = await f.engine.snapshot(); const receipt = Object.values(state.nativeTurnRequests ?? {})[0]; assert.equal(receipt.status, 'completed');
    assert.ok(task.messages?.some(message => message.runId === receipt.runId && message.role === 'assistant')); assert.equal(task.currentRunId, receipt.runId); assert.ok(task.artifact?.includes('-native-'));
    assert.equal(task.contextUsage?.usedTokens, 60); assert.equal(task.contextUsage?.maxTokens, 200000); assert.equal(task.runs?.find(run => run.id === receipt.runId)?.contextUsage?.usedTokens, 60);
    assert.match(await f.engine.artifact(task.id), new RegExp(immediate ? 'Immediate native answer' : 'Background wake'));
    assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
    await f.reopen(); assert.equal((await f.task()).result, task.result); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1, 'Recovery must not replay a native wake');
  });
});

test('A foreign native wake before the human echo cannot settle or overwrite the human run', async t => {
  const f = await fixture(t); const first = await f.start();
  await f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'second wake-before-echo', requestId: 'second' });
  const task = await f.wait(task => task.events.some(event => event.kind === 'message' && event.text === 'Foreign background wake') && task.events.some(event => event.text === 'Second pending'));
  const receipts = Object.values((await f.engine.snapshot()).nativeTurnRequests ?? {}); assert.equal(receipts.length, 1); assert.equal(receipts[0].result, 'Foreign background wake');
  assert.equal(task.status, 'running'); assert.notEqual(task.currentRunId, receipts[0].runId);
  await f.marker('finish-second'); await f.wait(task => task.status === 'completed' && task.result === 'Second answer');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 2);
});

test('Native stop uses the authenticated durable receipt, waits for terminal evidence, and deduplicates retries', async t => {
  const f = await fixture(t); const task = await f.start(); const work = task.nativeBackgroundWork![0]; const path = `/api/tasks/${task.id}/background/stop`;
  const body = { eventId: work.id, sessionId: work.transportId, requestId: 'owned-stop' };
  assert.equal((await f.app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).status, 401);
  for (const bad of [{ ...body, unknown: true }, { ...body, sessionId: 'foreign' }, { ...body, requestId: '__proto__' }]) assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(bad) })).status, 400);
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  const stopped = await f.wait(task => task.nativeBackgroundWork![0].stop?.status === 'completed'); assert.equal(stopped.nativeBackgroundWork![0].status, 'stopped'); assert.equal(stopped.result, 'First answer');
  assert.match((await output(f, work.id, work.transportId, 'last bytes')).text, /last bytes/);
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'stop_task').length, 1);
});

test('A background wake keeps actual permission ownership and cannot perform the write before approval', async t => {
  const f = await fixture(t); const original = await f.start();
  await f.engine.updateTaskMetadata(original.id, { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
  // SDK canUseTool callbacks run concurrently with the message iterator. Hold
  // the observation's start receipt so both paths necessarily see that race.
  const update = f.engine.nativeTurns.update.bind(f.engine.nativeTurns);
  let release!: () => void; let began!: () => void;
  const start = new Promise<void>(resolve => { began = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  f.engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { began(); await gate; } await update(id, value); };
  await f.marker('wake-permission'); await start; release();
  let task = await f.wait(task => task.approvals.some(approval => approval.state === 'pending')); const approval = task.approvals.find(approval => approval.state === 'pending')!;
  assert.ok(task.snoozeWakeAt, 'An actual native request wakes a Snoozed task immediately');
  await assert.rejects(access(join(f.data, 'late-approved'))); await f.engine.answer(task.id, approval.id, 'accept', {});
  task = await f.wait(task => task.status === 'completed' && task.result === 'Late approved');
  assert.equal(await readFile(join(f.data, 'late-approved'), 'utf8'), 'approved'); assert.equal(task.approvals.find(value => value.id === approval.id)?.state, 'answered');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('A native output stream validates process scope and exposes final output after completion', async t => {
  const f = await fixture(t); const task = await f.start(); const work = task.nativeBackgroundWork![0]; await output(f, work.id, work.transportId, 'first café');
  const path = `/api/tasks/${task.id}/background/${encodeURIComponent(work.id)}/output?sessionId=${work.transportId}`;
  assert.equal((await f.app.request(path)).status, 401);
  assert.equal((await f.app.request(path.replace(work.transportId, 'not-a-session'), { headers: f.headers })).status, 400);
  await f.marker('finish-work'); await f.wait(task => task.nativeBackgroundWork![0].status === 'completed');
  const response = await f.app.request(path, { headers: f.headers }); assert.equal(response.status, 200);
  const text = await response.text(); assert.match(text, /event: output/); assert.match(text, /last bytes/); assert.match(text, /"running":false/);
});

test('Native callbacks cannot update another thread, process, reverted event, or later human result', async t => {
  const f = await fixture(t); const task = await f.start(); const work = task.nativeBackgroundWork![0];
  const initial = await output(f, work.id, work.transportId, 'first café');
  for (const scope of [{ threadId: 'foreign', sessionId: work.transportId }, { threadId: work.sessionId, sessionId: 'old-process' }]) {
    await f.engine.updateExecution(task.id, { kind: 'nativeBackgroundOutput', ...scope, workId: work.id, delta: 'FOREIGN' });
    await f.engine.updateExecution(task.id, { kind: 'nativeBackground', ...scope, tasks: [{ ...work, status: 'failed' }] });
  }
  assert.equal((await f.engine.commandOutputs.nativeFrame(task.id, work.id, work.transportId)).text, initial.text); assert.equal((await f.task()).result, 'First answer');
  await f.engine.mutate(state => { state.tasks[0].runs!.find(run => run.id === work.origin!.runId)!.revertedAt = new Date().toISOString(); });
  await f.marker('finish-work'); await f.wait(task => task.nativeBackgroundWork![0].status === 'completed');
  assert.ok((await f.engine.taskHistory.eventItems(task.id, [work.origin!.eventId])).events[0].revertedAt);
});

test('Late completion updates the original command even after its event has moved into a history page', async t => {
  const f = await fixture(t); const task = await f.start(); const work = task.nativeBackgroundWork![0];
  await f.engine.patchTask(task.id, task => { for (let index = 0; index < 650; index++) task.events.push({ id: 'archive-' + index, kind: 'note', text: 'Owned history', at: new Date().toISOString(), runId: task.currentRunId }); });
  assert.ok(!(await f.task()).events.some(event => event.id === work.origin!.eventId));
  await f.marker('finish-work'); await f.wait(task => task.nativeBackgroundWork![0].status === 'completed');
  const saved = (await f.engine.taskHistory.eventItems(task.id, [work.origin!.eventId])).events[0]; assert.equal(saved.status, 'completed'); assert.match(saved.detail!, /last bytes/); assert.equal(saved.runId, work.origin!.runId);
});

test('Shutdown interrupts a pending native observation and restart never prompts to recreate it', async t => {
  const f = await fixture(t); await f.start(); await f.marker('start-wake'); await f.wait(task => task.status === 'running' && task.events.some(event => event.text === 'Background working'));
  await f.reopen(); const task = await f.wait(task => task.status === 'interrupted'); const receipt = Object.values((await f.engine.snapshot()).nativeTurnRequests ?? {})[0];
  assert.equal(receipt.status, 'interrupted'); assert.equal(task.status, 'interrupted'); assert.equal(task.nativeBackgroundConnected, false); assert.equal(task.nativeBackgroundWork![0].status, 'unknown');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Empty membership before a terminal edge drains its last output; root failure leaves live background ownership intact', async t => {
  const f = await fixture(t); const task = await f.start('background-command root-fails'); assert.equal(task.status, 'failed'); assert.match(task.error!, /Owned root failed/);
  const work = task.nativeBackgroundWork![0]; await f.marker('emit-output'); await output(f, work.id, work.transportId, 'late output');
  await f.marker('finish-empty-first'); const final = await f.wait(task => task.nativeBackgroundWork![0].status === 'completed' && !!task.nativeBackgroundWork![0].output?.text.includes('last bytes'));
  assert.equal(final.status, 'failed'); assert.match((await output(f, work.id, work.transportId, 'last bytes')).text, /last bytes/);
});

test('Disconnect and uncertain stop retain output and never replay the native stop or prompt after restart', async t => {
  const f = await fixture(t); const first = await f.start(); const work = first.nativeBackgroundWork![0];
  await f.marker('emit-output'); await output(f, work.id, work.transportId, 'late output'); await f.marker('lose-stop-receipt');
  await f.engine.nativeBackground.stop(first.id, work.id, work.transportId, 'unknown-stop');
  await f.wait(task => task.nativeBackgroundWork![0].stop?.status === 'uncertain' && task.nativeBackgroundWork![0].status === 'unknown');
  await f.reopen(); const task = await f.task(); assert.equal(task.result, 'First answer'); assert.equal(task.nativeBackgroundConnected, false); assert.match(task.nativeBackgroundWork![0].output!.text, /late output/);
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1); assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'stop_task').length, 1);
});

test('Active native work stays private and task deletion stops the owned process before removing the task', async t => {
  const f = await fixture(t); const task = await f.start(); const summary = taskSummary(task, 1);
  assert.equal(summary.backgroundActivity?.commands, 1); assert.equal(summary.nativeBackgroundWork, undefined); assert.ok(!JSON.stringify(summary).includes('owned command'));
  await f.engine.deleteTask(task.id); assert.equal((await f.engine.snapshot()).tasks.length, 0); assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'stop_task').length, 1);
});

test('Settled Stop closes only the native owner, drains its shutdown tail, and deduplicates through restart', async t => {
  const f = await fixture(t); const first = await f.start(); const work = first.nativeBackgroundWork![0];
  const pid = (await f.wire()).find(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).pid;
  await f.marker('slow-exit');
  const path = `/api/tasks/${first.id}/background/settle`; const body = { sessionId: work.transportId, runId: first.currentRunId, requestId: 'settled-stop' };
  assert.equal((await f.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  for (const bad of [{ ...body, unknown: true }, { ...body, sessionId: 'another-process' }, { ...body, runId: 'earlier-run' }, { ...body, requestId: '__proto__' }]) assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(bad) })).status, 400);
  const accepted = await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) }); assert.equal(accepted.status, 202); const receipt = await accepted.json();
  const stopped = await f.wait(task => task.backgroundStop?.status === 'completed');
  assert.equal(stopped.status, 'completed'); assert.equal(stopped.result, first.result); assert.equal(stopped.updatedAt, first.updatedAt);
  assert.equal(stopped.nativeBackgroundWork![0].status, 'interrupted'); assert.equal(stopped.nativeBackgroundConnected, false);
  assert.match((await output(f, work.id, work.transportId, 'shutdown final')).text, /shutdown final/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'A completed Stop owns the CLI shutdown, not just its UI status');
  assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt').length, 0, 'A settled native Stop closes the idle owner directly');
  const duplicate = await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) }); assert.deepEqual(await duplicate.json(), receipt);
  await f.reopen(); assert.equal((await f.task()).nativeBackgroundWork![0].status, 'interrupted');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
  const overview = await (await f.app.request('/api/overview', { headers: f.headers })).json(); assert.equal(overview.backgroundStopRequests, undefined);
});

test('Main Stop sends one interrupt, ignores a late success and waits for the native CLI to exit', async t => {
  const f = await fixture(t); const first = await f.start(); const work = first.nativeBackgroundWork![0];
  await f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'second', requestId: 'second' });
  await f.wait(task => task.events.some(event => event.text === 'Second pending'));
  await f.marker('interrupt-delayed'); await f.marker('slow-exit'); await Promise.all([f.engine.cancel(first.id), f.engine.cancel(first.id)]);
  const stopped = await f.task(); assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.nativeBackgroundWork![0].status, 'interrupted');
  assert.ok(!stopped.events.some(event => event.text.includes('Late reply after Stop'))); assert.notEqual(stopped.result, 'Late reply after Stop');
  assert.match((await output(f, work.id, work.transportId, 'shutdown final')).text, /shutdown final/);
  const wire = await f.wire(); assert.equal(wire.filter(entry => entry.request?.subtype === 'interrupt').length, 1);
  const pid = wire.find(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).pid; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await f.reopen(); assert.equal((await f.task()).status, 'cancelled'); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 2);
});

test('Stop of an observed native reply uses its owning turn and interrupts its background roster', async t => {
  const f = await fixture(t); await f.start(); await f.marker('start-wake');
  const active = await f.wait(task => task.status === 'running' && task.events.some(event => event.text === 'Background working'));
  await f.engine.cancel(active.id); const stopped = await f.wait(task => task.status === 'interrupted');
  assert.equal(stopped.nativeBackgroundWork![0].status, 'interrupted'); assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt').length, 1);
  const receipt = Object.values((await f.engine.snapshot()).nativeTurnRequests ?? {})[0]; assert.equal(receipt.status, 'interrupted');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('A Stop while a model result is being saved still closes the old native owner', { timeout: 15_000 }, async t => {
  const f = await fixture(t); let release!: () => void; let saving!: () => void; let aborted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); const savingResult = new Promise<void>(resolve => { saving = resolve; }); const didAbort = new Promise<void>(resolve => { aborted = resolve; });
  const run = f.engine.executor.run.bind(f.engine.executor); f.engine.executor.run = request => { request.signal.addEventListener('abort', aborted, { once: true }); return run(request); };
  const finish = f.engine.taskRuns.finish.bind(f.engine.taskRuns); let held = false;
  f.engine.taskRuns.finish = async (...args) => { if (args[2] === 'completed' && !held) { held = true; saving(); await gate; } return finish(...args); };
  t.signal.addEventListener('abort', release, { once: true });
  try {
  await f.engine.createTask({ projectId: 'p', title: 'Owned save race', agent: 'claude', mode: 'code', model: 'sonnet', reasoningEffort: 'high', prompt: 'background-command', requestId: 'first' });
  await savingResult; const task = await f.task(); const stopped = f.engine.cancel(task.id); await didAbort; release(); await stopped;
  const current = await f.task(); assert.equal(current.status, 'cancelled'); assert.equal(current.nativeBackgroundWork![0].status, 'interrupted');
  const pid = (await f.wire()).find(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).pid; assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { release(); }
});

test('A settled Stop after a lost transport is metadata-only and never recreates or prompts a CLI', async t => {
  const f = await fixture(t); const first = await f.start(); await f.marker('disconnect'); await f.wait(task => task.nativeBackgroundConnected === false); await f.reopen();
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'missing-owner');
  const task = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(task.nativeBackgroundWork![0].status, 'interrupted'); assert.equal(task.result, 'First answer');
  assert.equal((await f.wire()).filter(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).length, 1);
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('New input cannot replace a pending Stop; queued input waits for its durable completion', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const first = await f.start(); let began!: () => void; let release!: () => void;
  const start = new Promise<void>(resolve => { began = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const settle = f.engine.executor.settleNativeBackground!.bind(f.engine.executor); f.engine.executor.settleNativeBackground = async task => { began(); await gate; await settle(task); }; t.signal.addEventListener('abort', release, { once: true });
  try {
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'queued-stop'); await start;
  await assert.rejects(f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'direct replacement', requestId: 'direct' }), /正在停止后台工作/);
  await f.engine.taskQueue.enqueue(first.id, { text: 'After the native Stop', model: 'sonnet', reasoningEffort: 'high' }, 'after-stop');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1); release();
  const next = await f.wait(task => task.currentRunId !== first.currentRunId && task.status === 'completed');
  assert.equal(next.backgroundStop?.status, 'completed'); assert.notEqual(next.executionSessionId, first.executionSessionId); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 2);
  } finally { release(); }
});

test('A Stop whose captured execution scope was replaced never closes the newer owner', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const first = await f.start(); let began!: () => void; let release!: () => void;
  const start = new Promise<void>(resolve => { began = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const snapshot = f.engine.snapshot.bind(f.engine); let gated = false;
  f.engine.snapshot = async () => { const state = await snapshot(); if (!gated && state.tasks[0]?.backgroundStop?.status === 'pending') { gated = true; began(); await gate; return snapshot(); } return state; };
  t.signal.addEventListener('abort', release, { once: true });
  try {
    await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'old-scope'); await start;
    await f.engine.mutate(state => { state.tasks[0].executionSessionId = 'newer-owner'; state.tasks[0].result = 'Newer preserved answer'; }); release();
    const done = await f.wait(task => task.backgroundStop?.status === 'uncertain'); assert.equal(done.result, 'Newer preserved answer');
    const pid = (await f.wire()).find(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).pid; assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt' || entry.request?.subtype === 'stop_task').length, 0);
  } finally { release(); f.engine.snapshot = snapshot; }
});

test('A lost settled-Stop receipt can be explicitly reconciled after restart without reopening the CLI', async t => {
  const f = await fixture(t); const first = await f.start(); const settle = f.engine.executor.settleNativeBackground!.bind(f.engine.executor);
  f.engine.executor.settleNativeBackground = async task => { await settle(task); throw new Error('Owned lost receipt'); };
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'lost-group-receipt');
  await f.wait(task => task.backgroundStop?.status === 'uncertain'); await f.reopen();
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'reconcile-closed');
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.nativeBackgroundWork![0].status, 'interrupted'); assert.equal(done.result, 'First answer');
  assert.equal((await f.wire()).filter(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).length, 1);
});

test('The normal scoped Stop endpoint settles background work after the visible model turn completed', async t => {
  const f = await fixture(t); const first = await f.start();
  const body = { sessionId: first.executionSessionId, runId: first.currentRunId };
  const responses = await Promise.all([1, 2].map(() => f.app.request(`/api/tasks/${first.id}/cancel`, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })));
  assert.ok(responses.every(response => response.status === 200)); const done = await f.wait(task => task.backgroundStop?.status === 'completed');
  assert.equal(done.result, first.result); assert.equal(done.status, 'completed'); assert.equal(done.nativeBackgroundWork![0].status, 'interrupted');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('A delayed Stop for an earlier turn cannot pause queued input or interrupt the later human turn', async t => {
  const f = await fixture(t); const first = await f.start();
  await f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'second', requestId: 'second' });
  const second = await f.wait(task => task.events.some(event => event.text === 'Second pending'));
  await f.engine.taskQueue.enqueue(second.id, { text: 'Queued future request' }, 'future');
  const response = await f.app.request(`/api/tasks/${first.id}/cancel`, { method: 'POST', headers: f.headers, body: JSON.stringify({ runId: first.currentRunId, sessionId: first.executionSessionId }) });
  assert.equal(response.status, 400); const preserved = await f.task(); assert.equal(preserved.currentRunId, second.currentRunId); assert.equal(preserved.queue?.paused, false); assert.equal(preserved.status, 'running');
  assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt').length, 0);
  await f.engine.taskQueue.pause(second.id);
});

test('Waiting on background completion after a native result closes its owner without an extra model interrupt', async t => {
  const f = await fixture(t); const waiting = await f.start('monitor'); assert.equal(waiting.backgroundWaiting, true);
  await f.engine.cancel(waiting.id); const done = await f.task(); assert.equal(done.status, 'cancelled'); assert.equal(done.backgroundWaiting, false); assert.equal(done.nativeBackgroundWork![0].status, 'interrupted');
  assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt').length, 0); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Stopping an unsent newer input also closes the older native permission owner without approving its tool', { timeout: 15_000 }, async t => {
  const f = await fixture(t); const first = await f.start(); const run = f.engine.executor.run.bind(f.engine.executor);
  let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.engine.executor.run = request => {
    if (!request.prompt.includes('second-before-send')) return run(request);
    entered();
    return new Promise<never>((_, reject) => {
      const abort = () => reject(new Error('Owned input cancelled before send'));
      request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
    });
  };
  await f.engine.createTask({ continueId: first.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'second-before-send', requestId: 'second' });
  await waiting; await f.marker('wake-permission');
  const pending = await f.wait(task => task.approvals.some(approval => approval.state === 'pending'));
  assert.notEqual(pending.currentRunId, first.currentRunId); await assert.rejects(access(join(f.data, 'late-approved')));
  await f.engine.cancel(pending.id, { runId: pending.currentRunId, sessionId: pending.executionSessionId });
  const done = await f.task(); assert.equal(done.status, 'cancelled'); assert.equal(done.backgroundStop?.status, 'completed');
  assert.equal(done.nativeBackgroundWork![0].status, 'interrupted'); assert.ok(done.approvals.every(approval => approval.state !== 'pending'));
  await assert.rejects(access(join(f.data, 'late-approved')));
  const receipts = Object.values((await f.engine.snapshot()).nativeTurnRequests ?? {}); assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'interrupted');
  const wire = await f.wire(); assert.equal(wire.filter(entry => entry.type === 'user').length, 1); assert.equal(wire.filter(entry => entry.request?.subtype === 'interrupt').length, 1);
});

test('A native subagent has its own persisted conversation and scoped navigation without sending another prompt', async t => {
  const f = await fixture(t); const first = await f.start('subagent-detail');
  const parent = await f.wait(task => task.subagents?.length === 1); const agent = parent.subagents![0];
  let child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.subagentOrigin?.parentTaskId, parent.id); assert.equal(child.durableId, null); assert.equal(child.threadId, null);
  assert.equal(child.prompt, 'Read the project and report findings'); assert.equal(child.model, 'haiku'); assert.equal(child.result, 'Early child answer');
  assert.ok(child.events.some(event => event.text === 'Early child answer' && event.phase === 'final_answer')); assert.ok(!parent.events.some(event => event.text === 'Early child answer'));
  assert.ok(parent.events.some(event => event.kind === 'subagent' && event.subagentId === agent.id));
  const overview = await (await f.app.request('/api/overview', { headers: f.headers })).json();
  assert.equal(overview.tasks.find((task: WorkItem) => task.id === parent.id).subagents, undefined, 'An unselected child body must not leak through sidebar metadata');
  assert.ok(!JSON.stringify(overview).includes('Early child answer'));
  const opened = await f.app.request(`/api/tasks/${child.id}/snapshot`, { headers: f.headers }); assert.equal(opened.status, 200); assert.equal((await opened.json()).task.subagentOrigin.subagentId, agent.id);
  await assert.rejects(f.engine.createTask({ continueId: child.id, projectId: 'p', agent: 'claude', mode: 'code', prompt: 'Must not send', requestId: 'child-input' }), /原生子 Agent/);
  await assert.rejects(f.engine.taskQueue.enqueue(child.id, { text: 'Must not queue' }, 'child-queue'), /原生子 Agent/);
  await assert.rejects(f.engine.cancel(child.id), /原生子 Agent/);
  await assert.rejects(f.engine.taskTitles.start(child.id, 'child-title'), /不支持生成标题/);
  await f.marker('child-answer');
  const deadline = Date.now() + 4_000;
  while (true) { child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!; if (child.result === 'Actual child answer') break; assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.marker('finish-work'); const done = await f.wait(task => task.status === 'completed');
  child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.status, 'completed'); assert.equal(child.result, 'Actual child answer'); assert.equal(done.result, 'First answer');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
  await f.reopen(); child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!; assert.equal(child.result, 'Actual child answer');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Nested native subagents navigate through their actual parent and closing the host never replays their work', async t => {
  const f = await fixture(t); await f.start('subagent-detail'); await f.marker('child-nested');
  const parent = await f.wait(task => task.subagents?.length === 2 && task.subagents.some(agent => agent.nativeId === 'nested-task' && agent.status === 'completed'));
  const first = parent.subagents!.find(agent => agent.nativeId === 'task-owned')!; const nested = parent.subagents!.find(agent => agent.nativeId === 'nested-task')!;
  assert.equal(nested.parentSubagentId, first.id);
  const state = await f.engine.snapshot(); const child = state.tasks.find(task => task.id === first.childTaskId)!; const leaf = state.tasks.find(task => task.id === nested.childTaskId)!;
  assert.equal(leaf.subagentOrigin?.parentTaskId, child.id); assert.equal(leaf.result, 'Nested answer'); assert.equal(child.subagents?.[0].id, nested.id);
  assert.ok(!child.events.some(event => event.text === 'Nested answer')); assert.ok(!parent.events.some(event => event.text === 'Nested answer'));
  await f.reopen(); const restored = await f.engine.snapshot();
  assert.equal(restored.tasks.find(task => task.id === child.id)?.status, 'interrupted'); assert.equal(restored.tasks.find(task => task.id === leaf.id)?.status, 'completed');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Subagent Stop is authenticated, native-turn scoped and deduplicated, and does not hold the parent input queue', async t => {
  const f = await fixture(t); const root = await f.start('subagent-detail'); const agent = root.subagents![0];
  const path = `/api/tasks/${root.id}/subagents/${agent.id}/stop`; const body = { sessionId: agent.sessionId, childTurnId: agent.childTurnId, requestId: 'child-stop' };
  assert.equal((await f.app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })).status, 401);
  for (const bad of [{ ...body, extra: true }, { ...body, childTurnId: 'old-child-turn' }, { ...body, sessionId: 'another-process' }]) assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(bad) })).status, 400);
  await f.engine.taskQueue.enqueue(root.id, { text: 'second', model: 'sonnet', reasoningEffort: 'high' }, 'after-child');
  const response = await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) }); assert.equal(response.status, 202); const receipt = await response.json();
  const next = await f.wait(task => task.currentRunId !== root.currentRunId && task.events.some(event => event.text === 'Second pending'));
  assert.equal(next.queue?.paused, false); assert.equal(next.subagents?.[0].status, 'cancelled');
  const again = await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) }); assert.deepEqual(await again.json(), receipt);
  const wire = await f.wire(); assert.equal(wire.filter(entry => entry.request?.subtype === 'stop_task').length, 1); assert.equal(wire.filter(entry => entry.request?.subtype === 'interrupt').length, 0); assert.equal(wire.filter(entry => entry.type === 'user').length, 2);
});

test('A foreground native subagent can stop through its own native task without interrupting the parent turn', async t => {
  const f = await fixture(t); await f.engine.createTask({ projectId: 'p', title: 'Foreground child', agent: 'claude', mode: 'code', model: 'sonnet', reasoningEffort: 'high', prompt: 'subagent-foreground', requestId: 'first' });
  const root = await f.wait(task => task.subagents?.[0].canStop === true); const agent = root.subagents![0];
  assert.equal(root.nativeBackgroundWork![0].member, false); assert.equal(root.nativeBackgroundWork![0].backgrounded, false);
  await f.engine.subagents.stop(root.id, agent.id, agent.sessionId, agent.childTurnId, 'foreground-child-stop');
  const done = await f.wait(task => task.status === 'completed' && task.subagents![0].stop?.status === 'completed');
  assert.equal(done.subagents![0].status, 'cancelled'); assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'interrupt').length, 0);
  assert.equal((await f.wire()).filter(entry => entry.request?.subtype === 'stop_task').length, 1);
});

test('A child shell has an independent live output stream and persists its final tail without mixing into the root', async t => {
  const f = await fixture(t); const root = await f.start('subagent-detail'); const agent = root.subagents![0]; await f.marker('child-command');
  let child = await childTask(f, agent.childTaskId, task => task.events.some(event => event.kind === 'command'));
  const command = child.events.find(event => event.kind === 'command')!; const epoch = child.history!.epoch;
  const read = async (includes: string) => { const deadline = Date.now() + 4_000; while (true) { const value = await f.engine.commandOutputs.frame(child.id, command.id, epoch); if (value.text.includes(includes)) return value; assert.ok(Date.now() < deadline, 'Child output missing'); await new Promise(resolve => setTimeout(resolve, 10)); } };
  assert.equal((await read('Child command first café 🚀')).running, true); const revision = (await f.engine.snapshot()).revision;
  await f.marker('child-command-output'); await read('Child command last bytes'); assert.equal((await f.engine.snapshot()).revision, revision, 'Raw child output must remain a view-only tail');
  await f.marker('child-command-finish'); child = await childTask(f, child.id, task => task.events.some(event => event.id === command.id && event.status === 'completed'));
  assert.match(child.events.find(event => event.id === command.id)!.detail!, /Child command last bytes/); assert.equal((await read('last bytes')).running, false);
  assert.ok(!(await f.task()).events.some(event => event.text === command.text)); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Native child permissions stay on the root and cannot perform a write before the user answers there', async t => {
  const f = await fixture(t); const root = await f.start('subagent-detail'); const agent = root.subagents![0]; await f.marker('child-permission');
  const pending = await f.wait(task => task.approvals.some(approval => approval.state === 'pending')); const approval = pending.approvals.find(approval => approval.state === 'pending')!;
  const child = await childTask(f, agent.childTaskId, task => task.events.some(event => event.text.startsWith('Write')));
  assert.equal(child.approvals.length, 0); assert.equal(child.status, 'waiting'); await assert.rejects(access(join(f.data, 'late-approved')));
  await f.engine.answer(root.id, approval.id, 'accept', {}); await childTask(f, child.id, task => task.result === 'Child approved');
  assert.equal(await readFile(join(f.data, 'late-approved'), 'utf8'), 'approved'); assert.notEqual((await f.task()).result, 'Child approved');
  await f.marker('finish-work'); await f.wait(task => task.status === 'completed'); assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});

test('Reverted child conversations leave navigation, search and sidebar scopes, and late source updates cannot resurrect them', async t => {
  const f = await fixture(t); const root = await f.start('subagent-detail'); const agent = root.subagents![0];
  const state = await f.engine.snapshot(); assert.deepEqual(sidebarTaskScope(state, 'p').map(task => task.id), [root.id]);
  await f.marker('finish-work'); await f.wait(task => task.status === 'completed');
  await f.engine.mutate(state => { state.tasks[0].runs!.find(run => run.id === agent.runId)!.revertedAt = new Date().toISOString(); });
  const before = (await f.engine.snapshot()).revision;
  await f.engine.subagents.update(root.id, { kind: 'subagent', sessionId: agent.sessionId, threadId: agent.threadId, subagent: { ...agent, status: 'running' } });
  const hidden = await f.engine.snapshot(); assert.equal(hidden.revision, before); assert.ok(!hidden.tasks.some(task => task.id === agent.childTaskId)); assert.equal(hidden.tasks[0].subagents?.length, 0);
  assert.equal((await f.engine.taskSearchVisibility()).has(agent.childTaskId), false);
  assert.equal((await f.app.request(`/api/tasks/${agent.childTaskId}/snapshot`, { headers: f.headers })).status, 404);
});

test('An explicit Stop after losing the provider reconciles child status without recreating a CLI or changing the root result', async t => {
  const f = await fixture(t); const first = await f.start('subagent-detail'); const agent = first.subagents![0]; await f.marker('disconnect');
  await f.wait(task => task.nativeBackgroundConnected === false && task.subagents![0].status === 'unknown'); await f.reopen(); const original = await f.task();
  await f.engine.cancel(original.id); const done = await f.wait(task => task.backgroundStop?.status === 'completed');
  assert.equal(done.result, original.result); assert.equal(done.subagents![0].status, 'interrupted');
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!; assert.equal(child.subagentOrigin?.status, 'interrupted'); assert.equal(child.result, 'Early child answer');
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1); assert.equal((await f.wire()).filter(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))).length, 1);
});

test('A replaced root transport rejects stale child updates and a parent deletion removes all child projections without restarting them', async t => {
  const f = await fixture(t); const root = await f.start('subagent-detail'); const agent = root.subagents![0];
  await f.engine.mutate(state => { state.tasks[0].executionSessionId = 'replacement'; }); const before = (await f.engine.snapshot()).revision;
  await f.engine.subagents.update(root.id, { kind: 'subagent', sessionId: agent.sessionId, threadId: agent.threadId, subagent: { ...agent, result: 'Foreign replacement', status: 'completed' } });
  assert.equal((await f.engine.snapshot()).revision, before); assert.notEqual((await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!.result, 'Foreign replacement');
  await f.engine.mutate(state => { state.tasks[0].executionSessionId = agent.sessionId; });
  await f.engine.deleteTask(root.id); assert.equal((await f.engine.snapshot()).tasks.length, 0);
  assert.equal((await f.engine.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))!.tasks.length, 0, 'Child data must be removed from the owning document, not only hidden by navigation');
  assert.equal((await f.app.request(`/api/tasks/${agent.childTaskId}/snapshot`, { headers: f.headers })).status, 404);
  assert.equal((await f.wire()).filter(entry => entry.type === 'user').length, 1);
});
