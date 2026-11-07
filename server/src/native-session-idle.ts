// T3 8cd9641f apps/server/src/orchestration-v2/ProviderSessionManager.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export const NATIVE_SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const NATIVE_SESSION_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
export type NativeSessionIdlePolicy = { idleTimeoutMs?: number; maxIdlePinMs?: number };

/** Timers for an owned process only. It neither creates nor resumes a run. */
export class NativeSessionIdle {
  private timer?: NodeJS.Timeout;
  private pinnedAt?: number;
  private closed = false;
  private idleMs: number;
  private pinMs: number;
  constructor(private busy: () => boolean, private pending: () => boolean, private release: () => Promise<unknown>, policy: NativeSessionIdlePolicy = {}) {
    this.idleMs = Math.max(1, policy.idleTimeoutMs ?? NATIVE_SESSION_IDLE_TIMEOUT_MS);
    this.pinMs = Math.max(0, policy.maxIdlePinMs ?? NATIVE_SESSION_MAX_IDLE_PIN_MS);
  }
  refresh() {
    if (this.closed) return;
    if (this.busy()) { clearTimeout(this.timer); this.timer = undefined; this.pinnedAt = undefined; return; }
    if (!this.timer) this.schedule(this.idleMs);
  }
  private schedule(ms: number) {
    this.timer = setTimeout(() => { this.timer = undefined; void this.check().catch(() => {}); }, ms);
    this.timer.unref();
  }
  private async check() {
    if (this.closed) return;
    if (this.busy()) { this.pinnedAt = undefined; return; }
    if (this.pending()) {
      this.pinnedAt ??= Date.now();
      const remaining = this.pinMs - (Date.now() - this.pinnedAt);
      if (remaining > 0) { this.schedule(Math.min(this.idleMs, remaining)); return; }
    }
    this.stop(); await this.release();
  }
  stop() { this.closed = true; clearTimeout(this.timer); this.timer = undefined; }
}
