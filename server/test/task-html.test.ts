import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { TaskHtmlAssets } from '../src/task-html-api.js';
import { maxHtmlBytes, htmlContentSecurityPolicy } from '../src/task-html.js';
import type { WorkItem } from '../src/types.js';

const source = '<html><body><button onclick="this.textContent=\'Clicked\'">Click</button><script>window.pageLoaded=true</script></body></html>';
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const dir = await mkdtemp(join(tmpdir(), 'friday-html-')), cwd = join(dir, 'workspace'), data = join(dir, 'data');
  await mkdir(cwd);
  const executor = { async run() { throw new Error('No model should run'); }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0, changeRequestWatchIntervalMs: 0 }).open();
  const auth = new Auth(data), at = new Date().toISOString();
  const task: WorkItem = { id: 'html-task', title: 'HTML', prompt: 'Show a page', agent: 'codex', mode: 'code', status: 'running', projectId: 'project', cwd,
    createdAt: at, updatedAt: at, durableId: null, threadId: 'native-thread', turnId: 'native-turn', currentRunId: 'run', lastRequestId: 'initial', result: '', error: null, events: [], approvals: [], artifact: null,
    messages: [{ id: 'user', role: 'user', text: 'Show a page', at, runId: 'run' }], runs: [{ id: 'run', durableId: 0, requestId: 'initial', cwd, mode: 'code', messageId: 'user', at, status: 'running', turnId: 'native-turn' }] };
  await engine.mutate(state => { state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }); state.tasks.push(task); });
  const actor = { runId: 'run', cwd, projectId: 'project' };
  t.after(async () => { auth.close(); await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, cwd, data, auth, actor, task, get engine() { return engine; },
    publish: (input: Record<string, unknown> = { html: source, title: 'Interactive page' }) => engine.html.publish(task.id, actor, input, new AbortController().signal),
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0, changeRequestWatchIntervalMs: 0 }).open(); },
  };
}

test('Real MCP publishes one durable inline item, returns only metadata, and rejects stale or revoked callers', async t => {
  const f = await fixture(t), grant = await f.engine.runtimeTools.bind(f.task, 'run', new AbortController().signal);
  let next = 0;
  const rpc = async (method: string, params: unknown = {}, id = ++next, authenticated = true) => {
    const response = await fetch(grant.connection.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? grant.connection.headers : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
    return { status: response.status, value: response.status === 200 ? await response.json() : null };
  };
  assert.equal((await rpc('tools/list', {}, 100, false)).status, 401);
  const list = await rpc('tools/list'); assert(list.value.result.tools.some((tool: { name: string }) => tool.name === 'html_render'));
  const params = { name: 'html_render', arguments: { html: source, title: 'Interactive page' } };
  const first = await rpc('tools/call', params, 101); assert.equal(first.value.result.isError, false);
  const published = JSON.parse(first.value.result.content[0].text); assert.equal(published.htmlRender.title, 'Interactive page');
  assert(!JSON.stringify(first).includes('<html>'));
  await rpc('tools/call', params, 101); await rpc('tools/call', params, 102);
  const task = (await f.engine.snapshot()).tasks[0]; assert.equal(task.events.length, 1); assert.equal(task.events[0].html?.id, published.htmlRender.id);
  assert.equal(task.events[0].runId, 'run'); assert.equal(task.events[0].turnId, 'native-turn');
  assert(!JSON.stringify(task).includes(source)); assert(!JSON.stringify(task).includes(grant.connection.headers.Authorization));
  assert.equal((await rpc('tools/call', { ...params, arguments: { ...params.arguments, threadId: 'other' } })).value.result.isError, true);
  await f.engine.mutate(state => { state.tasks[0].lastStoppedRunId = 'run'; });
  assert.equal((await rpc('tools/call', params)).value.result.isError, true);
  grant.release(); assert.equal((await rpc('tools/list')).status, 401);
});

test('HTML and embedded local images survive history eviction, restart and workspace removal; retries do not duplicate', async t => {
  const f = await fixture(t), image = Buffer.from('image-fixture'); await writeFile(join(f.cwd, 'mascot.webp'), image);
  const input = { html: '<img src="friday-image:mascot"><script>window.ok=true</script>', title: 'Mascot', height: 360, images: [{ name: 'mascot', path: 'mascot.webp' }] };
  const result = await f.publish(input), eventID = 'html-' + result.htmlRender.id;
  await f.engine.patchTask(f.task.id, task => { for (let i = 0; i < 650; i++) task.events.push({ id: 'log-' + i, kind: 'tool', text: 'Work', at: new Date().toISOString(), runId: 'run' }); });
  assert(!(await f.engine.snapshot()).tasks[0].events.some(event => event.id === eventID));
  await f.publish(input); assert.equal((await f.engine.taskHistory.events((await f.engine.snapshot()).tasks[0])).filter(event => event.kind === 'html').length, 1);
  const page = await f.engine.conversationHistory.project((await f.engine.snapshot()).tasks[0], 1, true);
  assert(page.events.some(event => event.id === eventID && event.html?.id === result.htmlRender.id));
  await f.engine.mutate(state => { state.tasks[0].status = 'completed'; state.tasks[0].runs![0].status = 'completed'; });
  await f.reopen(); await rm(f.cwd, { recursive: true });
  const saved = await f.engine.html.read(f.task.id, eventID);
  assert(saved.html.includes('data:image/webp;base64,' + image.toString('base64'))); assert.equal(saved.reference.height, 360);
  await f.engine.mutate(state => { const other = { ...state.tasks[0], id: 'unrelated', events: [] }; delete other.eventArchive; state.tasks.push(other); });
  await assert.rejects(f.engine.html.read('unrelated', eventID), /不在当前会话/);
});

test('Scoped HTML asset API authenticates minting, serves executable pages without credentials, and revokes on rewind', async t => {
  const f = await fixture(t), result = await f.publish(), eventId = 'html-' + result.htmlRender.id;
  const api = createAPI(f.engine, f.auth), input = { taskId: f.task.id, eventId };
  const post = (authorized: boolean) => api.request('/api/task-html/asset-url', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: 'Bearer ' + f.auth.token } : {}) }, body: JSON.stringify(input) });
  assert.equal((await post(false)).status, 401);
  const issued = await post(true); assert.equal(issued.status, 200); const asset = await issued.json(); assert(!asset.url.includes(f.auth.token));
  const response = await api.request(asset.url, { headers: { Origin: 'null' } }); assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), htmlContentSecurityPolicy);
  assert.equal(response.headers.get('access-control-allow-origin'), '*'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text(); assert(html.includes(source)); assert(html.includes('friday-html-height')); assert(!html.includes(f.auth.token));
  assert(!htmlContentSecurityPolicy.includes('allow-same-origin')); assert(htmlContentSecurityPolicy.includes("connect-src 'none'"));
  assert.equal((await api.request(asset.url, { method: 'HEAD' })).status, 200);
  assert.equal((await api.request(asset.url, { method: 'OPTIONS', headers: { Origin: 'null' } })).status, 204);
  assert.equal((await api.request('/api/state', { headers: { Origin: 'null' } })).status, 403);
  await f.engine.mutate(state => { state.tasks[0].runs![0].revertedAt = new Date().toISOString(); });
  assert.equal((await api.request(asset.url)).status, 403); assert.equal((await post(true)).status, 400);
});

