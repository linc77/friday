import { backup, DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmod, link, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { imageType } from './ideas.js';

/** Export a consistent SQLite snapshot, including committed note image bytes.
 * A private temporary directory and exclusive publication prevent partial
 * backups, accidental overwrites, and briefly world-readable image data. */
export async function backupNoteDatabase(source: string, destination: string) {
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
  let temporary: string | undefined;
  try {
    for (const key of ['legacy-import-v1', 'references-v1']) {
      const row = db.prepare('SELECT value FROM friday_asset_state WHERE key=?').get(key);
      if (row?.value !== 'complete') throw new Error('图片迁移尚未完成，请先启动新版 Friday 主机');
    }
    temporary = await mkdtemp(join(dirname(destination), '.friday-backup-'));
    await chmod(temporary, 0o700);
    const path = join(temporary, 'friday.sqlite');
    await backup(db, path);
    await chmod(path, 0o600);
    const snapshot = new DatabaseSync(path);
    let images = 0, bytes = 0;
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE');
      const checks = snapshot.prepare('PRAGMA quick_check').all();
      if (checks.some(row => row.quick_check !== 'ok') || snapshot.prepare('PRAGMA foreign_key_check').all().length) throw new Error('备份数据库完整性检查失败');
      for (const row of snapshot.prepare('SELECT id,data,media_type,byte_length FROM friday_assets').iterate()) {
        const data = Buffer.from(row.data as Uint8Array);
        if (data.length !== row.byte_length || createHash('sha256').update(data).digest('hex') !== row.id || imageType(data) !== row.media_type) throw new Error('备份图片校验失败');
        images++; bytes += data.length;
      }
    } finally { snapshot.close(); }
    await link(path, destination);
    return { images, bytes };
  } finally {
    db.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
