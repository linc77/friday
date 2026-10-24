import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { CodexExecutor } from '../src/codex.js';
import { ClaudeExecutor } from '../src/claude.js';
import type { ClaudeConnection } from '../src/claude-provider.js';
import { claudeSessionCall } from '../src/claude-session.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { taskGit } from '../src/git-process.js';
import type { ExecutionRequest, Executor, NativeForkRequest, NativeForkResult, NativeRewindRequest, NativeRewindResult, TaskRun, WorkItem, Workspace } from '../src/types.js';

class ForkExecutor implements Executor {
  requests: ExecutionRequest[] = []; calls = 0; inspections = 0; lose: 'candidate' | 'all' | null = null;
  threads = new Map<string, string[]>(); gate?: () => Promise<void>;
  async run(request: ExecutionRequest) {
    this.requests.push(request); const thread = request.task.threadId ?? randomUUID(); const turn = 'turn-' + this.requests.length;
    this.threads.set(thread, [...(this.threads.get(thread) ?? []), turn]);
    await request.update({ kind: 'session', threadId: thread }); await request.update({ kind: 'turn', turnId: turn });
    if (request.task.agent === 'claude') await request.update({ kind: 'nativeHead', head: 'head-' + turn });
    if (request.prompt.includes('pause-execution')) await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    await request.update({ kind: 'item', item: { id: turn + '-event', kind: 'message', phase: 'final_answer', text: 'Answer ' + turn, at: new Date().toISOString(), status: 'completed', turnId: turn } });
    return 'Answer ' + turn;
  }
  async fork(request: NativeForkRequest): Promise<NativeForkResult> {
    if (request.inspectOnly) this.inspections++;
    let candidate = request.candidateId;
    if (!candidate) {
      if (request.inspectOnly) throw new Error('没有可核对的回执');
      await request.started(); this.calls++; await this.gate?.();
      const turns = this.threads.get(request.task.threadId!)!; const index = turns.indexOf(request.run.turnId!);
      assert.ok(index >= 0); assert.deepEqual(turns.slice(0, index + 1), request.expectedTurns);
      candidate = randomUUID(); this.threads.set(candidate, turns.slice(0, index + 1));
      if (this.lose === 'all') { this.lose = null; throw new Error('lost response before candidate'); }
      await request.candidate(candidate);
      if (this.lose === 'candidate') { this.lose = null; throw new Error('lost response after candidate'); }
    }
    const turns = this.threads.get(candidate)!; assert.deepEqual(turns, request.expectedTurns);
    return { threadId: candidate, turnIds: Object.fromEntries(turns.map(id => [id, id])), headIds: Object.fromEntries(turns.map(id => ['head-' + id, candidate + '-head-' + id])) };
  }
  async rewind(request: NativeRewindRequest): Promise<NativeRewindResult> {
    const id = request.task.threadId!; const turns = this.threads.get(id)!; const index = turns.indexOf(request.targetTurnId!);
    assert.deepEqual(turns.slice(index), request.removeTurns); const keep = turns.slice(0, index);
    await request.started({ threadId: id, turns, keep }); this.threads.set(id, keep); await request.candidate(id);
    return { state: 'applied', threadId: id, turns: keep };
  }
  async answer() {} async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Fork state transition timed out');
}
const settled = (engine: Engine, id: string) => until(engine, state => !!state.tasks.find(task => task.id === id)?.forkOperation && !['queued', 'running'].includes(state.tasks.find(task => task.id === id)!.forkOperation!.status));
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, agent: 'codex' | 'claude' = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-fork-'))); const root = join(base, 'source'); const data = join(base, 'data'); await mkdir(root);
  const executor = new ForkExecutor(); let engine = await new Engine(data, executor).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const sourceID = await engine.createTask({ prompt: 'First', requestId: 'first', projectId: 'project', mode: 'code', agent });
  await until(engine, state => state.tasks[0]?.status === 'completed');
  await engine.createTask({ continueId: sourceID, prompt: 'Second', requestId: 'second', projectId: 'project', mode: 'code' });
  await until(engine, state => state.tasks[0]?.status === 'completed' && state.tasks[0].runs?.length === 2);
  const reopen = async () => { await engine.close(); engine = await new Engine(data, executor).open(); return engine; };
  return { engine, executor, sourceID, root, data, reopen };
}

