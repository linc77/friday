import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Harness, defineDoc, createRegistry, type ConversationId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Engine } from '../src/engine.js';
import { ModelConnection } from '../src/model.js';
import { WorkspaceDoc } from '../src/state.js';
import { openFridayStorage } from '../src/durable-image-storage.js';
import { imageRetentionMs } from '../src/ideas.js';
import { backupNoteDatabase } from '../src/image-backup.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
const id = createHash('sha256').update(png).digest('hex');
const metadata = { id, name: '图片.png', mediaType: 'image/png' };
const upload = { id, name: metadata.name, data: png.toString('base64') };
const note = (id: string) => ({ id, text: '正文', createdAt: '2026-11-07T00:00:00Z', taskId: null, images: [metadata] });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(ready => { resolve = ready; }); return { promise, resolve }; };

test('BLOB uploads deduplicate, stay out of snapshots and rebuild stable Agent exports', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-db-'));
  const engine = await new Engine(directory).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await Promise.all([engine.images.save(upload), engine.images.save({ ...upload, name: 'another.png' })]);
  await assert.rejects(readFile(join(directory, 'idea-images', id)), { code: 'ENOENT' });
  await engine.mutate(state => { state.ideas.push(note('one'), note('two')); });
  const db = new DatabaseSync(join(directory, 'friday.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friday_assets').get()!.n, 1); }
  finally { db.close(); }
  assert(!JSON.stringify(await engine.snapshot()).includes(upload.data));
  const [exported] = await engine.images.resolve([metadata]);
  assert.equal(exported!.path, join(directory, 'idea-images', id));
  await writeFile(exported!.path, 'changed by a tool');
  await engine.images.resolve([metadata]);
  assert.deepEqual(await readFile(exported!.path), png);
  await rm(exported!.path);
  await engine.images.resolve([metadata]);
  assert.deepEqual(await readFile(exported!.path), png);
});

test('Missing image rejects the entire Durable commit and does not poison subsequent edits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-rollback-'));
  const engine = await new Engine(directory).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const before = await engine.snapshot();
  await assert.rejects(engine.mutate(state => {
    state.ideas.push(note('must-rollback'));
    state.memories.push({ id: 'receipt', text: 'must also roll back', updatedAt: '' });
  }), /图片.*尚未上传/);
  assert.deepEqual(await engine.snapshot(), before);
  await engine.images.save(upload);
  await engine.mutate(state => { state.ideas.push(note('retry')); });
  assert.equal((await engine.snapshot()).ideas[0]!.id, 'retry');
  await engine.mutate(state => { state.ideas[0]!.text = '只修改文字'; });
  await assert.rejects(engine.mutate(state => { state.ideas[0]!.images![0]!.id = 'a'.repeat(64); }), /尚未上传/);
  assert.equal((await engine.snapshot()).ideas[0]!.images![0]!.id, id, 'A leaf ID edit still validates inside the transaction');
  await engine.mutate(state => { state.ideas.unshift({ ...note('before'), images: [] }); });
  await engine.mutate(state => { state.ideas.reverse(); });
  await assert.rejects(engine.mutate(state => { state.ideas[0]!.images![0]!.id = 'a'.repeat(64); }), /尚未上传/, 'Array insertions/reorders must invalidate cached image paths');
});

test('Unrelated uploads cannot enter a suspended Durable SQL transaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-concurrency-'));
  const engine = await new Engine(directory).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.images.save(upload);
  const gate = deferred(), entered = deferred();
  const replace = engine.images.replaceReferences.bind(engine.images);
  engine.images.replaceReferences = async (...args) => { entered.resolve(); await gate.promise; return replace(...args); };
  const saving = engine.mutate(state => { state.ideas.push(note('one')); });
  await entered.promise;
  let uploaded = false;
  const uploading = engine.images.save({ data: Buffer.concat([png, Buffer.from([0])]).toString('base64') }).then(() => { uploaded = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploaded, false, 'The upload must wait for the complete outer transaction');
    const db = new DatabaseSync(join(directory, 'friday.sqlite'), { readOnly: true });
    try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM friday_asset_refs').get()!.n, 0, 'Another connection cannot observe partial references'); }
    finally { db.close(); }
  } finally { gate.resolve(); }
  await Promise.all([saving, uploading]);
  engine.images.replaceReferences = replace;
  assert.equal(uploaded, true);
  assert.equal((await engine.snapshot()).ideas[0]!.id, 'one');
});

