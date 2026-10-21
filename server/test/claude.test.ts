import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeConnection, defaultClaudeSettings } from '../src/claude-provider.js';
import { ClaudeExecutor } from '../src/claude.js';
import { Engine } from '../src/engine.js';
import { createAPI } from '../src/api.js';
import { Auth } from '../src/auth.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';

const binaryPath = fileURLToPath(new URL('fixtures/claude.mjs', import.meta.url));
const work = (cwd: string): WorkItem => ({ id: 'claude-test', title: 'test', prompt: 'test', projectId: 'project', cwd, agent: 'claude', mode: 'code', status: 'running', createdAt: '', updatedAt: '', durableId: 1, threadId: null, turnId: null, result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'request', model: 'sonnet', reasoningEffort: 'high' });
const wire = async (directory: string) => (await readFile(join(directory, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('Claude SDK foreground Bash streams before the tool result, drains its final file write and keeps the authoritative result', { timeout: 12_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-live-output-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, environment: [{ name: 'CLAUDE_CODE_TMPDIR', value: join(directory, 'tmp') }] });
  assert.equal(await executor.run({ task: work(directory), prompt: 'foreground-output-test', signal: new AbortController().signal, update: async update => {
    updates.push(update);
    if (update.kind === 'commandOutput') await writeFile(join(directory, 'tail-observed'), 'received');
  } }), 'Bash finished');
  const chunks = updates.filter(update => update.kind === 'commandOutput'); assert.ok(chunks.length >= 2);
  assert.equal(chunks.map(update => update.kind === 'commandOutput' ? update.delta : '').join(''), 'first café 🚀\nlast bytes\n');
  const completed = updates.findLastIndex(update => update.kind === 'item' && update.item.kind === 'command' && update.item.status === 'completed');
  assert.ok(updates.findIndex(update => update.kind === 'commandOutput') < completed);
  const command = updates[completed]; assert.ok(command.kind === 'item'); assert.equal(command.item.detail, 'first café 🚀\nlast bytes\n');
  assert.equal(updates.find(update => update.kind === 'item' && update.item.kind === 'command')?.kind, 'item');
  const before = updates.length; const file = (await wire(directory)).find(value => value.foregroundOutputFile)?.foregroundOutputFile;
  await appendFile(file, 'after completion'); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(updates.length, before);
});

test('Claude cancellation closes its file followers and saves an interrupted tail; an older CLI with no output file still returns the SDK result', { timeout: 12_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-live-cancel-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, environment: [{ name: 'CLAUDE_CODE_TMPDIR', value: join(directory, 'tmp') }] });
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    await assert.rejects(executor.run({ task: work(directory), prompt: 'foreground-output-cancel', signal: controller.signal, update: async update => {
      updates.push(update); if (update.kind === 'commandOutput') controller.abort();
    } }), /已中止/);
  } finally { clearTimeout(timeout); }
  const command = updates.findLast(update => update.kind === 'item' && update.item.kind === 'command'); assert.ok(command?.kind === 'item');
  assert.equal(command.item.status, 'interrupted'); assert.equal(command.item.detail, 'first café 🚀\n');
  const before = updates.length; const file = (await wire(directory)).find(value => value.foregroundOutputFile)?.foregroundOutputFile;
  await appendFile(file, 'after cancellation'); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(updates.length, before);
  const fallback: ExecutionUpdate[] = [];
  assert.equal(await executor.run({ task: work(directory), prompt: 'foreground-output-missing', signal: new AbortController().signal, update: async update => { fallback.push(update); } }), 'Bash finished');
  assert.ok(!fallback.some(update => update.kind === 'commandOutput'));
  const final = fallback.findLast(update => update.kind === 'item' && update.item.kind === 'command'); assert.ok(final?.kind === 'item'); assert.equal(final.item.detail, 'SDK fallback output\n');
});

