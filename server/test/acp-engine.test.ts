import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { acpProviderDefaults, type AcpProviderID } from '../src/acp-provider-settings.js';
import { AcpRegistryCatalog, acpRegistryTarget } from '../src/acp-registry-catalog.js';
import { ManagedProviderTools } from '../src/managed-provider-tools.js';
import { compactTask } from '../src/task-compaction.js';
import { terminalProviderEnvironment } from '../src/terminal-provider-environment.js';
const binary = fileURLToPath(new URL('./fixtures/acp-native.mjs', import.meta.url));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const end = Date.now() + 15000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > end) throw new Error('ACP Durable fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: AcpProviderID) {
  const root = await mkdtemp(join(tmpdir(), 'friday-acp-engine-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), wire = join(root, 'wire.jsonl'); await mkdir(cwd); await chmod(binary, 0o755); const bytes = await readFile(binary);
  const registry = new AcpRegistryCatalog(directory, { fetch: (async () => new Response(JSON.stringify({ version: '1.0.0', agents: [{ id: 'fixture', version: '1.2.3', name: 'Native fixture', description: 'Independent ACP protocol', distribution: { binary: { [acpRegistryTarget()!]: { archive: 'https://fixture.test/agent.bin', cmd: 'agent.mjs', sha256: createHash('sha256').update(bytes).digest('hex') } } } }] }))) as typeof fetch });
  const tools = new ManagedProviderTools(directory, { fetch: (async () => new Response(bytes)) as typeof fetch }); let first = true;
  const open = () => { const options = first ? { acpRegistry: { registry, tools } } : { acpRegistry: { registry, tools: new ManagedProviderTools(directory) } }; first = false; return new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }, options).open(); }; let engine: Engine | undefined = await open();
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); }); const connection = provider === 'antigravity' ? engine.antigravityConnection : engine.acpRegistryConnection, defaults = acpProviderDefaults(provider);
  await connection.save({ ...defaults, enabled: true, binaryPath: provider === 'antigravity' ? binary : defaults.binaryPath, nativeConfig: { ...defaults.nativeConfig, registryAgentId: 'fixture', harnessPath: binary, authMethod: 'gemini-api-key', apiKey: 'fixture-acp-engine-secret' }, environment: [{ name: 'ACP_TEST_WIRE', value: wire }, { name: 'ACP_TEST_HOME', value: join(root, 'sessions') }] });
  if (provider === 'acp-registry') await connection.prepare(); await engine.mutate(state => { state.projects = [{ id: 'project', name: 'ACP fixture', path: cwd, context: '' }]; });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, cwd, wire, trace, current: () => engine!, close: async () => { await engine!.close(); engine = undefined; }, reopen: async () => engine = await open() };
}
for (const provider of ['acp-registry', 'antigravity'] as const) {
  test(`${provider} Durable task identity and native compaction are deduplicated and survive restart`, async t => {
    const fixture = await setup(t, provider); let engine = fixture.current(); const input = { prompt: 'reply', title: 'ACP fixture', projectId: 'project', mode: 'code' as const, agent: provider, model: 'other-model', reasoningEffort: 'high', interactionMode: 'plan' as const, requestId: 'native-create' };
    const id = await engine.createTask(input), done = () => until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => ['completed', 'failed', 'interrupted'].includes(value.status)); let task = await done(); assert.equal(task.status, 'completed', task.error ?? 'Failed'); const thread = task.threadId; assert.ok(thread && task.nativeProviderAccount); assert.equal(task.result, 'ACP reply café\u2028line\u2029end'); assert.equal(await engine.createTask(input), id);
    assert.equal((await fixture.trace()).filter(value => value.prompt).length, 1); await compactTask(engine, id, { requestId: 'compact', threadId: thread }); task = await done(); assert.equal(task.status, 'completed', task.error ?? 'Compact failed'); await compactTask(engine, id, { requestId: 'compact', threadId: thread }); assert.equal((await fixture.trace()).filter(value => value.prompt === '/compress').length, 1);
    await fixture.close(); engine = await fixture.reopen(); await engine.createTask({ ...input, continueId: id, requestId: 'continue', prompt: 'continue' }); task = await done(); assert.equal(task.status, 'completed', task.error ?? 'Continuation failed'); assert.equal(task.threadId, thread); const env = await terminalProviderEnvironment(fixture.directory, task); if (provider === 'antigravity') assert.ok(env.GEMINI_HOME && env.GEMINI_API_KEY === 'fixture-acp-engine-secret'); else assert.ok(env.PATH?.includes('/tools/acp-fixture/versions/'));
  });
  test(`${provider} authenticated APIs preserve settings privacy, lock running tasks and retain forced Steer as one queued message`, async t => {
    const fixture = await setup(t, provider), engine = fixture.current(), auth = new Auth(fixture.directory); t.after(async () => auth.close()); const api = createAPI(engine, auth, () => []), headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, paired = { Authorization: `Bearer ${auth.pair(auth.createPairing().code, 'device', '127.0.0.1').token}`, 'Content-Type': 'application/json' }, endpoint = '/api/agents/' + provider;
    assert.equal((await api.request(endpoint)).status, 401); const status = await (await api.request(endpoint, { headers })).json(); assert.equal(status.connected, true); assert.ok(!JSON.stringify(status).includes('fixture-acp-engine-secret')); assert.equal((await (await api.request(endpoint, { headers: paired })).json()).settings, null);
    for (const path of ['/settings', '/login', '/install']) assert.equal((await api.request(endpoint + path, { method: path === '/settings' ? 'PUT' : 'POST', headers: paired, body: '{}' })).status, 403);
    assert.equal((await api.request(endpoint + '/install', { headers: paired })).status, 403);
    if (provider === 'acp-registry') { const results = await (await api.request(endpoint + '/registry/search', { method: 'POST', headers, body: '{"query":"fixture"}' })).json(); assert.equal(results.agents[0]?.id, 'fixture'); }
    const id = await engine.createTask({ prompt: 'hold', title: 'ACP fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'hold' }); const records = await until(fixture.trace, values => values.some(value => value.child)), child = records.find(value => value.child).child;
    for (const path of ['/settings', '/login', '/install']) assert.equal((await api.request(endpoint + path, { method: path === '/settings' ? 'PUT' : 'POST', headers, body: JSON.stringify(status.settings) })).status, 409);
    for (let attempt = 0; attempt < 2; attempt++) assert.equal((await api.request(`/api/tasks/${id}/message`, { method: 'POST', headers, body: '{"text":"next","dispatchMode":"steer","requestId":"queue"}' })).status, 200);
    let task = (await engine.snapshot()).tasks.find(value => value.id === id)!; assert.equal(task.canSteer, false); assert.equal(task.queue?.messages.length, 1); await engine.cancel(id); await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
    await engine.taskQueue.resume(id, 'resume'); task = await until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => ['completed', 'failed'].includes(value.status) && value.queue?.dispatcherId === null); assert.equal(task.status, 'completed', task.error ?? 'Queue failed'); assert.equal(task.queue?.messages[0]?.status, 'completed');
  });
  test(`${provider} a real service crash retains native session identity without replaying its uncertain prompt`, { timeout: 25000 }, async t => {
    const fixture = await setup(t, provider); await fixture.close();
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./fixtures/acp-engine-crash.ts', import.meta.url)), fixture.directory, fixture.wire, provider], { stdio: 'ignore' }); const timer = setTimeout(() => child.kill('SIGKILL'), 15000), code = await new Promise<number | null>(resolve => child.once('exit', resolve)); clearTimeout(timer); assert.equal(code, 93);
    const records = await fixture.trace(), native = records.find(value => value.prompt === 'hold'); assert.ok(native?.pid); try { process.kill(-native.pid, 'SIGTERM'); } catch {}
    const engine = await fixture.reopen(), task = await until(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'interrupted'); assert.ok(task.threadId && task.nativeProviderAccount); assert.match(task.error ?? '', /服务曾中断/); assert.equal((await fixture.trace()).filter(value => value.prompt === 'hold').length, 1);
    await engine.createTask({ continueId: task.id, prompt: 'reply', title: 'ACP fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'explicit' }); const resumed = await until(async () => (await engine.snapshot()).tasks[0]!, value => ['completed', 'failed'].includes(value.status)); assert.equal(resumed.status, 'completed', resumed.error ?? 'Failed'); assert.equal(resumed.threadId, task.threadId);
  });
}