test('A selected reply can fork beyond the old 300-record limit without replaying the source', async t => {
  const { engine, executor, sourceID } = await setup(t), source = (await engine.snapshot()).tasks[0];
  await engine.mutate(state => {
    for (let index = 0; index < 300; index++) state.tasks.push({ id: 'retained-' + index, title: 'Retained', prompt: 'Retained', result: '', projectId: source.projectId, cwd: source.cwd,
      agent: 'codex', mode: 'code', status: 'completed', createdAt: source.createdAt, updatedAt: source.updatedAt, archivedAt: source.updatedAt, durableId: null, threadId: null, turnId: null, events: [], approvals: [], artifact: null, error: null, lastRequestId: 'retained-' + index });
  });
  const id = await engine.taskForks.start(sourceID, { requestId: 'over-capacity-fork', runId: source.runs![0].id });
  const state = await until(engine, state => state.tasks.find(task => task.id === id)?.forkOperation?.status === 'completed');
  assert.equal(state.tasks.length, 302); assert.equal(executor.calls, 1); assert.equal(executor.requests.length, 2);
  assert.equal(await engine.taskForks.start(sourceID, { requestId: 'over-capacity-fork', runId: source.runs![0].id }), id); assert.equal(executor.calls, 1);
});

test('Fork copies only the selected prefix, resets thread metadata, deduplicates lost requests and continues a separate native session', async t => {
  const { engine, executor, sourceID, root } = await setup(t);
  await engine.mutate(state => { const source = state.tasks[0]; source.pinnedAt = source.updatedAt; source.archivedAt = source.updatedAt; source.snoozedUntil = '2099-01-01T00:00:00Z'; source.settledAt = source.updatedAt;
    source.model = 'current-model'; source.reasoningEffort = 'high'; source.interactionMode = 'plan'; source.mode = 'research'; });
  const before = (await engine.snapshot()).tasks[0]; const run = before.runs![0]; await writeFile(join(root, 'keep'), 'current source files\n');
  const [id, duplicate] = await Promise.all([engine.taskForks.start(sourceID, { requestId: 'fork', runId: run.id }), engine.taskForks.start(sourceID, { requestId: 'fork', runId: run.id })]);
  assert.equal(id, duplicate); let state = await settled(engine, id); let child = state.tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed', child.forkOperation?.error); assert.equal(executor.calls, 1); assert.equal(child.durableId, null);
  assert.deepEqual(child.messages?.map(message => message.text), ['First', 'Answer turn-1']); assert.equal(child.events.some(event => event.text.includes('turn-2')), false);
  assert.equal(child.runs?.length, 1); assert.equal(child.runs?.[0].durableId, null); assert.deepEqual(child.runs?.[0].inheritedFrom, { taskId: sourceID, runId: run.id });
  assert.notEqual(child.threadId, before.threadId); assert.equal(child.runs?.[0].threadId, child.threadId); assert.equal(child.forkOrigin?.rootTaskId, sourceID);
  assert.equal(child.mode, 'research'); assert.equal(child.model, 'current-model'); assert.equal(child.reasoningEffort, 'high'); assert.equal(child.interactionMode, 'plan', 'Like T3, forks inherit the current thread configuration while preserving historical run settings');
  assert.equal(child.runs?.[0].mode, 'code'); assert.equal(child.runs?.[0].interactionMode, 'default');
  assert.equal(child.archivedAt, undefined); assert.equal(child.pinnedAt, undefined); assert.equal(child.snoozedUntil, undefined); assert.equal(child.settledAt, undefined);
  assert.deepEqual(state.tasks[0], before); assert.equal(await readFile(join(root, 'keep'), 'utf8'), 'current source files\n');
  const inherited = structuredClone(child.runs);
  await engine.mutate(state => { state.tasks.find(task => task.id === id)!.forkOperation!.status = 'interrupted'; });
  await engine.taskForks.resolve(id, { requestId: 'projection-recovery', action: 'inspect' }); state = await settled(engine, id); child = state.tasks.find(task => task.id === id)!;
  assert.deepEqual(child.runs, inherited, 'Recovery after the saved projection must not erase or remap its native boundaries a second time'); assert.equal(executor.calls, 1);
  await engine.createTask({ continueId: id, prompt: 'Child only', requestId: 'child-turn', projectId: 'project', mode: 'code' });
  state = await until(engine, state => state.tasks.find(task => task.id === id)?.runs?.length === 2 && state.tasks.find(task => task.id === id)?.status === 'completed');
  child = state.tasks.find(task => task.id === id)!; assert.equal(executor.requests[2].task.threadId, child.threadId); assert.ok(!executor.requests[2].prompt.includes('Previous conversation'));
  assert.deepEqual(executor.threads.get(before.threadId!), ['turn-1', 'turn-2']); assert.deepEqual(executor.threads.get(child.threadId!), ['turn-1', 'turn-3']);
  await engine.deleteTask(id); assert.equal(await engine.taskForks.start(sourceID, { requestId: 'fork', runId: run.id }), id); assert.equal(executor.calls, 1);
  await assert.rejects(engine.taskForks.start(sourceID, { requestId: 'fork', runId: before.runs![1].id }), /请求 ID/);
});

