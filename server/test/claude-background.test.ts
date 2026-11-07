import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ClaudeBackground } from '../src/claude-background.js';

const frame = (subtype: string, fields: Record<string, unknown> = {}) => ({ type: 'system', subtype, session_id: 'session', uuid: randomUUID(), ...fields });
const member = (task_id: string, fields: Record<string, unknown> = {}) => ({ task_id, task_type: 'local_bash', description: 'Owned background command', ...fields });
const edge = (task_id: string, fields: Record<string, unknown> = {}) => ({ task_id, run_id: 'run-001', task_type: 'local_bash', description: 'Owned background command', ...fields });
const tracker = () => new ClaudeBackground('session', 'transport', () => '2026-10-18T12:00:00.000Z');

test('Claude level replaces the entire background membership and does not invent successful outcomes for missing bookends', () => {
  const state = tracker();
  assert.equal(state.handle(frame('background_tasks_changed', { tasks: [member('one'), member('two')] })), true);
  assert.equal(state.active().length, 2);
  state.handle(frame('background_tasks_changed', { tasks: [member('two')] }));
  assert.deepEqual(state.active().map(task => task.taskId), ['two']); assert.equal(state.current('one')?.status, 'unknown');
  state.handle(frame('background_tasks_changed', { tasks: [] })); assert.equal(state.active().length, 0);
  assert.equal(state.current('two')?.status, 'unknown'); assert.equal(state.current('two')?.completedAt, undefined);
});

test('A late notification after an empty level still supplies the original task outcome', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-001' })] }));
  const id = state.current('shell')!.id;
  state.handle(frame('background_tasks_changed', { tasks: [] }));
  state.handle(frame('task_notification', edge('shell', { status: 'completed', summary: 'Native completion', output_file: '/untrusted/never-read' })));
  const task = state.current('shell')!; assert.equal(task.id, id); assert.equal(task.status, 'completed'); assert.equal(task.summary, 'Native completion');
  assert.equal(task.member, false); assert.equal(task.completedAt, '2026-10-18T12:00:00.000Z'); assert.equal('output_file' in task, false);
});

test('Terminal notification before the final empty level cannot be resurrected by a delayed same-run level', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-001' })] }));
  state.handle(frame('task_notification', edge('shell', { status: 'failed' })));
  state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-001' })] }));
  assert.equal(state.current('shell')?.status, 'failed'); assert.equal(state.active().length, 0);
  state.handle(frame('task_notification', edge('shell', { status: 'completed' }))); assert.equal(state.current('shell')?.status, 'failed');
});

test('A new native run supersedes prior membership and rejects older or missing run IDs', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-001' })] }));
  state.handle(frame('task_started', edge('shell', { run_id: 'run-002', is_backgrounded: true })));
  assert.equal(state.current('shell')?.nativeRunId, 'run-002'); assert.equal(state.values().filter(task => task.nativeRunId === 'run-001')[0].member, false);
  state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-002' })] }));
  const id = state.current('shell')!.id;
  for (const run_id of ['run-001', undefined]) state.handle(frame('task_notification', edge('shell', { run_id, status: 'completed' })));
  assert.equal(state.current('shell')?.id, id); assert.equal(state.current('shell')?.status, 'running'); assert.equal(state.active().length, 1);
  state.handle(frame('background_tasks_changed', { tasks: [member('shell', { run_id: 'run-001' })] })); assert.equal(state.active()[0].nativeRunId, 'run-002');
});

test('Explicit legacy resume through a newly registered tool creates a distinct generation without replaying an old start', () => {
  const state = tracker(); state.registerTool('first-tool', 'Agent', { run_in_background: true });
  state.handle(frame('task_started', edge('agent', { run_id: undefined, task_type: 'local_agent', tool_use_id: 'first-tool' })));
  const first = state.current('agent')!.id; assert.equal(state.active().length, 1);
  state.handle(frame('task_notification', edge('agent', { run_id: undefined, status: 'completed' })));
  state.handle(frame('task_started', edge('agent', { run_id: undefined, tool_use_id: 'first-tool' }))); assert.equal(state.current('agent')?.id, first);
  state.registerTool('resume-tool', 'SendMessage', {});
  state.handle(frame('task_started', edge('agent', { run_id: undefined, task_type: 'local_agent', tool_use_id: 'resume-tool', is_backgrounded: true })));
  assert.notEqual(state.current('agent')?.id, first); assert.equal(state.current('agent')?.generation, 1); assert.equal(state.active().length, 1);
});

test('Foreground task edges do not become background membership until a structured move or an authoritative level', () => {
  const state = tracker(); state.registerTool('bash', 'Bash', { command: 'background words in a foreground command' });
  state.handle(frame('task_started', edge('shell', { tool_use_id: 'bash', is_backgrounded: false })));
  assert.equal(state.active().length, 0);
  state.handle(frame('task_updated', { task_id: 'shell', run_id: 'run-001', patch: { is_backgrounded: true } })); assert.equal(state.active().length, 1);
  state.handle(frame('background_tasks_changed', { tasks: [] }));
  state.handle(frame('task_updated', { task_id: 'shell', run_id: 'run-001', patch: { is_backgrounded: true, status: 'running' } }));
  assert.equal(state.active().length, 0, 'Once levels are supported, an edge cannot restore missing membership');
});

