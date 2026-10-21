import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { IdeaImages } from '../src/ideas.js';
import { planWorkspace, prepareWorkspace, retryWorkspacePlan } from '../src/task-workspace.js';
import type { ExecutionRequest, Executor, WorkItem } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
class RecordingExecutor implements Executor {
  calls: ExecutionRequest[] = [];
  async run(request: ExecutionRequest) {
    this.calls.push(request);
    await request.update({ kind: 'session', threadId: request.task.threadId ?? 'preparation-thread' });
    await request.update({ kind: 'turn', turnId: 'turn-' + this.calls.length });
    return 'Reply ' + this.calls.length;
  }
  async answer() {}
  async steer() {}
}
async function fixture(executor: Executor = new RecordingExecutor()) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'friday-preparation-')));
  const repo = join(root, 'repo'); await mkdir(repo); git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'file.txt'), 'committed\n'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'initial');
  git(repo, 'branch', 'other');
  const directory = join(root, 'service');
  const engine = await new Engine(directory, executor).open();
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Project', path: repo, context: 'Original project context' }));
  return { root, repo, directory, engine, executor, async close() { await engine.close(); await rm(root, { recursive: true, force: true }); } };
}
async function until(engine: Engine, id: string, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const task = (await engine.snapshot()).tasks.find(task => task.id === id);
    if (task && predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Preparation transition timed out');
}
async function failedCheckout(f: Awaited<ReturnType<typeof fixture>>, images?: Awaited<ReturnType<IdeaImages['save']>>[]) {
  await writeFile(join(f.repo, 'file.txt'), 'unsaved\n');
  const id = await f.engine.createTask({ projectId: 'project', prompt: 'Original request', agent: 'codex', mode: 'code', requestId: 'initial',
    images, model: 'original-model', reasoningEffort: 'low', workspace: { mode: 'checkout', branch: 'refs/heads/other' } });
  const task = await until(f.engine, id, task => task.status === 'failed');
  await f.engine.harness.waitForTask(task.durableId as TaskId, context);
  assert.equal(task.runs?.[0].workspacePreparation?.status, 'failed');
  return task;
}

test('Preparation retry retains its run, original input and images and deduplicates lost responses across restart and deletion', async () => {
  const f = await fixture(); const executor = f.executor as RecordingExecutor;
  let engine = f.engine; const auth = new Auth(f.directory);
  try {
    const image = await new IdeaImages(f.directory).save({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6lYQAAAAASUVORK5CYII=', name: 'original.png' });
    const failed = await failedCheckout(f, [image]); const run = failed.runs![0];
    const original = await engine.harness.getTask(failed.durableId as TaskId, context);
    assert.equal(executor.calls.length, 0);
    await engine.close(); engine = await new Engine(f.directory, executor).open();
    await engine.mutate(state => { state.projects[0].context = 'Changed context'; state.memories.push({ id: 'new', text: 'Later preference', updatedAt: '2026-10-18' }); });
    git(f.repo, 'restore', 'file.txt');
    const app = createAPI(engine, auth, () => []); const path = `/api/tasks/${failed.id}/runs/${run.id}/preparation/retry`;
    assert.equal((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    const retry = () => app.request(path, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'retry' }) });
    const responses = await Promise.all([retry(), retry()]); assert.deepEqual(responses.map(response => response.status), [202, 202]);
    const task = await until(engine, failed.id, task => task.status === 'completed');
    assert.equal(task.runs?.length, 1); assert.equal(task.runs?.[0].id, run.id); assert.notEqual(task.durableId, failed.durableId);
    assert.equal(task.messages?.filter(message => message.role === 'user').length, 1); assert.equal(task.messages?.[0].id, failed.messages?.[0].id);
    assert.equal(executor.calls.length, 1); assert.equal(executor.calls[0].prompt, (original!.input as { prompt: string }).prompt);
    assert.deepEqual(executor.calls[0].images?.map(item => item.id), [image.id]);
    assert.equal(task.runs?.[0].workspacePreparation?.attempt, 2); assert.equal(task.runs?.[0].workspacePreparation?.status, 'ready');
    assert.equal(task.messages?.[0].turnId, 'turn-1'); assert.equal(task.runs?.[0].turnId, 'turn-1');
    assert.equal((await retry()).status, 202); assert.equal(executor.calls.length, 1);
    assert.equal((await app.request(`/api/tasks/other/runs/${run.id}/preparation/retry`, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'retry' }) })).status, 400, 'A retry receipt cannot be reused in another thread');
    await engine.harness.waitForTask(task.durableId as TaskId, context); await engine.deleteTask(failed.id);
    assert.equal((await retry()).status, 202, 'A retained receipt never recreates a deleted thread');
    assert.equal((await engine.snapshot()).tasks.length, 0);
  } finally { await engine.close(); auth.close(); await f.close(); }
});