test('A saved candidate is inspected after restart without repeating the native fork', async t => {
  const fixture = await setup(t); let engine = fixture.engine; const { executor, sourceID } = fixture; executor.lose = 'candidate';
  const source = (await engine.snapshot()).tasks[0]; const id = await engine.taskForks.start(sourceID, { requestId: 'lost', runId: source.runs![0].id });
  let state = await settled(engine, id); let child = state.tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'interrupted'); assert.ok(child.forkOperation?.candidateId);
  await assert.rejects(engine.createTask({ continueId: id, prompt: 'must wait', requestId: 'blocked', projectId: 'project', mode: 'code' }), /分叉/);
  await assert.rejects(engine.taskQueue.enqueue(id, { text: 'must wait' }, 'blocked-queue'), /分叉/);
  engine = await fixture.reopen(); assert.equal(executor.calls, 1);
  await engine.taskForks.resolve(id, { requestId: 'inspect', action: 'inspect' }); state = await settled(engine, id); child = state.tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed', child.forkOperation?.error); assert.equal(executor.calls, 1); assert.equal(executor.inspections, 1);
  assert.equal(child.threadId, child.forkOperation?.candidateId);
  await engine.taskForks.resolve(id, { requestId: 'inspect', action: 'inspect' }); assert.equal(executor.calls, 1);
});

