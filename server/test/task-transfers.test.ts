import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, NativeForkRequest, Workspace } from '../src/types.js';
import { selectHistory, historyCost, type HistoricalMessage } from '../src/vendor/t3-handoff-budget.mjs';
import { providerDrivers } from '../src/provider-instances.js';

class TransferExecutor implements Executor {
  requests: ExecutionRequest[] = []; stops: { id: string; session: string }[] = []; forks = 0; block = false; loseClose = false;
  sessions = new Map<string,string>();
  loseFork = false; blockFork = false;
  async run(request: ExecutionRequest) {
    this.requests.push(request); const number = this.requests.length;
    const thread = request.task.threadId ?? request.task.agent + '-thread-' + number, session = request.task.agent + '-session-' + number;
    this.sessions.set(request.task.id, session);
    await request.update({ kind: 'session', threadId: thread, executionSessionId: session });
    await request.update({ kind: 'turn', turnId: 'turn-' + number }); await request.update({ kind: 'ready', canSteer: true });
    if (this.block) await new Promise<void>((_, reject) => { request.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }); if (request.signal.aborted) reject(new Error('Stopped')); });
    return 'Answer ' + request.task.agent + ' ' + number;
  }
  async fork(request: NativeForkRequest) {
    if (request.inspectOnly && request.candidateId) return { threadId: request.candidateId, turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, 'fork-' + this.forks + '-' + id])), headIds: {} };
    this.forks++; const threadId = 'fork-thread-' + this.forks; await request.started(); await request.candidate(threadId);
    if (this.loseFork) { this.loseFork = false; throw new Error('Lost native fork reply'); }
    if (this.blockFork) await new Promise<void>((_, reject) => { request.signal.addEventListener('abort', () => reject(new Error('Fork stopped')), { once: true }); if (request.signal.aborted) reject(new Error('Fork stopped')); });
    return { threadId, turnIds: Object.fromEntries(request.expectedTurns.map(id => [id, 'fork-' + this.forks + '-' + id])), headIds: {} };
  }
  hasSession(id: string) { return this.sessions.has(id); }
  async stopNativeSession(id: string, session: string) { this.stops.push({ id, session }); if (this.sessions.get(id) === session) this.sessions.delete(id); if (this.loseClose) { this.loseClose = false; throw new Error('Lost native close reply'); } }
  async answer() {} async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Transfer fixture timed out');
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'friday-transfer-'))), cwd = join(root, 'project'), data = join(root, 'data'); await mkdir(cwd);
  const executor = new TransferExecutor(); let engine = await new Engine(data, executor).open(); const auth = new Auth(data);
  t.after(async () => { auth.close(); await engine.close(); await rm(root, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', path: cwd, name: 'Fixture', context: '' }));
  const task = async (id: string) => (await engine.snapshot()).tasks.find(task => task.id === id)!;
  const turn = async (id: string | undefined, prompt: string, requestId: string) => {
    const target = await engine.createTask({ continueId: id, prompt, requestId, projectId: 'project', agent: 'codex', mode: 'code' });
    const state = await until(engine, state => state.tasks.find(task => task.id === target)?.status === 'completed');
    await engine.harness.waitForTask(state.tasks.find(task => task.id === target)!.durableId as TaskId, BACKGROUND_CONTEXT); return target;
  };
  const reopen = async () => { await engine.close(); engine = await new Engine(data, executor).open(); return engine; };
  return { get engine() { return engine; }, executor, task, turn, reopen, auth, api: () => createAPI(engine, auth, () => []), headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' } };
}
const target = (agent: 'claude' | 'pi' | 'codex') => ({ agent, providerInstanceId: agent, model: 'fixture-model', interactionMode: 'default' as const });

test('Provider handoff retains the app conversation and historical provenance, defers provider work, and consumes its immutable source point once', async t => {
  const f = await fixture(t), id = await f.turn(undefined, 'original user request', 'original'); const old = await f.task(id);
  await f.engine.sessionActions.start(id, { requestId: 'switch-claude', kind: 'handoff', target: target('claude') });
  let work = await f.task(id); assert.equal(work.id, id); assert.equal(work.agent, 'claude'); assert.equal(work.threadId, null); assert.equal(work.sessionOperation?.status, 'completed'); assert.equal(f.executor.requests.length, 1);
  assert.deepEqual(f.executor.stops, [{ id, session: old.executionSessionId }]); assert.equal(work.providerHistory?.[0].threadId, old.threadId);
  assert.equal(work.runs?.[0].agent, 'codex'); assert.notEqual(work.providerEpoch, work.runs?.[0].providerEpoch);
  assert.equal(work.contextTransfers?.[0].status, 'pending'); assert.equal(work.messages?.length, old.messages?.length);
  await f.executor.requests[0].update({ kind: 'session', threadId: 'late-old-frame', executionSessionId: 'old-frame' }); assert.equal((await f.task(id)).threadId, null, 'A closed provider cannot regain current identity');
  await f.engine.sessionActions.start(id, { requestId: 'switch-claude', kind: 'handoff', target: target('claude') }); assert.equal(f.executor.stops.length, 1);
  await assert.rejects(f.engine.sessionActions.start(id, { requestId: 'switch-claude', kind: 'handoff', target: target('pi') }), /ID/);
  await f.engine.createTask({ continueId: id, prompt: 'new user request', requestId: 'continue-claude', projectId: 'project', mode: 'code' }); await until(f.engine, state => state.tasks.find(task => task.id === id)?.status === 'completed');
  const request = f.executor.requests[1]; assert.equal(request.task.id, id); assert.equal(request.task.agent, 'claude'); assert.equal(request.task.threadId, null);
  assert.match(request.prompt, /original user request/); assert.match(request.prompt, /Answer codex 1/); assert.match(request.prompt, /provider_handoff/); assert.match(request.prompt, /new user request/);
  assert.doesNotMatch(request.prompt, /Previous conversation/); work = await f.task(id); assert.equal(work.contextTransfers?.[0].status, 'consumed'); assert.deepEqual(work.runs?.at(-1)?.contextTransferIds, [work.contextTransfers![0].id]);
  assert.equal(work.runs?.at(-1)?.agent, 'claude');
  const options = await f.engine.taskRewinds.options(id, work.messages![0].id); assert.match(options.nativeReason!, /Agent 交接/);
  await assert.rejects(f.engine.taskRewinds.start(id, { requestId: 'bad-cross-rewind', messageId: work.messages![0].id, fingerprint: options.fingerprint, restoreFiles: false }), /Agent 交接/);
  const fork = await f.engine.taskForks.start(id, { requestId: 'old-provider-fork', runId: work.runs![0].id }); await until(f.engine, state => state.tasks.find(task => task.id === fork)?.forkOperation?.status === 'completed');
  assert.equal(f.executor.forks, 0, 'An old provider run cannot be forked using the new provider native identity');
  await f.engine.taskRewinds.start(id, { requestId: 'cross-rewind-new-session', messageId: work.messages![0].id, fingerprint: options.fingerprint, restoreFiles: false, newSession: true });
  await until(f.engine, state => state.tasks.find(task => task.id === id)?.rewindOperation?.status === 'completed');
  assert.equal((await f.task(id)).rewindOperation?.editor.model, 'fixture-model', 'Old-provider editing cannot install an incompatible model into the current provider');
});

test('Unknown native detach is not replayed after restart; explicit retry preserves the same source and never starts a model', async t => {
  const f = await fixture(t), id = await f.turn(undefined, 'source', 'detach-source'); f.executor.loseClose = true;
  await f.engine.sessionActions.start(id, { requestId: 'unknown-close', kind: 'handoff', target: target('pi') });
  assert.equal((await f.task(id)).agent, 'codex'); assert.equal((await f.task(id)).sessionOperation?.status, 'uncertain');
  await assert.rejects(f.engine.createTask({ continueId: id, projectId: 'project', prompt: 'blocked', requestId: 'blocked-close', mode: 'code' }), /会话操作/);
  await f.reopen(); assert.equal(f.executor.stops.length, 1); assert.equal(f.executor.requests.length, 1);
  await f.engine.sessionActions.retry(id, 'explicit-close-retry'); assert.equal((await f.task(id)).agent, 'pi'); assert.equal((await f.task(id)).sessionOperation?.status, 'completed'); assert.equal(f.executor.stops.length, 2); assert.equal(f.executor.requests.length, 1);
});

test('Handoff refuses queued work without closing the old session, and Disconnect cancels its active run without deleting native provenance', async t => {
  const f = await fixture(t), id = await f.turn(undefined, 'source', 'busy-source');
  await f.engine.taskQueue.pause(id); await f.engine.taskQueue.enqueue(id, { text: 'queued' }, 'queued-input');
  await assert.rejects(f.engine.sessionActions.start(id, { requestId: 'busy-switch', kind: 'handoff', target: target('claude') }), /空闲/); assert.equal(f.executor.stops.length, 0);
  await f.engine.taskQueue.remove(id, 'queued-input'); f.executor.block = true;
  await f.engine.createTask({ continueId: id, prompt: 'long run', requestId: 'long', projectId: 'project', mode: 'code' });
  await until(f.engine, state => state.tasks.find(task => task.id === id)?.canSteer === true); const old = await f.task(id);
  await f.engine.sessionActions.start(id, { requestId: 'disconnect-active', kind: 'disconnect' }); const stopped = await f.task(id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.threadId, old.threadId); assert.equal(stopped.sessionOperation?.status, 'completed'); assert.equal(stopped.nativeSessionConnected, false);
  assert.equal(stopped.agent, 'codex'); assert.equal(f.executor.requests.length, 2); assert.ok(stopped.messages?.some(message => message.text === 'long run'));
});

test('Merge back captures only a completed fork delta, records pending context without provider calls and delivers the captured version on the parent next message', async t => {
  const f = await fixture(t), parent = await f.turn(undefined, 'source-only request', 'parent');
  const fork = await f.engine.taskForks.start(parent, { requestId: 'fork-child', runId: (await f.task(parent)).runs![0].id });
  await until(f.engine, state => state.tasks.find(task => task.id === fork)?.forkOperation?.status === 'completed');
  await f.turn(fork, 'fork exploration result', 'fork-input'); const run = (await f.task(fork)).runs!.at(-1)!;
  const before = f.executor.requests.length, oldParent = await f.task(parent);
  assert.equal(await f.engine.transfers.mergeBack(fork, run.id, 'merge-child'), parent); assert.equal(f.executor.requests.length, before);
  assert.equal((await f.task(parent)).threadId, oldParent.threadId); const transfer = (await f.task(parent)).contextTransfers![0];
  assert.equal(transfer.status, 'pending'); const snapshot = await f.engine.contexts.read(transfer.reference.id, { taskId: parent });
  assert.match(snapshot.text, /fork exploration result/); assert.doesNotMatch(snapshot.text, /source-only request/);
  assert.equal(await f.engine.transfers.mergeBack(fork, run.id, 'merge-child'), parent); assert.equal((await f.task(parent)).contextTransfers?.length, 1);
  await f.turn(fork, 'later fork text must not bleed', 'fork-later');
  await f.turn(parent, 'continue the parent', 'parent-next'); const request = f.executor.requests.at(-1)!;
  assert.equal(request.task.id, parent); assert.equal(request.task.threadId, oldParent.threadId); assert.match(request.prompt, /fork exploration result/); assert.doesNotMatch(request.prompt, /later fork text must not bleed/);
  assert.equal((await f.task(parent)).contextTransfers![0].status, 'consumed');
  await f.reopen(); assert.equal((await f.task(parent)).contextTransfers![0].reference.digest, transfer.reference.digest);
});

test('Session and merge HTTP operations authenticate, reject foreign lineages and expose source-point context only to its owner', async t => {
  const f = await fixture(t), id = await f.turn(undefined, 'source', 'api-source'); const api = f.api();
  assert.equal((await api.request('/api/tasks/' + id + '/session-operation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'no-auth', kind: 'disconnect' }) })).status, 401);
  assert.equal((await api.request('/api/tasks/' + id + '/merge-back', { method: 'POST', headers: f.headers, body: JSON.stringify({ requestId: 'not-fork', runId: (await f.task(id)).runs![0].id }) })).status, 400);
  const response = await api.request('/api/tasks/' + id + '/session-operation', { method: 'POST', headers: f.headers, body: JSON.stringify({ requestId: 'http-switch', kind: 'handoff', target: target('pi') }) }); assert.equal(response.status, 200, await response.clone().text()); assert.equal((await response.json()).ok, true);
  const reference = (await f.task(id)).contextTransfers![0].reference, foreign = await f.turn(undefined, 'foreign', 'foreign-task');
  await assert.rejects(f.engine.contexts.read(reference.id, { taskId: foreign }), /不属于/);
});

test('Fixed T3 budget selects intact historical items, reserves its serialized wrapper and retains first and latest useful messages', () => {
  const messages: HistoricalMessage[] = Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: '中'.repeat(index === 25 ? 30000 : 100), threadId: 'source', runId: String(Math.floor(index / 2)), itemId: String(index), providerThreadId: 'native', status: 'completed', kind: index % 2 ? 'assistant_message' : 'user_message' }));
  const selected = selectHistory({ messages, coverage: 'fixture', budget: 4000 });
  assert.ok(selected.messages.some(message => message.itemId === '0')); assert.ok(selected.messages.some(message => message.itemId === '48')); assert.ok(selected.messages.some(message => message.itemId === '49'));
  assert.ok(!selected.messages.some(message => message.itemId === '25')); assert.ok(historyCost(selected.messages, selected.context) <= 4000);
  assert.equal(selected.messages.length + selected.omittedItems, messages.length); assert.ok(selected.context.includes('not a new request'));
});

test('All nine drivers can be selected on the same idle thread without eager native execution or loss of the original history', async t => {
  const f = await fixture(t), id = await f.turn(undefined, 'kept across every provider', 'matrix-source');
  for (const agent of [...providerDrivers.filter(agent => agent !== 'codex'), 'codex' as const]) {
    await f.engine.sessionActions.start(id, { requestId: 'select-' + agent, kind: 'handoff', target: { agent, providerInstanceId: agent, model: agent + '-model', interactionMode: 'default' } });
    const work = await f.task(id); assert.equal(work.agent, agent); assert.equal(work.threadId, null); assert.equal(work.sessionOperation?.status, 'completed'); assert.equal(f.executor.requests.length, 1);
  }
  const work = await f.task(id); assert.equal(work.providerHistory?.length, 9); assert.equal(work.contextTransfers?.filter(transfer => transfer.status === 'pending').length, 1); assert.equal(work.messages?.[0].text, 'kept across every provider');
});

test('Lazy app forks resolve native identity only on first send and do not duplicate inherited history in a native fork prompt', async t => {
  const f = await fixture(t), parent = await f.turn(undefined, 'native source history', 'lazy-source'), sourceRun = (await f.task(parent)).runs![0].id;
  const child = await f.engine.taskForks.start(parent, { requestId: 'lazy-child', runId: sourceRun, lazy: true });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.forkOperation?.status === 'completed');
  assert.equal(f.executor.forks, 0); assert.equal((await f.task(child)).forkOperation?.dispatchPending, true); assert.equal((await f.task(child)).threadId, null);
  assert.equal(await f.engine.taskForks.start(parent, { requestId: 'lazy-child', runId: sourceRun, lazy: true }), child);
  await f.turn(child, 'first fork message', 'lazy-first'); const request = f.executor.requests.at(-1)!;
  assert.equal(f.executor.forks, 1); assert.equal(request.task.threadId, 'fork-thread-1'); assert.match(request.prompt, /first fork message/); assert.doesNotMatch(request.prompt, /native source history|Previous conversation/);
  assert.equal((await f.task(child)).forkOperation?.dispatchRunId, (await f.task(child)).currentRunId);
});

test('Choosing a different provider on an idle lazy fork uses portable context and never forks the old provider', async t => {
  const f = await fixture(t), parent = await f.turn(undefined, 'portable source history', 'portable-parent');
  const child = await f.engine.taskForks.start(parent, { requestId: 'portable-child', runId: (await f.task(parent)).runs![0].id, lazy: true });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.forkOperation?.status === 'completed');
  await f.engine.sessionActions.start(child, { requestId: 'choose-fork-claude', kind: 'handoff', target: target('claude') });
  await f.engine.createTask({ continueId: child, prompt: 'first Claude fork message', requestId: 'portable-first', projectId: 'project', mode: 'code' });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.status === 'completed');
  const request = f.executor.requests.at(-1)!; assert.equal(request.task.agent, 'claude'); assert.equal(request.task.threadId, null); assert.equal(f.executor.forks, 0); assert.match(request.prompt, /portable source history/); assert.match(request.prompt, /first Claude fork message/);
});

