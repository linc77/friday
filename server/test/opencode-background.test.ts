import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import { backgroundCommandActivity } from '../src/task-background-commands.js';
import type { WorkItem } from '../src/types.js';
// @ts-expect-error Independent SDK HTTP/SSE fixture.
import { openCodeFixture } from './fixtures/opencode.mjs';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, 'OpenCode background fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: { after(fn: () => Promise<void>): void }, generation: 1 | 2 = 2) {
  const root = await mkdtemp(join(tmpdir(), 'friday-opencode-background-')), directory = join(root, 'data'), cwd = join(root, 'workspace'); await mkdir(cwd);
  const native = await openCodeFixture({ generation, directory: cwd }), open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open(); let engine: Engine | undefined = await open(), id = '', ordinal = 0;
  t.after(async () => { await engine?.close(); await native.close(); await rm(root, { recursive: true, force: true }); });
  await engine.opencodeConnection.save({ ...nativeProviderDefaults('opencode'), enabled: true, serverUrl: native.url, serverPassword: '私有密码' });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'OpenCode background', path: cwd, context: '' }]; });
  const task = async () => (await engine!.snapshot()).tasks.find(task => task.id === id)!;
  const wait = async (ready: (task: WorkItem) => boolean) => {
    try { return await until(task, task => !!task && ready(task)); }
    catch (error) {
      const value = await task(), receipts = Object.values((await engine!.snapshot()).nativeTurnRequests ?? {}).filter(receipt => receipt.taskId === id);
      throw new Error(JSON.stringify({ error: error instanceof Error ? error.message : 'fixture timed out', status: value?.status, result: value?.result, currentRunId: value?.currentRunId, runs: value?.runs?.map(run => ({ id: run.id, status: run.status, turnId: run.turnId })), messages: value?.messages?.map(message => ({ runId: message.runId, role: message.role, text: message.text })), receipts: receipts.map(receipt => ({ runId: receipt.runId, status: receipt.status, result: receipt.result, error: receipt.error })) }));
    }
  };
  return { native, cwd, current: () => engine!, task, wait,
    start: async (prompt = 'reply') => { id = await engine!.createTask({ projectId: 'project', title: 'OpenCode background', agent: 'opencode', mode: 'code', prompt, requestId: 'first' }); return id; },
    reopen: async () => { await engine!.close(); engine = undefined; engine = await open(); return engine; },
    wake: async (text = 'OpenCode native wake', hold = false) => {
      const first = await task(), sessionID = first.threadId!, assistantMessageID = 'assistant-wake-' + ++ordinal, report = 'synthetic-wake-' + ordinal, session = native.sessions.get(sessionID);
      session.messages.push({ id: report, type: 'synthetic', payload: { text: 'Native background report' } }, { id: assistantMessageID, type: 'assistant', content: [{ type: 'text', text }], time: { created: '2026-10-24T01:00:00Z' } });
      native.emit('session.inbox.enqueued', { sessionID, inboxID: report, item: { type: 'synthetic', payload: { text: 'Native background report' } } });
      native.emit('session.execution.started', { sessionID }); native.emit('session.text.delta', { sessionID, assistantMessageID, ordinal: 0, delta: text });
      if (!hold) { native.emit('session.text.ended', { sessionID, assistantMessageID, ordinal: 0, text }); native.emit('session.execution.succeeded', { sessionID }); }
      return { sessionID, assistantMessageID };
    },
    launchChild: async () => {
      const parent = await wait(task => !!task.threadId), sessionID = parent.threadId!, sent = native.records.find((value: any) => value.prompt === 'hold'), childID = 'ses_nativechild';
      const messages = ['first', 'second'].flatMap<Record<string, unknown>>((label, index) => generation === 2
        ? [{ id: `child-user-${index}`, type: 'user', text: label, time: { created: `2026-10-24T01:0${index}:00Z` } }, { id: `child-answer-${index}`, type: 'assistant', content: [{ type: 'text', text: `Native ${label} answer` }], time: { created: `2026-10-24T01:0${index}:01Z` } }]
        : [{ info: { id: `child-user-${index}`, sessionID: childID, role: 'user', time: { created: 1792803600000 + index * 60_000 } }, parts: [{ type: 'text', text: label }] }, { info: { id: `child-answer-${index}`, sessionID: childID, role: 'assistant', parentID: `child-user-${index}`, time: { created: 1792803601000 + index * 60_000, completed: 1792803602000 + index * 60_000 } }, parts: [{ type: 'text', text: `Native ${label} answer` }] }]);
      native.sessions.set(childID, { id: childID, parentID: sessionID, location: { directory: cwd }, messages });
      native.emit('session.created', generation === 2 ? { sessionID: childID, parentID: sessionID } : { info: { id: childID, parentID: sessionID } });
      if (generation === 2) {
        native.emit('session.inbox.delivered', { sessionID, inboxID: sent.nativeId }); native.emit('session.tool.input.started', { sessionID, id: 'native-child-tool', name: 'subagent' });
        native.emit('session.tool.called', { sessionID, id: 'native-child-tool', input: { prompt: 'Inspect native child', description: 'Native child', background: true } }); native.emit('session.tool.progress', { sessionID, id: 'native-child-tool', metadata: { sessionID: childID } });
      } else {
        native.emit('message.updated', { info: { id: sent.nativeId, sessionID, role: 'user' } });
        native.emit('message.updated', { info: { id: 'native-child-launch', sessionID, parentID: sent.nativeId, role: 'assistant' } });
        native.emit('message.part.updated', { part: { id: 'native-child-tool', sessionID, messageID: 'native-child-launch', type: 'tool', tool: 'task', state: { status: 'running', input: { prompt: 'Inspect native child', description: 'Native child' }, metadata: { sessionId: childID } } } });
      }
      native.complete(sessionID, sent.nativeId); await wait(task => task.status === 'completed' && task.subagents?.length === 1);
      return { sessionID, childID, agent: (await task()).subagents![0]! };
    } };
}
test('OpenCode 2 automatic executions persist native observations without another prompt, preserve real heads, and serialize consecutive wakes in the same SSE batch', async t => {
  const f = await fixture(t); await f.start(); const first = await f.wait(task => task.status === 'completed');
  const replies = Array.from({ length: 6 }, (_, index) => 'Native reply ' + (index + 1));
  for (const text of replies) await f.wake(text);
  const done = await f.wait(task => task.status === 'completed' && task.result === replies.at(-1));
  assert.equal(done.runs!.length, 7); assert.equal(done.executionSessionId, first.executionSessionId); assert.equal(done.messages!.filter(value => value.role === 'user').length, 1);
  assert.deepEqual(done.messages!.filter(value => value.role === 'assistant').slice(1).map(value => value.text), replies);
  assert.equal(done.nativeHead, 'assistant-wake-6'); assert.deepEqual(done.runs!.at(-1)!.nativeTurnIds, ['synthetic-wake-6']);
  assert.equal(f.native.records.filter((value: any) => value.prompt).length, 1);
  const fork = await f.current().taskForks.start(done.id, { runId: done.runs!.at(-1)!.id, requestId: 'native-wake-fork' });
  const copied = await until(async () => (await f.current().snapshot()).tasks.find(task => task.id === fork)!, value => value.forkOperation?.status === 'completed');
  assert.equal(copied.result, replies.at(-1)); assert.equal(copied.messages!.filter(value => value.role === 'user').length, 1); assert.equal(copied.runs!.length, 7);
});
test('OpenCode native wake output waits for durable identity persistence and a stopped observation is not replayed after restart', async t => {
  const f = await fixture(t); await f.start(); const first = await f.wait(task => task.status === 'completed'), engine = f.current(), update = engine.nativeTurns.update.bind(engine.nativeTurns);
  let entered!: () => void, release!: () => void; const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.nativeTurns.update = async (id, value) => { if (value.kind === 'nativeTurnStart') { entered(); await gate; } await update(id, value); };
  try { await f.wake('Native pending reply', true); await entering; assert.equal((await f.task()).result, first.result); } finally { release(); }
  const active = await f.wait(task => task.status === 'running' && task.result === 'Native pending reply'); await engine.cancel(first.id, { runId: active.currentRunId!, sessionId: active.executionSessionId! });
  await f.wait(task => ['interrupted', 'cancelled'].includes(task.status)); await f.reopen(); assert.equal((await f.task()).result, 'Native pending reply');
  assert.equal(f.native.records.filter((value: any) => value.prompt).length, 1);
});
for (const generation of [1, 2] as const) test(`OpenCode ${generation} reads the actual child's complete paginated conversation, verifies parent scope and exposes only its supported native fork`, async t => {
  const f = await fixture(t, generation); await f.start('hold'); await until(async () => f.native.records, (records: any[]) => records.some(value => value.prompt === 'hold'));
  const { agent, childID } = await f.launchChild(); assert.equal(agent.nativeThreadId, childID);
  await f.current().subagentHistory.ensure(agent.childTaskId, true);
  const child = (await f.current().snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.nativeHistory?.status, 'ready'); assert.equal(child.nativeHistory.canFork, generation === 1); assert.equal(child.threadId, childID);
  assert.ok(child.messages?.some(value => value.text === 'first')); assert.ok(child.messages?.some(value => value.text === 'Native second answer'));
  const turns = (await f.current().taskHistory.events(child)).filter(value => value.kind === 'turn'); assert.equal(turns.length, 2);
  if (generation === 1) {
    const fork = await f.current().taskForks.start(child.id, { runId: turns[0]!.turnId!, requestId: 'child-fork' });
    await until(async () => (await f.current().snapshot()).tasks.find(task => task.id === fork)!, value => value.forkOperation?.status === 'completed');
    assert.ok(f.native.records.some((value: any) => value.path === '/session/' + childID + '/fork' && value.body.messageID === 'child-user-1'));
  } else await assert.rejects(f.current().taskForks.start(child.id, { runId: turns[0]!.turnId!, requestId: 'unsupported-child-fork' }), /尚不支持/);
  f.native.sessions.get(childID).parentID = 'foreign-parent'; await f.current().subagentHistory.ensure(child.id, true);
  assert.equal((await f.current().snapshot()).tasks.find(task => task.id === child.id)!.nativeHistory!.status, 'failed');
});
test('OpenCode settled Stop addresses the actual remote child and root sessions and verifies native inactivity', async t => {
  const f = await fixture(t); await f.start('hold'); await until(async () => f.native.records, (records: any[]) => records.some(value => value.prompt === 'hold'));
  const { childID, sessionID } = await f.launchChild(), parent = await f.task(); f.native.emit('session.execution.started', { sessionID: childID });
  assert.equal(backgroundCommandActivity(parent).canStop, true); await f.current().cancel(parent.id, { runId: parent.currentRunId!, sessionId: parent.executionSessionId! });
  const done = await f.wait(task => task.backgroundStop?.status === 'completed'); assert.equal(done.subagents![0]!.status, 'interrupted');
  assert.ok(f.native.records.some((value: any) => value.path === '/api/session/' + childID + '/interrupt')); assert.ok(f.native.records.some((value: any) => value.path === '/api/session/' + sessionID + '/interrupt'));
});