test('GC respects shared notes, upload leases, last-detachment grace and commit-time revalidation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-gc-'));
  const engine = await new Engine(directory).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.images.save(upload);
  assert.equal(await engine.images.collect(), 0, 'In-flight uploads remain pinned');
  await engine.mutate(state => { state.ideas.push(note('one'), note('two')); });
  await engine.mutate(state => { state.ideas = state.ideas.filter(value => value.id !== 'one'); });
  assert.equal(await engine.images.collect(Date.now() + imageRetentionMs * 2), 0, 'Another note still owns this hash');
  await engine.mutate(state => { state.ideas = []; });
  assert.equal(await engine.images.collect(), 0, 'Removing the last owner starts a fresh grace period');
  await engine.images.validate([metadata]);
  assert.equal(await engine.images.collect(Date.now() + imageRetentionMs * 2), 1);
  await assert.rejects(engine.mutate(state => { state.ideas.push(note('raced-with-gc')); }), /尚未上传/);
  assert.equal((await engine.snapshot()).ideas.length, 0);
  await engine.images.save(upload);
  await engine.mutate(state => { state.ideas.push(note('retry')); });
});

test('SQLite backup restores notes and images without a source image directory; refuses overwrite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-backup-'));
  const restored = await mkdtemp(join(tmpdir(), 'friday-image-restore-'));
  const engine = await new Engine(directory).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); await rm(restored, { recursive: true, force: true }); });
  await engine.images.save(upload);
  await engine.mutate(state => { state.ideas.push(note('backup')); });
  const target = join(restored, 'friday.sqlite');
  assert.deepEqual(await backupNoteDatabase(join(directory, 'friday.sqlite'), target), { images: 1, bytes: png.length });
  await assert.rejects(backupNoteDatabase(join(directory, 'friday.sqlite'), target), { code: 'EEXIST' });
  const cli = await promisify(execFile)('pnpm', ['notes:backup', join(restored, 'cli.sqlite')], { env: { ...process.env, FRIDAY_DATA_DIR: directory } });
  assert.match(cli.stdout, /已导出正文与 1 张图片/);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const recovered = await new Engine(restored).open();
  try {
    assert.equal((await recovered.snapshot()).ideas[0]!.text, '正文');
    const [file] = await recovered.images.resolve([metadata]);
    assert.deepEqual(await readFile(file!.path), png);
  } finally { await recovered.close(); }
});

test('Legacy file migration verifies bytes, backfills references, resumes and retains original files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'idea-images'));
  await writeFile(join(directory, 'idea-images', id), png);
  const legacy = await Harness.open(await openNodeSqliteStorage(join(directory, 'friday.sqlite')), { models: new ModelConnection(directory).models, registry: createRegistry() }, context);
  await (await legacy.root(context)).commit(async tx => { (await tx.doc(WorkspaceDoc)).ideas.push(note('legacy')); }, context);
  await legacy.close(context);
  const wrongID = 'f'.repeat(64);
  await writeFile(join(directory, 'idea-images', wrongID), png);
  await assert.rejects(openFridayStorage(directory), /校验失败/);
  assert.deepEqual(await readFile(join(directory, 'idea-images', id)), png);
  await rm(join(directory, 'idea-images', wrongID));
  const migrated = await openFridayStorage(directory);
  try {
    assert.deepEqual((await migrated.images.read(id)).data, png);
    assert.equal(await migrated.images.collect(Date.now() + imageRetentionMs * 2), 0, 'Existing notes are indexed before collection');
  } finally { await migrated.storage.close(context); }
  const again = await openFridayStorage(directory);
  try { assert.deepEqual((await again.images.read(id)).data, png); }
  finally { await again.storage.close(context); }
  assert.deepEqual(await readFile(join(directory, 'idea-images', id)), png);
});

test('Rewindable Durable history retains images after the current document removes them', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-image-history-'));
  const opened = await openFridayStorage(directory);
  const harness = await Harness.open(opened.storage, { models: new ModelConnection(directory).models, registry: createRegistry() }, context);
  t.after(async () => { await harness.close(context); await rm(directory, { recursive: true, force: true }); });
  const doc = defineDoc<{ images: typeof metadata[] }>({ kind: 'image.history.test', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf', initial: () => ({ images: [] }) });
  const root = await harness.root(context);
  await opened.images.save(upload);
  await root.commit(async tx => { (await tx.doc(doc, root.id as ConversationId)).images = [metadata]; }, context);
  await root.commit(async tx => { (await tx.doc(doc, root.id as ConversationId)).images = []; }, context);
  assert.equal(await opened.images.collect(Date.now() + imageRetentionMs * 2), 0);
});