test('Claude retains SDK envelope cursors, uses its persisted turn UUID as prompt identity and resumes explicitly at a rewind cursor', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-rewind-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
  const updates: ExecutionUpdate[] = [];
  await executor.run({ task: work(directory), prompt: 'stream-test', signal: new AbortController().signal, update: async value => { updates.push(value); } });
  const session = updates.find(value => value.kind === 'session'); const turn = updates.find(value => value.kind === 'turn'); const head = updates.find(value => value.kind === 'nativeHead');
  assert.ok(session?.kind === 'session' && turn?.kind === 'turn' && head?.kind === 'nativeHead');
  assert.match(head.head, /^[a-f0-9-]{36}$/); assert.notEqual(head.head, 'reply-' + turn.turnId);
  assert.equal((await wire(directory)).find(value => value.type === 'user')?.uuid, turn.turnId);
  const resumed = { ...work(directory), threadId: session.threadId, claudeHome: directory, claudeResumeSessionAt: head.head };
  await executor.run({ task: resumed, prompt: 'edited continuation', signal: new AbortController().signal, update: async () => {} });
  const launch = (await wire(directory)).find(entry => entry.args?.some((arg: string) => arg.startsWith('--resume-session-at')));
  assert.ok(launch); assert.ok(launch.args.includes(head.head) || launch.args.includes('--resume-session-at=' + head.head));
});

test('An interrupted Claude turn keeps its final tool-result chain cursor rather than dropping kept tool output on a later rewind', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-tool-cursor-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
  await assert.rejects(executor.run({ task: work(directory), prompt: 'permission-test tool-result-cursor', signal: new AbortController().signal, update: async update => {
    updates.push(update); if (update.kind === 'approval') await executor.answer('claude-test', update.approval.id, 'accept', {});
  } }), /stopped after tool result/);
  const expected = (await wire(directory)).find(entry => entry.nativeToolResultUUID)?.nativeToolResultUUID;
  assert.ok(expected); const head = updates.findLast(update => update.kind === 'nativeHead'); assert.ok(head?.kind === 'nativeHead'); assert.equal(head.head, expected);
});

