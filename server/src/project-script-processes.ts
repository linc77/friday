import { spawn, type ChildProcess } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

type Output = { text: string; sequence: number; shell: string; completed: number; exitCode: number | null };
type Running = { child: ChildProcess; done: Promise<number | null>; stopping: boolean };
const maxOutputBytes = 256 * 1024;

/** Noninteractive script processes. No login shell, PTY, input channel or idle polling. */
export class ProjectScriptProcesses {
  private db?: DatabaseSync;
  private running = new Map<string, Running>();
  private closing = false;

  async open(directory: string) {
    const path = join(directory, 'project-script-output.sqlite');
    this.db = new DatabaseSync(path); await chmod(path, 0o600);
    this.db.exec('CREATE TABLE IF NOT EXISTS output (id TEXT PRIMARY KEY, text TEXT NOT NULL, sequence INTEGER NOT NULL, shell TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, exitCode INTEGER)');
  }
  output(id: string): Output | undefined { return this.db?.prepare('SELECT text,sequence,shell,completed,exitCode FROM output WHERE id=?').get(id) as Output | undefined; }
  private append(id: string, text: string) {
    if (!text) return;
    const previous = this.output(id)!;
    const bytes = Buffer.from(previous.text + text);
    let start = Math.max(0, bytes.length - maxOutputBytes);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    this.db!.prepare('UPDATE output SET text=?,sequence=sequence+1 WHERE id=?').run(bytes.subarray(start).toString('utf8'), id);
  }
  isLive(id: string) { return this.running.has(id); }
  start(id: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
    if (this.closing) throw new Error('服务正在停止');
    if (this.running.has(id) || this.output(id)) throw new Error('脚本已经启动，不会自动重复执行');
    const shell = process.env.SHELL || '/bin/sh';
    this.db!.prepare('INSERT INTO output(id,text,sequence,shell) VALUES(?,?,0,?)').run(id, '', shell);
    const child = spawn(shell, ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let resolve!: (code: number | null) => void;
    const done = new Promise<number | null>(r => { resolve = r; });
    const entry: Running = { child, done, stopping: false }; this.running.set(id, entry);
    for (const stream of [child.stdout!, child.stderr!]) {
      const decoder = new StringDecoder('utf8');
      stream.on('data', (data: Buffer) => this.append(id, decoder.write(data)));
      stream.once('end', () => this.append(id, decoder.end()));
    }
    child.once('error', error => this.append(id, error.message + '\n'));
    child.once('close', code => {
      // A background child with redirected output must not outlive its script.
      this.signal(entry, 'SIGKILL');
      if (!this.closing && !entry.stopping) this.db!.prepare('UPDATE output SET completed=1,exitCode=? WHERE id=?').run(code, id);
      this.running.delete(id); resolve(code);
    });
    return new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  async wait(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const entry = this.running.get(id);
    if (!entry) return this.output(id)?.exitCode ?? null;
    let abort!: () => void;
    try {
      return await Promise.race([entry.done, new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]);
    } finally { signal.removeEventListener('abort', abort); }
  }
  private signal(entry: Running, signal: NodeJS.Signals) {
    if (entry.child.pid) { try { process.kill(-entry.child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  }
  async stop(id: string) {
    const entry = this.running.get(id); if (!entry) return;
    entry.stopping = true; this.signal(entry, 'SIGTERM');
    const controller = new AbortController();
    try { await Promise.race([entry.done, delay(1000, undefined, { signal: controller.signal })]); } finally { controller.abort(); }
    if (this.running.get(id) === entry) { this.signal(entry, 'SIGKILL'); await entry.done; }
  }
  delete(id: string) { this.db?.prepare('DELETE FROM output WHERE id=?').run(id); }
  async close() {
    this.closing = true;
    await Promise.all([...this.running.keys()].map(id => this.stop(id)));
    this.db?.close(); this.db = undefined;
  }
}
