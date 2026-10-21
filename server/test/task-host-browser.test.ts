import { HostBrowserTransfers, hostUploadFiles, hostUploadManifest, validateHostUploads, hostUploadMaxBytes, hostUploadMaxFiles, hostDownloadMaxBytes, hostDownloadLimit } from '../src/task-host-browser-transfers.js';
import { hostEditingCommand, hostClipboardScript } from '../src/task-host-browser-clipboard.js';
import { taskMediaResponse } from '../src/task-media.js';
import { Readable } from 'node:stream';
import type { Download, FileChooser } from 'playwright-core';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, stat, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { TaskHostBrowsers } from '../src/task-host-browser.js';
import { HostChromeContexts, hostBrowserExecutable, privateBrowserDirectory, type HostBrowserPlatform } from '../src/task-host-browser-chrome.js';
import { HostBrowserMailbox, HostBrowserReceipts, hostBrowserAction, hostBrowserSettings, type HostBrowserSnapshot } from '../src/task-host-browser-protocol.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

class FakeCDP extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  fail?: string;
  copied = '';
  hold?: { method: string; promise: Promise<void> };
  async send(method: string, params?: unknown): Promise<any> {
    this.calls.push({ method, params });
    if (method === this.fail) throw new Error('fixture failure');
    if (this.hold?.method === method) await this.hold.promise;
    if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{}, {}, {}] };
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'root' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from([137,80,78,71,13,10,26,10,0]).toString('base64') };
    if (method === 'Runtime.evaluate') { const value = this.copied; this.copied = ''; return { result: { value } }; }
    if (method === 'Input.dispatchKeyEvent' && ['copy', 'cut'].includes((params as any)?.commands?.[0])) this.copied = 'synthetic clipboard text';
    return {};
  }
}
class FakePage extends EventEmitter {
  cdp = new FakeCDP(); current = 'about:blank'; navigations: string[] = []; closed = false;
  constructor(readonly owner: FakePlatform) { super(); }
  navigation?: (url: string) => Promise<void>;
  url() { return this.current; }
  title() { return Promise.resolve('Synthetic protocol fixture'); }
  mainFrame() { return this; }
  frames() { return []; }
  async setViewportSize() {}
  context() { return this.owner.context; }
  async goto(url: string) { this.navigations.push(url); if (this.navigation) { await this.navigation(url); return; } this.current = url; this.emit('framenavigated', this); }
  async goBack() { this.navigations.push('back'); }
  async goForward() { this.navigations.push('forward'); }
  async reload() { this.navigations.push('reload'); }
  setDefaultTimeout() {} setDefaultNavigationTimeout() {}
  async close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
class FakePlatform implements HostBrowserPlatform {
  pages: FakePage[] = []; acquired: { profile: string; incognito: boolean; task: string }[] = []; released = 0; stopped = false;
  context = { newPage: async () => { const page = new FakePage(this); this.pages.push(page); return page; }, newCDPSession: async (page: FakePage) => page.cdp } as unknown as BrowserContext;
  async acquire(profile: string, incognito: boolean, task: string) { this.acquired.push({ profile, incognito, task }); let released = false; return { context: this.context, release: async () => { if (!released) { released = true; this.released++; } } }; }
  cleared: string[] = [];
  async clearProfile(profile: string) { this.cleared.push(profile); }
  async close() { this.stopped = true; }
}
const input = { taskId: 'task', tabId: 'tab', url: 'http://localhost:3000/', profile: 'default', width: 1280, height: 800 };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const platform = new FakePlatform(), browser = new TaskHostBrowsers('/unused-fixture', platform); t.after(() => browser.close());
  const state = await browser.open(input), attached = await browser.attach('task', 'tab', state.generation, 'viewer', 'owner');
  const event = await attached.mailbox.next(); assert.ok(event?.type === 'state');
  let sequence = 0;
  const command = (action: unknown, overrides: Record<string, unknown> = {}) => browser.command({ taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', controlGeneration: event.state.controlGeneration, requestId: 'request-' + (++sequence), sequence, action, ...overrides }, 'owner');
  return { platform, browser, state: event.state, attached, command };
}

test('Host browser rejects unbounded viewport, keys, coordinates and non-web navigation before any side effect', () => {
  assert.deepEqual(hostBrowserSettings({}), { width: 1280, height: 800, mobile: false, zoom: 1, appearance: 'system' });
  for (const raw of [{ width: 100 }, { width: 3840, height: 3840 }, { height: NaN }, { mobile: 'true' }, { zoom: Infinity }, { appearance: 'javascript' }]) assert.throws(() => hostBrowserSettings(raw));
  for (const raw of [{ type: 'navigate', url: 'file:///etc/passwd' }, { type: 'text', text: 'x'.repeat(8193) }, { type: 'text', text: '\0' }, { type: 'wheel', x: 0, y: 0, dx: Infinity, dy: 0, modifiers: 0 }, { type: 'key', key: 'x', code: 'KeyX', phase: 'down', modifiers: 16, repeat: false, keyCode: 88 }]) assert.throws(() => hostBrowserAction(raw));
  assert.deepEqual(hostBrowserAction({ type: 'text', text: '中文🙂' }), { type: 'text', text: '中文🙂' });
});
test('Frame mailbox keeps only the newest bounded frame and state, and gone drains without replay', async () => {
  const mailbox = new HostBrowserMailbox();
  for (let i = 0; i < 1000; i++) mailbox.offer({ type: 'frame', data: String(i), width: 1280, height: 800, sequence: i });
  mailbox.offer({ type: 'frame', data: 'x'.repeat(8 * 1024 * 1024 + 1), width: 1280, height: 800, sequence: 1001 });
  assert.deepEqual(await mailbox.next(), { type: 'frame', data: '999', width: 1280, height: 800, sequence: 999 });
  const next = mailbox.next(); mailbox.close(); assert.deepEqual(await next, { type: 'gone' }); assert.equal(await mailbox.next(), null);
});
test('Action receipts coalesce concurrent submissions, reject changed content, retain failure and prohibit evicted replay', async () => {
  const receipts = new HostBrowserReceipts(); let calls = 0; const action = async () => { calls++; return {} as HostBrowserSnapshot; };
  await Promise.all([receipts.run('v', 1, 'one', { text: 'a' }, action), receipts.run('v', 1, 'one', { text: 'a' }, action)]); assert.equal(calls, 1);
  assert.throws(() => receipts.run('v', 1, 'one', { text: 'b' }, action));
  for (let i = 2; i <= 520; i++) await receipts.run('v', i, 'id' + i, {}, action);
  assert.throws(() => receipts.run('v', 1, 'one', { text: 'a' }, action), /旧/);
  const failed = () => receipts.run('v', 521, 'failed', {}, async () => { calls++; throw new Error('uncertain'); }); const before = calls;
  await assert.rejects(failed()); await assert.rejects(failed()); assert.equal(calls, before + 1);
});
test('Opening and reconnecting retain a task page without repeating navigation; different task and profile remain scoped', async t => {
  const { browser, platform, state, attached } = await setup(t); await browser.open({ ...input, url: 'https://other.invalid/' }); assert.equal(platform.pages.length, 1); assert.deepEqual(platform.pages[0].navigations, [input.url]);
  await attached.detach(); const again = await browser.attach('task', 'tab', state.generation, 'new-viewer', 'device'); assert.equal((await again.mailbox.next())?.type, 'state'); assert.equal(platform.pages[0].closed, false);
  await browser.open({ ...input, taskId: 'other-task', profile: 'personal', incognito: true }); assert.equal(platform.pages.length, 2); assert.deepEqual(platform.acquired[1], { task: 'other-task', profile: 'personal', incognito: true });
  await assert.rejects(browser.open({ ...input, profile: 'wrong' }), /另一/);
  await assert.rejects(browser.attach('other-task', 'tab', state.generation, 'foreign', 'owner'), /变化/);
});
test('Only the authenticated controlling viewer sends ordered input; takeover releases held keys and invalidates old queued events', async t => {
  const { browser, platform, state, command } = await setup(t), cdp = platform.pages[0].cdp;
  await command({ type: 'key', phase: 'down', key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers: 8, repeat: false });
  const other = await browser.attach('task', 'tab', state.generation, 'second', 'device'); await other.mailbox.next();
  const base = { taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'second', sequence: 1, requestId: 'steal', action: { type: 'claim' } };
  const next = await browser.command(base, 'device'); assert.equal(next.controller, 'second');
  assert.ok(cdp.calls.some(call => call.method === 'Input.dispatchKeyEvent' && call.params.type === 'keyUp'));
  await assert.rejects(command({ type: 'text', text: 'old' }), /控制权/);
  await assert.rejects(browser.command({ ...base, sequence: 2, requestId: 'foreign', controlGeneration: next.controlGeneration, action: { type: 'text', text: 'secret' } }, 'owner'), /连接/);
  const operations = cdp.calls.filter(call => call.method === 'Input.insertText'); assert.equal(operations.length, 0);
});
test('Input failures are recorded once and do not automatically repeat side effects', async t => {
  const { platform, command } = await setup(t), cdp = platform.pages[0].cdp; cdp.fail = 'Input.insertText';
  const body = { sequence: 10, requestId: 'uncertain' }; await assert.rejects(command({ type: 'text', text: 'once' }, body), /尚未确认/); await assert.rejects(command({ type: 'text', text: 'once' }, body), /尚未确认/);
  assert.equal(cdp.calls.filter(call => call.method === 'Input.insertText').length, 1);
});
test('Disconnect releases pressed pointer and control, stops capture and keeps the service page until task deletion', async t => {
  const { browser, platform, state, command, attached } = await setup(t), cdp = platform.pages[0].cdp;
  await command({ type: 'pointer', phase: 'down', x: 100, y: 200, button: 'left', buttons: 1, modifiers: 0, clicks: 1 });
  await attached.detach(); await tick(); assert.ok(cdp.calls.some(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased')); assert.ok(cdp.calls.some(call => call.method === 'Page.stopScreencast')); assert.equal(platform.pages[0].closed, false);
  await browser.deleteTask('task'); assert.equal(platform.pages[0].closed, true); await assert.rejects(browser.attach('task', 'tab', state.generation, 'v', 'owner')); await assert.rejects(browser.open(input), /删除/);
});
test('Stream start failure terminates its attempt instead of entering a restart loop', async t => {
  const platform = new FakePlatform(), browser = new TaskHostBrowsers('/unused', platform); t.after(() => browser.close());
  const state = await browser.open(input); platform.pages[0].cdp.fail = 'Page.startScreencast'; const viewer = await browser.attach('task', 'tab', state.generation, 'v', 'owner'); await tick();
  assert.equal(platform.pages[0].cdp.calls.filter(call => call.method === 'Page.startScreencast').length, 1); const latest = await viewer.mailbox.next(); assert.ok(latest?.type === 'state' && latest.state.error?.includes('传输'));
});
test('Frame flow remains bounded and releases capture when viewers leave; no real page capture is used', async t => {
  const { attached, platform } = await setup(t), cdp = platform.pages[0].cdp;
  cdp.emit('Page.screencastFrame', { sessionId: 1, data: Buffer.from('synthetic-image-protocol').toString('base64') });
  const event = await attached.mailbox.next(); assert.ok(event?.type === 'frame'); assert.equal(event.data, Buffer.from('synthetic-image-protocol').toString('base64'));
  await attached.detach(); assert.deepEqual(await attached.mailbox.next(), { type: 'gone' });
});
test('Host browser directories reject existing and dangling symlinks and retain private modes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-host-private-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await privateBrowserDirectory(join(directory, 'safe')); assert.equal((await stat(join(directory, 'safe'))).mode & 0o777, 0o700);
  await symlink(join(directory, 'safe'), join(directory, 'link')); await symlink(join(directory, 'missing'), join(directory, 'dangling'));
  await assert.rejects(privateBrowserDirectory(join(directory, 'link'))); await assert.rejects(privateBrowserDirectory(join(directory, 'dangling')));
});
test('A slow native viewer receives one frame plus the newest pending frame and cannot acknowledge another device', async t => {
  const { browser, attached, platform, state } = await setup(t), cdp = platform.pages[0].cdp;
  const firstClock = Date.now; let now = firstClock(); Date.now = () => now;
  t.after(async () => { Date.now = firstClock; });
  try {
    for (let i = 1; i <= 100; i++) { now += 40; cdp.emit('Page.screencastFrame', { sessionId: i, data: 'synthetic-' + i }); }
    const first = await attached.mailbox.next(); assert.ok(first?.type === 'frame'); assert.equal(first.data, 'synthetic-1');
    const ack = { taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', sequence: first.sequence };
    await assert.rejects(browser.ackFrame(ack, 'foreign-device'), /连接/); await browser.ackFrame(ack, 'owner');
    const latest = await attached.mailbox.next(); assert.ok(latest?.type === 'frame'); assert.equal(latest.data, 'synthetic-100');
  } finally { Date.now = firstClock; }
});
test('Dialog replies and stop bypass an outstanding input without replaying it', async t => {
  const { browser, platform, command } = await setup(t), page = platform.pages[0];
  let release!: () => void; page.cdp.hold = { method: 'Input.insertText', promise: new Promise<void>(resolve => { release = resolve; }) };
  const pending = command({ type: 'text', text: 'once' }); await tick();
  let answered = false; page.emit('dialog', { type: () => 'confirm', message: () => 'Synthetic', defaultValue: () => '', accept: async () => { answered = true; }, dismiss: async () => {} });
  const connected = await browser.open(input); assert.ok(connected.dialog);
  await command({ type: 'dialog', id: connected.dialog.id, accept: true, text: '' }); assert.equal(answered, true);
  await command({ type: 'stop' }); assert.ok(page.cdp.calls.some(call => call.method === 'Page.stopLoading'));
  release(); await pending; assert.equal(page.cdp.calls.filter(call => call.method === 'Input.insertText').length, 1);
});
test('Native touch input retains browser gestures and releases an unfinished touch on disconnect', async t => {
  const { command, platform, attached } = await setup(t), cdp = platform.pages[0].cdp;
  await command({ type: 'touch', phase: 'start', x: 120, y: 250 });
  await command({ type: 'touch', phase: 'move', x: 120, y: 210 });
  assert.ok(cdp.calls.some(call => call.method === 'Emulation.setTouchEmulationEnabled' && call.params.enabled === true));
  assert.deepEqual(cdp.calls.filter(call => call.method === 'Input.dispatchTouchEvent').map(call => call.params.type), ['touchStart', 'touchMove']);
  await attached.detach(); assert.equal(cdp.calls.filter(call => call.method === 'Input.dispatchTouchEvent').at(-1)?.params.type, 'touchCancel');
});
test('Real service routes reject unauthenticated, cross-origin, foreign task and stale generation before operating a host page', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-host-api-'))), root = join(directory, 'project'); await mkdir(root);
  const engine = await new Engine(join(directory, 'data'), { run: async () => 'fixture', steer: async () => {}, answer: async () => {} }).open(), auth = new Auth(join(directory, 'data')), platform = new FakePlatform(), browser = new TaskHostBrowsers(directory, platform);
  t.after(async () => { await browser.close(); await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'fixture', path: root, context: '' }));
  const api = createAPI(engine, auth, () => [], { hostBrowsers: browser }), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const post = (path: string, body: unknown, override: Record<string, string> = {}) => api.request('/api/task-browser/host/' + path, { method: 'POST', headers: { ...headers, ...override }, body: JSON.stringify(body) });
  assert.equal((await post('open', input, { Authorization: '' })).status, 401); assert.equal((await post('open', input, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await post('open', input)).status, 400); assert.equal(platform.pages.length, 0);
  const response = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'fixture', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'host-fixture' }) }); assert.equal(response.status, 201); const { id } = await response.json() as { id: string };
  const open = await post('open', { ...input, taskId: id }); assert.equal(open.status, 200); const state = await open.json() as HostBrowserSnapshot;
  assert.equal((await post('close', { taskId: id, tabId: 'tab', generation: 'old' })).status, 409); assert.equal((await post('command', { taskId: id, tabId: 'tab', generation: state.generation, viewer: 'v', action: { type: 'text', text: 'no-viewer' } })).status, 409);
  const gone = await api.request('/api/task-browser/host/events?taskId=' + id + '&tabId=tab&generation=stale&viewer=v', { headers }); assert.equal(gone.status, 409);
  const uploadViewer = await browser.attach(id, 'tab', state.generation, 'uploader', 'owner'); await uploadViewer.mailbox.next();
  const chooser = chooserFixture(); platform.pages[0].emit('filechooser', chooser.chooser); await tick();
  const picker = await browser.open({ ...input, taskId: id });
  const query = new URLSearchParams({ taskId: id, tabId: 'tab', generation: state.generation, viewer: 'uploader', controlGeneration: String(picker.controlGeneration), chooser: picker.chooser!.id, requestId: 'http-upload', sequence: '100', digest: hostUploadManifest(uploadFixture) });
  const form = () => { const value = new FormData(); value.append('files', new File([uploadFixture[0].buffer], uploadFixture[0].name, { type: uploadFixture[0].mimeType })); return value; };
  const uploadPath = '/api/task-browser/host/upload?' + query;
  assert.equal((await api.request(uploadPath, { method: 'POST', body: form() })).status, 401);
  assert.equal((await api.request(uploadPath, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, Origin: 'https://foreign.invalid' }, body: form() })).status, 403);
  assert.equal((await api.request(uploadPath, { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token }, body: form() })).status, 200); assert.deepEqual(chooser.submissions[0], uploadFixture);
  const downloadBytes = Buffer.from('synthetic HTTP download'); platform.pages[0].emit('download', downloadFixture(downloadBytes).download);
  let saved: HostBrowserSnapshot | undefined;
  for (let count = 0; count < 100; count++) { saved = await browser.open({ ...input, taskId: id }); if (saved.downloads?.[0]?.status === 'ready') break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(saved?.downloads?.[0]?.status, 'ready');
  const downloadPath = '/api/task-browser/host/download?' + new URLSearchParams({ taskId: id, tabId: 'tab', generation: state.generation, id: saved!.downloads![0].id });
  assert.equal((await api.request(downloadPath)).status, 401);
  const fragment = await api.request(downloadPath, { headers: { Authorization: 'Bearer ' + auth.token, Range: 'bytes=0-8' } }); assert.equal(fragment.status, 206); assert.deepEqual(Buffer.from(await fragment.arrayBuffer()), downloadBytes.subarray(0, 9)); assert.match(fragment.headers.get('Content-Disposition')!, /^attachment;/);
  const captureBody = { taskId: id, tabId: 'tab', generation: state.generation, viewer: 'uploader', document: picker.documentId };
  assert.equal((await post('capture', captureBody, { Authorization: '' })).status, 401);
  assert.equal((await post('capture', { ...captureBody, viewer: 'not-the-viewer' })).status, 409);
  assert.equal((await post('capture', { ...captureBody, document: 'old-document' })).status, 409);
  const capture = await post('capture', captureBody); assert.equal(capture.status, 200); assert.equal(capture.headers.get('Content-Type'), 'image/png'); assert.equal(capture.headers.get('X-Friday-Capture-Document'), picker.documentId); assert.equal((await capture.arrayBuffer()).byteLength, 9);
  const recording = { ...captureBody, action: 'start', id: 'native-recording', keys: false };
  assert.equal((await post('recording', recording)).status, 200); assert.ok(platform.pages[0].cdp.calls.some(call => call.method === 'Page.startScreencast' && call.params.quality === 90));
  assert.equal((await post('recording', { ...recording, action: 'stop' })).status, 200);
  assert.equal((await post('recording', recording)).status, 409);
  const annotation = { ...captureBody, controlGeneration: picker.controlGeneration, id: 'native-annotation', action: 'start' };
  assert.equal((await post('annotation', annotation, { Authorization: '' })).status, 401);
  assert.equal((await post('annotation', annotation, { Origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await post('annotation', { ...annotation, taskId: 'missing-task' })).status, 400);
  assert.equal((await post('annotation', { ...annotation, viewer: 'foreign' })).status, 409);
  assert.equal((await post('annotation', { ...annotation, controlGeneration: picker.controlGeneration + 1 })).status, 409);
  assert.equal((await post('annotation', { ...annotation, document: 'stale' })).status, 409);
  assert.equal((await post('annotation', annotation)).status, 200);
  assert.equal((await post('annotation', { ...annotation, action: 'evaluate', script: 'not-allowed' })).status, 400);
  assert.equal((await post('annotation', { ...annotation, action: 'stop', viewer: 'foreign' })).status, 409);
  assert.equal((await post('annotation', { ...annotation, action: 'stop' })).status, 200);
  assert.equal((await post('annotation', annotation)).status, 409);
  assert.equal((await api.request('/api/task-browser/profiles/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profile: 'default' }) })).status, 401);
  assert.equal((await api.request('/api/task-browser/profiles/clear', { method: 'POST', headers, body: JSON.stringify({ profile: 'bad\nprofile' }) })).status, 400);
  await uploadViewer.detach();
  const paired = auth.pair(auth.createPairing().code, 'native-stream-fixture', 'local');
  const live = await api.request('/api/task-browser/host/events?taskId=' + id + '&tabId=tab&generation=' + state.generation + '&viewer=paired-viewer', { headers: { Authorization: 'Bearer ' + paired.token } });
  assert.equal(live.status, 200); assert.ok(live.headers.get('content-type')?.includes('text/event-stream'));
  const reader = live.body!.getReader(), first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: state/);
  auth.revoke(paired.id);
  const end = await Promise.race([reader.read(), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('Revoked browser stream did not close')), 2500); timer.unref(); })]); assert.equal(end.done, true);
});
// This verifies process launch and shutdown only. It never takes a screenshot, inspects a window or reads a real page.
test('Installed Chrome starts in a private service profile with sandbox and closes without opening a client window', { skip: process.platform !== 'darwin' }, async t => {
  try { await hostBrowserExecutable(); } catch { t.skip('Chrome is not installed on this host'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'friday-chrome-launch-')), contexts = new HostChromeContexts(directory);
  t.after(async () => { await contexts.close(); await rm(directory, { recursive: true, force: true }); });
  const lease = await contexts.acquire('protocol-launch', false, 'fixture'); assert.ok(lease.context); await lease.release();
});

