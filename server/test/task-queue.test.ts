import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { IdeaImages } from '../src/ideas.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';

class ControlledExecutor implements Executor {
  calls: { id: string; text: string; model?: string; effort?: string; release: () => void }[] = [];
  active = new Set<string>();
  steers: string[] = [];
  failSteer = false;
  async run(request: ExecutionRequest) {
    assert.equal(this.active.has(request.task.id), false, 'two turns of one thread must never overlap');
    this.active.add(request.task.id);
    try {
      await request.update({ kind: 'session', threadId: request.task.threadId ?? `thread-${request.task.id}` });
      await request.update({ kind: 'turn', turnId: randomUUID() });
      await new Promise<void>((resolve, reject) => {
        this.calls.push({ id: request.task.id, text: request.prompt, model: request.task.model, effort: request.task.reasoningEffort, release: resolve });
        const abort = () => reject(new Error('aborted'));
        request.signal.addEventListener('abort', abort, { once: true });
        if (request.signal.aborted) abort();
      });
      return 'Answer';
    } finally { this.active.delete(request.task.id); }
  }
  async steer(_id: string, text: string) { this.steers.push(text); if (this.failSteer) throw new Error('lost receipt'); }
  async answer() {}
}

async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Queue state transition timed out');
}
const input = (requestId: string) => ({ agent: 'codex' as const, prompt: 'Initial request', mode: 'research' as const, projectId: null, requestId });