test('An unknown fork is not repeated; explicit fallback retains captured contexts and never attaches the source session', async t => {
  const { engine, executor, sourceID, root } = await setup(t); await writeFile(join(root, 'file'), 'captured source\n');
  const reference = await engine.contexts.capture({ id: 'fork-context', scope: { taskId: sourceID }, kind: 'file', path: 'file' });
  await engine.createTask({ continueId: sourceID, prompt: '[file](friday-context://v1/file/fork-context)', contextIds: [reference.id], requestId: 'context-turn', projectId: 'project', mode: 'code' });
  const state = await until(engine, state => state.tasks[0].runs?.length === 3 && state.tasks[0].status === 'completed');
  executor.lose = 'all'; const id = await engine.taskForks.start(sourceID, { requestId: 'unknown', runId: state.tasks[0].runs![2].id });
  let child = (await settled(engine, id)).tasks.find(task => task.id === id)!; assert.equal(child.forkOperation?.status, 'interrupted');
  await assert.rejects(engine.taskForks.resolve(id, { requestId: 'unsafe-retry', action: 'retry' }), /不能重复/);
  await assert.rejects(engine.taskForks.resolve(id, { requestId: 'no-candidate', action: 'inspect' }), /没有收到/);
  await engine.taskForks.resolve(id, { requestId: 'fallback', action: 'new_session' }); child = (await settled(engine, id)).tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed'); assert.equal(child.forkOperation?.strategy, 'visible_history'); assert.equal(child.threadId, null); assert.ok(child.runs?.every(run => !run.threadId && !run.turnId));
  assert.ok(child.messages?.every(message => !message.turnId)); assert.ok(child.events.every(event => !event.turnId), 'Visible-history fallback cannot present source-native turn IDs as executable child history');
  await writeFile(join(root, 'file'), 'changed after capture\n'); await engine.deleteTask(sourceID);
  await engine.createTask({ continueId: id, prompt: 'Continue', requestId: 'fallback-turn', projectId: 'project', mode: 'code' });
  await until(engine, state => state.tasks.find(task => task.id === id)?.runs?.length === 4 && state.tasks.find(task => task.id === id)?.status === 'completed');
  assert.equal(executor.calls, 1); assert.ok(!executor.requests.at(-1)!.task.threadId); assert.match(executor.requests.at(-1)!.prompt, /Previous conversation/); assert.match(executor.requests.at(-1)!.prompt, /captured source/); assert.doesNotMatch(executor.requests.at(-1)!.prompt, /changed after capture/);
  const continued = (await engine.snapshot()).tasks.find(task => task.id === id)!; const latest = continued.runs!.at(-1)!;
  const options = await engine.taskRewinds.options(id, latest.messageId);
  await engine.taskRewinds.start(id, { requestId: 'rewind-fallback-turn', messageId: latest.messageId, fingerprint: options.fingerprint, restoreFiles: false });
  const rewound = await until(engine, state => state.tasks.find(task => task.id === id)?.rewindOperation?.status === 'completed');
  assert.equal(rewound.tasks.find(task => task.id === id)?.threadId, null, 'Removing the first new native turn must retain the inherited visible context for the replacement session');
  await engine.createTask({ continueId: id, prompt: 'Replacement', requestId: 'replacement-turn', projectId: 'project', mode: 'code' });
  await until(engine, state => state.tasks.find(task => task.id === id)?.runs?.length === 5 && state.tasks.find(task => task.id === id)?.status === 'completed');
  assert.match(executor.requests.at(-1)!.prompt, /Previous conversation/); assert.match(executor.requests.at(-1)!.prompt, /captured source/);
});

test('Forks retain immutable historical diff objects after current files change and the source task is deleted', async t => {
  const { engine, sourceID, root } = await setup(t); const source = (await engine.snapshot()).tasks[0];
  const git = (args: string[]) => taskGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args]);
  await git(['init', '-q', '--initial-branch=main']); await writeFile(join(root, 'tracked'), 'before\n'); await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  const before = await engine.taskRuns.checkpoints.capture(source, 'fork-diff', 'before'); await writeFile(join(root, 'tracked'), 'after selected\n');
  const after = await engine.taskRuns.checkpoints.capture(source, 'fork-diff', 'after'); const changes = await engine.taskRuns.checkpoints.changes(before, after);
  await engine.mutate(state => { Object.assign(state.tasks[0].runs![0], { before, after, changes }); });
  const id = await engine.taskForks.start(sourceID, { requestId: 'diff-fork', runId: source.runs![0].id }); const child = (await settled(engine, id)).tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed'); await writeFile(join(root, 'tracked'), 'current unrelated content\n'); await engine.deleteTask(sourceID);
  const diff = await engine.taskRuns.diff(child, child.runs![0].id, 'tracked'); assert.match(diff.patch, /-before/); assert.match(diff.patch, /\+after selected/); assert.doesNotMatch(diff.patch, /current unrelated/);
});

