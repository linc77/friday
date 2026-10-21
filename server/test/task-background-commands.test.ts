import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { Engine } from '../src/engine.js';
import { CodexExecutor } from '../src/codex.js';
import { taskSummary } from '../src/task-stream.js';
import { taskSidebarActivity } from '../src/task-sidebar-activity.js';
import { taskSettlementAt } from '../src/task-settlement.js';
import { assertCheckoutIdle } from '../src/branch-switch.js';
import type { WorkItem, NativeForkRequest } from '../src/types.js';

const command = fileURLToPath(new URL('fixtures/codex-background.mjs', import.meta.url));
async function fixture(t: TestContext, create = () => new CodexExecutor(command)) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-background-')); const cwd = join(directory, 'project'); await mkdir(cwd); await chmod(command, 0o755);
  let executor = create(); let engine = await new Engine(join(directory, 'data'), executor).open();
  const auth = new Auth(join(directory, 'data')); let app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  await engine.mutate(state => { state.projects.push({ id: 'project', name: 'Owned fixture', path: cwd, context: '' }); });
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const task = async () => (await engine.snapshot()).tasks.find(task => task.agent === 'codex')!;
  const wait = async (predicate: (task: WorkItem) => boolean) => {
    const deadline = Date.now() + 8_000;
    while (true) { const value = await task(); if (value && predicate(value)) return value; assert.ok(Date.now() < deadline, 'Owned CLI state did not reach its expected transition'); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const start = async () => { await engine.createTask({ projectId: 'project', title: 'Background fixture', agent: 'codex', mode: 'research', prompt: 'First owned turn', requestId: 'first' }); return wait(task => task.status === 'completed' && task.backgroundCommands?.[0]?.status === 'running'); };
  const wire = async () => (await readFile(join(cwd, 'background-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { get engine() { return engine; }, get executor() { return executor; }, get app() { return app; }, auth, headers, cwd, task, wait, start, wire,
    marker: (name: string) => writeFile(join(cwd, name), ''),
    async reopen() { await engine.close(); executor = create(); engine = await new Engine(join(directory, 'data'), executor).open(); app = createAPI(engine, auth, () => []); },
  };
}

test('A completed model turn retains the real CLI and late background output through a subsequent model turn', async t => {
  const f = await fixture(t); let task = await f.start(); const background = task.backgroundCommands![0]; const firstRun = task.currentRunId;
  assert.ok(task.executionSessionId); assert.equal(background.sessionId, task.executionSessionId); assert.equal(background.runId, firstRun);
  assert.equal(taskSidebarActivity(task).working, false, 'Commands alone do not hold model completion or the Working shelf');
  const originalUpdatedAt = task.updatedAt;
  await f.engine.createTask({ continueId: task.id, projectId: 'project', agent: 'codex', mode: 'research', prompt: 'Second owned turn', requestId: 'second' });
  task = await f.wait(task => task.status === 'running' && task.turnId === 'turn-2'); const secondRun = task.currentRunId;
  assert.notEqual(secondRun, firstRun); await f.marker('emit-background');
  const epoch = (await f.engine.taskHistory.eventItems(task.id, [background.id])).epoch;
  const deadline = Date.now() + 5_000;
  while (!(await f.engine.commandOutputs.frame(task.id, background.id, epoch)).text.includes('late 🚀')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  const output = await f.engine.commandOutputs.frame(task.id, background.id, epoch); assert.equal(output.text, 'first\nlate 🚀\n'); assert.equal(output.running, true); assert.ok(!output.text.includes('FOREIGN'));
  await f.marker('finish-background'); task = await f.wait(task => task.backgroundCommands?.[0]?.status === 'completed');
  assert.equal(task.status, 'running'); assert.equal(task.currentRunId, secondRun); assert.equal(task.turnId, 'turn-2'); assert.notEqual(task.updatedAt, originalUpdatedAt);
  assert.equal(task.result, ''); assert.equal(task.runs?.find(run => run.id === firstRun)?.status, 'completed');
  const event = (await f.engine.taskHistory.eventItems(task.id, [background.id])).events[0];
  assert.equal(event.runId, firstRun); assert.equal(event.status, 'completed'); assert.match(event.detail!, /late 🚀/);
  await f.marker('finish-second'); task = await f.wait(task => task.status === 'completed' && task.result === 'Second answer');
  const wire = await f.wire(); assert.equal(wire.filter(value => value.method === 'initialize').length, 1); assert.equal(wire.filter(value => value.method === 'turn/start').length, 2);
  assert.equal((await readFile(join(f.cwd, 'background-launches'), 'utf8')).trim().split('\n').length, 1, 'The next turn uses the retained native process');
});

test('Authenticated Durable stop verifies native item identity and deduplicates retries after termination', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0];
  const path = `/api/tasks/${task.id}/background/stop`; const body = { eventId: background.id, sessionId: background.sessionId, requestId: 'owned-stop' };
  assert.equal((await f.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  for (const bad of [{ ...body, unknown: true }, { ...body, requestId: '__proto__' }, { ...body, sessionId: 'foreign-session' }, { ...body, eventId: 'foreign-item' }]) {
    assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(bad) })).status, 400);
  }
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  let stopped = await f.wait(task => task.backgroundCommands?.[0]?.stop?.status === 'completed');
  assert.notEqual(stopped.backgroundCommands![0].status, 'running'); assert.equal(stopped.result, 'First answer'); assert.equal(stopped.updatedAt, task.updatedAt);
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
  await f.reopen(); stopped = await f.task(); assert.equal(stopped.backgroundCommands![0].stop?.status, 'completed');
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
});