test('Queue edits, reorder and cancellation persist while independent threads run in parallel', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const send = (path: string, body: object, method = 'POST') => app.request(path, { method, headers, body: JSON.stringify(body) });
  try {
    const first = await engine.createTask(input('first')); const other = await engine.createTask(input('other'));
    await until(engine, () => executor.calls.length === 2);
    assert.equal(executor.active.size, 2, 'different threads do not share a global FIFO');
    const queue = `/api/tasks/${first}/queue`;
    const enqueue = (requestId: string, text: string) => send(`/api/tasks/${first}/message`, { requestId, text, dispatchMode: 'queue' });
    const duplicate = await Promise.all([enqueue('q1', 'Cancel this'), enqueue('q1', 'Cancel this')]);
    assert.ok(duplicate.every(response => response.status === 200));
    await enqueue('q2', 'Edit this'); await enqueue('q3', 'Run first');
    let task = (await engine.snapshot()).tasks.find(task => task.id === first)!;
    assert.equal(task.queue?.messages.length, 3);
    assert.equal(task.messages?.length, 1, 'future messages enter the timeline when their turn starts');
    assert.equal((await send(`${queue}/q2`, { text: 'Edited second', model: 'different-model', reasoningEffort: 'high' }, 'PATCH')).status, 200);
    assert.equal((await send(`${queue}/q3/move`, { beforeId: 'q2' })).status, 200);
    assert.equal((await app.request(`${queue}/q1`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await send(`${queue}/q3/move`, { beforeId: 'missing' })).status, 400);
    executor.calls.find(call => call.id === first)!.release();
    await until(engine, () => executor.calls.length === 3);
    assert.match(executor.calls[2].text, /Task: Run first/);
    assert.equal(executor.calls[2].id, first);
    assert.equal((await engine.snapshot()).tasks.find(task => task.id === first)?.unread, true, 'automatic queue dispatch must not mark an unseen previous answer as read');
    assert.ok(executor.active.has(other), 'an unrelated thread does not delay this queue');
    executor.calls[2].release();
    await until(engine, () => executor.calls.length === 4);
    assert.match(executor.calls[3].text, /Task: Edited second/);
    assert.equal(executor.calls[3].model, 'different-model'); assert.equal(executor.calls[3].effort, 'high');
    executor.calls[3].release();
    await until(engine, state => state.tasks.find(task => task.id === first)?.queue?.dispatcherId === null);
    task = (await engine.snapshot()).tasks.find(task => task.id === first)!;
    assert.equal(task.status, 'completed');
    assert.deepEqual(task.messages?.map(message => message.text), ['Initial request', 'Answer', 'Run first', 'Answer', 'Edited second', 'Answer']);
    assert.equal(task.queue?.messages.find(message => message.id === 'q1')?.status, 'cancelled');
    assert.equal((await send(`${queue}/q3`, { text: 'Too late' }, 'PATCH')).status, 400);
    executor.calls.find(call => call.id === other)!.release();
    await until(engine, state => state.tasks.every(task => task.status === 'completed'));
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Stopping pauses queued messages; explicit resume is deduplicated and preserves the remaining order', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  const engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('stop')); await until(engine, () => executor.calls.length === 1);
    await engine.taskQueue.enqueue(id, { text: 'After stop one' }, 'q1');
    await engine.taskQueue.enqueue(id, { text: 'After stop two' }, 'q2');
    await engine.cancel(id);
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
    assert.equal(executor.calls.length, 1);
    assert.equal((await engine.snapshot()).tasks[0].queue?.paused, true);
    await Promise.all([engine.taskQueue.resume(id, 'resume-1'), engine.taskQueue.resume(id, 'resume-1')]);
    await until(engine, () => executor.calls.length === 2);
    assert.match(executor.calls[1].text, /Task: After stop one/);
    await engine.cancel(id);
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
    assert.equal(executor.calls.length, 2);
    await engine.taskQueue.resume(id, 'resume-2');
    await until(engine, () => executor.calls.length === 3);
    assert.match(executor.calls[2].text, /Task: After stop two/);
    executor.calls[2].release();
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
    assert.equal((await engine.snapshot()).tasks[0].queue?.messages[0].status, 'failed');
    assert.equal((await engine.snapshot()).tasks[0].queue?.messages[1].status, 'completed');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('A crash never replays uncertain execution and retains queued edits for explicit continuation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  let engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('restart')); await until(engine, () => executor.calls.length === 1);
    await engine.taskQueue.enqueue(id, { text: 'Original queued text' }, 'q1');
    await engine.taskQueue.edit(id, 'q1', { text: 'Saved queued edit' });
    await engine.close(); engine = await new Engine(directory, executor).open();
    await until(engine, state => state.tasks[0].status === 'interrupted' && state.tasks[0].queue?.dispatcherId === null);
    assert.equal(executor.calls.length, 1);
    assert.equal((await engine.snapshot()).tasks[0].queue?.messages[0].text, 'Saved queued edit');
    await engine.taskQueue.resume(id, 'explicit-resume');
    await until(engine, () => executor.calls.length === 2);
    assert.match(executor.calls[1].text, /Task: Saved queued edit/);
    executor.calls[1].release();
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
    assert.equal(executor.calls.length, 2);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Promotion uses persisted steer receipts and an uncertain delivery never becomes another queued turn', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  let engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('promote')); await until(engine, () => executor.calls.length === 1);
    await engine.taskQueue.enqueue(id, { text: 'Steer once' }, 'q1');
    await engine.taskQueue.enqueue(id, { text: 'Uncertain steer' }, 'q2');
    await engine.taskQueue.promote(id, 'q1');
    executor.failSteer = true;
    await assert.rejects(engine.taskQueue.promote(id, 'q2'), /尚未确认/);
    await assert.rejects(engine.taskQueue.promote(id, 'q2'), /当前不能/);
    assert.deepEqual(executor.steers, ['Steer once', 'Uncertain steer']);
    executor.calls[0].release();
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
    assert.equal(executor.calls.length, 1);
    assert.equal((await engine.snapshot()).tasks[0].queue?.messages[1].status, 'uncertain');
    await engine.close(); engine = await new Engine(directory, executor).open();
    assert.equal(executor.calls.length, 1);
    assert.equal((await engine.snapshot()).tasks[0].messages?.find(message => message.text === 'Uncertain steer')?.delivery, 'uncertain');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Queue API requires authentication, validates dispatch and cancels queue ownership before deleting a thread', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  try {
    const id = await engine.createTask(input('delete')); await until(engine, () => executor.calls.length === 1);
    const path = `/api/tasks/${id}/message`;
    assert.equal((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await app.request(path, { method: 'POST', headers, body: JSON.stringify({ text: 'Bad mode', requestId: 'bad', dispatchMode: 'typo' }) })).status, 400);
    await engine.taskQueue.enqueue(id, { text: 'Never run after delete' }, 'pending');
    assert.equal((await app.request(`/api/tasks/${id}`, { method: 'DELETE', headers })).status, 200);
    assert.equal((await engine.snapshot()).tasks.length, 0);
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.active.size, 0);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Connecting providers retain even an explicit steer as queued input, including image-only edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  const engine = await new Engine(directory, executor).open(); const auth = new Auth(directory); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  try {
    const id = await engine.createTask(input('readiness')); await until(engine, () => executor.calls.length === 1);
    await engine.updateExecution(id, { kind: 'ready', canSteer: false });
    const image = await new IdeaImages(directory).save({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', name: 'queued.png' });
    const response = await app.request(`/api/tasks/${id}/message`, { method: 'POST', headers,
      body: JSON.stringify({ text: '', images: [image], requestId: 'image-only-queue', dispatchMode: 'steer' }) });
    assert.equal(response.status, 200);
    assert.equal(executor.steers.length, 0);
    await assert.rejects(engine.taskQueue.promote(id, 'image-only-queue'), /当前不能/);
    assert.equal((await app.request(`/api/tasks/${id}/queue/image-only-queue`, { method: 'PATCH', headers, body: JSON.stringify({ text: '' }) })).status, 200);
    assert.equal((await engine.snapshot()).tasks[0].queue?.messages[0].images[0].id, image.id, 'text-only PATCH retains the existing host image');
    await engine.taskQueue.remove(id, 'image-only-queue');
    executor.calls[0].release();
    await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
  } finally { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Recovery distinguishes acknowledged, uncertain and never-attempted promotions without executing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  let engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('promotion-recovery')); await until(engine, () => executor.calls.length === 1);
    executor.calls[0].release(); await until(engine, state => state.tasks[0].status === 'completed');
    await engine.mutate(state => {
      const task = state.tasks[0];
      task.messages!.push({ id: 'sent-receipt', role: 'user', text: 'Sent', delivery: 'sent' }, { id: 'lost-receipt', role: 'user', text: 'Uncertain', delivery: 'sending' });
      task.queue = { dispatcherId: null, paused: true, messages: [
        { id: 'sent', dispatchId: 'sent-receipt', text: 'Sent', images: [], createdAt: task.updatedAt, status: 'steering' },
        { id: 'uncertain', dispatchId: 'lost-receipt', text: 'Uncertain', images: [], createdAt: task.updatedAt, status: 'steering' },
        { id: 'unsent', dispatchId: 'no-receipt', text: 'Unsent', images: [], createdAt: task.updatedAt, status: 'steering' },
      ] };
    });
    await engine.close(); engine = await new Engine(directory, executor).open();
    const state = await engine.snapshot();
    assert.deepEqual(state.tasks[0].queue?.messages.map(message => message.status), ['completed', 'uncertain', 'queued']);
    assert.equal(executor.calls.length, 1);
    assert.equal(executor.steers.length, 0);
    assert.equal(state.tasks[0].id, id);
    assert.equal(state.tasks[0].canSteer, false, 'a restarted service never advertises a stale live capability');
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Startup and shutdown hold unsent queues even after a known completed turn, until explicit resume', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-queue-')); const executor = new ControlledExecutor();
  let engine = await new Engine(directory, executor).open();
  try {
    const id = await engine.createTask(input('known-completed')); await until(engine, () => executor.calls.length === 1);
    executor.calls[0].release(); await until(engine, state => state.tasks[0].status === 'completed');
    await engine.mutate(state => {
      state.tasks[0].queue = { dispatcherId: null, paused: false, messages: [{ id: 'held', dispatchId: 'held-dispatch', text: 'Queued before close', images: [], createdAt: state.tasks[0].updatedAt, status: 'queued' }] };
    });
    await engine.close(); engine = await new Engine(directory, executor).open();
    const held = (await engine.snapshot()).tasks[0];
    assert.equal(held.status, 'completed');
    assert.equal(held.queue?.paused, true);
    assert.equal(held.queue?.messages[0].status, 'queued');
    assert.equal(executor.calls.length, 1, 'a known-unsent message still follows T3 explicit startup resume');
    await engine.taskQueue.resume(id, 'resume-held');
    await until(engine, () => executor.calls.length === 2);
    assert.match(executor.calls[1].text, /Task: Queued before close/);
    executor.calls[1].release(); await until(engine, state => state.tasks[0].queue?.dispatcherId === null);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
