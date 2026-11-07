import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { CodexExecutor } from '../src/codex.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { WorkItem } from '../src/types.js';
import { subagentIdentity, subagentChildId } from '../src/task-subagent-types.js';
import { nativeForkTurns } from '../src/task-native-fork.js';

const command = fileURLToPath(new URL('fixtures/codex-subagents.mjs', import.meta.url));
async function waitTask(engine: Engine, id: string, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 7000;
  while (true) { const task = (await engine.snapshot()).tasks.find(task => task.id === id); if (task && predicate(task)) return task;
    assert.ok(Date.now() < deadline, 'Native fork transition missing: ' + JSON.stringify(task && { status: task.status, fork: task.forkOperation })); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: TestContext, legacy = false) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-codex-children-')); const cwd = join(directory, 'project'); const data = join(directory, 'data');
  await mkdir(cwd); await chmod(command, 0o755); let executor = new CodexExecutor(command);
  if (legacy) {
    const run = executor.run.bind(executor);
    executor.run = request => run({ ...request, update: value => {
      if (value.kind !== 'subagent') return request.update(value);
      const id = subagentIdentity(value.sessionId, value.subagent.nativeId);
      return request.update({ ...value, subagent: { ...value.subagent, id, childTaskId: subagentChildId(request.task.id, id) } });
    } });
  }
  let engine = await new Engine(data, executor).open();
  const auth = new Auth(data); let app = createAPI(engine, auth, () => []);
  await engine.mutate(state => { state.projects.push({ id: 'p', name: 'Owned native children', path: cwd, context: '' }); });
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const root = async () => (await engine.snapshot()).tasks.find(task => !task.subagentOrigin)!;
  const wait = async (predicate: (task: WorkItem) => boolean) => { const deadline = Date.now() + 6_000; while (true) { const task = await root(); if (task && predicate(task)) return task; assert.ok(Date.now() < deadline, 'Native child state missing: ' + JSON.stringify(task && { status: task.status, error: task.error, agents: task.subagents })); await new Promise(resolve => setTimeout(resolve, 10)); } };
  return { get engine() { return engine; }, get executor() { return executor; }, get app() { return app; }, root, wait, cwd, headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
    async start() { await engine.createTask({ projectId: 'p', title: 'Codex children', agent: 'codex', mode: 'research', prompt: 'First owned turn', requestId: 'first' }); return wait(task => task.status === 'completed' && !!task.subagents?.[0]?.nativeRunId); },
    wire: async () => (await readFile(join(cwd, 'subagent-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)), marker: (name: string) => writeFile(join(cwd, name), ''),
    async reopen() { await engine.close(); executor = new CodexExecutor(command); engine = await new Engine(data, executor).open(); app = createAPI(engine, auth, () => []); },
  };
}

async function storedHistory(f: Awaited<ReturnType<typeof fixture>>, update: (value: any) => void) {
  const path = join(f.cwd, 'subagent-native-history.json'); const value = JSON.parse(await readFile(path, 'utf8')); update(value); await writeFile(path, JSON.stringify(value));
}
async function heldHistory(f: Awaited<ReturnType<typeof fixture>>) {
  const deadline = Date.now() + 3000;
  while (true) { try { await access(join(f.cwd, 'held-child-history')); return; } catch {} assert.ok(Date.now() < deadline, 'Native history request was not held'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('Selected native child history repairs a missed terminal answer without starting or resuming a child', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0];
  await f.marker('history-only-child-complete'); await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  const original = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!; assert.notEqual(original.result, 'Recovered native child answer');
  assert.equal((await f.app.request(`/api/tasks/${agent.childTaskId}/snapshot`, { headers: f.headers })).status, 200);
  const child = await waitTask(f.engine, agent.childTaskId, task => task.nativeHistory?.status === 'ready');
  assert.equal(child.result, 'Recovered native child answer'); assert.equal(child.durableId, null); assert.equal(child.currentRunId, undefined); assert.ok(!child.runs?.length);
  assert.equal(child.events.filter(event => event.id === 'codex:child-turn-1:answer').length, 1); assert.ok(!child.events.some(event => event.nativeTurnId === 'inherited-parent-1'));
  assert.equal(child.messages!.filter(message => message.role === 'assistant').length, 1); assert.equal((await f.root()).result, 'Parent answer');
  const search = await (await f.app.request('/api/tasks/search?query=Recovered', { headers: f.headers })).json();
  assert.equal(search.matches.find((match: any) => match.taskId === child.id)?.epoch, child.history!.epoch, 'search navigation uses the restored conversation epoch');
  const revision = (await f.engine.snapshot()).revision; await f.engine.subagentHistory.ensure(child.id, true);
  const next = (await f.engine.snapshot()).tasks.find(task => task.id === child.id)!;
  assert.equal(next.nativeHistory!.epoch, child.nativeHistory!.epoch, 'an unchanged native history must not invalidate cached pages');
  assert.ok((await f.engine.snapshot()).revision <= revision + 2, 'explicit retry changes loading status only');
  const wire = await f.wire(); assert.equal(wire.filter(message => message.method === 'turn/start').length, 1);
  assert.ok(!wire.some(message => message.method === 'thread/resume' && message.params.threadId === 'native-child'));
});

test('Native history supplies a missing turn reference and makes a passive child reply forkable', async t => {
  const f = await fixture(t); await f.marker('omit-child-turn-start');
  await f.engine.createTask({ projectId: 'p', title: 'Missing native frames', agent: 'codex', mode: 'research', prompt: 'First owned turn', requestId: 'first' });
  const root = await f.wait(task => task.status === 'completed' && !!task.subagents?.length); const agent = root.subagents![0]; assert.equal(agent.nativeRunId, undefined);
  await f.marker('history-only-child-complete'); await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  await f.engine.subagentHistory.ensure(agent.childTaskId);
  const child = await waitTask(f.engine, agent.childTaskId, task => task.nativeHistory?.status === 'ready');
  assert.ok(child.events.some(event => event.kind === 'turn' && event.nativeTurnId === 'child-turn-1' && event.turnId === agent.childTurnId));
  assert.equal((await f.root()).subagents![0].nativeRunId, 'child-turn-1');
  const id = await f.engine.taskForks.start(child.id, { requestId: 'fork-recovered-native-child', runId: agent.childTurnId });
  const fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'completed');
  assert.equal(fork.result, 'Recovered native child answer'); assert.deepEqual(fork.forkOperation!.nativePrefix, ['inherited-parent-1', 'child-turn-1']); assert.deepEqual(fork.runs, []);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('An offline native child restores additional stored turns and retains a stable projection after restart', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish');
  await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id)); await f.reopen();
  await storedHistory(f, value => value.source.push({ id: 'missed-child-turn', status: 'completed', items: [
    { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'Stored follow-up' }] }, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Stored follow-up answer' },
  ] }));
  await f.engine.subagentHistory.ensure(agent.childTaskId);
  const child = await waitTask(f.engine, agent.childTaskId, task => task.nativeHistory?.status === 'ready'); const updated = (await f.root()).subagents![0];
  assert.equal(child.result, 'Stored follow-up answer'); assert.equal(updated.nativeRunId, 'missed-child-turn'); assert.equal(updated.generation, agent.generation + 1);
  assert.notEqual(updated.childTurnId, agent.childTurnId); assert.ok(child.events.some(event => event.nativeTurnId === 'child-turn-1'));
  assert.deepEqual(nativeForkTurns(child).map(turn => turn.nativeId), ['child-turn-1', 'missed-child-turn']);
  const epoch = child.nativeHistory!.epoch; await f.reopen(); await f.engine.subagentHistory.ensure(child.id);
  assert.equal((await f.engine.snapshot()).tasks.find(task => task.id === child.id)!.nativeHistory!.epoch, epoch);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('A delayed readonly snapshot cannot replace a native child live delta or close its execution connection', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('hold-child-history');
  const read = f.engine.subagentHistory.ensure(agent.childTaskId); await heldHistory(f); await f.marker('child-output');
  await f.wait(task => task.subagents![0].status === 'running');
  await waitTask(f.engine, agent.childTaskId, task => task.result.includes('live output café 🚀'));
  await f.marker('release-child-history'); await read;
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.result, 'Child live output café 🚀'); assert.equal(child.events.find(event => event.kind === 'message')!.text, child.result);
  assert.equal(f.executor.hasSession(root.id), true); assert.ok(!child.events.some(event => event.text === 'Stored child partial'));
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed');
});