test('A replaced native process handle is never stopped and an uncertain stop is not replayed after restart', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0];
  await f.marker('replace-native-item'); await f.engine.backgroundCommands.stop(task.id, background.id, background.sessionId, 'wrong-native');
  await f.wait(task => task.backgroundCommands?.[0]?.stop?.status === 'uncertain');
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 0);
  await rm(join(f.cwd, 'replace-native-item')); await f.marker('lose-stop-receipt');
  await f.engine.backgroundCommands.stop(task.id, background.id, background.sessionId, 'lost-stop');
  const unknown = await f.wait(task => task.backgroundCommands?.[0]?.stop?.status === 'uncertain' && task.backgroundCommands?.[0]?.status === 'unknown');
  assert.equal(unknown.result, 'First answer');
  await f.reopen(); assert.equal((await f.task()).backgroundCommands![0].stop?.status, 'uncertain');
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
  assert.equal((await f.wire()).filter(value => value.method === 'turn/start').length, 1, 'Recovery starts no model or command');
});

test('Disconnect and service shutdown retain captured output and uncertain membership without inventing success', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0];
  await f.marker('emit-background');
  const epoch = (await f.engine.taskHistory.eventItems(task.id, [background.id])).epoch; const limit = Date.now() + 5_000;
  while (!(await f.engine.commandOutputs.frame(task.id, background.id, epoch)).text.includes('late 🚀')) { assert.ok(Date.now() < limit); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.marker('exit-background-process'); await f.wait(task => task.backgroundCommands?.[0]?.status === 'unknown');
  const event = (await f.engine.taskHistory.eventItems(task.id, [background.id])).events[0]; assert.equal(event.status, 'interrupted'); assert.match(event.detail!, /late 🚀/);
  await f.reopen(); const restored = await f.task(); assert.equal(restored.backgroundCommands![0].status, 'unknown'); assert.equal(restored.backgroundActivity?.unknownCommands, 1);
  assert.equal(restored.result, 'First answer'); assert.equal(restored.threadId, task.threadId);
});

