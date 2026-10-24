import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { OpenCodeConnection } from '../src/opencode-provider.js';
import { OpenCodeExecutor } from '../src/opencode.js';
import { openCodeGeneration, probeOpenCodeServer } from '../src/opencode-server.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
// @ts-expect-error Independent JavaScript HTTP fixture, never production code.
import { openCodeFixture } from './fixtures/opencode.mjs';
const task = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'opencode-task', agent: 'opencode', cwd, model: 'native/model', reasoningEffort: 'high', threadId: null, currentRunId: 'opencode-run', interactionMode: 'default', events: [], approvals: [], ...changes }) as WorkItem;
async function setup(t: { after(fn: () => Promise<unknown>): void }, generation: 1 | 2, local = false) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-opencode-')), fixture = local ? undefined : await openCodeFixture({ generation, directory }), wire = join(directory, 'wire.jsonl'), connection = new OpenCodeConnection(directory), executor = new OpenCodeExecutor(connection);
  const binary = fileURLToPath(new URL('./fixtures/opencode.mjs', import.meta.url)); await chmod(binary, 0o755);
  t.after(async () => { await executor.close(); await fixture?.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...nativeProviderDefaults('opencode'), enabled: true, binaryPath: binary, ...(fixture ? { serverUrl: fixture.url, serverPassword: '私有密码' } : {}), environment: [{ name: 'OPENCODE_TEST_GENERATION', value: String(generation) }, { name: 'OPENCODE_TEST_WIRE', value: wire }] });
  return { connection, executor, directory, fixture, trace: async () => fixture?.records ?? (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 6000; while (!await read()) { if (Date.now() > end) throw new Error('OpenCode fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
for (const generation of [1, 2] as const) test(`OpenCode ${generation} independent generation denies every native tool and allocates a separate session`, async t => {
  const fixture = await setup(t, generation);
  const result = await fixture.executor.generateText({ task: task(fixture.directory, { threadId: 'foreground', nativeProviderAccount: 'foreground-account' }), purpose: 'task_title', prompt: 'Title', signal: AbortSignal.timeout(5000), update: async () => {} });
  assert.ok(result.trim());
  const trace: any[] = await fixture.trace(), created = trace.find(value => value.method === 'POST' && value.path === (generation === 2 ? '/api/session' : '/session'));
  assert.ok(created);
  assert.deepEqual(generation === 2 ? created.body.permissions : created.body.permission, generation === 2 ? [{ action: '*', resource: '*', effect: 'deny' }] : [{ permission: '*', pattern: '*', action: 'deny' }]);
  assert.ok(!trace.some(value => value.path === '/session/foreground'));
});
for (const generation of [1, 2] as const) test(`OpenCode ${generation} uses its native task tool schema, preserves child identity and waits for the explicit background report`, async t => {
  const f = await setup(t, generation), updates: ExecutionUpdate[] = [];
  await f.executor.run({ task: task(f.directory), prompt: 'children', signal: AbortSignal.timeout(5000), update: async value => { updates.push(value); } });
  const children = updates.filter(value => value.kind === 'subagent'), child = children.at(-1)!;
  assert.equal(new Set(children.map(value => value.subagent.id)).size, 1); assert.equal(child.subagent.status, 'completed');
  assert.equal(child.subagent.title, 'Native OpenCode child'); assert.equal(child.subagent.result, 'OpenCode child result');
  if (generation === 2) { assert.ok(children.some(value => value.subagent.progress === 'Background child launch ACK' && value.subagent.status === 'running')); assert.ok(children.some(value => value.subagent.progress === 'OpenCode child stream')); }
});
test('OpenCode child session grants reply to the actual child and never become a parent session permission', async t => {
  const f = await setup(t, 2), controller = new AbortController(); let sessionId = '', approval: any;
  const running = f.executor.run({ task: task(f.directory), prompt: 'hold', signal: controller.signal, update: async value => { if (value.kind === 'session') sessionId = value.threadId; if (value.kind === 'approval') approval = value.approval; if (value.kind === 'subagent' && value.value?.kind === 'approval') approval = value.value.approval; } }); void running.catch(() => {});
  t.after(() => controller.abort());
  await until(async () => (await f.trace()).some((value: any) => value.prompt === 'hold'));
  const sent = (await f.trace()).find((value: any) => value.prompt === 'hold');
  f.fixture.emit('session.inbox.delivered', { sessionID: sessionId, inboxID: sent.nativeId });
  const runtime = await f.connection.runtime(), lease = await f.connection.server(runtime.settings, f.directory);
  t.after(() => lease.close());
  const child = await lease.server.v2!.session.create({ location: { directory: f.directory }, model: { providerID: 'native', id: 'model' } });
  f.fixture.emit('session.tool.input.started', { sessionID: sessionId, id: 'owned-child-tool', name: 'subagent' });
  f.fixture.emit('session.tool.called', { sessionID: sessionId, id: 'owned-child-tool', input: { prompt: 'Child prompt' } });
  f.fixture.emit('session.tool.progress', { sessionID: sessionId, id: 'owned-child-tool', metadata: { sessionID: child.id } });
  f.fixture.emit('permission.asked', { sessionID: child.id, id: 'child-permission', action: 'shell', resources: ['child-only'], save: ['child-only'] });
  await until(async () => !!approval); assert.ok(approval.subagentId); await f.executor.answer('opencode-task', approval.id, 'acceptForSession', {});
  approval = undefined; f.fixture.emit('permission.asked', { sessionID: sessionId, id: 'parent-permission', action: 'shell', resources: ['parent-only'], save: ['parent-only'] });
  await until(async () => !!approval); assert.equal(approval.subagentId, undefined); await f.executor.answer('opencode-task', approval.id, 'acceptForSession', {});
  const trace: any[] = await f.trace(), childUpdate = trace.find(value => value.method === 'PATCH' && value.path.endsWith('/' + child.id)), parentUpdate = trace.findLast(value => value.method === 'PATCH' && value.path.endsWith('/' + sessionId));
  assert.ok(childUpdate.body.permissions.some((value: any) => value.resource === 'child-only'));
  assert.ok(!parentUpdate.body.permissions.some((value: any) => value.resource === 'child-only'));
  assert.ok(parentUpdate.body.permissions.some((value: any) => value.resource === 'parent-only'));
  controller.abort(); await assert.rejects(running, /已中止/);
});
for (const generation of [1, 2] as const) test(`OpenCode ${generation} verifies paginated native history, maps copied IDs and never repeats an uncertain history operation`, async t => {
  const f = await setup(t, generation), turns: string[] = []; let threadId = '', account = '';
  for (const id of ['one', 'two']) await f.executor.run({ task: task(f.directory, { currentRunId: id, threadId: threadId || null }), prompt: id, signal: AbortSignal.timeout(5000), update: async update => {
    if (update.kind === 'session') { threadId = update.threadId; account = update.nativeProviderAccount!; }
    if (update.kind === 'turn') turns.push(update.turnId);
  } });
  const source = task(f.directory, { threadId, nativeProviderAccount: account }); let started = false, candidate = '';
  const request = { task: source, run: { threadId, turnId: turns[0] }, expectedTurns: [turns[0]!], title: 'Fork', inspectOnly: false, signal: AbortSignal.timeout(5000), started: async () => { started = true; }, candidate: async (id: string) => { assert.ok(started); candidate = id; } };
  const fork = await f.executor.fork(request); assert.equal(fork.threadId, candidate); assert.notEqual(fork.threadId, threadId); assert.ok(fork.turnIds[turns[0]!]); assert.notEqual(fork.turnIds[turns[0]!], turns[0]);
  const count = () => f.trace().then((trace: any[]) => trace.filter(value => value.path?.endsWith('/fork')).length);
  const before = await count(); await f.executor.fork({ ...request, candidateId: candidate, inspectOnly: true, started: async () => assert.fail('cannot repeat fork') });
  await assert.rejects(f.executor.fork({ ...request, inspectOnly: true }), /不会重复创建/); assert.equal(await count(), before);
  let original: any, rewindCandidate = '';
  const rewind = { task: source, targetTurnId: turns[1]!, removeTurns: [turns[1]!], keepTurns: [turns[0]!], signal: AbortSignal.timeout(5000), started: async (value: any) => { original = value; }, candidate: async (value: string) => { assert.ok(original); rewindCandidate = value; } };
  const result = await f.executor.rewind(rewind); assert.equal(result.state, 'applied'); assert.equal(result.turns?.length, 1);
  if (generation === 1) { assert.equal(result.threadId, rewindCandidate); assert.ok(result.turnIds![turns[0]!]); assert.notEqual(result.turnIds![turns[0]!], turns[0]); }
  else { assert.equal(result.threadId, threadId); const stages = (await f.trace()).filter((value: any) => value.path?.endsWith('/revert/stage')); assert.equal(stages.length, 1); assert.equal(stages[0].body.files, false); }
  const beforeInspect = (await f.trace()).filter((value: any) => value.path?.endsWith('/fork') || value.path?.endsWith('/revert/commit')).length;
  assert.equal((await f.executor.rewind({ ...rewind, task: { ...source, threadId: result.threadId }, original, inspectOnly: true, started: async () => assert.fail('cannot repeat rewind') })).state, 'applied');
  assert.equal((await f.trace()).filter((value: any) => value.path?.endsWith('/fork') || value.path?.endsWith('/revert/commit')).length, beforeInspect);
  await assert.rejects(f.executor.rewind({ ...rewind, task: { ...source, nativeProviderAccount: 'another-account' } }), /账号配置/);
});
test('OpenCode version detection distinguishes real JSON health from a 1.x HTML fallback and uses UTF-8 Basic credentials', async t => {
  assert.equal(openCodeGeneration('opencode 1.14.19'), 1); assert.equal(openCodeGeneration('2.0.28'), 2); assert.throws(() => openCodeGeneration('1.14.18'), /1.14.19/);
  for (const generation of [1, 2] as const) { const f = await openCodeFixture({ generation }); t.after(() => f.close()); assert.equal((await probeOpenCodeServer(f.url, '私有密码')).generation, generation); await assert.rejects(probeOpenCodeServer(f.url, 'wrong'), /拒绝/); }
});
for (const generation of [1, 2] as const) {
  test(`OpenCode ${generation}.x official SDK subscribes before dispatch, fences foreign output, persists its session and resumes without creating a replacement`, async t => {
    const { connection, executor, directory, trace } = await setup(t, generation), updates: ExecutionUpdate[] = []; let sessionId = '', account = '';
    assert.deepEqual((await connection.status()).models.map(value => value.id), ['native/model']); assert.ok(!JSON.stringify(await connection.status(true)).includes('私有密码'));
    const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'session') { sessionId = value.threadId; account = value.nativeProviderAccount!; } };
    const result = await executor.run({ task: task(directory), prompt: 'reply', signal: new AbortController().signal, update, beforeStart: async () => { assert.ok(sessionId && account); assert.ok(!(await trace()).some((r: any) => r.prompt)); } });
    assert.equal(result, 'OpenCode reply café\u2028line\u2029end'); assert.ok(updates.some(value => value.kind === 'ready' && value.canSteer === (generation === 2))); assert.ok(updates.some(value => value.kind === 'contextUsage' && value.usage?.usedTokens === 21)); if (generation === 2) assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.text === 'printf fixture' && value.item.detail === 'native command output'));
    assert.ok((await trace()).filter((r: any) => r.path === (generation === 2 ? '/api/session' : '/session') && r.method === 'POST').every((r: any) => r.subscribed));
    const native = sessionId; await executor.run({ task: task(directory, { threadId: native, nativeProviderAccount: account, currentRunId: 'next' }), prompt: 'continue', signal: new AbortController().signal, update }); assert.equal(sessionId, native);
    const created = (await trace()).filter((r: any) => r.path === (generation === 2 ? '/api/session' : '/session') && r.method === 'POST').length;
    await assert.rejects(executor.run({ task: task(directory, { threadId: 'ses_missing' }), prompt: 'continue', signal: new AbortController().signal, update })); assert.equal((await trace()).filter((r: any) => r.path === (generation === 2 ? '/api/session' : '/session') && r.method === 'POST').length, created);
  });
  test(`OpenCode ${generation}.x permissions keep native choices and question/form answers reach the original endpoint`, async t => {
    const { executor, directory, trace } = await setup(t, generation); let approval: any;
    const run = (prompt: string) => executor.run({ task: task(directory), prompt, signal: new AbortController().signal, update: async value => { if (value.kind === 'approval') approval = value.approval; } });
    let result = run('permission'); await until(async () => !!approval); assert.deepEqual(approval.decisions, ['cancel', 'decline', 'acceptForSession', 'accept']); await executor.answer('opencode-task', approval.id, 'acceptForSession', {}); await result;
    assert.ok((await trace()).some((r: any) => r.body?.reply === 'always' || r.body?.decision === 'once'));
    approval = undefined; result = run(generation === 1 ? 'question' : 'form'); await until(async () => !!approval); await executor.answer('opencode-task', approval.id, 'accept', { [generation === 1 ? 'q0' : 'choice']: ['First'] }); await result;
    assert.ok((await trace()).some((r: any) => generation === 1 ? r.body?.answers?.[0]?.[0] === 'First' : r.body?.answer?.choice === 'native-first'));
  });
}
test('OpenCode 2.x Steer waits for native inbox delivery and deduplicates request IDs; disconnect fails instead of replaying a prompt', async t => {
  const { executor, directory, trace } = await setup(t, 2), controller = new AbortController();
  const running = executor.run({ task: task(directory), prompt: 'hold', signal: controller.signal, update: async () => {} }); void running.catch(() => {});
  await until(async () => (await trace()).some((r: any) => r.prompt === 'hold')); const start = Date.now();
  await Promise.all([executor.steer('opencode-task', 'next', 'same'), executor.steer('opencode-task', 'next', 'same')]); assert.ok(Date.now() - start >= 25); assert.equal((await trace()).filter((r: any) => r.body?.delivery === 'steer').length, 1);
  controller.abort(); await assert.rejects(running, /已中止/);
  await assert.rejects(executor.run({ task: task(directory), prompt: 'disconnect', signal: new AbortController().signal, update: async () => {} }), /连接已关闭/); assert.equal((await trace()).filter((r: any) => r.prompt === 'disconnect').length, 1);
});
test('Owned OpenCode 1.x/2.x servers install the real HTTP MCP connection, compact natively and release their tool process groups on cancellation', async t => {
  const calls: any[] = [], mcp = createServer(async (req, res) => { let data = ''; for await (const chunk of req) data += chunk; calls.push({ authorization: req.headers.authorization, body: JSON.parse(data) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } })); });
  await new Promise<void>(resolve => mcp.listen(0, '127.0.0.1', resolve)); t.after(async () => { mcp.closeAllConnections(); await new Promise<void>(resolve => mcp.close(() => resolve())); }); const port = (mcp.address() as any).port;
  for (const generation of [1, 2] as const) {
    const { executor, directory, trace } = await setup(t, generation, true); let sessionId = '';
    const request = { task: task(directory), signal: new AbortController().signal, update: async (value: ExecutionUpdate) => { if (value.kind === 'session') sessionId = value.threadId; } };
    await executor.run({ ...request, prompt: 'mcp', taskMcp: { url: `http://127.0.0.1:${port}`, headers: { Authorization: 'Bearer fixture-mcp-secret' } } as any });
    await executor.run({ ...request, task: task(directory, { threadId: sessionId }), prompt: 'must not be sent', command: 'compact' }); assert.ok((await trace()).some((r: any) => r.path?.endsWith(generation === 2 ? '/compact' : '/summarize')));
    const controller = new AbortController(), running = executor.run({ ...request, task: task(directory, { threadId: sessionId }), prompt: 'hold', signal: controller.signal }); void running.catch(() => {}); await until(async () => (await trace()).some((r: any) => r.child)); const child = (await trace()).find((r: any) => r.child).child; controller.abort(); await assert.rejects(running, /已中止/); await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
  }
  assert.equal(calls.length, 2); assert.ok(calls.every(value => value.authorization === 'Bearer fixture-mcp-secret' && value.body.params.arguments.text === 'native-mcp'));
});
