import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';

class PlanExecutor implements Executor {
  calls: { task: ExecutionRequest['task']; prompt: string; release: () => void }[] = [];
  steers: string[] = [];
  async run(request: ExecutionRequest) {
    let release = () => {};
    const held = request.prompt.includes('hold-first') ? new Promise<void>((resolve, reject) => {
      release = resolve;
      request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }) : Promise.resolve();
    const index = this.calls.length + 1;
    this.calls.push({ task: structuredClone(request.task), prompt: request.prompt, release });
    await request.update({ kind: 'session', threadId: request.task.threadId ?? `session-${request.task.id}` });
    await request.update({ kind: 'turn', turnId: `turn-${index}` });
    await held;
    if (request.task.interactionMode === 'plan') {
      const text = `# Plan ${index}\n\nInspect, implement and verify.`;
      await request.update({ kind: 'item', item: { id: `proposal-${index}`, itemId: `proposal-${index}`, turnId: `turn-${index}`, kind: 'proposal', text, at: new Date().toISOString(), status: 'completed' } });
      return text;
    }
    return 'Implemented';
  }
  async steer(_id: string, text: string) { this.steers.push(text); }
  async answer() {}
}
async function until(engine: Engine, predicate: (value: Workspace) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Plan lifecycle timed out');
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-plan-mode-'));
  const cwd = join(directory, 'project'); await mkdir(cwd);
  const executor = new PlanExecutor(); const engine = await new Engine(directory, executor).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }));
  const auth = new Auth(directory); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: object) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { directory, cwd, engine, executor, app, post };
}

test('Plan refinement retains the session and implementation explicitly exits Plan mode with a stable receipt', async t => {
  const { directory, engine, executor, post } = await setup(t);
  const id = await engine.createTask({ prompt: 'Design a change', projectId: 'project', mode: 'code', agent: 'codex', interactionMode: 'plan', requestId: 'plan' });
  let state = await until(engine, value => value.tasks[0]?.status === 'completed'); const session = state.tasks[0].threadId;
  assert.equal(state.tasks[0].interactionMode, 'plan');
  assert.match(executor.calls[0].prompt, /Do not modify project files/); assert.doesNotMatch(executor.calls[0].prompt, /Implement the requested change/);
  const refined = await post(`/api/tasks/${id}/plan/follow-up`, { eventId: 'proposal-1', text: 'Use SQLite', requestId: 'refine' }); assert.equal(refined.status, 201);
  state = await until(engine, value => executor.calls.length === 2 && value.tasks[0].status === 'completed');
  assert.equal(executor.calls[1].task.threadId, session); assert.equal(executor.calls[1].task.interactionMode, 'plan');
  assert.match(executor.calls[1].prompt, /Use SQLite/);
  assert.equal((await post(`/api/tasks/${id}/plan/follow-up`, { eventId: 'proposal-1', text: '', requestId: 'stale' })).status, 400);
  const body = { eventId: 'proposal-2', text: '', requestId: 'implement' };
  assert.equal((await post(`/api/tasks/${id}/plan/follow-up`, body)).status, 201);
  state = await until(engine, value => executor.calls.length === 3 && value.tasks[0].status === 'completed');
  assert.equal(executor.calls[2].task.threadId, session); assert.equal(executor.calls[2].task.interactionMode, 'default');
  assert.match(executor.calls[2].prompt, /PLEASE IMPLEMENT THIS PLAN:\n# Plan 2/); assert.equal(state.tasks[0].interactionMode, 'default');
  assert.equal((await post(`/api/tasks/${id}/plan/follow-up`, body)).status, 201);
  assert.equal(executor.calls.length, 3, 'A lost response cannot create another external turn');
  assert.equal(state.tasks[0].messages?.findLast(message => message.role === 'user')?.interactionMode, 'default');
  await engine.close(); const reopened = await new Engine(directory, executor).open();
  try { assert.equal((await reopened.snapshot()).tasks[0].interactionMode, 'default'); assert.equal(executor.calls.length, 3); }
  finally { await reopened.close(); }
});

test('Implementing in a new task keeps the exact source worktree, starts a fresh native session and does not mutate the plan task', async t => {
  const { directory, engine, executor, post } = await setup(t);
  const id = await engine.createTask({ prompt: 'Design', projectId: 'project', mode: 'code', agent: 'claude', interactionMode: 'plan', requestId: 'plan' });
  await until(engine, value => value.tasks[0]?.status === 'completed');
  const worktree = join(directory, 'worktree'); await mkdir(worktree);
  await engine.mutate(state => {
    const source = state.tasks[0]; source.cwd = worktree;
    source.executionWorkspace = { mode: 'worktree', sourcePath: join(directory, 'project'), root: join(directory, 'project'), cwd: worktree, branch: 'feature', commit: 'abc', state: 'ready' };
    state.projects = []; // A removed registration must not replace a retained worktree with the default directory.
  });
  const body = { eventId: 'proposal-1', text: '', newThread: true, requestId: 'new-implementation' };
  const response = await post(`/api/tasks/${id}/plan/follow-up`, body); assert.equal(response.status, 201, await response.clone().text()); const created = (await response.json()).id;
  await until(engine, value => value.tasks.find(task => task.id === created)?.status === 'completed');
  assert.notEqual(created, id); assert.equal(executor.calls[1].task.cwd, worktree); assert.equal(executor.calls[1].task.threadId, null);
  assert.equal(executor.calls[1].task.agent, 'claude'); assert.equal(executor.calls[1].task.interactionMode, 'default');
  const state = await engine.snapshot(); assert.equal(state.tasks[0].interactionMode, 'plan'); assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.tasks[1].title, 'Implement Plan 1'); assert.equal(state.tasks[1].executionWorkspace?.state, 'ready');
  assert.equal((await post(`/api/tasks/${id}/plan/follow-up`, body)).status, 201); assert.equal(executor.calls.length, 2);
});

