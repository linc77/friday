import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Wire = { id?: string | number; method?: string; params?: any; result?: any; error?: { message: string; code?: number } };
export class CodexRpc {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  nextId = 1;
  onMessage: (message: Wire) => void = () => {};
  onExit: (error: Error) => void = () => {};
  stderr = '';
  constructor(command: string, cwd: string, options: { args?: string[]; env?: NodeJS.ProcessEnv } = {}) {
    const env = { ...process.env, ...options.env };
    delete env.CODEX_THREAD_ID;
    this.child = spawn(command, ['app-server', '--listen', 'stdio://', ...(options.args ?? [])], { cwd, env, stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: Wire;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.method && typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else this.onMessage(message);
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Codex 连接结束（${code ?? 'signal'}）。可稍后继续此任务。`)));
    this.child.stdin.on('error', () => {});
  }
  send(message: Wire) { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 请求超时`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
  close() { this.onExit = () => {}; this.fail(new Error('Codex 连接已关闭')); this.child.stdin.end(); this.child.kill('SIGTERM'); }
}
