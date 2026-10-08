import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planWorkspace, prepareWorkspace, workspaceOptions, workspaceSelection } from '../src/task-workspace.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, Workspace, WorkItem } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-task-workspace-')));
  const repo = join(directory, 'repo'); await mkdir(repo); git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'tracked.txt'), 'committed');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Friday Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  git(repo, 'branch', 'feature/other');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  return { directory, repo, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('Workspace options list local and remote branches without changing the checkout; validate inputs', async () => {
  const f = await fixture();
  try {
    const options = await workspaceOptions(f.repo);
    assert.deepEqual(options.branches.map(b => b.ref), ['refs/heads/feature/other', 'refs/heads/main', 'refs/remotes/origin/main']);
    assert.equal(options.hasCommit, true);
    assert.equal(options.branches[2].remote, true);
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    assert.deepEqual(workspaceSelection({ mode: 'worktree', branch: 'refs/heads/main' }), { mode: 'worktree', branch: 'refs/heads/main' });
    for (const value of [null, [], { mode: 'bad' }, { mode: 'worktree', branch: 1 }, { mode: 'checkout', branch: 'x\n-y' }]) assert.throws(() => workspaceSelection(value));
    await assert.rejects(planWorkspace({ mode: 'checkout', branch: '--discard-changes' }, f.repo, f.directory, 'bad'), /不存在/);
    await assert.rejects(planWorkspace({ mode: 'checkout', branch: 'refs/remotes/origin/main' }, f.repo, f.directory, 'remote'), /New Worktree/);
    const nonGit = await planWorkspace({ mode: 'checkout' }, f.directory, f.directory, 'plain');
    assert.equal(nonGit.state, 'ready');
    await assert.rejects(planWorkspace({ mode: 'worktree' }, f.directory, f.directory, 'bad'), /非 Git/);
    const unborn = join(f.directory, 'unborn'); await mkdir(unborn); git(unborn, 'init', '-b', 'new');
    assert.equal((await workspaceOptions(unborn)).hasCommit, false);
    const unbornPlan = await planWorkspace({ mode: 'checkout' }, unborn, f.directory, 'unborn');
    await prepareWorkspace(unbornPlan, async () => assert.fail('Already on the unborn branch'));
    await assert.rejects(planWorkspace({ mode: 'worktree' }, unborn, f.directory, 'bad'), /至少一个提交/);
  } finally { await f.cleanup(); }
});

test('Current checkout switches only on preparation and refuses to carry uncommitted changes', async () => {
  const f = await fixture();
  try {
    const plan = await planWorkspace({ mode: 'checkout', branch: 'refs/heads/feature/other' }, f.repo, f.directory, 'local');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    await assert.rejects(prepareWorkspace(plan, async () => assert.fail('Cancelled before mutation'), AbortSignal.abort()));
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    await writeFile(join(f.repo, 'tracked.txt'), 'unsaved');
    await assert.rejects(prepareWorkspace(plan, async () => assert.fail('Must reject before mutation')), /未提交/);
    const same = await planWorkspace({ mode: 'checkout' }, f.repo, f.directory, 'same');
    await prepareWorkspace(same, async () => assert.fail('No switch necessary'));
    assert.equal(await readFile(join(f.repo, 'tracked.txt'), 'utf8'), 'unsaved');
    git(f.repo, 'restore', 'tracked.txt');
    let started = 0;
    await prepareWorkspace(plan, async () => { started++; });
    assert.equal(started, 1); assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/other');
    // Explicit retry inspects a switch whose receipt was lost; it does not switch again.
    plan.state = 'preparing';
    await prepareWorkspace(plan, async () => assert.fail('Never replay'));
    git(f.repo, 'switch', 'main');
    await assert.rejects(prepareWorkspace(plan, async () => assert.fail('Never replay')), /不会自动重复/);
  } finally { await f.cleanup(); }
});

test('New Worktree pins the chosen commit, leaves dirty source untouched, and reconciles uncertain operations', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.repo, 'tracked.txt'), 'local edits');
    const plan = await planWorkspace({ mode: 'worktree', branch: 'refs/remotes/origin/main' }, f.repo, f.directory, 'isolated');
    await assert.rejects(realpath(plan.cwd));
    const later = git(f.repo, '-c', 'user.name=Friday Test', '-c', 'user.email=test@example.invalid', 'commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'Later remote commit');
    git(f.repo, 'update-ref', 'refs/remotes/origin/main', later);
    assert.notEqual(later, plan.commit, 'The selected branch advances while the task is queued');
    await prepareWorkspace(plan, async () => { plan.state = 'preparing'; });
    assert.equal(git(plan.cwd, 'rev-parse', 'HEAD'), plan.commit);
    assert.equal(git(plan.cwd, 'branch', '--show-current'), 'linc/task-isolated');
    assert.equal(await readFile(join(plan.cwd, 'tracked.txt'), 'utf8'), 'committed');
    assert.equal(await readFile(join(f.repo, 'tracked.txt'), 'utf8'), 'local edits');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    await prepareWorkspace(plan, async () => assert.fail('Never repeat worktree add'));
    const interrupted = await planWorkspace({ mode: 'worktree' }, f.repo, f.directory, 'interrupted');
    interrupted.state = 'preparing';
    await assert.rejects(prepareWorkspace(interrupted, async () => assert.fail('Never replay')), /不会自动重复/);
    git(f.repo, 'checkout', '--detach');
    const detached = await planWorkspace({ mode: 'worktree' }, f.repo, f.directory, 'detached');
    await prepareWorkspace(detached, async () => {});
    assert.equal(git(detached.cwd, 'rev-parse', 'HEAD'), detached.commit);
  } finally { await f.cleanup(); }
});

