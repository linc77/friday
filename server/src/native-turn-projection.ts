import type { ExecutionRequest, TaskEvent } from './types.js';

/** Ephemeral event projection only. Execution intent, session identity, start
 * receipts and recovery remain owned by the existing Durable task. */
export class NativeTurnProjection {
  readonly items = new Map<string, TaskEvent>();
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  private chain = Promise.resolve();
  private failure?: Error;
  private outputDirty = false;
  private finalItem?: string;
  output = '';
  constructor(readonly request: ExecutionRequest, readonly turnId: string) {}
  put(key: string, kind: string, text: string, changes: Partial<TaskEvent> = {}) {
    const previous = this.items.get(key), item: TaskEvent = { id: `${this.turnId}:${key}`, itemId: key, turnId: this.turnId, at: previous?.at ?? new Date().toISOString(), status: 'running', ...previous, kind, text, ...changes };
    this.items.set(key, item); this.dirty.add(key);
    if (kind === 'message') { this.output = item.text; this.outputDirty = true; this.finalItem = key; }
    this.timer ??= setTimeout(() => { void this.flush().catch(error => { this.failure ??= error; }); }, 50);
    return item;
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    this.chain = this.chain.then(async () => {
      if (this.failure) throw this.failure;
      const keys = [...this.dirty]; this.dirty.clear();
      for (const key of keys) { const item = this.items.get(key); if (item) await this.request.update({ kind: 'item', item: { ...item } }); }
      if (this.outputDirty) { this.outputDirty = false; await this.request.update({ kind: 'output', text: this.output }); }
    });
    return this.chain;
  }
  async finish(status: 'completed' | 'failed' | 'interrupted', retainRunningKeys: ReadonlySet<string> = new Set()) {
    clearTimeout(this.timer); this.timer = undefined;
    for (const [key, item] of this.items) {
      const changes: Partial<TaskEvent> = {};
      if (item.status === 'running' && !(status === 'completed' && retainRunningKeys.has(key))) { changes.status = status; changes.completedAt = new Date().toISOString(); }
      if (status === 'completed' && key === this.finalItem) changes.phase = 'final_answer';
      if (Object.keys(changes).length) this.put(key, item.kind, item.text, changes);
    }
    await this.flush(); return this.output;
  }
  dispose() { clearTimeout(this.timer); this.timer = undefined; }
}
