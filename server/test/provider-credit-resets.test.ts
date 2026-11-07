import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { defaultCodexSettings } from '../src/codex-settings.js';
import { claudeResetCredits, readClaudeResetCredits, consumeClaudeResetCredit } from '../src/claude-reset-credits.js';
import { ProviderResetError, codexUsageLimits } from '../src/provider-usage-limits.js';

const now = Date.parse('2030-01-01T00:00:00Z');
test('Reset credit snapshots follow pinned T3 grant selection, eligibility, expiry and available-count rules', () => {
  const summary = codexUsageLimits({ resetCredits: { availableCount: 2, credits: [{ status: 'used', expiresAt: 1 }, { status: 'available', expiresAt: 2_000_000_000 }, { status: 'available', expiresAt: 1_900_000_000 }] } }).resetCredits;
  assert.deepEqual(summary, { availableCount: 2, nextExpiresAt: new Date(1_900_000_000_000).toISOString() });
  assert.equal(codexUsageLimits({}).resetCredits, undefined);
  const good = { id: 'credit_1', resets_left: 2, usable_now: true, ends_at: '2099-01-01T00:00:00Z' };
  const block = { eligible: true, grants: [good, { ...good, id: 'paused', paused: true }, { ...good, id: 'expired', ends_at: '2029-01-01T00:00:00Z' }, { ...good, id: 'invalid-date', ends_at: '2099-02-30T00:00:00Z' }, { ...good, id: 'not-usable', usable_now: false }], next_grant_id: good.id };
  assert.deepEqual(claudeResetCredits(block, now), { availableCount: 2, nextCreditId: good.id, nextExpiresAt: new Date(good.ends_at).toISOString() });
  assert.equal(claudeResetCredits({ ...block, eligible: false }, now), undefined);
  assert.equal(claudeResetCredits({ ...block, grants: 'malformed' }, now), undefined);
  assert.deepEqual(claudeResetCredits({ ...block, next_grant_id: 'absent' }, now), { availableCount: 0 });
});

test('Claude credit reads leave macOS Keychain alone; claims use the displayed grant, fixed API origin, OAuth headers and explicit request key', async () => {
  const paths: string[] = [], requests: { url: string; init: RequestInit }[] = [];
  const read = async (file: string) => { paths.push(file); return file.endsWith('.credentials.json') ? JSON.stringify({ claudeAiOauth: { accessToken: 'isolated-fixture-token' } }) : JSON.stringify({ oauthAccount: { organizationUuid: 'org/with space' } }); };
  const io = { platform: 'linux', read, fetch: (async (input, init) => { requests.push({ url: String(input), init: init! }); return Response.json({ result: 'reset', cedar_ember: { eligible: true, grants: [{ id: 'grant', resets_left: 1, usable_now: true }], next_grant_id: 'grant' } }); }) as typeof fetch };
  assert.equal(await readClaudeResetCredits('/fixture', '2.1.285', { ...io, platform: 'darwin' }), undefined); assert.equal(paths.length, 0); assert.equal(requests.length, 0);
  assert.equal((await readClaudeResetCredits('/fixture', '2.1.285', io))?.nextCreditId, 'grant');
  assert.equal(await consumeClaudeResetCredit({ home: '/fixture', accountConfigPath: '/fixture/account.json', version: '2.1.285', grantId: 'grant', requestId: 'same-request' }, io), 'reset');
  assert.equal(requests[1].url, 'https://api.anthropic.com/api/organizations/org%2Fwith%20space/reset_rate_limits');
  assert.equal(requests[1].init.redirect, 'error'); assert.deepEqual(JSON.parse(String(requests[1].init.body)), { program: 'cedar_ember', grant_id: 'grant', request_id: 'same-request' });
  assert.equal(new Headers(requests[1].init.headers).get('authorization'), 'Bearer isolated-fixture-token');
  for (const [result, settled] of [['cooldown', true], ['unavailable', false], ['constructor', false]] as const) {
    await assert.rejects(consumeClaudeResetCredit({ home: '/fixture', accountConfigPath: '/fixture/account.json', version: '2.1.285', grantId: 'grant', requestId: 'same-request' }, { ...io, fetch: (async () => Response.json({ result })) as typeof fetch }), error => error instanceof ProviderResetError && error.settled === settled);
  }
});