class RecordingExecutor implements Executor {
  calls: ExecutionRequest[] = [];
  async run(request: ExecutionRequest) {
    this.calls.push(request);
    assert.equal(request.task.executionWorkspace?.state, 'ready');
    await request.update({ kind: 'session', threadId: `session-${request.task.id}` });
    return git(request.task.cwd, 'branch', '--show-current');
  }
  async answer() {}
  async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Task did not settle');
}

function existingTask(cwd: string, id = 'existing'): WorkItem {
  return { id, cwd, title: 'Existing conversation', prompt: 'Original request', projectId: null, agent: 'codex', mode: 'research',
    status: 'completed', createdAt: '2026-10-08', updatedAt: '2026-10-08', durableId: null, threadId: 'original-thread', turnId: null,
    result: 'Original result', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'original',
    messages: [{ id: 'original-message', role: 'user', text: 'Keep this conversation' }] };
}

test('Existing tasks switch branches through Durable without a new agent turn or changing their conversation', async () => {
  const f = await fixture(); const directory = join(f.directory, 'service');
  let calls = 0;
  const executor: Executor = { async run(request) { calls++; assert.equal(request.task.threadId, 'original-thread'); return git(request.task.cwd, 'branch', '--show-current'); }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor).open(); const auth = new Auth(directory);
  try {
    const original = existingTask(f.repo);
    await engine.mutate(s => { s.tasks.push(original); });
    let app = createAPI(engine, auth, () => []);
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const switchTo = (branch: string, requestId: string) => app.request('/api/tasks/existing/branch', { method: 'POST', headers, body: JSON.stringify({ branch, requestId }) });
    assert.equal((await app.request('/api/tasks/existing/git')).status, 401);
    assert.equal((await app.request('/api/tasks/unknown/git', { headers })).status, 404);
    assert.equal((await (await app.request('/api/tasks/existing/git', { headers })).json()).git.branch, 'main');
    // Populate the display cache before the mutation; completion invalidates it immediately.
    await app.request('/api/state', { headers });
    const results = await Promise.all([switchTo('refs/heads/feature/other', 'switch'), switchTo('refs/heads/feature/other', 'switch')]);
    assert.ok(results.every(result => result.status === 202));
    let state = await until(engine, s => s.tasks[0].branchChange?.status === 'completed');
    assert.equal(calls, 0);
    assert.equal(state.tasks[0].cwd, original.cwd);
    assert.equal(state.tasks[0].threadId, original.threadId);
    assert.deepEqual(state.tasks[0].messages, original.messages);
    assert.equal(state.tasks[0].status, 'completed');
    assert.equal((await (await app.request('/api/state', { headers })).json()).tasks[0].git.branch, 'feature/other');
    await writeFile(join(f.repo, 'tracked.txt'), 'uncommitted');
    assert.equal((await switchTo('refs/heads/main', 'dirty')).status, 202);
    state = await until(engine, s => s.tasks[0].branchChange?.status === 'failed');
    assert.match(state.tasks[0].branchChange!.error!, /未提交/);
    assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/other');
    assert.equal(await readFile(join(f.repo, 'tracked.txt'), 'utf8'), 'uncommitted');
    assert.equal((await switchTo('refs/remotes/origin/main', 'remote')).status, 400);
    assert.equal((await switchTo('refs/heads/deleted', 'deleted')).status, 400);
    assert.equal((await switchTo('refs/heads/main', 'switch')).status, 400, 'A request ID cannot target another branch');
    await engine.close(); engine = await new Engine(directory, executor).open(); app = createAPI(engine, auth, () => []);
    assert.equal((await switchTo('refs/heads/feature/other', 'switch')).status, 202);
    assert.equal(calls, 0);
    await engine.createTask({ prompt: 'Continue', projectId: null, mode: 'research', requestId: 'continue-existing', continueId: 'existing' });
    state = await until(engine, s => s.tasks[0].status === 'completed' && s.tasks[0].lastRequestId === 'continue-existing');
    assert.equal(calls, 1); assert.equal(state.tasks[0].result, 'feature/other');
  } finally { await engine.close(); auth.close(); await f.cleanup(); }
});

