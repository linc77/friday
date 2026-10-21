import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { codexContextUsage, claudeContextUsage } from '../src/task-context-usage.js';
import { ClaudeEvents } from '../src/claude-events.js';
import { CodexExecutor } from '../src/codex.js';
import { ClaudeExecutor } from '../src/claude.js';
import { ClaudeConnection, defaultClaudeSettings } from '../src/claude-provider.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { compactTask } from '../src/task-compaction.js';
import type { ExecutionRequest, ExecutionUpdate, WorkItem } from '../src/types.js';

const work = (cwd: string): WorkItem => ({ id: 'task', projectId: null, cwd, title: 'Task', prompt: 'Original request', result: 'Original answer', agent: 'codex', mode: 'research', status: 'completed',
  createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:01:00Z', durableId: null, threadId: 'protocol-thread', turnId: null, events: [], approvals: [], artifact: 'original.md', error: null, lastRequestId: 'original',
  messages: [{ id: 'original-user', role: 'user', text: 'Original request' }, { id: 'original-assistant', role: 'assistant', text: 'Original answer' }] });

test('Context occupancy uses the last request and separate cache counts; unknown and malformed windows stay unknown', () => {
  const codex = codexContextUsage({ total: { totalTokens: 9e8 }, last: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 60, outputTokens: 40, reasoningOutputTokens: 10 }, modelContextWindow: 200000 })!;
  assert.equal(codex.usedTokens, 140); assert.equal(codex.maxTokens, 200000); assert.equal(codex.cachedInputTokens, 60);
  assert.equal(codexContextUsage({ last: { totalTokens: 0 }, modelContextWindow: 0 })?.maxTokens, null);
  for (const invalid of [null, [], {}, { last: { totalTokens: NaN } }, { last: { totalTokens: Infinity } }]) assert.equal(codexContextUsage(invalid), undefined);
  const claude = claudeContextUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }, 'model', 1000)!;
  assert.equal(claude.usedTokens, 135); assert.equal(claude.inputTokens, 130); assert.equal(claude.cachedInputTokens, 100); assert.equal(claude.maxTokens, 1000);
  assert.equal(claudeContextUsage({ input_tokens: 0, output_tokens: 0 })?.maxTokens, null);
  assert.equal(claudeContextUsage({ input_tokens: 1e308, output_tokens: 1e308 }), undefined);
  const ttl = (ephemeral_1h_input_tokens: number, ephemeral_5m_input_tokens: number) => claudeContextUsage({ input_tokens: 1, output_tokens: 1, cache_creation: { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens } })?.promptCacheTtlMs;
  assert.equal(ttl(100, 10), 3_600_000); assert.equal(ttl(0, 10), 300_000); assert.equal(ttl(0, 0), undefined);
});

test('Claude reports actual root request occupancy and the matching model window, excluding child and cumulative accounting', async () => {
  const updates: ExecutionUpdate[] = [], events = new ClaudeEvents('turn', async value => { updates.push(value); });
  const assistant = (model: string, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'message', model, content: [], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } });
  await events.handle(assistant('model', 'child') as never); assert.equal(updates.length, 0);
  await events.handle(assistant('model') as never);
  await events.handle({ type: 'result', modelUsage: { model: { inputTokens: 9e8, outputTokens: 9e8, contextWindow: 200000 } } } as never);
  const usages = updates.filter(update => update.kind === 'contextUsage'); assert.equal(usages.length, 2);
  assert.equal(usages[1].usage?.usedTokens, 135); assert.equal(usages[1].usage?.maxTokens, 200000);
  await events.handle({ type: 'system', subtype: 'compact_boundary' } as never);
  assert.deepEqual(updates.findLast(update => update.kind === 'contextUsage'), { kind: 'contextUsage', usage: null });
  await events.handle({ type: 'result', modelUsage: { model: { contextWindow: 200000 } } } as never);
  assert.equal(updates.filter(update => update.kind === 'contextUsage').length, 3, 'A pre-compaction report never revives after a boundary');
});