async function fixture(t: { after: (body: () => Promise<void>) => void }, mode: string) {
  const base = await mkdtemp(join(tmpdir(), 'friday-credit-reset-')), data = join(base, 'data'), home = join(base, 'home'); await mkdir(home);
  const binaryPath = fileURLToPath(new URL('fixtures/codex-provider.mjs', import.meta.url)); await chmod(binaryPath, 0o755);
  const executor = { async run(): Promise<string> { throw new Error('A reset must never send a model turn'); }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open(); const auth = new Auth(data); let app = createAPI(engine, auth, () => []);
  const settings = { ...defaultCodexSettings, binaryPath, homePath: home, environment: [{ name: 'FRIDAY_TEST_RESET', value: mode }] }; await engine.codexConnection.save(settings);
  t.after(async () => { await engine.close(); auth.close(); await rm(base, { recursive: true, force: true }); });
  const post = (body: object, token: string | null = auth.token) => app.request('/api/composer/reset-credit', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return { get engine() { return engine; }, get app() { return app; }, auth, post, data, home, settings,
    wire: async () => (await readFile(join(data, 'reset-wire.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    limits: async () => (await (await app.request('/api/composer/usage-limits', { method: 'POST', headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'codex' }) })).json()),
    async reopen() { await engine.close(); engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open(); app = createAPI(engine, auth, () => []); },
  };
}

test('A lost native reset answer persists its key across restart, never replays automatically, and an explicit retry cannot spend a second credit', async t => {
  const f = await fixture(t, 'drop-first'), limits = await f.limits(), fingerprint = limits.credentialFingerprint;
  const body = { provider: 'codex', fingerprint, requestId: 'first', confirmed: true };
  assert.equal((await f.post(body, null)).status, 401);
  const paired = f.auth.pair(f.auth.createPairing().code, 'Readonly phone', 'fixture'); assert.equal((await f.post(body, paired.token)).status, 403);
  assert.equal((await f.post({ ...body, confirmed: false })).status, 400); assert.equal((await f.post({ ...body, fingerprint: '0'.repeat(64) })).status, 400);
  const response = await f.post(body); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'uncertain');
  assert.equal((await f.wire()).length, 1); const nativeKey = (await f.wire())[0].key;
  await f.reopen(); assert.equal((await f.wire()).length, 1, 'Recovery must not retry a quota spend');
  assert.equal((await (await f.post(body)).json()).status, 'uncertain'); assert.equal((await f.wire()).length, 1);
  const retry = await (await f.post({ ...body, requestId: 'explicit-retry' })).json();
  assert.equal(retry.status, 'completed'); assert.equal(retry.outcome, 'alreadyRedeemed'); assert.equal((await f.wire())[1].key, nativeKey);
  assert.equal((await readFile(join(f.data, 'reset-spends'), 'utf8')).trim().split('\n').length, 1);
  const next = await (await f.post({ ...body, requestId: 'after-answer' })).json(); assert.equal(next.outcome, 'nothingToReset'); assert.notEqual((await f.wire())[2].key, nativeKey);
  const overview = await (await f.app.request('/api/overview', { headers: { Authorization: 'Bearer ' + f.auth.token } })).json();
  assert.equal(overview.providerCreditResets, undefined); assert.equal(overview.providerCreditAccounts, undefined); assert.equal(overview.providerUsageSnapshots.codex.windows[0].usedPercent, 0);
  assert(!JSON.stringify(retry).includes(nativeKey)); assert(!JSON.stringify(retry).includes(f.home)); assert(!JSON.stringify(retry).includes(f.auth.token));
});

test('Different confirmed requests serialize through Durable on the account; settings changes and stale account confirmations cannot redirect a spend', async t => {
  const f = await fixture(t, 'hold'), fingerprint = (await f.limits()).credentialFingerprint;
  const body = { provider: 'codex', fingerprint, confirmed: true };
  const first = f.post({ ...body, requestId: 'one' }), second = f.post({ ...body, requestId: 'two' });
  try {
    const end = Date.now() + 6_000; while (!(await readFile(join(f.data, 'reset-entered'), 'utf8').then(() => true).catch(() => false))) { assert(Date.now() < end); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal((await f.wire()).length, 1);
    await assert.rejects(f.engine.codexConnection.save(f.settings), /配置或登录/);
    const maintenance = new ServiceMaintenance(() => f.engine.snapshot()); await assert.rejects(maintenance.prepare(), /配额重置/); assert.equal(maintenance.preparing, false);
  } finally { await writeFile(join(f.data, 'release-reset'), ''); }
  const responses = await Promise.all([first, second]); const values = await Promise.all(responses.map(response => response.json())); assert.deepEqual(values.map(value => value.outcome).sort(), ['nothingToReset', 'reset']);
  assert.equal((await readFile(join(f.data, 'reset-spends'), 'utf8')).trim().split('\n').length, 1);
  assert.equal(new Set((await f.wire()).map(value => value.key)).size, 2);
  await f.engine.codexConnection.save({ ...f.settings, environment: [{ name: 'FRIDAY_TEST_RESET', value: 'hold' }, { name: 'FRIDAY_TEST_ACCOUNT', value: 'other@example.invalid' }] });
  assert.equal((await f.engine.snapshot()).providerUsageSnapshots?.codex, undefined); assert.equal((await f.engine.snapshot()).providerConfigurationVersions?.codex, 2);
  assert.equal((await f.post({ ...body, requestId: 'old-account-confirmation' })).status, 400); assert.equal((await f.wire()).length, 2);
  assert.equal((await (await f.post({ ...body, requestId: 'one' })).json()).outcome, values[0].outcome); assert.equal((await f.wire()).length, 2);
});

test('An uncertain Claude claim retains its displayed grant even when a later probe names a new credit', async t => {
  const f = await fixture(t, 'none'), fingerprint = 'a'.repeat(64), calls: { key: string; creditId?: string }[] = [];
  let creditId = 'credit_a';
  f.engine.claudeConnection.resetScope = async () => ({ provider: 'claude', accountKey: 'b'.repeat(64), settingsDigest: 'c'.repeat(64), fingerprint, creditId });
  f.engine.claudeConnection.usageLimits = async () => ({ checkedAt: new Date().toISOString(), credentialFingerprint: fingerprint, windows: [], resetCredits: { availableCount: 1, nextCreditId: creditId } });
  f.engine.claudeConnection.consumeResetCredit = async (scope, key) => {
    calls.push({ key, ...(scope.creditId ? { creditId: scope.creditId } : {}) });
    if (calls.length === 1) throw new ProviderResetError('Isolated lost answer');
    if (calls.length === 2) throw new ProviderResetError('Known preflight refusal', true);
    return calls.length === 3 ? 'alreadyRedeemed' : 'reset';
  };
  const body = { provider: 'claude', fingerprint, confirmed: true };
  assert.equal((await (await f.post({ ...body, requestId: 'grant-first' })).json()).status, 'uncertain');
  creditId = 'credit_b';
  assert.equal((await (await f.post({ ...body, requestId: 'grant-refused' })).json()).status, 'rejected');
  assert.equal((await (await f.post({ ...body, requestId: 'grant-retry' })).json()).outcome, 'alreadyRedeemed');
  assert.equal((await (await f.post({ ...body, requestId: 'grant-new' })).json()).outcome, 'reset');
  assert.deepEqual(calls.map(call => call.creditId), ['credit_a', 'credit_a', 'credit_a', 'credit_b']); assert.equal(calls[0].key, calls[1].key); assert.equal(calls[1].key, calls[2].key); assert.notEqual(calls[2].key, calls[3].key);
  assert.equal((await f.engine.snapshot()).providerCreditResets!['grant-retry'].nativeCreditId, 'credit_a');
});

test('Account reset controls remain available without an executable model, and never start or resume a task thread', async t => {
  const f = await fixture(t, 'available');
  const state = await f.engine.codexConnection.save({ ...f.settings, environment: [...f.settings.environment, { name: 'FRIDAY_TEST_EMPTY_MODELS', value: '1' }] });
  assert.equal(state.models.length, 0);
  const limits = await f.limits(); assert.equal(limits.windows[0].usedPercent, 100);
  const receipt = await (await f.post({ provider: 'codex', fingerprint: limits.credentialFingerprint, requestId: 'account-only', confirmed: true })).json();
  assert.equal(receipt.outcome, 'reset');
  const wire = (await readFile(join(f.data, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(!wire.some(value => ['thread/start', 'thread/resume', 'turn/start'].includes(value.method)));
});
