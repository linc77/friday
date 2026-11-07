import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export type TaskSearchInput = { query: string; limit: number };
export type TaskSearchMatch = { taskId: string; projectId: string | null; epoch: string; source: 'user' | 'assistant'; snippet: string; messageCreatedAt: string | null };
export type TaskSearchResult = { sequence: number; query: string; matches: TaskSearchMatch[] };
export class TaskSearchUnavailable extends Error { constructor() { super('任务消息搜索暂时不可用，请稍后重试'); } }
export function taskSearchInput(query: unknown, limit: unknown = 50): TaskSearchInput {
  if (typeof query !== 'string' || query.trim().length < 2 || query.trim().length > 200) throw new Error('搜索内容需要 2 到 200 个字符');
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('搜索结果数量需要在 1 到 50 之间');
  return { query: query.trim(), limit: limit as number };
}

/** Search is a read model. This worker never opens a Harness, starts a provider,
 * takes the service lease or writes to Durable's SQLite file. */
export class TaskSearch {
  private worker?: Worker;
  private serial = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (result: TaskSearchResult) => void; reject: (error: Error) => void; clear: () => void }>();
  constructor(private readonly directory: string) {}
  private reader() {
    if (this.closed) throw new TaskSearchUnavailable();
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./task-search-worker.mjs', import.meta.url), { workerData: { file: join(this.directory, 'friday.sqlite') } });
    this.worker = worker; worker.unref();
    worker.on('message', (reply: { id: number; result?: TaskSearchResult; error?: boolean }) => {
      const pending = this.pending.get(reply.id); if (!pending) return;
      this.pending.delete(reply.id); pending.clear();
      if (!this.pending.size) worker.unref();
      if (reply.result) pending.resolve(reply.result); else pending.reject(new TaskSearchUnavailable());
    });
    const stopped = () => {
      if (this.worker !== worker) return;
      this.worker = undefined;
      for (const pending of this.pending.values()) { pending.clear(); pending.reject(new TaskSearchUnavailable()); }
      this.pending.clear();
    };
    worker.once('error', stopped); worker.once('exit', stopped);
    worker.unref();
    return worker;
  }
  search(input: TaskSearchInput, signal?: AbortSignal): Promise<TaskSearchResult> {
    if (this.closed || this.pending.size >= 16 || signal?.aborted) return Promise.reject(new TaskSearchUnavailable());
    const worker = this.reader(); const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); pending.clear(); reject(new TaskSearchUnavailable());
        if (!this.pending.size) worker.unref();
      };
      const timer = setTimeout(cancel, 20_000); timer.unref();
      this.pending.set(id, { resolve, reject, clear: () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); } });
      worker.ref();
      signal?.addEventListener('abort', cancel, { once: true });
      try { worker.postMessage({ id, input }); }
      catch { cancel(); }
    });
  }
  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) { pending.clear(); pending.reject(new TaskSearchUnavailable()); }
    this.pending.clear(); const worker = this.worker; this.worker = undefined;
    if (worker) { worker.ref(); await worker.terminate(); }
  }
}
