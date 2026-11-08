import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskBrowserDiscovery, browserConfiguredURLs, browserWebResponse, parseBrowserListeners, resolveBrowserAddress } from '../src/task-browser.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

async function fixture<T>(name: string) { return JSON.parse(await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8')) as T; }
async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); return address.port; }

test('Address input matches the pinned T3 browser address resolver including search, Unicode and explicit schemes', async () => {
  const { cases } = await fixture<{ cases: { input: string; url?: string; error?: boolean }[] }>('t3-browser-addresses.json');
  assert.equal(cases.length, 39);
  for (const value of cases) { if (value.error) assert.throws(() => resolveBrowserAddress(value.input), value.input); else assert.equal(resolveBrowserAddress(value.input), value.url, value.input); }
  assert.throws(() => resolveBrowserAddress('https://example.com/' + 'x'.repeat(2048)));
  assert.throws(() => resolveBrowserAddress('中'.repeat(1000)));
});
test('Listener projection matches actual upstream parsing for dual stack, wildcard, duplicate ports and malformed lsof records', async () => {
  const { cases } = await fixture<{ cases: { input: string; servers: unknown }[] }>('t3-browser-listeners.json');
  assert.equal(cases.length, 12); for (const value of cases) assert.deepEqual(parseBrowserListeners(value.input), value.servers, value.input);
});
test('Configured discovery accepts loopback paths and deduplicates equivalent interfaces without probing arbitrary remote hosts', async () => {
  assert.deepEqual(browserConfiguredURLs(['http://localhost:3000/app?q=1', 'http://127.0.0.1:3000/other', 'https://[::1]:4443/', 'http://0.0.0.0:3000/']), ['http://localhost:3000/app?q=1', 'http://127.0.0.1:3000/other', 'https://[::1]:4443/', 'http://localhost:3000/']);
  assert.deepEqual(browserConfiguredURLs(['https://example.com/', 'file:///tmp/project', 'localhost:3000']), []);
  let calls = 0; const discovery = new TaskBrowserDiscovery(async () => { calls++; return ''; });
  for (const configured of [new Array(33).fill('http://localhost:3000'), 'http://localhost:3000', [42], ['']]) await assert.rejects(discovery.list(configured));
  assert.equal(calls, 0);
  assert.deepEqual((await discovery.list()).servers, []); assert.equal(calls, 0, 'No terminal discovery scans remain without configured URLs');
});
test('HTTP classification matches T3 HTML and manual navigation redirects, omitting API, empty and error responses', () => {
  for (const status of [200, 201, 202, 206, 299]) assert.equal(browserWebResponse(status, 'Text/HTML; charset=utf-8', null), true);
  assert.equal(browserWebResponse(200, 'application/xhtml+xml', null), true);
  for (const status of [204, 205, 400, 401, 403, 404, 500]) assert.equal(browserWebResponse(status, 'text/html', null), false);
  for (const status of [301, 302, 303, 307, 308]) { assert.equal(browserWebResponse(status, null, '/login'), true); assert.equal(browserWebResponse(status, null, ' '), false); }
  for (const type of ['application/json', 'text/plain', null]) assert.equal(browserWebResponse(200, type, null), false);
});
test('Discovery probes real HTML once per URL and owner, coalesces scanner reads and never follows a redirect', async t => {
  const hits: string[] = []; const web = createServer((request, response) => {
    hits.push(request.url ?? '');
    if (request.url === '/go') { response.writeHead(302, { Location: '/must-not-follow' }); response.end(); }
    else if (request.url === '/api') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); }
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Fixture</title>'); }
  });
  const port = await listen(web); t.after(() => { web.closeAllConnections(); web.close(); });
  let reads = 0; const scanner = new TaskBrowserDiscovery(async () => { reads++; await new Promise(resolve => setTimeout(resolve, 10)); return `p42\ncfixture\nn127.0.0.1:${port}\n`; });
  const [a, b] = await Promise.all([scanner.list([`http://localhost:${port}`]), scanner.list([`http://localhost:${port}`])]); assert.equal(reads, 1); assert.equal(a.servers[0]?.port, port); assert.equal(b.servers[0]?.processName, 'fixture');
  await scanner.list(); assert.equal(hits.filter(value => value === '/').length, 1);
  const override = await scanner.list([`http://localhost:${port}/go`]); assert.equal(override.servers[0]?.url, `http://localhost:${port}/go`); assert.equal(hits.includes('/must-not-follow'), false);
  const api = await scanner.list([`http://localhost:${port}/api`]); assert.equal(api.servers.length, 0);
});
test('Unowned and shared listener ports receive no automatic probes, while an explicit configuration can be opened', async () => {
  const probed: string[] = [];
  const scanner = new TaskBrowserDiscovery(async () => 'p42\ncowned\nn*:3000\np99\ncforeign\nn*:3000\nn*:4000\n', async url => { probed.push(url); return true; });
  assert.deepEqual((await scanner.list()).servers, []); assert.deepEqual(probed, []);
  assert.equal((await scanner.list(['http://localhost:4000/app'])).servers[0]?.url, 'http://localhost:4000/app'); assert.deepEqual(probed, ['http://localhost:4000/app']);
});
test('The real API requires authentication and a real task before normalizing or scanning browser targets', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-browser-'))), root = join(base, 'project'); await mkdir(root);
  const engine = await new Engine(join(base, 'data'), { run: async () => 'fixture', steer: async () => {}, answer: async () => {} }).open(), auth = new Auth(join(base, 'data'));
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  let scans = 0, taskId = ''; const scanner = new TaskBrowserDiscovery(async () => { scans++; return 'p42\ncfixture\nn*:3000\n'; }, async () => true);
  const api = createAPI(engine, auth, () => [], { browserDiscovery: scanner }), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const create = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'fixture', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'browser' }) }); assert.equal(create.status, 201); const { id } = await create.json() as { id: string }; taskId = id;
  const post = (path: string, body: unknown, authenticated = true) => api.request('/api/task-browser/' + path, { method: 'POST', headers: authenticated ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('servers', { taskId: id }, false)).status, 401);
  assert.equal((await post('servers', { taskId: 'missing' })).status, 400); assert.equal(scans, 0);
  const resolved = await post('resolve', { taskId: id, address: 'localhost:3000/app' }); assert.equal(resolved.status, 200); assert.deepEqual(await resolved.json(), { url: 'http://localhost:3000/app' });
  assert.equal((await post('resolve', { taskId: id, address: 'javascript:alert(1)' })).status, 400);
  const result = await post('servers', { taskId: id, configuredURLs: ['http://localhost:3000'] }); assert.equal(result.status, 200); assert.deepEqual((await result.json() as { servers: unknown[] }).servers, [{ host: 'localhost', port: 3000, url: 'http://localhost:3000/', processName: 'fixture', pid: 42 }]);
});
