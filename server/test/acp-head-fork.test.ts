import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { acpProviderDefaults } from '../src/acp-provider-settings.js';
import { defaultGrokSettings } from '../src/grok-provider.js';
import type { WorkItem } from '../src/types.js';
import type { TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) { const deadline = Date.now() + 12_000; for (;;) { const value = await read(); if (ready(value)) return value; assert.ok(Date.now() < deadline, 'Head fork fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
async function fixture(t: { after(fn: () => Promise<void>): void }, generation: 1 | 2, provider: 'acp-registry' | 'grok' = 'acp-registry', extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'friday-head-fork-')), directory = join(root, 'data'), cwd = join(root, 'workspace'), home = join(root, 'sessions'), wire = join(root, 'wire.jsonl'); await mkdir(cwd);
  const binaryPath = fileURLToPath(new URL(provider === 'grok' ? './fixtures/grok.mjs' : './fixtures/acp-native.mjs', import.meta.url)); await chmod(binaryPath, 0o755);
  const open = () => new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open(); let engine: Engine | undefined = await open(), id = '', rounds = 0;
  t.after(async () => { await engine?.close(); await rm(root, { recursive: true, force: true }); });
  if (provider === 'grok') await engine.grokConnection.save({ ...defaultGrokSettings, enabled: true, binaryPath, homePath: home, environment: Object.entries({ GROK_TEST_PROTOCOL: String(generation), GROK_TEST_FORK: '1', GROK_TEST_WIRE: wire, ...extra }).map(([name, value]) => ({ name, value })) });
  else { const defaults = acpProviderDefaults(provider); await engine.acpRegistryConnection.save({ ...defaults, enabled: true, binaryPath, nativeConfig: { ...defaults.nativeConfig, source: 'local' }, environment: Object.entries({ ACP_TEST_GENERATION: String(generation), ACP_TEST_FORK: '1', ACP_TEST_WIRE: wire, ACP_TEST_HOME: home, ...extra }).map(([name, value]) => ({ name, value })) }); }
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Head fork', path: cwd, context: '' }]; });
  const task = async (taskId = id) => (await engine!.snapshot()).tasks.find(task => task.id === taskId)!, wait = (taskId: string, ready: (task: WorkItem) => boolean) => until(() => task(taskId), task => !!task && ready(task));
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const auth = new Auth(directory); t.after(async () => { auth.close(); });
  return { current: () => engine!, task, wait, trace, cwd, provider,
    start: async (text: string, target = id) => { const taskId = await engine!.createTask({ ...(target ? { continueId: target } : {}), projectId: 'project', title: 'Head fork fixture', mode: 'code', agent: provider, prompt: text, requestId: 'human-' + ++rounds }); if (!id) id = taskId; return wait(taskId, task => task.status === 'completed' || task.status === 'failed'); },
    api: () => createAPI(engine!, auth, () => []), headers: { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' },
    native: async (nativeId: string) => JSON.parse(await readFile(provider === 'grok' ? join(home, 'sessions', nativeId + '.json') : join(home, nativeId), 'utf8')),
    reopen: async () => { await engine!.close(); engine = undefined; engine = await open(); } };
}
for (const generation of [1, 2] as const) test(`ACP ${generation} head fork is negotiated, locks new source input, copies full native context and admits task tools only in the target's later real run`, async t => {
  const f = await fixture(t, generation, 'acp-registry', { ACP_TEST_FORK_MCP: '1', ...(generation === 1 ? { ACP_TEST_NO_RESUME: '1' } : {}) });
  const first = await f.start('first'), source = await f.start('second'); assert.equal(source.status, 'completed', source.error ?? ''); assert.equal(source.nativeHeadForkSupported, true);
  const original = await f.native(source.threadId!); assert.deepEqual(original.messages, ['first', 'second']);
  const engine = f.current(), originalFork = engine.executor.fork!.bind(engine.executor); let entered!: () => void, release!: () => void;
  const entering = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  engine.executor.fork = request => originalFork({ ...request, started: async () => { await request.started(); entered(); await gate; } });
  const path = '/api/tasks/' + source.id + '/fork-head'; assert.equal((await f.api().request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"requestId":"head"}' })).status, 401);
  const response = await f.api().request(path, { method: 'POST', headers: f.headers, body: '{"requestId":"head"}' }); assert.equal(response.status, 202); const target = (await response.json()).id;
  try {
    await entering; assert.equal((await f.task()).nativeHeadForkPending, true);
    await assert.rejects(f.start('cannot-race'), /分叉/);
  } finally { release(); }
  const fork = await f.wait(target, task => task.forkOperation?.status === 'completed'); assert.notEqual(fork.threadId, source.threadId); assert.equal(fork.runs!.length, source.runs!.length);
  assert.equal((await f.task()).nativeHeadForkPending, false); assert.deepEqual((await f.native(fork.threadId!)).messages, original.messages);
  const before = (await f.trace()).find(value => value.taskTool === 'before-admission'); assert.equal(before.status, 200); assert.equal(before.body.result.isError, true);
  const continued = await f.start('mcp', target); assert.equal(continued.status, 'completed', continued.error ?? '');
  const admitted = (await f.trace()).find(value => value.taskTool === 'admitted'); assert.equal(admitted.body.result.isError, false);
  assert.deepEqual((await f.native(source.threadId!)).messages, ['first', 'second']); assert.deepEqual((await f.native(fork.threadId!)).messages, ['first', 'second', 'mcp']);
  const trace = await f.trace(), nativeFork = trace.find(value => value.method === 'session/fork'), targetPrompt = trace.find(value => value.prompt === 'mcp'); assert.equal(targetPrompt.pid, nativeFork.pid);
  assert.ok(!trace.some(value => ['session/load', 'session/resume'].includes(value.method) && value.params.sessionId === fork.threadId), 'The forked native runtime remains owned, including a v1 agent without resume');
  const replay = await f.api().request(path, { method: 'POST', headers: f.headers, body: '{"requestId":"head"}' }); assert.equal((await replay.json()).id, target); assert.equal((await f.trace()).filter(value => value.method === 'session/fork').length, 1);
  const portable = await engine.taskForks.start(source.id, { runId: first.runs![0]!.id, requestId: 'old-reply' }); const visible = await f.wait(portable, task => task.forkOperation?.status === 'completed'); assert.equal(visible.forkOperation!.strategy, 'visible_history'); assert.equal(visible.threadId, null);
});
for (const generation of [1, 2] as const) test(`Grok ${generation} explicit native head fork preserves its source and resumes the fork's actual native session`, async t => {
  const f = await fixture(t, generation, 'grok'), source = await f.start('source'); assert.equal(source.nativeHeadForkSupported, true);
  const target = await f.current().taskForks.head(source.id, { requestId: 'grok-head' }), fork = await f.wait(target, task => task.forkOperation?.status === 'completed');
  assert.deepEqual((await f.native(fork.threadId!)).messages, ['source']); const continued = await f.start('fork continuation', target); assert.equal(continued.status, 'completed', continued.error ?? '');
  assert.deepEqual((await f.native(source.threadId!)).messages, ['source']); assert.deepEqual((await f.native(fork.threadId!)).messages, ['source', 'fork continuation']);
  assert.equal((await f.trace()).filter(value => value.method === 'session/fork').length, 1);
});
test('A lost native head-fork acknowledgement survives service close without a second fork; explicit visible-history recovery releases the source', async t => {
  const f = await fixture(t, 2, 'acp-registry', { ACP_TEST_FORK_NO_ACK: '1' }), source = await f.start('source'), target = await f.current().taskForks.head(source.id, { requestId: 'lost-head' });
  await until(f.trace, values => values.some(value => value.nativeFork)); await f.reopen();
  await f.current().harness.waitForTask((await f.task(target)).forkOperation!.durableId as TaskId, BACKGROUND_CONTEXT);
  await f.wait(target, task => ['failed', 'interrupted'].includes(task.forkOperation?.status ?? ''));
  assert.equal((await f.trace()).filter(value => value.method === 'session/fork').length, 1); assert.equal((await f.task()).nativeHeadForkPending, true);
  await f.current().taskForks.resolve(target, { requestId: 'recover-visible', action: 'new_session' }); await f.wait(target, task => task.forkOperation?.status === 'completed');
  assert.equal((await f.task()).nativeHeadForkPending, false); assert.equal((await f.trace()).filter(value => value.method === 'session/fork').length, 1);
});
