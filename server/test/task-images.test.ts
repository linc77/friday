import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, ExecutionImage, Executor, WorkItem } from '../src/types.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';
class ImageExecutor implements Executor {
  requests: ExecutionRequest[] = [];
  messages: { text: string; images?: ExecutionImage[] }[] = [];
  releases: (() => void)[] = [];
  loseReceipt = false;
  async run(request: ExecutionRequest) {
    this.requests.push(request);
    await request.update({ kind: 'session', threadId: 'image-session' });
    await request.update({ kind: 'turn', turnId: `turn-${this.requests.length}` });
    await new Promise<void>((resolve, reject) => {
      this.releases.push(resolve);
      request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    return 'Image inspected';
  }
  async answer() {}
  async steer(_id: string, text: string, _request: string, images?: ExecutionImage[]) {
    this.messages.push({ text, images });
    if (this.loseReceipt) throw new Error('lost receipt');
  }
}
async function until(engine: Engine, predicate: (task: WorkItem) => boolean) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = (await engine.snapshot()).tasks[0];
    if (task && predicate(task)) return task;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Image task transition timed out');
}

test('Image-only tasks, continuation and live attachments retain metadata, deliver bytes and deduplicate lost receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-images-'));
  const executor = new ImageExecutor(); let engine = await new Engine(directory, executor).open();
  const auth = new Auth(directory); let app = createAPI(engine, auth);
  const request = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const image = await (await request('/api/idea-images', { data: png, name: '参考.png' })).json();
    const input = { agent: 'codex', mode: 'research', prompt: '', requestId: 'image-only', images: [image] };
    const created = await request('/api/tasks', input); assert.equal(created.status, 201, await created.clone().text());
    const { id } = await created.json();
    const running = await until(engine, task => task.turnId !== null);
    assert.equal(running.title, '图片任务'); assert.equal(running.messages?.[0]?.text, '');
    assert.deepEqual(running.messages?.[0]?.images, [image]);
    assert.equal((await (await request('/api/tasks', input)).json()).id, id);
    assert.equal(executor.requests.length, 1);
    assert.deepEqual(await readFile(executor.requests[0]!.images![0]!.path), Buffer.from(png, 'base64'));
    const live = { text: '参考这张图片', requestId: 'live-image', images: [image] };
    assert.equal((await request(`/api/tasks/${id}/message`, live)).status, 200);
    assert.equal((await request(`/api/tasks/${id}/message`, live)).status, 200);
    assert.equal(executor.messages.length, 1);
    assert.deepEqual(await readFile(executor.messages[0]!.images![0]!.path), Buffer.from(png, 'base64'));
    assert.equal((await engine.snapshot()).tasks[0]!.messages?.at(-1)?.delivery, 'sent');
    executor.releases[0]!(); await until(engine, task => task.status === 'completed');
    await engine.close(); engine = await new Engine(directory, executor).open(); app = createAPI(engine, auth);
    assert.deepEqual((await engine.snapshot()).tasks[0]!.messages?.[0]?.images, [image]);
    assert.ok(!JSON.stringify(await engine.snapshot()).includes(png), 'SSE and Durable snapshots contain references only');
    assert.equal((await request(`/api/tasks/${id}/message`, live)).status, 200);
    assert.equal(executor.messages.length, 1, 'Completed turns also deduplicate a lost live receipt');
    assert.equal((await request(`/api/tasks/${id}/message`, { text: '', requestId: 'image-followup', images: [image] })).status, 200);
    await until(engine, task => task.turnId === 'turn-2');
    assert.equal(executor.requests[1]!.task.threadId, 'image-session');
    assert.deepEqual(executor.requests[1]!.images?.map(value => value.id), [image.id]);
    executor.releases[1]!(); await until(engine, task => task.status === 'completed');
    assert.equal((await request(`/api/tasks/${id}/message`, { text: '继续', requestId: 'text-followup' })).status, 200);
    await until(engine, task => task.turnId === 'turn-3');
    assert.deepEqual(executor.requests[2]!.images, [], 'Past images are not replayed on an ordinary follow-up');
    executor.loseReceipt = true;
    const uncertain = { text: '  ', images: [image], requestId: 'uncertain-image' };
    assert.equal((await request(`/api/tasks/${id}/message`, uncertain)).status, 400);
    assert.equal((await request(`/api/tasks/${id}/message`, uncertain)).status, 400);
    assert.equal(executor.messages.length, 2, 'An uncertain external message must never be replayed');
    assert.equal((await engine.snapshot()).tasks[0]!.messages?.at(-1)?.delivery, 'uncertain');
    executor.releases[2]!(); await until(engine, task => task.status === 'completed');
    assert.equal((await request(`/api/tasks/${id}/message`, uncertain)).status, 400);
    assert.equal(executor.messages.length, 2);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Task images require uploaded IDs, bounded counts, supported agents and valid prompt text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-task-image-validation-'));
  const engine = await new Engine(directory, new ImageExecutor()).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth);
  const request = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const image = await (await request('/api/idea-images', { data: png, name: 'image.png' })).json();
    const base = { agent: 'codex', mode: 'research', prompt: '查看图片', requestId: 'bad' };
    for (const input of [
      { ...base, images: [{ ...image, id: '../owner-token' }] },
      { ...base, images: [{ ...image, id: 'a'.repeat(64) }] },
      { ...base, images: Array(21).fill(image) },
      { ...base, prompt: '' }, { ...base, prompt: 'a'.repeat(12001), images: [image] },
      { ...base, agent: 'friday', images: [image] },
    ]) assert.equal((await request('/api/tasks', input)).status, 400);
    assert.equal((await engine.snapshot()).tasks.length, 0);
    assert.equal((await app.request(`/api/idea-images/${image.id}`)).status, 401);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