test('Forking a failed response keeps its partial answer and never substitutes the previous successful reply', async t => {
  const { engine, sourceID } = await setup(t);
  await engine.mutate(state => {
    const source = state.tasks[0]; const run = source.runs![1]; run.status = 'failed'; source.status = 'failed'; source.result = 'Partial second answer';
    source.messages = source.messages!.filter(message => message.role !== 'assistant' || message.runId !== run.id);
    source.events.find(event => event.runId === run.id && event.kind === 'message')!.text = source.result;
  });
  const source = (await engine.snapshot()).tasks[0];
  const id = await engine.taskForks.start(sourceID, { requestId: 'failed-fork', runId: source.runs![1].id }); const child = (await settled(engine, id)).tasks.find(task => task.id === id)!;
  assert.equal(child.result, 'Partial second answer'); assert.equal(child.forkOperation?.status, 'completed');
  await engine.mutate(state => { const source = state.tasks.find(task => task.id === sourceID)!; source.result = ''; source.events = source.events.filter(event => event.runId !== source.runs![1].id || event.kind !== 'message'); });
  const emptyID = await engine.taskForks.start(sourceID, { requestId: 'failed-empty-fork', runId: source.runs![1].id }); const empty = (await settled(engine, emptyID)).tasks.find(task => task.id === emptyID)!;
  assert.equal(empty.result, ''); assert.equal(empty.messages?.at(-1)?.role, 'user');
});

test('Forked history never retains executable ownership of an older source session across a Claude session boundary', async t => {
  const { engine, executor, sourceID } = await setup(t, 'claude');
  await engine.mutate(state => { const source = state.tasks[0]; source.runs![0].threadId = 'older-source-native'; source.runs![0].nativeHead = 'older-head'; source.runs![1].nativeHead = 'head-turn-2'; });
  const source = (await engine.snapshot()).tasks[0]; executor.threads.set(source.threadId!, ['turn-2']); executor.threads.set('older-source-native', ['turn-1']);
  const id = await engine.taskForks.start(sourceID, { requestId: 'cross-session-fork', runId: source.runs![1].id }); const child = (await settled(engine, id)).tasks.find(task => task.id === id)!;
  assert.equal(child.forkOperation?.status, 'completed', child.forkOperation?.error); assert.equal(child.runs![0].threadId, undefined); assert.equal(child.runs![0].nativeHead, undefined);
  assert.equal(child.runs![1].threadId, child.threadId); assert.notEqual(child.runs![1].nativeHead, source.runs![1].nativeHead);
  const options = await engine.taskRewinds.options(id, child.runs![1].messageId); assert.match(options.nativeReason!, /没有 SDK 消息游标/);
  await assert.rejects(engine.taskRewinds.start(id, { requestId: 'unsafe-parent-attach', messageId: options.messageId, fingerprint: options.fingerprint, restoreFiles: false }), /没有 SDK 消息游标/);
  await engine.taskRewinds.start(id, { requestId: 'fresh-child-rewind', messageId: options.messageId, fingerprint: options.fingerprint, restoreFiles: false, newSession: true });
  const state = await until(engine, state => state.tasks.find(task => task.id === id)?.rewindOperation?.status === 'completed');
  assert.equal(state.tasks.find(task => task.id === id)?.threadId, null); assert.deepEqual(state.tasks.find(task => task.id === sourceID), source);
  assert.deepEqual(executor.threads.get(source.threadId!), ['turn-2']); assert.deepEqual(executor.threads.get('older-source-native'), ['turn-1']);
});