test('Monitor identity comes from its actual tool, not shell task_type or description', () => {
  const state = tracker(); state.registerTool('watch', 'Monitor', { command: 'watch' }, { turnId: 'turn', runId: 'friday-run', eventId: 'event' });
  state.handle(frame('background_tasks_changed', { tasks: [member('watcher', { run_id: 'run-001' })] }));
  state.handle(frame('task_started', edge('watcher', { tool_use_id: 'watch', is_backgrounded: true })));
  assert.equal(state.current('watcher')?.kind, 'monitor'); assert.equal(state.holdsCompletion(), true);
  assert.deepEqual(state.current('watcher')?.origin, { turnId: 'turn', runId: 'friday-run', eventId: 'event' });
  const plain = tracker(); plain.handle(frame('background_tasks_changed', { tasks: [member('shell', { description: 'Monitor the service, spawn an agent' })] }));
  assert.equal(plain.active()[0].kind, 'command'); assert.equal(plain.holdsCompletion(), false);
});

test('A tool arriving after task_started can hydrate Monitor and origin metadata without changing native identity', () => {
  const state = tracker(); state.handle(frame('task_started', edge('watcher', { tool_use_id: 'watch', is_backgrounded: true })));
  const id = state.current('watcher')!.id;
  state.registerTool('watch', 'Monitor', {}, { turnId: 'turn', eventId: 'event' });
  assert.equal(state.current('watcher')?.id, id); assert.equal(state.current('watcher')?.kind, 'monitor'); assert.equal(state.current('watcher')?.origin?.eventId, 'event');
});

test('Ambient watchers and skip_transcript tasks never hold completion or contribute to activity', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('ambient', { ambient: true }), member('agent', { task_type: 'local_agent' })] }));
  assert.deepEqual(state.active().map(task => task.taskId), ['agent']); assert.equal(state.holdsCompletion(), true);
  state.handle(frame('task_started', edge('agent', { run_id: undefined, task_type: 'local_agent', skip_transcript: true })));
  assert.equal(state.active().length, 0); assert.equal(state.holdsCompletion(), false);
  state.handle(frame('background_tasks_changed', { tasks: [member('ambient', { ambient: false })] })); assert.equal(state.active()[0].taskId, 'ambient');
});

test('Native parent references resolve only within this transport and cannot form cyclic navigation', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('root', { task_type: 'local_agent' }), member('child', { parent_task_id: 'root' }), member('unknown', { parent_task_id: 'not-registered' })] }));
  assert.equal(state.parent('child')?.taskId, 'root'); assert.equal(state.parent('unknown'), undefined);
  state.handle(frame('background_tasks_changed', { tasks: [member('root', { parent_task_id: 'child' }), member('child', { parent_task_id: 'root' })] }));
  assert.equal(state.parent('child'), undefined); assert.equal(state.parent('root'), undefined);
});

test('Malformed or cross-session level signals cannot clear valid live membership', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('shell')] }));
  for (const value of [frame('background_tasks_changed', { tasks: [], session_id: 'foreign' }), frame('background_tasks_changed', { tasks: null }),
    frame('background_tasks_changed', { tasks: [member('duplicate'), member('duplicate')] }), frame('background_tasks_changed', { tasks: [member('shell', { ambient: 'false' })] }),
    frame('background_tasks_changed', { tasks: [{ task_id: 'bad', task_type: 'local_bash' }] })]) assert.equal(state.handle(value), false);
  assert.equal(state.active().length, 1); assert.equal(state.active()[0].taskId, 'shell');
});

test('Duplicate SDK message IDs and malformed edge fields cannot mutate or resurrect a task', () => {
  const state = tracker(); const start = frame('task_started', edge('shell', { is_backgrounded: true }));
  assert.equal(state.handle(start), true); assert.equal(state.handle(start), false);
  for (const value of [frame('task_started', { ...edge('shell'), subtype: ['task_started'] }), frame('task_notification', edge('shell', { status: 'not-a-status' })),
    frame('task_updated', { task_id: 'shell', patch: null }), frame('task_started', edge('shell', { run_id: 7 }))]) assert.equal(state.handle(value), false);
  state.handle(frame('task_updated', { task_id: 'shell', run_id: 'run-001', patch: { status: '__proto__' } })); assert.equal(state.current('shell')?.status, 'running');
});

test('Public progress remains bounded, copies are isolated, and task output paths are never trusted', () => {
  const state = tracker(); state.handle(frame('task_started', edge('shell', { is_backgrounded: true })));
  state.handle(frame('task_progress', edge('shell', { summary: 'x'.repeat(3_999) + '🚀', usage: { total_tokens: 12, tool_uses: 2, duration_ms: 1_234 }, output_file: '/private/untrusted' })));
  const task = state.current('shell')!; assert.equal(task.summary?.length, 3_999); assert.deepEqual(task.usage, { totalTokens: 12, toolUses: 2, durationMs: 1_234 });
  task.description = 'Mutated outside'; assert.notEqual(state.current('shell')?.description, task.description); assert.equal('output_file' in task, false);
});

test('A new CLI transport resets membership; disconnection retains unknown outcomes without replay or fabricated completion', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('shell')] }));
  state.disconnect(); assert.equal(state.active().length, 0); assert.equal(state.current('shell')?.status, 'unknown'); assert.equal(state.current('shell')?.completedAt, undefined);
  const next = new ClaudeBackground('session', 'different-transport'); assert.equal(next.active().length, 0);
  next.handle(frame('background_tasks_changed', { tasks: [member('shell')] })); assert.notEqual(next.current('shell')?.id, state.current('shell')?.id);
});

test('Explicit owner shutdown interrupts unfinished records without changing confirmed native outcomes', () => {
  const state = tracker(); state.handle(frame('background_tasks_changed', { tasks: [member('running'), member('finished')] }));
  state.handle(frame('task_notification', { task_id: 'finished', status: 'completed', summary: 'Native completion' }));
  state.disconnect(true); assert.equal(state.current('running')?.status, 'interrupted'); assert.ok(state.current('running')?.completedAt);
  assert.equal(state.current('finished')?.status, 'completed'); assert.ok(state.values().every(work => !work.member)); assert.equal(state.active().length, 0);
});