const uploadFixture = [{ name: '中文.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic upload 中文') }];
function chooserFixture(multiple = false) {
  const submissions: unknown[] = [];
  const chooser = { isMultiple: () => multiple, element: () => ({ getAttribute: async () => '.txt,text/plain' }), setFiles: async (files: unknown) => { submissions.push(files); } } as unknown as FileChooser;
  return { chooser, submissions };
}
async function waitFor<T>(read: () => T, valid: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) { const value = read(); if (valid(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Host transfer fixture timed out');
}
function downloadFixture(bytes: Buffer, name = '../文档.txt') {
  let cancelled = 0;
  const download = { url: () => input.url, suggestedFilename: () => name, createReadStream: async () => Readable.from([bytes]), cancel: async () => { cancelled++; } } as unknown as Download;
  return { download, cancelled: () => cancelled };
}
test('File picker answers are bound to viewer, chooser and control generation; duplicate upload applies buffers once', async t => {
  const { browser, platform, state } = await setup(t), fixture = chooserFixture(); platform.pages[0].emit('filechooser', fixture.chooser); await tick();
  const current = await browser.open(input); assert.ok(current.chooser);
  const body = { taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', controlGeneration: current.controlGeneration, chooser: current.chooser.id, requestId: 'upload', sequence: 20, digest: hostUploadManifest(uploadFixture) };
  let reads = 0; const read = async () => { reads++; return uploadFixture; };
  await browser.upload(body, 'owner', read); await browser.upload(body, 'owner', read); assert.equal(reads, 1); assert.equal(fixture.submissions.length, 1); assert.deepEqual(fixture.submissions[0], uploadFixture);
  assert.equal((await browser.open(input)).chooser, null);
  await assert.rejects(browser.upload({ ...body, requestId: 'foreign', sequence: 21 }, 'foreign-device', read)); assert.equal(reads, 1);
});
test('Taking control refreshes the picker ID and stale native file choices never reach the page', async t => {
  const { browser, platform, state } = await setup(t), fixture = chooserFixture(true); platform.pages[0].emit('filechooser', fixture.chooser); await tick();
  const old = await browser.open(input); const other = await browser.attach('task', 'tab', state.generation, 'second', 'device'); await other.mailbox.next();
  const changed = await browser.command({ taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'second', requestId: 'take', sequence: 1, action: { type: 'claim' } }, 'device');
  assert.notEqual(changed.chooser?.id, old.chooser?.id); assert.equal(changed.chooser?.offeredTo, 'second'); let reads = 0;
  await assert.rejects(browser.upload({ taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', controlGeneration: old.controlGeneration, chooser: old.chooser!.id, requestId: 'old-upload', sequence: 10, digest: hostUploadManifest(uploadFixture) }, 'owner', async () => { reads++; return uploadFixture; }));
  assert.equal(reads, 0); assert.equal(fixture.submissions.length, 0);
});
test('Cancelling a picker preserves its previous input files and does not call setFiles with an empty replacement', async t => {
  const { browser, platform, state } = await setup(t), fixture = chooserFixture(); platform.pages[0].emit('filechooser', fixture.chooser); await tick();
  const current = await browser.open(input);
  await browser.upload({ taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', controlGeneration: current.controlGeneration, chooser: current.chooser!.id, requestId: 'cancel-upload', sequence: 3, digest: hostUploadManifest([]) }, 'owner', async () => []);
  assert.equal(fixture.submissions.length, 0); assert.equal((await browser.open(input)).chooser, null);
});
test('Multipart parser enforces actual stream bytes, counts and immutable upload digests', async () => {
  const form = new FormData(); form.append('files', new File([uploadFixture[0].buffer], uploadFixture[0].name, { type: 'text/plain' }));
  const request = () => new Request('http://fixture/upload', { method: 'POST', body: form });
  const files = await hostUploadFiles(request()); assert.deepEqual(files, uploadFixture); validateHostUploads(files, false, hostUploadManifest(files));
  assert.throws(() => validateHostUploads(files, false, '0'.repeat(64))); assert.throws(() => validateHostUploads([...files, ...files], false, hostUploadManifest([...files, ...files])));
  assert.throws(() => validateHostUploads(new Array(21).fill(files[0]), true, '0'.repeat(64)));
  const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(256)); controller.close(); } });
  await assert.rejects(hostUploadFiles(new Request('http://fixture/upload', { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=fixture' }, body: oversized, duplex: 'half' } as RequestInit & { duplex: string }), 16));
  const invalid = new FormData(); invalid.append('path', '/host/private-file'); await assert.rejects(hostUploadFiles(new Request('http://fixture/upload', { method: 'POST', body: invalid })));
  assert.equal(hostUploadMaxFiles, 20); assert.equal(hostUploadMaxBytes, 104857600); assert.equal(hostDownloadMaxBytes, 1073741824); assert.equal(hostDownloadLimit, 20);
});
test('Private download cache streams exact bytes and ranges, exposes no host paths and rejects replaced files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-host-download-')), cache = new HostBrowserTransfers(directory, 'generation', () => {}, () => 'viewer'); t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }); });
  const bytes = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251)), fixture = downloadFixture(bytes); cache.receive(fixture.download);
  const item = await waitFor(() => cache.downloads[0], item => item?.status === 'ready'); assert.equal(item.fileName, '文档.txt'); assert.equal(item.offeredTo, 'viewer'); assert.equal(JSON.stringify(item).includes(directory), false);
  const response = await taskMediaResponse(await cache.open(item.id), { method: 'GET', range: 'bytes=10-25' }); assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(10, 26));
  const head = await taskMediaResponse(await cache.open(item.id), { method: 'HEAD' }); assert.equal(head.headers.get('Content-Length'), String(bytes.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const path = join(directory, 'browser/transfers/generation', item.id); assert.equal((await stat(path)).mode & 0o777, 0o600); await writeFile(path, bytes); await assert.rejects(cache.open(item.id), /变化/); await unlink(path); await symlink('/etc/hosts', path); await assert.rejects(cache.open(item.id));
});
test('Oversized and interrupted download writes are cancelled and never promoted to a ready artifact', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-host-limit-')), cache = new HostBrowserTransfers(directory, 'generation', () => {}, () => null, 4); t.after(async () => { await cache.close(); await rm(directory, { recursive: true, force: true }); });
  const fixture = downloadFixture(Buffer.from('too large')); cache.receive(fixture.download);
  const failed = await waitFor(() => cache.downloads[0], item => item?.status === 'failed'); assert.match(failed.error!, /1 GiB/); assert.equal(fixture.cancelled(), 1); await assert.rejects(cache.open(failed.id));
});
test('Clipboard editing commands match Cmd/Ctrl behavior and copied text is returned only to the requesting viewer', async t => {
  assert.equal(hostEditingCommand('c', 4), 'copy'); assert.equal(hostEditingCommand('x', 2), 'cut'); assert.equal(hostEditingCommand('z', 12), 'redo'); assert.equal(hostEditingCommand('a', 4), 'selectAll'); assert.equal(hostEditingCommand('a', 2), null); assert.equal(hostEditingCommand('c', 6), null);
  const { command, browser } = await setup(t); const result = await command({ type: 'edit', command: 'copy' }); assert.equal(result.clipboardText, 'synthetic clipboard text');
  assert.equal((await browser.open(input)).clipboardText, undefined);
});
test('Isolated clipboard recorder accepts only trusted copy/cut keys, captures page overrides and never reads the shared OS clipboard', () => {
  const listeners = new Map<string, ((event: any) => void)[]>(), timers: (() => void)[] = [];
  class Field { value = 'field selection'; selectionStart = 0; selectionEnd = 5; }
  const sandbox: any = { HTMLInputElement: Field, HTMLTextAreaElement: class {}, document: { activeElement: new Field(), getSelection: () => 'document selection' }, addEventListener: (name: string, callback: (event: any) => void) => { listeners.set(name, [...listeners.get(name) ?? [], callback]); }, setTimeout: (callback: () => void) => { timers.push(callback); } };
  runInNewContext(hostClipboardScript, sandbox);
  const emit = (name: string, event: any) => { for (const listener of listeners.get(name) ?? []) listener(event); };
  emit('keydown', { key: 'c', ctrlKey: true, metaKey: false, altKey: false, isTrusted: false }); emit('copy', { isTrusted: true }); assert.equal(sandbox.takeCopy(), '');
  emit('keydown', { key: 'c', ctrlKey: true, metaKey: false, altKey: false, isTrusted: true }); emit('copy', { isTrusted: true, defaultPrevented: false }); assert.equal(sandbox.takeCopy(), 'field'); assert.equal(sandbox.takeCopy(), '');
  emit('copy', { isTrusted: true, defaultPrevented: true, clipboardData: { getData: () => 'page override' } }); assert.equal(sandbox.takeCopy(), 'page override');
  for (const timer of timers) timer(); emit('copy', { isTrusted: true }); assert.equal(sandbox.takeCopy(), ''); assert.equal('navigator' in sandbox, false);
});
test('Transfer limits and 128 editing combinations match the executed pinned T3 source', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/t3-host-browser-transfers.json', import.meta.url), 'utf8'));
  assert.equal(fixture.editing.length, 128); for (const entry of fixture.editing) assert.equal(hostEditingCommand(entry.key, entry.modifiers), entry.command);
  assert.deepEqual(fixture.limits, { uploadFiles: hostUploadMaxFiles, uploadBytes: hostUploadMaxBytes, downloadFiles: hostDownloadLimit, downloadBytes: hostDownloadMaxBytes });
  const files = fixture.upload.files.map((file: any) => ({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.base64, 'base64') })); assert.equal(hostUploadManifest(files), fixture.upload.digest);
});

