import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readGitContext, TaskGitContexts, gitRefreshInterval } from '../src/git-context.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { WorkItem, Workspace } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const task = (id: string, cwd: string): WorkItem => ({
  id, cwd, title: 'Branch display', prompt: '', projectId: null, agent: 'codex', mode: 'code', status: 'completed',
  createdAt: '2026-10-07', updatedAt: '2026-10-07', durableId: null, threadId: null, turnId: null,
  result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: id,
});
const workspace = (tasks: WorkItem[]): Workspace => ({ revision: 1, ideas: [], projects: [], memories: [], requests: {}, tasks });

test('Reads real branches, unborn branches, nested directories, linked worktrees and detached HEAD', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-git-'));
  try {
    const repo = join(directory, 'repo'); await mkdir(repo); git(repo, 'init', '-b', 'feature/sidebar');
    assert.deepEqual(await readGitContext(repo), { status: 'repository', branch: 'feature/sidebar', head: null, isWorktree: false });
    git(repo, '-c', 'user.name=Friday Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Fixture');
    const subdir = join(repo, 'nested'); await mkdir(subdir);
    assert.deepEqual(await readGitContext(subdir), await readGitContext(repo));
    const linked = join(directory, 'linked'); git(repo, 'worktree', 'add', '-b', 'feature/worktree', linked);
    assert.deepEqual(await readGitContext(linked), { status: 'repository', branch: 'feature/worktree', head: null, isWorktree: true });
    git(linked, 'checkout', '--detach');
    assert.deepEqual(await readGitContext(linked), { status: 'repository', branch: null, head: git(linked, 'rev-parse', '--short=8', 'HEAD'), isWorktree: true });
    assert.deepEqual(await readGitContext(directory), { status: 'not_repository' });
    assert.deepEqual(await readGitContext(join(directory, 'missing')), { status: 'unavailable' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Git environment overrides cannot redirect inspection to a different repository', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-git-env-'));
  const previous = process.env.GIT_DIR;
  try {
    git(directory, 'init', '-b', 'real-branch');
    process.env.GIT_DIR = '/nonexistent/other-repository';
    assert.deepEqual(await readGitContext(directory), { status: 'repository', branch: 'real-branch', head: null, isWorktree: false });
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('Metadata shares reads across tasks and clients, refreshes and never changes persisted state', async () => {
  let now = 0; let reads = 0; let branch = 'before'; let active = 0; let peak = 0;
  const contexts = new TaskGitContexts(async () => {
    reads++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return { status: 'repository', branch, head: null, isWorktree: false };
  }, () => now);
  const state = workspace(Array.from({ length: 20 }, (_, i) => task(String(i), `/repo/${i % 7}`)));
  await Promise.all([contexts.snapshot(state), contexts.snapshot(state)]);
  assert.equal(reads, 7); assert.ok(peak <= 4);
  assert.ok(state.tasks.every(task => task.git === undefined));
  branch = 'after'; now += gitRefreshInterval + 1;
  const refreshed = await contexts.snapshot(state);
  assert.equal(reads, 14); assert.equal(refreshed.revision, state.revision);
  assert.ok(refreshed.tasks.every(task => task.git?.status === 'repository' && task.git.branch === 'after'));
});

test('State and SSE publish Git changes without a task mutation or service restart', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-git-api-'));
  const repo = join(directory, 'repo'); await mkdir(repo); git(repo, 'init', '-b', 'before');
  const engine = await new Engine(join(directory, 'service')).open(); const auth = new Auth(join(directory, 'service'));
  const app = createAPI(engine, auth, () => []);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await engine.mutate(state => { state.tasks.push(task('git-task', repo)); });
    const headers = { Authorization: `Bearer ${auth.token}` };
    const state = await (await app.request('/api/state', { headers })).json();
    assert.equal(state.tasks[0].git.branch, 'before');
    reader = (await app.request('/api/events', { headers })).body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /"branch":"before"/);
    git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/after');
    let updated = '';
    while (!updated.includes('"branch":"after"')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      updated = new TextDecoder().decode(chunk.value);
    }
    assert.match(updated, new RegExp(`"revision":${state.revision}`));
    assert.equal((await engine.snapshot()).tasks[0].git, undefined);
    assert.equal((await (await app.request('/api/state', { headers })).json()).tasks[0].git.branch, 'after');
  } finally { await reader?.cancel(); await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
