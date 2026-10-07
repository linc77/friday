import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

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
