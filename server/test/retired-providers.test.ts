import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { discoverAgents } from '../src/agents.js';
import { providerDrivers, type ProviderDriver } from '../src/provider-instances.js';
import { textGenerationSettingsChange } from '../src/text-generation-settings.js';
import type { Executor, WorkItem } from '../src/types.js';

const retired = ['opencode', 'grok', 'muse', 'cursor', 'antigravity', 'acp-registry'];
const message = /接入已移除/;

test('retired instances remain on disk without breaking supported accounts or allowing identity reuse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-retired-instances-'));
  const records = retired.map((driver, i) => ({ instanceId: driver + '_old', driver, displayName: driver, enabled: true, storageKey: `00000000-0000-0000-0000-00000000000${i}` }));
  records.push(...retired.map(driver => ({ instanceId: driver, driver, displayName: driver, enabled: true, storageKey: '' })).map(({ storageKey: _, ...value }) => value) as typeof records);
  await writeFile(join(directory, 'provider-instances.json'), JSON.stringify(records));
  const engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(discoverAgents().map(value => value.id), [...providerDrivers]);
  assert.deepEqual((await engine.providerInstances.list()).map(value => value.driver), [...providerDrivers]);
  for (const driver of retired) {
    await assert.rejects(engine.providerInstances.get(driver as ProviderDriver), message);
    await assert.rejects(engine.providerInstances.change({ operation: 'create', instanceId: driver + '_new', instance: { driver, displayName: driver, enabled: true } }));
    await assert.rejects(engine.providerInstances.change({ operation: 'upsert', instanceId: driver + '_old', instance: { driver: 'codex', displayName: 'wrong account', enabled: true } }), message);
    assert.throws(() => textGenerationSettingsChange({ projectId: null, expectedVersion: 0, changes: { textGenerationModelSelection: { agent: driver, model: 'old', reasoningEffort: '' } } }), /Provider/);
  }
  await engine.providerInstances.change({ operation: 'create', instanceId: 'pi_extra', instance: { driver: 'pi', displayName: 'Pi extra', enabled: true } });
  const saved = JSON.parse(await readFile(join(directory, 'provider-instances.json'), 'utf8'));
  for (const record of records) assert.deepEqual(saved.find((value: { instanceId: string }) => value.instanceId === record.instanceId), record);
});

test('removed agents keep history, artifacts and queued text across restart; submissions never run a substitute', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-retired-history-')), cwd = join(directory, 'project'); await mkdir(cwd);
  let calls = 0;
  const executor: Executor = { run: async () => { calls++; return 'supported result'; }, answer: async () => {}, steer: async () => {} };
  let engine = await new Engine(directory, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const stamp = '2026-10-01T00:00:00.000Z';
  const tasks: WorkItem[] = retired.map(agent => ({ id: 'old-' + agent, agent, providerInstanceId: agent + '_old', title: 'Historical ' + agent, prompt: 'Original prompt', projectId: 'p', cwd, mode: 'code', status: 'completed', createdAt: stamp, updatedAt: stamp, durableId: null, threadId: 'native-' + agent, turnId: 'turn-' + agent, nativeProviderAccount: 'old-account', result: 'Original answer', error: null,
    events: [{ id: 'event-' + agent, kind: 'message', text: 'Original answer', at: stamp }], approvals: [],
    messages: [{ id: 'user-' + agent, role: 'user', text: 'Original prompt', at: stamp }, { id: 'assistant-' + agent, role: 'assistant', text: 'Original answer', at: stamp }],
    artifact: 'old-' + agent + '.md', lastRequestId: 'original-' + agent,
    queue: { dispatcherId: null, paused: false, messages: [{ id: 'queued-' + agent, dispatchId: 'dispatch-' + agent, text: 'Unsent text', images: [], status: 'queued', createdAt: stamp }] },
  }));
  await mkdir(join(directory, 'artifacts'), { recursive: true });
  for (const task of tasks) await writeFile(join(directory, 'artifacts', task.artifact!), '# Original artifact');
  await engine.mutate(state => { state.projects = [{ id: 'p', name: 'Project', path: cwd, context: '' }]; state.tasks.push(...tasks); });
  await engine.close(); engine = await new Engine(directory, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  const auth = new Auth(directory); t.after(() => auth.close()); const api = createAPI(engine, auth);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const response = await api.request('/api/state', { headers }); assert.equal(response.status, 200);
  const state = await response.json();
  for (const original of tasks) {
    const task = state.tasks.find((task: WorkItem) => task.id === original.id) as WorkItem;
    for (const key of ['agent', 'providerInstanceId', 'threadId', 'turnId', 'result', 'artifact', 'messages', 'events'] as const) assert.deepEqual(task[key], original[key]);
    assert.equal(await engine.artifact(task.id), '# Original artifact');
    await assert.rejects(engine.taskRewinds.options(task.id, 'user-' + task.agent), message);
    await assert.rejects(engine.taskForks.start(task.id, { requestId: 'fork-' + task.id, runId: 'old-run' }), message);
    await assert.rejects(engine.sessionActions.start(task.id, { requestId: 'session-' + task.id, kind: 'disconnect' }), message);
    assert.equal(task.queue!.messages[0].text, 'Unsent text'); assert.equal(task.queue!.paused, true);
    await assert.rejects(engine.createTask({ continueId: task.id, projectId: 'p', mode: 'code', prompt: 'Hi', requestId: 'continue-' + task.id }), message);
    await assert.rejects(engine.taskQueue.enqueue(task.id, { text: 'Hi' }, 'enqueue-' + task.id), message);
    await assert.rejects(engine.taskQueue.resume(task.id, 'resume-' + task.id), message);
    const config = await api.request('/api/agents/' + task.agent, { headers }); assert.equal(config.status, 404);
    const submit = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: task.agent, projectId: 'p', mode: 'code', prompt: 'Hi', requestId: 'new-' + task.id }) }); assert.equal(submit.status, 400);
  }
  assert.equal(calls, 0);
  for (const agent of providerDrivers) {
    const id = await engine.createTask({ agent, projectId: 'p', mode: 'code', prompt: 'Hi', title: 'Supported', requestId: 'supported-' + agent });
    const limit = Date.now() + 5000;
    while ((await engine.snapshot()).tasks.find(task => task.id === id)?.status !== 'completed') { assert.ok(Date.now() < limit, 'Supported task timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(calls, 3);
});