test('Background callbacks cannot overwrite a later session, reverted history, task result, or unrelated output', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0];
  const event = (await f.engine.taskHistory.eventItems(task.id, [background.id])).events[0];
  await f.engine.updateExecution(task.id, { kind: 'backgroundCommand', sessionId: 'old-session', threadId: background.threadId, item: { ...event, text: 'wrong command', status: 'completed' } }, background.runId);
  await f.engine.updateExecution(task.id, { kind: 'backgroundCommandOutput', sessionId: 'old-session', threadId: background.threadId, eventId: background.id, delta: 'STALE' }, background.runId);
  let state = await f.task(); assert.equal(state.backgroundCommands![0].status, 'running'); assert.equal(state.result, task.result);
  const epoch = (await f.engine.taskHistory.eventItems(task.id, [background.id])).epoch;
  assert.ok(!(await f.engine.commandOutputs.frame(task.id, background.id, epoch)).text.includes('STALE'));
  await f.engine.mutate(state => { state.tasks[0].runs!.find(run => run.id === background.runId)!.revertedAt = new Date().toISOString(); });
  await f.engine.updateExecution(task.id, { kind: 'backgroundCommand', sessionId: background.sessionId, threadId: background.threadId, item: { ...event, status: 'completed' } }, background.runId);
  state = await f.task(); assert.equal(state.backgroundCommands![0].status, 'running');
});

test('Background work protects mutations and deletion stops it through Durable without leaking command bodies to sidebars', async t => {
  const f = await fixture(t); const task = await f.start(); const summary = taskSummary(task, 7);
  assert.equal(summary.backgroundActivity?.commands, 1); assert.equal(summary.backgroundCommands, undefined); assert.ok(!JSON.stringify(summary).includes('owned-background-command'));
  const snapshot = await f.engine.snapshot(); assert.throws(() => assertCheckoutIdle(snapshot, f.cwd), /执行或排队/);
  assert.equal(taskSettlementAt(task, Date.now() + 10 * 86_400_000, 3), null);
  const response = await f.app.request('/api/service/update', { method: 'POST', headers: f.headers, body: '{}' }); assert.equal(response.status, 409);
  await f.engine.deleteTask(task.id); assert.equal((await f.engine.snapshot()).tasks.length, 0);
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
  assert.match(await readFile(join(f.cwd, 'background-wire'), 'utf8'), /owned-background-command|thread\/backgroundTerminals/);
});

