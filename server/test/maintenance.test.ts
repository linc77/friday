import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ServiceMaintenance } from '../src/maintenance.js';
import type { Workspace } from '../src/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
const state = (status?: string) => ({ tasks: status ? [{ status }] : [] }) as unknown as Workspace;

test('update drains existing writes, prevents new writes and can be cancelled', async () => {
  let inspected = false;
  const gate = new ServiceMaintenance(async () => { inspected = true; return state(); });
  const leave = gate.enterWrite(); const prepare = gate.prepare();
  assert.equal(gate.preparing, true); assert.equal(inspected, false);
  assert.throws(() => gate.enterWrite(), /准备更新/);
  await assert.rejects(gate.prepare(), /已有更新/);
  leave(); await prepare; assert.equal(inspected, true);
  gate.cancel(); gate.enterWrite()();
});
test('active or waiting work prevents updates and releases the write barrier', async () => {
  for (const status of ['queued', 'running', 'waiting']) {
    const gate = new ServiceMaintenance(async () => state(status));
    await assert.rejects(gate.prepare(), /仍有任务/);
    assert.equal(gate.preparing, false); gate.enterWrite()();
  }
  const gate = new ServiceMaintenance(async () => state('completed'));
  await gate.prepare(); assert.equal(gate.preparing, true);
});
test('abandoned update leases expire without requiring a service restart', async () => {
  const gate = new ServiceMaintenance(async () => state(), 30);
  await gate.prepare(); await delay(50);
  assert.equal(gate.preparing, false); gate.enterWrite()();
});

test('only the owner can prepare or cancel an update; paired clients cannot release the barrier', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-update-api-'));
  const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  try {
    const app = createAPI(engine, auth, () => []);
    const device = auth.pair(auth.createPairing().code, 'Test device', 'local');
    const request = (path: string, method: string, token?: string, body?: object) => app.request(path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('/api/service/update', 'POST', undefined, {})).status, 401);
    assert.equal((await request('/api/service/update', 'POST', device.token, {})).status, 403);
    assert.equal((await request('/api/service/update', 'POST', auth.token, {})).status, 200);
    assert.equal((await request('/api/service/update', 'DELETE', device.token)).status, 403);
    assert.equal((await request('/api/ideas', 'POST', device.token, { text: 'Must wait' })).status, 503);
    assert.equal((await request('/api/service/update', 'DELETE', auth.token)).status, 200);
    assert.equal((await request('/api/ideas', 'POST', device.token, { text: 'Saved after update cancelled' })).status, 201);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