test('Navigation that becomes a matching download settles successfully without reporting an uncertain page operation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-host-nav-download-')), platform = new FakePlatform(), browser = new TaskHostBrowsers(directory, platform); t.after(async () => { await browser.close(); await rm(directory, { recursive: true, force: true }); });
  const opened = await browser.open(input), viewer = await browser.attach('task', 'tab', opened.generation, 'viewer', 'owner'); const event = await viewer.mailbox.next(); assert.ok(event?.type === 'state');
  platform.pages[0].navigation = async () => { setTimeout(() => platform.pages[0].emit('download', downloadFixture(Buffer.from('native download navigation')).download), 10); throw new Error('page.goto: net::ERR_ABORTED'); };
  const result = await browser.command({ taskId: 'task', tabId: 'tab', generation: opened.generation, viewer: 'viewer', controlGeneration: event.state.controlGeneration, sequence: 1, requestId: 'download-navigation', action: { type: 'navigate', url: input.url } }, 'owner');
  assert.equal(result.error, null); assert.equal(result.loading, false); assert.equal(result.downloads?.length, 1);
});

test('Concurrent uploads queue before reading large bodies and every valid file choice eventually completes', async t => {
  const { browser, platform } = await setup(t); const releases:(() => void)[] = []; let reads = 0;
  const requests:Record<string,unknown>[] = [];
  for (let index = 0; index < 3; index++) {
    const id = 'queued-tab-' + index, state = await browser.open({ ...input, tabId: id }); const view = await browser.attach('task', id, state.generation, 'queue-viewer-' + index, 'owner'); const event = await view.mailbox.next(); assert.ok(event?.type === 'state');
    platform.pages.at(-1)!.emit('filechooser', chooserFixture().chooser); await tick(); const open = await browser.open({ ...input, tabId: id });
    requests.push({ taskId: 'task', tabId: id, generation: state.generation, viewer: 'queue-viewer-' + index, controlGeneration: event.state.controlGeneration, chooser: open.chooser!.id, requestId: 'queued-upload-' + index, sequence: 1, digest: hostUploadManifest(uploadFixture) });
  }
  const pending = requests.map(body => browser.upload(body, 'owner', async () => { reads++; await new Promise<void>(resolve => releases.push(resolve)); return uploadFixture; })); for (const request of pending) void request.catch(() => {});
  await tick(); assert.equal(reads, 2); releases[0](); await tick(); assert.equal(reads, 3); releases[1](); releases[2](); const results = await Promise.all(pending); assert.ok(results.every(result => result.chooser === null));
});

