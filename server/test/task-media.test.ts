import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openTaskMedia, taskMediaResponse } from '../src/task-media.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-media-'))), root = join(base, 'project'), directory = join(root, 'runtime');
  const closing: Array<() => Promise<void>> = [];
  await mkdir(directory, { recursive: true }); t.after(async () => { for (const close of closing) await close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, directory, closing, open: (path: string) => openTaskMedia(path, root, directory) };
}
test('Host images resolve relative, absolute and canonical symlink paths including spaces, Unicode and query characters literally', async t => {
  const { base, root, open } = await fixture(t); const name = "中文 # ? % '().PNG", outside = join(base, name); await writeFile(outside, 'actual media bytes');
  await symlink(outside, join(root, 'alias.png'));
  for (const path of [outside, '../' + name, 'alias.png']) {
    const media = await open(path); assert.equal(media.mimeType, 'image/png'); assert.equal(media.name, name);
    const response = await taskMediaResponse(media, { method: 'GET' }); assert.equal(await response.text(), 'actual media bytes');
    assert.equal(response.headers.get('cache-control'), 'private, no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const header = response.headers.get('content-disposition')!; assert.equal(decodeURIComponent(header.split("UTF-8''")[1]), name); assert.equal([...header].filter(character => character === "'").length, 2);
  }
});
test('Private runtime paths, aliases, Git internals, directories, unsupported files and URI inputs are rejected', async t => {
  const { root, directory, open } = await fixture(t); await writeFile(join(directory, 'secret.png'), 'private'); await symlink(join(directory, 'secret.png'), join(root, 'alias.png'));
  await mkdir(join(root, '.git')); await writeFile(join(root, '.git', 'secret.png'), 'private'); await writeFile(join(root, 'secret.txt'), 'not media'); await symlink(join(root, 'secret.txt'), join(root, 'renamed.png')); await mkdir(join(root, 'folder.png'));
  for (const path of ['runtime/secret.png', 'alias.png', '.git/secret.png', 'secret.txt', 'renamed.png', 'folder.png', 'file:///tmp/test.png', 'https://example.com/a.png', '~/.png', 'bad\0.png']) await assert.rejects(open(path), path);
});
test('Ranges, suffixes, HEAD, cache validators and invalid ranges close the checked file descriptor', async t => {
  const { root, open } = await fixture(t); await writeFile(join(root, 'image.png'), '0123456789');
  for (const [range, expected] of [['bytes=2-5', '2345'], ['bytes=7-', '789'], ['bytes=-3', '789'], ['bytes=8-99', '89'], ['bytes=-99', '0123456789']]) {
    const media = await open('image.png'), response = await taskMediaResponse(media, { method: 'GET', range }); assert.equal(response.status, 206); assert.equal(await response.text(), expected); assert.equal(Number(response.headers.get('content-length')), expected.length); await assert.rejects(media.handle.stat());
  }
  const head = await open('image.png'), response = await taskMediaResponse(head, { method: 'HEAD' }); assert.equal(await response.text(), ''); assert.equal(response.headers.get('content-length'), '10'); await assert.rejects(head.handle.stat());
  const cached = await open('image.png'), unchanged = await taskMediaResponse(cached, { method: 'GET', ifNoneMatch: response.headers.get('etag')! }); assert.equal(unchanged.status, 304); await assert.rejects(cached.handle.stat());
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=999999999999999999999-', 'bytes=-']) {
    const media = await open('image.png'), result = await taskMediaResponse(media, { method: 'GET', range }); assert.equal(result.status, 416, range); assert.equal(result.headers.get('content-range'), 'bytes */10'); await assert.rejects(media.handle.stat());
  }
});
test('A renamed path cannot replace the file descriptor already selected for the response', async t => {
  const { root, open } = await fixture(t); const path = join(root, 'image.png'); await writeFile(path, 'first image'); const media = await open('image.png');
  await rename(path, path + '.old'); await writeFile(path, 'replacement image');
  assert.equal(await (await taskMediaResponse(media, { method: 'GET' })).text(), 'first image');
  assert.equal(await (await taskMediaResponse(await open('image.png'), { method: 'GET' })).text(), 'replacement image');
});
test('Cancelling a response and an already aborted request release their file descriptors', async t => {
  const { root, open } = await fixture(t); await writeFile(join(root, 'image.png'), Buffer.alloc(512 * 1024));
  const media = await open('image.png'), response = await taskMediaResponse(media, { method: 'GET' }); await response.body!.cancel(); await assert.rejects(media.handle.stat());
  const controller = new AbortController(); controller.abort(); const aborted = await open('image.png'); await taskMediaResponse(aborted, { method: 'GET', signal: controller.signal }); await assert.rejects(aborted.handle.stat());
});
test('An absolute image stays available after the old workspace is removed, and special files do not block opening', async t => {
  const { base, root, directory } = await fixture(t); await writeFile(join(base, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const media = await openTaskMedia(join(base, 'image.svg'), join(root, 'gone'), directory); assert.equal(media.mimeType, 'image/svg+xml'); await media.handle.close();
  const fifo = join(root, 'pipe.png'); await promisify(execFile)('mkfifo', [fifo]); await assert.rejects(openTaskMedia(fifo, root, directory), /普通图片/);
});
test('The HTTP route requires current device authentication and a real local task, without mutating tasks or starting execution', async t => {
  const { base, root, closing } = await fixture(t), data = join(base, 'api-data');
  const executor = { run: async (_request: ExecutionRequest) => 'fixture only', steer: async () => {}, answer: async () => {} };
  const engine = await new Engine(data, executor).open(), auth = new Auth(data); closing.push(async () => { auth.close(); await engine.close(); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'fixture', requestId: 'fixture', projectId: 'project', mode: 'code', agent: 'codex' });
  const path = join(root, '图片 #?.png'); await writeFile(path, 'test picture'); const api = createAPI(engine, auth, () => []), route = '/api/tasks/' + id + '/media?path=' + encodeURIComponent(path);
  assert.equal((await api.request(route)).status, 401);
  const paired = auth.pair(auth.createPairing().code, 'Fixture device', 'local'); const headers = { Authorization: 'Bearer ' + paired.token };
  const result = await api.request(route, { headers }); assert.equal(result.status, 200, await result.clone().text()); assert.equal(await result.text(), 'test picture');
  assert.equal((await api.request('/api/tasks/missing/media?path=' + encodeURIComponent(path), { headers })).status, 404);
  const head = await api.request(route, { method: 'HEAD', headers }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  auth.revoke(paired.id); assert.equal((await api.request(route, { headers })).status, 401);
  assert.equal((await engine.snapshot()).tasks.length, 1); assert.equal((await readFile(path)).toString(), 'test picture');
});
