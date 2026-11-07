import { AsyncLocalStorage } from 'node:async_hooks';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageRejected, type DocumentRecord, type Storage, type StorageWrite, type Seq } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Op } from '@earendil-works/chord/delta';
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { IdeaImages, referencedImages, type ImageReferencePath } from './ideas.js';

/** A transaction-scoped facade over Durable's public database interface. Only
 * the admitted callback sees its executor; unrelated uploads/GC wait in the
 * underlying adapter's queue. No second connection and no nested SQL BEGIN. */
class SharedDatabase implements SqliteDatabase {
  private scope = new AsyncLocalStorage<SqliteExecutor>();
  constructor(private db: SqliteDatabase) {}
  private executor() { return this.scope.getStore() ?? this.db; }
  exec(sql: string) { return this.executor().exec(sql); }
  run(sql: string, ...params: SqliteValue[]) { return this.executor().run(sql, ...params); }
  get<T extends object>(sql: string, ...params: SqliteValue[]) { return this.executor().get<T>(sql, ...params); }
  all<T extends object>(sql: string, ...params: SqliteValue[]) { return this.executor().all<T>(sql, ...params); }
  transaction<T>(callback: (tx: SqliteExecutor) => Promise<T>): Promise<T> {
    const current = this.scope.getStore();
    return current ? callback(current) : this.db.transaction(tx => this.scope.run(tx, () => callback(tx)));
  }
  close() { return this.db.close(); }
}

const rewindable = (record: DocumentRecord) => record.scope.kind === 'conversation' && record.history === 'rewindable';

function affectsImages(op: Op, paths: readonly ImageReferencePath[]) {
  if (op[0] === 'r') return true;
  const changed = op[1];
  if (changed.includes('images') || paths.some(path => path.slice(0, Math.min(path.length, changed.length)).every((segment, index) => segment === changed[index]))) return true;
  const insertedPaths: ImageReferencePath[] = [];
  if (op[0] === 's') referencedImages(op[2], new Set(), insertedPaths);
  if (op[0] === 'p') referencedImages(op[4], new Set(), insertedPaths);
  return insertedPaths.length > 0;
}

async function captureWrites(storage: Storage, images: IdeaImages, tx: SqliteExecutor, writes: readonly StorageWrite[], seq: Seq, cache: Map<number, ImageReferencePath[]>) {
  const updated = new Map<number, ImageReferencePath[]>();
  const documents = new Set(writes.flatMap(write => write.type.startsWith('document.')
    ? ['record' in write ? write.record.id : 'id' in write ? write.id : undefined].filter(id => id !== undefined) : []));
  for (const id of documents) {
    const paths = cache.get(id);
    const changes = writes.filter(write => 'id' in write && write.id === id || 'record' in write && write.record.id === id);
    // Text/token deltas outside every image subtree need no materialization or
    // reference writes. Array splices/reorders above images invalidate paths.
    if (paths && changes.every(write => write.type === 'document.change' && write.content.kind === 'delta' && !write.content.ops.some(op => affectsImages(op, paths)))) continue;
    const document = await storage.document(id, 'current', BACKGROUND_CONTEXT);
    // Retiring latest-only documents drops their live references. Rewindable
    // revisions each have their own owner and remain protected for as-of reads.
    if (!document) { await images.replaceReferences(tx, `document:${id}`, new Set()); updated.set(id, []); continue; }
    const owner = `document:${id}` + (rewindable(document.record) ? `:${seq}` : '');
    const nextPaths: ImageReferencePath[] = [];
    await images.replaceReferences(tx, owner, referencedImages(document.value, new Set(), nextPaths));
    updated.set(id, nextPaths);
  }
  for (const write of writes) if ('value' in write) {
    await images.replaceReferences(tx, `${write.type}:${write.value.id}`, referencedImages(write.value));
  }
  return updated;
}

/** One-time reference-index backfill for the pinned Durable SQLite v1 schema.
 * SQL only enumerates records; document materialization stays with Durable. */
async function seedReferences(storage: Storage, images: IdeaImages, db: SharedDatabase) {
  if (await db.get("SELECT value FROM friday_asset_state WHERE key='references-v1'")) return;
  if ((await db.get<{ version: number }>('SELECT version FROM durable_schema WHERE singleton=1'))?.version !== 1) throw new Error('图片迁移不支持这个 Pi Durable 数据库版本');
  for (const table of ['documents', 'tasks', 'entries', 'submissions', 'conversations'] as const) {
    let after = 0;
    for (;;) {
      const rows = await db.all<{ id: number; record: string }>(`SELECT id,record FROM ${table} WHERE id>? ORDER BY id LIMIT 100`, after);
      if (!rows.length) break;
      for (const row of rows) {
        await db.transaction(async tx => {
          const record = JSON.parse(row.record);
          if (table === 'documents') {
            const documentRecord = record as DocumentRecord;
            const points = rewindable(documentRecord)
              ? (await tx.all<{ seq: Seq }>('SELECT seq FROM document_revisions WHERE document_id=? ORDER BY seq', row.id)).map(value => value.seq)
              : ['current' as const];
            for (const point of points) {
              const document = await storage.document(documentRecord.id, point, BACKGROUND_CONTEXT);
              if (document) await images.replaceReferences(tx, `document:${row.id}` + (point === 'current' ? '' : `:${point}`), referencedImages(document.value));
            }
          } else await images.replaceReferences(tx, `${table === 'entries' ? 'entry' : table.slice(0, -1)}:${row.id}`, referencedImages(record));
        });
        after = row.id;
      }
    }
  }
  await db.run("INSERT INTO friday_asset_state(key,value) VALUES('references-v1','complete')");
}

export async function openFridayStorage(directory: string) {
  const path = join(directory, 'friday.sqlite');
  const db = new SharedDatabase(await openNodeSqliteDatabase(path));
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    await chmod(path, 0o600);
    await db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const durable = await SqliteStorage.open(db);
    const images = new IdeaImages(directory, db);
    await images.initialize();
    await images.migrateLegacy();
    await seedReferences(durable, images, db);
    await db.run("INSERT OR REPLACE INTO friday_asset_state(key,value) VALUES('legacy-import-v1','complete')");
    const paths = new Map<number, ImageReferencePath[]>();
    const commit: Storage['commit'] = async (writes, context) => {
      const committed = await db.transaction(async tx => {
        const seq = await durable.commit(writes, context);
        try { return { seq, updated: await captureWrites(durable, images, tx, writes, seq, paths) }; }
        catch (cause) {
          // This error exits the outer transaction, which must roll back before
          // Session sees StorageRejected. A rollback failure remains fatal.
          throw new StorageRejected(cause instanceof Error ? cause.message : '图片引用保存失败', { cause });
        }
      });
      // Never adopt path hints for a rolled-back document. This bounded cache
      // contains paths only, not whole Workspace documents or image bytes.
      for (const [id, next] of committed.updated) { paths.delete(id); paths.set(id, next); }
      while (paths.size > 256) paths.delete(paths.keys().next().value!);
      return committed.seq;
    };
    const storage: Storage = new Proxy(durable, {
      get(target, property, receiver) {
        if (property === 'commit') return commit;
        if (property === 'close') return async (context: Parameters<Storage['close']>[0]) => { clearInterval(timer); await target.close(context); };
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    timer = setInterval(() => { void images.collect().catch(() => console.error('[Friday images] cleanup failed')); }, 60 * 60 * 1000);
    timer.unref();
    return { storage, images };
  } catch (error) { clearInterval(timer); await db.close().catch(() => {}); throw error; }
}
