import test from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSubagents } from '../src/claude-subagents.js';
import type { SubagentRuntimeUpdate } from '../src/task-subagent-types.js';

function fixture() {
  let sequence = 0; const updates: SubagentRuntimeUpdate[] = [];
  const tracker = new ClaudeSubagents({ taskId: 'root', threadId: 'native-thread', sessionId: 'process', model: 'sonnet' }, async value => { if (value.kind === 'subagent') updates.push(structuredClone(value)); });
  const message = (value: Record<string, unknown>) => ({ uuid: 'frame-' + ++sequence, session_id: 'native-thread', ...value } as unknown as SDKMessage);
  const tool = (input: Record<string, unknown> = {}, name = 'Agent', id = 'launch') => message({ type: 'assistant', parent_tool_use_id: null, message: { id: 'tool-message', role: 'assistant', model: 'sonnet', content: [{ type: 'tool_use', id, name, input }] } });
  const child = (text: string, values: Record<string, unknown> = {}) => message({ type: 'assistant', parent_tool_use_id: 'launch', message: { id: 'child-message-' + sequence, role: 'assistant', model: 'haiku', content: [{ type: 'text', text }] }, ...values });
  const started = (values: Record<string, unknown> = {}) => message({ type: 'system', subtype: 'task_started', task_id: 'agent', task_type: 'local_agent', tool_use_id: 'launch', run_id: '001', description: 'Inspect', is_backgrounded: true, ...values });
  const ended = (values: Record<string, unknown> = {}) => message({ type: 'system', subtype: 'task_notification', task_id: 'agent', run_id: '001', tool_use_id: 'launch', status: 'completed', summary: 'Summary', ...values });
  const origin = { runId: 'run', turnId: 'root-turn' };
  return { updates, tracker, message, tool, child, started, ended, origin };
}

test('Only a native lifecycle claims early child frames; foreign, replayed and non-agent tasks cannot create child conversations', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.handle(f.child('Early answer')); assert.equal(f.updates.length, 0);
  await f.tracker.handle(f.tool({ prompt: 'Inspect without writing' }), f.origin); assert.equal(f.updates.length, 0);
  await f.tracker.handle(f.started({ task_type: 'local_bash' }), f.origin); assert.equal(f.updates.length, 0);
  const start = f.started(); await f.tracker.handle(start, f.origin);
  assert.ok(f.updates.some(update => update.value?.kind === 'output' && update.value.text === 'Early answer'));
  assert.equal(f.updates.at(-1)!.subagent.model, 'haiku');
  const before = f.updates.length; await f.tracker.handle(start, f.origin);
  await f.tracker.handle(f.child('Foreign answer', { session_id: 'another-thread' }));
  await f.tracker.handle(f.child('Replayed answer', { isReplay: true })); assert.equal(f.updates.length, before);
});

test('A resumed native task keeps its child conversation but gets a new turn; older runs and terminal debris never overwrite it', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.handle(f.tool({ prompt: 'First prompt' }), f.origin); await f.tracker.handle(f.started(), f.origin);
  await f.tracker.handle(f.child('First actual answer')); await f.tracker.handle(f.ended());
  const first = f.updates.at(-1)!.subagent; assert.equal(first.result, 'First actual answer'); assert.equal(first.status, 'completed');
  const before = f.updates.length; await f.tracker.handle(f.child('Late debris'));
  await f.tracker.handle(f.message({ type: 'system', subtype: 'task_progress', task_id: 'agent', run_id: '001', description: 'Late progress' })); assert.equal(f.updates.length, before);
  const nextOrigin = { runId: 'later-run', turnId: 'later-turn' };
  await f.tracker.handle(f.tool({ to: 'agent', message: 'Follow-up prompt' }, 'SendMessage', 'resume'), nextOrigin);
  await f.tracker.handle(f.started({ run_id: '002', tool_use_id: 'resume', prompt: 'Follow-up prompt' }), nextOrigin);
  const resumed = f.updates.at(-1)!.subagent; assert.equal(resumed.childTaskId, first.childTaskId); assert.notEqual(resumed.childTurnId, first.childTurnId); assert.equal(resumed.generation, 1); assert.equal(resumed.runId, 'later-run');
  const current = f.updates.length; await f.tracker.handle(f.started({ run_id: '001' }), f.origin);
  await f.tracker.handle(f.ended()); await f.tracker.handle(f.child('Old run answer', { run_id: '001' })); assert.equal(f.updates.length, current);
  await f.tracker.handle(f.child('Follow-up answer', { run_id: '002' })); await f.tracker.handle(f.ended({ run_id: '002', tool_use_id: 'resume' }));
  assert.equal(f.updates.at(-1)!.subagent.result, 'Follow-up answer');
});