test('An earlier completed Codex response can fork while a later source turn is active; update and branch writes respect the pending operation', async t => {
  const { engine, executor, sourceID, root } = await setup(t); const first = (await engine.snapshot()).tasks[0].runs![0];
  await engine.createTask({ continueId: sourceID, prompt: 'pause-execution', requestId: 'running-third', projectId: 'project', mode: 'code' });
  await until(engine, state => state.tasks[0].status === 'running' && state.tasks[0].runs?.length === 3);
  let release!: () => void; executor.gate = () => new Promise(resolve => { release = resolve; });
  const id = await engine.taskForks.start(sourceID, { requestId: 'fork-active', runId: first.id });
  await until(engine, state => !!state.tasks.find(task => task.id === id)?.forkOperation?.startedAt);
  assert.ok(release); const maintenance = new ServiceMaintenance(() => engine.snapshot()); await assert.rejects(maintenance.prepare(), /仍有任务/);
  await assert.rejects(engine.createTask({ prompt: 'other work', requestId: 'same-workspace', projectId: 'project', mode: 'code', agent: 'codex' }), /切换分支/);
  release(); const child = (await settled(engine, id)).tasks.find(task => task.id === id)!;
  assert.deepEqual(child.messages?.map(message => message.text), ['First', 'Answer turn-1']); assert.equal(child.cwd, root); assert.equal(child.forkOperation?.status, 'completed');
  await engine.cancel(sourceID);
});

