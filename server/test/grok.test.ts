import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { GrokConnection, defaultGrokSettings, grokModelInventory, grokModelsCLI, grokSpawnArgs, validateGrokSettings } from '../src/grok-provider.js';
import { GrokExecutor, grokPermissionDecisions, grokQuestionResponse } from '../src/grok.js';
import { terminalProviderEnvironment } from '../src/terminal-provider-environment.js';
import type { ExecutionUpdate, WorkItem } from '../src/types.js';

const binary = fileURLToPath(new URL('./fixtures/grok.mjs', import.meta.url));
const work = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'grok-task', agent: 'grok', title: 'Grok fixture', cwd, model: 'grok-fast', reasoningEffort: 'high', threadId: null, currentRunId: 'grok-run', events: [], approvals: [], interactionMode: 'default', ...changes }) as WorkItem;
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-grok-')), wire = join(directory, 'wire.jsonl'), home = join(directory, 'grok-home'), connection = new GrokConnection(directory), executor = new GrokExecutor(connection);
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); }); await chmod(binary, 0o755);
  await connection.save({ ...defaultGrokSettings, enabled: true, binaryPath: binary, homePath: home, environment: Object.entries({ GROK_TEST_WIRE: wire, ...environment }).map(([name, value]) => ({ name, value })) });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, wire, home, connection, executor, trace };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await read()) { if (Date.now() > end) throw new Error('Grok fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('Grok independent generation starts its own native session in explicit default permissions and suppresses updater side effects', async t => {
  const fixture = await setup(t);
  const result = await fixture.executor.generateText({ task: work(fixture.directory, { threadId: 'foreground', grokHome: '/another-account', nativeProviderAccount: 'another-account' }), purpose: 'task_title', prompt: 'Title', signal: AbortSignal.timeout(5000), update: async () => {} });
  assert.ok(result.trim());
  const trace = await fixture.trace(), prompt = trace.find(value => value.method === 'session/prompt');
  assert.ok(trace.some(value => value.method === 'session/new')); assert.ok(!trace.some(value => value.method === 'session/load' || value.method === 'session/resume'));
  assert.equal(prompt.argv[prompt.argv.indexOf('--permission-mode') + 1], 'default'); assert.equal(prompt.probe, '1'); assert.ok(!prompt.argv.includes('--always-approve'));
});
test('Grok maps native model reasoning choices, CLI defaults and explicit permission modes without inventing capabilities', () => {
  const models = grokModelInventory({ currentModelId: 'native', availableModels: [{ modelId: 'native', name: 'Native', _meta: { reasoningEffort: 'dynamic-budget', reasoningEfforts: [{ value: 'low' }, { id: 'dynamic-budget', default: true }, { value: 'bad value' }, { value: 'low' }] } }, { modelId: 'plain', name: 'Plain', _meta: { supportsReasoningEffort: false, reasoningEfforts: [{ value: 'high' }] } }] });
  assert.deepEqual(models.map(value => value.id), ['native', 'plain']); assert.deepEqual(models[0]!.reasoningEfforts, ['low', 'dynamic-budget']); assert.equal(models[0]!.defaultReasoningEffort, 'dynamic-budget'); assert.deepEqual(models[1]!.reasoningEfforts, []);
  assert.deepEqual(grokSpawnArgs('default'), ['--permission-mode', 'default', 'agent', 'stdio']); assert.deepEqual(grokSpawnArgs('fullAccess'), ['agent', '--always-approve', 'stdio']); assert.deepEqual(grokSpawnArgs('auto'), ['--permission-mode', 'auto', 'agent', 'stdio']);
  const listing = grokModelsCLI('You are logged in\n* grok-fast (default)\n- Grok_native default description\n- grok-fast'); assert.equal(listing.authenticated, true); assert.equal(listing.models.length, 2); assert.equal(listing.models[1]!.isDefault, false); assert.equal(listing.models[1]!.name, 'Grok native');
  for (const permissionMode of ['acceptEdits', 'plan']) assert.throws(() => validateGrokSettings({ ...defaultGrokSettings, permissionMode }), /权限/);
  assert.throws(() => validateGrokSettings({ ...defaultGrokSettings, launchArgs: '--always-approve' }), /启动参数/);
  assert.equal(validateGrokSettings({ ...defaultGrokSettings, reasoningEffort: ' ' + 'x'.repeat(32) + ' ' }).reasoningEffort.length, 32);
  assert.deepEqual(grokPermissionDecisions([{ kind: 'allow_always', optionId: 'project-grant' }, { kind: 'allow_once', optionId: 'once' }]), ['cancel', 'accept']);
  assert.deepEqual(grokQuestionResponse([{ id: 'q', question: 'Target', options: [{ label: 'One', preview: 'preview' }] }], { q: ['One'] }), { outcome: 'accepted', answers: { Target: ['One'] }, annotations: { Target: { preview: 'preview' } } });
  assert.deepEqual(grokQuestionResponse([{ question: 'Target', options: [] }], { Target: ['Custom target'] }), { outcome: 'accepted', answers: { Target: ['Other'] }, annotations: { Target: { notes: 'Custom target' } } });
});
test('Grok read-only probes, credentials and workspace catalog honor the configured account and suppress updater side effects', async t => {
  const { directory, connection, trace, home } = await setup(t, { XAI_API_KEY: 'fixture-private-key' });
  const owner = await connection.status(true), device = await connection.status(false); assert.equal(owner.connected, true); assert.equal(device.settings, null); assert.ok(!JSON.stringify(owner).includes('fixture-private-key'));
  assert.equal(owner.models[0]!.id, 'grok-fast'); assert.deepEqual(owner.models[0]!.reasoningEfforts, ['low', 'high', 'native-effort']);
  const workspace = await connection.workspace(directory); assert.deepEqual(workspace.commands.map(value => value.name), ['compact', 'native-command']); assert.equal(workspace.skills[0]!.name, 'hidden'); assert.equal(workspace.skills[0]!.enabled, false); assert.ok(!JSON.stringify(workspace).includes('must-not-be-public'));
  await connection.save(owner.settings); assert.equal(JSON.parse(await readFile(join(directory, 'grok-provider.json'), 'utf8')).environment.find((value: any) => value.name === 'XAI_API_KEY').value, 'fixture-private-key');
  const environment = await terminalProviderEnvironment(directory, { agent: 'grok', grokHome: home }); assert.equal(environment.GROK_HOME, home); assert.equal(environment.XAI_API_KEY, 'fixture-private-key'); await assert.rejects(terminalProviderEnvironment(directory, { agent: 'grok', grokHome: directory }), /配置已改变/);
  const records = await trace(); assert.ok(records.every(value => value.probe === '1')); assert.ok(!records.some(value => ['session/new', 'session/prompt'].includes(value.method)));
});
test('Grok saves its native ID before external start, negotiates ACP v1/v2, streams scoped output and resumes without replaying load history', async t => {
  for (const protocol of ['1', 'legacy-2', '2']) {
    const fixture = await setup(t, { GROK_TEST_PROTOCOL: protocol }), { directory, executor, trace, home } = fixture; const updates: ExecutionUpdate[] = []; let session = '', started = false;
    const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'session') session = value.threadId; };
    const result = await executor.run({ task: work(directory), prompt: 'reply', signal: new AbortController().signal, update, beforeStart: async () => { assert.ok(session); started = true; } });
    assert.equal(result, 'Grok reply café\u2028line\u2029end'); assert.ok(started); assert.ok(updates.some(value => value.kind === 'ready' && value.canSteer === false)); assert.ok(updates.some(value => value.kind === 'contextUsage' && value.usage?.usedTokens === 456));
    assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.status === 'completed' && value.item.detail === 'native output'));
    assert.ok(updates.every(value => !JSON.stringify(value).includes('Foreign session text') && !JSON.stringify(value).includes('Another session text')));
    const first = session; updates.length = 0;
    assert.equal(await executor.run({ task: work(directory, { threadId: first, grokHome: home, currentRunId: 'continued' }), prompt: 'continue', signal: new AbortController().signal, update }), 'Grok reply café\u2028line\u2029end'); assert.equal(session, first);
    assert.ok(updates.every(value => !JSON.stringify(value).includes('Loaded history')));
    const records = await trace(); assert.ok(records.some(value => value.method === (protocol === '2' ? 'session/resume' : 'session/load') && value.params.sessionId === first));
    assert.ok(records.some(value => protocol === '2' ? value.method === 'session/set_config_option' && value.params.configId === 'native-effort' && value.params.value === 'high' : value.method === 'session/set_model' && value.params._meta.reasoningEffort === 'high'));
    await assert.rejects(executor.run({ task: work(directory, { grokHome: 'different' }), prompt: 'reply', signal: new AbortController().signal, update }), /配置目录/);
  }
});
test('Grok waits for its own native completion, ignores background completions and propagates native failure', async t => {
  const { directory, executor, trace } = await setup(t); const updates: ExecutionUpdate[] = [];
  assert.equal(await executor.run({ task: work(directory), prompt: 'fallback', signal: new AbortController().signal, update: async value => { updates.push(value); } }), 'Grok reply café\u2028line\u2029end');
  assert.ok((await trace()).some(value => value.nativeCompletion)); assert.ok(updates.some(value => value.kind === 'item' && value.item.phase === 'final_answer'));
  await assert.rejects(executor.run({ task: work(directory), prompt: 'error', signal: new AbortController().signal, update: async () => {} }), /Native Grok failure/);
});
test('Grok native approvals preserve the original option IDs, reject permanent grants and write the reply before acknowledging the answer', async t => {
  const { directory, executor, trace } = await setup(t); let answer: Promise<void> | undefined;
  const running = executor.run({ task: work(directory), prompt: 'approval', signal: new AbortController().signal, update: async value => {
    if (value.kind === 'approval') {
      assert.deepEqual(value.approval.decisions, ['cancel', 'decline', 'acceptForSession', 'accept']);
      // A user action is dispatched after the approval publication returns,
      // just as the HTTP answer API runs independently from event delivery.
      answer = new Promise<void>((resolve, reject) => setImmediate(async () => { try { await assert.rejects(executor.answer('grok-task', value.approval.id, 'acceptAlways', {}), /授权/); await executor.answer('grok-task', value.approval.id, 'acceptForSession', {}); resolve(); } catch (error) { reject(error); } }));
    }
  } });
  assert.equal(await running, 'Grok reply café\u2028line\u2029end'); await answer;
  assert.ok((await trace()).some(value => value.permissionOutcome?.outcome?.optionId === 'allow-edits-session'));
});
test('Grok questions encode preview and freeform annotations and native plans use the existing proposal card', async t => {
  const { directory, executor, trace } = await setup(t); const updates: ExecutionUpdate[] = []; let answer: Promise<void> | undefined;
  const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'approval') answer = new Promise<void>((resolve, reject) => setImmediate(() => { void executor.answer('grok-task', value.approval.id, 'accept', { choice: ['One'] }).then(resolve, reject); })); };
  await executor.run({ task: work(directory), prompt: 'question', signal: new AbortController().signal, update }); await answer;
  assert.ok((await trace()).some(value => value.nativeResult?.annotations?.['Choose a target']?.preview === 'preview-one'));
  await executor.run({ task: work(directory), prompt: 'proposal', signal: new AbortController().signal, update }); assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'proposal' && value.item.text.startsWith('# Native plan')));
  assert.ok((await trace()).some(value => value.nativeResult?.outcome === 'abandoned'));
});
test('Grok native cancel reaches the protocol before its real process group is terminated', async t => {
  const { directory, executor, trace } = await setup(t), controller = new AbortController();
  const running = executor.run({ task: work(directory), prompt: 'hold', signal: controller.signal, update: async () => {} });
  await until(async () => (await trace()).some(value => value.child)); const child = (await trace()).find(value => value.child)!.child;
  controller.abort(); await assert.rejects(running, /已中止/); assert.ok((await trace()).some(value => value.cancelTrigger === 'ctrl_c'));
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
});
test('Grok negotiates genuine ACP v2 upserts, batched streaming, tool output, UTF-8 terminal chunks and idle completion', async t => {
  const { directory, executor } = await setup(t, { GROK_TEST_PROTOCOL: '2' }), updates: ExecutionUpdate[] = [];
  const result = await executor.run({ task: work(directory), prompt: 'patches', signal: new AbortController().signal, update: async value => { updates.push(value); } });
  assert.equal(result, 'Replacement');
  assert.ok(updates.some(value => value.kind === 'item' && value.item.text === 'Replacement' && value.item.phase === 'final_answer'));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'reasoning' && value.item.text === 'Thought snapshot'));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.itemId === 'tool:streamed' && value.item.detail === 'first second' && value.item.status === 'completed'));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.itemId === 'terminal:term' && value.item.detail === '🙂' && value.item.exitCode === 0));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.plan?.[0]?.step === 'Finish fixture'));
});
test('Grok authenticates with the advertised native method and persists its session before answering an early workspace permission', async t => {
  for (const protocol of ['1', '2']) {
    const { directory, executor, trace } = await setup(t, { GROK_TEST_PROTOCOL: protocol, GROK_TEST_AUTH_REQUIRED: '1', GROK_TEST_EARLY_PERMISSION: '1' });
    let sessionId = '', started = false, answer: Promise<void> | undefined;
    await executor.run({ task: work(directory), prompt: 'reply', signal: new AbortController().signal,
      beforeStart: async () => { assert.ok(sessionId); started = true; },
      update: async value => {
        if (value.kind === 'session') sessionId = value.threadId;
        if (value.kind === 'approval') { assert.ok(sessionId); answer = new Promise<void>((resolve, reject) => setImmediate(() => { void executor.answer('grok-task', value.approval.id, 'accept', {}).then(resolve, reject); })); }
      } }); await answer;
    assert.ok(started); const records = await trace(); assert.ok(records.some(value => value.method === (protocol === '2' ? 'auth/login' : 'authenticate') && value.params.methodId === 'cached_token'));
    assert.ok(records.some(value => value.nativeResult?.outcome?.optionId === 'allow-once'));
  }
});
test('Grok preserves native image blocks despite legacy image:false and never replaces a failed resume with a new session', async t => {
  const { directory, executor, trace } = await setup(t, { GROK_TEST_FAIL_RESUME: '1' }), image = join(directory, 'fixture.png'), bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jLmcAAAAASUVORK5CYII=', 'base64');
  await writeFile(image, bytes); let sessionId = '';
  await executor.run({ task: work(directory), prompt: 'reply', images: [{ id: 'fixture-image', name: 'fixture.png', path: image, mediaType: 'image/png' }], signal: new AbortController().signal, update: async value => { if (value.kind === 'session') sessionId = value.threadId; } });
  const prompt = (await trace()).find(value => value.method === 'session/prompt'); assert.deepEqual(prompt.params.prompt[1], { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' });
  await assert.rejects(executor.run({ task: work(directory, { threadId: sessionId }), prompt: 'continue', signal: new AbortController().signal, update: async () => {} }), /Native resume failed/);
  assert.equal((await trace()).filter(value => value.method === 'session/new').length, 1);
});
test('Grok transports actual Friday MCP calls over both native HTTP and the stdio fallback without exposing credentials in task updates', async t => {
  for (const protocol of ['1', '2']) for (const nativeHTTP of ['0', '1']) {
    const { directory, executor } = await setup(t, { GROK_TEST_PROTOCOL: protocol, GROK_TEST_MCP_HTTP: nativeHTTP }), target = join(directory, 'mcp-written.txt'); let calls = 0;
    const server = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-mcp-private'); let data = ''; for await (const chunk of req) data += chunk; const message = JSON.parse(data); let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture_write', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] };
      else { calls++; await writeFile(target, message.params.arguments.text); result = { content: [{ type: 'text', text: 'Written' }] }; }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result }); res.writeHead(200, { 'Content-Type': nativeHTTP === '0' ? 'text/event-stream' : 'application/json' }); res.end(nativeHTTP === '0' ? 'data: ' + payload + '\n\n' : payload);
    });
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const updates: ExecutionUpdate[] = [], controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
    try { await executor.run({ task: work(directory), prompt: 'mcp', signal: controller.signal, update: async value => { updates.push(value); }, taskMcp: { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer fixture-mcp-private' } } }); }
    finally { clearTimeout(timeout); }
    assert.equal(calls, 1); assert.equal(await readFile(target, 'utf8'), 'Written through real Friday MCP transport'); assert.ok(!JSON.stringify(updates).includes('fixture-mcp-private'));
  }
});