test('Native history cannot resurrect a child whose birth execution was removed while the read was pending', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('hold-child-history');
  const read = f.engine.subagentHistory.ensure(agent.childTaskId); await heldHistory(f);
  await f.engine.mutate(state => { state.tasks.find(task => task.id === root.id)!.runs!.find(run => run.id === agent.runId)!.executionExcludedAt = new Date().toISOString(); });
  await f.marker('release-child-history'); await read;
  assert.ok(!(await f.engine.snapshot()).tasks.some(task => task.id === agent.childTaskId));
  assert.equal((await f.app.request(`/api/tasks/${agent.childTaskId}/native-history/refresh`, { method: 'POST', headers: f.headers })).status, 404);
});

test('Native history refresh requires authentication and applies only to visible native Codex children', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; const path = `/api/tasks/${agent.childTaskId}/native-history/refresh`;
  assert.equal((await f.app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 401);
  assert.equal((await f.app.request(`/api/tasks/${root.id}/native-history/refresh`, { method: 'POST', headers: f.headers })).status, 400);
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers })).status, 202);
  await waitTask(f.engine, agent.childTaskId, task => task.nativeHistory?.status === 'ready');
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
  await f.engine.mutate(state => { state.tasks.find(task => task.id === root.id)!.threadId = 'different-native-prefix'; });
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers })).status, 400);
});