test('Manual compaction is one authenticated durable provider run, preserving the conversation, reply and original session across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-context-command-')), requests: ExecutionRequest[] = [];
  const executor = { async run(request: ExecutionRequest) {
    requests.push(request); assert.equal(request.command, 'compact'); assert.equal(request.task.threadId, 'protocol-thread');
    assert.equal(request.contextBeforeCompaction?.usedTokens, 9000); assert.equal(request.contextBeforeCompaction?.maxTokens, 200000); assert.equal(request.task.contextUsage, null);
    await request.update({ kind: 'output', text: 'Internal compaction summary must not replace the answer' });
    await request.update({ kind: 'contextUsage', usage: { usedTokens: 120, maxTokens: 200000, updatedAt: new Date().toISOString() } }); return '';
  }, async answer() {}, async steer() {} };
  const options = { changeRequestSyncIntervalMs: 0 };
  let engine = await new Engine(directory, executor, undefined, options).open(); const auth = new Auth(directory);
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => { state.tasks = [{ ...work(directory), contextUsage: { usedTokens: 9000, maxTokens: 200000, updatedAt: new Date().toISOString() } }]; });
  let api = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const input = { threadId: 'protocol-thread', requestId: 'compact-once' };
  assert.equal((await api.request('/api/tasks/task/compact', { method: 'POST', body: JSON.stringify(input), headers: { 'Content-Type': 'application/json' } })).status, 401);
  const responses = await Promise.all([0, 1].map(() => api.request('/api/tasks/task/compact', { method: 'POST', headers, body: JSON.stringify(input) })));
  assert(responses.every(response => response.status === 202));
  const deadline = Date.now() + 5000;
  while ((await engine.snapshot()).tasks[0].status !== 'completed') { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  let current = (await engine.snapshot()).tasks[0]; assert.equal(requests.length, 1); assert.equal(requests[0].taskMcp, undefined);
  assert.equal(current.messages?.length, 2); assert.equal(current.result, 'Original answer'); assert.equal(current.artifact, 'original.md');
  assert.equal(current.contextUsage?.usedTokens, 120); assert.equal(current.runs?.[0].command, 'compact'); assert.equal(current.runs?.[0].contextUsage?.usedTokens, 120);
  await assert.rejects(compactTask(engine, 'task', { requestId: 'old-thread', threadId: 'old-thread' }), /已经改变/);
  await engine.close(); engine = await new Engine(directory, executor, undefined, options).open(); api = createAPI(engine, auth, () => []);
  assert.equal((await api.request('/api/tasks/task/compact', { method: 'POST', headers, body: JSON.stringify(input) })).status, 202);
  current = (await engine.snapshot()).tasks[0]; assert.equal(current.contextUsage?.usedTokens, 120); assert.equal(requests.length, 1);
  await engine.mutate(state => { state.tasks[0].status = 'running'; });
  await assert.rejects(compactTask(engine, 'task', { requestId: 'busy', threadId: 'protocol-thread' }), /正在运行/);
});

test('Codex uses its native compact RPC after the start receipt, reports scoped usage and never sends an ordinary prompt', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-native-compact-')), command = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));
  await chmod(command, 0o755); const executor = new CodexExecutor(command), updates: ExecutionUpdate[] = []; let started = 0;
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  await executor.run({ task: work(directory), prompt: 'Never send this prompt', command: 'compact', signal: new AbortController().signal,
    beforeStart: async () => { started++; const wire = await readFile(join(directory, 'wire.jsonl'), 'utf8'); assert(!wire.includes('thread/compact/start')); }, update: async value => { updates.push(value); } });
  const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(started, 1); assert.equal(wire.filter(message => message.method === 'thread/compact/start').length, 1); assert(!wire.some(message => message.method === 'turn/start'));
  const usages = updates.filter(update => update.kind === 'contextUsage'); assert.equal(usages.length, 1); assert.equal(usages[0].usage?.usedTokens, 1505);
});

