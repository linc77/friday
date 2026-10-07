import { setTimeout as delay } from 'node:timers/promises';
import { activeStatuses, type Workspace } from './types.js';

/** A short owner-held write barrier; process death or expiry releases it. */
export class ServiceMaintenance {
  private expiresAt = 0;
  private writes = 0;
  constructor(private readonly snapshot: () => Promise<Workspace>, private readonly leaseMs = 120_000) {}
  get preparing() { return this.expiresAt > Date.now(); }
  enterWrite() {
    if (this.preparing) throw new Error('Friday 正在准备更新，请稍后重试。');
    this.writes++;
    return () => { this.writes--; };
  }
  async prepare() {
    if (this.preparing) throw new Error('已有更新正在准备，请稍后重试。');
    this.expiresAt = Date.now() + this.leaseMs;
    try {
      const deadline = Date.now() + Math.min(10_000, this.leaseMs);
      while (this.writes > 0) {
        if (Date.now() >= deadline) throw new Error('仍有请求正在保存，请稍后重试更新。');
        await delay(10);
      }
      const state = await this.snapshot();
      if (state.tasks.some(task => activeStatuses.includes(task.status))) throw new Error('仍有任务正在执行或等待处理。请完成或停止任务后再安装更新。');
      if (!this.preparing) throw new Error('更新准备已超时，请重试。');
    } catch (error) { this.cancel(); throw error; }
  }
  cancel() { this.expiresAt = 0; }
}
