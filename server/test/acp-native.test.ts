import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AcpProcess } from '../src/acp-process.js';
import { AcpNativeExecutor, type AcpNativeConnection, type AcpNativeRuntime } from '../src/acp-native.js';
import { acpInitializeRequest, acpInitializeResponse } from '../src/acp-protocol.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
const binary = fileURLToPath(new URL('./fixtures/acp-native.mjs', import.meta.url));
const task = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'acp-native-task', agent: 'acp-registry', cwd, model: 'other-model', reasoningEffort: 'high', threadId: null, currentRunId: 'run', events: [], approvals: [], ...changes }) as WorkItem;
async function setup(t: { after(fn: () => Promise<unknown>): void }, generation: 1 | 2, extra: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-acp-native-')), wire = join(directory, 'wire.jsonl'), clients = new Set<AcpProcess>(); await chmod(binary, 0o755);
  const runtime: AcpNativeRuntime = { provider: 'acp-registry', name: 'ACP Native', model: 'other-model', effort: 'high', account: 'fixture-account-binding', command: binary, args: [], compactCommand: 'compress', nativeMode: 'plan', authenticateEagerly: true, authMethod: 'native-auth', env: { ...process.env, ACP_TEST_GENERATION: String(generation), ACP_TEST_WIRE: wire, ACP_TEST_HOME: join(directory, 'sessions'), ...extra } };
  const connection: AcpNativeConnection = { provider: runtime.provider, directory, runtime: async () => runtime, client: async (runtime, cwd) => { const client = new AcpProcess(runtime.name, runtime.command, runtime.args, cwd, runtime.env); clients.add(client); const initialized = acpInitializeResponse(await client.call('initialize', acpInitializeRequest())); return { client, initialized, close: async () => { await client.close(); clients.delete(client); } }; }, close: async () => { await Promise.all([...clients].map(client => client.close())); } }, executor = new AcpNativeExecutor(connection);
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); return { executor, runtime, directory, trace };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await read()) { if (Date.now() > end) throw new Error('ACP native fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
for (const generation of [1, 2] as const) test(`ACP generation ${generation} preserves native identity and real configuration, streams once and refuses a replacement on failed resume`, async t => {
  const { executor, directory, trace } = await setup(t, generation), updates: ExecutionUpdate[] = []; let sessionId = '', account = '';
  const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'session') { sessionId = value.threadId; account = value.nativeProviderAccount!; } };
  const run = (changes: Partial<WorkItem>, prompt: string) => executor.run({ task: task(directory, changes), prompt, signal: new AbortController().signal, update, beforeStart: async () => { assert.ok(sessionId && account); } });
  assert.equal(await run({}, 'reply'), 'ACP reply café\u2028line\u2029end'); assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.text === 'printf native' && value.item.detail === 'native tool output')); assert.ok(updates.some(value => value.kind === 'contextUsage' && value.usage?.usedTokens === 12)); assert.ok(!JSON.stringify(updates).includes('WRONG'));
  const native = sessionId; updates.length = 0; await run({ threadId: native, nativeProviderAccount: account }, 'continue'); assert.equal(sessionId, native); assert.ok(!JSON.stringify(updates).includes('Loaded history'));
  const records = await trace(); assert.ok(records.some(value => value.method === (generation === 2 ? 'auth_login' : 'authenticate'))); assert.ok(records.some(value => value.method === 'session/set_config_option' && value.params.configId === 'model' && value.params.value === 'other-model')); assert.ok(records.some(value => value.method === 'session/set_mode' && value.params.modeId === 'plan'));
  const created = records.filter(value => value.method === 'session/new').length; await assert.rejects(run({ threadId: 'missing-session' }, 'continue'), /not found/); assert.equal((await trace()).filter(value => value.method === 'session/new').length, created); await assert.rejects(run({ nativeProviderAccount: 'other-account' }, 'reply'), /账号配置/);
});
test('ACP setup permissions save the native ID and Durable start boundary before writing the exact offered choice ID', async t => {
  const { executor, directory, trace } = await setup(t, 1, { ACP_TEST_INIT_PERMISSION: '1' }); let session = '', started = false, answer: Promise<void> | undefined;
  await executor.run({ task: task(directory), prompt: 'reply', signal: new AbortController().signal, beforeStart: async () => { assert.ok(session); assert.ok(!(await trace()).some(value => value.answered)); started = true; }, update: async value => { if (value.kind === 'session') session = value.threadId; if (value.kind === 'approval') { assert.ok(session); answer = new Promise<void>((resolve, reject) => setImmediate(() => { void executor.answer('acp-native-task', value.approval.id, 'acceptForSession', {}).then(resolve, reject); })); } } }); await answer;
  assert.ok(started); assert.equal((await trace()).find(value => value.answered).answered.outcome.optionId, 'exact-session');
});
test('ACP compact uses the advertised native command and cancellation reaps the actual process tree', async t => {
  const { executor, runtime, directory, trace } = await setup(t, 1, { ACP_TEST_STUBBORN_CHILD: '1' });
  await executor.run({ task: task(directory), prompt: 'not compact context', command: 'compact', signal: new AbortController().signal, update: async () => {} }); assert.ok((await trace()).some(value => value.prompt === '/compress'));
  const controller = new AbortController(), running = executor.run({ task: task(directory), prompt: 'hold', signal: controller.signal, update: async () => {} }); void running.catch(() => {}); await until(async () => (await trace()).some(value => value.child)); const child = (await trace()).find(value => value.child).child; controller.abort(); await assert.rejects(running, /已中止/); await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
  runtime.compactCommand = undefined; await assert.rejects(executor.run({ task: task(directory), prompt: '', command: 'compact', signal: new AbortController().signal, update: async () => {} }), /未声明/);
});