test('Host annotations are invalidated by control takeover, document navigation and viewer detachment without exposing private capture data', async t => {
  const { browser, platform, state, attached } = await setup(t);
  const body = { taskId: 'task', tabId: 'tab', generation: state.generation, viewer: 'viewer', document: state.documentId, controlGeneration: state.controlGeneration, id: 'picker', action: 'start' };
  await browser.annotation(body, 'owner');
  const observer = await browser.attach('task', 'tab', state.generation, 'observer', 'other'); const event = await observer.mailbox.next();
  assert.ok(event?.type === 'state'); assert.equal('annotation' in event.state, false);
  await browser.command({ ...body, viewer: 'observer', sequence: 1, requestId: 'takeover', action: { type: 'claim' } }, 'other');
  await assert.rejects(browser.annotation({ ...body, action: 'read' }, 'owner'), /变化/);
  const fresh = await browser.open(input); const next = { ...body, viewer: 'observer', controlGeneration: fresh.controlGeneration, id: 'next' }; await browser.annotation(next, 'other');
  platform.pages[0].emit('framenavigated', platform.pages[0]); await tick();
  await assert.rejects(browser.annotation({ ...next, action: 'read' }, 'other'), /变化/);
  const navigated = await browser.open(input); const third = { ...next, id: 'third', document: navigated.documentId }; await browser.annotation(third, 'other');
  await observer.detach(); await assert.rejects(browser.annotation({ ...third, action: 'read' }, 'other'), /变化/); await attached.detach();
  assert.ok(platform.pages[0].cdp.calls.filter(call => call.method === 'Runtime.evaluate' && call.params.expression?.includes('FridayBrowserPicker?.stop')).length >= 3);
});

