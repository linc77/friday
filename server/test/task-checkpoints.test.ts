import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { taskGit } from '../src/git-process.js';
import { TaskCheckpoints } from '../src/task-checkpoints.js';
import type { TaskCheckpoint, WorkItem } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, nested = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-checkpoint-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'source'); const directory = nested ? join(root, '.private') : join(base, 'private');
  await mkdir(root); await mkdir(directory);
  const git = (args: string[], env?: NodeJS.ProcessEnv) => taskGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { env });
  await git(['init', '-q', '--initial-branch=main']);
  const put = (path: string, value: string | Buffer) => writeFile(join(root, path), value);
  const checkpoints = new TaskCheckpoints(directory);
  const work: WorkItem = { id: 'fixture', title: 'Fixture', prompt: 'Fixture', projectId: 'project', cwd: root, agent: 'codex', mode: 'code',
    status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durableId: 1, threadId: null, turnId: null,
    result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'fixture' };
  const capture = async (run: string, phase: 'before' | 'after', task = work) => {
    const value = await checkpoints.capture(task, run, phase);
    assert.equal(value.status, 'ready', value.status === 'unavailable' ? value.error : value.status);
    return value as Extract<TaskCheckpoint, { status: 'ready' }>;
  };
  return { root, directory, git, put, checkpoints, work, capture };
}

test('Turn snapshots preserve source index, private boundaries, dirty baselines, binary files, symlinks and special rename paths', async t => {
  const { root, directory, git, put, checkpoints, capture } = await fixture(t, true);
  await put('code.txt', 'base\n'); await put('rename [old]\n.txt', 'rename\n'); await put('binary', Buffer.from([0, 1, 255]));
  await put('.gitignore', 'ignored\n'); await put('.private/credential', 'fixture-private-secret');
  await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  await put('code.txt', 'already dirty\n'); await put('ignored', 'tracked despite ignore\n'); await git(['add', '-f', 'ignored']);
  await put('staged.txt', 'staged\n'); await git(['add', 'staged.txt']); await put('staged.txt', 'staged then working\n');
  await git(['update-index', '--assume-unchanged', 'code.txt']);
  const sourceIndex = await readFile(join(root, '.git/index'));
  const before = await capture('1', 'before');
  assert.deepEqual(await readFile(join(root, '.git/index')), sourceIndex);
  const store = join(directory, 'checkpoints', before.repository);
  const names = (await taskGit(store, ['--git-dir=' + store, 'ls-tree', '-r', '--name-only', before.tree])).stdout;
  assert.doesNotMatch(names, /\.private/); assert.match(names, /ignored/);
  await put('code.txt', 'turn result\n'); await rename(join(root, 'rename [old]\n.txt'), join(root, 'rename [new]\n.txt'));
  await put('binary', Buffer.from([0, 2, 254])); await symlink('/outside/target', join(root, 'link'));
  const after = await capture('1', 'after');
  assert.deepEqual(await readFile(join(root, '.git/index')), sourceIndex);
  const changes = await checkpoints.changes(before, after);
  assert.deepEqual(new Set(changes.map(file => file.path)), new Set(['code.txt', 'rename [new]\n.txt', 'binary', 'link']));
  assert.equal(changes.find(file => file.path === 'rename [new]\n.txt')?.oldPath, 'rename [old]\n.txt');
  assert.equal(changes.find(file => file.path === 'binary')?.additions, null);
  const diff = await checkpoints.diff(before, after, changes, 'code.txt'); assert.match(diff.patch, /-already dirty\n\+turn result/);
  assert.doesNotMatch((await git(['for-each-ref', '--format=%(refname)'])).stdout, /friday/);
  await assert.rejects(checkpoints.diff(before, after, changes, '../.private/credential'), /相对文件路径/);
  await assert.rejects(checkpoints.diff(before, after, changes, '.private/credential'), /净改动/);
  // Re-capture of an acknowledged boundary is idempotent, even after edits.
  await put('code.txt', 'later edit\n'); assert.deepEqual(await capture('1', 'after'), after);
  await git(['gc', '--prune=now']);
  assert.match((await checkpoints.diff(before, after, changes, 'code.txt')).patch, /\+turn result/);
});

