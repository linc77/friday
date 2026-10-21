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

test('Codex keeps structured file patches, full stats and rename endpoints without truncating file identity', async () => {
  const { items, handle } = transcript();
  const patch = '--- a/source.ts\n+++ b/destination.ts\n@@ -1,2 +1,3 @@\n---source-header\n+++added-header\n+new line\n context\n';
  await handle('item/completed', { id: 'patch', type: 'fileChange', status: 'completed', changes: [
    { path: '/workspace/source.ts', kind: { type: 'update', move_path: '/workspace/destination.ts' }, diff: patch },
    { path: 'large.txt', kind: { type: 'add' }, diff: '@@ -0,0 +1,100000 @@\n' + '+line\n'.repeat(100_000) },
  ] });
  const item = items.get('codex:turn-1:patch')!;
  assert.equal(item.changes?.[0]?.path, '/workspace/destination.ts'); assert.equal(item.changes?.[0]?.oldPath, '/workspace/source.ts');
  assert.equal(item.changes?.[0]?.diff, patch); assert.equal(item.changes?.[0]?.additions, 2); assert.equal(item.changes?.[0]?.deletions, 1);
  assert.equal(item.changes?.[1]?.additions, 100_000); assert.equal(item.changes?.[1]?.truncated, true);
  assert.equal(item.changes?.[1]?.diff.length, 256_000); assert.match(item.text, /destination\.ts\nlarge\.txt/);
});

test('Execution plan steps remain distinct from a streamed proposed plan and a plan-only turn has a meaningful result', async () => {
  const { events, items, handle } = transcript();
  await events.handle('turn/plan/updated', { explanation: 'Inspect before changing', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Implement', status: 'inProgress' }, { step: 'Check', status: 'pending' }] }, 'turn-1');
  await handle('item/started', { id: 'proposal', type: 'plan', text: '' });
  await events.handle('item/plan/delta', { itemId: 'proposal', delta: '# Proposed change\n\nKeep the state durable.' }, 'turn-1');
  await handle('item/completed', { id: 'proposal', type: 'plan', text: '# Proposed change\n\nKeep the state durable.' });
  await events.finishTurn('turn-1', 'completed');
  assert.equal(items.get('codex:turn-1:plan')?.kind, 'plan'); assert.equal(items.get('codex:turn-1:plan')?.plan?.[1]?.status, 'inProgress');
  assert.equal(items.get('codex:turn-1:proposal')?.kind, 'proposal'); assert.match(events.result, /^# Proposed change/);
});

test('Parsed command actions preserve read/search/list identities and discard unrelated wire fields', async () => {
  const { items, handle } = transcript();
  await handle('item/completed', { id: 'read', type: 'commandExecution', command: 'rg TODO src', exitCode: 0,
    commandActions: [{ type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src', unrelated: 'discard' }, { type: 'read', command: 'cat file', path: 'file', name: 'file' }] });
  assert.deepEqual(items.get('codex:turn-1:read')?.commandActions, [
    { type: 'search', command: 'rg TODO src', query: 'TODO', path: 'src' }, { type: 'read', command: 'cat file', path: 'file', name: 'file' },
  ]);
});

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

test('The first text appears immediately and a paused token burst flushes without another event', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const items: TaskEvent[] = [];
  let flushed!: () => void;
  const trailing = new Promise<void>(resolve => { flushed = resolve; });
  const events = new CodexEvents(async update => {
    if (update.kind !== 'item') return;
    items.push(update.item);
    if (update.item.text === 'Inspecting the project') flushed();
  });
  await events.handle('item/started', { item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '' } }, 'turn-1');
  await events.handle('item/agentMessage/delta', { itemId: 'progress', delta: 'Inspecting' }, 'turn-1');
  assert.equal(items.at(-1)?.text, 'Inspecting', 'the empty start must not throttle the first text');
  await events.handle('item/agentMessage/delta', { itemId: 'progress', delta: ' the project' }, 'turn-1');
  assert.equal(items.at(-1)?.text, 'Inspecting');
  t.mock.timers.tick(150);
  await trailing;
  assert.equal(items.at(-1)?.text, 'Inspecting the project');
  assert.equal(items.at(-1)?.status, 'running', 'publish before item/completed or turn/completed');
  await events.finishTurn('turn-1', 'completed');
});

test('Completion and interruption drain pending text without publishing stale running snapshots', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const { events, updates, items, handle } = transcript();
  await handle('item/started', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '' });
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: 'First' }, 'turn-1');
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: ' buffered' }, 'turn-1');
  await handle('item/completed', { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Authoritative answer' });
  await events.handle('item/commandExecution/outputDelta', { itemId: 'cmd', delta: 'First output' }, 'turn-1');
  await events.handle('item/commandExecution/outputDelta', { itemId: 'cmd', delta: ' buffered output' }, 'turn-1');
  await events.finishTurn('turn-1', 'interrupted');
  const count = updates.length;
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(updates.length, count, 'terminal items must cancel their pending timers');
  assert.equal(items.get('codex:turn-1:answer')?.text, 'Authoritative answer');
  assert.equal(items.get('codex:turn-1:answer')?.status, 'completed');
  assert.equal(items.get('codex:turn-1:cmd')?.detail, 'First output buffered output');
  assert.equal(items.get('codex:turn-1:cmd')?.status, 'interrupted');
});

test('Public summary parts keep their boundaries and survive an empty completion snapshot', async () => {
  const { events, updates, items, handle } = transcript();
  await handle('item/started', { id: 'reasoning', type: 'reasoning', summary: [] });
  await events.handle('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 1, delta: 'Next step' }, 'turn-1');
  await events.handle('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: 'Checking' }, 'turn-1');
  await events.handle('item/reasoning/summaryTextDelta', { itemId: 'reasoning', summaryIndex: 0, delta: ' the project' }, 'turn-1');
  assert.equal(await events.handle('item/reasoning/textDelta', { itemId: 'reasoning', delta: 'private reasoning' }, 'turn-1'), false);
  await handle('item/completed', { id: 'reasoning', type: 'reasoning', summary: [], content: ['private reasoning'] });
  await events.finishTurn('turn-1', 'completed');
  assert.equal(items.get('codex:turn-1:reasoning')?.text, 'Checking the project\n\nNext step');
  assert.equal(items.get('codex:turn-1:reasoning')?.status, 'completed');
  assert.ok(!updates.some(update => update.kind === 'output'), 'summaries are never the final result');
  assert.ok(!JSON.stringify(updates).includes('private reasoning'));
});

test('A failed timer flush reports the error and cannot leave background writes running', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const error = new Error('storage unavailable');
  let report!: (error: Error) => void;
  const failed = new Promise<Error>(resolve => { report = resolve; });
  const events = new CodexEvents(async update => {
    if (update.kind === 'item' && update.item.text === 'First buffered') throw error;
  }, report);
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: 'First' }, 'turn-1');
  await events.handle('item/agentMessage/delta', { itemId: 'answer', delta: ' buffered' }, 'turn-1');
  t.mock.timers.tick(150);
  assert.equal(await failed, error);
  await assert.rejects(events.finishTurn('turn-1', 'failed'), /storage unavailable/);
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