test('Clearing a persistent profile closes its task pages and original popup generation, preserves other profiles and never replays old navigation', async t => {
  const { browser, platform, state } = await setup(t);
  await browser.open({ ...input, taskId: 'other', profile: 'other-profile' });
  const popup = new FakePage(platform); platform.pages[0].emit('popup', popup); await tick(); await tick();
  const before = await browser.open(input), child = before.popups[0]; assert.ok(child);
  assert.deepEqual(await browser.clearProfile('default'), { ok: true }); assert.deepEqual(platform.cleared, ['default']); assert.equal(platform.pages[0].closed, true); assert.equal(popup.closed, true); assert.equal(platform.pages[1].closed, false);
  await assert.rejects(browser.open({ ...input, generation: state.generation }), /关闭/);
  await assert.rejects(browser.open({ ...input, tabId: child.tabId, generation: child.generation }), /关闭/);
  assert.deepEqual(platform.pages[0].navigations, [input.url]);
});
test('Profile clearing is a barrier for new opens, coalesces repeats and leaves incognito contexts alone like the pinned T3 server', async t => {
  const { browser, platform } = await setup(t); let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  platform.clearProfile = async profile => { platform.cleared.push(profile); await hold; };
  const clearing = browser.clearProfile('default'); const repeated = browser.clearProfile('default'); let opened = false;
  const next = browser.open({ ...input, tabId: 'new-tab' }).then(value => { opened = true; return value; }); await tick(); assert.equal(opened, false); release(); await Promise.all([clearing, repeated, next]); assert.deepEqual(platform.cleared, ['default']);
  await browser.clearProfile('incognito'); assert.deepEqual(platform.cleared, ['default']);
});
test('Closed profile deletion removes only its hashed private directory and rejects profile or ancestor symlinks', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-profile-clear-'))), platform = new HostChromeContexts(directory); t.after(async () => { await platform.close(); await rm(directory, { recursive: true, force: true }); });
  const { createHash } = await import('node:crypto'); const root = join(directory, 'browser'), profiles = join(root, 'profiles'), profile = join(profiles, createHash('sha256').update('work').digest('hex')), other = join(profiles, 'other');
  await mkdir(profile, { recursive: true }); await mkdir(other); await writeFile(join(profile, 'Cookies'), 'synthetic'); await writeFile(join(other, 'keep'), 'synthetic');
  await platform.clearProfile('work'); await assert.rejects(stat(profile)); assert.equal((await stat(join(other, 'keep'))).isFile(), true);
  await symlink(other, profile); await assert.rejects(platform.clearProfile('work'), /私有目录/); assert.equal((await stat(join(other, 'keep'))).isFile(), true);
  await assert.rejects(platform.clearProfile('work\nother'), /标识/);
  await unlink(profile); const saved = join(directory, 'saved-profiles'); await rename(profiles, saved); await symlink(saved, profiles); await assert.rejects(platform.clearProfile('work'), /私有目录/); assert.equal((await stat(join(saved, 'other', 'keep'))).isFile(), true);
});
test('A failed backend profile clear keeps task pages and original generations available for an explicit retry', async t => {
  const { browser, platform, state } = await setup(t);
  platform.clearProfile = async () => { throw new Error('synthetic close failed'); };
  await assert.rejects(browser.clearProfile('default'), /close failed/); assert.equal(platform.pages[0].closed, false);
  assert.equal((await browser.open({ ...input, generation: state.generation })).generation, state.generation);
  platform.clearProfile = async profile => { platform.cleared.push(profile); }; await browser.clearProfile('default'); assert.equal(platform.pages[0].closed, true);
});
