import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Engine } from '../src/engine.js';
import { prepareWorkspace } from '../src/task-workspace.js';
import { taskGit } from '../src/git-process.js';
import { rewindFingerprint } from '../src/task-rewind-safety.js';
import type { ExecutionRequest, Executor, NativeForkRequest, NativeRewindRequest, NativeRewindResult, WorkItem } from '../src/types.js';

class OrderedExecutor implements Executor {
  calls: ExecutionRequest[] = []; threads = new Map<string, string[]>(); forks = 0; reverts = 0; inspections = 0; lose = false;
  async run(request: ExecutionRequest) {
    this.calls.push(request); const turnId = 'turn-' + this.calls.length; const thread = request.task.threadId ?? randomUUID();
    this.threads.set(thread, [...(this.threads.get(thread) ?? []), turnId]);
    await request.update({ kind: 'session', threadId: thread }); await request.update({ kind: 'turn', turnId });
    if (request.task.agent === 'claude') await request.update({ kind: 'nativeHead', head: 'head-' + turnId });
    await writeFile(join(request.task.cwd, 'file'), turnId + '\n');
    await request.update({ kind: 'item', item: { id: 'reply-' + turnId, itemId: 'reply-' + turnId, kind: 'message', phase: 'final_answer', text: 'Answer ' + turnId, at: new Date().toISOString(), status: 'completed', turnId } });
    return 'Answer ' + turnId;
  }
  async fork(request: NativeForkRequest) {
    const turns = this.threads.get(request.task.threadId!)!; const index = turns.indexOf(request.run.turnId!);
    assert.ok(index >= 0); assert.deepEqual(turns.slice(0, index + 1), request.expectedTurns, 'Fork boundaries follow actual provider execution');
    await request.started(); this.forks++; const id = randomUUID(); const prefix = turns.slice(0, index + 1); this.threads.set(id, prefix); await request.candidate(id);
    return { threadId: id, turnIds: Object.fromEntries(prefix.map(turn => [turn, turn])), headIds: Object.fromEntries(prefix.map(turn => ['head-' + turn, id + '-head-' + turn])) };
  }
  async rewind(request: NativeRewindRequest): Promise<NativeRewindResult> {
    const id = request.task.threadId!; const turns = this.threads.get(id)!;
    if (request.inspectOnly) { this.inspections++; return { state: JSON.stringify(turns) === JSON.stringify(request.original?.keep) ? 'applied' : 'unchanged', threadId: id, turns }; }
    const index = request.targetTurnId ? turns.indexOf(request.targetTurnId) : turns.length;
    assert.ok(index >= 0); assert.deepEqual(turns.slice(index), request.removeTurns, 'Reverts remove an actual native suffix');
    assert.deepEqual(turns.slice(0, index), request.keepTurns);
    await request.started({ threadId: id, turns: [...turns], keep: turns.slice(0, index) }); this.reverts++; this.threads.set(id, turns.slice(0, index));
    if (this.lose) { this.lose = false; throw new Error('Lost native revert receipt'); }
    await request.candidate(id); return { state: 'applied', threadId: id, turns: turns.slice(0, index) };
  }
  async answer() {} async steer() {}
}
async function until(engine: Engine, id: string, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const task = (await engine.snapshot()).tasks.find(task => task.id === id); if (task && predicate(task)) return task; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Run-order transition timed out');
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, agent: 'codex' | 'claude' = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-run-order-'))); const repo = join(base, 'repo'); const data = join(base, 'data'); await mkdir(repo);
  const git = (args: string[]) => taskGit(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args]);
  await git(['init', '-q', '--initial-branch=main']); await writeFile(join(repo, 'file'), 'baseline\n'); await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  const executor = new OrderedExecutor(); let engine = await new Engine(data, executor).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', path: repo, name: 'Project', context: '' }));
  await writeFile(join(data, 'worktrees'), 'Temporary obstacle');
  const id = await engine.createTask({ prompt: 'Original request', requestId: 'original', projectId: 'project', agent, mode: 'code', workspace: { mode: 'worktree' } });
  const failed = await until(engine, id, task => task.status === 'failed'); await engine.harness.waitForTask(failed.durableId as TaskId, context);
  await rm(join(data, 'worktrees')); await prepareWorkspace(failed.executionWorkspace!, async () => { await engine.patchTask(id, task => { task.executionWorkspace!.state = 'preparing'; }); });
  await engine.patchTask(id, task => { task.executionWorkspace!.state = 'ready'; });
  await engine.createTask({ continueId: id, prompt: 'Later request', requestId: 'later', projectId: 'project', mode: 'code' });
  await until(engine, id, task => task.status === 'completed');
  await engine.taskPreparations.retry(id, failed.currentRunId!, 'retry-original');
  const source = await until(engine, id, task => task.status === 'completed' && task.currentRunId === failed.currentRunId);
  assert.equal(source.runs?.length, 2); assert.deepEqual(executor.threads.get(source.threadId!), ['turn-1', 'turn-2']);
  return { get engine() { return engine; }, id, source, executor, data, async reopen() { await engine.close(); engine = await new Engine(data, executor).open(); } };
}
async function fork(f: Awaited<ReturnType<typeof fixture>>, runId: string, requestId = 'fork') {
  const id = await f.engine.taskForks.start(f.id, { runId, requestId });
  const child = await until(f.engine, id, task => !!task.forkOperation && !['queued', 'running'].includes(task.forkOperation.status));
  assert.equal(child.forkOperation?.status, 'completed', child.forkOperation?.error); return child;
}
async function rewind(f: Awaited<ReturnType<typeof fixture>>, messageId: string, restoreFiles = false, requestId = 'rewind') {
  const options = await f.engine.taskRewinds.options(f.id, messageId);
  await f.engine.taskRewinds.start(f.id, { requestId, messageId, restoreFiles, fingerprint: options.fingerprint, fileFingerprint: options.fileFingerprint });
  const task = await until(f.engine, f.id, task => !!task.rewindOperation && !['queued', 'running'].includes(task.rewindOperation.status));
  return { task, options };
}