test('Unknown first-dispatch native fork never sends the user prompt, is not replayed on restart, and reconciles a known candidate read-only', async t => {
  const f = await fixture(t), parent = await f.turn(undefined, 'source', 'unknown-fork-parent');
  const child = await f.engine.taskForks.start(parent, { requestId: 'unknown-lazy-child', runId: (await f.task(parent)).runs![0].id, lazy: true });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.forkOperation?.status === 'completed');
  f.executor.loseFork = true; await f.engine.createTask({ continueId: child, prompt: 'not sent yet', requestId: 'unknown-first', projectId: 'project', mode: 'code' });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.status === 'failed');
  assert.equal(f.executor.requests.length, 1); assert.equal(f.executor.forks, 1); assert.equal((await f.task(child)).forkOperation?.status, 'interrupted');
  await f.reopen(); assert.equal(f.executor.forks, 1); assert.equal(f.executor.requests.length, 1);
  await f.engine.taskForks.resolve(child, { requestId: 'inspect-known-lazy-candidate', action: 'inspect' });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.forkOperation?.status === 'completed');
  assert.equal(f.executor.forks, 1); assert.equal(f.executor.requests.length, 1);
  await f.turn(child, 'explicitly send after inspection', 'inspected-first'); assert.equal(f.executor.requests.at(-1)?.task.threadId, 'fork-thread-1'); assert.equal(f.executor.requests.length, 2);
});

test('Stopping a first lazy-fork dispatch cancels both Durable operations without starting a provider turn', async t => {
  const f = await fixture(t), parent = await f.turn(undefined, 'source', 'cancel-fork-parent');
  const child = await f.engine.taskForks.start(parent, { requestId: 'cancel-lazy-child', runId: (await f.task(parent)).runs![0].id, lazy: true });
  await until(f.engine, state => state.tasks.find(task => task.id === child)?.forkOperation?.status === 'completed'); f.executor.blockFork = true;
  await f.engine.createTask({ continueId: child, prompt: 'cancel before native send', requestId: 'cancel-first', projectId: 'project', mode: 'code' });
  await until(f.engine, state => !!state.tasks.find(task => task.id === child)?.forkOperation?.candidateId);
  await f.engine.cancel(child); const work = await f.task(child);
  assert.equal(work.status, 'cancelled'); assert.equal(work.forkOperation?.status, 'interrupted'); assert.equal(f.executor.requests.length, 1); assert.equal((await f.task(parent)).status, 'completed');
});
