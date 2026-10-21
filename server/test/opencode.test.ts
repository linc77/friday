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
