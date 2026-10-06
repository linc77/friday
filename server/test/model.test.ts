import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { createModels, fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { ModelConnection } from '../src/model.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Workspace } from '../src/types.js';

function response(delta: unknown, finish = 'stop') {
  return `data: ${JSON.stringify({ id: 'test-completion', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;
}
function mock() {
  const original = getGlobalDispatcher(); const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://api.deepseek.com');
  const chat = () => pool.intercept({ path: '/chat/completions', method: 'POST' });
  return { agent, chat, async close() { setGlobalDispatcher(original); await agent.close(); } };
}
const streamHeaders = { headers: { 'content-type': 'text/event-stream' } };
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  for (let i = 0; i < 500; i++) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Task did not settle');
}

test('DeepSeek validates a real protocol response before saving; failed replacement preserves the private key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-deepseek-key-')); const wire = mock();
  let connection = new ModelConnection(directory);
  try {
    assert.equal((await connection.status()).connected, false);
    await connection.credentials.modify('openai', async () => ({ type: 'oauth', access: 'old', refresh: 'old', expires: 1 }));
    assert.equal((await connection.status()).connected, false);
    await assert.rejects(connection.ready(), /DeepSeek API Key/);
    await assert.rejects(connection.saveKey(' '), /有效/);
    await assert.rejects(connection.saveKey('sk-one\nsk-two'), /有效/);
    wire.chat().reply(401, { error: { message: 'private echoed key sk-bad' } });
    await assert.rejects(connection.saveKey('sk-bad'), error => /无效或没有访问权限/.test(String(error)) && !String(error).includes('sk-bad'));
    assert.equal(await connection.credentials.read('deepseek'), undefined);
    wire.chat().reply(200, options => {
      const body = JSON.parse(String(options.body));
      assert.equal(body.model, 'deepseek-flash'); assert.equal(body.max_tokens, 16);
      assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.stream, true);
      assert.equal(new Headers(options.headers as Record<string, string>).get('authorization'), 'Bearer sk-good');
      return response({ role: 'assistant', content: 'OK' });
    }, streamHeaders).delay(30);
    const pending = connection.saveKey(' sk-good ');
    assert.equal((await connection.status()).connected, false);
    await assert.rejects(connection.clearKey(), /正在验证/);
    await assert.rejects(connection.saveKey('sk-another'), /正在验证/);
    await pending;
    await connection.ready();
    assert.equal((await stat(join(directory, 'model-auth.json'))).mode & 0o777, 0o600);
    assert.equal((await connection.credentials.read('deepseek') as any).key, 'sk-good');
    assert.ok(await connection.credentials.read('openai'), 'Switching providers must preserve old credentials');
    await connection.close(); connection = new ModelConnection(directory);
    for (const [status, message] of [[402, /余额不足/], [429, /过于频繁/], [503, /暂时不可用/]] as const) {
      wire.chat().reply(status, { error: { message: 'private echoed key' } });
      await assert.rejects(connection.saveKey('sk-replacement'), message);
      assert.equal((await connection.credentials.read('deepseek') as any).key, 'sk-good');
    }
    wire.chat().replyWithError(new Error('private network detail'));
    await assert.rejects(connection.saveKey('sk-network'), /网络或代理/);
    assert.deepEqual(await connection.status(true), { provider: 'DeepSeek API', model: 'deepseek-flash', connected: true });
    assert.deepEqual(await connection.status(false), await connection.status(true));
    await connection.clearKey(); assert.equal((await connection.status()).connected, false);
    assert.ok(await connection.credentials.read('openai'));
    wire.agent.assertNoPendingInterceptors();
  } finally { await connection.close(); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});

test('DeepSeek API is owner-only and continuing an old model conversation keeps history and completes a tool round trip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-deepseek-loop-')); const wire = mock();
  const faux = fauxProvider({ tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('这是切换前的回复。')]);
  let engine = await new Engine(directory, undefined, { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }).open();
  const auth = new Auth(directory);
  const input = { prompt: '你好', projectId: null, mode: 'auto' as const, requestId: 'old-provider' };
  try {
    const id = await engine.createTask(input);
    const previous = await until(engine, state => state.tasks[0].status === 'completed');
    const conversationId = previous.tasks[0].conversationId;
    await engine.close(); engine = await new Engine(directory).open();
    let codexCalls = 0; engine.executor.run = async () => { codexCalls++; throw new Error('Unexpected Codex'); };
    const app = createAPI(engine, auth, () => []);
    const paired = auth.pair(auth.createPairing().code, 'phone', 'test');
    const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const remoteHeaders = { ...headers, Authorization: `Bearer ${paired.token}` };
    assert.equal((await app.request('/api/model/key', { method: 'PUT', headers: remoteHeaders, body: '{"apiKey":"sk-remote"}' })).status, 403);
    assert.equal((await app.request('/api/model/key', { method: 'DELETE', headers: remoteHeaders })).status, 403);
    assert.equal((await app.request('/api/model/login', { method: 'POST', headers, body: '{}' })).status, 404);
    wire.chat().reply(200, response({ role: 'assistant', content: 'OK' }), streamHeaders);
    const saved = await app.request('/api/model/key', { method: 'PUT', headers, body: '{"apiKey":"sk-local"}' });
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes('sk-local'));
    wire.chat().reply(200, options => {
      const body = JSON.parse(String(options.body));
      assert.equal(body.model, 'deepseek-flash'); assert.equal(body.reasoning_effort, 'high');
      assert.ok(JSON.stringify(body.messages).includes('这是切换前的回复。'));
      assert.ok(body.tools.some((tool: any) => tool.function.name === 'remember'));
      assert.ok(body.tools.every((tool: any) => !tool.function.strict));
      return response({ role: 'assistant', reasoning_content: 'Need to remember the preference.', tool_calls: [{ index: 0, id: 'call-remember', type: 'function', function: { name: 'remember', arguments: '{"text":"喜欢中文回答"}' } }] }, 'tool_calls');
    }, streamHeaders).delay(40);
    wire.chat().reply(200, options => {
      const body = JSON.parse(String(options.body));
      assert.ok(body.messages.some((message: any) => message.role === 'tool' && message.tool_call_id === 'call-remember'));
      assert.ok(body.messages.some((message: any) => message.role === 'assistant' && message.reasoning_content === 'Need to remember the preference.'));
      return response({ role: 'assistant', content: '记住了，你喜欢中文回答。' });
    }, streamHeaders);
    await engine.createTask({ ...input, prompt: '请记住我喜欢中文回答', requestId: 'deepseek-turn', continueId: id });
    assert.equal((await app.request('/api/model/key', { method: 'DELETE', headers })).status, 409);
    assert.equal((await app.request('/api/model/key', { method: 'PUT', headers, body: '{"apiKey":"sk-new"}' })).status, 409);
    const state = await until(engine, state => ['completed', 'failed'].includes(state.tasks[0].status));
    assert.equal(state.tasks[0].status, 'completed', state.tasks[0].error ?? '');
    assert.equal(state.tasks[0].conversationId, conversationId);
    assert.equal(state.tasks[0].messages?.filter(message => message.role === 'user').length, 2);
    assert.equal(state.memories[0].text, '喜欢中文回答'); assert.equal(codexCalls, 0);
    assert.match(state.tasks[0].result, /记住了/);
    const remoteState = await (await app.request('/api/model', { headers: remoteHeaders })).json();
    assert.deepEqual(remoteState, { provider: 'DeepSeek API', model: 'deepseek-flash', connected: true });
    assert.equal((await app.request('/api/model/key', { method: 'DELETE', headers })).status, 200);
    wire.agent.assertNoPendingInterceptors();
  } finally { await engine.close(); auth.close(); await wire.close(); await rm(directory, { recursive: true, force: true }); }
});
