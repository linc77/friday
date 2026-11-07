import { DatabaseSync } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskTerminalSummary, TerminalOperation, TerminalReceipt } from './terminal-types.js';

type Frame = { seq: number; bytes: number; lines: number };
type Window = { frames: Frame[]; head: number; bytes: number; lines: number };
const newlines = (data: Uint8Array) => { let count = 0; for (const byte of data) if (byte === 10) count++; return count; };

// Private output storage is separate from conversation snapshots, so a PTY
// cannot turn every output burst into a whole-workspace SSE broadcast.
export class TerminalStore {
  private db?: DatabaseSync;
  private windows = new Map<string, Window>();
  async open(directory: string) {
    const path = join(directory, 'terminals.sqlite'); this.db = new DatabaseSync(path); await chmod(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS terminal (task TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(task,id));
      CREATE TABLE IF NOT EXISTS terminal_output (task TEXT NOT NULL,id TEXT NOT NULL,generation INTEGER NOT NULL,seq INTEGER NOT NULL,data BLOB NOT NULL,lines INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(task,id,generation,seq));
      CREATE TABLE IF NOT EXISTS terminal_operation (request TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS terminal_input (request TEXT PRIMARY KEY,data TEXT NOT NULL,state TEXT NOT NULL DEFAULT '');`);
    if (!(this.db.prepare('PRAGMA table_info(terminal_output)').all() as { name: string }[]).some(row => row.name === 'lines')) {
      this.db.exec('ALTER TABLE terminal_output ADD COLUMN lines INTEGER NOT NULL DEFAULT 0');
      for (const row of this.db.prepare('SELECT rowid,data FROM terminal_output').all() as { rowid: number; data: Uint8Array }[]) this.db.prepare('UPDATE terminal_output SET lines=? WHERE rowid=?').run(newlines(row.data), row.rowid);
    }
    if (!(this.db.prepare('PRAGMA table_info(terminal_input)').all() as { name: string }[]).some(row => row.name === 'state')) this.db.exec("ALTER TABLE terminal_input ADD COLUMN state TEXT NOT NULL DEFAULT ''");
    this.db.exec("UPDATE terminal_input SET state=json_extract(data,'$.state') WHERE state=''; CREATE INDEX IF NOT EXISTS terminal_input_state ON terminal_input(state)");
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of this.list()) if (['starting', 'running', 'closing'].includes(row.status)) this.save({ ...row, status: 'interrupted', pid: null, hasRunningSubprocess: false, updatedAt: new Date().toISOString(), error: '服务曾中断；保留终端输出，等待明确重新启动，不重放输入。' });
      const pending = this.db.prepare("SELECT data FROM terminal_input WHERE state='started'").all() as { data: string }[];
      for (const row of pending) { const receipt = JSON.parse(row.data) as TerminalReceipt; if (receipt.state === 'started') this.input({ ...receipt, state: 'uncertain' }); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private database() { if (!this.db) throw new Error('终端存储尚未打开'); return this.db; }
  list(taskId?: string): TaskTerminalSummary[] {
    if (!this.db) return [];
    const rows = taskId ? this.db.prepare('SELECT data FROM terminal WHERE task=? ORDER BY rowid').all(taskId) : this.db.prepare('SELECT data FROM terminal ORDER BY rowid').all();
    return (rows as { data: string }[]).map(row => JSON.parse(row.data));
  }
  get(taskId: string, id: string): TaskTerminalSummary | undefined { if (!this.db) return; const row = this.db.prepare('SELECT data FROM terminal WHERE task=? AND id=?').get(taskId, id) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  historyTail(row: TaskTerminalSummary, limit = 8192): Buffer {
    const chunks: Buffer[] = []; let bytes = 0;
    for (const value of this.database().prepare('SELECT data FROM terminal_output WHERE task=? AND id=? AND generation=? ORDER BY seq DESC').iterate(row.taskId, row.id, row.generation) as Iterable<{ data: Uint8Array }>) {
      const chunk = Buffer.from(value.data); chunks.push(chunk); bytes += chunk.length; if (bytes >= limit) break;
    }
    return Buffer.concat(chunks.reverse()).subarray(-limit);
  }
  save(value: TaskTerminalSummary) { this.database().prepare('INSERT INTO terminal(task,id,data) VALUES(?,?,?) ON CONFLICT(task,id) DO UPDATE SET data=excluded.data').run(value.taskId, value.id, JSON.stringify(value)); }
  operation(value: TerminalOperation) { this.database().prepare('INSERT INTO terminal_operation(request,data) VALUES(?,?)').run(value.requestId, JSON.stringify(value)); }
  getOperation(id: string): TerminalOperation | undefined { const row = this.database().prepare('SELECT data FROM terminal_operation WHERE request=?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  input(value: TerminalReceipt) { this.database().prepare('INSERT INTO terminal_input(request,data,state) VALUES(?,?,?) ON CONFLICT(request) DO UPDATE SET data=excluded.data,state=excluded.state').run(value.requestId, JSON.stringify(value), value.state); }
  receipt(id: string): TerminalReceipt | undefined { const row = this.database().prepare('SELECT data FROM terminal_input WHERE request=?').get(id) as { data: string } | undefined; return row ? JSON.parse(row.data) : undefined; }
  output(row: TaskTerminalSummary, data: Buffer) {
    const db = this.database(); const idKey = row.taskId + '\0' + row.id + '\0' + row.generation;
    let window = this.windows.get(idKey);
    if (!window) {
      const frames = db.prepare('SELECT seq,length(data) AS bytes,lines FROM terminal_output WHERE task=? AND id=? AND generation=? ORDER BY seq').all(row.taskId, row.id, row.generation) as Frame[];
      window = { frames, head: 0, bytes: frames.reduce((n, frame) => n + frame.bytes, 0), lines: frames.reduce((n, frame) => n + frame.lines, 0) }; this.windows.set(idKey, window);
    }
    const frame = { seq: row.sequence + 1, bytes: data.length, lines: newlines(data) };
    let head = window.head; let bytes = window.bytes + frame.bytes; let lines = window.lines + frame.lines; let trimmed: { frame: Frame; data: Buffer } | undefined;
    // Keep a bounded raw VT transcript. Retention examines only removed frames,
    // not the entire scrollback on each output burst.
    const at = (index: number) => index < window.frames.length ? window!.frames[index]! : frame;
    while ((bytes > 8 * 1024 * 1024 || lines > 5000) && head < window.frames.length) {
      const first = at(head); if (bytes - first.bytes < 8 * 1024 * 1024 && lines - first.lines < 5000) break;
      bytes -= first.bytes; lines -= first.lines; head++;
    }
    if (bytes > 8 * 1024 * 1024 || lines > 5000) {
      const first = at(head); const stored = first === frame ? data : Buffer.from((db.prepare('SELECT data FROM terminal_output WHERE task=? AND id=? AND generation=? AND seq=?').get(row.taskId, row.id, row.generation, first.seq) as { data: Uint8Array }).data);
      let cut = Math.max(0, bytes - 8 * 1024 * 1024); let removedLines = newlines(stored.subarray(0, cut));
      while (cut < stored.length && lines - removedLines > 5000) if (stored[cut++] === 10) removedLines++;
      const tail = stored.subarray(cut); trimmed = { frame: { seq: first.seq, bytes: tail.length, lines: first.lines - removedLines }, data: tail };
      bytes -= cut; lines -= removedLines;
    }
    const earliest = at(head).seq; const next = { ...row, sequence: frame.seq, baseSequence: earliest, historyTruncated: row.historyTruncated || head > window.head || !!trimmed };
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO terminal_output(task,id,generation,seq,data,lines) VALUES(?,?,?,?,?,?)').run(row.taskId, row.id, row.generation, frame.seq, data, frame.lines);
      if (trimmed) db.prepare('UPDATE terminal_output SET data=?,lines=? WHERE task=? AND id=? AND generation=? AND seq=?').run(trimmed.data, trimmed.frame.lines, row.taskId, row.id, row.generation, trimmed.frame.seq);
      if (head > window.head) db.prepare('DELETE FROM terminal_output WHERE task=? AND id=? AND generation=? AND seq<?').run(row.taskId, row.id, row.generation, earliest);
      this.save(next); db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    window.frames.push(frame); if (trimmed) window.frames[head] = trimmed.frame;
    Object.assign(window, { head, bytes, lines }); if (head > 4096) { window.frames = window.frames.slice(head); window.head = 0; }
    Object.assign(row, next);
    return row.sequence;
  }
  history(row: TaskTerminalSummary, after = -1) {
    return (this.database().prepare('SELECT seq,data FROM terminal_output WHERE task=? AND id=? AND generation=? AND seq>? ORDER BY seq').all(row.taskId, row.id, row.generation, after) as { seq: number; data: Uint8Array }[]).map(value => ({ sequence: value.seq, data: Buffer.from(value.data) }));
  }
  clear(row: TaskTerminalSummary) {
    const db = this.database(); const next = { ...row, sequence: row.sequence + 1, baseSequence: row.sequence + 2, historyTruncated: false };
    db.exec('BEGIN IMMEDIATE'); try { db.prepare('DELETE FROM terminal_output WHERE task=? AND id=?').run(row.taskId, row.id); this.save(next); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    Object.assign(row, next); for (const key of this.windows.keys()) if (key.startsWith(row.taskId + '\0' + row.id + '\0')) this.windows.delete(key);
  }
  deleteTask(taskId: string) {
    for (const table of ['terminal', 'terminal_output']) this.database().prepare(`DELETE FROM ${table} WHERE task=?`).run(taskId);
    for (const key of this.windows.keys()) if (key.startsWith(taskId + '\0')) this.windows.delete(key);
    // Operation and input receipts remain tombstones: old network retries may
    // not create a new shell or replay a command after task deletion.
  }
  close() { this.db?.close(); this.db = undefined; this.windows.clear(); }
}