test('HTML capabilities reject tampering, expiry and revoked devices', async t => {
  const f = await fixture(t), result = await f.publish(), assets = new TaskHtmlAssets(f.engine, f.auth);
  const device = f.auth.pair(f.auth.createPairing().code, 'Test client', 'local');
  const asset = await assets.issue(device.id, { taskId: f.task.id, eventId: 'html-' + result.htmlRender.id }, 1000), token = asset.url.split('/')[3];
  assert.equal((await assets.resource(token, 'GET', 1001)).status, 200);
  await assert.rejects(assets.resource(token + 'a', 'GET', 1001), /无效/);
  await assert.rejects(assets.resource(token, 'GET', 3_601_000), /过期/);
  f.auth.revoke(device.id); await assert.rejects(assets.resource(token, 'GET', 1001), /无效/);
});

test('Concurrent publication deduplicates while revisions stay distinct; inherited references survive source deletion', async t => {
  const f = await fixture(t);
  const [one, duplicate] = await Promise.all([f.publish(), f.publish()]);
  assert.equal(one.htmlRender.id, duplicate.htmlRender.id);
  const revised = await f.publish({ html: source.replace('Click</button>', 'Revised</button>'), title: 'Interactive page' });
  assert.notEqual(revised.htmlRender.id, one.htmlRender.id);
  assert.equal((await f.engine.snapshot()).tasks[0].events.length, 2);
  const assets = new TaskHtmlAssets(f.engine, f.auth), eventId = 'html-' + one.htmlRender.id;
  const original = await assets.issue('owner', { taskId: f.task.id, eventId });
  await f.engine.mutate(state => {
    const inherited = JSON.parse(JSON.stringify(state.tasks[0])) as WorkItem;
    inherited.id = 'fork'; inherited.status = 'completed';
    state.tasks = [inherited];
  });
  await assert.rejects(assets.resource(original.url.split('/')[3], 'GET'));
  assert.equal((await f.engine.html.read('fork', eventId)).html, source);
  const inherited = await assets.issue('owner', { taskId: 'fork', eventId });
  assert.equal((await assets.resource(inherited.url.split('/')[3], 'GET')).status, 200);
});

test('HTML validation bounds source and image expansion and prevents private-file reads without publishing a partial item', async t => {
  const f = await fixture(t);
  for (const input of [{ html: '', title: 'Empty' }, { html: 'x'.repeat(maxHtmlBytes + 1), title: 'Huge' }, { html: source, title: 'Page', height: 0 }, { html: source, title: 'Page', height: 1.5 }, { html: source, title: '\nBad' }, { html: '<img src="friday-image:missing">', title: 'Missing' }, { html: source, title: 'Page', images: [null] }, { html: source, title: 'Page', path: '/tmp' }]) await assert.rejects(f.publish(input));
  await writeFile(join(f.cwd, 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(f.publish({ html: 'friday-image:big', title: 'Huge image', images: [{ name: 'big', path: 'big.png' }] }), /2 MB/);
  await writeFile(join(f.cwd, 'small.png'), Buffer.alloc(512 * 1024));
  await assert.rejects(f.publish({ html: '<img src="friday-image:big">'.repeat(30), title: 'Expansion', images: [{ name: 'big', path: 'small.png' }] }), /8 MB/);
  await writeFile(join(f.data, 'private.png'), 'private'); await symlink(join(f.data, 'private.png'), join(f.cwd, 'alias.png'));
  await assert.rejects(f.publish({ html: 'friday-image:private', title: 'Private', images: [{ name: 'private', path: 'alias.png' }] }), /私有/);
  await assert.rejects(f.engine.html.publish(f.task.id, { ...f.actor, runId: 'old' }, { html: source, title: 'Stale' }, new AbortController().signal), /轮次已结束/);
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(f.engine.html.publish(f.task.id, f.actor, { html: source, title: 'Aborted' }, aborted.signal));
  assert.equal((await f.engine.snapshot()).tasks[0].events.length, 0);
});
