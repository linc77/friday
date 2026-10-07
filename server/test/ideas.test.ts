import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=';

test('Notes retain original capture time, rich content and authenticated images across a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-notes-'));
  let engine = await new Engine(directory).open();
  const auth = new Auth(directory);
  const pairing = auth.createPairing(); const device = auth.pair(pairing.code, 'Phone', 'test');
  let app = createAPI(engine, auth);
  const request = (path: string, body?: unknown, method = 'POST') => app.request(path, { method, headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await (await request('/api/state', undefined, 'GET')).json()).notesVersion, 1);
    const upload = await request('/api/idea-images', { data: png, name: '日记.png' });
    assert.equal(upload.status, 201); const image = await upload.json();
    assert.match(image.id, /^[a-f0-9]{64}$/);
    const repeat = await request('/api/idea-images', { id: image.id, data: png, name: image.name });
    assert.deepEqual(await repeat.json(), image);
    const createdAt = '2026-10-06T12:34:56.000Z';
    const text = `## 今天\n\n[参考](https://example.com)\n\n![日记](friday-image:${image.id})\n\n${'日记内容。'.repeat(4000)}`;
    const response = await request('/api/ideas', { id: 'diary', title: '今天的日记', text, images: [image], createdAt });
    assert.equal(response.status, 201); const note = await response.json();
    assert.equal(note.createdAt, createdAt); assert.equal(note.text, text);
    assert.deepEqual(note.images, [image]);
    const retry = await request('/api/ideas', { id: 'diary', text: 'This must never overwrite an offline retry' });
    assert.deepEqual(await retry.json(), note);
    assert.equal((await app.request(`/api/idea-images/${image.id}`)).status, 401);
    await engine.close(); engine = await new Engine(directory).open(); app = createAPI(engine, auth);
    assert.deepEqual((await engine.snapshot()).ideas[0], note);
    const downloaded = await request(`/api/idea-images/${image.id}`, undefined, 'GET');
    assert.equal(downloaded.headers.get('Content-Type'), 'image/png');
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.from(png, 'base64'));
    assert.ok(JSON.stringify(await engine.snapshot()).length < text.length + 2000, 'Binary data must not bloat SSE or Durable workspace state');
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Editing preserves creation and delegation, detects another device edit, and retries a lost response safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-edit-'));
  const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth);
  const request = (path: string, body: unknown, method = 'POST') => app.request(path, { method, headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    // A note made by an older client has no optional fields.
    await engine.mutate(s => { s.ideas.push({ id: 'legacy', text: '以前的想法', createdAt: '2026-10-05T00:00:00.000Z', taskId: 'conversation' }); });
    const body = { title: '工作资料', text: '**继续整理**\n\nhttps://example.com', expectedUpdatedAt: '2026-10-05T00:00:00.000Z', editId: 'first-edit' };
    const edited = await request('/api/ideas/legacy', body, 'PUT');
    assert.equal(edited.status, 200, await edited.clone().text()); const note = await edited.json();
    assert.equal(note.createdAt, body.expectedUpdatedAt); assert.equal(note.taskId, 'conversation');
    assert.notEqual(note.updatedAt, note.createdAt);
    assert.deepEqual(await (await request('/api/ideas/legacy', body, 'PUT')).json(), note, 'Lost edit receipts are idempotent');
    const conflict = await request('/api/ideas/legacy', { ...body, text: '其他设备的旧版本', editId: 'second-edit' }, 'PUT');
    assert.equal(conflict.status, 409); assert.equal((await engine.snapshot()).ideas[0].text, body.text);
    const newer = await request('/api/ideas/legacy', { ...body, text: '核对后继续编辑', expectedUpdatedAt: note.updatedAt, editId: 'third-edit' }, 'PUT');
    assert.equal(newer.status, 200);
    assert.ok((await newer.json()).updatedAt > note.updatedAt);
    assert.equal((await request('/api/ideas/missing', body, 'PUT')).status, 404);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Notes reject missing images, invalid content and image path traversal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-note-validation-'));
  const engine = await new Engine(directory).open(); const auth = new Auth(directory);
  const app = createAPI(engine, auth);
  const request = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const body of [{ text: '' }, { title: 'a'.repeat(201), text: 'Note' }, { text: 'a'.repeat(100001) }, { text: 'Note', images: [{ id: 'a'.repeat(64), name: 'Missing', mediaType: 'image/png' }] }, { text: 'Note', images: [{ id: '../owner-token', name: 'Invalid', mediaType: 'image/png' }] }]) {
      assert.equal((await request('/api/ideas', body)).status, 400);
    }
    assert.equal((await request('/api/idea-images', { data: Buffer.from('<svg/>').toString('base64') })).status, 400);
    assert.equal((await request('/api/idea-images', { data: png, id: 'b'.repeat(64) })).status, 400);
    const titleOnly = await request('/api/ideas', { title: '一个标题' }); assert.equal(titleOnly.status, 201);
    const image = await (await request('/api/idea-images', { data: png })).json();
    assert.equal((await request('/api/ideas', { images: [image] })).status, 201, 'An image-only note is valid');
    assert.equal((await engine.snapshot()).ideas.length, 2);
  } finally { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); }
});