test('Recovered native child events survive cold history paging and an unchanged reload without duplicate records', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish');
  await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  await storedHistory(f, value => { value.source[1].items = [
    ...Array.from({ length: 620 }, (_, index) => ({ id: 'stored-' + index, type: 'agentMessage', phase: 'commentary', text: 'Stored event ' + index })),
    { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Recovered cold answer' },
  ]; });
  await f.engine.subagentHistory.ensure(agent.childTaskId);
  let child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.nativeHistory!.status, 'ready'); assert.ok(child.eventArchive!.count > 0); assert.ok(child.events.length <= 600);
  const all = await f.engine.taskHistory.events(child); assert.equal(all.filter(event => event.id.includes(':stored-')).length, 620);
  const epoch = child.nativeHistory!.epoch; await f.reopen(); await f.engine.subagentHistory.ensure(child.id);
  child = (await f.engine.snapshot()).tasks.find(task => task.id === child.id)!;
  assert.equal(child.nativeHistory!.epoch, epoch); const reloaded = await f.engine.taskHistory.events(child);
  assert.equal(reloaded.length, all.length); assert.equal(new Set(reloaded.map(event => event.id)).size, reloaded.length);
  assert.equal(child.result, 'Recovered cold answer'); assert.ok(!child.runs?.length);
});

test('Cancelling a borrowed history read leaves the owned child model connection alive', async t => {
  const f = await fixture(t); const root = await f.start(); const child = (await f.engine.snapshot()).tasks.find(task => task.id === root.subagents![0].childTaskId)!;
  const controller = new AbortController(); await f.marker('hold-child-history');
  const read = f.executor.readSubagentHistory(child, 'native-root', controller.signal); const rejected = assert.rejects(read); await heldHistory(f);
  controller.abort(); await f.marker('release-child-history'); await rejected;
  assert.equal(f.executor.hasSession(root.id), true); await f.marker('child-output');
  await waitTask(f.engine, child.id, task => task.result.includes('live output café 🚀'));
  assert.ok(!(await f.wire()).some(message => message.method === 'turn/interrupt'));
});

test('Codex native child frames are scoped to a persistent child conversation and outlive the parent turn without another prompt', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0];
  let child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(agent.nativeId, 'native-child'); assert.equal(child.result, 'Child '); assert.equal(child.model, 'actual-child-model'); assert.equal(child.durableId, null);
  assert.ok(!root.events.some(event => event.text === 'Child ')); assert.equal(root.result, 'Parent answer'); assert.equal(f.executor.hasSession(root.id), true);
  await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Second owned turn', requestId: 'second' });
  const next = await f.wait(task => task.events.some(event => event.text === 'Second parent pending')); await f.marker('child-finish');
  const ended = await f.wait(task => task.subagents![0].status === 'completed'); child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.result, 'Actual child answer'); assert.equal(ended.currentRunId, next.currentRunId); assert.equal(ended.status, 'running'); assert.notEqual(ended.result, child.result);
  await f.marker('second-finish'); await f.wait(task => task.status === 'completed');
  const wire = await f.wire(); assert.equal(wire.filter(message => message.method === 'turn/start').length, 2); assert.ok(wire.filter(message => ['turn/start', 'thread/resume'].includes(message.method)).every(message => message.params.threadId === 'native-root'));
  await assert.rejects(access(join(f.cwd, 'unexpected-child-input'))); await assert.rejects(access(join(f.cwd, 'unexpected-child-resume')));
});