for (const action of ['archived', 'settled'] as const) test(action + ' Codex terminates its retained background command once, preserves output and restores without another model turn', async t => {
  const f = await fixture(t), first = await f.start(), command = first.backgroundCommands![0];
  const pid = Number(await readFile(join(f.cwd, 'background-pid'), 'utf8'));
  await f.engine.updateTaskMetadata(first.id, { [action]: true, requestId: 'end-background' });
  const archived = await f.task(); assert(archived[action === 'archived' ? 'archivedAt' : 'settledAt']); assert.equal(archived[action === 'archived' ? 'archiveCleanup' : 'settleCleanup']?.status, 'completed');
  assert.equal(archived.result, first.result); assert.ok(!['running', 'unknown'].includes(archived.backgroundCommands![0].status));
  const deadline = Date.now() + 3_000;
  while (true) { try { process.kill(pid, 0); } catch { break; } assert.ok(Date.now() < deadline, 'Archived Codex must release its owned CLI'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const history = await f.engine.taskHistory.eventItems(first.id, [command.id]);
  const output = await f.engine.commandOutputs.frame(first.id, command.id, history.epoch);
  assert.equal(output.running, false); assert.match(output.text, /first/);
  await f.engine.updateTaskMetadata(first.id, { [action]: false, requestId: 'restore-background' });
  await f.reopen(); assert.equal((await f.task())[action === 'archived' ? 'archivedAt' : 'settledAt'], null);
  const wire = await f.wire(); assert.equal(wire.filter(value => value.method === 'turn/start').length, 1);
  assert.equal(wire.filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
});

test('A verified native termination ends output and drains the transport even when the CLI omits item/completed', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0]; await f.marker('omit-stop-event');
  const pid = Number(await readFile(join(f.cwd, 'background-pid'), 'utf8'));
  await f.engine.backgroundCommands.stop(task.id, background.id, background.sessionId, 'no-bookend');
  const ended = await f.wait(task => task.backgroundCommands?.[0]?.stop?.status === 'completed');
  assert.equal(ended.backgroundCommands![0].status, 'stopped'); assert.equal(ended.backgroundCommands![0].exitCode, undefined);
  const page = await f.engine.taskHistory.eventItems(task.id, [background.id]);
  assert.equal(page.events[0].status, 'interrupted'); assert.equal((await f.engine.commandOutputs.frame(task.id, background.id, page.epoch)).running, false);
  const deadline = Date.now() + 3_000;
  while (true) { try { process.kill(pid, 0); } catch { break; } assert.ok(Date.now() < deadline, 'The final retained command must release its owned CLI'); await new Promise(resolve => setTimeout(resolve, 10)); }
});

test('SIGKILL after persisted stop intent never replays termination or starts a model during Durable recovery', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-background-crash-')); const cwd = join(directory, 'project');
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('fixtures/background-crash.mjs', import.meta.url)), directory], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3_000); });
  let engine: Engine | undefined;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await engine?.close(); await rm(directory, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await readFile(join(cwd, 'stop-sent')); break; } catch {}
    assert.equal(child.exitCode, null, stderr); assert.ok(Date.now() < deadline, 'Owned crash fixture did not reach the external stop call'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  child.kill('SIGKILL'); await once(child, 'exit');
  engine = await new Engine(join(directory, 'data'), new CodexExecutor(command)).open();
  const limit = Date.now() + 5_000; let restored: WorkItem;
  while (true) {
    restored = (await engine.snapshot()).tasks[0];
    if (restored.backgroundCommands?.[0]?.stop?.status === 'uncertain') break;
    assert.ok(Date.now() < limit); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(restored.backgroundCommands![0].status, 'unknown'); assert.equal(restored.result, 'First answer');
  const wire = (await readFile(join(cwd, 'background-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(wire.filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
  assert.equal(wire.filter(value => value.method === 'turn/start').length, 1);
  assert.equal((await readFile(join(cwd, 'background-launches'), 'utf8')).trim().split('\n').length, 1);
});

test('A terminal item arriving before the stop response does not close its pending control RPC', async t => {
  const f = await fixture(t); const task = await f.start(); const background = task.backgroundCommands![0]; await f.marker('delay-stop-response');
  await f.engine.backgroundCommands.stop(task.id, background.id, background.sessionId, 'delayed-response');
  const stopped = await f.wait(task => task.backgroundCommands?.[0]?.stop?.status === 'completed');
  assert.notEqual(stopped.backgroundCommands![0].status, 'running'); assert.equal(stopped.result, 'First answer');
  assert.equal((await f.wire()).filter(value => value.method === 'thread/backgroundTerminals/terminate').length, 1);
});

test('Service shutdown drains a retained command while its following model turn is still active', async t => {
  const f = await fixture(t); const task = await f.start(); const pid = Number(await readFile(join(f.cwd, 'background-pid'), 'utf8'));
  await f.engine.createTask({ continueId: task.id, projectId: 'project', agent: 'codex', mode: 'research', prompt: 'Second owned turn', requestId: 'second' });
  await f.wait(task => task.status === 'running' && task.turnId === 'turn-2');
  await f.engine.close(); await f.reopen();
  const restored = await f.task(); assert.equal(restored.backgroundCommands![0].status, 'unknown');
  assert.equal((await f.wire()).filter(value => value.method === 'turn/start').length, 2, 'Shutdown does not replay either external run');
  const deadline = Date.now() + 3_000;
  while (true) { try { process.kill(pid, 0); } catch { break; } assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
});

test('Forked history cannot inherit live command ownership, while the original background command keeps running', async t => {
  const f = await fixture(t, () => new class extends CodexExecutor {
    constructor() { super(command); }
    async fork(request: NativeForkRequest) { return { threadId: 'forked-thread', turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, 'forked-' + id])), headIds: {} }; }
  }());
  const source = await f.start(); const background = source.backgroundCommands![0];
  const childId = await f.engine.taskForks.start(source.id, { requestId: 'fork-background', runId: source.currentRunId! });
  const deadline = Date.now() + 5_000; let child: WorkItem;
  while (true) {
    child = (await f.engine.snapshot()).tasks.find(work => work.id === childId)!;
    if (child.forkOperation?.status === 'completed') break;
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(child.backgroundCommands, undefined); assert.equal(child.executionSessionId, undefined);
  const history = await f.engine.taskHistory.events(child); const copied = history.find(event => event.kind === 'command');
  assert.ok(copied); assert.equal(copied.status, 'interrupted');
  assert.equal((await f.task()).backgroundCommands![0].status, 'running');
  await f.marker('finish-background'); await f.wait(task => task.backgroundCommands?.[0]?.status === 'completed');
  assert.equal((await f.engine.taskHistory.eventItems(source.id, [background.id])).events[0].status, 'completed');
});

test('Settled Stop terminates Codex background work through its native identity and keeps the completed model result', async t => {
  const f = await fixture(t); const first = await f.start(); const command = first.backgroundCommands![0];
  const path = `/api/tasks/${first.id}/background/settle`; const body = { sessionId: command.sessionId, runId: first.currentRunId, requestId: 'codex-group-stop' };
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  const done = await f.wait(task => task.backgroundStop?.status === 'completed');
  assert.equal(done.status, 'completed'); assert.equal(done.result, 'First answer'); assert.equal(done.updatedAt, first.updatedAt);
  assert.ok(!['running', 'unknown'].includes(done.backgroundCommands![0].status)); assert.equal(done.backgroundActivity?.commands, 0);
  assert.equal((await f.wire()).filter(entry => entry.method === 'thread/backgroundTerminals/list').length, 1);
  assert.equal((await f.wire()).filter(entry => entry.method === 'thread/backgroundTerminals/terminate').length, 1);
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).status, 202);
  await f.reopen(); assert.equal((await f.task()).backgroundStop?.status, 'completed'); assert.equal((await f.wire()).filter(entry => entry.method === 'turn/start').length, 1);
});