test('Private scoped trees survive source deletion and source GC without storing files outside the selected workspace', async t => {
  const { root, directory, git, put, checkpoints, work, capture } = await fixture(t);
  await mkdir(join(root, 'scope')); await put('scope/file', 'before\n'); await put('outside', 'must stay outside snapshot\n');
  await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  const scoped = { ...work, cwd: join(root, 'scope') };
  const before = await capture('1', 'before', scoped); await put('scope/file', 'after\n'); await put('scope/new', 'untracked source bytes\n');
  const after = await capture('1', 'after', scoped); const changes = await checkpoints.changes(before, after);
  const store = join(directory, 'checkpoints', before.repository);
  assert.equal((await taskGit(store, ['--git-dir=' + store, 'ls-tree', '-r', '--name-only', before.tree])).stdout, 'file\n');
  await git(['gc', '--prune=now']); await rm(root, { recursive: true, force: true });
  await taskGit(store, ['--git-dir=' + store, 'gc', '--prune=now']);
  assert.deepEqual(await checkpoints.saved(work.id, '1', 'after', before), after);
  assert.match((await checkpoints.diff(before, after, changes, 'new')).patch, /\+untracked source bytes/);
  assert.match((await checkpoints.diff(before, after, changes, 'file')).patch, /-before\n\+after/);
});

test('Unborn and sparse repositories capture net worktree contents while retaining absent sparse files and the user index', async t => {
  const { root, git, put, checkpoints, capture } = await fixture(t);
  await put('first', 'before\n'); const unborn = await capture('0', 'before'); await put('first', 'after\n');
  const unbornAfter = await capture('0', 'after'); assert.equal((await checkpoints.changes(unborn, unbornAfter))[0]?.path, 'first');
  await mkdir(join(root, 'selected')); await mkdir(join(root, 'sparse'));
  await put('selected/file', 'selected\n'); await put('sparse/absent', 'sparse absent\n');
  await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  await git(['sparse-checkout', 'init', '--cone', '--sparse-index']); await git(['sparse-checkout', 'set', 'selected']);
  const index = await readFile(join(root, '.git/index'));
  const before = await capture('1', 'before'); await put('selected/file', 'selected after\n'); const after = await capture('1', 'after');
  assert.deepEqual(await readFile(join(root, '.git/index')), index);
  assert.deepEqual((await checkpoints.changes(before, after)).map(file => file.path), ['selected/file']);
});

test('Turn net changes remove clean incoming commits while retaining edits made during the turn', async t => {
  const { git, put, checkpoints, capture } = await fixture(t);
  await put('local', 'local before\n'); await put('upstream', 'upstream before\n'); await git(['add', '.']); await git(['commit', '-qm', 'Initial']);
  await git(['switch', '-qc', 'upstream-fixture']); await put('upstream', 'old upstream change\n'); await git(['add', 'upstream']);
  await git(['commit', '-qm', 'An old upstream commit'], { GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
  await git(['switch', '-q', 'main']);
  const before = await capture('1', 'before'); await git(['merge', '--ff-only', 'upstream-fixture']); await put('local', 'local after\n');
  const after = await capture('1', 'after');
  assert.deepEqual((await checkpoints.changes(before, after)).map(file => file.path), ['local']);
  const nextBefore = await capture('2', 'before'); await put('local', 'committed this turn\n'); await git(['add', 'local']); await git(['commit', '-qm', 'Turn commit']);
  const nextAfter = await capture('2', 'after'); assert.deepEqual((await checkpoints.changes(nextBefore, nextAfter)).map(file => file.path), ['local']);
});
