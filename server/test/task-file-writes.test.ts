import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest } from '../src/types.js';

const executor = { run: async (_request: ExecutionRequest) => 'fixture', steer: async () => {}, answer: async () => {} };
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-file-edit-'))), root = join(base, 'project'), data = join(root, 'runtime'); await mkdir(root);
  let engine = await new Engine(data, executor).open(); t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  await writeFile(join(root, 'code.swift'), 'before\n');
  const files = (await engine.contexts.owner({ projectId: 'project' })).files, preview = await files.preview('code.swift');
  const input = (requestId: string, revision: number, contents: string, path = 'code.swift') => ({ requestId, editorId: 'editor', revision, contents, path, workspaceVersion: preview.workspaceVersion, scope: { projectId: 'project' } });
  return { base, root, data, get engine() { return engine; }, input, preview, reopen: async () => { await engine.close(); engine = await new Engine(data, executor).open(); return engine; } };
}
test('Explicit editor saves preserve mode and literal filenames, can recreate missing paths, and keep receipts out of task snapshots', async t => {
  const { root, engine, input } = await fixture(t); await chmod(join(root, 'code.swift'), 0o640);
  const saved = await engine.fileWrites.save(input('one', 1, 'let café = "🚀"\n')); assert.equal(saved.status, 'saved'); assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), 'let café = "🚀"\n'); assert.equal((await stat(join(root, 'code.swift'))).mode & 0o777, 0o640);
  const next = await engine.fileWrites.save(input('two', 2, 'new file\n', 'new/中文 #?.txt')); assert.equal(next.status, 'saved'); assert.equal(await readFile(join(root, 'new/中文 #?.txt'), 'utf8'), 'new file\n');
  assert.ok(!JSON.stringify(await engine.snapshot()).includes('let café'));
});
test('Saving a source file with a UTF-8 BOM confirms the exact bytes instead of leaving an uncertain receipt', async t => {
  const { engine, input, root } = await fixture(t), source = '\ufeffName,Value\r\n文,🚀\r\n';
  const result = await engine.fileWrites.save(input('bom-save', 1, source));
  assert.equal(result.status, 'saved'); assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), source);
  assert.equal((await engine.fileWrites.status('bom-save', { projectId: 'project' })).status, 'saved');
});
test('Closing the file writer drains accepted duplicate saves and status reads before its durable session can close', async t => {
  const { engine, input } = await fixture(t), original = engine.contexts.owner.bind(engine.contexts);
  let release!: () => void, closed = false, entered = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  engine.contexts.owner = async scope => { entered++; await gate; return original(scope); };
  try {
    const first = engine.fileWrites.save(input('closing', 1, 'accepted')), duplicate = engine.fileWrites.save(input('closing', 1, 'accepted'));
    const status = engine.fileWrites.status('closing', { projectId: 'project' });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(entered, 2);
    const closing = engine.fileWrites.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(closed, false);
    await assert.rejects(engine.fileWrites.save(input('too-late', 2, 'late')), /停止/);
    await assert.rejects(engine.fileWrites.status('closing', { projectId: 'project' }), /停止/);
    release(); const outcomes = await Promise.all([first, duplicate, status]); await closing;
    assert.ok(outcomes.every(outcome => outcome.status === 'saved')); assert.equal(closed, true);
  } finally { release(); engine.contexts.owner = original; }
});
test('A repeated or lost response confirms the old save without repeating its write, even after later external edits and restart', async t => {
  const value = await fixture(t), input = value.input('lost', 1, 'saved\n');
  const first = await value.engine.fileWrites.save(input); assert.equal(first.status, 'saved'); const before = await stat(join(value.root, 'code.swift'));
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => value.engine.fileWrites.save(input))); assert.ok(concurrent.every(result => result.status === 'saved')); assert.equal((await stat(join(value.root, 'code.swift'))).mtimeMs, before.mtimeMs);
  await writeFile(join(value.root, 'code.swift'), 'external\n'); await value.reopen(); assert.deepEqual(await value.engine.fileWrites.save(input), first); assert.equal(await readFile(join(value.root, 'code.swift'), 'utf8'), 'external\n');
  await assert.rejects(value.engine.fileWrites.save({ ...input, contents: 'different content' }), /请求 ID/);
});
test('Late older editor revisions never overwrite a newer revision; another editor retains T3 last-write behavior', async t => {
  const { engine, input, root } = await fixture(t); assert.equal((await engine.fileWrites.save(input('newer', 3, 'newer'))).status, 'saved');
  assert.equal((await engine.fileWrites.save(input('older', 1, 'older'))).status, 'superseded'); assert.equal((await engine.fileWrites.save(input('same-revision', 3, 'old'))).status, 'superseded');
  assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), 'newer');
  assert.equal((await engine.fileWrites.save({ ...input('another', 1, 'another editor'), editorId: 'another-editor' })).status, 'saved'); assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), 'another editor');
});
test('A changed workspace, escaped symlinks, private runtime paths and Git internals are rejected before user source is changed', async t => {
  const { root, base, engine, input } = await fixture(t); await writeFile(join(base, 'outside'), 'outside'); await symlink(join(base, 'outside'), join(root, 'escape'));
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'config'), 'git');
  for (const path of ['../outside', 'escape', 'runtime/owner-token', '.git/config']) await assert.rejects(engine.fileWrites.save(input('invalid-' + path.replace(/\W/g, '_'), 1, 'bad', path)), path);
  await rename(root, root + '-old'); await mkdir(root); await writeFile(join(root, 'code.swift'), 'replacement');
  await assert.rejects(engine.fileWrites.save(input('root-changed', 1, 'must not write')), /工作区已改变/); assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), 'replacement');
  await rename(root, join(base, 'replacement')); await rename(root + '-old', root);
});
test('The authenticated save route accepts escaped text up to one MiB, rejects invalid bodies, and does not grant writes to HTML frames', async t => {
  const { engine, data, input, root } = await fixture(t), auth = new Auth(data); t.after(() => auth.close()); const api = createAPI(engine, auth, () => []), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const value = input('http', 1, 'line\n'.repeat(70_000)); assert.equal((await api.request('/api/task-files/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) })).status, 401);
  const response = await api.request('/api/task-files/document', { method: 'PUT', headers, body: JSON.stringify(value) }); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'saved'); assert.equal(await readFile(join(root, 'code.swift'), 'utf8'), value.contents);
  assert.equal((await api.request('/api/task-files/document', { method: 'PUT', headers: { ...headers, Origin: 'null' }, body: JSON.stringify(input('frame', 2, 'bad')) })).status, 403);
  for (const body of [{ ...value, revision: 0 }, { ...value, contents: 'x'.repeat(1024 * 1024 + 1) }, { ...value, contents: 'bad\0' }]) assert.equal((await api.request('/api/task-files/document', { method: 'PUT', headers, body: JSON.stringify(body) })).status, 400);
});
for (const phase of ['before', 'after']) test('A real process exit ' + phase + ' the file effect is inspected after restart and is never blindly replayed', async t => {
  const value = await fixture(t), input = value.input('crash-' + phase, 1, 'written before exit\n'); await value.engine.close();
  const script = fileURLToPath(new URL('./fixtures/file-write-crash.ts', import.meta.url));
  try { await promisify(execFile)(process.execPath, ['--import', 'tsx', script, value.data, JSON.stringify(input), phase], { timeout: 20_000 }); assert.fail('Crash boundary was not reached'); }
  catch (error) { assert.equal((error as { code?: number }).code, phase === 'before' ? 70 : 71); }
  await value.reopen(); const expected = phase === 'before' ? 'before\n' : input.contents; assert.equal(await readFile(join(value.root, 'code.swift'), 'utf8'), expected);
  const result = await value.engine.fileWrites.save(input); assert.equal(result.status, phase === 'before' ? 'unconfirmed' : 'saved'); assert.equal(await readFile(join(value.root, 'code.swift'), 'utf8'), expected);
  assert.equal((await value.engine.fileWrites.status(input.requestId, input.scope)).status, result.status);
});
