import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import { backgroundCommandActivity } from '../src/task-background-commands.js';
import type { WorkItem } from '../src/types.js';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (matches(value)) return value; assert.ok(Date.now() < deadline, 'Muse background fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-muse-background-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), home = join(root, 'muse'), wire = join(root, 'wire.jsonl');
  await mkdir(cwd); const binaryPath = fileURLToPath(new URL('./fixtures/muse.mjs', import.meta.url)); await chmod(binaryPath, 0o755);
  const open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  let engine: Engine | undefined = await open(), id = '';
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  await engine.museConnection.save({ ...nativeProviderDefaults('muse'), enabled: true, binaryPath, environment: [{ name: 'MUSE_TEST_HOME', value: home }, { name: 'MUSE_TEST_WIRE', value: wire }] });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Muse background', path: cwd, context: '' }]; });
  const task = async () => (await engine!.snapshot()).tasks.find(task => task.id === id)!;
  const wait = (matches: (task: WorkItem) => boolean) => until(task, task => !!task && matches(task));
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, current: () => engine!, task, wait, trace, wake: () => writeFile(join(home, 'emit-wake'), 'wake'),
    start: async (prompt = 'background') => { id = await engine!.createTask({ projectId: 'project', title: 'Muse background', agent: 'muse', mode: 'code', prompt, requestId: 'first' }); return id; },
    reopen: async () => { await engine!.close(); engine = undefined; engine = await open(); return engine; } };
}
test('Muse local question validation permits correcting a selection without claiming or forwarding the invalid answer', async t => {
  const f = await fixture(t), id = await f.start('question-two');
  const task = await f.wait(task => task.status === 'waiting'), approval = task.approvals.find(value => value.state === 'pending')!;
  await assert.rejects(f.current().answer(id, approval.id, 'accept', { target: ['One'] }, 'correctable-answer'), /选项数量/);
  assert.equal((await f.task()).approvals.find(value => value.id === approval.id)!.responseStatus, undefined);
  assert.equal((await f.current().snapshot()).approvalResponses?.['correctable-answer'], undefined);
  assert.equal((await f.trace()).filter(value => value.method === 'userInput/answer').length, 0);
  await f.current().answer(id, approval.id, 'accept', { target: ['One', 'Two'] }, 'correctable-answer');
  await f.wait(task => task.status === 'completed');
  const responses = (await f.trace()).filter(value => value.method === 'userInput/answer'); assert.equal(responses.length, 1); assert.deepEqual(responses[0]!.params.answers[0].selectedLabels, ['One', 'Two']);
});
test('Muse native wake in the same wire batch as the parent result waits for Durable finalization, persists a separate reply and never sends another prompt', async t => {
  const f = await fixture(t); await f.start('background immediate-wake');
  const task = await f.wait(task => task.status === 'completed' && task.messages?.filter(message => message.role === 'assistant').length === 2);
  const replies = task.messages!.filter(message => message.role === 'assistant'); assert.equal(replies[1]!.text, 'Native wake after background');
  assert.equal(task.runs!.length, 2); assert.notEqual(replies[0]!.runId, replies[1]!.runId);
  const receipt = Object.values((await f.current().snapshot()).nativeTurnRequests ?? {})[0]!;
  assert.equal(receipt.provider, 'muse'); assert.equal(receipt.providerInstanceId, 'muse'); assert.equal(receipt.status, 'completed'); assert.equal(receipt.turnId, (await f.trace()).find(value => value.nativeWake).nativeWake);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
  assert.equal(task.nativeBackgroundWork![0]!.status, 'completed'); assert.equal(task.subagents!.length, 2); assert.ok(task.subagents!.every(child => child.status === 'completed'));
  const workflow = task.events.find(event => event.itemId === 'native-workflow'); assert.equal(workflow?.status, 'completed'); assert.equal(workflow?.detail, 'Workflow complete');
});
test('Muse consecutive native wakes in one wire batch are admitted in order and the later reply owns the current result', async t => {
  const f = await fixture(t); await f.start('background twice immediate-wake');
  const task = await f.wait(task => task.status === 'completed' && task.messages?.filter(message => message.role === 'assistant').length === 3);
  assert.equal(task.result, 'Second native wake answer'); assert.equal(task.runs!.length, 3);
  assert.deepEqual(task.messages!.filter(message => message.role === 'assistant').map(message => message.text), ['Muse reply café\u2028line\u2029end', 'Native wake after background', 'Second native wake answer']);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('A later native wake waits for the previous Durable run to finish after its wire result is already saved', async t => {
  const f = await fixture(t), engine = f.current(), finish = engine.taskRuns.finish.bind(engine.taskRuns);
  let entered!: () => void, release!: () => void, held = false; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.taskRuns.finish = async (...args) => { if (!held && args[1].startsWith('native:')) { held = true; entered(); await gate; } await finish(...args); };
  await f.start('background twice immediate-wake');
  try { await entering; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(Object.values((await engine.snapshot()).nativeTurnRequests ?? {}).length, 1); }
  finally { release(); }
  const done = await f.wait(task => task.status === 'completed' && task.messages?.filter(value => value.role === 'assistant').length === 3);
  assert.equal(done.result, 'Second native wake answer'); assert.equal(done.currentRunId, done.runs!.at(-1)!.id);
});
test('Durable admission preserves consecutive native wakes when the transport omits its optional finalizer', async t => {
  const f = await fixture(t), engine = f.current(), run = engine.executor.run.bind(engine.executor), finish = engine.taskRuns.finish.bind(engine.taskRuns);
  engine.executor.run = request => run({ ...request, nativeTurnFinalized: undefined });
  let entered!: () => void, release!: () => void, held = false;
  const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.taskRuns.finish = async (...args) => { if (!held && args[1].startsWith('native:')) { held = true; entered(); await gate; } await finish(...args); };
  await f.start('background twice immediate-wake');
  try { await entering; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(Object.values((await engine.snapshot()).nativeTurnRequests ?? {}).length, 1); }
  finally { release(); }
  const done = await f.wait(task => task.status === 'completed' && task.messages?.filter(value => value.role === 'assistant').length === 3);
  assert.equal(done.result, 'Second native wake answer'); assert.equal(done.currentRunId, done.runs!.at(-1)!.id);
});
test('Muse child approval after the parent completed stays attached to the original child and resolves before the native wake', async t => {
  const f = await fixture(t); const id = await f.start('background child-approval');
  const parent = await f.wait(task => task.status === 'completed'); assert.equal(backgroundCommandActivity(parent).backgroundTasks, 1); assert.equal(backgroundCommandActivity(parent).subagents, 2);
  const runningWorkflow = parent.events.find(event => event.itemId === 'native-workflow'); assert.equal(runningWorkflow?.status, 'running');
  await f.wake(); const pending = await f.wait(task => task.approvals.some(approval => approval.state === 'pending'));
  const approval = pending.approvals.find(approval => approval.state === 'pending')!;
  assert.ok(approval.subagentId); assert.equal(approval.ownerRunId, parent.currentRunId); assert.equal(pending.status, 'completed');
  await f.current().answer(id, approval.id, 'accept', {}, 'late-child-response');
  const done = await f.wait(task => task.result === 'Native wake after background' && task.status === 'completed');
  assert.equal(done.approvals.find(value => value.id === approval.id)!.state, 'answered');
  assert.equal((await f.trace()).filter(value => value.method === 'approval/decide').length, 1);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse workflow attempts keep one child identity, expose failed completed attempts and accept a genuine later generation', async t => {
  const f = await fixture(t); await f.start('background retry immediate-wake');
  const task = await f.wait(task => task.result === 'Native wake after background' && task.status === 'completed');
  const child = task.subagents!.find(child => child.nativeId.includes(':agent:workflow-child'))!;
  assert.equal(child.generation, 2); assert.equal(child.status, 'completed'); assert.equal(child.result, undefined); assert.equal(child.title, 'Workflow reviewer');
  const conversation = (await f.current().snapshot()).tasks.find(task => task.id === child.childTaskId)!;
  assert.equal(conversation.result, '');
  assert.ok(conversation.messages!.some(message => message.role === 'assistant' && message.text === 'timeout'));
  assert.equal(task.subagents!.filter(child => child.nativeId.includes(':agent:workflow-child')).length, 1);
});
test('Muse Stop while a late child approval is pending expires it and closes owned background work', async t => {
  const f = await fixture(t); const id = await f.start('background child-approval'); await f.wait(task => task.status === 'completed'); await f.wake();
  const pending = await f.wait(task => task.approvals.some(approval => approval.state === 'pending'));
  await f.current().cancel(id, { runId: pending.currentRunId!, sessionId: pending.executionSessionId! });
  const ended = await f.task(); assert.ok(ended.approvals.every(approval => approval.state !== 'pending')); assert.equal(ended.backgroundStop?.status, 'completed');
  assert.equal((await f.trace()).filter(value => value.method === 'approval/decide').length, 0);
});
test('Muse child approval received beside the parent terminal survives parent finalization until its native child is answered', async t => {
  const f = await fixture(t); const id = await f.start('background early-approval');
  const task = await f.wait(task => task.status === 'completed' && task.approvals.some(approval => approval.state === 'pending'));
  const approval = task.approvals.find(approval => approval.state === 'pending')!; assert.ok(approval.subagentId); assert.equal(task.subagents!.find(child => child.id === approval.subagentId)!.status, 'waiting');
  await f.current().answer(id, approval.id, 'accept', {}, 'early-child-approval');
  const done = await f.wait(task => task.status === 'completed' && task.result === 'Native wake after background'); assert.equal(done.approvals.find(value => value.id === approval.id)!.state, 'answered');
  assert.equal((await f.trace()).filter(value => value.method === 'approval/decide').length, 1); assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse settled Stop closes the owning host and real child, and late workflow rows do not offer unsupported individual Stop', async t => {
  const f = await fixture(t); const id = await f.start('background hold'); const task = await f.wait(task => task.status === 'completed');
  const work = task.nativeBackgroundWork![0]!; assert.equal(work.canStop, false); assert.equal(backgroundCommandActivity(task).canStop, true);
  await assert.rejects(f.current().nativeBackground.stop(id, work.id, work.transportId, 'unsupported-row-stop'), /不可停止/);
  const child = (await f.trace()).find(value => value.backgroundChild).backgroundChild;
  await f.current().cancel(id, { runId: task.currentRunId!, sessionId: task.executionSessionId! });
  const stopped = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(stopped.nativeBackgroundWork![0]!.status, 'interrupted'); assert.equal(stopped.result, task.result);
  assert.ok(stopped.subagents!.every(child => child.status === 'interrupted'));
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse retained background work prevents disabling its exact instance or replacing credentials until it is stopped', async t => {
  const f = await fixture(t), engine = f.current(); const id = await f.start('background hold'); const task = await f.wait(task => task.status === 'completed');
  const auth = new Auth(f.directory); t.after(() => auth.close()); const api = createAPI(engine, auth, () => []), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await api.request('/api/agents/muse/settings', { method: 'PUT', headers, body: '{}' })).status, 409);
  const change = { operation: 'upsert', instanceId: 'muse', instance: { driver: 'muse', displayName: 'Muse', enabled: false } };
  await assert.rejects(engine.providerInstances.change(change), /停止/);
  await engine.cancel(id, { runId: task.currentRunId!, sessionId: task.executionSessionId! });
  await engine.providerInstances.change(change); assert.equal((await engine.providerInstances.list()).find(value => value.instanceId === 'muse')!.enabled, false);
});
test('Muse deleting a settled task closes owned workflow work before removing its child conversations', async t => {
  const f = await fixture(t); const id = await f.start('background hold'); await f.wait(task => task.status === 'completed');
  const child = (await f.trace()).find(value => value.backgroundChild).backgroundChild;
  await f.current().deleteTask(id); assert.equal((await f.current().snapshot()).tasks.length, 0);
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse stopping an observed native turn targets the native ID, then a service restart preserves it without replay', async t => {
  const f = await fixture(t); const id = await f.start('background hold-wake'); await f.wait(task => task.status === 'completed'); await f.wake();
  const active = await f.wait(task => task.result === 'Native wake' && task.status === 'running'); const native = (await f.trace()).find(value => value.nativeWake).nativeWake;
  await f.current().cancel(id, { runId: active.currentRunId!, sessionId: active.executionSessionId! });
  const ended = await f.wait(task => ['cancelled', 'interrupted'].includes(task.status));
  assert.ok((await f.trace()).some(value => value.interrupted === native));
  const child = (await f.trace()).find(value => value.backgroundChild).backgroundChild;
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  await f.reopen(); const saved = await f.task(); assert.equal(saved.currentRunId, ended.currentRunId); assert.equal(saved.messages!.filter(message => message.role === 'user').length, 1);
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse native turns that join an active prompt finish inside its existing Durable run and Stop interrupts both native IDs', async t => {
  const f = await fixture(t); await f.start('joined'); const completed = await f.wait(task => task.status === 'completed');
  assert.equal(completed.result, 'Joined native response'); assert.equal(completed.runs!.length, 1); assert.equal(Object.values((await f.current().snapshot()).nativeTurnRequests ?? {}).length, 0);
  const id = await f.current().createTask({ projectId: 'project', title: 'Joined hold', agent: 'muse', mode: 'code', prompt: 'joined-hold', requestId: 'hold' });
  await until(f.trace, values => values.some(value => value.prompt === 'joined-hold'));
  await f.current().cancel(id); const records = await f.trace(), native = records.find(value => value.prompt === 'joined-hold').turnId;
  assert.ok(records.some(value => value.interrupted === native)); assert.ok(records.some(value => value.interrupted === 'native-joined-' + native));
});
test('Muse unsolicited work rejects a foreign provider instance and thread before creating a Durable receipt', async t => {
  const f = await fixture(t); const id = await f.start(); const task = await f.wait(task => task.status === 'completed');
  const value = { kind: 'nativeTurnStart' as const, provider: 'muse' as const, providerInstanceId: 'muse', sessionId: task.executionSessionId!, threadId: task.threadId!, key: 'foreign-wake', turnId: 'foreign-native-turn', parameters: { cwd: task.cwd, mode: task.mode } };
  for (const changes of [{ providerInstanceId: 'claude' }, { threadId: 'other-thread' }, { sessionId: 'other-transport' }]) await assert.rejects(f.current().nativeTurns.update(id, { ...value, ...changes }));
  assert.equal(Object.values((await f.current().snapshot()).nativeTurnRequests ?? {}).length, 0);
});
test('Muse closing while a native wake identity is being persisted leaves an interrupted receipt and does not replay the turn', async t => {
  const f = await fixture(t), engine = f.current(), update = engine.nativeTurns.update.bind(engine.nativeTurns);
  let began!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { began = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { began(); await gate; } await update(id, value); };
  const id = await f.start('background immediate-wake'); await entering;
  const task = await f.task(), closing = engine.executor.stopNativeSession!(id, task.executionSessionId!); release(); await closing;
  const ended = await f.wait(task => task.status === 'interrupted'); assert.ok(ended.messages!.some(message => message.role === 'assistant' && message.text.startsWith('Muse reply')));
  const receipt = Object.values((await engine.snapshot()).nativeTurnRequests ?? {})[0]!; assert.equal(receipt.status, 'interrupted');
  assert.equal((await f.trace()).filter(value => value.method === 'turn/start').length, 1);
});
test('Muse retained MCP waits for native admission, reads the new run instead of an old cached request, and revokes its credential when the host closes', async t => {
  const f = await fixture(t), engine = f.current(); const id = await f.start('background mcp'); const parent = await f.wait(task => task.status === 'completed');
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const update = engine.nativeTurns.update.bind(engine.nativeTurns);
  engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  await engine.mutate(state => { state.tasks.find(task => task.id === id)!.changeRequests = [{ number: 42, url: 'https://github.com/fixture/repo/pull/42', title: 'Native wake link', state: 'open', base: 'main', head: 'feature', repository: 'fixture/repo', host: 'github.com' }]; });
  try {
    await f.wake(); await entering;
    assert.ok(!(await f.trace()).some(value => value.phase === 'wake'), 'No tool call is accepted before its native run has been persisted');
  } finally { release(); }
  await f.wait(task => task.status === 'completed' && task.result === 'Native wake after background');
  const trace = await f.trace(), foreground = trace.find(value => value.phase === 'foreground'), wake = trace.find(value => value.phase === 'wake');
  assert.equal(foreground.mcpStatus, 200); assert.equal(wake.mcpStatus, 200); assert.equal(wake.mcpBody.result.isError, false);
  assert.equal(JSON.parse(foreground.mcpBody.result.content[0].text).pullRequests.length, 0); assert.equal(JSON.parse(wake.mcpBody.result.content[0].text).pullRequests[0].number, 42);
  const mcp = trace.find(value => value.method === 'session/start').params.config.mcpServers.friday;
  await engine.executor.stopNativeSession!(id, parent.executionSessionId!);
  const denied = await fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }) }); assert.equal(denied.status, 401);
  assert.equal(trace.filter(value => value.method === 'turn/start').length, 1);
});
test('Closing the task tool server cancels native MCP admission waits before a pending turn persistence gate is released', async t => {
  const f = await fixture(t), engine = f.current(); await f.start('background mcp'); await f.wait(task => task.status === 'completed');
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const update = engine.nativeTurns.update.bind(engine.nativeTurns); engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  let timer: NodeJS.Timeout | undefined;
  try {
    await f.wake(); await entering;
    await Promise.race([engine.runtimeTools.close(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Task tool server did not cancel pending admission')), 2000); })]);
  } finally { clearTimeout(timer); release(); }
});
