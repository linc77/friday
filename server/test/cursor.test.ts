import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { CursorConnection, cursorModels } from '../src/cursor-provider.js';
import { CursorExecutor } from '../src/cursor.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
const sdkModule = fileURLToPath(new URL('./fixtures/cursor-sdk.cjs', import.meta.url));
const task = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'cursor-task', agent: 'cursor', cwd, model: 'native-model', reasoningEffort: 'high', threadId: null, currentRunId: 'cursor-run', interactionMode: 'default', events: [], approvals: [], ...changes }) as WorkItem;
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, environment: Record<string, string> = {}, withKey = true) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-cursor-')), wire = join(directory, 'wire.jsonl'), connection = new CursorConnection(directory, { sdkModule }), executor = new CursorExecutor(connection);
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...nativeProviderDefaults('cursor'), enabled: true, environment: Object.entries({ CURSOR_TEST_WIRE: wire, ...(withKey ? { CURSOR_API_KEY: 'fixture-cursor-private' } : {}), ...environment }).map(([name, value]) => ({ name, value })) });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, connection, executor, trace };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await read()) { if (Date.now() > end) throw new Error('Cursor fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('Cursor sends context and boolean model parameters using their native SDK IDs on both create and send', async t => {
  const fixture = await setup(t, { CURSOR_TEST_OPTIONS: '1' });
  const modelOptions = [{ id: 'contextWindow', value: 'expanded' }, { id: 'fastMode', value: false }];
  await fixture.executor.run({ task: task(fixture.directory, { modelOptions }), prompt: 'reply', signal: AbortSignal.timeout(5000), update: async () => {} });
  const trace = await fixture.trace(), created = trace.find(value => value.operation === 'create'), sent = trace.find(value => value.sent);
  const expected = [{ id: 'context', value: 'expanded' }, { id: 'fast', value: 'false' }, { id: 'effort', value: 'high' }];
  assert.deepEqual(created.options.model.params, expected); assert.deepEqual(sent.sendOptions.model.params, expected);
});
test('Cursor native Task lifecycle creates a scoped child, projects official conversation steps and rejects late partial resurrection', async t => {
  const f = await setup(t), updates: ExecutionUpdate[] = [];
  await f.executor.run({ task: task(f.directory), prompt: 'children', signal: AbortSignal.timeout(5000), update: async value => { updates.push(value); } });
  const children = updates.filter(value => value.kind === 'subagent');
  assert.ok(children.length >= 3); const last = children.at(-1)!;
  assert.equal(last.subagent.provider, 'cursor'); assert.equal(last.subagent.status, 'completed'); assert.equal(last.subagent.title, 'Native child');
  assert.equal(last.subagent.model, 'child-model'); assert.match(last.subagent.result!, /First child answer\nFinal child answer\nChild summary/);
  assert.ok(children.every(value => value.subagent.id === last.subagent.id && value.subagent.runId === 'cursor-run'));
  assert.ok(children.some(value => value.value?.kind === 'item' && value.value.item.text === 'Final child answer'));
  const session = updates.find(value => value.kind === 'session')!; assert.equal(last.sessionId, session.executionSessionId); assert.equal(last.threadId, session.threadId);
});
test('Cursor independent generation uses an empty disposable workspace, separate native state and no inherited settings or MCP', async t => {
  const fixture = await setup(t);
  const result = await fixture.executor.generateText({ task: task(fixture.directory, { threadId: 'foreground', nativeProviderAccount: 'foreground-account' }), purpose: 'task_title', prompt: 'Title', taskMcp: { url: 'http://forbidden.invalid', headers: {} }, signal: AbortSignal.timeout(5000), update: async () => {} });
  assert.ok(result.includes('Cursor'));
  const trace = await fixture.trace(), created = trace.find(value => value.operation === 'create'), store = trace.find(value => value.store);
  assert.ok(created); assert.equal(created.mcp, false); assert.deepEqual(created.options.settingSources, []); assert.equal(created.options.mode, 'plan'); assert.equal(created.options.autoReview, false);
  assert.notEqual(store.store.workspaceRef, fixture.directory); assert.notEqual(store.store.workspaceRef, store.store.stateRoot);
  await assert.rejects(stat(store.store.workspaceRef), { code: 'ENOENT' }); await assert.rejects(stat(store.store.stateRoot), { code: 'ENOENT' });
  assert.ok(!trace.some(value => value.operation === 'resume'));
});
test('The installed Cursor SDK exposes the pinned APIs and opens its real private SQLite store without contacting a model', async t => {
  const require = createRequire(import.meta.url), sdk = require('@cursor/sdk') as typeof import('@cursor/sdk'), sqlite = require('@cursor/sdk/sqlite') as typeof import('@cursor/sdk/sqlite');
  assert.equal(typeof sdk.Agent.create, 'function'); assert.equal(typeof sdk.Agent.resume, 'function'); assert.equal(typeof sdk.Cursor.auth.login, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'friday-cursor-store-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await sqlite.SqliteLocalAgentStore.open({ stateRoot: join(directory, 'state'), workspaceRef: directory }); await store.dispose(); assert.ok((await stat(join(directory, 'state'))).isDirectory());
});
test('Cursor SDK catalog keeps native effort parameter IDs and credentials private, without creating an agent for discovery', async t => {
  const models = cursorModels([{ id: 'model', displayName: 'Model', parameters: [{ id: 'reasoning', values: [{ value: 'native-effort' }] }], variants: [{ isDefault: true, params: [{ id: 'reasoning', value: 'native-effort' }] }] }]); assert.equal(models[0]!.nativeEffortId, 'reasoning'); assert.equal(models[0]!.defaultReasoningEffort, 'native-effort');
  const { connection, trace } = await setup(t), owner = await connection.status(true); assert.equal(owner.connected, true); assert.equal(owner.account?.email, 'fixture@example.test'); assert.ok(!JSON.stringify(owner).includes('fixture-cursor-private'));
  assert.equal((await connection.status(false)).settings, null); assert.ok(!(await trace()).some(value => value.operation));
});
test('Cursor SDK worker saves the native session before sending, buffers synchronous deltas and resumes its original private store', async t => {
  const { executor, directory, trace } = await setup(t), updates: ExecutionUpdate[] = []; let sessionId = '', account = '';
  const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'session') { sessionId = value.threadId; account = value.nativeProviderAccount!; } };
  const result = await executor.run({ task: task(directory), prompt: 'reply', signal: new AbortController().signal, update, beforeStart: async () => { assert.ok(sessionId && account); assert.ok(!(await trace()).some(value => value.sent)); } });
  assert.equal(result, 'line\u2029end'); assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'message' && value.item.text === 'Cursor reply café\u2028')); assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.detail === 'native output' && value.item.exitCode === 0));
  assert.ok(updates.some(value => value.kind === 'ready' && value.canSteer === false)); const native = sessionId;
  await executor.run({ task: task(directory, { threadId: native, nativeProviderAccount: account }), prompt: 'continue', signal: new AbortController().signal, update }); assert.equal(sessionId, native);
  const records = await trace(); assert.ok(records.some(value => value.operation === 'resume' && value.agentId === native)); assert.deepEqual(records.find(value => value.sent).sendOptions.model, { id: 'native-model', params: [{ id: 'effort', value: 'high' }] });
});
test('Cursor native Plan and sandbox policy are passed to the SDK, compression sends its native command and failed resume never creates another agent', async t => {
  const { executor, connection, directory, trace } = await setup(t, { CURSOR_TEST_FAIL_RESUME: '1' }), owner = await connection.status(true); await connection.save({ ...owner.settings, permissionMode: 'fullAccess' }); let sessionId = '';
  await executor.run({ task: task(directory, { interactionMode: 'plan' }), prompt: 'reply', signal: new AbortController().signal, update: async value => { if (value.kind === 'session') sessionId = value.threadId; } });
  const opened = (await trace()).find(value => value.operation === 'create'); assert.equal(opened.options.mode, 'plan'); assert.equal(opened.options.fullAccess, true); assert.equal(opened.options.autoReview, false);
  await executor.run({ task: task(directory), prompt: 'Ignored compact context', command: 'compact', signal: new AbortController().signal, update: async () => {} }); assert.ok((await trace()).some(value => value.sent === '/compress'));
  const before = (await trace()).filter(value => value.operation === 'create').length;
  await assert.rejects(executor.run({ task: task(directory, { threadId: sessionId }), prompt: 'continue', signal: new AbortController().signal, update: async () => {} }), /Native Cursor agent not found/);
  assert.equal((await trace()).filter(value => value.operation === 'create').length, before);
});
test('Cursor browser login uses the SDK private store, returns only its login URL and makes no automatic browser launch', async t => {
  const { directory, connection, trace } = await setup(t, {}, false); assert.equal((await connection.status()).connected, false);
  const response = await connection.login(); assert.deepEqual(response, { url: 'https://cursor.fixture.test/login' });
  await until(async () => (await connection.status(false, true)).connected);
  assert.equal((await stat(join(directory, 'cursor', 'auth.json'))).mode & 0o777, 0o600); assert.equal((await trace()).find(value => value.login).openBrowser, false);
  assert.ok(!JSON.stringify(await connection.status(true)).includes('fixture-stored-key'));
});
test('Cursor cancellation waits for SDK ownership cleanup and terminates the real worker tool process group', async t => {
  const { directory, executor, trace } = await setup(t), controller = new AbortController();
  const running = executor.run({ task: task(directory), prompt: 'hold', signal: controller.signal, update: async () => {} });
  await until(async () => (await trace()).some(value => value.child)); const child = (await trace()).find(value => value.child).child;
  controller.abort(); await assert.rejects(running, /已中止/); assert.ok((await trace()).some(value => value.cancelled));
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
});