test('A failed Codex Stop preserves uncertainty and a later metadata reconciliation never repeats termination', async t => {
  const f = await fixture(t); const first = await f.start(); await f.marker('lose-stop-receipt');
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'uncertain-group');
  await f.wait(task => task.backgroundStop?.status === 'uncertain' && task.backgroundCommands![0].status === 'unknown');
  await f.reopen(); await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'reconcile-group');
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.backgroundCommands![0].status, 'interrupted'); assert.equal(done.result, 'First answer');
  const wire = await f.wire(); assert.equal(wire.filter(entry => entry.method === 'thread/backgroundTerminals/terminate').length, 1); assert.equal(wire.filter(entry => entry.method === 'turn/start').length, 1);
});

test('No-owner Codex Stop reconciles more than one history lookup page without launching a process', async t => {
  const f = await fixture(t); const first = await f.start(); await f.marker('exit-background-process'); await f.wait(task => task.backgroundCommands![0].status === 'unknown'); await f.reopen();
  const original = (await f.engine.taskHistory.eventItems(first.id, [first.backgroundCommands![0].id])).events[0];
  await f.engine.patchTask(first.id, task => {
    for (let index = 0; index < 130; index++) {
      const id = 'orphan-command-' + index;
      task.backgroundCommands!.push({ ...task.backgroundCommands![0], id, itemId: id });
      const event = { ...original, id, itemId: id, status: 'interrupted' as const }; delete event.historyOrder; delete event.historyDigest;
      task.events.push(event);
    }
  });
  await f.engine.backgroundStops.start(first.id, first.executionSessionId!, 'many-orphans');
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.backgroundCommands!.length, 131); assert.ok(done.backgroundCommands!.every(command => command.status === 'interrupted'));
  assert.equal((await f.wire()).filter(entry => entry.method === 'thread/backgroundTerminals/terminate').length, 0); assert.equal((await f.wire()).filter(entry => entry.method === 'turn/start').length, 1);
});

test('Settled Stop adopts an existing terminal-control receipt rather than terminating the same command twice', async t => {
  const f = await fixture(t); const first = await f.start(); const command = first.backgroundCommands![0]; await f.marker('delay-stop-response');
  await f.engine.backgroundCommands.stop(first.id, command.id, command.sessionId, 'individual-stop');
  await f.wait(task => task.backgroundCommands![0].status === 'failed' && task.backgroundCommands![0].stop?.status === 'pending');
  await f.engine.backgroundStops.start(first.id, command.sessionId, 'adopt-stop');
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.backgroundCommands![0].stop?.status, 'completed');
  assert.equal((await f.wire()).filter(entry => entry.method === 'thread/backgroundTerminals/terminate').length, 1);
});
