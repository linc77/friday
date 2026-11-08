import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ClaudeConnection, defaultClaudeSettings, validateClaudeSettings } from '../src/claude-provider.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

const binaryPath = fileURLToPath(new URL('fixtures/claude-provider.mjs', import.meta.url));
const readWire = async (directory: string) => (await readFile(join(directory, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
test('Claude probes inherited configuration without a user turn and keeps secrets on the host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-provider-')); const connection = new ClaudeConnection(directory);
  try {
    const settings = { ...defaultClaudeSettings, binaryPath, homePath: directory, model: 'sonnet', launchArgs: '--model sonnet --effort=high --setting-sources=user,project', environment: [{ name: 'ANTHROPIC_API_KEY', value: 'private-claude-test-key' }], customModels: [{ id: 'custom/gateway-model', name: 'Gateway model' }] };
    const state = await connection.save(settings);
    assert.equal(state.connected, true); assert.equal(state.version, '2.1.285'); assert.equal(state.model, 'sonnet');
    assert.equal(state.account?.type, 'apiKey'); assert.equal(state.account?.email, 'claude@example.com');
    assert.deepEqual(state.models.map(model => model.id), ['default', 'sonnet', 'custom/gateway-model']);
    assert.equal(state.models[0]?.resolvedModel, 'gateway-model'); assert.deepEqual(state.models[1]?.reasoningEfforts, ['medium', 'high', 'ultrathink']);
    assert.deepEqual(state.models[2]?.reasoningEfforts, []); assert.equal(state.models[2]?.isCustom, true);
    assert.ok(!JSON.stringify(state).includes('private-claude-test-key'));
    assert.equal((await connection.status()).settings, null); assert.equal((await connection.status()).account?.email, null);
    assert.equal((await stat(join(directory, 'claude-provider.json'))).mode & 0o777, 0o600);
    const wire = await readWire(directory);
    const initialize = wire.find(line => line.type === 'control_request'); assert.equal(initialize.request.subtype, 'initialize');
    assert.ok(!wire.some(line => line.type === 'user'));
    const launch = wire.find(line => line.args?.includes('--no-session-persistence'));
    assert.equal(launch.configDirectory, directory); assert.ok(launch.args.includes('--no-session-persistence'));
    assert.ok(launch.args.includes('{"disableAllHooks":true}')); assert.ok(launch.args.includes('--strict-mcp-config'));
    assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(launch.args[launch.args.indexOf('--effort') + 1], 'high');
    assert.equal(launch.args[launch.args.indexOf('--setting-sources') + 1], 'user,project');
    assert.equal(launch.args[launch.args.indexOf('--tools') + 1], '');
    assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' }, 'A completed probe must release its CLI');
    const runtime = await connection.runtime(); assert.deepEqual(runtime.settingSources, ['user', 'project']); assert.equal(runtime.apiEffort, 'high');
    await connection.save({ ...state.settings, environment: [{ name: 'ANTHROPIC_API_KEY', value: null }] });
    assert.match(await readFile(join(directory, 'claude-provider.json'), 'utf8'), /private-claude-test-key/);
    assert.equal((await connection.save({ ...settings, enabled: false })).connected, false);
    const signedOut = await connection.save({ ...settings, environment: [{ name: 'FRIDAY_TEST_AUTH', value: 'none' }] });
    assert.equal(signedOut.connected, false); assert.match(signedOut.error!, /尚未登录/);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const ending of ['close', 'timeout'] as const) test(`Claude capability probe ${ending} releases its CLI without submitting a turn`, { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-probe-')), connection = new ClaudeConnection(directory);
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  const checking = connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, environment: [{ name: 'FRIDAY_TEST_PROBE', value: 'hang' }] });
  let wire: Awaited<ReturnType<typeof readWire>> = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    wire = await readWire(directory).catch(() => []);
    if (wire.some(message => message.request?.subtype === 'initialize')) break;
    await delay(10);
  }
  assert.ok(wire.some(message => message.request?.subtype === 'initialize'), 'The fixture must receive initialization before cancellation');
  const launch = wire.find(message => message.args?.includes('--no-session-persistence'));
  assert.doesNotThrow(() => process.kill(launch.pid, 0));
  if (ending === 'close') await connection.close();
  const state = await checking; assert.equal(state.connected, false);
  assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
  assert.ok(!(await readWire(directory)).some(message => message.type === 'user'));
});

test('Failed SDK capability and usage probes redact errors and release their CLIs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-probe-error-')), connection = new ClaudeConnection(directory);
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  const state = await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, environment: [{ name: 'FRIDAY_TEST_PROBE', value: 'error' }] });
  assert.equal(state.connected, false); assert.ok(!JSON.stringify(state).includes('private-claude-test-key'));
  await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, environment: [{ name: 'FRIDAY_TEST_USAGE', value: 'error' }] });
  await assert.rejects(connection.usageLimits(), { message: 'usage' });
  const wire = await readWire(directory);
  assert.ok(!wire.some(message => message.type === 'user'));
  for (const launch of wire.filter(message => message.args?.includes('--no-session-persistence'))) assert.throws(() => process.kill(launch.pid, 0), { code: 'ESRCH' });
});

test('Claude configuration validation cannot turn a health probe into work', () => {
  for (const launchArgs of ['hello', '--print hello', '--resume existing', '--mcp-config unsafe', '--model']) {
    assert.throws(() => validateClaudeSettings({ ...defaultClaudeSettings, launchArgs }), /启动参数/);
  }
  assert.equal(validateClaudeSettings({ ...defaultClaudeSettings, launchArgs: '--model sonnet --effort=high' }).launchArgs, '--model sonnet --effort=high');
  assert.throws(() => validateClaudeSettings({ ...defaultClaudeSettings, environment: [{ name: 'CLAUDE_CONFIG_DIR', value: '/tmp' }] }), /运行目录/);
  assert.throws(() => validateClaudeSettings({ ...defaultClaudeSettings, customModels: [{ id: 'duplicate', name: '' }, { id: 'duplicate', name: '' }] }), /重复/);
});

test('Claude settings writes are owner-only; connected devices can read redacted models', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-api-')); const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  try {
    await engine.claudeConnection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    const app = createAPI(engine, auth, () => []); const paired = auth.pair(auth.createPairing().code, 'Phone', 'test');
    const headers = { Authorization: `Bearer ${paired.token}`, 'Content-Type': 'application/json' };
    for (const path of ['settings', 'check']) assert.equal((await app.request('/api/agents/claude/' + path, { method: path === 'settings' ? 'PUT' : 'POST', headers, body: '{}' })).status, 403);
    const state = await (await app.request('/api/agents/claude', { headers })).json();
    assert.equal(state.connected, true); assert.equal(state.settings, null); assert.equal(state.account.email, null);
    assert.equal((await app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: 'hermes', prompt: 'Do work', requestId: 'unsupported' }) })).status, 400);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
