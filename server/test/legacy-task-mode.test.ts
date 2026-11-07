import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';

async function until(engine: Engine, ready: (state: Workspace) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (ready(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Task did not settle');
}

test('Retired plan requests cannot execute, while legacy history can continue as a normal task', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-retired-mode-'));
  const cwd = join(directory, 'project'); await mkdir(cwd);
  const calls: ExecutionRequest[] = [];
  const executor: Executor = {
    async run(request) {
      calls.push(request);
      await request.update({ kind: 'session', threadId: 'native-session' });
      return 'Normal reply';
    }, async answer() {}, async steer() {},
  };
  const engine = await new Engine(directory, executor).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }));
  const auth = new Auth(directory), api = createAPI(engine, auth, () => []);
  const post = (path: string, body: object) => api.request(path, {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const input = { prompt: 'Inspect this project', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'initial' };
  assert.equal((await post('/api/tasks', { ...input, interactionMode: 'plan' })).status, 400);
  assert.equal(calls.length, 0);
  const created = await post('/api/tasks', { ...input, interactionMode: 'default' });
  assert.equal(created.status, 201); const { id } = await created.json();
  await until(engine, state => state.tasks[0]?.status === 'completed');
  for (const body of [{ text: 'Inspect', interactionMode: 'plan' }, { text: '/plan' }, { text: '/default' }]) {
    assert.equal((await post(`/api/tasks/${id}/message`, { ...body, requestId: 'retired' })).status, 400);
  }
  for (const endpoint of ['save', 'follow-up']) assert.equal((await post(`/api/tasks/${id}/plan/${endpoint}`, {})).status, 404);
  assert.equal(calls.length, 1);

  // A saved plan remains readable; a fresh user turn clears obsolete task state.
  await engine.mutate(state => {
    Object.assign(state.tasks[0], { interactionMode: 'plan', planOrigin: { taskId: 'source', eventId: 'proposal' } });
    state.tasks[0].events.push({ id: 'legacy', kind: 'proposal', text: '# Saved plan', at: new Date().toISOString(), status: 'completed' });
  });
  assert.equal((await post(`/api/tasks/${id}/message`, { text: 'Continue normally', requestId: 'continue' })).status, 200);
  let state = await until(engine, value => calls.length === 2 && value.tasks[0].status === 'completed');
  assert.equal('interactionMode' in state.tasks[0], false); assert.equal('planOrigin' in state.tasks[0], false);
  assert.ok((await engine.taskHistory.events(state.tasks[0])).some(event => event.text === '# Saved plan'));
  assert.equal('interactionMode' in calls[1].task, false);

  // Existing pending plan input must not silently become a write-capable turn.
  await engine.taskQueue.pause(id);
  await engine.taskQueue.enqueue(id, { text: 'Saved read-only request' }, 'legacy-queue');
  await engine.mutate(value => Object.assign(value.tasks[0].queue!.messages[0], { interactionMode: 'plan' }));
  await engine.taskQueue.resume(id, 'resume');
  state = await until(engine, value => value.tasks[0].queue?.paused === true && !!value.tasks[0].queue?.messages[0].error);
  assert.match(state.tasks[0].queue!.messages[0].error!, /计划模式已移除/);
  assert.equal(calls.length, 2);
});
