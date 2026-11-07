import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defaultPiSettings } from '../src/pi-provider.js';
import { backgroundCommandActivity } from '../src/task-background-commands.js';
import type { WorkItem } from '../src/types.js';

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (matches(value)) return value; assert.ok(Date.now() < deadline, 'Pi background fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-pi-background-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), home = join(root, 'pi'), wire = join(root, 'wire.jsonl');
  await mkdir(cwd); const binaryPath = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url)); await chmod(binaryPath, 0o755);
  const open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open(); let engine: Engine | undefined = await open(), id = '';
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  await engine.piConnection.save({ ...defaultPiSettings, enabled: true, binaryPath, homePath: home, environment: [{ name: 'PI_TEST_WIRE', value: wire }, { name: 'PI_TEST_BOOTSTRAP_MCP', value: '1' }] });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Pi background', path: cwd, context: '' }]; });
  const task = async () => (await engine!.snapshot()).tasks.find(task => task.id === id)!;
  const wait = (matches: (task: WorkItem) => boolean) => until(task, task => !!task && matches(task));
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, current: () => engine!, task, wait, trace, wake: () => writeFile(join(home, 'emit-wake'), 'wake'),
    start: async (prompt = 'background') => { id = await engine!.createTask({ projectId: 'project', title: 'Pi background', agent: 'pi', mode: 'code', prompt, requestId: 'first' }); return wait(task => ['completed', 'failed'].includes(task.status)); },
    reopen: async () => { await engine!.close(); engine = undefined; engine = await open(); return engine; } };
}
test('Pi unsolicited agent_start becomes a durable native reply on the retained process without another prompt or human message', async t => {
  const f = await fixture(t), first = await f.start(); assert.equal(first.status, 'completed', first.error ?? ''); await f.wake();
  const task = await f.wait(task => task.status === 'completed' && task.result === 'Pi native wake result');
  const receipt = Object.values((await f.current().snapshot()).nativeTurnRequests ?? {})[0]!;
  assert.equal(receipt.provider, 'pi'); assert.equal(receipt.providerInstanceId, 'pi'); assert.equal(receipt.status, 'completed');
  assert.equal(task.executionSessionId, first.executionSessionId); assert.equal(task.threadId, first.threadId); assert.equal(task.runs!.length, 2);
  assert.equal(task.messages!.filter(message => message.role === 'user').length, 1); assert.equal(task.messages!.filter(message => message.role === 'assistant').length, 2);
  assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
  assert.equal(new Set((await f.trace()).filter(value => value.type === 'prompt' || value.nativeWake).map(value => value.pid)).size, 1);
  const bootstrap = (await f.trace()).find(value => value.bootstrapCatalog); assert.equal(bootstrap.bootstrapCatalog.status, 200); assert.ok(bootstrap.bootstrapCatalog.body.result.tools.length > 0);
  assert.equal(bootstrap.bootstrapAction.body.result.isError, true, 'The static catalog is available before discovery, while task data and actions remain fenced');
});
test('Pi native wake MCP calls wait for their persisted run, then an explicit human continuation reuses the native connection and tool credential safely', async t => {
  const f = await fixture(t), first = await f.start('background mcp'), engine = f.current(); assert.equal(first.status, 'completed', first.error ?? '');
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const update = engine.nativeTurns.update.bind(engine.nativeTurns); engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  try { await f.wake(); await entering; assert.ok(!(await f.trace()).some(value => value.wakeMcp)); }
  finally { release(); }
  await f.wait(task => task.status === 'completed' && task.result === 'Pi native wake result');
  const call = (await f.trace()).find(value => value.wakeMcp).wakeMcp; assert.equal(call.status, 200); assert.equal(call.body.result.isError, false);
  await engine.createTask({ continueId: first.id, projectId: 'project', title: 'Pi continuation', agent: 'pi', mode: 'code', prompt: 'reply', requestId: 'human-follow-up' });
  const done = await f.wait(task => task.status === 'completed' && task.result.includes('Pi reply')); assert.equal(done.executionSessionId, first.executionSessionId);
  const records = await f.trace(); assert.equal(records.filter(value => value.type === 'prompt').length, 2); assert.equal(new Set(records.filter(value => value.type === 'prompt').map(value => value.pid)).size, 1);
});
test('Pi native wake approvals retain native question identity and resolve in the observation without another external start', async t => {
  const f = await fixture(t), first = await f.start('background approval'); await f.wake();
  const pending = await f.wait(task => task.status === 'waiting' && task.approvals.some(approval => approval.state === 'pending'));
  const approval = pending.approvals.find(approval => approval.state === 'pending')!; await f.current().answer(first.id, approval.id, 'accept', {}, 'native-pi-approval');
  const done = await f.wait(task => task.status === 'completed' && task.result === 'Approved native reply'); assert.equal(done.approvals.find(value => value.id === approval.id)!.state, 'answered');
  assert.equal((await f.trace()).filter(value => value.type === 'extension_ui_response').length, 1); assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
});
test('A recorded Stop intent prevents a native wake permission from being forwarded before its abort callback runs', async t => {
  const f = await fixture(t), first = await f.start('background approval'); await f.wake();
  const task = await f.wait(task => task.status === 'waiting' && task.approvals.some(approval => approval.state === 'pending'));
  await f.current().taskQueue.pause(first.id, { runId: task.currentRunId!, sessionId: task.executionSessionId! });
  const approval = task.approvals.find(approval => approval.state === 'pending')!;
  await assert.rejects(f.current().answer(first.id, approval.id, 'accept', {}, 'after-stop'), /过期/);
  assert.equal((await f.trace()).filter(value => value.type === 'extension_ui_response').length, 0);
  await f.current().cancel(first.id, { runId: task.currentRunId!, sessionId: task.executionSessionId! });
});
test('Pi locally invalid choices leave no uncertain command and a corrected answer can reuse the same request ID', async t => {
  const f = await fixture(t), completion = f.start('question');
  const task = await f.wait(task => task.status === 'waiting'), approval = task.approvals.find(value => value.state === 'pending')!, question = approval.questions[0]!;
  await assert.rejects(f.current().answer(task.id, approval.id, 'accept', { [question.id]: ['Missing'] }, 'correctable-answer'), /选项已失效/);
  assert.equal((await f.task()).approvals.find(value => value.id === approval.id)!.responseStatus, undefined);
  assert.equal((await f.current().snapshot()).approvalResponses?.['correctable-answer'], undefined);
  assert.equal((await f.trace()).filter(value => value.type === 'extension_ui_response').length, 0);
  await f.current().answer(task.id, approval.id, 'accept', { [question.id]: ['Two'] }, 'correctable-answer');
  assert.equal((await completion).status, 'completed');
  const responses = (await f.trace()).filter(value => value.type === 'extension_ui_response'); assert.equal(responses.length, 1); assert.equal(responses[0]!.value, 'Two');
});
test('Pi Stop closes a native wake and its actual child process; restart retains the interrupted observation without replay', async t => {
  const f = await fixture(t), first = await f.start('background hold-wake'); await f.wake();
  const active = await f.wait(task => task.status === 'running' && task.result === 'Pi native pending'), child = (await f.trace()).find(value => value.wakeChild).wakeChild;
  await f.current().cancel(first.id, { runId: active.currentRunId!, sessionId: active.executionSessionId! });
  const ended = await f.wait(task => ['interrupted', 'cancelled'].includes(task.status)); assert.equal(ended.result, 'Pi native pending');
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  await f.reopen(); const restored = await f.task(); assert.equal(restored.currentRunId, ended.currentRunId); assert.equal(restored.result, 'Pi native pending');
  assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
});
test('Pi close during native identity persistence leaves an interrupted receipt and cannot release the waiting MCP action', async t => {
  const f = await fixture(t), first = await f.start('background mcp'), engine = f.current();
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const update = engine.nativeTurns.update.bind(engine.nativeTurns); engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  await f.wake(); await entering; const closing = engine.executor.stopNativeSession!(first.id, first.executionSessionId!); release(); await closing;
  await f.wait(task => task.status === 'interrupted');
  assert.equal(Object.values((await engine.snapshot()).nativeTurnRequests ?? {})[0]!.status, 'interrupted');
  assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
});
test('Pi settled Stop reconciles an unfinished native child and terminates its actual owned process without restarting the CLI', async t => {
  const f = await fixture(t), first = await f.start('children-unfinished'); assert.equal(first.status, 'completed', first.error ?? '');
  assert.equal(first.subagents![0]!.status, 'unknown'); assert.equal(backgroundCommandActivity(first).canStop, true); assert.equal(backgroundCommandActivity(first).unknownTasks, 1);
  await assert.rejects(f.current().providerInstances.change({ operation: 'upsert', instanceId: 'pi', instance: { driver: 'pi', displayName: 'Pi', enabled: false } }), /停止/);
  const auth = new Auth(f.directory); t.after(() => auth.close()); const api = createAPI(f.current(), auth, () => []);
  assert.equal((await api.request('/api/agents/pi/settings', { method: 'PUT', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: '{}' })).status, 409);
  const child = (await f.trace()).find(value => value.unfinishedChild).unfinishedChild;
  await f.current().cancel(first.id, { runId: first.currentRunId!, sessionId: first.executionSessionId! });
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.subagents![0]!.status, 'interrupted'); assert.equal(done.result, first.result);
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
  assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
});
test('Pi disabling its configuration while a wake is being admitted prevents the old native MCP credential from acting', async t => {
  const f = await fixture(t), first = await f.start('background mcp'), engine = f.current();
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const update = engine.nativeTurns.update.bind(engine.nativeTurns); engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  try { await f.wake(); await entering; const settings = (await engine.piConnection.status(true)).settings!; await engine.piConnection.save({ ...settings, enabled: false }); }
  finally { release(); }
  await f.wait(task => task.status === 'interrupted');
  assert.ok(!(await f.trace()).some(value => value.wakeMcp?.body?.result?.isError === false));
  assert.equal((await f.trace()).filter(value => value.type === 'prompt').length, 1);
});
