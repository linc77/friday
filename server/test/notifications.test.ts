import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { connect } from 'node:http2';
import { ApnsSender } from '../src/notifications.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

test('APNs uses ES256 authentication, the device environment, and a generic notification that opens the conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-apns-test-'));
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const path = join(directory, 'test.p8'); await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    let headers: Record<string, string> = {}; let payload: any; let target: unknown;
    const factory = ((url: unknown) => {
      target = url;
      const session = new EventEmitter() as any;
      session.destroy = () => {};
      session.request = (value: Record<string, string>) => {
        headers = value; const request = new EventEmitter() as any;
        request.end = (data: string) => { payload = JSON.parse(data); queueMicrotask(() => { request.emit('response', { ':status': 200 }); request.emit('end'); }); };
        return request;
      };
      queueMicrotask(() => session.emit('connect'));
      return session;
    }) as typeof connect;
    const sender = new ApnsSender({ FRIDAY_APNS_KEY_PATH: path, FRIDAY_APNS_KEY_ID: 'key-id', FRIDAY_APNS_TEAM_ID: 'team-id', FRIDAY_APNS_TOPIC: 'dev.friday.test' }, factory);
    const result = await sender.send({ deviceId: 'phone', token: 'a'.repeat(64), environment: 'development' }, 'notification-id', 'friday-health', new AbortController().signal);
    assert.equal(result.status, 'accepted'); assert.equal(target, 'https://api.sandbox.push.apple.com');
    assert.equal(headers['apns-topic'], 'dev.friday.test'); assert.equal(headers['apns-push-type'], 'alert');
    const jwt = headers.authorization.slice('bearer '.length); const parts = jwt.split('.');
    assert.equal(JSON.parse(Buffer.from(parts[0], 'base64url').toString()).alg, 'ES256');
    assert.equal(JSON.parse(Buffer.from(parts[1], 'base64url').toString()).iss, 'team-id');
    assert.equal(verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), true);
    assert.equal(payload.taskId, 'friday-health'); assert.equal(payload.deliveryId, 'notification-id');
    assert.equal(Object.hasOwn(payload, 'health'), false); assert.match(payload.aps.alert.body, /准备好/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('APNs configuration failures expose no key paths or credentials', async () => {
  const device = { deviceId: 'phone', token: 'a'.repeat(64), environment: 'production' as const };
  assert.equal((await new ApnsSender({}).send(device, 'id', 'friday-health', new AbortController().signal)).status, 'unavailable');
  const result = await new ApnsSender({ FRIDAY_APNS_KEY_PATH: '/private/no-key-here', FRIDAY_APNS_KEY_ID: 'secret-id', FRIDAY_APNS_TEAM_ID: 'secret-team', FRIDAY_APNS_TOPIC: 'topic' }).send(device, 'id', 'friday-health', new AbortController().signal);
  assert.equal(result.status, 'failed'); assert.ok(!JSON.stringify(result).includes('secret')); assert.ok(!JSON.stringify(result).includes('/private'));
});

test('HTTP/2 failures before submission can retry while an interrupted write stays uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-apns-transport-'));
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const file = join(directory, 'test.p8'); await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const env = { FRIDAY_APNS_KEY_PATH: file, FRIDAY_APNS_KEY_ID: 'key', FRIDAY_APNS_TEAM_ID: 'team', FRIDAY_APNS_TOPIC: 'dev.friday.test' };
    for (const point of ['connect', 'request', 'write']) {
      const factory = (() => {
        if (point === 'connect') throw new Error('connection failed');
        const session = new EventEmitter() as any; session.destroy = () => {};
        session.request = () => {
          if (point === 'request') throw new Error('session closed');
          const request = new EventEmitter() as any; request.end = () => { throw new Error('write interrupted'); }; return request;
        };
        queueMicrotask(() => session.emit('connect')); return session;
      }) as typeof connect;
      const result = await new ApnsSender(env, factory).send({ deviceId: 'phone', token: 'a'.repeat(64), environment: 'production' }, 'id', 'friday-health', new AbortController().signal);
      assert.equal(result.status, point === 'write' ? 'uncertain' : 'retry');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('The native host persists a validated APNs key privately and reopens without shell environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-apns-persistence-'));
  try {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const file = join(directory, 'apns-auth.json'); const sender = new ApnsSender({}, undefined, file);
    await sender.initialize(); assert.equal(sender.configured, false);
    const result = await sender.save({ keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.friday.test', privateKey: pem });
    assert.equal(result.configured, true); assert.equal(result.source, 'file'); assert.ok(!JSON.stringify(result).includes('PRIVATE KEY'));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const restored = new ApnsSender({}, undefined, file); await restored.initialize();
    assert.equal(restored.configured, true); assert.equal(restored.status(true).topic, 'dev.friday.test');
    assert.deepEqual(restored.status(false), { configured: true });
    await assert.rejects(restored.save({ keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'bad\nheader', privateKey: pem }), /Bundle Identifier/);
    await assert.rejects(restored.save({ keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.friday.test', privateKey: 'not-a-key' }), /P-256/);
    assert.equal(restored.configured, true);
    await restored.save({ keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.friday.updated' });
    const saved = JSON.parse(await readFile(file, 'utf8')); assert.equal(saved.topic, 'dev.friday.updated'); assert.ok(saved.privateKey.includes('PRIVATE KEY'));
    await restored.clear(); assert.equal(restored.configured, false); await assert.rejects(stat(file), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Only the host owner can configure APNs and paired devices never receive key material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-apns-api-'));
  const sender = new ApnsSender({}, undefined, join(directory, 'apns-auth.json'));
  const engine = await new Engine(directory, undefined, undefined, { push: sender }).open(); const auth = new Auth(directory);
  try {
    const phone = auth.pair(auth.createPairing().code, 'Phone', 'test'); const api = createAPI(engine, auth, () => []);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const config = { keyId: 'KEY1234567', teamId: 'TEAM123456', topic: 'dev.friday.test', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
    const call = (token: string, method: string, body?: object) => api.request('/api/notifications/provider', { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await call(phone.token, 'PUT', config)).status, 403);
    assert.equal((await call(auth.token, 'PUT', config)).status, 200);
    assert.deepEqual(await (await call(phone.token, 'GET')).json(), { configured: true });
    const owner = await (await call(auth.token, 'GET')).json(); assert.ok(!JSON.stringify(owner).includes('privateKey')); assert.ok(!JSON.stringify(owner).includes('PRIVATE KEY'));
    assert.equal((await call(phone.token, 'DELETE')).status, 403);
    assert.equal((await call(auth.token, 'DELETE')).status, 200);
    assert.equal(sender.configured, false);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
