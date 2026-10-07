import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexEvents } from '../src/codex-events.js';
import type { ExecutionUpdate, TaskEvent } from '../src/types.js';

function transcript() {
  const updates: ExecutionUpdate[] = []; const items = new Map<string, TaskEvent>();
  const events = new CodexEvents(async update => { updates.push(update); if (update.kind === 'item') items.set(update.item.id, update.item); });
  const handle = (method: string, item: object) => events.handle(method, { item }, 'turn-1');
  return { events, updates, items, handle };
}

test('Codex preserves commentary and final reply separately, with stable streaming items', async () => {
  const { events, updates, items, handle } = transcript();
  await events.startTurn('turn-1');
  await handle('item/started', { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '' });
  await events.handle('item/agentMessage/delta', { itemId: 'progress', delta: 'I am inspecting the project.' }, 'turn-1');
  await handle('item/completed', { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Inspection complete.' });
  assert.ok(!updates.some(u => u.kind === 'output'), 'commentary must never become the task result');
  await handle('item/started', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '' });
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: 'Partial' }, 'turn-1');
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: ' reply' }, 'turn-1');
  await handle('item/completed', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Authoritative answer' });
  await events.finishTurn('turn-1', 'completed');
  assert.equal(events.result, 'Authoritative answer');
  assert.equal(items.size, 3, 'deltas replace the item snapshot');
  assert.equal(items.get('codex:turn-1:progress')?.text, 'Inspection complete.');
  assert.equal(items.get('codex:turn-1:answer')?.text, 'Authoritative answer');
  assert.equal(items.get('codex:turn-1:turn')?.status, 'completed');
});

test('Commands retain one identity, complete output, failure state, and turn scope', async () => {
  const { events, items, handle } = transcript();
  await handle('item/started', { id: 'command', type: 'commandExecution', command: 'pnpm test' });
  const startedAt = items.get('codex:turn-1:command')?.at;
  await events.handle('item/commandExecution/outputDelta', { itemId: 'command', delta: 'streamed output' }, 'turn-1');
  await handle('item/completed', { id: 'command', type: 'commandExecution', command: 'pnpm test', aggregatedOutput: 'Complete output', exitCode: 1, durationMs: 350 });
  assert.equal(items.size, 1);
  assert.equal(items.get('codex:turn-1:command')?.at, startedAt);
  assert.equal(items.get('codex:turn-1:command')?.status, 'failed');
  assert.equal(items.get('codex:turn-1:command')?.detail, 'Complete output');
  await events.handle('item/started', { turnId: 'turn-2', item: { id: 'command', type: 'commandExecution', command: 'pwd' } }, 'turn-2');
  await events.finishTurn('turn-2', 'interrupted');
  assert.equal(items.size, 2, 'item IDs can recur across turns');
  assert.equal(items.get('codex:turn-2:command')?.status, 'interrupted');
  assert.equal(items.get('codex:turn-1:command')?.status, 'failed');
});

test('Phase-less peers use the last reply; raw reasoning and image payloads are not stored', async () => {
  const { events, items, handle } = transcript();
  await handle('item/completed', { id: 'old-progress', type: 'agentMessage', text: 'Progress' });
  await handle('item/completed', { id: 'old-answer', type: 'agentMessage', text: 'Answer' });
  assert.equal(events.result, 'Answer');
  await handle('item/completed', { id: 'reasoning', type: 'reasoning', summary: ['Public summary'], content: ['private reasoning'] });
  await handle('item/completed', { id: 'tool', type: 'mcpToolCall', server: 'browser', tool: 'inspect', result: { content: [{ type: 'text', text: 'Page title' }, { type: 'image', data: 'secret-base64' }] } });
  await handle('item/completed', { id: 'search', type: 'webSearch', action: { type: 'search', query: 'Friday' } });
  assert.equal(items.get('codex:turn-1:reasoning')?.text, 'Public summary');
  assert.equal(items.get('codex:turn-1:tool')?.detail, 'Page title');
  assert.equal(items.get('codex:turn-1:search')?.text, 'Friday');
  assert.ok(!JSON.stringify([...items.values()]).includes('private reasoning'));
  assert.ok(!JSON.stringify([...items.values()]).includes('secret-base64'));
});
