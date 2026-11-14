import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { existingFridayData, fridayPaths, personalWorkspaceDefault, prepareFridayPaths } from '../src/friday-paths.mjs';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'friday-home-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, env: {} };
}

test('New installations use one private Friday home with separate data, workspace and logs', async t => {
  const options = await setup(t);
  const paths = await prepareFridayPaths(options);
  assert.equal(paths.root, join(options.home, '.friday'));
  assert.equal(paths.data, join(paths.root, 'data'));
  assert.equal(paths.workspace, join(paths.root, 'workspace'));
  assert.equal(paths.logs, join(paths.root, 'logs'));
  for (const path of [paths.root, paths.data, paths.workspace, paths.logs]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal(personalWorkspaceDefault(paths.data, options), paths.workspace);
  assert.deepEqual(await prepareFridayPaths(options), paths);
  await assert.rejects(stat(paths.legacy), /ENOENT/);
});

test('Legacy adoption retains credentials, absolute paths, workspace and the live SQLite lease', async t => {
  const options = await setup(t), paths = fridayPaths(options);
  await mkdir(join(paths.legacy, 'workspace'), { recursive: true });
  await writeFile(join(paths.legacy, 'owner-token'), 'synthetic-owner-token');
  await writeFile(join(paths.legacy, 'workspace', 'note.md'), 'Existing personal file');
  const database = new DatabaseSync(join(paths.legacy, 'owner.sqlite'));
  database.exec('CREATE TABLE owner (id INTEGER); BEGIN IMMEDIATE');
  try {
    assert.equal(existingFridayData(options), paths.legacy);
    await prepareFridayPaths(options);
    assert.equal(await realpath(paths.data), paths.legacy);
    assert.equal(await readFile(join(paths.data, 'owner-token'), 'utf8'), 'synthetic-owner-token');
    assert.equal(await realpath(paths.workspace), join(paths.legacy, 'workspace'));
    assert.equal(await readFile(join(paths.workspace, 'note.md'), 'utf8'), 'Existing personal file');
    const contender = new DatabaseSync(join(paths.data, 'owner.sqlite'));
    try { assert.throws(() => contender.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'), /locked/); }
    finally { contender.close(); }
    assert.equal(personalWorkspaceDefault(paths.legacy, options), paths.workspace);
    assert.equal(existingFridayData(options), paths.data);
    await prepareFridayPaths(options);
  } finally { database.close(); }
});

test('Independent old and new databases are never merged or silently selected at startup', async t => {
  const options = await setup(t), paths = fridayPaths(options);
  await mkdir(paths.legacy, { recursive: true }); await mkdir(paths.data, { recursive: true });
  await writeFile(join(paths.legacy, 'owner-token'), 'old'); await writeFile(join(paths.data, 'owner-token'), 'new');
  await assert.rejects(prepareFridayPaths(options), /目录冲突/);
  assert.equal(await readFile(join(paths.legacy, 'owner-token'), 'utf8'), 'old');
  assert.equal(await readFile(join(paths.data, 'owner-token'), 'utf8'), 'new');
});

test('Explicit data overrides stay isolated, with their own workspace and logs', async t => {
  const options = await setup(t), data = join(options.home, 'development-data');
  const configured = { ...options, env: { FRIDAY_DATA_DIR: data } };
  const paths = await prepareFridayPaths(configured);
  assert.equal(paths.data, data); assert.equal(paths.workspace, join(data, 'workspace'));
  assert.equal(paths.logs, join(data, 'logs'));
  assert.equal(personalWorkspaceDefault(data, configured), paths.workspace);
  await assert.rejects(stat(join(options.home, '.friday')), /ENOENT/);
});

test('Explicit Friday home relocates all defaults without adopting the default host data', async t => {
  const options = await setup(t), defaults = fridayPaths(options);
  await mkdir(defaults.legacy, { recursive: true });
  await writeFile(join(defaults.legacy, 'owner-token'), 'default-host');
  const configured = { ...options, env: { FRIDAY_HOME: join(options.home, 'alternate-home') } };
  const paths = await prepareFridayPaths(configured);
  assert.equal(await realpath(paths.data), join(configured.env.FRIDAY_HOME, 'data'));
  assert.equal(personalWorkspaceDefault(paths.data, configured), paths.workspace);
  await assert.rejects(readFile(join(paths.data, 'owner-token')), /ENOENT/);
  assert.equal(await readFile(join(defaults.legacy, 'owner-token'), 'utf8'), 'default-host');
});

test('A disconnected compatibility link fails instead of creating an empty replacement host', async t => {
  const options = await setup(t), paths = fridayPaths(options);
  await mkdir(paths.root); await symlink(join(options.home, 'missing-volume'), paths.data);
  await assert.rejects(prepareFridayPaths(options));
  await assert.rejects(stat(join(paths.data, 'owner-token')), /ENOENT/);
});

test('Conflicting personal workspaces are preserved and reported', async t => {
  const options = await setup(t), paths = fridayPaths(options);
  await mkdir(join(paths.legacy, 'workspace'), { recursive: true });
  await mkdir(paths.workspace, { recursive: true });
  await writeFile(join(paths.legacy, 'workspace', 'old.md'), 'old');
  await writeFile(join(paths.workspace, 'new.md'), 'new');
  await assert.rejects(prepareFridayPaths(options), /目录冲突/);
  assert.equal(await readFile(join(paths.legacy, 'workspace', 'old.md'), 'utf8'), 'old');
  assert.equal(await readFile(join(paths.workspace, 'new.md'), 'utf8'), 'new');
});
