import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, rename, unlink, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SqliteDatabase, SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import type { IdeaImage, ExecutionImage } from './types.js';

export const maxIdeaLength = 100_000;
export const maxImageBytes = 10 * 1024 * 1024;
const maxTotalImageBytes = 80 * 1024 * 1024;
const imageID = /^[a-f0-9]{64}$/;
export class MissingImageError extends Error {}

export function imageType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片');
}

export function ideaContent(body: Record<string, unknown>) {
  const title = body.title ?? '';
  const text = body.text ?? '';
  if (typeof title !== 'string' || title.length > 200 || typeof text !== 'string' || text.length > maxIdeaLength) throw new Error('标题最多 200 字，笔记最多 100,000 字');
  if (!title.trim() && !text.trim() && !(Array.isArray(body.images) && body.images.length)) throw new Error('请写下内容或添加图片');
  return { title: title.trim(), text: text.trim() };
}

export class IdeaImages {
  constructor(private directory: string, private db: SqliteDatabase) {}
  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS friday_assets (
        id TEXT PRIMARY KEY NOT NULL, media_type TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK(byte_length > 0 AND byte_length <= ${maxImageBytes}),
        data BLOB NOT NULL CHECK(length(data) = byte_length), created_at INTEGER NOT NULL,
        unreferenced_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS friday_assets_by_unreferenced ON friday_assets(unreferenced_at) WHERE unreferenced_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS friday_asset_refs (
        owner TEXT NOT NULL, asset_id TEXT NOT NULL REFERENCES friday_assets(id) ON DELETE RESTRICT,
        PRIMARY KEY(owner, asset_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS friday_asset_refs_by_asset ON friday_asset_refs(asset_id);
      CREATE TABLE IF NOT EXISTS friday_asset_uploads (
        asset_id TEXT PRIMARY KEY NOT NULL REFERENCES friday_assets(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS friday_asset_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
    `);
  }
  /** Complete, resumable import; old files are retained as recovery copies. Once
   * marked complete, files at these paths are only rebuildable Agent exports. */
  async migrateLegacy() {
    if (await this.db.get("SELECT value FROM friday_asset_state WHERE key = 'legacy-import-v1'")) return;
    const directory = join(this.directory, 'idea-images');
    const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const id of names.filter(name => imageID.test(name))) {
      const file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || !info.size || info.size > maxImageBytes) throw new Error(`旧图片 ${id} 无效，迁移已停止，原文件已保留`);
        const data = await file.readFile();
        if (createHash('sha256').update(data).digest('hex') !== id) throw new Error(`旧图片 ${id} 校验失败，迁移已停止，原文件已保留`);
        await this.put(id, data, imageType(data));
      } finally { await file.close(); }
    }
  }
  private async put(id: string, data: Buffer, mediaType: string) {
    const now = Date.now();
    await this.db.transaction(async tx => {
      await tx.run('INSERT OR IGNORE INTO friday_assets(id,media_type,byte_length,data,created_at,unreferenced_at) VALUES(?,?,?,?,?,?)', id, mediaType, data.length, data, now, now);
      // One renewable lease per immutable hash protects concurrent uploaders.
      await tx.run('INSERT INTO friday_asset_uploads(asset_id,expires_at) VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET expires_at = MAX(expires_at,excluded.expires_at)', id, now + imageRetentionMs);
    });
  }
  private path(id: string) {
    if (!imageID.test(id)) throw new Error('图片 ID 无效');
    return join(this.directory, 'idea-images', id);
  }
  async save(body: Record<string, unknown>): Promise<IdeaImage> {
    if (typeof body.data !== 'string' || !body.data.length || body.data.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new Error('图片不能为空，且不能超过 10 MB');
    const data = Buffer.from(body.data, 'base64');
    if (data.length > maxImageBytes) throw new Error('图片不能超过 10 MB');
    const mediaType = imageType(data);
    const id = createHash('sha256').update(data).digest('hex');
    if (body.id !== undefined && body.id !== id) throw new Error('图片内容与 ID 不一致');
    const name = typeof body.name === 'string' ? body.name.slice(0, 255) : '图片';
    await this.put(id, data, mediaType);
    return { id, name, mediaType };
  }
  async read(id: string) {
    this.path(id);
    const stored = await this.db.get<{ data: Uint8Array; media_type: string }>('SELECT data,media_type FROM friday_assets WHERE id=?', id);
    if (!stored) throw new Error('图片尚未上传或已过期，请重试保存');
    const data = Buffer.from(stored.data);
    if (createHash('sha256').update(data).digest('hex') !== id || imageType(data) !== stored.media_type) throw new Error('数据库中的图片校验失败，请从备份恢复');
    return { data, mediaType: stored.media_type };
  }
  async validate(value: unknown): Promise<IdeaImage[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 100) throw new Error('最多添加 100 张图片');
    if (!value.length) return [];
    // User validation happens before Durable: 1.5 treats every storage refusal
    // as fatal. Renew the lease atomically with the check so GC cannot remove a
    // validated upload while its request waits to commit the references.
    return this.db.transaction(async tx => {
      const images: IdeaImage[] = [];
      let totalBytes = 0;
      for (const image of value) {
        if (!image || typeof image.id !== 'string' || typeof image.name !== 'string' || image.name.length > 255 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) throw new Error('图片信息无效');
        this.path(image.id);
        const stored = await tx.get<{ byte_length: number; media_type: string }>('SELECT byte_length,media_type FROM friday_assets WHERE id=?', image.id);
        if (!stored) throw new MissingImageError('图片尚未上传，请重试保存');
        totalBytes += stored.byte_length;
        if (totalBytes > maxTotalImageBytes) throw new Error('每条消息的图片总大小不能超过 80 MB');
        if (!images.some(i => i.id === image.id)) images.push({ id: image.id, name: image.name, mediaType: stored.media_type });
      }
      const expires = Date.now() + imageRetentionMs;
      for (const image of images) await tx.run('INSERT INTO friday_asset_uploads(asset_id,expires_at) VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at)', image.id, expires);
      return images;
    });
  }
  async resolve(images: IdeaImage[] = []): Promise<ExecutionImage[]> {
    const result: ExecutionImage[] = [];
    for (const image of await this.validate(images)) {
      const { data } = await this.read(image.id), path = this.path(image.id);
      // Keep historical native-session paths stable. Files are exports, never
      // read back into authoritative storage after migration.
      const cached = await (async () => {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.size !== data.length) return undefined;
          await file.chmod(0o600);
          return await file.readFile();
        } finally { await file.close(); }
      })().catch(() => undefined);
      if (!cached || !cached.equals(data)) {
        await mkdir(join(this.directory, 'idea-images'), { recursive: true, mode: 0o700 });
        const temporary = path + '.' + randomUUID() + '.tmp';
        try { await writeFile(temporary, data, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
        finally { await unlink(temporary).catch(() => {}); }
      }
      result.push({ ...image, path });
    }
    return result;
  }
  /** Called inside the SAME SQL transaction as the Durable document/receipt. */
  async replaceReferences(tx: SqliteExecutor, owner: string, ids: ReadonlySet<string>) {
    const previous = await tx.all<{ asset_id: string }>('SELECT asset_id FROM friday_asset_refs WHERE owner=?', owner);
    await tx.run('DELETE FROM friday_asset_refs WHERE owner=?', owner);
    for (const id of ids) {
      if (!await tx.get('SELECT id FROM friday_assets WHERE id=?', id)) throw new MissingImageError(`图片 ${id} 尚未上传，请重试保存`);
      await tx.run('INSERT INTO friday_asset_refs(owner,asset_id) VALUES(?,?)', owner, id);
      await tx.run('UPDATE friday_assets SET unreferenced_at=NULL WHERE id=?', id);
    }
    for (const { asset_id } of previous) if (!ids.has(asset_id)) await tx.run(`UPDATE friday_assets SET unreferenced_at=COALESCE(unreferenced_at,?)
      WHERE id=? AND NOT EXISTS(SELECT 1 FROM friday_asset_refs WHERE asset_id=?)`, Date.now(), asset_id, asset_id);
  }
  async collect(now = Date.now()) {
    return this.db.transaction(async tx => {
      const candidates = await tx.all<{ id: string }>(`SELECT id FROM friday_assets a WHERE unreferenced_at <= ?
        AND NOT EXISTS(SELECT 1 FROM friday_asset_refs r WHERE r.asset_id=a.id)
        AND NOT EXISTS(SELECT 1 FROM friday_asset_uploads u WHERE u.asset_id=a.id AND u.expires_at>?) LIMIT 100`, now - imageRetentionMs, now);
      for (const { id } of candidates) await tx.run('DELETE FROM friday_assets WHERE id=?', id);
      return candidates.length;
    });
  }
}

export const imageRetentionMs = 7 * 24 * 60 * 60 * 1000;

/** Only Friday image metadata is indexed; arbitrary hashes in tool output or
 * text are not attachment references. Names and placement remain in Durable. */
export type ImageReferencePath = readonly (string | number)[];
export function referencedImages(value: unknown, ids = new Set<string>(), paths?: ImageReferencePath[], path: ImageReferencePath = []): Set<string> {
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) referencedImages(item, ids, paths, paths ? [...path, index] : []); }
  else if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'images' && Array.isArray(nested)) {
        paths?.push([...path, key]);
        for (const image of nested) if (image && typeof image.id === 'string' && imageID.test(image.id) && typeof image.name === 'string' && ['image/png','image/jpeg','image/gif','image/webp'].includes(image.mediaType)) ids.add(image.id);
      }
      referencedImages(nested, ids, paths, paths ? [...path, key] : []);
    }
  }
  return ids;
}
