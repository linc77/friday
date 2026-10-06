import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OAuthCredential } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { ModelConnection, loginError } from '../src/model.js';

test('Login diagnostics distinguish token-exchange network failures without exposing provider secrets', () => {
  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('private-host'), { code: 'ENOTFOUND' }) });
  assert.match(loginError(dns, true, false), /浏览器已返回.*无法解析 OpenAI/);
  assert.match(loginError(new Error('Port 1455 is in use, private details'), false, false), /端口 1455/);
  const rejected = loginError(new Error('OpenAI OAuth token request failed (400): access_token=secret'), true, false);
  assert.match(rejected, /OpenAI 拒绝/); assert.ok(!rejected.includes('secret'));
  assert.match(loginError(new Error('OpenAI OAuth token request failed (400): {"error":"invalid_grant","access_token":"secret"}'), true, false), /HTTP 400，invalid_grant/);
  assert.match(loginError(new Error('secret'), true, true), /超时/);
  assert.ok(!loginError(new Error('secret'), true, false).includes('secret'));
});

test('OAuth is connected only after token exchange and private credential persistence; failure can retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-login-')); const connection = new ModelConnection(directory);
  let finish!: (credential: OAuthCredential) => void; let fail!: (error: Error) => void; let exchanges = 0;
  const provider = openaiProvider();
  // Keep the Models/CredentialStore path real without binding the user's OAuth port during tests.
  connection.models.setProvider({ ...provider, auth: { oauth: { ...provider.auth.oauth!, login: async (interaction, options) => {
    exchanges++;
    assert.equal(options?.openai?.clientId, exchanges === 1 ? undefined : 'oaiapp_test');
    assert.equal(options?.openai?.agentName, 'Friday');
    await options?.openai?.onClientId?.('oaiapp_test');
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/test' });
    interaction.notify({ type: 'progress', message: 'Exchanging authorization code for tokens...' });
    return new Promise<OAuthCredential>((resolve, reject) => { finish = resolve; fail = reject; });
  } } } });
  const wait = async (status: string) => {
    for (let i = 0; i < 100; i++) { const value = await connection.status(true); if (value.login?.status === status) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Login did not settle');
  };
  try {
    for (const succeed of [false, true]) {
      const pending = await connection.startLogin(); assert.equal(pending.connected, false);
      assert.equal(pending.login!.status, 'waiting'); assert.equal(await connection.credentials.read('openai'), undefined);
      if (succeed) finish({ type: 'oauth', access: 'test-access', refresh: 'test-refresh', expires: Date.now() + 3600_000 });
      else fail(new TypeError('fetch failed', { cause: Object.assign(new Error('private-host'), { code: 'ENOTFOUND' }) }));
      const state = await wait(succeed ? 'connected' : 'error');
      assert.equal(state.connected, succeed);
      if (!succeed) { assert.match(state.login!.error!, /无法解析 OpenAI/); assert.equal(await connection.credentials.read('openai'), undefined); }
    }
    assert.equal(exchanges, 2);
    assert.equal((await stat(join(directory, 'model-auth.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, 'openai-registration.json'))).mode & 0o777, 0o600);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});
