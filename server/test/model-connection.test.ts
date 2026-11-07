import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { ModelConnection } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

const draft = { name: 'My gateway', baseUrl: 'https://gateway.example/v1', apiKey: 'private-test-key', model: 'vendor/chat-b' };
const catalog = { data: [{ id: 'vendor/chat-b', name: 'Chat B', context_length: 65536 }, { id: 'vendor/chat-a' }, { id: 'vendor/chat-b', name: 'Chat B', context_length: 65536 }, { id: 'bad id' }] };
const completion = () => new Response([
  { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
  { id: 'test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
const directory = () => mkdtemp(join(tmpdir(), 'friday-api-models-'));

test('model discovery paginates, deduplicates and preserves gateway paths without saving credentials', async () => {
  const root = await directory(); const urls: URL[] = [];
  const connection = new ModelConnection(root, async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-key');
    assert.equal(init?.redirect, 'error');
    return Response.json(url.search ? { data: [{ id: 'vendor/chat-c' }, { id: 'vendor/chat-a' }] } : { ...catalog, has_more: true, last_id: 'vendor/chat-b' });
  });
  try {
    const result = await connection.discover({ ...draft, baseUrl: draft.baseUrl + '///' });
    assert.equal(result.baseUrl, draft.baseUrl);
    assert.deepEqual(result.models.map(m => m.id), ['vendor/chat-a', 'vendor/chat-b', 'vendor/chat-c']);
    assert.equal(result.models[1].contextWindow, 65536);
    assert.equal(urls[0].pathname, '/v1/models'); assert.equal(urls[1].searchParams.get('after'), 'vendor/chat-b');
    assert.equal((await connection.status()).connected, false);
    await assert.rejects(readFile(join(root, 'model-provider.json')), { code: 'ENOENT' });
    assert.ok(!JSON.stringify(result).includes(draft.apiKey));
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('selected API models drive real completion requests and survive restart, key reuse and removal', async () => {
  const root = await directory(); const calls: Record<string, any>[] = [];
  const request: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-key');
    if (String(input).endsWith('/models')) return Response.json(catalog);
    assert.equal(String(input), draft.baseUrl + '/chat/completions');
    calls.push(JSON.parse(String(init?.body)));
    return completion();
  };
  let connection = new ModelConnection(root, request);
  try {
    const saved = await connection.save(draft);
    assert.equal(saved.provider, draft.name); assert.equal(saved.model, draft.model); assert.equal(saved.connected, true);
    assert.equal(calls[0].model, draft.model);
    assert.ok(!JSON.stringify(saved).includes(draft.apiKey));
    assert.equal((await stat(join(root, 'model-provider.json'))).mode & 0o777, 0o600);
    await connection.close(); connection = new ModelConnection(root, request);
    await connection.open(); await connection.ready();
    const result = await connection.models.completeSimple(connection.models.getModel(connection.model.provider, connection.model.modelId)!, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] }, { fetch: request });
    assert.equal(result.stopReason, 'stop'); assert.equal(calls.at(-1)?.model, draft.model);
    const publicState = await connection.status();
    assert.ok(!('baseUrl' in publicState)); assert.ok(!('models' in publicState));
    assert.equal((await connection.status(true)).baseUrl, draft.baseUrl);
    const next = await connection.save({ ...draft, model: 'vendor/chat-a', apiKey: '' });
    assert.equal(next.model, 'vendor/chat-a');
    await connection.clearKey();
    assert.equal((await connection.status()).connected, false);
    await assert.rejects(connection.ready(), /配置/);
    await connection.close(); connection = new ModelConnection(root, request);
    assert.equal((await connection.status()).connected, false);
    assert.equal((await connection.status()).model, 'vendor/chat-a');
    assert.ok(!(await readFile(join(root, 'model-provider.json'), 'utf8')).includes(draft.apiKey));
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('failed discovery and model probes preserve the saved connection and redact upstream errors', async () => {
  const root = await directory(); let fail = '';
  const connection = new ModelConnection(root, async (input) => {
    if (fail === 'list') return new Response('echo private-test-key', { status: 401 });
    if (String(input).endsWith('/models')) return Response.json(catalog);
    return fail === 'probe' ? new Response('echo private-test-key', { status: 400 }) : completion();
  });
  try {
    await connection.save(draft);
    const before = await readFile(join(root, 'model-provider.json'), 'utf8');
    for (const failure of ['list', 'probe']) {
      fail = failure;
      await assert.rejects(connection.save({ ...draft, model: 'vendor/chat-a' }), error => !String(error).includes(draft.apiKey));
      assert.equal((await connection.status()).model, draft.model);
      assert.equal(await readFile(join(root, 'model-provider.json'), 'utf8'), before);
    }
    fail = '';
    await assert.rejects(connection.save({ ...draft, model: 'missing' }), /不可用/);
    assert.equal(await readFile(join(root, 'model-provider.json'), 'utf8'), before);
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('legacy DeepSeek keys remain usable and are never borrowed by a different API URL', async () => {
  const root = await directory(); let calls = 0;
  const connection = new ModelConnection(root, async () => { calls++; return Response.json(catalog); });
  try {
    await connection.credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'legacy-key' }));
    await connection.ready(); assert.equal((await connection.status()).provider, 'DeepSeek API');
    await assert.rejects(connection.discover({ ...draft, apiKey: '' }), /API Key/);
    assert.equal(calls, 0);
    const result = await connection.discover({ name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/', apiKey: '' });
    assert.equal(result.models.length, 2);
    await connection.clearKey(); assert.equal((await connection.status()).connected, false);
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('a reasoning model exhausting the short probe budget is still a valid connection', async () => {
  const root = await directory();
  const connection = new ModelConnection(root, async input => String(input).endsWith('/models') ? Response.json(catalog) : new Response(
    'data: {"id":"thinking","choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"Thinking"},"finish_reason":null}]}\n\n' +
    'data: {"id":"thinking","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  ));
  try { assert.equal((await connection.save(draft)).connected, true); }
  finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('model configuration rejects malformed URLs, keys, empty catalogs and incomplete pagination', async () => {
  const root = await directory(); let body: unknown = { data: [] }; let calls = 0;
  const connection = new ModelConnection(root, async () => { calls++; return Response.json(body); });
  try {
    for (const baseUrl of ['file:///tmp/key', 'https://user:pass@example.com/v1', 'https://api.example/v1?api_key=secret', 'https://api.example/v1#fragment']) await assert.rejects(connection.discover({ ...draft, baseUrl }), /URL/);
    await assert.rejects(connection.discover({ ...draft, apiKey: 'bad\nkey' }), /API Key/);
    assert.equal(calls, 0);
    await assert.rejects(connection.discover(draft), /没有返回可用模型/);
    body = { error: 'private-test-key' };
    await assert.rejects(connection.discover(draft), /兼容的模型列表/);
    body = { data: [{ id: 'same' }], has_more: true, last_id: 'same' };
    await assert.rejects(connection.discover(draft), /分页未完成/);
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('closing aborts discovery and prevents simultaneous model changes', async () => {
  const root = await directory(); let started!: () => void;
  const begun = new Promise<void>(resolve => { started = resolve; });
  const connection = new ModelConnection(root, async (_input, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  try {
    const pending = connection.discover(draft);
    await begun;
    await assert.rejects(connection.save(draft), /请稍候/);
    await assert.rejects(connection.clearKey(), /请稍候/);
    const rejected = assert.rejects(pending, /无法连接/);
    await connection.close(); await rejected;
    assert.equal((await connection.status()).connected, false);
  } finally { await connection.close(); await rm(root, { recursive: true, force: true }); }
});

test('model API is owner-only, blocks active Friday work and uses the configured model in main chat', async () => {
  const root = await directory(); const completions: any[] = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-test-key');
    if (request.url === '/v1/models') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(catalog)); return; }
    assert.equal(request.url, '/v1/chat/completions');
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    completions.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.setHeader('Content-Type', 'text/event-stream'); response.end(await completion().text());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  const engine = await new Engine(root).open(); const auth = new Auth(root);
  try {
    const app = createAPI(engine, auth, () => []);
    const paired = auth.pair(auth.createPairing().code, 'phone', 'test');
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const remote = { ...headers, Authorization: `Bearer ${paired.token}` };
    for (const [path, method] of [['models', 'POST'], ['settings', 'PUT']] as const) {
      assert.equal((await app.request('/api/model/' + path, { method, headers: remote, body: '{}' })).status, 403);
    }
    const saved = await app.request('/api/model/settings', { method: 'PUT', headers, body: JSON.stringify({ ...draft, baseUrl }) });
    assert.equal(saved.status, 200, await saved.clone().text());
    const id = await engine.createTask({ prompt: 'Hello', mode: 'auto', projectId: null, requestId: 'custom-api' });
    for (let count = 0; count < 300; count++) {
      const task = (await engine.snapshot()).tasks.find(task => task.id === id)!;
      if (['completed', 'failed'].includes(task.status)) { assert.equal(task.status, 'completed', task.error ?? ''); break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const task = (await engine.snapshot()).tasks.find(task => task.id === id)!;
    assert.equal(task.status, 'completed'); assert.match(task.result, /OK/);
    assert.ok(completions.length >= 2); assert.ok(completions.every(body => body.model === draft.model));
    await engine.mutate(state => { state.tasks.find(task => task.id === id)!.status = 'running'; });
    assert.equal((await app.request('/api/model/settings', { method: 'PUT', headers, body: '{}' })).status, 409);
    assert.equal((await app.request('/api/model/models', { method: 'POST', headers, body: '{}' })).status, 409);
    await engine.mutate(state => { state.tasks.find(task => task.id === id)!.status = 'completed'; });
    const publicState = await (await app.request('/api/model', { headers: remote })).json();
    assert.equal(publicState.model, draft.model); assert.equal(publicState.baseUrl, undefined);
    assert.ok(!JSON.stringify(publicState).includes(draft.apiKey));
  } finally { await engine.close(); auth.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
