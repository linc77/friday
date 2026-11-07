import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { Engine } from '../src/engine.js';
import type { ExecutionRequest, Executor, WorkItem } from '../src/types.js';

const idle = (): WorkItem => ({
  id: 'local-task', title: 'Original title', prompt: 'Inspect', projectId: null, cwd: '/tmp',
  agent: 'codex', mode: 'research', status: 'completed', createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z', durableId: null, threadId: 'native-thread', turnId: 'native-turn',
  result: 'Result', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'original',
});

class AbortableExecutor implements Executor {
  calls = 0;
  aborted = false;
  async run(request: ExecutionRequest): Promise<string> {
    this.calls++;
    await request.update({ kind: 'session', threadId: 'live-thread' });
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => { this.aborted = true; reject(new Error('aborted')); }, { once: true });
    });
  }
  async steer() {}
  async answer() {}
}

test('Task metadata persists across restarts without changing execution, result, or activity order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-metadata-'));
  let engine = await new Engine(directory, new AbortableExecutor()).open();
  const auth = new Auth(directory);
  let app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const patch = (body: object) => app.request('/api/tasks/local-task', { method: 'PATCH', headers, body: JSON.stringify(body) });
  try {
    await engine.mutate(state => { state.tasks.push(idle()); });
    assert.equal((await patch({ title: '  Renamed task  ', pinned: true, read: false, autoSettle: false })).status, 200);
    let task = (await engine.snapshot()).tasks[0];
    assert.equal(task.title, 'Renamed task');
    assert.ok(task.pinnedAt);
    assert.equal(task.unread, true);
    assert.equal(task.autoSettle, false);
    assert.equal(task.updatedAt, idle().updatedAt, 'metadata does not pretend agent activity occurred');
    assert.equal(task.threadId, 'native-thread');
    assert.equal(task.turnId, 'native-turn');
    assert.equal(task.result, 'Result');
    const pinnedAt = task.pinnedAt;
    assert.equal((await patch({ pinned: true })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].pinnedAt, pinnedAt, 'retrying a pin is idempotent');
    assert.equal((await patch({ settled: true })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].pinnedAt, null);
    assert.equal((await patch({ settled: false, snoozedUntil: '2099-01-01T00:00:00Z' })).status, 200);
    task = (await engine.snapshot()).tasks[0];
    assert.ok(task.unsettledAt);
    assert.equal(task.settledAt, null);
    assert.equal(task.snoozedUntil, '2099-01-01T00:00:00.000Z');
    assert.equal((await patch({ archived: true })).status, 200);
    task = (await engine.snapshot()).tasks[0];
    assert.ok(task.archivedAt);
    assert.equal(task.snoozedUntil, '2099-01-01T00:00:00.000Z', 'T3 archive retains snooze for restoration');
    await engine.close(); engine = await new Engine(directory, new AbortableExecutor()).open();
    app = createAPI(engine, auth, () => []);
    assert.deepEqual((await engine.snapshot()).tasks[0], task);
    assert.equal((await patch({ archived: false, pinned: true })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].archivedAt, null);
    assert.ok((await engine.snapshot()).tasks[0].pinnedAt);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Metadata validation is atomic and a stale read receipt cannot clear new unread output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-metadata-'));
  const engine = await new Engine(directory, new AbortableExecutor()).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const patch = (body: object, id = 'local-task') => app.request(`/api/tasks/${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  try {
    await engine.mutate(state => { state.tasks.push({ ...idle(), unread: true }); });
    for (const body of [{ title: '' }, { title: 'bad\ntitle' }, { title: 'a'.repeat(201) }, { pinned: 'true' }, { status: 'completed' }, { snoozedUntil: 'yesterday' }, { snoozedUntil: '2020-01-01' }, { seenAt: idle().updatedAt }, { archived: true, pinned: true }]) {
      assert.equal((await patch(body)).status, 400, JSON.stringify(body));
      assert.equal((await engine.snapshot()).tasks[0].title, idle().title);
      assert.equal((await engine.snapshot()).tasks[0].archivedAt, undefined, 'failed changes must roll back');
    }
    assert.equal((await app.request('/api/tasks/local-task', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await patch({ title: 'Missing' }, 'missing')).status, 400);
    assert.equal((await patch({ read: true, seenAt: '2026-10-15T00:00:00Z' })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].unread, true);
    assert.equal((await patch({ read: true, seenAt: idle().updatedAt })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].unread, false);
    await engine.mutate(state => { state.tasks[0].status = 'running'; });
    assert.equal((await patch({ archived: true })).status, 200, 'Archive saves its cancellation boundary and cleans up the owned runtime');
    assert.equal((await patch({ archived: false })).status, 200);
    await engine.mutate(state => { state.tasks[0].status = 'running'; });
    assert.equal((await patch({ snoozedUntil: '2099-01-01' })).status, 200, 'An adopted running turn can be snoozed like T3');
    assert.equal((await engine.snapshot()).tasks[0].snoozed, true);
    assert.equal((await engine.snapshot()).tasks[0].status, 'running');
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Deleting stops a live execution, preserves request tombstones, and never deletes workspace files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-delete-'));
  const executor = new AbortableExecutor(); const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}` };
  const input = { agent: 'codex' as const, prompt: 'Inspect', mode: 'research' as const, projectId: null, requestId: 'delete-live' };
  try {
    const id = await engine.createTask(input);
    const deadline = Date.now() + 5000;
    while (!(await engine.snapshot()).tasks.find(task => task.id === id)?.threadId) {
      if (Date.now() >= deadline) throw new Error('Execution did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const projectFile = join(directory, 'project.txt'); await writeFile(projectFile, 'Keep this');
    const artifact = join(directory, 'artifacts', `${id}.md`); await writeFile(artifact, 'Saved transcript');
    const response = await app.request(`/api/tasks/${id}`, { method: 'DELETE', headers });
    assert.equal(response.status, 200, await response.text());
    assert.equal(executor.aborted, true, 'the external process must stop before removal is acknowledged');
    assert.equal((await engine.snapshot()).tasks.length, 0);
    assert.equal(await readFile(projectFile, 'utf8'), 'Keep this');
    await assert.rejects(access(artifact));
    assert.equal(await engine.createTask(input), id, 'an old request cannot recreate deleted external work');
    assert.equal(executor.calls, 1);
    assert.equal((await engine.snapshot()).tasks.length, 0);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