test('Mode changes during a run stay queued, cannot be promoted to a different mode, and dispatch with the saved mode', async t => {
  const { engine, executor, post, app } = await setup(t);
  const id = await engine.createTask({ prompt: 'hold-first', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'initial' });
  await until(engine, value => value.tasks[0]?.canSteer === true);
  const response = await post(`/api/tasks/${id}/message`, { text: 'Plan the follow-up', interactionMode: 'plan', dispatchMode: 'steer', requestId: 'next-plan' }); assert.equal(response.status, 200);
  let state = await engine.snapshot(); assert.equal(state.tasks[0].interactionMode, 'default'); assert.equal(state.tasks[0].queue?.messages[0].interactionMode, 'plan');
  assert.equal(executor.steers.length, 0); await assert.rejects(engine.taskQueue.promote(id, 'next-plan'), /交互模式不同/);
  assert.equal((await post(`/api/tasks/${id}/message`, { text: 'invalid', interactionMode: 'unknown', requestId: 'invalid' })).status, 400);
  assert.equal((await app.request(`/api/tasks/${id}/plan/follow-up`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  executor.calls[0].release();
  state = await until(engine, value => executor.calls.length === 2 && value.tasks[0].status === 'completed' && value.tasks[0].queue?.dispatcherId === null);
  assert.equal(executor.calls[1].task.interactionMode, 'plan'); assert.equal(state.tasks[0].interactionMode, 'plan');
  await engine.taskQueue.pause(id); await engine.taskQueue.enqueue(id, { text: 'Held refinement', interactionMode: 'plan' }, 'held');
  const blocked = await post(`/api/tasks/${id}/plan/follow-up`, { eventId: 'proposal-2', text: '', requestId: 'blocked' });
  assert.equal(blocked.status, 400); assert.match((await blocked.json()).error, /排队消息/);
});
