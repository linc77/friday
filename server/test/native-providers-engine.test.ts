import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { nativeProviderDefaults, type NativeProvider } from '../src/native-provider-config.js';
import { compactTask } from '../src/task-compaction.js';
import { terminalProviderEnvironment } from '../src/terminal-provider-environment.js';
const sdkModule = fileURLToPath(new URL('./fixtures/cursor-sdk.cjs', import.meta.url));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const end = Date.now() + 12000; for (;;) { const value = await read(); if (ready(value)) return value; if (Date.now() > end) throw new Error('Native Durable fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: NativeProvider) {
  const root = await mkdtemp(join(tmpdir(), 'friday-native-engine-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), wire = join(root, 'wire.jsonl'); await mkdir(cwd);
  const open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }, { cursor: { sdkModule } }).open(); let engine: Engine | undefined = await open();
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  const connection = provider === 'cursor' ? engine.cursorConnection : provider === 'muse' ? engine.museConnection : engine.opencodeConnection;
  const binary = fileURLToPath(new URL(`./fixtures/${provider}.mjs`, import.meta.url)); if (provider !== 'cursor') await chmod(binary, 0o755);
  await connection.save({ ...nativeProviderDefaults(provider), enabled: true, ...(provider === 'cursor' ? {} : { binaryPath: binary }), environment: Object.entries(provider === 'cursor' ? { CURSOR_API_KEY: 'fixture-native-key', CURSOR_TEST_WIRE: wire } : provider === 'muse' ? { MUSE_TEST_WIRE: wire, MUSE_TEST_HOME: join(root, 'muse') } : { OPENCODE_TEST_WIRE: wire, OPENCODE_TEST_GENERATION: '2' }).map(([name, value]) => ({ name, value })) });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Native fixture', path: cwd, context: '' }]; });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, cwd, wire, trace, connection: () => provider === 'cursor' ? engine!.cursorConnection : provider === 'muse' ? engine!.museConnection : engine!.opencodeConnection, current: () => engine!, close: async () => { await engine!.close(); engine = undefined; }, reopen: async () => engine = await open() };
}
for (const provider of ['cursor', 'muse'] as const) test(`${provider} native subagents persist navigable child output, inherit the exact instance and remain isolated after restart`, async t => {
  const f = await setup(t, provider); let engine = f.current();
  const id = await engine.createTask({ agent: provider, projectId: 'project', mode: 'code', prompt: 'children', requestId: 'native-children' });
  let state = await until(() => engine.snapshot(), state => state.tasks.some(task => task.id === id && ['completed', 'failed'].includes(task.status)));
  const root = state.tasks.find(task => task.id === id)!; assert.equal(root.status, 'completed', root.error ?? ''); assert.equal(root.subagents?.length, 1);
  const metadata = root.subagents![0]!, child = state.tasks.find(task => task.id === metadata.childTaskId)!;
  assert.equal(metadata.status, 'completed'); assert.equal(child.providerInstanceId, root.providerInstanceId);
  assert.equal(child.subagentOrigin?.rootTaskId, id); assert.equal(child.subagentOrigin?.sessionId, root.executionSessionId);
  assert.ok(child.result.includes(provider === 'cursor' ? 'Final child answer' : 'Muse child result'));
  assert.ok(child.messages!.some(message => message.role === 'assistant' && message.text === child.result));
  assert.equal(child.threadId, null, 'A projected child is not an executable native session takeover');
  await assert.rejects(engine.createTask({ agent: provider, projectId: 'project', mode: 'code', prompt: 'do not take over', continueId: child.id, requestId: 'illegal-child' }), /子|父/);
  await f.close(); engine = await f.reopen(); state = await engine.snapshot();
  assert.equal(state.tasks.find(task => task.id === child.id)!.result, child.result);
  assert.equal(state.tasks.find(task => task.id === id)!.subagents![0]!.id, metadata.id);
});
for (const provider of ['cursor', 'muse', 'opencode'] as const) {
  test(`${provider} Durable tasks persist native identity, deduplicate create/compact and continue the same session after a service restart`, async t => {
    const fixture = await setup(t, provider); let engine = fixture.current();
    const input = { prompt: 'reply', title: 'Native fixture', projectId: 'project', mode: 'code' as const, agent: provider, requestId: 'native-create' };
    const id = await engine.createTask(input), terminal = () => until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => ['completed', 'failed', 'interrupted'].includes(value.status));
    let task = await terminal(); assert.equal(task.status, 'completed', task.error ?? 'Task failed'); const native = task.threadId; assert.ok(native && task.nativeProviderAccount); assert.equal(await engine.createTask(input), id);
    const prompts = (records: any[]) => records.filter(value => provider === 'cursor' ? value.sent : value.prompt).length; const before = prompts(await fixture.trace()); assert.equal(before, 1);
    await compactTask(engine, id, { requestId: 'compact', threadId: native }); task = await terminal(); assert.equal(task.status, 'completed', task.error ?? 'Compaction failed'); assert.equal(task.threadId, native); await compactTask(engine, id, { requestId: 'compact', threadId: native });
    assert.equal(prompts(await fixture.trace()), provider === 'muse' ? before : before + 1);
    await fixture.close(); engine = await fixture.reopen(); await engine.createTask({ ...input, continueId: id, requestId: 'native-continue', prompt: 'continue' }); task = await terminal(); assert.equal(task.status, 'completed', task.error ?? 'Continuation failed'); assert.equal(task.threadId, native);
    assert.ok(await terminalProviderEnvironment(fixture.directory, task));
    if (provider === 'muse') await assert.rejects(engine.createTask({ ...input, requestId: 'plan', interactionMode: 'plan' }), /计划模式/);
  });
  test(`${provider} API protects settings from devices and active runs, and cancellation stops the native tool child`, async t => {
    const fixture = await setup(t, provider), engine = fixture.current(), auth = new Auth(fixture.directory); t.after(async () => auth.close()); const api = createAPI(engine, auth, () => []), headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
    const device = auth.pair(auth.createPairing().code, 'fixture-device', '127.0.0.1'), paired = { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, endpoint = '/api/agents/' + provider;
    assert.equal((await api.request(endpoint)).status, 401); const state = await (await api.request(endpoint, { headers })).json(); assert.equal(state.connected, true); assert.ok(!JSON.stringify(state).includes('fixture-native-key')); assert.equal((await (await api.request(endpoint, { headers: paired })).json()).settings, null);
    assert.equal((await api.request(endpoint + '/settings', { method: 'PUT', headers: paired, body: JSON.stringify(state.settings) })).status, 403);
    if (provider === 'cursor') assert.equal((await api.request(endpoint + '/login', { method: 'POST', headers: paired, body: '{}' })).status, 403);
    const created = await api.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ prompt: 'hold', title: 'Native fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'native-hold' }) }); assert.equal(created.status, 201); const id = (await created.json()).id;
    const records = await until(fixture.trace, values => values.some(value => value.child)), child = records.find(value => value.child).child;
    assert.equal((await api.request(endpoint + '/settings', { method: 'PUT', headers, body: JSON.stringify(state.settings) })).status, 409);
    if (provider === 'cursor') {
      for (let index = 0; index < 2; index++) assert.equal((await api.request(`/api/tasks/${id}/message`, { method: 'POST', headers, body: JSON.stringify({ text: 'next', dispatchMode: 'steer', requestId: 'queue' }) })).status, 200);
      const task = (await engine.snapshot()).tasks.find(value => value.id === id)!; assert.equal(task.canSteer, false); assert.equal(task.queue?.messages.length, 1); assert.equal(task.queue?.messages[0]?.status, 'queued');
    }
    await engine.cancel(id); assert.equal((await engine.snapshot()).tasks.find(value => value.id === id)!.status, 'cancelled');
    await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } }, Boolean);
    if (provider === 'cursor') { await engine.taskQueue.resume(id, 'resume'); const task = await until(async () => (await engine.snapshot()).tasks.find(value => value.id === id)!, value => value.status === 'completed' && value.queue?.dispatcherId === null); assert.equal(task.queue?.messages[0]?.status, 'completed'); }
  });
  test(`${provider} an actual service crash never replays uncertain native work and preserves explicit continuation`, { timeout: 25000 }, async t => {
    const fixture = await setup(t, provider); await fixture.close();
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./fixtures/native-providers-engine-crash.ts', import.meta.url)), fixture.directory, fixture.wire, provider, sdkModule], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000), code = await new Promise<number | null>(resolve => child.once('exit', resolve)); clearTimeout(timer); assert.equal(code, 93);
    const records = await fixture.trace(), native = records.find(value => provider === 'cursor' ? value.sent === 'hold' : value.prompt === 'hold');
    const pid = provider === 'muse' ? records.find(value => value.child).pid : native.pid; if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
    const engine = await fixture.reopen(), task = await until(async () => (await engine.snapshot()).tasks[0]!, value => value.status === 'interrupted'); assert.ok(task.threadId && task.nativeProviderAccount); assert.match(task.error ?? '', /服务曾中断/);
    assert.equal((await fixture.trace()).filter(value => provider === 'cursor' ? value.sent === 'hold' : value.prompt === 'hold').length, 1);
    await engine.createTask({ continueId: task.id, prompt: 'reply', title: 'Native fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'explicit-continue' });
    const continued = await until(async () => (await engine.snapshot()).tasks[0]!, value => ['completed', 'failed'].includes(value.status)); assert.equal(continued.status, 'completed', continued.error ?? 'Continuation failed'); assert.equal(continued.threadId, task.threadId);
  });
}