test('Forking a retried early response retains the complete native prefix and continuing/rewinding the child selects the actual latest run', async t => {
  const f = await fixture(t); const original = f.source.runs![0]; const child = await fork(f, original.id);
  assert.deepEqual(child.messages?.map(message => message.text), ['Original request', 'Later request', 'Answer turn-1', 'Answer turn-2']);
  assert.deepEqual(f.executor.threads.get(child.threadId!), ['turn-1', 'turn-2']); assert.equal(child.result, 'Answer turn-2');
  assert.equal(child.currentRunId, child.runs![0].id); assert.ok(child.runs![0].executionOrder! > child.runs![1].executionOrder!);
  await f.engine.createTask({ continueId: child.id, prompt: 'Continue child', requestId: 'child', projectId: 'project', mode: 'code' });
  const completed = await until(f.engine, child.id, task => task.status === 'completed' && task.runs?.length === 3); const latest = completed.runs![2];
  const options = await f.engine.taskRewinds.options(child.id, latest.messageId);
  await f.engine.taskRewinds.start(child.id, { requestId: 'child-rewind', messageId: latest.messageId, restoreFiles: false, fingerprint: options.fingerprint });
  const rewound = await until(f.engine, child.id, task => task.rewindOperation?.status === 'completed');
  assert.equal(rewound.currentRunId, child.runs![0].id); assert.equal(rewound.turnId, 'turn-2'); assert.equal(rewound.result, 'Answer turn-2');
  assert.deepEqual(f.executor.threads.get(child.threadId!), ['turn-1', 'turn-2']);
});

test('An earlier native fork retains an older input but excludes its later retried execution, reply and diff', async t => {
  const f = await fixture(t); const child = await fork(f, f.source.runs![1].id);
  assert.deepEqual(child.messages?.map(message => message.text), ['Original request', 'Later request', 'Answer turn-1']);
  assert.equal(child.result, 'Answer turn-1'); assert.deepEqual(f.executor.threads.get(child.threadId!), ['turn-1']);
  const unexecuted = child.runs![0]; assert.ok(unexecuted.executionExcludedAt); assert.equal(unexecuted.turnId, undefined); assert.equal(unexecuted.threadId, undefined);
  assert.equal(unexecuted.before, undefined); assert.equal(unexecuted.changes, undefined); assert.equal(child.messages?.[0].turnId, undefined);
  assert.ok(child.events.every(event => event.kind === 'user' || event.turnId !== 'turn-2'));
  await assert.rejects(f.engine.taskForks.start(child.id, { requestId: 'invalid-future-fork', runId: unexecuted.id }), /已结束且未回退/);
});

test('Editing the original early input reverts the actual native suffix and restores its first removed execution checkpoint', async t => {
  const f = await fixture(t); const original = f.source.runs![0];
  assert.equal(await readFile(join(f.source.cwd, 'file'), 'utf8'), 'turn-2\n');
  const { task, options } = await rewind(f, original.messageId, true);
  assert.equal(options.canRestore, true); assert.equal(task.rewindOperation?.status, 'completed', task.rewindOperation?.error);
  assert.deepEqual(task.rewindOperation?.removeTurns, ['turn-1', 'turn-2']); assert.deepEqual(f.executor.threads.get(f.source.threadId!), []);
  assert.equal(await readFile(join(f.source.cwd, 'file'), 'utf8'), 'baseline\n'); assert.equal(task.messages?.filter(message => !message.revertedAt).length, 0);
  assert.equal(task.rewindOperation?.checkpoint?.status === 'ready' ? task.rewindOperation.checkpoint.key : null, f.source.runs![1].before?.status === 'ready' ? f.source.runs![1].before.key : null);
});

