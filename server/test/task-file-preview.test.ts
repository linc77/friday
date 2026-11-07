import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskFiles } from '../src/task-files.js';
import { taskFileMimeType } from '../src/task-file-preview.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-file-preview-'))), root = join(base, 'project'), directory = join(root, 'runtime');
  await mkdir(directory, { recursive: true }); const closing: Array<() => Promise<void>> = [];
  t.after(async () => { for (const close of closing) await close(); await rm(base, { recursive: true, force: true }); });
  return { base, root, directory, closing, files: new TaskFiles(root, directory) };
}
test('File previews preserve source bytes, kinds, size and version without the smaller composer-reference limit', async t => {
  const { root, files } = await fixture(t); const body = '# Title\n\n' + '文'.repeat(30_000); await writeFile(join(root, 'readme.md'), body);
  const first = await files.preview('readme.md'); assert.equal(first.kind, 'markdown'); assert.equal(first.contents, body); assert.equal(first.sizeBytes, Buffer.byteLength(body)); assert.equal(first.truncated, false);
  assert.equal((await files.preview('readme.md')).version, first.version); await writeFile(join(root, 'readme.md'), 'changed'); assert.notEqual((await files.preview('readme.md')).version, first.version);
  await writeFile(join(root, 'index.html'), '<script>counter += 1</script>'); assert.equal((await files.preview('index.html')).kind, 'html');
  await writeFile(join(root, 'table.tsv'), 'A\tB\n1\t2'); assert.equal((await files.preview('table.tsv')).kind, 'table');
});
test('The one MiB preview limit does not split a UTF-8 scalar and reports truncation while binary files stay binary', async t => {
  const { root, files } = await fixture(t); await writeFile(join(root, 'large.swift'), '文'.repeat(400_000));
  const preview = await files.preview('large.swift'); assert.ok(preview.contents); assert.ok(!preview.contents.includes('\ufffd')); assert.ok(Buffer.byteLength(preview.contents) <= 1024 * 1024); assert.equal(preview.truncated, true); assert.equal(preview.language, 'swift');
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 8])); const binary = await files.preview('binary.bin'); assert.equal(binary.kind, 'unsupported'); assert.equal(binary.contents, undefined);
  await writeFile(join(root, 'bad.txt'), Buffer.from([255])); assert.equal((await files.preview('bad.txt')).kind, 'unsupported');
});
test('Directory documents stay read-only and retain workspace, private-data and Git boundaries', async t => {
  const { root, files, base } = await fixture(t); await mkdir(join(root, 'src #?% dir'));
  const folder = await files.document('src #?% dir'), workspace = await files.document('');
  assert.equal(folder.kind, 'directory'); assert.equal(folder.writeSupported, false); assert.ok(!('contents' in folder)); assert.equal(folder.workspaceVersion, workspace.workspaceVersion);
  assert.equal((await files.document('src #?% dir')).version, folder.version);
  await assert.rejects(files.document('runtime'), /私有/); await assert.rejects(files.document('.git'), /工作区/);
  await mkdir(join(base, 'outside')); await symlink(join(base, 'outside'), join(root, 'escape'));
  await assert.rejects(files.document('escape'), /工作区/);
});
test('UTF-8 BOMs are preserved in file documents and captured references for source editing', async t => {
  const { root, files } = await fixture(t), source = '\ufeffName,Value\r\n文,🚀\r\n'; await writeFile(join(root, 'table.csv'), source);
  const document = await files.document('table.csv'); assert.equal(document.kind, 'table'); assert.ok('contents' in document); assert.equal(document.contents, source);
  assert.equal((await files.read('table.csv')).text, source.replaceAll('\r\n', '\n'));
});
test('Image and PDF previews use metadata without trying to parse binary bytes as text', async t => {
  const { root, files } = await fixture(t);
  for (const [path, kind] of [['image.svg', 'image'], ['report.pdf', 'pdf'], ['clip.mp4', 'video'], ['sound.m4a', 'audio']]) {
    await writeFile(join(root, path), Buffer.from([0, 255, 4])); const preview = await files.preview(path); assert.equal(preview.kind, kind); assert.equal(preview.contents, undefined); assert.equal(preview.truncated, false);
  }
  for (const [path, type] of [['app.mjs', 'text/javascript'], ['site.css', 'text/css'], ['data.json', 'application/json'], ['font.woff2', 'font/woff2'], ['engine.wasm', 'application/wasm']]) assert.equal(taskFileMimeType(path), type);
});
test('File content and metadata share the workspace and private-runtime boundaries', async t => {
  const { base, root, directory, files } = await fixture(t); await writeFile(join(base, 'outside.txt'), 'outside'); await symlink(join(base, 'outside.txt'), join(root, 'escape')); await writeFile(join(directory, 'secret.html'), 'private'); await symlink(join(directory, 'secret.html'), join(root, 'alias.html'));
  for (const path of ['../outside.txt', join(base, 'outside.txt'), 'escape', 'runtime/secret.html', 'alias.html', '.git/config']) {
    await assert.rejects(files.preview(path), path); await assert.rejects(files.open(path), path);
  }
  await mkdir(join(root, 'directory')); await assert.rejects(files.preview('directory'), /普通文件/);
});
test('HTTP file pages and relative resources require task scope and authentication, use sandboxed HTML, and keep ranges intact', async t => {
  const { base, root, closing } = await fixture(t), data = join(base, 'service');
  const engine = await new Engine(data, { run: async (_request: ExecutionRequest) => 'fixture', steer: async () => {}, answer: async () => {} }).open(); const auth = new Auth(data);
  closing.push(async () => { auth.close(); await engine.close(); }); await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'fixture', requestId: 'files', projectId: 'project', mode: 'code', agent: 'codex' }); const api = createAPI(engine, auth, () => []), headers = { Authorization: 'Bearer ' + auth.token };
  const html = '<script src="app.js"></script><link href="style.css" rel="stylesheet">'; await writeFile(join(root, 'index.html'), html); await writeFile(join(root, 'app.js'), 'globalThis.counter=1;'); await writeFile(join(root, 'style.css'), 'body{color:red}');
  const route = (kind: string, path: string) => '/api/task-files/' + kind + '?taskId=' + id + '&path=' + encodeURIComponent(path);
  await mkdir(join(root, 'src #?% dir'));
  const folder = await api.request(route('document', 'src #?% dir'), { headers }); assert.equal(folder.status, 200); assert.equal((await folder.json()).kind, 'directory');
  assert.equal((await api.request(route('document', 'src #?% dir'))).status, 401);
  assert.equal((await api.request(route('document', 'index.html'))).status, 401);
  const document = await api.request(route('document', 'index.html'), { headers }); assert.equal(document.status, 200); assert.equal((await document.json()).contents, html);
  const page = await api.request(route('content', 'index.html'), { headers }); assert.equal(await page.text(), html); assert.equal(page.headers.get('content-security-policy'), 'sandbox allow-scripts allow-forms allow-popups allow-downloads');
  const script = await api.request(route('content', 'app.js'), { headers }); assert.equal(script.headers.get('content-type'), 'text/javascript'); assert.equal(script.headers.get('content-security-policy'), null); assert.equal(await script.text(), 'globalThis.counter=1;');
  const range = await api.request(route('content', 'style.css'), { headers: { ...headers, Range: 'bytes=0-3' } }); assert.equal(range.status, 206); assert.equal(await range.text(), 'body');
  assert.equal((await api.request(route('content', '../outside'), { headers })).status, 400); assert.equal((await readFile(join(root, 'index.html'))).toString(), html);
});