test('An existing Worktree task switches its own checkout and blocks changes while a sibling task is active', async () => {
  const f = await fixture(); const directory = join(f.directory, 'service');
  const linked = join(f.directory, 'linked'); git(f.repo, 'worktree', 'add', '-b', 'linc/existing', linked);
  const engine = await new Engine(directory, new RecordingExecutor()).open();
  try {
    await engine.mutate(s => { s.tasks.push(existingTask(linked)); });
    await engine.switchTaskBranch('existing', 'refs/heads/feature/other', 'linked-switch');
    await until(engine, s => s.tasks[0].branchChange?.status === 'completed');
    assert.equal(git(linked, 'branch', '--show-current'), 'feature/other');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    await engine.mutate(s => { s.tasks.push({ ...existingTask(linked, 'busy'), status: 'running' }); });
    await assert.rejects(engine.switchTaskBranch('existing', 'refs/heads/linc/existing', 'busy-switch'), /正在执行或排队/);
    assert.equal(git(linked, 'branch', '--show-current'), 'feature/other');
    await engine.mutate(s => { s.tasks[1].status = 'completed'; s.tasks[0].status = 'queued'; });
    await assert.rejects(engine.switchTaskBranch('existing', 'refs/heads/linc/existing', 'self-busy'), /正在执行或排队/);
  } finally { await engine.close(); await f.cleanup(); }
});

test('Queued branch changes reserve the checkout, survive restart and deduplicate a lost response', async () => {
  const f = await fixture(); const directory = join(f.directory, 'service');
  const executor: Executor = { async run(request) { await new Promise<void>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); return ''; }, async answer() {}, async steer() {} };
  let engine = await new Engine(directory, executor).open();
  try {
    // This unrelated task holds the local agent lane, leaving the switch queued.
    await engine.createTask({ prompt: 'Wait elsewhere', projectId: null, mode: 'research', agent: 'codex', requestId: 'hold' });
    await until(engine, s => s.tasks[0]?.status === 'running');
    await engine.mutate(s => { s.tasks.push(existingTask(f.repo)); });
    await engine.switchTaskBranch('existing', 'refs/heads/feature/other', 'queued-switch');
    await assert.rejects(engine.createTask({ prompt: 'Continue', projectId: null, mode: 'research', continueId: 'existing', requestId: 'racing-turn' }), /正在切换分支/);
    await assert.rejects(engine.switchTaskBranch('existing', 'refs/heads/main', 'racing-switch'), /正在切换分支/);
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    await engine.close(); engine = await new Engine(directory, executor).open();
    await until(engine, s => s.tasks[1].branchChange?.status === 'completed');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'feature/other');
    git(f.repo, 'switch', 'main');
    await engine.switchTaskBranch('existing', 'refs/heads/feature/other', 'queued-switch');
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main', 'A retried old request never repeats the side effect');
  } finally { await engine.close(); await f.cleanup(); }
});

test('API persists selection, deduplicates concurrent submissions, executes in Worktree and resumes there after restart', async () => {
  const f = await fixture(); const directory = join(f.directory, 'service');
  const executor = new RecordingExecutor(); let engine = await new Engine(directory, executor).open();
  const auth = new Auth(directory);
  try {
    await engine.mutate(s => s.projects.push({ id: 'project', name: 'Fixture', path: f.repo, context: '' }));
    let app = createAPI(engine, auth, () => []);
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    assert.equal((await app.request('/api/projects/project/git')).status, 401);
    assert.equal((await app.request('/api/projects/missing/git', { headers })).status, 404);
    const options = await (await app.request('/api/projects/project/git', { headers })).json();
    assert.equal(options.git.branch, 'main');
    const body = { prompt: 'Inspect the workspace', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'worktree', workspace: { mode: 'worktree', branch: 'refs/heads/feature/other' } };
    const responses = await Promise.all([1, 2].map(() => app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify(body) })));
    assert.ok(responses.every(r => r.status === 201));
    const ids = await Promise.all(responses.map(r => r.json())); assert.equal(ids[0].id, ids[1].id);
    const id = ids[0].id;
    let state = await until(engine, s => s.tasks[0]?.status === 'completed');
    const task = state.tasks[0];
    assert.equal(task.projectId, 'project'); assert.notEqual(task.cwd, f.repo);
    assert.equal(task.executionWorkspace?.branch, 'refs/heads/feature/other');
    assert.equal(task.result, `linc/task-${id}`);
    assert.equal(executor.calls.length, 1);
    await engine.close(); engine = await new Engine(directory, executor).open(); app = createAPI(engine, auth, () => []);
    const continued = await app.request(`/api/tasks/${id}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'Continue here', requestId: 'continue' }) });
    assert.equal(continued.status, 200);
    state = await until(engine, s => s.tasks[0].status === 'completed');
    assert.equal(state.tasks[0].cwd, task.cwd);
    assert.equal(executor.calls.length, 2); assert.equal(executor.calls[1].task.threadId, `session-${id}`);
    assert.equal(git(f.repo, 'branch', '--show-current'), 'main');
    const invalid = await app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ ...body, requestId: 'invalid', workspace: { mode: 'worktree', branch: 'missing' } }) });
    assert.equal(invalid.status, 400);
    assert.equal((await engine.snapshot()).tasks.length, 1);
  } finally { await engine.close(); auth.close(); await f.cleanup(); }
});
