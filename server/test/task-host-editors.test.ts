import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { TaskHostEditors } from '../src/task-host-editors.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, actualLaunch = false) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-host-editors-'))), root = join(base, 'project'), data = join(root, 'runtime'), bin = join(base, 'bin'), apps = join(base, 'Applications'), home = join(base, 'home');
  for (const directory of [root, bin, apps, home]) await mkdir(directory);
  const engine = await new Engine(data, { run: async () => 'fixture', steer: async () => {}, answer: async () => {} }).open(), auth = new Auth(data);
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  await writeFile(join(root, 'file #?% $(literal):12.txt'), 'text');
  const launches: { command: string; args: string[]; cwd: string }[] = [];
  const editors = new TaskHostEditors(engine, { platform: 'darwin', env: { PATH: bin, HOME: home }, appRoots: [apps], ...(!actualLaunch ? { run: async (launch: { command: string; args: string[] }, cwd: string) => { launches.push({ ...launch, cwd }); } } : {}) });
  const api = createAPI(engine, auth, () => [], { hostEditors: editors });
  const command = async (path: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 }); return path; };
  const input = { scope: { projectId: 'project' }, workspaceRoot: root, path: 'file #?% $(literal):12.txt', editor: 'vscode' };
  return { base, root, data, bin, apps, home, engine, auth, api, editors, launches, command, input };
}
test('Editor discovery uses installed commands, exact app identities and versioned Toolbox bundles in T3 order', async t => {
  const { editors, root, bin, apps, command } = await fixture(t);
  await command(join(bin, 'code')); await command(join(bin, 'cursor'));
  await command(join(apps, 'IntelliJ IDEA 2026.1.4.app/Contents/MacOS/idea'));
  const snapshot = await editors.snapshot({ projectId: 'project' }, root);
  assert.equal(snapshot.workspaceRoot, root); assert.equal(snapshot.revealSupported, true);
  assert.deepEqual(snapshot.editors.map(editor => editor.id), ['cursor', 'vscode', 'idea', 'file-manager']);
});
test('Stable Code never borrows Insiders, Antigravity Hub is not its IDE and Zed prefers its bundle to the ZFS command', async t => {
  const { editors, root, bin, apps, command, launches, input } = await fixture(t);
  await command(join(apps, 'Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders'));
  await command(join(apps, 'Antigravity.app/Contents/Resources/app/bin/code')); await command(join(bin, 'agy'));
  await command(join(bin, 'zed')); const zed = await command(join(apps, 'Zed.app/Contents/MacOS/cli'));
  const ids = (await editors.snapshot(input.scope, root)).editors.map(editor => editor.id);
  assert.ok(ids.includes('vscode-insiders')); assert.ok(!ids.includes('vscode')); assert.ok(!ids.includes('antigravity'));
  await editors.open({ ...input, editor: 'zed' }); assert.equal(launches[0].command, zed);
});
test('Editor launch preserves literal filenames, goto/line-column conventions and Cursor/Kiro bundle arguments', async t => {
  const { editors, root, bin, apps, command, launches, input } = await fixture(t);
  for (const name of ['code', 'cursor', 'idea']) await command(join(bin, name));
  await command(join(apps, 'Kiro.app/Contents/Resources/app/bin/kiro'));
  await editors.open(input); assert.deepEqual(launches[0].args, [join(root, input.path)]);
  await editors.open({ ...input, line: 9, column: 4 }); assert.deepEqual(launches[1].args, ['--goto', join(root, input.path) + ':9:4']);
  await editors.open({ ...input, editor: 'idea', line: 9, column: 4 }); assert.deepEqual(launches[2].args, ['--line', '9', '--column', '4', join(root, input.path)]);
  await editors.open({ ...input, editor: 'cursor' }); assert.deepEqual(launches[3].args, ['--classic', join(root, input.path)]);
  await editors.open({ ...input, editor: 'kiro' }); assert.deepEqual(launches[4].args, [join(root, input.path)]);
  assert.ok(launches.every(launch => launch.cwd === root));
});
test('File manager opens files, opens root folders and reveals a selected entry without interpreting path text as shell', async t => {
  const { editors, launches, input, root } = await fixture(t);
  await editors.open({ ...input, editor: 'file-manager' });
  await editors.open({ ...input, editor: 'file-manager', reveal: true });
  await editors.open({ ...input, editor: 'file-manager', path: '' });
  assert.deepEqual(launches.map(launch => launch.args), [[join(root, input.path)], ['-R', join(root, input.path)], [root]]);
});
test('Opening applies the same private/Git/symlink boundaries and rejects unavailable editors, malformed positions and stale roots', async t => {
  const { editors, root, data, base, bin, command, launches, input } = await fixture(t); await command(join(bin, 'code'));
  await writeFile(join(base, 'outside'), 'outside'); await symlink(join(base, 'outside'), join(root, 'escape'));
  await writeFile(join(data, 'private'), 'private'); await symlink(join(data, 'private'), join(root, 'alias'));
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'config'), 'internal');
  for (const path of ['../outside', '.git/config', 'runtime/private', 'alias', 'escape']) await assert.rejects(editors.open({ ...input, path }));
  for (const extra of [{ editor: 'code;echo' }, { editor: 'cursor' }, { line: 0 }, { line: 1.5 }, { column: 2 }, { reveal: 'true' }, { reveal: true }, { workspaceRoot: root + '-other' }]) await assert.rejects(editors.open({ ...input, ...extra }));
  await rm(join(bin, 'code')); await assert.rejects(editors.open(input), /未找到/);
  assert.equal(launches.length, 0);
});
test('A changed workspace during editor resolution is rejected again immediately before the external launch', async t => {
  const { editors, engine, root, bin, command, launches, input, base } = await fixture(t); await command(join(bin, 'code'));
  const changed = join(base, 'changed'); await mkdir(changed); await writeFile(join(changed, input.path), 'different');
  const owner = engine.contexts.owner.bind(engine.contexts); let calls = 0;
  engine.contexts.owner = async value => { const result = await owner(value); if (++calls === 1) await engine.mutate(state => { state.projects[0].path = changed; }); return result; };
  await assert.rejects(editors.open(input), /工作区已改变/); assert.equal(launches.length, 0);
});
test('The real API authenticates both discovery and launch, rejects foreign origins and stops revoked paired devices', async t => {
  const { api, auth, root, input, launches, bin, command } = await fixture(t); await command(join(bin, 'code'));
  const query = '?projectId=project&workspaceRoot=' + encodeURIComponent(root), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await api.request('/api/task-files/editors' + query)).status, 401);
  assert.equal((await api.request('/api/task-files/editors' + query, { headers })).status, 200);
  const post = (extra: Record<string, string>) => api.request('/api/task-files/open', { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(input) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ ...headers, Origin: 'https://example.invalid' })).status, 403);
  const paired = auth.pair(auth.createPairing().code, 'Fixture', 'local');
  assert.equal((await post({ Authorization: 'Bearer ' + paired.token })).status, 200); assert.equal(launches.length, 1);
  auth.revoke(paired.id); assert.equal((await post({ Authorization: 'Bearer ' + paired.token })).status, 401); assert.equal(launches.length, 1);
});
test('An editor launch participates in the update barrier and is never retried or replayed by a read', async t => {
  const { api, auth, input, launches, bin, command } = await fixture(t); await command(join(bin, 'code'));
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const prepare = await api.request('/api/service/update', { method: 'POST', headers, body: '{}' }); assert.equal(prepare.status, 200);
  const post = () => api.request('/api/task-files/open', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await post()).status, 503); assert.equal(launches.length, 0);
  await api.request('/api/service/update', { method: 'DELETE', headers });
  assert.equal((await post()).status, 200); assert.equal(launches.length, 1);
  await api.request('/api/state', { headers }); assert.equal(launches.length, 1);
});
test('The default detached launcher starts only the discovered executable with literal argv and a workspace cwd', async t => {
  const { editors, bin, root, input } = await fixture(t, true); const marker = join(bin, 'launched.json'), command = join(bin, 'code');
  await writeFile(command, '#!' + process.execPath + '\nrequire("node:fs").writeFileSync(' + JSON.stringify(marker) + ',JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));\n', { mode: 0o755 }); await chmod(command, 0o755);
  await editors.open(input);
  let value: string | undefined;
  for (let attempt = 0; attempt < 500; attempt++) { value = await readFile(marker, 'utf8').catch(() => undefined); if (value) break; await delay(10); }
  assert.deepEqual(JSON.parse(value ?? 'null'), { args: [join(root, input.path)], cwd: root });
});