test('Late launch metadata preserves the full prompt and ignored child frames stay bounded until their real launch is known', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.handle(f.message({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'launch', name: 'Agent', input: {} } } }), f.origin);
  for (let index = 0; index < 140; index++) await f.tracker.handle(f.child('Early ' + index));
  await f.tracker.handle(f.started(), f.origin);
  assert.ok(f.updates.some(update => update.value?.kind === 'output' && update.value.text === 'Early 127'));
  assert.ok(!JSON.stringify(f.updates).includes('Early 128'));
  const prompt = 'Actual complete prompt\n' + '内容 🚀\n'.repeat(5_000);
  await f.tracker.handle(f.tool({ prompt }), f.origin);
  assert.equal(f.updates.at(-1)!.subagent.prompt, prompt);
});

test('Explicit host interruption suppresses late prose while disconnect preserves the last native result without pretending success', async () => {
  for (const explicit of [false, true]) {
    const f = fixture(); await f.tracker.handle(f.tool({ prompt: 'Prompt' }), f.origin); await f.tracker.handle(f.started(), f.origin);
    await f.tracker.handle(f.child('Retained partial answer')); f.tracker.ignoreFrames(); await f.tracker.handle(f.child('Late success must not win'));
    await f.tracker.close(explicit);
    const state = f.updates.at(-1)!.subagent; assert.equal(state.status, explicit ? 'interrupted' : 'unknown'); assert.equal(state.result, 'Retained partial answer');
    assert.ok(!JSON.stringify(f.updates).includes('Late success must not win')); assert.equal(f.tracker.active(), false);
  }
});

test('An early child permission and plan wait for the real child identity and remain scoped to that conversation', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.permission('write', true, 'agent'); await f.tracker.propose('plan', '# Child plan', 'agent'); assert.equal(f.updates.length, 0);
  await f.tracker.handle(f.tool({ prompt: 'Inspect' }), f.origin); await f.tracker.handle(f.started(), f.origin);
  assert.equal(f.updates.at(-1)!.subagent.status, 'waiting'); assert.ok(f.updates.some(update => update.value?.kind === 'item' && update.value.item.kind === 'proposal' && update.value.item.turnId === update.subagent.childTurnId));
  await f.tracker.permission('write', false, 'agent'); assert.equal(f.updates.at(-1)!.subagent.status, 'running');
  f.tracker.ignoreFrames(); const before = f.updates.length; await f.tracker.propose('plan', '# Late plan', 'agent'); assert.equal(f.updates.length, before);
});

test('A resumed nested agent retains its original parent even when the follow-up was sent from the root', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.handle(f.tool({ prompt: 'Parent' }), f.origin); await f.tracker.handle(f.started(), f.origin); const parent = f.updates.at(-1)!.subagent;
  await f.tracker.handle(f.message({ type: 'assistant', parent_tool_use_id: 'launch', message: { id: 'nested-call', role: 'assistant', model: 'haiku', content: [{ type: 'tool_use', id: 'nested-launch', name: 'Agent', input: { prompt: 'Nested prompt' } }] } }));
  await f.tracker.handle(f.started({ task_id: 'nested', tool_use_id: 'nested-launch', parent_task_id: 'agent' }), f.origin);
  await f.tracker.handle(f.ended({ task_id: 'nested', tool_use_id: 'nested-launch' }));
  const initial = f.updates.at(-1)!.subagent; assert.equal(initial.parentSubagentId, parent.id); assert.equal(initial.eventOwnerSubagentId, parent.id);
  await f.tracker.handle(f.tool({ to: 'nested', message: 'Follow up' }, 'SendMessage', 'root-resume'), f.origin);
  await f.tracker.handle(f.started({ task_id: 'nested', tool_use_id: 'root-resume', run_id: '002', prompt: 'Follow up' }), f.origin);
  const next = f.updates.at(-1)!.subagent; assert.equal(next.childTaskId, initial.childTaskId); assert.equal(next.parentSubagentId, parent.id); assert.equal(next.eventOwnerSubagentId, undefined); assert.equal(next.eventId, 'claude:root-turn:root-resume');
});

test('A newer native run drains and interrupts unfinished tools in the old child turn before installing its replacement', async t => {
  const f = fixture(); t.after(() => f.tracker.close());
  await f.tracker.handle(f.tool({ prompt: 'Inspect' }), f.origin); await f.tracker.handle(f.started(), f.origin); const previous = f.updates.at(-1)!.subagent;
  await f.tracker.handle(f.message({ type: 'assistant', parent_tool_use_id: 'launch', message: { id: 'command', role: 'assistant', model: 'haiku', content: [{ type: 'tool_use', id: 'running-command', name: 'Bash', input: { command: 'owned command' } }] } }));
  await f.tracker.handle(f.started({ run_id: '002' }), f.origin);
  assert.ok(f.updates.some(update => update.subagent.childTurnId === previous.childTurnId && update.value?.kind === 'item' && update.value.item.itemId === 'running-command' && update.value.item.status === 'interrupted'));
  assert.notEqual(f.updates.at(-1)!.subagent.childTurnId, previous.childTurnId); assert.equal(f.updates.at(-1)!.subagent.status, 'running');
});
