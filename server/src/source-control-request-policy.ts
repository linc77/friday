/*
Adapted from T3 Code 8cd9641f SourceControlRateLimit, GitHubQuota and GitHubRequestPolicy.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SourceControlProvider } from './source-control-provider.js';
import { SourceControlHTTPError } from './source-control-http-errors.js';

const interaction = new AsyncLocalStorage<boolean>();
export const withSourceControlInteraction = <T>(interactive: boolean, run: () => T): T => interaction.run(interactive, run);
export const sourceControlInteractive = () => interaction.getStore() === true;
export type SourceControlRateKey = { provider: SourceControlProvider; host: string; scope: string };
type Pause = { attempt: number; generation: number; retryAt: number };
type Quota = { limit: number; remaining: number; resetAt: number };
export class SourceControlRateLimitPausedError extends SourceControlHTTPError {
  constructor(readonly provider: SourceControlProvider, readonly host: string, readonly retryAt: number) { super(429, '仓库平台请求暂缓，请在配额重置后重试', { retryAt, rateLimited: true }); }
}
export function sourceControlRetryAt(value: string | null | undefined, now: number): number | undefined {
  if (value == null) return;
  const text = value.trim();
  if (/^\d+$/.test(text)) { const next = now + Number(text) * 1000; return Number.isSafeInteger(next) ? next : undefined; }
  const next = Date.parse(text); return Number.isFinite(next) && next > now ? next : undefined;
}
export function githubRateLimited(status: number, headers: Headers, body = '', errors?: unknown): boolean {
  return status === 429 || Array.isArray(errors) && (headers.get('x-ratelimit-remaining') === '0' || errors.some(error => error?.type === 'RATE_LIMITED' || typeof error?.message === 'string' && /rate limit (already )?exceeded/i.test(error.message)))
    || status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /rate limit/i.test(body));
}
export function responseRetryAt(headers: Headers, now: number): number | undefined {
  const retry = sourceControlRetryAt(headers.get('retry-after'), now); if (retry !== undefined) return retry;
  const reset = Number(headers.get('x-ratelimit-reset')) * 1000; return Number.isFinite(reset) && reset > now ? reset : undefined;
}
export function sourceControlRateFailure(error: unknown): { retryAt?: number } | null {
  let current = error;
  for (let i = 0; current instanceof Error && i < 8; i++, current = current.cause) {
    const value = current as Error & { reason?: string; status?: number; retryAt?: number; rateLimited?: boolean };
    if (value.rateLimited || value.status === 429 || value.reason === 'rate-limited') return { ...(Number.isFinite(value.retryAt) ? { retryAt: value.retryAt } : {}) };
  }
  return null;
}

/** One resident service owns these limits. A slot covers headers and body;
 * cancellation removes queued reads, and no provider write is retried here. */
export class SourceControlRequestPolicy {
  readonly #pauses = new Map<string, Pause>();
  readonly #quotas = new Map<string, Quota>();
  readonly #lifetime = new AbortController();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #waiters: (() => void)[] = [];
  #active = 0;
  constructor(readonly now: () => number = Date.now, readonly concurrency = 8) { if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Source Control 并发设置无效'); }
  private key(key: SourceControlRateKey) { return key.provider + '\0' + key.host.trim().toLowerCase() + '\0' + key.scope; }
  check(key: SourceControlRateKey, allowPaused = false): number {
    const entry = this.#pauses.get(this.key(key));
    if (entry && entry.retryAt > this.now() && !allowPaused) throw new SourceControlRateLimitPausedError(key.provider, key.host.trim().toLowerCase(), entry.retryAt);
    return entry?.generation ?? 0;
  }
  recordRateLimit(key: SourceControlRateKey, lease: number, proposed?: number) {
    const normalized = this.key(key), previous = this.#pauses.get(normalized), now = this.now();
    if (previous && previous.generation > lease) {
      if (previous.retryAt <= now && (proposed === undefined || proposed <= now)) return;
      if (proposed !== undefined && proposed > previous.retryAt) this.#pauses.set(normalized, { ...previous, retryAt: proposed });
      return;
    }
    const attempt = (previous?.attempt ?? 0) + 1;
    const retryAt = proposed !== undefined && proposed > now ? proposed : now + Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
    this.#pauses.set(normalized, { attempt, generation: Math.max(previous?.generation ?? 0, lease) + 1, retryAt: previous && previous.retryAt > now ? Math.max(previous.retryAt, retryAt) : retryAt });
  }
  recordSuccess(key: SourceControlRateKey, lease: number) {
    const normalized = this.key(key), previous = this.#pauses.get(normalized);
    if (previous && previous.generation === lease && previous.retryAt <= this.now()) this.#pauses.set(normalized, { attempt: 0, generation: previous.generation, retryAt: 0 });
  }
  observeGithub(host: string, scope: string, headers: Headers) {
    const resource = headers.get('x-ratelimit-resource')?.trim(), limit = Number(headers.get('x-ratelimit-limit')), remaining = Number(headers.get('x-ratelimit-remaining')), resetAt = Number(headers.get('x-ratelimit-reset')) * 1000;
    if (!resource || !headers.has('x-ratelimit-remaining') || !headers.has('x-ratelimit-reset') || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(resetAt)) return;
    const key = host.trim().toLowerCase() + '\0' + resource + '\0' + scope, previous = this.#quotas.get(key);
    if (!previous || resetAt >= previous.resetAt) this.#quotas.set(key, { limit, remaining, resetAt });
  }
  admitGithub(host: string, scope: string, resource: string, allowReserve = false) {
    const value = this.#quotas.get(host.trim().toLowerCase() + '\0' + resource + '\0' + scope);
    if (value && value.resetAt > this.now() && value.remaining < (allowReserve ? 1 : value.limit * .1)) throw new SourceControlRateLimitPausedError('github', host.trim().toLowerCase(), value.resetAt);
  }
  private permit(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const take = () => {
        if (signal.aborted) { cancel(); return; }
        if (this.#active >= this.concurrency) { this.#waiters.push(take); return; }
        signal.removeEventListener('abort', cancel); this.#active++; let released = false;
        resolve(() => { if (released) return; released = true; this.#active--; this.#waiters.shift()?.(); });
      };
      const cancel = () => { const index = this.#waiters.indexOf(take); if (index >= 0) this.#waiters.splice(index, 1); signal.removeEventListener('abort', cancel); reject(signal.reason); };
      signal.addEventListener('abort', cancel, { once: true }); take();
    });
  }
  request<T>(key: SourceControlRateKey, options: { resource?: string; interactive?: boolean; signal?: AbortSignal }, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = AbortSignal.any([this.#lifetime.signal, ...(options.signal ? [options.signal] : [])]), interactive = options.interactive ?? sourceControlInteractive();
    const run = (async () => {
      signal.throwIfAborted(); const release = key.provider === 'github' ? await this.permit(signal) : () => {};
      try {
        signal.throwIfAborted();
        if (key.provider === 'github') this.admitGithub(key.host, key.scope, options.resource ?? 'core', interactive);
        const lease = this.check(key, interactive);
        try { const result = await send(signal); this.recordSuccess(key, lease); return result; }
        catch (error) { const limited = sourceControlRateFailure(error); if (limited) this.recordRateLimit(key, lease, limited.retryAt); throw error; }
      } finally { release(); }
    })();
    this.#pending.add(run); void run.finally(() => this.#pending.delete(run)).catch(() => {}); return run;
  }
  async close() { this.#lifetime.abort(new Error('Source Control 连接已关闭')); await Promise.allSettled(this.#pending); this.#pauses.clear(); this.#quotas.clear(); }
}