test('Editing a later input keeps the older request while excluding its later execution and retiring receipts by actual Durable identity', async t => {
  const f = await fixture(t); const original = f.source.runs![0];
  assert.notEqual(String(original.durableId), original.id);
  await f.engine.mutate(state => { state.tasks[0].queue = { paused: true, dispatcherId: null, messages: [{ id: 'old-queue-receipt', dispatchId: 'old-dispatch', text: 'Original request', images: [], createdAt: f.source.createdAt, status: 'uncertain', runId: original.durableId! }] }; });
  const { task, options } = await rewind(f, f.source.runs![1].messageId);
  assert.equal(task.rewindOperation?.status, 'completed', task.rewindOperation?.error); assert.equal(options.additionalExecutionCount, 1);
  assert.deepEqual(task.messages?.filter(message => !message.revertedAt).map(message => message.text), ['Original request']);
  assert.ok(task.runs![0].executionExcludedAt); assert.equal(task.runs![0].revertedAt, undefined); assert.equal(task.messages?.[0].turnId, undefined);
  assert.equal(task.queue?.messages[0].status, 'cancelled'); assert.equal(task.threadId, null); assert.equal(task.result, '');
  await assert.rejects(f.engine.taskRuns.diff(task, original.id, 'file'), /没有完整/);
  const events = await f.engine.taskHistory.events(task); assert.ok(events.filter(event => event.kind === 'message').every(event => event.revertedAt));
  await f.engine.createTask({ continueId: f.id, prompt: 'Edited later request', requestId: 'edited', projectId: 'project', mode: 'code' });
  const next = await until(f.engine, f.id, task => task.status === 'completed' && task.runs?.length === 3);
  assert.equal(f.executor.calls.length, 3); assert.notEqual(next.threadId, f.source.threadId); assert.match(f.executor.calls[2].prompt, /Previous conversation \(context only; do not replay past actions\)/);
});

test('Legacy run records without execution markers use saved response positions after restart', async t => {
  const f = await fixture(t);
  await f.engine.mutate(state => { for (const run of state.tasks[0].runs!) { delete run.executionOrder; delete run.executionMessagePosition; } });
  await f.reopen(); const child = await fork(f, f.source.runs![0].id);
  assert.deepEqual(f.executor.threads.get(child.threadId!), ['turn-1', 'turn-2']);
  const { task } = await rewind(f, f.source.runs![1].messageId); assert.equal(task.rewindOperation?.status, 'completed', task.rewindOperation?.error);
  assert.deepEqual(task.messages?.filter(message => !message.revertedAt).map(message => message.text), ['Original request']);
});

test('Claude rollback continues from the actual previous SDK cursor after an early preparation retry', async t => {
  const f = await fixture(t, 'claude');
  await f.engine.createTask({ continueId: f.id, prompt: 'Third request', requestId: 'third', projectId: 'project', mode: 'code' });
  const third = await until(f.engine, f.id, task => task.status === 'completed' && task.runs?.length === 3);
  const { task } = await rewind(f, third.runs![2].messageId);
  assert.equal(task.rewindOperation?.status, 'completed', task.rewindOperation?.error); assert.equal(task.claudeResumeSessionAt, 'head-turn-2');
  assert.equal(task.currentRunId, f.source.runs![0].id); assert.equal(task.result, 'Answer turn-2'); assert.equal(f.executor.reverts, 0);
});

test('A lost reordered revert receipt survives restart and is inspected without repeating the native change', async t => {
  const f = await fixture(t); f.executor.lose = true;
  const { task } = await rewind(f, f.source.runs![1].messageId);
  assert.equal(task.rewindOperation?.status, 'interrupted'); assert.equal(f.executor.reverts, 1); assert.deepEqual(task.rewindOperation?.nativeStart?.turns, ['turn-1', 'turn-2']);
  await f.engine.mutate(state => {
    const work = state.tasks[0]; work.rewindOperation!.fingerprint = rewindFingerprint(work, 1); delete work.rewindOperation!.fingerprintVersion;
  });
  await f.reopen(); await f.engine.taskRewinds.resolve(f.id, task.rewindOperation!.id, { requestId: 'inspect', action: 'inspect' });
  const restored = await until(f.engine, f.id, task => task.rewindOperation?.status === 'completed');
  assert.equal(f.executor.reverts, 1); assert.equal(f.executor.inspections, 1); assert.ok(restored.runs![0].executionExcludedAt);
  assert.deepEqual(restored.messages?.filter(message => !message.revertedAt).map(message => message.text), ['Original request']);
});

test('Fork positions are rebased after a rewind leaves audited messages in the source', async t => {
  const f = await fixture(t); await rewind(f, f.source.runs![1].messageId);
  await f.engine.createTask({ continueId: f.id, prompt: 'Edited request', requestId: 'edited', projectId: 'project', mode: 'code' });
  await until(f.engine, f.id, task => task.status === 'completed' && task.runs?.length === 3);
  await f.engine.createTask({ continueId: f.id, prompt: 'Following request', requestId: 'following', projectId: 'project', mode: 'code' });
  const latest = await until(f.engine, f.id, task => task.status === 'completed' && task.runs?.length === 4);
  const child = await fork(f, latest.runs![2].id);
  assert.deepEqual(child.messages?.map(message => message.text), ['Original request', 'Edited request', 'Answer turn-3']);
  assert.equal(child.runs?.find(run => run.turnId === 'turn-3')?.executionMessagePosition, 2);
  assert.deepEqual(f.executor.threads.get(child.threadId!), ['turn-3']);
});