test('The installed Claude SDK sends a native compact command, keeps its real boundary cursor and uses post-compaction occupancy', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-compact-')), binary = fileURLToPath(new URL('fixtures/claude.mjs', import.meta.url));
  await chmod(binary, 0o755); const connection = new ClaudeConnection(directory), executor = new ClaudeExecutor(connection);
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath: binary, homePath: directory });
  const initial = { ...work(directory), agent: 'claude', threadId: null, model: 'sonnet', reasoningEffort: 'high' }, first: ExecutionUpdate[] = [];
  await executor.run({ task: initial, prompt: 'Prepare existing session', signal: new AbortController().signal, update: async value => { first.push(value); } });
  const session = first.find(value => value.kind === 'session')!; assert.equal(session.kind, 'session');
  if (session.kind !== 'session') throw new Error('Missing session');
  const updates: ExecutionUpdate[] = []; let started = 0;
  const result = await executor.run({ task: { ...initial, threadId: session.threadId, executionSessionId: session.executionSessionId,
    currentRunId: 'compact-run', contextUsage: { usedTokens: 8000, maxTokens: 200000, model: 'sonnet', updatedAt: new Date().toISOString() } },
    command: 'compact', prompt: 'This wrapper must not become the compact message', signal: new AbortController().signal,
    beforeStart: async () => { started++; }, update: async value => { updates.push(value); } });
  assert.equal(result, ''); assert.equal(started, 1);
  const wire = (await readFile(join(directory, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const inputs = wire.filter(message => message.type === 'user'); assert.equal(inputs.length, 2); assert.equal(inputs[1].message.content, '/compact');
  const usage = updates.findLast(value => value.kind === 'contextUsage'); assert(usage?.kind === 'contextUsage'); assert.equal(usage.usage?.usedTokens, 800); assert.equal(usage.usage?.maxTokens, 200000);
  assert(updates.some(value => value.kind === 'item' && value.item.kind === 'compaction' && value.item.detail === '8000 → 800 Token'));
  assert(updates.some(value => value.kind === 'nativeHead'), 'The SDK accepts any chain UUID as resumeSessionAt, including the saved compaction boundary');
  assert(!updates.some(value => value.kind === 'ready' && value.canSteer));
});

test('The installed Claude SDK expands a chosen Skill in the final text block, preserving prose and keeping Friday context outside ARGUMENTS', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-skill-wire-')), binary = fileURLToPath(new URL('fixtures/claude.mjs', import.meta.url));
  await chmod(binary, 0o755); await mkdir(join(directory, 'skills/review'), { recursive: true }); await writeFile(join(directory, 'skills/review/SKILL.md'), '---\ndescription: Review code\n---\n');
  const connection = new ClaudeConnection(directory), executor = new ClaudeExecutor(connection);
  t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath: binary, homePath: directory });
  await executor.run({ task: { ...work(directory), agent: 'claude', threadId: null, model: 'sonnet' }, prompt: 'Full wrapped prompt', userText: 'Before $review focus on auth', contextText: 'Friday supplied context',
    signal: new AbortController().signal, update: async () => {} });
  const wire = (await readFile(join(directory, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const input = wire.find(message => message.type === 'user');
  assert.deepEqual(input.message.content, [{ type: 'text', text: 'Friday supplied context\n\nBefore' }, { type: 'text', text: '/review focus on auth' }]);
});

test('An uncertain native compaction survives service interruption without replaying the external operation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-compact-uncertain-')); let calls = 0; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const executor = { async run(request: ExecutionRequest) {
    calls++; await writeFile(join(directory, 'external-compact-effect'), String(calls)); entered();
    await new Promise<never>((_, reject) => { if (request.signal.aborted) reject(new Error('Interrupted')); else request.signal.addEventListener('abort', () => reject(new Error('Interrupted')), { once: true }); }); return '';
  }, async answer() {}, async steer() {} };
  const options = { changeRequestSyncIntervalMs: 0 };
  let engine = await new Engine(directory, executor, undefined, options).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => { state.tasks = [work(directory)]; });
  const input = { threadId: 'protocol-thread', requestId: 'uncertain-compact', nextMessage: { text: 'Retained next user message' } };
  await compactTask(engine, 'task', input); await started; await engine.close();
  engine = await new Engine(directory, executor, undefined, options).open();
  const deadline = Date.now() + 5000;
  while ((await engine.snapshot()).tasks[0].status !== 'interrupted') { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(await compactTask(engine, 'task', input), 'task'); assert.equal(calls, 1); assert.equal(await readFile(join(directory, 'external-compact-effect'), 'utf8'), '1');
  assert.equal((await engine.snapshot()).tasks[0].result, 'Original answer');
  const pending = (await engine.snapshot()).tasks[0].queue!;
  assert.equal(pending.paused, true); assert.equal(pending.messages.length, 1); assert.equal(pending.messages[0].text, input.nextMessage.text); assert.equal(pending.messages[0].status, 'queued');
});

