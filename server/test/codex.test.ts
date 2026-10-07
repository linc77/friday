import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor } from '../src/codex.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
import { Engine } from '../src/engine.js';

const command = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));
const work = (cwd: string): WorkItem => ({ id: 'test', title: 'test', prompt: 'test', projectId: null, cwd, agent: 'codex', mode: 'research', status: 'running', createdAt: '', updatedAt: '', durableId: 1, threadId: null, turnId: null, result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'request' });

test('Codex wire transcript persists through Durable and reopens without duplicated output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-durable-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); let engine = await new Engine(directory, executor).open();
  try {
    await engine.createTask({ agent: 'codex', prompt: 'timeline-protocol', mode: 'research', projectId: null, requestId: 'timeline' });
    const limit = Date.now() + 5000;
    let task = (await engine.snapshot()).tasks[0];
    while (task.status === 'queued' || task.status === 'running') {
      if (Date.now() > limit) throw new Error('Codex wire execution timed out');
      await new Promise(resolve => setTimeout(resolve, 15)); task = (await engine.snapshot()).tasks[0];
    }
    assert.equal(task.status, 'completed', task.error ?? '');
    assert.equal(task.result, '## Final result\n\nVerified.');
    assert.equal(task.events.filter(e => e.kind === 'command').length, 1);
    assert.equal(task.events.find(e => e.kind === 'command')?.detail, '/tmp');
    assert.equal(task.events.find(e => e.phase === 'commentary')?.text, 'Inspection complete');
    assert.equal(task.events.find(e => e.kind === 'turn')?.status, 'completed');
    assert.equal(task.messages?.length, 2);
    assert.equal(task.messages?.[0].turnId, task.turnId);
    const saved = task.events;
    await engine.close(); engine = await new Engine(directory, executor).open();
    assert.deepEqual((await engine.snapshot()).tasks[0].events, saved);
    assert.ok(!(await engine.artifact(task.id)).includes('Inspection complete'));
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Codex wire saves session before turn, presents diffs and questions, declines unsupported permissions, and resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); const updates: ExecutionUpdate[] = [];
  try {
    const update = async (u: ExecutionUpdate) => {
      if (u.kind === 'session') {
        const wire = await readFile(join(directory, 'wire.jsonl'), 'utf8');
        assert.ok(!wire.includes('turn/start'), 'session must persist before turn/start');
      }
      updates.push(u);
      if (u.kind === 'approval') {
        if (u.approval.method.includes('fileChange')) {
          assert.ok(updates.some(v => v.kind === 'item' && v.item.detail?.includes('+example')));
          await executor.steer('test', 'Additional instruction', 'steer-1');
        }
        await executor.answer('test', u.approval.id, 'accept', { q: ['A'] });
      }
    };
    assert.equal(await executor.run({ task: work(directory), prompt: 'test', signal: new AbortController().signal, update }), 'Protocol verified');
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(wire.find(m => m.method === 'thread/start').params.sandbox, 'read-only');
    assert.deepEqual(wire.find(m => m.id === 92 && !m.method).result, { permissions: {}, scope: 'turn' });
    assert.deepEqual(wire.find(m => m.id === 91 && !m.method).result.answers.q.answers, ['A']);
    const abort = new AbortController();
    await assert.rejects(executor.run({ task: { ...work(directory), threadId: 'protocol-thread' }, prompt: 'wait-for-cancel', signal: abort.signal, update: async u => { if (u.kind === 'turn') abort.abort(); } }), /中止/);
    assert.match(await readFile(join(directory, 'wire.jsonl'), 'utf8'), /thread\/resume/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Conversation tools use read-only access before selection and return structured workspace/capture requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); const updates: ExecutionUpdate[] = [];
  try {
    const task = { ...work(directory), mode: 'auto' as const };
    await executor.run({ task, prompt: 'choose-workspace', signal: new AbortController().signal, update: async u => { updates.push(u); } });
    assert.ok(updates.some(u => u.kind === 'workspace' && u.reason.includes('目录')));
    await executor.run({ task, prompt: 'capture-idea', signal: new AbortController().signal, update: async u => { updates.push(u); } });
    assert.ok(updates.some(u => u.kind === 'idea' && u.text === '只记录这条想法' && u.id.length <= 80));
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const start = wire.find(m => m.method === 'thread/start');
    assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.approvalsReviewer, 'user', 'Auto must not broaden an unscoped task');
    assert.deepEqual(start.params.dynamicTools.map((t: any) => t.name), ['friday_request_workspace', 'friday_save_idea', 'friday_remember']);
    assert.equal(wire.find(m => m.id === 93 && !m.method).result.success, true);
    await executor.run({ task: { ...task, projectId: 'chosen-project', threadId: 'protocol-thread' }, prompt: 'test', signal: new AbortController().signal, update: async u => { if (u.kind === 'approval') await executor.answer('test', u.approval.id, 'decline', { q: ['A'] }); } });
    const resumed = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(m => m.method === 'thread/resume');
    assert.equal(resumed.params.sandbox, 'workspace-write'); assert.equal(resumed.params.cwd, directory);
    assert.equal(resumed.params.approvalsReviewer, 'auto_review');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
