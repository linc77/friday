import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readTaskChanges, readTaskDiff } from '../src/task-changes.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

const exec = promisify(execFile);
async function repository(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-changes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = async (...args: string[]) => (await exec('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args])).stdout;
  await git('init', '-q');
  const put = async (path: string, contents: string | Buffer) => writeFile(join(directory, path), contents);
  const commit = async () => { await git('add', '.'); await git('commit', '-qm', 'fixture'); };
  return { directory, git, put, commit };
}

test('Current Git changes distinguish staged, working, rename, untracked and binary files without quoting paths', async t => {
  const { directory, git, put, commit } = await repository(t);
  await put('old name.txt', 'one\ntwo\nthree\n'); await put('both.txt', 'original\n'); await put('binary', Buffer.from([0, 1, 2])); await commit();
  await rename(join(directory, 'old name.txt'), join(directory, 'new name\n.txt')); await git('add', '-A');
  await put('both.txt', 'staged\n'); await git('add', 'both.txt'); await put('both.txt', 'working\n');
  await put('binary', Buffer.from([0, 1, 3])); await put(':(glob)*.txt', 'new file\n');
  const all = await readTaskChanges(directory);
  assert.equal(all.status, 'repository');
  const moved = all.files.find(file => file.path === 'new name\n.txt')!;
  assert.equal(moved.oldPath, 'old name.txt'); assert.equal(moved.kind, 'rename'); assert.equal(moved.staged, true);
  assert.deepEqual(all.files.find(file => file.path === 'binary')?.additions, null);
  assert.ok(all.files.find(file => file.path === 'binary')?.binary);
  assert.equal(all.files.find(file => file.path === 'both.txt')?.unstaged, true);
  const staged = await readTaskDiff(directory, 'both.txt', 'staged');
  const working = await readTaskDiff(directory, 'both.txt', 'working');
  assert.match(staged.patch, /-original\n\+staged/); assert.match(working.patch, /-staged\n\+working/);
  assert.equal((await readTaskChanges(directory, 'staged')).files.some(file => file.kind === 'untracked'), false);
  const untracked = await readTaskDiff(directory, ':(glob)*.txt'); assert.match(untracked.patch, /\+new file/);
  const renameDiff = await readTaskDiff(directory, 'new name\n.txt'); assert.match(renameDiff.patch, /rename from old name/);
  assert.ok((await readTaskDiff(directory, 'binary')).binary);
});

test('An unborn repository compares all changes to current files and staged changes to its index', async t => {
  const { directory, git, put } = await repository(t);
  await put('first.txt', 'index\n'); await put('deleted.txt', 'gone\n'); await git('add', '.');
  await put('first.txt', 'working\nsecond line'); await rm(join(directory, 'deleted.txt')); await put('new.txt', 'new\n');
  const all = await readTaskChanges(directory); assert.deepEqual(all.files.map(file => file.path), ['first.txt', 'new.txt']);
  assert.equal(all.files[0]?.additions, 2);
  assert.match((await readTaskDiff(directory, 'first.txt')).patch, /\+working\n\+second line\n\\ No newline/);
  const staged = await readTaskChanges(directory, 'staged'); assert.equal(staged.files.length, 2);
  assert.match((await readTaskDiff(directory, 'first.txt', 'staged')).patch, /\+index/);
  const outside = await mkdtemp(join(tmpdir(), 'friday-no-git-')); t.after(() => rm(outside, { recursive: true, force: true }));
  assert.equal((await readTaskChanges(outside)).status, 'not_repository');
});

test('A task rooted in a Git subdirectory sees only that workspace, including rename boundaries', async t => {
  const { directory, put, commit, git } = await repository(t);
  await mkdir(join(directory, 'scope')); await put('outside.txt', 'outside original\n'); await put('scope/inside.txt', 'inside\n'); await commit();
  await put('outside.txt', 'outside private\n'); await put('scope/inside.txt', 'new inside\n');
  await rename(join(directory, 'outside.txt'), join(directory, 'scope/moved.txt')); await git('add', '-A');
  const cwd = join(directory, 'scope'); const files = (await readTaskChanges(cwd)).files;
  assert.deepEqual(files.map(file => file.path), ['inside.txt', 'moved.txt']);
  assert.equal(files.find(file => file.path === 'moved.txt')?.oldPath, undefined);
  const patch = (await readTaskDiff(cwd, 'moved.txt')).patch;
  assert.doesNotMatch(patch, /outside original|outside\.txt|\.\.\//);
  assert.match(patch, /\+outside private/);
  await assert.rejects(readTaskDiff(cwd, '../outside.txt'), /相对文件路径/);
  await assert.rejects(readTaskDiff(cwd, 'outside.txt'), /已不在当前改动/);
});

test('Symlink previews show link targets without reading the contents of outside files', async t => {
  const { directory } = await repository(t);
  const outside = await mkdtemp(join(tmpdir(), 'friday-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'private.txt'), 'PRIVATE CONTENT');
  await symlink(join(outside, 'private.txt'), join(directory, 'link.txt'));
  await symlink(outside, join(directory, 'folder'));
  const patch = (await readTaskDiff(directory, 'link.txt')).patch;
  assert.match(patch, /private\.txt/); assert.doesNotMatch(patch, /PRIVATE CONTENT/);
  await assert.rejects(readTaskDiff(directory, 'folder/private.txt'), /已不在当前改动/);
  await assert.rejects(readTaskDiff(directory, '.git/config'), /相对文件路径/);
});

test('Diff reads suppress repository diff drivers and Git environment overrides and bound large previews', async t => {
  const { directory, git, put, commit } = await repository(t);
  await put('.gitattributes', '*.txt diff=fixture\n'); await put('file.txt', 'before\n'); await commit();
  const marker = join(directory, 'driver-ran'); const driver = join(directory, 'driver');
  await put('driver', `#!/bin/sh\nprintf called > '${marker}'\n`); await chmod(driver, 0o755);
  await git('config', 'diff.fixture.command', driver); await git('config', 'diff.fixture.textconv', driver);
  await put('file.txt', 'after\n');
  const previous = process.env.GIT_DIR; process.env.GIT_DIR = '/nonexistent-friday-git-override';
  try { assert.match((await readTaskDiff(directory, 'file.txt')).patch, /\+after/); }
  finally { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; }
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await put('file.txt', 'large changed line\n'.repeat(60_000));
  const patch = await readTaskDiff(directory, 'file.txt'); assert.equal(patch.truncated, true); assert.ok(patch.patch.length <= 512 * 1024);
  await put('huge-untracked', 'x'.repeat(600_000));
  const huge = await readTaskDiff(directory, 'huge-untracked'); assert.equal(huge.truncated, true); assert.equal(huge.patch, '');
});

test('File APIs require authentication and use the persisted task workspace rather than a supplied cwd', async t => {
  const { directory, put, commit } = await repository(t); await put('file.txt', 'before\n'); await commit(); await put('file.txt', 'after\n');
  const data = await mkdtemp(join(tmpdir(), 'friday-diff-api-')); t.after(() => rm(data, { recursive: true, force: true }));
  const engine = await new Engine(data, { async run() { return 'done'; }, async steer() {}, async answer() {} }).open(); t.after(() => engine.close());
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Test', path: directory, context: '' }));
  const id = await engine.createTask({ prompt: 'inspect', projectId: 'project', mode: 'research', agent: 'codex', requestId: 'diff-test' });
  const auth = new Auth(data); const app = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}` };
  assert.equal((await app.request(`/api/tasks/${id}/changes`)).status, 401);
  const changes = await app.request(`/api/tasks/${id}/changes?cwd=/`, { headers }); assert.equal(changes.status, 200);
  assert.deepEqual((await changes.json()).files.map((file: { path: string }) => file.path), ['file.txt']);
  const diff = await app.request(`/api/tasks/${id}/diff?path=file.txt&scope=working`, { headers }); assert.match((await diff.json()).patch, /\+after/);
  assert.equal((await app.request(`/api/tasks/${id}/diff?path=..%2Foutside`, { headers })).status, 400);
  assert.equal((await app.request('/api/tasks/missing/changes', { headers })).status, 404);
});
