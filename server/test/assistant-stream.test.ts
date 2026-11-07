import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels, fauxProvider, fauxAssistantMessage, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { WorkItem } from '../src/types.js';

const noExecutor = { run: async () => { throw new Error('No external agent'); }, answer: async () => {}, steer: async () => {} };
async function until(engine: Engine, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const task = (await engine.snapshot()).tasks[0];
    if (task && predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Assistant did not reach the expected stream state');
}

test('Friday streams thinking and text over SSE, retains tools, and keeps message identity through completion and reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-assistant-stream-'));
  const faux = fauxProvider({ tokensPerSecond: 120, tokenSize: { min: 4, max: 4 } });
  const models = createModels(); models.setProvider(faux.provider);
  const options = { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } };
  const thinking = '先核对已有信息，再确认用户缺少的条件。'.repeat(10);
  const answer = '这是连续生成的回复，用于确认消息在完成之前就已经显示。'.repeat(10);
  faux.setResponses([
    fauxAssistantMessage([fauxThinking(thinking), fauxToolCall('ask_user', { question: '选择哪一天？' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(answer),
  ]);
  let engine = await new Engine(directory, noExecutor, options).open();
  const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => []);
  const response = await app.request('/api/overview/events', { headers: { Authorization: `Bearer ${auth.token}` } });
  const reader = response.body!.getReader();
  let wire = '';
  const reading = (async () => { while (true) { const chunk = await reader.read(); if (chunk.done) return; wire += new TextDecoder().decode(chunk.value); } })();
  try {
    const id = await engine.createTask({ prompt: '检查状态流', mode: 'assistant', projectId: null, requestId: 'stream' });
    const partialThinking = await until(engine, task => task.assistantActivity?.phase === 'thinking' && !!task.messages?.some(m => m.streaming && m.thinking && m.thinking.length < thinking.length));
    const thinkingID = partialThinking.messages!.find(m => m.streaming)!.id;
    const waiting = await until(engine, task => task.status === 'waiting' && !!task.messages?.some(m => m.tools?.some(t => t.name === 'ask_user')));
    assert.equal(waiting.messages?.find(m => m.id === thinkingID)?.thinking, thinking);
    assert.equal(waiting.result, '', 'Thinking and tool metadata must not become an answer');
    await engine.answer(id, waiting.approvals.find(a => a.state === 'pending')!.id, 'accept', { answer: ['周六'] });
    const partial = await until(engine, task => task.assistantActivity?.phase === 'responding' && !!task.messages?.some(m => m.streaming && m.text.length > 0 && m.text.length < answer.length));
    const answerID = partial.messages!.find(m => m.streaming)!.id;
    const done = await until(engine, task => task.status === 'completed');
    assert.equal(done.messages?.find(m => m.id === answerID)?.text, answer);
    assert.equal(done.messages?.find(m => m.id === thinkingID)?.tools?.[0].status, 'completed');
    assert.match(done.messages?.find(m => m.id === thinkingID)?.tools?.[0].output ?? '', /周六/);
    assert.equal(done.messages?.filter(m => m.text === answer).length, 1);
    assert.equal(done.messages?.some(m => m.streaming), false);
    assert.equal(done.assistantActivity, undefined);
    assert.match(wire, /"phase":"thinking"/);
    assert.match(wire, /"phase":"responding"/);
    assert.match(wire, /"streaming":true/);
    await reader.cancel(); await reading;
    await engine.close(); engine = await new Engine(directory, noExecutor, options).open();
    const restored = (await engine.snapshot()).tasks[0];
    assert.equal(restored.messages?.find(m => m.id === thinkingID)?.thinking, thinking);
    assert.equal(restored.messages?.find(m => m.id === answerID)?.text, answer);
    assert.equal(faux.state.callCount, 2, 'Reopening must not replay the loop');
  } finally { await reader.cancel().catch(() => {}); await reading; await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Cancellation preserves the partial reply and clears the active stream state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-assistant-cancel-'));
  const faux = fauxProvider({ tokensPerSecond: 80, tokenSize: { min: 4, max: 4 } });
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('尚未完成的流式回复。'.repeat(50))]);
  const engine = await new Engine(directory, noExecutor, { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } }).open();
  try {
    const id = await engine.createTask({ prompt: '取消流式输出', mode: 'assistant', projectId: null, requestId: 'cancel' });
    const partial = await until(engine, task => !!task.messages?.some(m => m.streaming && m.text));
    const text = partial.messages!.find(m => m.streaming)!.text;
    await engine.cancel(id);
    const stopped = await until(engine, task => task.status === 'cancelled');
    assert.ok(stopped.messages?.some(m => m.text.startsWith(text)));
    assert.equal(stopped.assistantActivity, undefined);
    assert.equal(stopped.messages?.some(m => m.streaming), false);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
