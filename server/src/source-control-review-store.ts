import { createHash } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceControlRepository } from './task-change-requests.js';

export type ReviewViewedScope = { repository: SourceControlRepository; number: number; viewer: string | null };
export type ReviewViewedMark = { path: string; revision: string | null };
const scopeKey = (scope: ReviewViewedScope) => createHash('sha256').update(JSON.stringify([scope.repository.provider, scope.repository.host, scope.repository.path, scope.number, scope.viewer ?? ''])).digest('hex');

/** Environment-owned marks, separate from the public workspace and host marks.
 * One lazy connection belongs to the engine's exclusive directory lease. */
export class SourceControlReviewStore {
  private database?: DatabaseSync;
  private closed = false;
  constructor(private readonly directory: string) {}
  private db() {
    if (this.closed) throw new Error('Source Control 审查存储已关闭');
    if (this.database) return this.database;
    const file = join(this.directory, 'source-control-review.sqlite');
    try { const value = lstatSync(file); if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1) throw new Error('Source Control 审查存储不是独立文件'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); db.exec('CREATE TABLE IF NOT EXISTS viewed_files (scope TEXT NOT NULL, path TEXT NOT NULL, revision TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(scope,path))'); }
    catch (error) { db.close(); throw error; }
    this.database = db; return db;
  }
  list(scope: ReviewViewedScope): { files: ReviewViewedMark[]; truncated: boolean } {
    const rows = this.db().prepare('SELECT path,revision FROM viewed_files WHERE scope=? ORDER BY updated_at DESC,path LIMIT 501').all(scopeKey(scope)) as ReviewViewedMark[];
    return { files: rows.slice(0, 500), truncated: rows.length > 500 };
  }
  set(scope: ReviewViewedScope, files: { path: string; revision: string | null; viewed: boolean }[]) {
    const db = this.db(), key = scopeKey(scope), at = new Date().toISOString();
    const put = db.prepare('INSERT INTO viewed_files(scope,path,revision,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,path) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at');
    const remove = db.prepare('DELETE FROM viewed_files WHERE scope=? AND path=?');
    db.exec('BEGIN IMMEDIATE');
    try { for (const file of files) { if (file.viewed) put.run(key, file.path, file.revision, at); else remove.run(key, file.path); } db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  close() { this.closed = true; this.database?.close(); this.database = undefined; }
}