for (const purpose of ['git_text', 'task_title', 'review_guide'] as const) test(`Claude ${purpose} generation isolates user MCP and plugins and cannot request a write approval`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-git-text-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    await executor.run({ task: { ...work(directory), mode: 'research' }, purpose, prompt: 'permission-test', signal: new AbortController().signal, update: async update => {
      assert.notEqual(update.kind, 'approval');
    } });
    await assert.rejects(access(join(directory, 'allowed.txt')));
    const launch = (await wire(directory)).find(entry => entry.args?.includes('--permission-mode'));
    if (purpose === 'review_guide') { assert.match(launch.args[launch.args.indexOf('--tools') + 1], /Read/); assert.equal(launch.args[launch.args.indexOf('--permission-mode') + 1], 'dontAsk'); assert(launch.args.includes('--allowedTools')); const schema = JSON.parse(launch.args[launch.args.indexOf('--json-schema') + 1]); assert.equal(schema.properties.stops.type, 'array'); } else assert.equal(launch.args[launch.args.indexOf('--tools') + 1], ''); assert.ok(launch.args.includes('--strict-mcp-config'));
    if (purpose === 'task_title') {
      const schema = JSON.parse(launch.args[launch.args.indexOf('--json-schema') + 1]);
      assert.equal(schema.properties.title.type, 'string'); assert.equal(schema.additionalProperties, false);
      const result = await executor.generateText({ task: { ...work(directory), mode: 'research' }, purpose, prompt: 'structured-title-test', signal: new AbortController().signal, update: async () => {} });
      assert.equal(JSON.parse(result).title, 'Structured title', 'SDK structured output takes precedence over assistant prose');
    }
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Claude Plan mode captures ExitPlanMode without starting implementation and restores configured permissions on the next turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-plan-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, permissionMode: 'default' });
    const planning = { ...work(directory), interactionMode: 'plan' as const };
    assert.equal(await executor.run({ task: planning, prompt: 'plan-test', signal: new AbortController().signal, update: async update => { updates.push(update); } }), 'Plan captured');
    const proposals = updates.filter(update => update.kind === 'item' && update.item.kind === 'proposal');
    assert.ok(proposals.length > 0); assert.ok(proposals.every(update => update.kind === 'item' && update.item.status === 'completed'));
    assert.ok(!updates.some(update => update.kind === 'approval'), 'ExitPlanMode becomes a proposed plan, not an implementation permission request');
    const session = updates.find(update => update.kind === 'session'); assert.ok(session?.kind === 'session');
    assert.equal(await executor.run({ task: { ...planning, threadId: session.threadId }, prompt: 'permission-test', signal: new AbortController().signal, update: async update => {
      assert.notEqual(update.kind, 'approval', 'A plan turn cannot request permission to modify project files');
    } }), 'Declined');
    await assert.rejects(access(join(directory, 'allowed.txt')));
    await executor.run({ task: { ...planning, interactionMode: 'default', threadId: session.threadId }, prompt: 'permission-test', signal: new AbortController().signal, update: async update => {
      if (update.kind === 'approval') await executor.answer('claude-test', update.approval.id, 'accept', {});
    } });
    assert.equal(await readFile(join(directory, 'allowed.txt'), 'utf8'), 'authorized');
    const launches = (await wire(directory)).filter(entry => entry.args?.includes('--permission-mode'));
    assert.deepEqual(launches.map(entry => entry.args[entry.args.indexOf('--permission-mode') + 1]), ['plan']);
    assert.deepEqual((await wire(directory)).filter(entry => entry.request?.subtype === 'set_permission_mode').map(entry => entry.request.mode), ['plan', 'default']);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Claude SDK persists identity before launch, streams once, resumes with selection, validates account and cancels', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-wire-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    await assert.rejects(connection.runtime({ model: 'unknown' }), /模型不可用/);
    await assert.rejects(connection.runtime({ model: 'opus', reasoningEffort: 'medium' }), /推理强度/);
    assert.equal(await executor.run({ task: { ...work(directory), reasoningEffort: 'medium' }, prompt: 'stream-test', signal: new AbortController().signal, update: async value => {
      if (value.kind === 'session') assert.ok(!(await wire(directory)).some(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))));
      updates.push(value);
    } }), 'Verified Claude');
    assert.ok(updates.some(value => value.kind === 'output' && value.text === 'Verified '));
    const final = updates.filter(value => value.kind === 'item' && value.item.phase === 'final_answer'); assert.equal(final.length, 1);
    assert.ok(!JSON.stringify(updates).includes('private-test-thinking'), 'raw thinking is not persisted in the UI transcript');
    const session = updates.find(value => value.kind === 'session'); assert.ok(session?.kind === 'session');
    const initialLaunch = (await wire(directory)).find(entry => entry.args?.includes('--permission-mode'));
    assert.equal(initialLaunch.args[initialLaunch.args.indexOf('--permission-mode') + 1], 'auto');
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, permissionMode: 'default' });
    const resumed = { ...work(directory), threadId: session.threadId, claudeHome: directory, model: 'opus', reasoningEffort: 'high' };
    await executor.run({ task: resumed, prompt: 'continue', signal: new AbortController().signal, update: async () => {} });
    const entries = await wire(directory);
    assert.equal(entries.filter(entry => entry.args?.includes('--permission-mode')).length, 1, 'Human continuations retain the live native process');
    assert.ok(entries.some(entry => entry.request?.subtype === 'set_model' && entry.request.model === 'opus'));
    assert.ok(entries.some(entry => entry.request?.subtype === 'apply_flag_settings' && entry.request.settings?.effortLevel === 'high'));
    assert.ok(entries.some(entry => entry.request?.subtype === 'set_permission_mode' && entry.request.mode === 'default'), 'Continuation reads the current Provider mode');
    await assert.rejects(executor.run({ task: { ...resumed, claudeHome: '/different-account' }, prompt: 'continue', signal: new AbortController().signal, update: async () => {} }), /另一个 Claude/);
    const abort = new AbortController();
    const running = executor.run({ task: resumed, prompt: 'wait-for-cancel', signal: abort.signal, update: async () => {} });
    setTimeout(() => abort.abort(), 150);
    await assert.rejects(running);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Cancelling during SDK initialization waits for its owned CLI to exit before returning', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-slow-init-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    const controller = new AbortController();
    const running = executor.run({ task: work(directory), prompt: 'never submitted before initialization completes', signal: controller.signal, update: async () => {} });
    // Attach the rejection handler before aborting while we inspect the actual
    // fixture's process receipt, rather than guessing a startup duration.
    const rejected = assert.rejects(running, /中止/); let pid: number | undefined;
    const deadline = Date.now() + 6000;
    while (!pid && Date.now() < deadline) {
      const launch = (await wire(directory)).find(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id')));
      if (launch) pid = launch.pid; else await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(pid, 'The SDK fixture must actually be alive in its initialization phase');
    assert.doesNotThrow(() => process.kill(pid!, 0)); controller.abort(); await rejected;
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' }, 'A returned cancellation must not leave the CLI writing into the task directory');
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Claude permissions apply exact inputs only after approval; questions, decline and live steering work', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-controls-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory, permissionMode: 'default' });
    for (const decision of ['decline', 'accept'] as const) {
      const text = await executor.run({ task: work(directory), prompt: 'permission-test', signal: new AbortController().signal, update: async value => {
        if (value.kind === 'approval') {
          await assert.rejects(access(join(directory, 'allowed.txt')));
          assert.match(value.approval.detail, /authorized/);
          await executor.answer('claude-test', value.approval.id, decision, {});
        }
      } });
      assert.equal(text, decision === 'accept' ? 'Allowed' : 'Declined');
    }
    assert.equal(await readFile(join(directory, 'allowed.txt'), 'utf8'), 'authorized');
    const question = await executor.run({ task: work(directory), prompt: 'question-test', signal: new AbortController().signal, update: async value => {
      if (value.kind === 'approval') {
        assert.equal(value.approval.questions[0]?.question, 'Which option?');
        assert.equal(value.approval.questions[0]?.multiSelect, true);
        await executor.answer('claude-test', value.approval.id, 'accept', { q0: ['A', 'B'] });
      }
    } });
    assert.equal(question, '{"Which option?":"A, B"}');
    let steered = false;
    const text = await executor.run({ task: work(directory), prompt: 'wait-for-steer', signal: new AbortController().signal, update: async value => {
      if (value.kind === 'output' && !steered) {
        steered = true; await executor.steer('claude-test', 'include verification', 'steer');
      }
    } });
    assert.equal(text, 'Included: include verification');
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

async function until(engine: Engine, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const task = (await engine.snapshot()).tasks[0]; if (task && predicate(task)) return task; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('State transition timed out');
}
test('Claude tasks route through Durable, preserve provider/session across restart and block config changes while active', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-durable-')); await chmod(binaryPath, 0o755);
  let engine = await new Engine(directory).open(); const auth = new Auth(directory);
  try {
    await engine.claudeConnection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    await engine.mutate(value => { value.projects.push({ id: 'p', name: 'project', path: directory, context: '' }); });
    const app = createAPI(engine, auth); const headers = { Authorization: `Bearer ${(await readFile(join(directory, 'owner-token'), 'utf8')).trim()}`, 'Content-Type': 'application/json' };
    const response = await app.request('/api/tasks', { method: 'POST', headers, body: JSON.stringify({ agent: 'claude', prompt: 'permission-test', projectId: 'p', mode: 'code', model: 'sonnet', reasoningEffort: 'high', requestId: 'claude-api' }) });
    assert.equal(response.status, 201, await response.clone().text()); const { id } = await response.json();
    const waiting = await until(engine, task => task.status === 'waiting'); assert.equal(waiting.agent, 'claude'); assert.ok(waiting.threadId);
    assert.equal((await app.request('/api/agents/claude/settings', { method: 'PUT', headers, body: '{}' })).status, 409);
    await engine.answer(id, waiting.approvals[0]!.id, 'decline', {});
    const done = await until(engine, task => task.status === 'completed'); assert.equal(done.result, 'Declined'); assert.equal(done.claudeHome, directory);
    await engine.close(); engine = await new Engine(directory).open();
    assert.equal((await engine.snapshot()).tasks[0]?.threadId, done.threadId);
    await assert.rejects(engine.createTask({ continueId: id, agent: 'codex', prompt: 'change agent', projectId: 'p', mode: 'code', requestId: 'wrong-provider' }), /不能切换/);
    await engine.createTask({ continueId: id, prompt: 'continue', projectId: 'p', mode: 'code', requestId: 'continue', model: 'opus', reasoningEffort: 'high' });
    const continued = await until(engine, task => task.status === 'completed'); assert.equal(continued.threadId, done.threadId); assert.equal(continued.model, 'opus'); assert.equal(continued.messages?.length, 4);
    await engine.createTask({ continueId: id, prompt: 'wait-for-cancel', projectId: 'p', mode: 'code', requestId: 'stop' });
    await until(engine, task => task.status === 'running' && task.turnId !== null);
    await engine.close(); engine = await new Engine(directory).open();
    const recovered = await until(engine, task => task.status === 'interrupted'); assert.equal(recovered.threadId, done.threadId);
    const count = (await wire(directory)).filter(message => message.type === 'user').length;
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await wire(directory)).filter(message => message.type === 'user').length, count, 'uncertain external work must not replay');
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Claude sends typed image blocks in initial and live messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-images-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  const { IdeaImages } = await import('../src/ideas.js'); const store = new IdeaImages(directory);
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
  const image = await store.save({ data, name: 'image.png' }); const images = await store.resolve([image]);
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    let steered = false;
    const result = await executor.run({ task: work(directory), prompt: 'wait-for-steer', images, signal: new AbortController().signal, update: async update => {
      if (update.kind === 'output' && !steered) { steered = true; await executor.steer('claude-test', 'Inspect this image', 'image-steer', images); }
    } });
    assert.equal(result, 'Included: Inspect this image');
    const wire = (await readFile(join(directory, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const messages = wire.filter(value => value.type === 'user'); assert.equal(messages.length, 2);
    for (const message of messages) {
      assert.equal(message.message.content[0].type, 'text');
      assert.deepEqual(message.message.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
    }
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});


test('Friday PR task MCP is refreshed on a reused Claude SDK session without restarting its native conversation',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'friday-task-mcp-claude-'));await chmod(binaryPath,0o755);const connection=new ClaudeConnection(directory),executor=new ClaudeExecutor(connection);t.after(async()=>{await connection.close();await rm(directory,{recursive:true,force:true});});await connection.save({...defaultClaudeSettings,binaryPath,homePath:directory});
 const first={url:'http://127.0.0.1:14399/mcp',headers:{Authorization:'Bearer synthetic-turn-one'}},second={...first,headers:{Authorization:'Bearer synthetic-turn-two'}};const updates:ExecutionUpdate[]=[];
 await executor.run({task:work(directory),prompt:'First turn',taskMcp:first,signal:new AbortController().signal,update:async v=>{updates.push(v);}});const session=updates.find(v=>v.kind==='session');assert(session?.kind==='session');
 await executor.run({task:{...work(directory),threadId:session.threadId},prompt:'Second turn',taskMcp:second,signal:new AbortController().signal,update:async()=>{}});const records=await wire(directory),launch=records.find(v=>v.args?.includes('--mcp-config')&&!v.args.includes('--no-session-persistence'));assert(launch);assert(JSON.stringify(launch.args).includes('synthetic-turn-one'));const changed=records.find(v=>v.request?.subtype==='mcp_set_servers');assert(changed);assert(JSON.stringify(changed).includes('synthetic-turn-two'));assert(!JSON.stringify(changed).includes('synthetic-turn-one'));assert.equal(records.filter(v=>v.pid&&v.args?.includes('--input-format')&&!v.args.includes('--no-session-persistence')).length,1);
});
