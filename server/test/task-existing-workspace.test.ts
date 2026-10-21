import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { planExistingTaskWorkspace, workspaceSelection } from '../src/task-workspace.js';
import { contextLink } from '../src/task-context-types.js';
import type { ExecutionRequest, WorkItem } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-existing-workspace-'))), repo = join(directory, 'repo');
  await mkdir(repo); git(repo, 'init', '-b', 'main'); await writeFile(join(repo, 'tracked'), 'original'); git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial');
  return { directory, repo };
}
function source(cwd: string): WorkItem {
  const at = new Date().toISOString();
  return { id: 'source', projectId: 'project', cwd, title: 'Source', prompt: 'Source prompt', result: 'Original result', agent: 'codex', mode: 'code', status: 'completed',
    createdAt: at, updatedAt: at, durableId: null, threadId: 'original-native-session', turnId: null, events: [], approvals: [], artifact: null, error: null, lastRequestId: 'original-request' };
}

test('Existing checkout selection validates the registered repository and exact branch without touching dirty files', async t => {
  const { directory, repo } = await fixture(); t.after(() => rm(directory, { recursive: true, force: true }));
  const worktree = join(directory, 'worktree'); git(repo, 'worktree', 'add', '-b', 'topic', worktree); await mkdir(join(worktree, 'nested'));
  await writeFile(join(worktree, 'tracked'), 'uncommitted'); await writeFile(join(worktree, 'untracked'), 'kept');
  const original = source(join(worktree, 'nested'));
  const selected = workspaceSelection({ mode: 'worktree', branch: 'refs/heads/topic', reuseTaskId: original.id })!;
  const before = git(worktree, 'status', '--porcelain'), plan = await planExistingTaskWorkspace(selected, repo, original);
  assert.equal(plan.cwd, original.cwd); assert.equal(plan.root, worktree); assert.equal(plan.state, 'ready'); assert.equal(plan.commit, git(worktree, 'rev-parse', 'HEAD'));
  assert.equal(plan.reuseBranch, true); assert.equal(git(worktree, 'status', '--porcelain'), before); assert.equal(await readFile(join(worktree, 'tracked'), 'utf8'), 'uncommitted');
  await assert.rejects(planExistingTaskWorkspace({ ...selected, branch: 'refs/heads/main' }, repo, original), /已经改变/);
  await assert.rejects(planExistingTaskWorkspace({ ...selected, mode: 'checkout' }, repo, original), /已经改变/);
  const foreign = join(directory, 'foreign'); await mkdir(foreign); git(foreign, 'init', '-b', 'main');
  await assert.rejects(planExistingTaskWorkspace(selected, foreign, original), /不匹配/);
  git(worktree, 'branch', '-m', 'renamed'); await assert.rejects(planExistingTaskWorkspace(selected, repo, original), /已经改变/);
  for (const invalid of [{ mode: 'worktree', reuseTaskId: 'source' }, { mode: 'checkout', reuseTaskId: '../source', branch: 'main' },
    { mode: 'worktree', reuseTaskId: 'source', branch: 'refs/heads/topic', startFromOrigin: false },
    { mode: 'worktree', reuseTaskId: 'source', preparationId: '00000000-0000-0000-0000-000000000001' }]) assert.throws(() => workspaceSelection(invalid));
});

test('A new task on the same branch gets a fresh native session, reuses its checkout, and survives restart without setup or replay', async t => {
  const { directory, repo } = await fixture(), worktree = join(directory, 'worktree'), data = join(directory, 'data');
  git(repo, 'worktree', 'add', '-b', 'topic', worktree); await writeFile(join(worktree, 'tracked'), 'local changes');
  const calls: ExecutionRequest[] = [];
  const executor = { async run(request: ExecutionRequest) { calls.push(request); await request.update({ kind: 'session', threadId: 'new-native-session' }); return 'New result'; }, async answer() {}, async steer() {} };
  const options = { changeRequestSyncIntervalMs: 0 };
  let engine = await new Engine(data, executor, undefined, options).open();
  const auth = new Auth(data); let app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const original = source(worktree);
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Project', path: repo, context: '' }, { id: 'other', name: 'Other registration', path: repo, context: '' }]; state.tasks = [original]; });
  const reference = await engine.contexts.capture({ id: 'existing-checkout-file', scope: { taskId: original.id }, kind: 'file', path: 'tracked' });
  const input = { prompt: 'Independent work ' + contextLink(reference), contextIds: [reference.id], requestId: 'new-on-branch', projectId: 'project', agent: 'codex' as const, mode: 'code' as const,
    workspace: workspaceSelection({ mode: 'worktree', branch: 'refs/heads/topic', reuseTaskId: 'source' })! };
  assert.equal((await app.request('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  const responses = await Promise.all([0, 1].map(() => app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify(input) })));
  assert(responses.every(response => response.status === 201));
  const receipts = await Promise.all(responses.map(response => response.json() as Promise<{ id: string }>));
  const id = receipts[0].id, deadline = Date.now() + 5000; assert.equal(receipts[1].id, id);
  while ((await engine.snapshot()).tasks.find(task => task.id === id)?.status !== 'completed') { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const created = (await engine.snapshot()).tasks.find(task => task.id === id)!;
  assert.notEqual(id, original.id); assert.equal(created.cwd, worktree); assert.equal(created.threadId, 'new-native-session');
  assert.equal(created.parentId, undefined); assert.equal(created.planOrigin, undefined); assert.equal(calls.length, 1);
  assert.equal(calls[0].task.threadId, null); assert.equal(calls[0].task.cwd, worktree); assert(!calls[0].prompt.includes('Source prompt'));
  assert.match(calls[0].prompt, /local changes/); assert.equal(created.messages?.[0].contexts?.[0].id, reference.id);
  assert.equal(created.executionWorkspace?.state, 'ready'); assert.equal((await engine.snapshot()).projectScriptRuns?.length ?? 0, 0);
  assert.equal((await engine.snapshot()).tasks.find(task => task.id === 'source')?.threadId, 'original-native-session');
  assert.equal(git(repo, 'branch', '--show-current'), 'main'); assert.equal(git(worktree, 'branch', '--show-current'), 'topic'); assert.equal(await readFile(join(worktree, 'tracked'), 'utf8'), 'local changes');
  await assert.rejects(engine.createTask({ ...input, requestId: 'wrong-project', projectId: 'other' }), /不属于/);
  await assert.rejects(engine.createTask({ ...input, requestId: 'missing-source', workspace: { ...input.workspace, reuseTaskId: 'missing' } }), /不属于/);
  const invalid = await app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ ...input, requestId: 'invalid-existing', workspace: { ...input.workspace, startFromOrigin: true } }) });
  assert.equal(invalid.status, 400); assert.equal((await engine.snapshot()).taskExistingWorkspaceSupported, true);
  await engine.close(); engine = await new Engine(data, executor, undefined, options).open();
  app = createAPI(engine, auth, () => []);
  const replay = await app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(replay.status, 201); assert.equal((await replay.json()).id, id);
  assert.equal(calls.length, 1); assert.equal((await engine.snapshot()).tasks.find(task => task.id === id)?.cwd, worktree);
});
