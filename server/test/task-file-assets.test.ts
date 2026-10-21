import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { TaskFileAssets } from '../src/task-file-assets.js';
import type { ExecutionRequest } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-file-assets-'))), root = join(base, 'project'), data = join(root, 'runtime'); await mkdir(root);
  const engine = await new Engine(data, { run: async (_request: ExecutionRequest) => 'fixture', steer: async () => {}, answer: async () => {} }).open(), auth = new Auth(data);
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  await mkdir(join(root, 'docs')); await writeFile(join(root, 'docs', 'index.html'), '<script type="module" src="app.js"></script>'); await writeFile(join(root, 'docs', 'app.js'), 'fetch("data.json")'); await writeFile(join(root, 'docs', 'data.json'), '{"answer":42}');
  return { base, root, data, engine, auth, api: createAPI(engine, auth, () => []), assets: new TaskFileAssets(engine, auth) };
}
test('Authenticated issue produces a scoped HTTP link whose page, modules and fetch resources support opaque-origin CORS without a bearer credential', async t => {
  const { api, auth } = await fixture(t); const input = { scope: { projectId: 'project' }, path: 'docs/index.html' }, headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await api.request('/api/task-files/asset-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  const issue = await api.request('/api/task-files/asset-url', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(issue.status, 200); const asset = await issue.json(); assert.ok(asset.url.startsWith('/file-assets/')); assert.ok(!asset.url.includes(auth.token));
  const document = await api.request(asset.url, { headers: { Origin: 'null' } }); assert.equal(document.status, 200); assert.equal(document.headers.get('content-type'), 'text/html; charset=utf-8'); assert.equal(document.headers.get('access-control-allow-origin'), '*'); assert.equal(document.headers.get('referrer-policy'), 'no-referrer'); assert.ok(document.headers.get('content-security-policy')?.includes('sandbox allow-scripts')); assert.ok(!document.headers.get('content-security-policy')?.includes('allow-same-origin')); await document.arrayBuffer();
  for (const path of ['app.js']) {
    const url = new URL(path, 'http://localhost' + asset.url); const result = await api.request(url, { headers: { Origin: 'null' } }); assert.equal(result.status, 200); assert.equal(result.headers.get('access-control-allow-origin'), '*'); await result.arrayBuffer();
  }
  const dataURL = new URL('data.json', 'http://localhost' + asset.url); assert.equal((await api.request(dataURL, { headers: { Origin: 'null' } })).status, 404, 'T3 only serves its preview-asset extension allowlist');
  const preflight = await api.request(asset.url, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET' } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  const range = await api.request(asset.url, { headers: { Range: 'bytes=0-6', Origin: 'null' } }); assert.equal(range.status, 206); assert.equal(await range.text(), '<script');
  assert.equal((await api.request('/api/state', { headers: { Origin: 'null' } })).status, 403, 'A page receives no application API credential');
});
test('Capabilities reject tampering, expiry and revocation, and never traverse outside the root or into Friday runtime data', async t => {
  const { assets, auth, root, base, data } = await fixture(t); const paired = auth.pair(auth.createPairing().code, 'Fixture', 'local');
  const asset = await assets.issue(paired.id, { scope: { projectId: 'project' }, path: 'docs/index.html' }, 1000), token = asset.url.split('/')[2];
  const response = await assets.resource(token, 'index.html', { method: 'HEAD' }, 1001); assert.equal(response.status, 200);
  const changed = (token.startsWith('A') ? 'B' : 'A') + token.slice(1); await assert.rejects(assets.resource(changed, 'index.html', { method: 'GET' }, 1001), /无效/);
  await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }, 1000 + 60 * 60 * 1000), /过期/);
  await writeFile(join(base, 'outside.txt'), 'outside'); await symlink(join(base, 'outside.txt'), join(root, 'escape')); await writeFile(join(data, 'private.html'), 'private');
  await writeFile(join(root, 'docs', '.env.html'), 'private'); await writeFile(join(root, 'docs', 'source.swift'), 'source');
  await writeFile(join(root, 'secrets.css'), 'outside the page directory'); await symlink(join(data, 'private.html'), join(root, 'docs', 'alias.html'));
  for (const path of ['../outside.txt', 'escape', 'runtime/private.html', '.env.html', 'source.swift', 'secrets.css', 'alias.html']) await assert.rejects(assets.resource(token, path, { method: 'GET' }, 1001), path);
  await writeFile(join(root, 'docs', 'a.svg'), '<svg/>'); await writeFile(join(root, 'docs', 'b.svg'), '<svg/>');
  const exact = await assets.issue('owner', { scope: { projectId: 'project' }, path: 'docs/a.svg' }, 1000), exactToken = exact.url.split('/')[2];
  assert.equal((await assets.resource(exactToken, 'a.svg', { method: 'HEAD' }, 1001)).status, 200); await assert.rejects(assets.resource(exactToken, 'b.svg', { method: 'GET' }, 1001), /范围/);
  auth.revoke(paired.id); await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }, 1001), /无效/);
});
test('Audio and video capabilities stream exact-file bytes and HEAD/ranges without exposing sibling assets or application APIs', async t => {
  const { root, engine, assets, api } = await fixture(t);
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, index) => index % 251));
  for (const [name, kind, mime] of [['clip #?.MP4', 'video', 'video/mp4'], ['sound.wav', 'audio', 'audio/wav']]) {
    const path = 'docs/' + name; await writeFile(join(root, path), bytes);
    const document = await (await engine.contexts.owner({ projectId: 'project' })).files.document(path);
    assert.equal(document.kind, kind); assert.equal(Object.hasOwn(document, 'contents'), false); assert.equal(document.mimeType, mime);
    const asset = await assets.issue('owner', { scope: { projectId: 'project' }, path });
    const head = await api.request(asset.url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(bytes.length)); assert.equal(head.headers.get('content-type'), mime); assert.equal((await head.arrayBuffer()).byteLength, 0);
    const range = await api.request(asset.url, { headers: { Range: 'bytes=10-29', Origin: 'null' } });
    assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), `bytes 10-29/${bytes.length}`); assert.equal(range.headers.get('access-control-allow-origin'), '*'); assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(10, 30));
    const suffix = await api.request(asset.url, { headers: { Range: 'bytes=-8' } }); assert.equal(suffix.status, 206); assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-8));
    const sibling = asset.url.slice(0, asset.url.lastIndexOf('/') + 1) + 'app.js'; assert.equal((await api.request(sibling)).status, 404);
    assert.equal((await api.request('/api/task-files/content?projectId=project&path=' + encodeURIComponent(path))).status, 401);
  }
});
test('Media grants remain bound to the issuing device and reject a replaced symlink outside the workspace', async t => {
  const { assets, auth, root, base } = await fixture(t); await writeFile(join(root, 'clip.webm'), 'media'); await writeFile(join(base, 'private.webm'), 'outside');
  const paired = auth.pair(auth.createPairing().code, 'Fixture', 'local');
  const asset = await assets.issue(paired.id, { scope: { projectId: 'project' }, path: 'clip.webm' }), token = asset.url.split('/')[2];
  await rm(join(root, 'clip.webm')); await symlink(join(base, 'private.webm'), join(root, 'clip.webm'));
  await assert.rejects(assets.resource(token, 'clip.webm', { method: 'GET' }), /工作区之外/);
  auth.revoke(paired.id); await assert.rejects(assets.resource(token, 'clip.webm', { method: 'HEAD' }), /无效/);
});
test('A media action must issue against its captured workspace and echo the actual root for clients to verify', async t => {
  const { assets, engine, root, base } = await fixture(t);
  const input = { scope: { projectId: 'project' }, path: 'docs/index.html', workspaceRoot: root };
  assert.equal((await assets.issue('owner', input)).workspaceRoot, root);
  for (const workspaceRoot of [root + '-other', null, 42, {}]) await assert.rejects(assets.issue('owner', { ...input, workspaceRoot }), /工作区已改变/);
  const changed = join(base, 'changed'); await mkdir(join(changed, 'docs'), { recursive: true }); await writeFile(join(changed, 'docs/index.html'), 'different workspace');
  await engine.mutate(state => { state.projects[0].path = changed; });
  await assert.rejects(assets.issue('owner', input), /工作区已改变/);
  assert.equal((await assets.issue('owner', { scope: input.scope, path: input.path, workspaceRoot: changed })).workspaceRoot, changed);
});
test('Authored host media becomes an exact-file capability, including files outside the workspace, without broadening legacy image reads', async t => {
  const { assets, root, base, data } = await fixture(t);
  const path = join(base, 'clip #?%.MP4'), bytes = Buffer.from('0123456789-video'); await writeFile(path, bytes);
  const input = { scope: { projectId: 'project' }, path, workspaceRoot: root, kind: 'media' };
  const grant = await assets.issue('owner', input), token = grant.url.split('/')[2]; assert.equal(grant.workspaceRoot, root);
  const response = await assets.resource(token, 'clip #?%.MP4', { method: 'GET', range: 'bytes=3-7' }); assert.equal(response.status, 206); assert.equal(response.headers.get('content-type'), 'video/mp4'); assert.equal(await response.text(), '34567');
  await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }), /范围/);
  const direct = await assets.issue('owner', { ...input, kind: undefined });
  assert.equal((await assets.resource(direct.url.split('/')[2], 'clip #?%.MP4', { method: 'HEAD' })).status, 200);
  await writeFile(join(data, 'private.mp4'), 'private'); await rm(path); await symlink(join(data, 'private.mp4'), path);
  await assert.rejects(assets.resource(token, 'clip #?%.MP4', { method: 'GET' }), /私有/);
});
test('Host media capabilities reject non-media files, logical Git aliases and changed workspace bindings', async t => {
  const { assets, root, base } = await fixture(t); const path = join(base, 'clip.mp4'); await writeFile(path, 'bytes');
  const input = { scope: { projectId: 'project' }, path, kind: 'media', workspaceRoot: root };
  await assert.rejects(assets.issue('owner', { ...input, workspaceRoot: root + '-other' }), /工作区已改变/);
  await writeFile(join(base, 'secret.txt'), 'not media'); await assert.rejects(assets.issue('owner', { ...input, path: join(base, 'secret.txt') }), /支持的媒体/);
  await mkdir(join(root, '.git')); await symlink(path, join(root, '.git/alias.mp4'));
  await assert.rejects(assets.issue('owner', { ...input, path: join(root, '.git/alias.mp4') }), /Git/);
});
test('A saved capability does not adopt a new directory or a different workspace at the same project address', async t => {
  const { assets, engine, root, base } = await fixture(t); const asset = await assets.issue('owner', { scope: { projectId: 'project' }, path: 'docs/index.html' }), token = asset.url.split('/')[2];
  await rename(root, root + '-old'); await mkdir(root); await writeFile(join(root, 'index.html'), 'replacement');
  await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }), /工作区已改变/);
  await rename(root, join(base, 'replacement')); await rename(root + '-old', root);
  await engine.mutate(state => { state.projects[0].path = join(base, 'replacement'); }); await assert.rejects(assets.resource(token, 'index.html', { method: 'GET' }), /工作区已改变/);
});
