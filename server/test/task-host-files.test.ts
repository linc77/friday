import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { TaskFileAssets } from '../src/task-file-assets.js';
import { TaskFiles, fileReferencePath } from '../src/task-files.js';
import { TaskHostEditors } from '../src/task-host-editors.js';
import { taskGit } from '../src/git-process.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-host-files-'))), root = join(base, 'workspace'), host = join(base, 'host'), data = join(root, 'runtime');
  await mkdir(root); await mkdir(host); await mkdir(join(host, 'nested')); await writeFile(join(host, 'a #?%20.md'), '# host\n');
  const engine = await new Engine(data, { run: async () => 'fixture', steer: async () => {}, answer: async () => {} }).open(), auth = new Auth(data);
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const api = createAPI(engine, auth, () => []), scope = { projectId: 'project' }, headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const route = (kind: string, path: string) => '/api/task-files' + (kind ? '/' + kind : '') + '?projectId=project&path=' + encodeURIComponent(path);
  return { base, root, host, data, engine, auth, api, scope, headers, route, assets: new TaskFileAssets(engine, auth) };
}
test('Host folders list absolute children and return complete text, directory metadata and original content through authenticated file APIs', async t => {
  const { host, api, headers, route } = await fixture(t), path = join(host, 'a #?%20.md');
  assert.equal((await api.request(route('', host))).status, 401);
  const listing = await (await api.request(route('', host), { headers })).json();
  assert.ok(listing.entries.some((entry: { path: string }) => entry.path === path));
  const directory = await (await api.request(route('document', host), { headers })).json(); assert.equal(directory.kind, 'directory'); assert.equal(directory.writeSupported, false);
  const document = await (await api.request(route('document', path), { headers })).json(); assert.equal(document.path, path); assert.equal(document.contents, '# host\n'); assert.equal(document.writeSupported, true);
  assert.equal(await (await api.request(route('content', path), { headers })).text(), '# host\n');
  assert.equal(fileReferencePath('/', true, true), '/');
});
test('Host edits use the existing durable receipts and keep absolute new-file targets pinned to their owning workspace', async t => {
  const { host, root, scope, engine, api, headers, route } = await fixture(t), path = join(host, 'a #?%20.md');
  const document = await (await api.request(route('document', path), { headers })).json();
  const input = { requestId: 'host-save', editorId: 'host-editor', revision: 1, scope, path, contents: '# changed\n', workspaceVersion: document.workspaceVersion };
  const saved = await engine.fileWrites.save(input); assert.equal(saved.status, 'saved'); assert.equal(await readFile(path, 'utf8'), '# changed\n');
  await writeFile(path, '# externally changed\n');
  assert.deepEqual(await engine.fileWrites.save(input), saved); assert.equal(await readFile(path, 'utf8'), '# externally changed\n');
  assert.equal((await engine.fileWrites.status('host-save', scope)).status, 'saved');
  const created = join(host, 'new/sub/file.txt');
  assert.equal((await engine.fileWrites.save({ ...input, requestId: 'host-create', revision: 2, path: created, contents: 'new' })).status, 'saved');
  assert.equal(await readFile(created, 'utf8'), 'new');
  await engine.mutate(state => { state.projects[0].path = host; });
  await assert.rejects(engine.fileWrites.save({ ...input, requestId: 'host-stale', revision: 3 }), /工作区/);
  assert.equal(await readFile(path, 'utf8'), '# externally changed\n'); assert.notEqual(root, host);
});
test('Host file and directory context captures stay immutable and owned by the original project', async t => {
  const { host, scope, engine, root } = await fixture(t), path = join(host, 'a #?%20.md');
  const file = await engine.contexts.capture({ id: 'host-file', scope, kind: 'file', path });
  const directory = await engine.contexts.capture({ id: 'host-directory', scope, kind: 'directory', path: host });
  await writeFile(path, '# different');
  assert.equal((await engine.contexts.read(file.id, scope)).text, '# host\n');
  const snapshot = await engine.contexts.read(directory.id, scope); assert.equal(snapshot.cwd, root); assert.equal(snapshot.reference.path, host); assert.ok(snapshot.text.includes('nested/'));
  await assert.rejects(engine.contexts.read(file.id, { projectId: 'other' }));
});
test('Absolute host reads and writes still reject private data, logical and canonical Git paths, devices and unsafe relative escapes', async t => {
  const { host, root, data, scope, engine } = await fixture(t), files = (await engine.contexts.owner(scope)).files;
  await writeFile(join(data, 'private.txt'), 'private'); await symlink(join(data, 'private.txt'), join(host, 'private-alias'));
  await mkdir(join(host, '.git')); await writeFile(join(host, '.git/config'), 'git'); await symlink(join(host, '.git/config'), join(host, 'git-alias'));
  await symlink(host, join(root, 'escape'));
  for (const path of [join(data, 'private.txt'), join(host, 'private-alias'), join(host, '.git/config'), join(host, 'git-alias'), '../host/a #?%20.md', 'escape/a #?%20.md']) await assert.rejects(files.document(path));
  const listing = await files.list(host); assert.ok(!listing.entries.some(entry => ['.git', 'private-alias', 'git-alias'].includes(entry.name)));
  const restricted = new TaskFiles(root, data); await assert.rejects(restricted.document(join(host, 'a #?%20.md')));
  const invalidOwner = new TaskFiles(data, data, true); await assert.rejects(invalidOwner.open(join(host, 'a #?%20.md')), /私有/);
});
test('Host HTML capabilities serve relative resources and deny sibling symlink escapes, hidden/source resources and replaced preview directories', async t => {
  const { host, base, scope, root, assets } = await fixture(t);
  await writeFile(join(host, 'index.html'), '<script src="nested/app.js"></script>'); await writeFile(join(host, 'nested/app.js'), 'ok'); await writeFile(join(base, 'outside.js'), 'outside'); await symlink(join(base, 'outside.js'), join(host, 'alias.js'));
  const grant = await assets.issue('owner', { scope, path: join(host, 'index.html'), workspaceRoot: root }), token = grant.url.split('/')[2];
  assert.equal(await (await assets.resource(token, 'nested/app.js', { method: 'GET' })).text(), 'ok');
  for (const path of ['alias.js', '../outside.js', '.hidden.js', 'source.swift', 'data.json']) await assert.rejects(assets.resource(token, path, { method: 'GET' }));
  await rename(host, host + '-old'); await mkdir(host); await writeFile(join(host, 'index.html'), 'replacement');
  await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }), /目录已改变/);
});
test('Host media capabilities remain exact and revoke with their device or original workspace', async t => {
  const { host, scope, root, assets, auth, engine } = await fixture(t); await writeFile(join(host, 'clip.mp4'), '0123456789');
  const paired = auth.pair(auth.createPairing().code, 'Fixture', 'local');
  const grant = await assets.issue(paired.id, { scope, workspaceRoot: root, path: join(host, 'clip.mp4') }), token = grant.url.split('/')[2];
  assert.equal(await (await assets.resource(token, 'clip.mp4', { method: 'GET', range: 'bytes=2-4' })).text(), '234');
  await assert.rejects(assets.resource(token, 'other.mp4', { method: 'GET' }));
  auth.revoke(paired.id); await assert.rejects(assets.resource(token, 'clip.mp4', { method: 'HEAD' }));
  const ownerGrant = await assets.issue('owner', { scope, workspaceRoot: root, path: join(host, 'clip.mp4') });
  await engine.mutate(state => { state.projects[0].path = host; }); await assert.rejects(assets.resource(ownerGrant.url.split('/')[2], 'clip.mp4', { method: 'HEAD' }), /工作区/);
});
test('The host editor launcher accepts explicit absolute host files and directories without running an arbitrary command', async t => {
  const { host, root, scope, engine, base } = await fixture(t), bin = join(base, 'bin'); await mkdir(bin); await writeFile(join(bin, 'code'), '#!/bin/sh\n', { mode: 0o755 });
  const launches: string[][] = [], editors = new TaskHostEditors(engine, { platform: 'darwin', env: { PATH: bin }, appRoots: [], run: async launch => { launches.push(launch.args); } });
  await editors.open({ scope, workspaceRoot: root, path: join(host, 'a #?%20.md'), editor: 'vscode', line: 3 });
  await editors.open({ scope, workspaceRoot: root, path: host, editor: 'vscode' });
  assert.deepEqual(launches, [['--goto', join(host, 'a #?%20.md') + ':3'], [host]]);
});
test('Directory browsing returns every immediate child beyond 1000 entries and does not list symbolic links', async t => {
  const { host, engine, scope } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, async (_, worker) => { for (let index = worker; index < 1002; index += 8) await writeFile(join(host, `file-${String(index).padStart(4, '0')}.txt`), 'x'); }));
  await symlink(join(host, 'file-0000.txt'), join(host, 'alias'));
  const listing = await (await engine.contexts.owner(scope)).files.list(host);
  assert.equal(listing.truncated, false); assert.equal(listing.entries.filter(entry => entry.name.startsWith('file-')).length, 1002);
  assert.ok(!listing.entries.some(entry => entry.name === 'alias')); assert.ok(listing.entries.some(entry => entry.name === 'file-1001.txt'));
});
test('Git-ignored children stay visible with ignored metadata while tracked files and special filenames retain their identity', async t => {
  const { host, engine, scope } = await fixture(t);
  await taskGit(host, ['init']); await writeFile(join(host, '.gitignore'), 'ignored-*\ntracked.txt\n');
  const ignored = 'ignored-#?%\nname.txt'; await writeFile(join(host, ignored), 'ignored'); await writeFile(join(host, 'tracked.txt'), 'tracked');
  await taskGit(host, ['add', '-f', 'tracked.txt']);
  const listing = await (await engine.contexts.owner(scope)).files.list(host);
  assert.equal(listing.entries.find(entry => entry.name === ignored)?.ignored, true);
  assert.equal(listing.entries.find(entry => entry.name === 'tracked.txt')?.ignored, undefined);
  assert.ok(!listing.entries.some(entry => entry.name === '.git'));
});
