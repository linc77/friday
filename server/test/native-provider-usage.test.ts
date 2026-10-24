import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenCodeConnection } from '../src/opencode-provider.js';
import { nativeProviderDefaults, nativeProviderAccount, nativeProviderSettings } from '../src/native-provider-config.js';
import { saveProviderSettings } from '../src/codex-settings.js';
import { cursorUsageResponse, grokUsageResponse, openCodeUsageResponse, readCursorUsage, readGrokUsage, readOpenCodeUsage } from '../src/native-provider-usage.js';

const checkedAt = '2026-10-24T00:00:00Z', reset = '2026-11-01T00:00:00Z';
const go = { usage: { rolling: { percent: 10, resetsAt: reset }, weekly: { percent: 20, resetsAt: reset }, monthly: { percent: 30, resetsAt: reset } } };
const fixtureFetch = (body: unknown, calls: { url: string; init?: RequestInit }[], status = 200) => (async (input, init) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;

test('native windows preserve reported dashboard percentages, cycle kinds, resets and a valid unmetered Grok account', () => {
  const cursor = cursorUsageResponse({ billingCycleEnd: String(Date.parse(reset)), planUsage: { totalPercentUsed: 110, autoPercentUsed: 12.5, apiPercentUsed: -1 } }, checkedAt);
  assert.deepEqual(cursor.windows.map(window => [window.id, window.usedPercent]), [['totalPercentUsed', 100], ['autoPercentUsed', 12.5], ['apiPercentUsed', 0]]);
  assert.equal(cursor.windows[0].resetsAt, new Date(reset).toISOString()); assert.equal(cursor.windows[2].label, 'Other Models');
  const grok = grokUsageResponse({ config: { creditUsagePercent: 24, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: reset } } }, checkedAt);
  assert.equal(grok.windows[0].kind, 'weekly'); assert.equal(grok.windows[0].windowDurationMins, 10080);
  assert.equal(grokUsageResponse({ config: { creditUsagePercent: 2, currentPeriod: { type: 'UNKNOWN' } } }).windows[0].kind, 'other');
  assert.deepEqual(grokUsageResponse({ config: {} }, checkedAt), { checkedAt, windows: [], available: true });
  assert.equal(openCodeUsageResponse(go, checkedAt).windows.length, 3);
  assert.throws(() => openCodeUsageResponse({ usage: { rolling: { percent: Number.NaN } } }));
  assert.throws(() => grokUsageResponse({ config: { creditUsagePercent: '12' } }));
});

test('Cursor explicit tokens use the native Connect endpoint while API keys and disabled Keychain never borrow a stored login', async () => {
  const calls: { url: string; init?: RequestInit }[] = []; let keychainReads = 0;
  const options = { platform: 'darwin' as const, readKeychain: async () => { keychainReads++; return 'fixture-keychain-token'; }, fetch: fixtureFetch({ planUsage: { totalPercentUsed: 14 } }, calls) };
  assert.equal((await readCursorUsage({ CURSOR_API_KEY: 'fixture-sdk-account' }, true, {}, options)).unavailable?.reason, 'unsupported');
  assert.equal((await readCursorUsage({}, false, {}, options)).unavailable?.reason, 'unsupported');
  assert.equal((await readCursorUsage({ AGENT_CLI_CREDENTIAL_STORE: 'memory' }, true, {}, options)).unavailable?.reason, 'unsupported');
  assert.equal((await readCursorUsage({ CURSOR_API_ENDPOINT: 'https://another.invalid' }, true, {}, options)).unavailable?.reason, 'unsupported');
  assert.equal(calls.length, 0); assert.equal(keychainReads, 0);
  const result = await readCursorUsage({ CURSOR_AUTH_TOKEN: 'fixture-explicit-cli-token', CURSOR_API_KEY: 'fixture-sdk-account' }, false, {}, options);
  assert.equal(result.windows[0].usedPercent, 14); assert.equal(result.sourceLabel, 'Cursor CLI'); assert.ok(result.credentialFingerprint);
  assert.equal(calls[0].url, 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'); assert.equal(calls[0].init?.method, 'POST'); assert.equal(calls[0].init?.redirect, 'error');
  const headers = new Headers(calls[0].init?.headers); assert.equal(headers.get('connect-protocol-version'), '1'); assert.equal(headers.get('authorization'), 'Bearer fixture-explicit-cli-token');
  assert.equal(keychainReads, 0); assert.ok(!JSON.stringify(result).includes('fixture-explicit-cli-token'));
  await readCursorUsage({}, true, {}, options); assert.equal(keychainReads, 1);
});

test('Cursor file credentials follow the configured native credential store and an HTTP failure stays distinct from unsupported', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-cursor-usage-')); t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(join(directory, '.cursor'));
  await writeFile(join(directory, '.cursor/auth.json'), JSON.stringify({ accessToken: 'fixture-file-token' }));
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await readCursorUsage({ HOME: directory, AGENT_CLI_CREDENTIAL_STORE: 'file' }, false, {}, { platform: 'darwin', fetch: fixtureFetch({ planUsage: { autoPercentUsed: 7 } }, calls) });
  assert.equal(result.windows[0].usedPercent, 7);
  assert.equal((await readCursorUsage({ CURSOR_AUTH_TOKEN: 'fixture' }, false, {}, { fetch: fixtureFetch({}, calls, 503) })).unavailable?.reason, 'probeFailed');
});

