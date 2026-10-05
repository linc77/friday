import { randomBytes, randomInt, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Auth {
  readonly token: string;
  private db: DatabaseSync;
  private attempts = new Map<string, { count: number; since: number }>();
  constructor(directory: string) {
    const path = join(directory, 'owner-token');
    try { this.token = readFileSync(path, 'utf8').trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.token = randomBytes(32).toString('hex'); writeFileSync(path, this.token, { flag: 'wx', mode: 0o600 });
    }
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(join(directory, 'access.sqlite'));
    this.db.exec(`CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairing (id INTEGER PRIMARY KEY CHECK(id=1), code_hash TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  identify(token: string | undefined): string | null {
    if (!token) return null;
    if (hash(token) === hash(this.token)) return 'owner';
    return (this.db.prepare('SELECT id FROM devices WHERE token_hash=?').get(hash(token)) as { id: string } | undefined)?.id ?? null;
  }
  createPairing() {
    const code = randomInt(100000, 1000000).toString(); const expires = Date.now() + 5 * 60_000;
    this.db.prepare('INSERT OR REPLACE INTO pairing VALUES(1,?,?)').run(hash(code), expires);
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  pair(code: string, name: string, address: string) {
    const stamp = Date.now();
    if (this.attempts.size > 500) for (const [key, value] of this.attempts) if (stamp - value.since > 10 * 60_000) this.attempts.delete(key);
    const attempts = this.attempts.get(address);
    const counter = attempts && stamp - attempts.since < 10 * 60_000 ? attempts : { count: 0, since: stamp };
    counter.count++; this.attempts.set(address, counter);
    if (counter.count > 5) throw new Error('尝试次数过多，请 10 分钟后重试');
    const pair = this.db.prepare('SELECT code_hash,expires FROM pairing WHERE id=1').get() as { code_hash: string; expires: number } | undefined;
    if (!pair || pair.expires < stamp || pair.code_hash !== hash(code)) throw new Error('配对码无效或已过期');
    const token = randomBytes(32).toString('hex'); const id = randomUUID();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO devices VALUES(?,?,?,?)').run(id, name, hash(token), new Date().toISOString());
      this.db.prepare('DELETE FROM pairing WHERE id=1').run(); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { id, token };
  }
  devices() { return this.db.prepare('SELECT id,name,created_at AS createdAt FROM devices ORDER BY created_at DESC').all(); }
  revoke(id: string) { this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  close() { this.db.close(); }
}
