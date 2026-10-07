import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, access } from 'node:fs/promises';
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

test('Claude SDK persists identity before launch, streams once, resumes with selection, validates account and cancels', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-wire-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection); const updates: ExecutionUpdate[] = [];
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
    await assert.rejects(connection.runtime({ model: 'unknown' }), /模型不可用/);
    await assert.rejects(connection.runtime({ model: 'opus', reasoningEffort: 'medium' }), /推理强度/);
    assert.equal(await executor.run({ task: work(directory), prompt: 'stream-test', signal: new AbortController().signal, update: async value => {
      if (value.kind === 'session') assert.ok(!(await wire(directory)).some(entry => entry.args?.some((arg: string) => arg.startsWith('--session-id'))));
      updates.push(value);
    } }), 'Verified Claude');
    assert.ok(updates.some(value => value.kind === 'output' && value.text === 'Verified '));
    const final = updates.filter(value => value.kind === 'item' && value.item.phase === 'final_answer'); assert.equal(final.length, 1);
    assert.ok(!JSON.stringify(updates).includes('private-test-thinking'), 'raw thinking is not persisted in the UI transcript');
    const session = updates.find(value => value.kind === 'session'); assert.ok(session?.kind === 'session');
    const resumed = { ...work(directory), threadId: session.threadId, claudeHome: directory, model: 'opus', reasoningEffort: 'high' };
    await executor.run({ task: resumed, prompt: 'continue', signal: new AbortController().signal, update: async () => {} });
    const entries = await wire(directory); const launch = entries.find(entry => entry.args?.some((arg: string) => arg.startsWith('--resume')));
    assert.ok(launch.args.some((arg: string) => arg.includes(session.threadId))); assert.ok(launch.args.includes('opus')); assert.ok(launch.args.includes('high'));
    await assert.rejects(executor.run({ task: { ...resumed, claudeHome: '/different-account' }, prompt: 'continue', signal: new AbortController().signal, update: async () => {} }), /另一个 Claude/);
    const abort = new AbortController();
    const running = executor.run({ task: resumed, prompt: 'wait-for-cancel', signal: abort.signal, update: async () => {} });
    setTimeout(() => abort.abort(), 150);
    await assert.rejects(running);
  } finally { await connection.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Claude permissions apply exact inputs only after approval; questions, decline and live steering work', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-claude-controls-')); await chmod(binaryPath, 0o755);
  const connection = new ClaudeConnection(directory); const executor = new ClaudeExecutor(connection);
  try {
    await connection.save({ ...defaultClaudeSettings, binaryPath, homePath: directory });
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
      if (value.kind === 'approval') { assert.equal(value.approval.questions[0]?.question, 'Which option?'); await executor.answer('claude-test', value.approval.id, 'accept', { q0: ['A'] }); }
    } });
    assert.equal(question, '{"Which option?":"A"}');
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
