import test from 'node:test';
import assert from 'node:assert/strict';
import { readCodexHistory } from '../src/codex-history.js';
import type { WorkItem } from '../src/types.js';

const child = { threadId: 'child', createdAt: '2026-10-19T10:00:00.000Z' } as WorkItem;
const parentTurn = { id: 'inherited', status: 'completed', itemsView: 'summary' };
const turn = { id: 'own', status: 'completed', startedAt: 1792404000, completedAt: 1792404005, itemsView: 'summary' };
const items = [
  { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Owned prompt' }, { type: 'image', data: 'do-not-import-image' }] },
  { id: 'reason', type: 'reasoning', summary: ['Public summary'], content: ['DO NOT IMPORT RAW REASONING'] },
  { id: 'command', type: 'commandExecution', status: 'completed', command: 'pwd', aggregatedOutput: '/owned/project', exitCode: 0 },
  { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Owned answer' },
];
function peer(legacy = false) {
  const requests: { method: string; params: any }[] = [];
  const rpc = { async call(method: string, p: any): Promise<any> {
    requests.push({ method, params: p });
    if (method === 'thread/read') return { thread: { id: p.threadId, parentThreadId: p.threadId === 'child' ? 'parent' : null,
      historyMode: legacy ? 'legacy' : 'paginated', model: 'child-model', reasoningEffort: 'low',
      ...(p.includeTurns ? { turns: p.threadId === 'child' ? [parentTurn, { ...turn, items }] : [parentTurn] } : {}) } };
    if (method === 'thread/turns/list') return { data: p.threadId === 'parent' ? [parentTurn] : p.cursor ? [turn] : [parentTurn], nextCursor: p.threadId === 'child' && !p.cursor ? 'second' : null };
    if (method === 'thread/items/list') {
      assert.equal(p.threadId, 'child'); assert.equal(p.turnId, 'own'); const index = Number(p.cursor ?? 0);
      return { data: [{ turnId: 'own', item: items[index], startedAtMs: 1792404000000 + index * 100, completedAtMs: 1792404005000 }], nextCursor: index + 1 < items.length ? String(index + 1) : null };
    }
    assert.fail('History reader must remain read-only: ' + method);
  } };
  return { rpc, requests };
}

test('Codex paginated and legacy history exclude inherited parent turns and retain only public child output', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'legacy full history' : 'separate turn and item pages', async () => {
    const { rpc, requests } = peer(legacy); const value = await readCodexHistory(rpc, child, 'parent', new AbortController().signal);
    assert.deepEqual(value.turns.map(turn => turn.id), ['own']); assert.equal(value.turns[0].prompt, 'Owned prompt');
    assert.ok(value.turns[0].events.some(event => event.kind === 'turn' && event.nativeTurnId === 'own' && event.status === 'completed'));
    assert.ok(value.turns[0].events.some(event => event.text === 'Owned answer' && event.phase === 'final_answer'));
    assert.ok(value.turns[0].events.some(event => event.kind === 'command' && event.detail === '/owned/project'));
    assert.ok(value.turns[0].events.some(event => event.kind === 'reasoning' && event.text === 'Public summary'));
    assert.ok(!JSON.stringify(value).includes('DO NOT IMPORT')); assert.ok(!JSON.stringify(value).includes('do-not-import-image'));
    assert.ok(requests.every(request => ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(request.method)));
    if (!legacy) assert.ok(requests.filter(request => request.method === 'thread/read').every(request => !request.params.includeTurns));
    assert.equal(value.model, 'child-model'); assert.equal(value.effort, 'low');
  });
});

test('Stored native event timestamps and durations are stable across history reads', async () => {
  const first = await readCodexHistory(peer().rpc, child, 'parent', new AbortController().signal);
  await new Promise(resolve => setTimeout(resolve, 8));
  const second = await readCodexHistory(peer().rpc, child, 'parent', new AbortController().signal);
  assert.deepEqual(first, second);
});

test('Native history rejects foreign parents, repeated cursors, duplicate turn IDs and cross-turn items', async t => {
  for (const mode of ['parent', 'cursor', 'duplicate', 'item']) await t.test(mode, async () => {
    const { rpc } = peer(); const call = rpc.call.bind(rpc);
    rpc.call = async (method, params) => {
      const result = await call(method, params);
      if (mode === 'parent' && method === 'thread/read' && params.threadId === 'child') result.thread.parentThreadId = 'foreign';
      if (mode === 'cursor' && method === 'thread/turns/list') result.nextCursor = 'again';
      if (mode === 'duplicate' && method === 'thread/turns/list' && params.cursor) result.data = [parentTurn];
      if (mode === 'item' && method === 'thread/items/list') result.data[0].turnId = 'foreign';
      return result;
    };
    await assert.rejects(readCodexHistory(rpc, child, 'parent', new AbortController().signal));
  });
});

test('Aborting a stored-history read does not issue execution or control calls', async () => {
  const { rpc, requests } = peer(); const controller = new AbortController(); const call = rpc.call.bind(rpc);
  rpc.call = async (method, params) => { const result = await call(method, params); controller.abort(); return result; };
  await assert.rejects(readCodexHistory(rpc, child, 'parent', controller.signal)); assert.equal(requests.length, 1);
});