test('Compact and send atomically saves one queued message, waits for native success and keeps its selected mode and model', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-compact-send-')), calls: ExecutionRequest[] = [];
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const executor = { async run(request: ExecutionRequest) { calls.push(request); if (request.command) { await gate; return ''; } return 'Following answer'; }, async answer() {}, async steer() {} };
  const options = { changeRequestSyncIntervalMs: 0 }; let engine = await new Engine(directory, executor, undefined, options).open(); const auth = new Auth(directory);
  t.after(async () => { release(); await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => { state.tasks = [work(directory)]; });
  let api = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const input = { text: 'Following user request', requestId: 'compact-and-send', threadId: 'protocol-thread', compactBeforeSend: true, model: 'chosen-model', interactionMode: 'plan' };
  const send = () => api.request('/api/tasks/task/message', { method: 'POST', headers, body: JSON.stringify(input) });
  const replies = await Promise.all([send(), send()]); assert(replies.every(reply => reply.status === 200));
  const deadline = Date.now() + 5000;
  while (!calls.length) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const during = (await engine.snapshot()).tasks[0]; assert.equal(during.queue?.messages.length, 1); assert.equal(during.queue?.messages[0].status, 'queued');
  assert.equal(during.messages?.length, 2); assert.equal(calls.length, 1); assert.equal(calls[0].command, 'compact');
  release();
  while ((await engine.snapshot()).tasks[0].queue?.messages[0].status !== 'completed') { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(calls.length, 2); assert.equal(calls[1].command, undefined); assert.equal(calls[1].task.model, 'chosen-model'); assert.equal(calls[1].task.interactionMode, 'plan'); assert.match(calls[1].prompt, /Following user request/);
  await engine.close(); engine = await new Engine(directory, executor, undefined, options).open(); api = createAPI(engine, auth, () => []);
  assert.equal((await send()).status, 200); assert.equal(calls.length, 2); assert.equal((await engine.snapshot()).tasks[0].queue?.messages.length, 1);
  assert.equal((await api.request('/api/tasks/task/message', { method: 'POST', headers, body: JSON.stringify({ ...input, requestId: 'old-thread', threadId: 'wrong' }) })).status, 400);
  assert.equal((await api.request('/api/tasks/task/message', { method: 'POST', headers, body: JSON.stringify({ text: '/compact', requestId: 'invalid-dispatch', dispatchMode: 'invalid' }) })).status, 400);
});

test('A failed compaction holds the saved follow-up without sending or replaying it', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-compact-failure-')); let calls = 0;
  const executor = { async run(request: ExecutionRequest): Promise<string> { calls++; assert.equal(request.command, 'compact'); throw new Error('Native compaction failed'); }, async answer() {}, async steer() {} };
  const engine = await new Engine(directory, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => { state.tasks = [work(directory)]; });
  await compactTask(engine, 'task', { requestId: 'held-follow-up', threadId: 'protocol-thread', nextMessage: { text: 'Saved user input' } });
  const deadline = Date.now() + 5000;
  while (!(await engine.snapshot()).tasks[0].queue?.paused) { assert(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 5)); }
  const current = (await engine.snapshot()).tasks[0]; assert.equal(current.status, 'failed'); assert.equal(current.result, 'Original answer'); assert.equal(current.queue?.messages[0].status, 'queued'); assert.equal(calls, 1);
});
