import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SourceControlReadCache, SQLiteSourceControlReadStorage, type SourceControlReadStorage } from '../src/source-control-read-cache.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const decode = (value: unknown) => value && typeof value === 'object' && typeof (value as any).title === 'string' ? value as { title: string } : undefined;

test('Concurrent readers share one lookup, values are isolated, TTL expires, and failures are never cached', async t => {
  let now = 0, reads = 0; const cache = new SourceControlReadCache(undefined, () => now); t.after(() => cache.close());
  const read = async () => { reads++; return { title: 'fresh' }; };
  const values = await Promise.all([cache.get('same', read), cache.get('same', read)]); assert.equal(reads, 1);
  values[0].title = 'caller'; assert.equal((await cache.get('same', read)).title, 'fresh'); assert.equal(values[1].title, 'fresh');
  now = 60000; await cache.get('same', read); assert.equal(reads, 2);
  for (let i = 0; i < 2; i++) await assert.rejects(cache.get('failed', async () => { reads++; throw new Error('Synthetic'); })); assert.equal(reads, 4);
});
test('Cancelling one subscriber preserves another; cancelling the final subscriber aborts transport', async t => {
  const cache = new SourceControlReadCache(); t.after(() => cache.close()); let release!: () => void, calls = 0, aborted = 0;
  const read = (signal: AbortSignal) => new Promise<number>((resolve, reject) => { calls++; release = () => resolve(7); signal.addEventListener('abort', () => { aborted++; reject(signal.reason); }, { once: true }); });
  const controller = new AbortController(), first = cache.get('shared', read, { signal: controller.signal }), second = cache.get('shared', read); const rejected = assert.rejects(first);
  await tick(); controller.abort(); await rejected; assert.equal(aborted, 0); release(); assert.equal(await second, 7); assert.equal(calls, 1);
  const all = new AbortController(), pending = cache.get('cancel-all', read, { signal: all.signal }); const stopped = assert.rejects(pending); await tick(); all.abort(); await stopped; assert.equal(aborted, 1);
});
test('Invalidation waits for active reads and blocks later readers until its revision is durable', async t => {
  const cache = new SourceControlReadCache(); t.after(() => cache.close()); const order: string[] = []; let release!: () => void;
  const first = cache.get('request', async () => { order.push('old-start'); await new Promise<void>(resolve => { release = resolve; }); order.push('old-finish'); return 'old'; }, { scopes: ['pr'] });
  await tick(); const invalidated = cache.invalidate('pr').then(() => order.push('invalidated'));
  const second = cache.get('request', async () => { order.push('fresh'); return 'new'; }, { scopes: ['pr'] });
  await tick(); assert.deepEqual(order, ['old-start']); release(); assert.equal(await first, 'old'); await invalidated; assert.equal(await second, 'new'); assert.deepEqual(order, ['old-start', 'old-finish', 'invalidated', 'fresh']);
});
test('Scope invalidation preserves unrelated entries, while global invalidation clears both', async t => {
  const cache = new SourceControlReadCache(); t.after(() => cache.close()); let reads = 0;
  const read = async () => ++reads; await cache.get('a', read, { scopes: ['a'] }); await cache.get('b', read, { scopes: ['b'] });
  await cache.invalidate('a'); await cache.get('b', read, { scopes: ['b'] }); assert.equal(reads, 2); await cache.get('a', read, { scopes: ['a'] }); assert.equal(reads, 3);
  await cache.invalidate('global'); await cache.get('b', read, { scopes: ['b'] }); assert.equal(reads, 4);
});
test('Private persisted reads survive restart, retain scope revisions and use hashed keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-pr-cache-')); t.after(() => rm(directory, { recursive: true, force: true })); let now = 0, reads = 0;
  const options = { persist: true, decode, scopes: ['project', 'pr'] }, key = 'github/repo/synthetic-private-credential-key', read = async () => ({ title: 'read-' + ++reads });
  let cache = new SourceControlReadCache(new SQLiteSourceControlReadStorage(directory), () => now);
  assert.equal((await cache.get(key, read, options)).title, 'read-1'); await cache.close();
  const file = join(directory, 'source-control-reads.sqlite'); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const db = new DatabaseSync(file); const row = db.prepare('SELECT key,payload FROM pr_reads').get() as { key: string; payload: string }; assert.match(row.key, /^[a-f\d]{64}$/); assert(!row.payload.includes(key)); db.close();
  cache = new SourceControlReadCache(new SQLiteSourceControlReadStorage(directory), () => now); assert.equal((await cache.get(key, read, options)).title, 'read-1'); assert.equal(reads, 1);
  now = 1; await cache.invalidate('pr'); await cache.close(); cache = new SourceControlReadCache(new SQLiteSourceControlReadStorage(directory), () => now);
  assert.equal((await cache.get(key, read, options)).title, 'read-2'); now = 60002; assert.equal((await cache.get(key, read, options)).title, 'read-3'); await cache.close();
});
test('An invalidation storage failure disables cache reads instead of serving a previous success', async t => {
  let stored: any, reads = 0;
  const storage: SourceControlReadStorage = { get: () => stored, set: (_key, value) => { stored = value; }, revision: () => undefined, invalidate: () => { throw new Error('Synthetic disk failure'); }, prune() {}, close() {} };
  const cache = new SourceControlReadCache(storage); t.after(() => cache.close()); const read = async () => ({ title: String(++reads) });
  await cache.get('request', read, { persist: true, decode }); await cache.invalidate('global'); await cache.get('request', read, { persist: true, decode }); await cache.get('request', read, { persist: true, decode }); assert.equal(reads, 3);
});
test('Bad stored payloads and unavailable storage fall back to live reads without changing their result', async t => {
  const broken: SourceControlReadStorage = { get: () => ({ payload: '{invalid', revision: '', expiresAt: Date.now() + 60000, writtenAt: Date.now() }), set() {}, revision() { return undefined; }, invalidate() {}, prune() {}, close() {} };
  const cache = new SourceControlReadCache(broken); t.after(() => cache.close()); let reads = 0;
  assert.equal((await cache.get('request', async () => ({ title: String(++reads) }), { persist: true, decode })).title, '1');
});
test('Pruning removes day-old read entries and preserves unrelated SQLite data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-pr-prune-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = new SQLiteSourceControlReadStorage(directory); storage.set('old', { payload: '{}', revision: '', expiresAt: 1, writtenAt: 0 }); storage.set('new', { payload: '{}', revision: '', expiresAt: 100, writtenAt: 100 });
  const db = new DatabaseSync(join(directory, 'source-control-reads.sqlite')); db.exec("CREATE TABLE unrelated(value TEXT);INSERT INTO unrelated VALUES('keep')");
  storage.prune(50); assert.equal(storage.get('old'), undefined); assert(storage.get('new')); assert.equal((db.prepare('SELECT value FROM unrelated').get() as any).value, 'keep'); db.close(); storage.close();
});
test('Shutdown aborts running and queued reads and leaves no shared lookup waiting on another caller', async () => {
  const cache = new SourceControlReadCache(); let aborted = false;
  const reads = Array.from({ length: 3 }, () => cache.get('shared', signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }))));
  const settled = Promise.allSettled(reads); await tick(); await cache.close(); assert(aborted); assert((await settled).every(value => value.status === 'rejected')); await assert.rejects(cache.get('closed', async () => 1), /关闭/);
});