test('Fork API requires authentication, rejects active boundaries and keeps request identity scoped after source deletion', async t => {
  const { engine, sourceID, data } = await setup(t); const source = (await engine.snapshot()).tasks[0]; const auth = new Auth(data); t.after(() => auth.close()); const app = createAPI(engine, auth, () => []);
  const url = `http://localhost/api/tasks/${sourceID}/fork`; const body = { requestId: 'api-fork', runId: source.runs![0].id };
  assert.equal((await app.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
  const response = await app.request(url, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(response.status, 202);
  const { id } = await response.json(); await settled(engine, id); await engine.deleteTask(sourceID);
  const repeated = await app.request(url, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal((await repeated.json()).id, id);
  await assert.rejects(engine.taskForks.start(id, { requestId: 'first', runId: (await engine.snapshot()).tasks[0].runs![0].id }), /请求 ID/);
  await engine.mutate(state => { state.tasks[0].runs![0].status = 'running'; });
  await assert.rejects(engine.taskForks.start(id, { requestId: 'active-boundary', runId: (await engine.snapshot()).tasks[0].runs![0].id }), /已结束/);
});

const nativeTask = (cwd: string): WorkItem => ({ id: 'source', title: 'Source', prompt: 'First', projectId: null, cwd, agent: 'codex', mode: 'research', status: 'completed', createdAt: '', updatedAt: '', durableId: null, threadId: 'source-native', turnId: 'selected', result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'source' });
const nativeRun: TaskRun = { id: 'run', durableId: 1, messageId: 'message', requestId: 'request', cwd: '', at: '', status: 'completed', threadId: 'source-native', turnId: 'selected', mode: 'research', interactionMode: 'default' };

test('Codex native fork bounds paginated history, defers goals and verifies a saved candidate read-only after a lost receipt', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-fork-wire-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const command = new URL('./fixtures/codex-fork.mjs', import.meta.url).pathname; await chmod(command, 0o755);
  await writeFile(join(directory, 'fork-history.json'), JSON.stringify({ source: ['first', 'selected', 'later'], activeTurn: 'later', failVerifyOnce: true }));
  const executor = new CodexExecutor(command); let started = 0; let candidateId: string | undefined;
  const request: NativeForkRequest = { task: nativeTask(directory), run: nativeRun, expectedTurns: ['first', 'selected'], title: 'Source fork', inspectOnly: false, signal: new AbortController().signal,
    started: async () => { started++; const wire = await readFile(join(directory, 'fork-wire.jsonl'), 'utf8'); assert.doesNotMatch(wire, /"method":"thread\/fork"/); }, candidate: async id => { candidateId = id; } };
  await assert.rejects(executor.fork(request), /verification connection lost/); assert.equal(started, 1); assert.ok(candidateId);
  const result = await executor.fork({ ...request, candidateId, inspectOnly: true }); assert.equal(result.threadId, candidateId); assert.deepEqual(result.turnIds, { first: 'first', selected: 'selected' });
  const wire = (await readFile(join(directory, 'fork-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); const forks = wire.filter(item => item.method === 'thread/fork');
  assert.equal(forks.length, 1); assert.equal(forks[0].params.lastTurnId, 'selected'); assert.equal(forks[0].params.deferGoalContinuation, true); assert.equal(forks[0].params.excludeTurns, true);
  assert.equal(wire.some(item => ['turn/start', 'thread/revert', 'thread/resume'].includes(item.method)), false);
  const history = JSON.parse(await readFile(join(directory, 'fork-history.json'), 'utf8')); assert.deepEqual(history.source, ['first', 'selected', 'later']);
});

test('Codex legacy history can fork, while unknown prefixes or lost fork IDs never cause an implicit second fork', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-fork-legacy-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = new CodexExecutor(new URL('./fixtures/codex-fork.mjs', import.meta.url).pathname);
  const request: NativeForkRequest = { task: nativeTask(directory), run: nativeRun, expectedTurns: ['first', 'selected'], title: 'Fork', inspectOnly: false, signal: new AbortController().signal, started: async () => {}, candidate: async () => {} };
  await writeFile(join(directory, 'fork-history.json'), JSON.stringify({ source: ['first', 'selected', 'later'], mode: 'legacy' }));
  assert.equal((await executor.fork(request)).threadId, 'fork-native-1');
  await writeFile(join(directory, 'fork-history.json'), JSON.stringify({ source: ['unknown', 'first', 'selected'] })); await assert.rejects(executor.fork(request), /不一致/);
  await writeFile(join(directory, 'fork-history.json'), JSON.stringify({ source: ['first', 'selected'], loseReceipt: true })); await assert.rejects(executor.fork(request), /连接结束/);
  await assert.rejects(executor.fork({ ...request, inspectOnly: true }), /没有可核对/);
  const wire = (await readFile(join(directory, 'fork-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); assert.equal(wire.filter(item => item.method === 'thread/fork').length, 2);
});

test('Claude SDK forks a real transcript through the selected chain cursor, remaps UUIDs and isolates concurrent account homes', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-fork-sdk-'))); t.after(() => rm(base, { recursive: true, force: true })); const cwd = join(base, 'workspace'); await mkdir(cwd);
  const home = join(base, 'account-one'); const other = join(base, 'account-two'); const sessionId = randomUUID(); const ids = Array.from({ length: 6 }, () => randomUUID());
  const project = cwd.replace(/[^a-zA-Z0-9]/g, '-'); await mkdir(join(home, 'projects', project), { recursive: true }); await mkdir(join(other, 'projects', project), { recursive: true });
  const contents = ['First request', [{ type: 'tool_use', id: 'tool-fixture', name: 'Read', input: { file_path: 'file' } }],
    [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: 'Historical tool output' }], [{ type: 'text', text: 'First answer' }], 'Later request', [{ type: 'text', text: 'Later answer' }]];
  const entries = ids.map((uuid, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid, parentUuid: ids[i - 1] ?? null, sessionId, cwd, timestamp: new Date(Date.now() + i).toISOString(), isSidechain: false,
    message: i % 2 ? { role: 'assistant', model: 'fixture', content: contents[i], stop_reason: i === 1 ? 'tool_use' : 'end_turn' } : { role: 'user', content: contents[i] } }));
  const file = join(home, 'projects', project, sessionId + '.jsonl'); const original = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'; await writeFile(file, original, { mode: 0o600 });
  const signal = new AbortController().signal; const environment = process.env.CLAUDE_CONFIG_DIR;
  const [messages, missing] = await Promise.all([claudeSessionCall(home, { action: 'read', sessionId, dir: cwd }, signal), claudeSessionCall(other, { action: 'read', sessionId, dir: cwd }, signal)]);
  assert.equal(messages.length, 6); assert.equal(missing.length, 0); assert.equal(process.env.CLAUDE_CONFIG_DIR, environment);
  const connection = { runtime: async () => ({ home }), onClose: () => () => {} } as unknown as ClaudeConnection; const executor = new ClaudeExecutor(connection); let started = 0; let candidateId: string | undefined;
  const request: NativeForkRequest = { task: { ...nativeTask(cwd), agent: 'claude', threadId: sessionId, claudeHome: home }, run: { ...nativeRun, turnId: ids[0], nativeHead: ids[3] }, expectedTurns: [ids[0]], title: 'Branched', signal, inspectOnly: false, started: async () => { started++; }, candidate: async id => { candidateId = id; } };
  const result = await executor.fork(request); assert.equal(started, 1); assert.equal(result.threadId, candidateId); assert.notEqual(result.threadId, sessionId); assert.notEqual(result.headIds[ids[3]], ids[3]);
  const forked = await claudeSessionCall(home, { action: 'read', sessionId: result.threadId, dir: cwd }, signal); assert.equal(forked.length, 4); assert.equal(forked[3].uuid, result.headIds[ids[3]]); assert.equal(forked[0].uuid, result.turnIds[ids[0]]); assert.match(JSON.stringify(forked), /Historical tool output/);
  assert.equal(await readFile(file, 'utf8'), original); assert.doesNotMatch(JSON.stringify(forked), /Later request|Later answer/);
  const inspected = await executor.fork({ ...request, candidateId, inspectOnly: true }); assert.deepEqual(inspected, result); assert.equal(started, 1);
  await assert.rejects(executor.fork({ ...request, task: { ...request.task, claudeHome: other } }), /配置目录/);
});


test('Forked conversation context carries PR associations, hidden stack dismissals and branch metadata independently of the source',async t=>{
 const {engine,sourceID}=await setup(t),snapshot=await engine.snapshot(),source=snapshot.tasks.find(task=>task.id===sourceID)!;
 const pr={number:17,title:'PR context',url:'https://github.com/owner/repo/pull/17',state:'open' as const,head:'feature',base:'main',provider:'github' as const,host:'github.com',repository:'owner/repo',linkedAt:source.createdAt,linkSource:'manual' as const};
 await engine.mutate(state=>{const task=state.tasks.find(task=>task.id===sourceID)!;task.changeRequests=[pr,{...pr,number:18,url:pr.url.replace('/17','/18'),linkSource:'stack-dismissed',dismissedAt:task.updatedAt}];task.changeRequestLinksRevision=2;task.branchPullRequest=pr;task.changeRequestStacks={[pr.url]:{id:'stack',number:7,url:'https://github.com/owner/repo/stacks/7',base:'main',syncedAt:task.updatedAt,layers:[{number:17,headBranch:'feature',state:'open'}]}};});
 const id=await engine.taskForks.start(sourceID,{requestId:'pr-context-fork',runId:source.runs![0].id});const state=await settled(engine,id),child=state.tasks.find(task=>task.id===id)!;
 assert.equal(child.changeRequests?.length,2);assert.equal(child.changeRequests?.[1].linkSource,'stack-dismissed');assert.equal(child.branchPullRequest?.number,17);assert.equal(child.changeRequestStacks?.[pr.url]?.number,7);
 await engine.mutate(s=>{s.tasks.find(task=>task.id===id)!.changeRequests!.pop();});assert.equal((await engine.snapshot()).tasks.find(task=>task.id===sourceID)?.changeRequests?.length,2);
});
