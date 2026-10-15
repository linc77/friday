import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Executor, Workspace } from '../src/types.js';

test('Workspace identity edits persist across restarts, sync to paired clients and preserve context and paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-workspace-'));
  let engine = await new Engine(directory).open(); const auth = new Auth(directory);
  let app = createAPI(engine, auth, () => []);
  const paired = auth.pair(auth.createPairing().code, 'Phone', 'test');
  const request = (path: string, body?: unknown, method = 'PUT', token = auth.token) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const response = await request('/api/projects', { name: 'Original', path: directory, context: 'Keep project instructions' }, 'POST');
    assert.equal(response.status, 201);
    const project = await response.json();
    assert.equal(project.icon, undefined, 'Legacy workspaces need no migration');
    const path = `/api/projects/${project.id}`;
    assert.equal((await request(path, { name: '  Friday Notes  ', icon: 'book.closed', color: 'purple', path: '/do/not/move' })).status, 200);
    let saved = (await engine.snapshot()).projects[0];
    assert.equal(saved.name, 'Friday Notes');
    assert.equal(saved.context, 'Keep project instructions');
    assert.equal(saved.path, await realpath(directory));
    assert.equal(saved.id, project.id);
    assert.equal(saved.icon, 'book.closed'); assert.equal(saved.color, 'purple');
    const state = await (await request('/api/state', undefined, 'GET', paired.token)).json();
    assert.deepEqual(state.projects[0], saved, 'Paired clients see the same saved appearance');
    await engine.close(); engine = await new Engine(directory).open(); app = createAPI(engine, auth, () => []);
    assert.deepEqual((await engine.snapshot()).projects[0], saved, 'Appearance survives a service restart');
    assert.equal((await request(path, { name: 'Renamed by older client', context: 'Updated background' }, 'PUT', paired.token)).status, 200);
    saved = (await engine.snapshot()).projects[0];
    assert.equal(saved.icon, 'book.closed'); assert.equal(saved.color, 'purple');
    assert.equal(saved.context, 'Updated background');
    assert.equal((await request(path, { name: saved.name, context: '' })).status, 200);
    assert.equal((await engine.snapshot()).projects[0].context, '', 'Explicitly clearing context still works');
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Workspace appearance validates before mutation and requires authentication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-workspace-validation-'));
  const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => []);
  const request = (path: string, body: unknown, method = 'PUT') => app.request(path, { method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const created = await request('/api/projects', { name: 'Workspace', path: directory, icon: 'terminal', color: 'blue' }, 'POST');
    assert.equal(created.status, 201); const project = await created.json();
    assert.equal(project.icon, 'terminal'); assert.equal(project.color, 'blue');
    const path = `/api/projects/${project.id}`;
    const before = await engine.snapshot();
    for (const body of [null, [], { name: '' }, { name: '  ' }, { name: 'x'.repeat(121) },
      { name: 'Do not partially rename', icon: 'unknown' }, { name: 'Invalid', icon: null },
      { name: 'Invalid', color: '#ff00ff' }, { name: 'Invalid', color: 123 }, { name: 'Invalid', context: null }]) {
      assert.equal((await request(path, body)).status, 400, JSON.stringify(body));
      assert.deepEqual(await engine.snapshot(), before, 'Rejected edits leave all saved fields untouched');
    }
    assert.equal((await app.request(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Unauthorized' }) })).status, 401);
    assert.equal((await request('/api/projects/missing', { name: 'Missing' })).status, 400);
    assert.deepEqual((await engine.snapshot()).projects, before.projects);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Workspace deletion preserves files, active and completed tasks, persists and permits existing session continuation', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-workspace-delete-')));
  const projectPath = join(directory, 'project'); const otherPath = join(directory, 'other');
  await mkdir(projectPath); await mkdir(otherPath);
  const file = join(projectPath, 'keep.txt'); await writeFile(file, 'Keep project files');
  const calls: { cwd: string; threadId: string | null }[] = [];
  let hold = false; let release: (() => void) | undefined;
  const executor: Executor = {
    async run(request) {
      calls.push({ cwd: request.task.cwd, threadId: request.task.threadId });
      if (!request.task.threadId) await request.update({ kind: 'session', threadId: `session-${request.task.id}` });
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      return `Result ${calls.length}`;
    },
    async answer() {}, async steer() {},
  };
  const data = join(directory, 'service');
  let engine = await new Engine(data, executor).open(); const auth = new Auth(data);
  let app = createAPI(engine, auth, () => []);
  const paired = auth.pair(auth.createPairing().code, 'Phone', 'test');
  const request = (path: string, method: string, body?: unknown, token = auth.token) => app.request(path, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function until(predicate: (state: Workspace) => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const state = await engine.snapshot(); if (predicate(state)) return state;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    throw new Error('Task transition timed out');
  }
  try {
    const project = await (await request('/api/projects', 'POST', { name: 'Delete registration', path: projectPath })).json();
    const other = await (await request('/api/projects', 'POST', { name: 'Keep registration', path: otherPath })).json();
    const path = `/api/projects/${project.id}`;
    const create = (requestId: string) => engine.createTask({ agent: 'codex', mode: 'code', prompt: 'Inspect', projectId: project.id, requestId });
    const first = await create('completed');
    await until(state => state.tasks.find(t => t.id === first)?.status === 'completed');
    const artifact = await engine.artifact(first);
    hold = true;
    const active = await create('active');
    const before = await until(state => state.tasks.find(t => t.id === active)?.threadId != null && release !== undefined);
    assert.equal((await app.request(path, { method: 'DELETE' })).status, 401);
    assert.deepEqual(await engine.snapshot(), before, 'Unauthenticated deletion leaves the Workspace untouched');
    assert.equal((await request(path, 'DELETE', undefined, paired.token)).status, 200);
    let state = await engine.snapshot();
    assert.deepEqual(state.projects, [other]);
    assert.deepEqual(state.tasks, before.tasks, 'Removing registration preserves running work, transcripts, sessions and execution directories');
    assert.deepEqual(state.requests, before.requests);
    assert.equal(await readFile(file, 'utf8'), 'Keep project files');
    assert.equal(await engine.artifact(first), artifact);
    assert.equal((await request(path, 'DELETE')).status, 200, 'Deletion can be retried after a lost response');
    const synced = await (await request('/api/state', 'GET', undefined, paired.token)).json();
    assert.deepEqual(synced.projects, [other]);
    assert.equal(synced.tasks.length, 2);
    hold = false; release!(); release = undefined;
    await until(state => state.tasks.every(t => t.status === 'completed'));
    await engine.close(); engine = await new Engine(data, executor).open(); app = createAPI(engine, auth, () => []);
    assert.deepEqual((await engine.snapshot()).projects, [other], 'Deletion persists after restart');
    assert.equal((await request(`/api/tasks/${first}/message`, 'POST', { text: 'Continue in the original directory', requestId: 'continue' })).status, 200);
    state = await until(state => state.tasks.find(t => t.id === first)?.result === 'Result 3');
    assert.equal(state.tasks.find(t => t.id === first)?.projectId, project.id);
    assert.deepEqual(calls[2], { cwd: projectPath, threadId: `session-${first}` });
    assert.equal((await request('/api/tasks', 'POST', { agent: 'codex', mode: 'code', prompt: 'New task', projectId: project.id, requestId: 'deleted-project' })).status, 400,
      'A deleted Workspace cannot be used to start a new task');
    await assert.rejects(engine.createTask({ continueId: first, mode: 'code', prompt: 'Unrelated missing project', projectId: 'missing', requestId: 'unrelated' }), /项目不存在/);
    await engine.mutate(state => state.projects.push({ id: 'unavailable', name: 'Missing directory', path: join(directory, 'missing'), context: '' }));
    assert.equal((await request('/api/projects/unavailable', 'DELETE')).status, 200, 'A missing directory never prevents deletion');
    assert.deepEqual((await engine.snapshot()).projects, [other]);
    assert.equal(await readFile(file, 'utf8'), 'Keep project files');
  } finally { hold = false; release?.(); await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