test('Grok uses only its known subscription principal and refuses custom deployments or API-key fallback', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-grok-usage-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = { 'https://accounts.x.ai/sign-in': { key: 'fixture-subscription-token', email: 'fixture@example.test' }, 'https://other.invalid': { key: 'other-account' } };
  await writeFile(join(directory, 'auth.json'), JSON.stringify(credentials));
  const calls: { url: string; init?: RequestInit }[] = [], options = { grokSystemConfigPaths: [], fetch: fixtureFetch({ config: { creditUsagePercent: 32, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: reset } } }, calls) };
  const result = await readGrokUsage({ GROK_HOME: directory }, options);
  assert.equal(result.windows[0].usedPercent, 32); assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'); assert.ok(!JSON.stringify(result).includes('fixture-subscription-token'));
  for (const extra of [{ XAI_API_KEY: 'fixture-api-key' }, { GROK_CONFIG: '/other/config' }, { GROK_OAUTH2_PRINCIPAL_ID: 'other' }, { GROK_CLI_CHAT_PROXY_BASE_URL: 'https://other.invalid' }]) assert.equal((await readGrokUsage({ GROK_HOME: directory, ...extra }, options)).unavailable?.reason, 'unsupported');
  assert.equal(calls.length, 1);
  await writeFile(join(directory, 'config.toml'), '[auth]\nprincipal="other"\n');
  assert.equal((await readGrokUsage({ GROK_HOME: directory }, options)).unavailable?.reason, 'unsupported'); assert.equal(calls.length, 1);
});

test('OpenCode external servers never read a host account; stored Go keys override environment and a valid non-Go key is unsupported', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-opencode-usage-')); t.after(() => rm(directory, { recursive: true, force: true })); await mkdir(join(directory, 'opencode'));
  await writeFile(join(directory, 'opencode/auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-stored-go-key' } }));
  const calls: { url: string; init?: RequestInit }[] = [], environment = { XDG_DATA_HOME: directory, OPENCODE_API_KEY: 'fixture-env-key' }, options = { fetch: fixtureFetch(go, calls) };
  assert.equal((await readOpenCodeUsage(true, 'http://127.0.0.1:4096', environment, options)).unavailable?.reason, 'unsupported'); assert.equal(calls.length, 0);
  const result = await readOpenCodeUsage(true, '', environment, options);
  assert.equal(result.windows[0].windowDurationMins, 300); assert.equal(new Headers(calls[0].init?.headers).get('authorization'), 'Bearer fixture-stored-go-key'); assert.ok(result.credentialFingerprint);
  assert.equal((await readOpenCodeUsage(true, '', environment, { fetch: fixtureFetch({}, calls, 403) })).unavailable?.reason, 'unsupported');
  assert.equal((await readOpenCodeUsage(true, '', environment, { fetch: fixtureFetch({ usage: {} }, calls) })).unavailable?.reason, 'probeFailed');
});
test('usage opt-in is a boolean preference and cannot invalidate a native Cursor execution account', () => {
  const base = nativeProviderSettings('cursor', nativeProviderDefaults('cursor')), enabled = nativeProviderSettings('cursor', { ...base, cursorUsageKeychainEnabled: true });
  assert.equal(enabled.cursorUsageKeychainEnabled, true); assert.equal(nativeProviderAccount('cursor', enabled), nativeProviderAccount('cursor', base));
  assert.throws(() => nativeProviderSettings('cursor', { ...base, cursorUsageKeychainEnabled: 'yes' }));
});
test('a late native usage response cannot cross a provider configuration change', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-usage-scope-')), connection = new OpenCodeConnection(directory);
  const originalFetch = globalThis.fetch; let reply!: (response: Response) => void;
  t.after(async () => { globalThis.fetch = originalFetch; reply?.(new Response(JSON.stringify(go))); await connection.close(); await rm(directory, { recursive: true, force: true }); });
  const settings = { ...nativeProviderDefaults('opencode'), enabled: true, environment: [{ name: 'OPENCODE_AUTH_CONTENT', value: JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture' } }) }] };
  await saveProviderSettings(directory, 'opencode-provider.json', settings);
  globalThis.fetch = (async () => new Promise<Response>(resolve => { reply = resolve; })) as typeof fetch;
  const pending = connection.usageLimits(true);
  const deadline = Date.now() + 1000; while (!reply && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(reply);
  await saveProviderSettings(directory, 'opencode-provider.json', { ...settings, serverUrl: 'https://new-server.invalid' } as typeof settings);
  reply(new Response(JSON.stringify(go)));
  await assert.rejects(pending, /配置已改变/);
});
