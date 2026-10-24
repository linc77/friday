import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpProviderConnection } from '../src/acp-provider.js';
import { AcpNativeExecutor } from '../src/acp-native.js';
import { acpProviderDefaults, type AcpProviderID } from '../src/acp-provider-settings.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
const binary = fileURLToPath(new URL('./fixtures/acp-native.mjs', import.meta.url));
async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: AcpProviderID) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-acp-provider-')), wire = join(directory, 'wire.jsonl'), cwd = join(directory, 'workspace'); await mkdir(cwd); await chmod(binary, 0o755);
  const connection = new AcpProviderConnection(directory, provider, { discoveryHome: join(directory, 'home') }), executor = new AcpNativeExecutor(connection); t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  const defaults = acpProviderDefaults(provider); await connection.save({ ...defaults, enabled: true, binaryPath: binary, nativeConfig: { ...defaults.nativeConfig, source: 'local', harnessPath: binary, authMethod: 'gemini-api-key', apiKey: 'fixture-gemini-secret' }, environment: [{ name: 'ACP_TEST_WIRE', value: wire }, { name: 'ACP_TEST_HOME', value: join(directory, 'native-sessions') }] });
  return { directory, cwd, connection, executor, trace: async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
for (const provider of ['acp-registry', 'antigravity'] as const) {
  test(`${provider} independent generation follows its actual capability and cannot borrow a foreground session`, async t => {
    const fixture = await setup(t, provider);
    const input = { task: { id: 'generation', agent: provider, cwd: fixture.cwd, model: 'native-model', reasoningEffort: 'low', threadId: 'foreground', nativeProviderAccount: 'foreground-account', interactionMode: 'default', mode: 'research', events: [], approvals: [] } as unknown as WorkItem, purpose: 'task_title' as const, prompt: 'Title', signal: AbortSignal.timeout(5000), update: async () => {} };
    if (provider === 'acp-registry') { await assert.rejects(fixture.executor.generateText(input), /不支持独立文字生成/); assert.ok(!(await fixture.trace()).some(value => value.method === 'session/prompt')); return; }
    assert.ok((await fixture.executor.generateText(input)).trim());
    const trace = await fixture.trace();
    assert.ok(!trace.some(value => ['session/resume', 'session/load'].includes(value.method)));
    assert.ok(trace.some(value => value.method === 'session/set_mode' && value.params.modeId === 'plan'));
    assert.ok(trace.filter(value => value.method === 'initialize').every(value => value.params.clientCapabilities.fs.writeTextFile === false));
  });
  test(`${provider} native discovery keeps credentials private and its actual model/command catalog scoped to the workspace`, async t => {
    const { connection, directory, cwd, trace } = await setup(t, provider), owner = await connection.status(true); assert.equal(owner.installed, true); assert.equal(owner.connected, true, owner.error ?? 'Not connected'); assert.equal(owner.supportsPlan, true); assert.deepEqual(owner.models.map(value => value.id), ['native-model', 'other-model']); assert.equal(owner.settings?.nativeConfig?.apiKey, null); assert.ok(!JSON.stringify(owner).includes('fixture-gemini-secret')); assert.equal((await connection.status(false)).settings, null);
    assert.equal((await stat(join(directory, provider + '-provider.json'))).mode & 0o777, 0o600);
    assert.ok(!(await trace()).some(value => value.method === 'session/prompt')); const workspace = await connection.workspace(cwd); assert.equal(workspace.cwd, cwd); assert.equal(workspace.commands[0]?.name, 'compress'); if (provider === 'acp-registry') { assert.equal(workspace.skills[0]?.name, 'review'); assert.equal(workspace.skills[0]?.path, 'acp://skill/review'); }
    if (provider === 'antigravity') assert.ok((await trace()).filter(value => value.method === 'initialize').every(value => value.params.clientCapabilities.fs.writeTextFile === false));
    assert.ok((await trace()).some(value => value.method === 'session/new' && value.params.cwd === cwd)); const probes = (await trace()).filter(value => value.method === 'session/new').length; await connection.workspace(cwd); assert.equal((await trace()).filter(value => value.method === 'session/new').length, probes);
    const saved = await connection.save(owner.settings); assert.equal(saved.settings?.nativeConfig?.apiKeyConfigured, true);
  });
  test(`${provider} executor continues the native session and uses its advertised compression command`, async t => {
    const { connection, executor, directory, cwd, trace } = await setup(t, provider); let native = '', account = '';
    const task = (changes: Partial<WorkItem> = {}) => ({ id: 'native-provider', agent: provider, cwd, model: 'other-model', reasoningEffort: 'high', currentRunId: 'run', ...changes }) as WorkItem;
    const update = async (value: ExecutionUpdate) => { if (value.kind === 'session') { native = value.threadId; account = value.nativeProviderAccount!; } };
    assert.equal(await executor.run({ task: task({ interactionMode: 'plan' }), prompt: 'reply', signal: new AbortController().signal, update }), 'ACP reply café\u2028line\u2029end'); const session = native;
    await executor.run({ task: task({ threadId: native, nativeProviderAccount: account, interactionMode: 'default' }), prompt: 'continue', signal: new AbortController().signal, update }); assert.equal(native, session); assert.ok((await trace()).some(value => value.method === 'session/set_mode' && value.params.modeId === 'default'));
    await executor.run({ task: task({ threadId: native, nativeProviderAccount: account }), prompt: 'must not be compressed', command: 'compact', signal: new AbortController().signal, update }); assert.ok((await trace()).some(value => value.prompt === '/compress'));
    if (provider === 'antigravity') { const runtime = await connection.runtime(), one = await connection.client(runtime, cwd), two = await connection.client(runtime, cwd), records = (await trace()).filter(value => value.method === 'initialize'), a = records.at(-2)!.tempDirectory, b = records.at(-1)!.tempDirectory; assert.equal(records.at(-1)!.params.clientCapabilities.fs.writeTextFile, true); assert.notEqual(a, b); await one.close(); await assert.rejects(stat(a), { code: 'ENOENT' }); assert.ok((await stat(b)).isDirectory()); await two.close(); }
    assert.ok(directory);
  });
}
test('ACP agent-managed sign-in binds a new private credential generation and keeps old tasks from silently switching it', async t => {
  const { connection, trace } = await setup(t, 'acp-registry'), before = (await connection.runtime()).account;
  const response = await connection.login(); assert.equal(response.pending, false); assert.notEqual((await connection.runtime()).account, before); assert.ok((await trace()).some(value => value.method === 'authenticate' && value.params.methodId === 'native-auth'));
});
test('An explicit ACP sign-in can be cancelled, blocks new work while pending and invalidates uncertain credential identity', async t => {
  const { connection, trace } = await setup(t, 'acp-registry'), settings = (await connection.status(true)).settings!;
  await connection.save({ ...settings, environment: [...settings.environment, { name: 'ACP_TEST_HOLD_AUTH', value: '1' }] }); const before = (await connection.runtime()).account;
  assert.equal((await connection.login()).pending, true); assert.equal((await connection.login()).pending, true); await assert.rejects(connection.runtime(), /登录操作/);
  assert.equal((await connection.cancelLogin()).pending, false); assert.equal(connection.loginState().pending, false); assert.notEqual((await connection.runtime()).account, before); assert.equal((await trace()).filter(value => value.method === 'authenticate').length, 1);
});