test('A new native transport reuses the original child conversation, retains its history, and rejects old Stop scopes', async t => {
  for (const legacy of [false, true]) await t.test(legacy ? 'existing transport-derived identities' : 'native thread identities', async t => {
    const f = await fixture(t, legacy); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish');
    await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
    const original = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
    if (legacy) await f.reopen(); await f.marker('resume-known-child');
    await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Continue the parent after restart', requestId: 'second' });
    const resumed = await f.wait(task => task.subagents![0].nativeRunId === 'child-turn-2' && task.subagents![0].model === 'resumed-child-model'); const next = resumed.subagents![0];
    assert.equal(resumed.subagents!.length, 1); assert.equal(next.id, agent.id); assert.equal(next.childTaskId, agent.childTaskId); assert.equal(next.runId, agent.runId);
    assert.notEqual(next.sessionId, agent.sessionId); assert.equal(next.generation, agent.generation + 1); assert.notEqual(next.childTurnId, agent.childTurnId);
    const child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
    assert.equal(child.createdAt, original.createdAt); assert.equal(child.durableId, null); assert.equal(child.subagentOrigin!.sessionId, next.sessionId);
    assert.ok(child.events.some(event => event.kind === 'message' && event.text === 'Actual child answer' && event.turnId === agent.childTurnId));
    assert.ok(child.events.some(event => event.kind === 'message' && event.text === 'Resumed child ' && event.turnId === next.childTurnId));
    assert.equal(child.messages!.filter(message => message.role === 'user' && message.text === agent.prompt).length, 1);
    assert.equal(child.messages!.filter(message => message.role === 'user' && message.text === 'Continue the original native child').length, 1);
    const beforeStale = (await f.engine.snapshot()).revision;
    await f.engine.subagents.update(root.id, { kind: 'subagent', sessionId: agent.sessionId, threadId: agent.threadId, subagent: { ...agent, result: 'Stale source result' }, value: { kind: 'output', text: 'Stale source result' } });
    await f.engine.subagents.update(root.id, { kind: 'subagent', sessionId: next.sessionId, threadId: next.threadId, previousSessionId: agent.sessionId, subagent: { ...next, result: 'Repeated adoption' }, value: { kind: 'output', text: 'Repeated adoption' } });
    assert.equal((await f.engine.snapshot()).revision, beforeStale); assert.equal((await f.engine.snapshot()).tasks.find(task => task.id === child.id)!.result, child.result);
    const response = await f.app.request(`/api/tasks/${root.id}/subagents/${agent.id}/stop`, { method: 'POST', headers: f.headers, body: JSON.stringify({ sessionId: agent.sessionId, childTurnId: agent.childTurnId, requestId: 'stale-stop' }) });
    assert.equal(response.status, 400); assert.equal((await f.wire()).filter(message => message.method === 'turn/interrupt').length, 0);
    await f.engine.subagents.stop(root.id, next.id, next.sessionId, next.childTurnId, 'current-stop'); await f.wait(task => task.subagents![0].stop?.status === 'completed');
    assert.deepEqual((await f.wire()).filter(message => message.method === 'turn/interrupt').map(message => message.params), [{ threadId: 'native-child', turnId: 'child-turn-2' }]);
    await f.marker('second-finish'); await f.wait(task => task.status === 'completed');
    const wire = await f.wire(); assert.equal(wire.filter(message => message.method === 'turn/start').length, 2);
    assert.ok(wire.filter(message => message.method === 'thread/resume').every(message => message.params.threadId === 'native-root'));
  });
});

test('A readonly native metadata response cannot overwrite a newer child selection notification', async t => {
  const f = await fixture(t); await f.marker('defer-child-selection'); const root = await f.start(); const deadline = Date.now() + 4000;
  while (!(await f.wire()).some(message => message.method === 'thread/read')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.marker('child-settings'); await f.wait(task => task.subagents![0].model === 'fresh-child-model'); await f.marker('release-child-selection');
  await f.marker('child-finish'); const ended = await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  assert.equal(ended.subagents![0].model, 'fresh-child-model'); assert.equal(ended.subagents![0].reasoningEffort, 'high'); assert.equal(ended.model, 'parent-model');
  assert.ok((await f.wire()).filter(message => message.method === 'thread/read').every(message => message.params.includeTurns === false));
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1); assert.equal(root.subagents![0].childTaskId, ended.subagents![0].childTaskId);
});

test('A completed native child reply forks with its inherited provider context while the source keeps running', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0];
  const home = join(f.cwd, 'owned-codex-home'); await f.engine.mutate(state => { state.tasks.find(task => task.id === root.id)!.codexHome = home; });
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  await f.marker('resume-known-child'); await f.engine.createTask({ continueId: root.id, projectId: 'p', mode: 'research', prompt: 'Next parent turn', requestId: 'second' });
  await f.wait(task => task.subagents![0].nativeRunId === 'child-turn-2');
  const [id, duplicate] = await Promise.all([f.engine.taskForks.start(agent.childTaskId, { requestId: 'fork-native-child', runId: agent.childTurnId }), f.engine.taskForks.start(agent.childTaskId, { requestId: 'fork-native-child', runId: agent.childTurnId })]);
  assert.equal(id, duplicate); let fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'completed');
  assert.equal(fork.threadId, 'native-fork-1'); assert.equal(fork.subagentOrigin, undefined); assert.equal(fork.durableId, null); assert.equal(fork.currentRunId, undefined); assert.deepEqual(fork.runs, []);
  assert.equal(fork.codexHome, home); assert.equal(fork.forkOrigin!.taskId, agent.childTaskId); assert.equal(fork.forkOrigin!.rootTaskId, root.id);
  assert.deepEqual(fork.forkOperation!.nativePrefix, ['inherited-parent-1', 'child-turn-1']); assert.equal(fork.result, 'Actual child answer');
  const overview = await (await f.app.request('/api/overview', { headers: f.headers })).json();
  assert.equal(overview.tasks.find((task: WorkItem) => task.id === id).forkOperation.nativePrefix, undefined, 'the sidebar does not receive the private native prefix');
  assert.deepEqual(fork.messages!.map(message => message.text), ['Inspect without changing files', 'Actual child answer']);
  assert.ok(!fork.events.some(event => event.text.includes('Resumed child'))); assert.ok(fork.events.some(event => event.kind === 'turn' && event.turnId === 'child-turn-1'));
  assert.equal((await f.root()).status, 'running'); assert.equal((await f.root()).subagents![0].status, 'running');
  const first = (await f.wire()).find(message => message.method === 'thread/fork'); assert.equal(first.params.threadId, 'native-child'); assert.equal(first.params.lastTurnId, 'child-turn-1'); assert.equal(first.params.deferGoalContinuation, true);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 2);
  await f.engine.createTask({ continueId: id, projectId: 'p', mode: 'research', prompt: 'Continue the independent fork', requestId: 'continue-fork' });
  fork = await waitTask(f.engine, id, task => task.status === 'completed' && task.result === 'Fork independent answer');
  const next = await f.engine.taskForks.start(id, { requestId: 'fork-independent-again', runId: fork.currentRunId! });
  const twice = await waitTask(f.engine, next, task => task.forkOperation?.status === 'completed');
  assert.deepEqual(twice.forkOperation!.nativePrefix, ['inherited-parent-1', 'child-turn-1', 'fork-turn-1']);
  assert.ok(twice.events.some(event => event.kind === 'turn' && event.turnId === 'child-turn-1'), 'forks retain their earlier observed native replies');
  assert.equal((await f.root()).status, 'running');
  await f.marker('child-finish'); await f.marker('second-finish'); await f.wait(task => task.status === 'completed' && task.subagents![0].status === 'completed');
});

