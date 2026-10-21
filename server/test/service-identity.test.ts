import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../src/auth.js';
import { Engine } from '../src/engine.js';
import { createAPI } from '../src/api.js';

test('The authenticated host identity survives restart and matches across owner, paired-device and overview transports without granting access', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-host-identity-'))), directory = join(base, 'data');
  const engine = await new Engine(directory, { run: async () => '', steer: async () => {}, answer: async () => {} }).open();
  let auth = new Auth(directory);
  t.after(async () => { await engine.close(); auth.close(); await rm(base, { recursive: true, force: true }); });
  const app = createAPI(engine, auth, () => []), pairing = auth.createPairing(), phone = auth.pair(pairing.code, 'Phone', '127.0.0.1');
  const ownerHeaders = { Authorization: 'Bearer ' + auth.token }, phoneHeaders = { Authorization: 'Bearer ' + phone.token };
  const owner = await (await app.request('/api/state', { headers: ownerHeaders })).json();
  const paired = await (await app.request('/api/state', { headers: phoneHeaders })).json();
  const overview = await (await app.request('/api/overview', { headers: phoneHeaders })).json();
  assert.match(owner.serviceId, /^[a-f0-9]{64}$/); assert.equal(owner.serviceId, auth.serviceId);
  assert.equal(paired.serviceId, owner.serviceId); assert.equal(overview.serviceId, owner.serviceId);
  assert.equal(owner.deviceId, 'owner'); assert.equal(paired.deviceId, phone.id);
  assert.ok(!JSON.stringify(owner).includes(auth.token)); assert.ok(!JSON.stringify(paired).includes(phone.token));
  assert.equal((await app.request('/api/state')).status, 401);
  assert.equal((await app.request('/api/state', { headers: { Authorization: 'Bearer ' + owner.serviceId } })).status, 401);
  const controller = new AbortController(), stream = await app.request('/api/overview/events', { headers: phoneHeaders, signal: controller.signal });
  const reader = stream.body!.getReader(), chunk = await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
  const frame = new TextDecoder().decode(chunk.value); assert.ok(frame.includes('"serviceId":"' + owner.serviceId + '"'));
  const identity = auth.serviceId; auth.close(); auth = new Auth(directory); assert.equal(auth.serviceId, identity);
  const otherDirectory = join(base, 'other'); await mkdir(otherDirectory); const other = new Auth(otherDirectory);
  try { assert.notEqual(other.serviceId, identity); } finally { other.close(); }
});
