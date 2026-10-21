import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import type { WorkItem } from '../src/types.js';

test('More than three hundred retained tasks never block a new task or discard archived history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-capacity-')), cwd = join(directory, 'project'), data = join(directory, 'data');
  await mkdir(cwd); let calls = 0;
  const executor = { async run() { calls++; return 'New result'; }, async answer() {}, async steer() {} };
  const options = { changeRequestSyncIntervalMs: 0 };
  let engine = await new Engine(data, executor, undefined, options).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  const retained: WorkItem[] = Array.from({ length: 300 }, (_, index) => ({
    id: 'retained-' + index, title: 'Existing ' + index, prompt: 'Existing request', result: 'Retained result',
    cwd, projectId: 'project', agent: 'codex', mode: 'code', status: 'completed', createdAt: at, updatedAt: at,
    durableId: null, threadId: 'native-' + index, turnId: null, events: [], approvals: [], artifact: null, error: null,
    lastRequestId: 'existing-' + index, ...(index < 100 ? { archivedAt: at } : {}),
  }));
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Project', path: cwd, context: '' }]; state.tasks = retained; });
  const input = { requestId: 'above-300', projectId: 'project', agent: 'codex' as const, mode: 'code' as const, prompt: 'New work' };
  const id = await engine.createTask(input), deadline = Date.now() + 5000;
  while ((await engine.snapshot()).tasks.find(task => task.id === id)?.status !== 'completed') {
    assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await engine.snapshot()).tasks.length, 301); assert.equal(calls, 1);
  assert.equal(await engine.createTask(input), id);
  await engine.close(); engine = await new Engine(data, executor, undefined, options).open();
  const tasks = (await engine.snapshot()).tasks;
  assert.equal(tasks.length, 301); assert.equal(tasks.filter(task => task.archivedAt).length, 100); assert.equal(calls, 1);
  for (const previous of retained) {
    const current = tasks.find(task => task.id === previous.id)!;
    assert.equal(current.threadId, previous.threadId); assert.equal(current.result, previous.result); assert.equal(current.archivedAt, previous.archivedAt);
  }
});