test('Native child forks reject active turns, unsupported providers and hidden execution prefixes before creating a native fork', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0];
  await assert.rejects(f.engine.taskForks.start(agent.childTaskId, { requestId: 'active-child-fork', runId: agent.childTurnId }), /已结束/);
  assert.equal((await f.app.request(`/api/tasks/${agent.childTaskId}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'unauth-child-fork', runId: agent.childTurnId }) })).status, 401);
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed' && !f.executor.hasSession(task.id));
  await f.engine.mutate(state => { state.tasks.find(task => task.id === agent.childTaskId)!.agent = 'claude'; });
  await assert.rejects(f.engine.taskForks.start(agent.childTaskId, { requestId: 'unsupported-child-fork', runId: agent.childTurnId }), /不支持/);
  await f.engine.mutate(state => { state.tasks.find(task => task.id === agent.childTaskId)!.agent = 'codex'; state.tasks.find(task => task.id === root.id)!.runs!.find(run => run.id === agent.runId)!.revertedAt = new Date().toISOString(); });
  await assert.rejects(f.engine.taskForks.start(agent.childTaskId, { requestId: 'hidden-child-fork', runId: agent.childTurnId }), /可见历史/);
  assert.equal((await f.wire()).filter(message => message.method === 'thread/fork').length, 0); assert.equal((await f.engine.snapshot()).tasks.length, 1);
});

test('An unknown native child fork receipt retains its frozen prefix and never creates another candidate during recovery', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed'); await f.marker('lose-child-fork-receipt');
  await f.engine.patchTask(agent.childTaskId, task => { for (let i = 0; i < 160; i++) task.events.push({ id: 'cold-native-' + i, kind: 'tool', text: 'Saved child tool ' + i, at: agent.startedAt, turnId: agent.childTurnId, nativeTurnId: 'child-turn-1', status: 'completed' }); });
  const id = await f.engine.taskForks.start(agent.childTaskId, { requestId: 'lost-native-child-fork', runId: agent.childTurnId });
  let fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'interrupted'); assert.ok(fork.forkOperation!.startedAt); assert.equal(fork.forkOperation!.candidateId, undefined);
  assert.deepEqual(fork.forkOperation!.nativePrefix, ['inherited-parent-1', 'child-turn-1']);
  await f.reopen(); assert.equal(await f.engine.taskForks.start(agent.childTaskId, { requestId: 'lost-native-child-fork', runId: agent.childTurnId }), id);
  await assert.rejects(f.engine.taskForks.resolve(id, { requestId: 'repeat-unknown-native-fork', action: 'retry' }), /不能重复/);
  assert.equal((await f.wire()).filter(message => message.method === 'thread/fork').length, 1);
  await f.engine.taskForks.resolve(id, { requestId: 'visible-child-fork', action: 'new_session' }); fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'completed');
  assert.equal(fork.threadId, null); assert.equal(fork.result, 'Actual child answer'); assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
  assert.equal((await f.engine.taskHistory.eventItems(id, ['cold-native-0'])).events[0].turnId, undefined, 'fallback clears native ownership in cold pages too');
  assert.equal((await f.engine.taskHistory.eventItems(agent.childTaskId, ['cold-native-0'])).events[0].turnId, agent.childTurnId, 'the source cold history remains unchanged');
});

test('A saved native child fork candidate is inspected after restart without repeating the native fork', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed'); await f.marker('fail-child-fork-inspection');
  const id = await f.engine.taskForks.start(agent.childTaskId, { requestId: 'inspect-native-child-fork', runId: agent.childTurnId });
  const pending = await waitTask(f.engine, id, task => task.forkOperation?.status === 'interrupted'); assert.equal(pending.forkOperation!.candidateId, 'native-fork-1');
  await f.reopen(); await f.engine.taskForks.resolve(id, { requestId: 'inspect-saved-native-fork', action: 'inspect' }); const fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'completed');
  assert.equal(fork.threadId, 'native-fork-1'); assert.equal((await f.wire()).filter(message => message.method === 'thread/fork').length, 1);
});

test('An observed child boundary cannot accept a candidate that lost its unobserved inherited provider context', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed'); await f.marker('drop-inherited-child-fork-prefix');
  const id = await f.engine.taskForks.start(agent.childTaskId, { requestId: 'bad-native-child-prefix', runId: agent.childTurnId });
  const rejected = await waitTask(f.engine, id, task => task.forkOperation?.status === 'interrupted');
  assert.equal(rejected.threadId, null); assert.equal(rejected.forkOperation!.nativeResult, undefined); assert.deepEqual(rejected.forkOperation!.nativePrefix, ['inherited-parent-1', 'child-turn-1']);
  assert.equal((await f.wire()).filter(message => message.method === 'thread/fork').length, 1); assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('An interrupted child can fork its captured partial reply even when the disconnected native rollout retained an active status', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.reopen();
  const id = await f.engine.taskForks.start(agent.childTaskId, { requestId: 'partial-native-child-fork', runId: agent.childTurnId });
  const fork = await waitTask(f.engine, id, task => task.forkOperation?.status === 'completed');
  assert.equal(fork.result, 'Child '); assert.equal(fork.threadId, 'native-fork-1'); assert.equal(fork.forkOperation!.sourceStatus, 'interrupted');
  assert.equal((await f.wire()).filter(message => message.method === 'thread/fork').length, 1); assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('Rebinding an uncertain child does not offer Stop against its old native turn before the new turn is observed', async t => {
  const f = await fixture(t); const root = await f.start(); const previous = root.subagents![0]; await f.reopen();
  assert.equal((await f.root()).subagents![0].status, 'unknown'); await f.marker('resume-known-child'); await f.marker('defer-child-start');
  await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Continue after losing the old native transport', requestId: 'second' });
  const pending = await f.wait(task => task.subagents![0].sessionId !== previous.sessionId && task.subagents![0].model === 'resumed-child-model');
  assert.equal(pending.subagents![0].nativeRunId, previous.nativeRunId); assert.equal(pending.subagents![0].canStop, false);
  await f.marker('release-child-start'); const observed = await f.wait(task => task.subagents![0].nativeRunId === 'child-turn-2' && task.subagents![0].canStop === true);
  assert.equal(observed.subagents![0].generation, previous.generation + 1); assert.equal((await f.wire()).filter(message => message.method === 'turn/interrupt').length, 0);
  await f.marker('child-finish'); await f.marker('second-finish'); await f.wait(task => task.status === 'completed' && task.subagents![0].status === 'completed');
});

test('A nested native child keeps its logical parent when the root interacts with it after reconnecting', async t => {
  const f = await fixture(t); const root = await f.start(); const parent = root.subagents![0]; await f.marker('spawn-nested-child');
  const spawned = await f.wait(task => task.subagents?.some(agent => agent.nativeId === 'nested-native') === true); const nested = spawned.subagents!.find(agent => agent.nativeId === 'nested-native')!;
  assert.equal(nested.parentSubagentId, parent.id); await f.marker('finish-nested-child'); await f.marker('child-finish');
  await f.wait(task => task.subagents!.every(agent => agent.status === 'completed') && !f.executor.hasSession(task.id));
  await f.reopen(); await f.marker('resume-known-nested');
  await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Continue the nested native child', requestId: 'second' });
  const resumed = await f.wait(task => task.subagents?.some(agent => agent.id === nested.id && agent.nativeRunId === 'nested-turn-2' && agent.model === 'resumed-nested-model') === true);
  const next = resumed.subagents!.find(agent => agent.id === nested.id)!; assert.equal(next.parentSubagentId, parent.id); assert.equal(next.eventOwnerSubagentId, parent.id); assert.notEqual(next.sessionId, nested.sessionId);
  assert.equal(resumed.subagents!.find(agent => agent.id === parent.id)!.sessionId, parent.sessionId, 'observing the child must not take over its logical parent');
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === nested.childTaskId)!; assert.equal(child.subagentOrigin!.parentTaskId, parent.childTaskId);
  assert.ok(child.events.some(event => event.text === 'Original nested answer')); assert.ok(child.events.some(event => event.text === 'Resumed nested '));
  await f.marker('finish-nested-child'); await f.marker('second-finish'); await f.wait(task => task.status === 'completed' && task.subagents!.find(agent => agent.id === nested.id)!.status === 'completed');
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 2);
});

test('A late native child transcript remains readable after its launch receipt already reported completion', async t => {
  const f = await fixture(t); const root = await f.start();
  await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Second owned turn', requestId: 'second' });
  await f.wait(task => task.events.some(event => event.text === 'Second parent pending')); await f.marker('late-child-launch');
  const launched = await f.wait(task => task.subagents?.some(agent => agent.nativeId === 'late-child' && agent.status === 'completed') === true);
  const agent = launched.subagents!.find(agent => agent.nativeId === 'late-child')!; await f.marker('late-child-frames');
  await f.wait(task => task.subagents?.some(agent => agent.nativeId === 'late-child' && agent.result === 'Actual late child output') === true);
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!;
  assert.equal(child.status, 'completed'); assert.equal(child.model, undefined, 'an unknown child model must not be guessed from the parent');
  assert.ok(child.events.some(event => event.kind === 'message' && event.text === 'Actual late child output' && event.status === 'completed'));
  assert.equal((await f.root()).status, 'running'); assert.equal((await f.root()).subagents!.find(value => value.id === agent.id)!.generation, agent.generation);
  await f.marker('second-finish'); await f.wait(task => task.status === 'completed');
});

test('Codex child permissions are asked on the settled parent and require the user response before the native write', async t => {
  const f = await fixture(t); const root = await f.start(); await f.marker('child-approval');
  const pending = await f.wait(task => task.pendingSubagentRequest === 'approval'); const approval = pending.approvals.find(approval => approval.state === 'pending')!;
  assert.equal(pending.status, 'completed'); assert.equal(approval.subagentId, root.subagents![0].id); await assert.rejects(access(join(f.cwd, 'child-approved')));
  await f.engine.answer(root.id, approval.id, 'accept', {}); await f.wait(task => !task.pendingSubagentRequest);
  // Clearing the unanswered prompt acknowledges our decision, not the child
  // process consuming stdin and finishing its separately scheduled file write.
  const deadline = Date.now() + 6000;
  while (true) {
    const contents = await readFile(join(f.cwd, 'child-approved'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
    if (contents === 'approved') break;
    assert.ok(Date.now() < deadline, 'Native child did not perform its approved write'); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(await readFile(join(f.cwd, 'child-approved'), 'utf8'), 'approved'); assert.equal((await f.wire()).filter(message => message.id === 'child-approval-request' && message.result?.decision === 'accept').length, 1);
});

test('Codex child Stop is a durable native-turn control and never interrupts the parent queue', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; const path = `/api/tasks/${root.id}/subagents/${agent.id}/stop`;
  const body = { sessionId: agent.sessionId, childTurnId: agent.childTurnId, requestId: 'stop-child' };
  assert.equal((await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify({ ...body, childTurnId: 'old-turn' }) })).status, 400);
  const response = await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) }); assert.equal(response.status, 202); const receipt = await response.json();
  const stopped = await f.wait(task => task.subagents![0].stop?.status === 'completed'); assert.equal(stopped.subagents![0].status, 'interrupted'); assert.equal(stopped.status, 'completed'); assert.equal(stopped.result, 'Parent answer');
  assert.deepEqual(await (await f.app.request(path, { method: 'POST', headers: f.headers, body: JSON.stringify(body) })).json(), receipt);
  const interrupts = (await f.wire()).filter(message => message.method === 'turn/interrupt'); assert.equal(interrupts.length, 1); assert.deepEqual(interrupts[0].params, { threadId: 'native-child', turnId: 'child-turn-1' });
});

test('A native child background command retains its own output and verified Stop after both model turns completed', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0];
  await f.marker('child-background');
  const deadline = Date.now() + 5_000;
  while (!(await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)?.events.some(event => event.kind === 'command')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].status === 'completed' && task.subagents![0].backgroundCommands === 1);
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)!; const command = child.backgroundCommands![0];
  assert.equal(command.threadId, 'native-child'); assert.equal(command.turnId, 'child-turn-1'); assert.equal(f.executor.hasSession(root.id), true);
  const initial = await f.engine.commandOutputs.frame(child.id, command.id, child.history!.epoch);
  assert.equal(initial.running, true, 'a completed child model must not complete its running command');
  assert.match(initial.text, /first child output/);
  await f.marker('child-background-output');
  while (!(await f.engine.commandOutputs.frame(child.id, command.id, child.history!.epoch)).text.includes('late child output')) { assert.ok(Date.now() < deadline, 'Child background output missing'); await new Promise(resolve => setTimeout(resolve, 10)); }
  const id = await f.engine.backgroundCommands.stop(child.id, command.id, command.sessionId, 'child-command-stop');
  await f.engine.harness.waitForTask(id as any, (await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
  const ended = (await f.engine.snapshot()).tasks.find(task => task.id === child.id)!; assert.equal(ended.backgroundCommands![0].stop?.status, 'completed'); assert.match((await f.engine.commandOutputs.frame(child.id, command.id, child.history!.epoch)).text, /last child output/);
  const rpc = (await f.wire()).find(message => message.method === 'thread/backgroundTerminals/terminate'); assert.deepEqual(rpc.params, { threadId: 'native-child', processId: 'child-process' });
  assert.equal((await f.root()).result, 'Parent answer'); assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('Whole Stop after the parent settles interrupts its child without starting another model turn', async t => {
  const f = await fixture(t); const root = await f.start();
  assert.equal(root.backgroundActivity?.subagents, 1);
  await f.engine.cancel(root.id);
  const stopped = await f.root(); assert.equal(stopped.backgroundStop?.status, 'completed'); assert.equal(stopped.subagents![0].status, 'interrupted');
  assert.equal(stopped.result, 'Parent answer'); assert.equal(stopped.backgroundActivity?.subagents, 0);
  assert.deepEqual((await f.wire()).filter(message => message.method === 'turn/interrupt').map(message => message.params), [{ threadId: 'native-child', turnId: 'child-turn-1' }]);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('Whole Stop also verifies a child command after its model completed, without interrupting the completed turn', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-background');
  const deadline = Date.now() + 5000;
  while (!(await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)?.events.some(event => event.kind === 'command')) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].backgroundCommands === 1 && task.subagents![0].status === 'completed');
  await f.engine.cancel(root.id); const stopped = await f.root(); assert.equal(stopped.backgroundStop?.status, 'completed'); assert.equal(stopped.subagents![0].backgroundCommands, 0);
  assert.equal(stopped.result, 'Parent answer'); assert.equal((await f.wire()).filter(message => message.method === 'thread/backgroundTerminals/terminate').length, 1);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/interrupt').length, 0);
});

test('A lost child Stop receipt remains uncertain through restart and never repeats its native side effect', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('lose-child-stop-receipt');
  const receipt = await f.engine.subagents.stop(root.id, agent.id, agent.sessionId, agent.childTurnId, 'lost-child-stop');
  await f.wait(task => task.subagents![0].status === 'unknown' && task.subagents![0].stop?.status === 'uncertain'); await f.reopen();
  assert.equal(await f.engine.subagents.stop(root.id, agent.id, agent.sessionId, agent.childTurnId, 'lost-child-stop'), receipt);
  assert.equal((await f.root()).subagents![0].stop?.status, 'uncertain');
  await f.engine.cancel(root.id); assert.equal((await f.root()).subagents![0].status, 'interrupted');
  assert.equal((await f.wire()).filter(message => message.method === 'turn/interrupt').length, 1); assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});

test('Stopping a running parent also interrupts its native child and keeps both turn scopes exact', async t => {
  const f = await fixture(t); const root = await f.start();
  await f.engine.createTask({ continueId: root.id, projectId: 'p', agent: 'codex', mode: 'research', prompt: 'Second owned turn', requestId: 'second' });
  await f.wait(task => task.events.some(event => event.text === 'Second parent pending'));
  await f.engine.cancel(root.id);
  const ended = await f.root(); assert.equal(ended.status, 'cancelled'); assert.equal(ended.subagents![0].status, 'interrupted');
  const targets = (await f.wire()).filter(message => message.method === 'turn/interrupt').map(message => message.params).sort((a,b) => a.threadId.localeCompare(b.threadId));
  assert.deepEqual(targets, [{ threadId: 'native-child', turnId: 'child-turn-1' }, { threadId: 'native-root', turnId: 'root-turn-2' }]);
});

test('Deleting a settled parent stops the owned native child and removes its passive conversation', async t => {
  const f = await fixture(t); const root = await f.start(); await f.engine.deleteTask(root.id);
  assert.equal((await f.engine.snapshot()).tasks.length, 0);
  assert.deepEqual((await f.wire()).filter(message => message.method === 'turn/interrupt').map(message => message.params), [{ threadId: 'native-child', turnId: 'child-turn-1' }]);
});

test('A restarted service keeps native child output, marks commands unknown, and settles metadata without replay', async t => {
  const f = await fixture(t); const root = await f.start(); const agent = root.subagents![0]; await f.marker('child-background');
  const deadline = Date.now() + 5000;
  while (!(await f.engine.snapshot()).tasks.find(task => task.id === agent.childTaskId)?.events.some(event => event.kind === 'command' && event.detail === undefined)) {
    assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10));
  }
  await f.marker('child-finish'); await f.wait(task => task.subagents![0].backgroundCommands === 1 && task.subagents![0].status === 'completed');
  const launches = await readFile(join(f.cwd, 'subagent-launches'), 'utf8'); await f.reopen();
  const recovered = await f.root(); assert.equal(recovered.subagents![0].backgroundCommands, 0); assert.equal(recovered.subagents![0].unknownCommands, 1);
  await f.engine.cancel(root.id); const stopped = await f.root(); assert.equal(stopped.backgroundStop?.status, 'completed'); assert.equal(stopped.subagents![0].unknownCommands, 0);
  assert.equal(await readFile(join(f.cwd, 'subagent-launches'), 'utf8'), launches);
  assert.equal((await f.wire()).filter(message => message.method === 'turn/start').length, 1);
});
