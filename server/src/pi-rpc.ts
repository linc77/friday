import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type PiRecord = Record<string, any>;
export const piRecord = (value: unknown): PiRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as PiRecord : undefined;

/** Pi uses LF framing, including when JSON strings contain U+2028/U+2029.
 * Protocol reference: T3 Code 8cd9641f packages/provider-pi/src/server/rpc.ts. */
export function piFramer(maxChars = 64 * 1024 * 1024) {
  let buffer = '', dropping = false;
  return (chunk: string) => {
    const lines: string[] = [];
    for (let start = 0; start < chunk.length;) {
      const newline = chunk.indexOf('\n', start), end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > maxChars) { buffer = ''; dropping = true; }
        else buffer += chunk.slice(start, end);
      }
      if (newline < 0) break;
      if (!dropping && buffer) lines.push(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
      buffer = ''; dropping = false; start = newline + 1;
    }
    return lines;
  };
}

export class PiRpc {
  readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { command: string; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;
  private stopping = false;
  private failure?: Error;
  private exited: Promise<void>;
  onEvent?: (record: PiRecord) => void;
  onExit?: (error: Error) => void;
  constructor(command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv) {
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', detached: process.platform !== 'win32' });
    const frame = piFramer();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      for (const line of frame(chunk)) {
        let record: PiRecord | undefined;
        try { record = piRecord(JSON.parse(line)); } catch { continue; }
        if (!record) continue;
        if (record.type === 'response' && typeof record.id === 'string') {
          const pending = this.pending.get(record.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(record.id);
          if (record.command !== pending.command || typeof record.success !== 'boolean') pending.reject(new Error('Pi 返回了无效的 RPC 回执'));
          else if (!record.success) pending.reject(new Error(`Pi ${pending.command} 失败：${typeof record.error === 'string' ? record.error.slice(0, 500) : '原生请求失败'}`));
          else pending.resolve(record.data);
        } else this.onEvent?.(record);
      }
    });
    // CLI diagnostics may contain credentials. The public error uses only the
    // exit code, while stdout carries the structured native error.
    this.child.stderr.resume();
    this.child.stdin.on('error', error => this.fail(new Error(`Pi 输入连接已关闭（${(error as NodeJS.ErrnoException).code ?? 'IO'}）`)));
    this.child.on('error', error => this.fail(new Error(`无法启动 Pi（${(error as NodeJS.ErrnoException).code ?? 'IO'}）`)));
    this.exited = new Promise(resolve => this.child.once('close', code => {
      this.closed = true;
      const error = new Error(`Pi 进程已退出（${code ?? 'signal'}）`);
      this.fail(error); if (!this.stopping) this.onExit?.(this.failure ?? error); resolve();
    }));
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async send(record: PiRecord) {
    if (this.closed || this.failure) throw this.failure ?? new Error('Pi 连接已关闭');
    await new Promise<void>((resolve, reject) => this.child.stdin.write(JSON.stringify(record) + '\n', error => error ? reject(new Error('无法向 Pi 发送请求')) : resolve()));
  }
  request(record: PiRecord, timeoutMs = 30_000): Promise<any> {
    if (typeof record.type !== 'string') return Promise.reject(new Error('Pi 请求缺少类型'));
    const id = typeof record.id === 'string' && record.id ? record.id : randomUUID();
    if (this.pending.has(id)) return Promise.reject(new Error('Pi 请求 ID 已在使用'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi ${record.type} 请求超时；不会自动重试`)); }, timeoutMs);
      this.pending.set(id, { command: record.type, resolve, reject, timer });
      void this.send({ ...record, id }).catch(error => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }
  async close() {
    this.stopping = true;
    if (!this.closed) {
      this.signal('SIGTERM');
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
      if (!this.closed) this.signal('SIGKILL');
    }
    await this.exited;
  }
  private signal(signal: NodeJS.Signals) {
    // A child that exited can still have descendants holding its pipes open.
    // Until close, the detached process group remains owned by this transport.
    if (this.closed || !this.child.pid) return;
    try { if (process.platform === 'win32') this.child.kill(signal); else process.kill(-this.child.pid, signal); } catch { /* Already exited. */ }
  }
}