test('Concurrent distinct retries claim one attempt; an execution failure after preparation is never offered as preparation retry', async () => {
  const f = await fixture({ async run() { throw new Error('Provider failed after preparation'); }, async answer() {}, async steer() {} });
  try {
    const task = await failedCheckout(f); git(f.repo, 'restore', 'file.txt');
    const results = await Promise.allSettled(['one', 'two'].map(id => f.engine.taskPreparations.retry(task.id, task.runs![0].id, id)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const failed = await until(f.engine, task.id, task => task.status === 'failed' && task.runs?.[0].workspacePreparation?.status === 'ready');
    assert.equal(failed.error, 'Provider failed after preparation');
    await assert.rejects(f.engine.taskPreparations.retry(task.id, task.runs![0].id, 'provider-retry'), /没有失败/);
    assert.equal(failed.runs?.length, 1);
  } finally { await f.close(); }
});

test('Preparation failure holds follow-ups; retry executes the original request before the unchanged queue', async () => {
  const f = await fixture(); const executor = f.executor as RecordingExecutor;
  try {
    const failed = await failedCheckout(f);
    await f.engine.taskQueue.enqueue(failed.id, { text: 'Next request', model: 'next-model' }, 'next');
    let task = (await f.engine.snapshot()).tasks[0];
    assert.equal(task.queue?.paused, true); assert.equal(task.queue?.heldByRunId, failed.currentRunId); assert.equal(executor.calls.length, 0);
    await assert.rejects(f.engine.taskQueue.resume(failed.id, 'skip-original'), /先重试/);
    git(f.repo, 'restore', 'file.txt');
    await f.engine.taskPreparations.retry(failed.id, failed.currentRunId!, 'retry-queue');
    task = await until(f.engine, failed.id, task => task.queue?.messages[0].status === 'completed' && task.status === 'completed');
    assert.equal(executor.calls.length, 2); assert.ok(executor.calls[0].prompt.includes('Original request')); assert.ok(executor.calls[1].prompt.includes('Next request'));
    assert.equal(executor.calls[0].task.model, 'original-model'); assert.equal(executor.calls[1].task.model, 'next-model');
    assert.deepEqual(task.messages?.filter(message => message.role === 'user').map(message => message.text), ['Original request', 'Next request']);
    assert.equal(task.runs?.length, 2); assert.equal(task.runs?.[0].id, failed.currentRunId);
  } finally { await f.close(); }
});

test('A manual or reconnect queue hold stays paused when preparation is retried', async () => {
  for (const hold of ['manual', 'reconnect']) {
    const f = await fixture(); const executor = f.executor as RecordingExecutor;
    try {
      const failed = await failedCheckout(f);
      await f.engine.taskQueue.enqueue(failed.id, { text: 'Keep held' }, 'held');
      if (hold === 'manual') await f.engine.taskQueue.pause(failed.id); else await f.engine.taskQueue.hold();
      git(f.repo, 'restore', 'file.txt'); await f.engine.taskPreparations.retry(failed.id, failed.currentRunId!, 'retry-held');
      const task = await until(f.engine, failed.id, task => task.status === 'completed');
      assert.equal(task.queue?.paused, true); assert.equal(task.queue?.messages[0].status, 'queued'); assert.equal(executor.calls.length, 1);
    } finally { await f.close(); }
  }
});

test('Explicit worktree retry reuses its pinned branch or a verified completed worktree; recovery never repeats an uncertain mutation', async () => {
  const f = await fixture();
  try {
    const plan = await planWorkspace({ mode: 'worktree' }, f.repo, f.directory, 'partial'); plan.state = 'preparing';
    await assert.rejects(prepareWorkspace(plan, async () => assert.fail('Recovery cannot replay Git')), /不会自动重复/);
    git(f.repo, 'branch', plan.targetBranch!, plan.commit!);
    const retry = await retryWorkspacePlan(plan); assert.equal(retry.reuseBranch, true); assert.equal(retry.state, 'pending');
    await prepareWorkspace(retry, async () => { retry.state = 'preparing'; });
    const adopted = await retryWorkspacePlan(retry); assert.equal(adopted.state, 'preparing');
    await prepareWorkspace(adopted, async () => assert.fail('Do not repeat worktree add'));
    assert.equal(git(adopted.root, 'rev-parse', 'HEAD'), plan.commit); assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    assert.equal(await readFile(join(adopted.cwd, 'file.txt'), 'utf8'), 'committed\n');
  } finally { await f.close(); }
});

test('Worktree retry preserves conflicting files and refuses replaced paths, changed branches and foreign registrations', async () => {
  const f = await fixture();
  try {
    const plan = await planWorkspace({ mode: 'worktree' }, f.repo, f.directory, 'conflict'); plan.state = 'preparing';
    await mkdir(plan.root, { recursive: true }); await writeFile(join(plan.root, 'keep.txt'), 'Keep me');
    await assert.rejects(retryWorkspacePlan(plan), /已有文件/); assert.equal(await readFile(join(plan.root, 'keep.txt'), 'utf8'), 'Keep me');
    await rm(plan.root, { recursive: true }); await symlink(f.repo, plan.root); await assert.rejects(retryWorkspacePlan(plan), /替代/); await rm(plan.root);
    const later = git(f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'later');
    git(f.repo, 'update-ref', 'refs/heads/' + plan.targetBranch, later); await assert.rejects(retryWorkspacePlan(plan), /分支已经改变/);
    git(f.repo, 'update-ref', 'refs/heads/' + plan.targetBranch, plan.commit!);
    git(f.repo, 'worktree', 'add', join(f.root, 'elsewhere'), plan.targetBranch!); await assert.rejects(retryWorkspacePlan(plan), /另一个目录/);
  } finally { await f.close(); }
});

test('An older failed preparation can retry in the existing workspace without releasing a later queue hold or changing later message ownership', async () => {
  const f = await fixture(); const executor = f.executor as RecordingExecutor;
  try {
    const failed = await failedCheckout(f); git(f.repo, 'restore', 'file.txt');
    // The workspace was repaired by the user; a later ordinary run succeeded.
    git(f.repo, 'switch', 'other');
    await f.engine.patchTask(failed.id, task => { task.executionWorkspace!.state = 'ready'; });
    await f.engine.createTask({ continueId: failed.id, projectId: 'project', prompt: 'Later request', mode: 'code', requestId: 'later', model: 'later-model' });
    await until(f.engine, failed.id, task => task.status === 'completed');
    await f.engine.mutate(state => { state.tasks[0].queue = { paused: true, dispatcherId: null, messages: [] }; });
    await f.engine.taskQueue.enqueue(failed.id, { text: 'Held later request' }, 'held-later');
    await f.engine.taskPreparations.retry(failed.id, failed.currentRunId!, 'retry-older');
    const task = await until(f.engine, failed.id, task => task.status === 'completed' && task.currentRunId === failed.currentRunId);
    assert.equal(executor.calls.length, 2); assert.equal(executor.calls[1].task.model, 'original-model');
    assert.equal(task.messages?.find(message => message.text === 'Original request')?.turnId, 'turn-2');
    assert.equal(task.messages?.find(message => message.text === 'Later request')?.turnId, 'turn-1');
    assert.equal(task.queue?.paused, true); assert.equal(task.queue?.messages[0].status, 'queued'); assert.equal(task.runs?.length, 2);
  } finally { await f.close(); }
});

test('A failed worktree launch retries in its original destination and commit while the dirty source stays untouched', async () => {
  const f = await fixture(); const executor = f.executor as RecordingExecutor;
  try {
    await writeFile(join(f.repo, 'file.txt'), 'Source edits');
    await writeFile(join(f.directory, 'worktrees'), 'Temporary filesystem obstacle');
    const id = await f.engine.createTask({ projectId: 'project', prompt: 'Use isolated worktree', agent: 'codex', mode: 'code', requestId: 'worktree', workspace: { mode: 'worktree' } });
    const failed = await until(f.engine, id, task => task.status === 'failed');
    const destination = failed.cwd; const commit = failed.executionWorkspace!.commit;
    assert.equal(executor.calls.length, 0); assert.equal(failed.runs?.[0].workspacePreparation?.status, 'failed');
    await rm(join(f.directory, 'worktrees'));
    await f.engine.taskPreparations.retry(id, failed.currentRunId!, 'retry-worktree');
    const completed = await until(f.engine, id, task => task.status === 'completed');
    assert.equal(completed.cwd, destination); assert.equal(git(completed.cwd, 'rev-parse', 'HEAD'), commit);
    assert.equal(completed.runs?.length, 1); assert.equal(completed.runs?.[0].id, failed.currentRunId); assert.equal(executor.calls.length, 1);
    assert.equal(await readFile(join(f.repo, 'file.txt'), 'utf8'), 'Source edits'); assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
  } finally { await f.close(); }
});

test('An upgraded preparation failure recovers its original Durable run metadata without executing anything', async () => {
  const f = await fixture(); const executor = f.executor as RecordingExecutor; let engine = f.engine;
  try {
    const failed = await failedCheckout(f);
    await engine.mutate(state => { delete state.tasks[0].runs; delete state.tasks[0].currentRunId; });
    await engine.close(); engine = await new Engine(f.directory, executor).open();
    const restored = (await engine.snapshot()).tasks[0];
    assert.equal(executor.calls.length, 0); assert.equal(restored.currentRunId, failed.currentRunId);
    assert.equal(restored.runs?.[0].workspacePreparation?.status, 'failed'); assert.equal(restored.messages?.length, 1);
    git(f.repo, 'restore', 'file.txt'); await engine.taskPreparations.retry(restored.id, restored.currentRunId!, 'upgraded-retry');
    const completed = await until(engine, restored.id, task => task.status === 'completed');
    assert.equal(executor.calls.length, 1); assert.equal(completed.runs?.length, 1); assert.equal(completed.messages?.filter(message => message.role === 'user').length, 1);
  } finally { await engine.close(); await f.close(); }
});

test('Cancelling or recovering an external turn after a preparation retry settles its original logical run and never replays it', async () => {
  for (const action of ['cancel', 'restart']) {
    let calls = 0;
    const executor: Executor = {
      async run(request) {
        calls++;
        await request.update({ kind: 'session', threadId: 'retained-thread' });
        await request.update({ kind: 'turn', turnId: 'external-turn' });
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new Error('aborted'));
          request.signal.addEventListener('abort', abort, { once: true }); if (request.signal.aborted) abort();
        });
        return 'Never completed';
      }, async answer() {}, async steer() {},
    };
    const f = await fixture(executor); let engine = f.engine;
    try {
      const failed = await failedCheckout(f); git(f.repo, 'restore', 'file.txt');
      await engine.taskPreparations.retry(failed.id, failed.currentRunId!, 'retry-' + action);
      const running = await until(engine, failed.id, task => task.turnId === 'external-turn');
      assert.notEqual(String(running.durableId), running.currentRunId, 'The retry uses a separate Durable attempt');
      if (action === 'cancel') await engine.cancel(failed.id);
      else { await engine.close(); engine = await new Engine(f.directory, executor).open(); }
      const settled = await until(engine, failed.id, task => task.status === (action === 'cancel' ? 'cancelled' : 'interrupted'));
      assert.equal(settled.runs?.length, 1); assert.equal(settled.runs?.[0].id, failed.currentRunId);
      assert.equal(settled.runs?.[0].status, settled.status); assert.equal(calls, 1);
    } finally { await engine.close(); await f.close(); }
  }
});
