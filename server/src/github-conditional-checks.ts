/*
Adapted from T3 Code 8cd9641f gitHubConditionalChecks.ts.
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
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import type { ChangeRequestDetail } from './task-change-request-data.js';
import { SourceControlHTTPError } from './source-control-http-errors.js';

export type ChangeRequestChecks = Pick<ChangeRequestDetail, 'checks' | 'checksState' | 'checksUnavailable' | 'workflowApprovalsRequired' | 'workflowApprovalsUnavailable'> & { state: 'open' | 'closed' | 'merged'; headSha: string; updatedAt?: string; isDraft?: boolean; mergeability?: string };
export type ChangeRequestChecksRead = ChangeRequestChecks & { headSha: string };
type Runs = { headSha: string; runs: Record<string, any>[] };
const workflows = new AsyncLocalStorage<Runs | null>();
export const knownGitHubWorkflowRuns = () => workflows.getStore();
type Validator = { etag?: string; next: boolean; body: string };
type Entry = { born: number; validators: Map<string, Validator>; head?: { sha: string; source: number | null; target: number }; value?: ChangeRequestChecks; readAt: number; supported: boolean; tail: Promise<unknown> };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Validators and bounded response bodies stay in this service's private
 * memory. A 304 reuses its own page, including the previous pagination flag. */
export class GitHubChecksRevalidator {
  readonly #entries = new Map<string, Entry>();
  readonly #lifetime = new AbortController();
  constructor(readonly now: () => number = Date.now) {}
  async get(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, read: () => Promise<ChangeRequestChecksRead>, signal?: AbortSignal): Promise<ChangeRequestChecks> {
    if (p.provider !== r.provider || p.host !== r.host) throw new Error('Source Control 连接与目标不一致');
    if (r.provider !== 'github' || !p.fingerprint || !p.conditional) return read();
    const combined = AbortSignal.any([this.#lifetime.signal, ...(signal ? [signal] : [])]); combined.throwIfAborted();
    const key = JSON.stringify([p.fingerprint, r.host, r.path, number]); let entry = this.#entries.get(key);
    if (entry && this.now() - entry.born >= 30 * 60_000) { this.#entries.delete(key); entry = undefined; }
    if (!entry) { entry = { born: this.now(), validators: new Map(), readAt: 0, supported: true, tail: Promise.resolve() }; this.#entries.set(key, entry); if (this.#entries.size > 128) this.#entries.delete(this.#entries.keys().next().value!); }
    const held = entry, run = held.tail.catch(() => {}).then(async () => {
      combined.throwIfAborted(); if (!held.supported) return read();
      const fail = () => new SourceControlHTTPError(502, '无法确认 GitHub 检查状态，请刷新');
      const get = async (endpoint: string, head = false): Promise<boolean | null> => {
        const previous = held.validators.get(endpoint); let response;
        try { response = await p.conditional!(endpoint, { signal: combined, maxResponseBytes: 8 * 1024 * 1024, ...(previous?.etag ? { ifNoneMatch: previous.etag } : {}) }); }
        catch (error) {
          combined.throwIfAborted();
          if (!(error instanceof SourceControlHTTPError) || [401, 403, 429].includes(error.status) || error.rateLimited) throw error;
          if ([404, 405, 501].includes(error.status)) held.supported = false;
          held.value = undefined; return null;
        }
        if (response.status === 304 && previous) return previous.next;
        if (response.status !== 200) throw fail();
        held.value = undefined;
        if (head) {
          let value; try { value = JSON.parse(response.body); } catch { throw fail(); }
          const rawHead = record(record(value).head), source = rawHead.repo === null ? null : record(rawHead.repo).id, target = record(record(record(value).base).repo).id;
          if (typeof rawHead.sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(rawHead.sha) || source !== null && !positive(source) || !positive(target)) throw fail();
          if (held.head?.sha !== rawHead.sha) held.validators.clear();
          held.head = { sha: rawHead.sha, source, target };
        }
        held.validators.set(endpoint, { etag: response.headers.get('etag')?.trim() || undefined, next: /rel="next"/.test(response.headers.get('link') ?? ''), body: response.body });
        return held.validators.get(endpoint)!.next;
      };
      const root = `repos/${r.path}`;
      if (await get(root + '/pulls/' + number, true) === null) return read();
      const head = held.head; if (!head) throw fail();
      const runs = head.source !== head.target ? root + '/actions/runs?head_sha=' + head.sha + '&event=pull_request' : null;
      const runPages: string[] = [];
      for (const endpoint of [root + '/commits/' + head.sha + '/check-runs?filter=all', root + '/commits/' + head.sha + '/status', ...(runs ? [runs] : [])]) {
        for (let page = 1; ; page++) {
          if (page > 100) throw fail();
          const paged = endpoint + (endpoint.includes('?') ? '&' : '?') + 'per_page=100&page=' + page, next = await get(paged);
          if (next === null) return read(); if (endpoint === runs) runPages.push(paged); if (!next) break;
        }
      }
      if (held.value && this.now() - held.readAt < 5 * 60_000) return structuredClone(held.value);
      let known: Runs | null = runs ? { headSha: head.sha, runs: [] } : null;
      for (const endpoint of runPages) {
        try { const value = JSON.parse(held.validators.get(endpoint)?.body ?? ''); if (!Array.isArray(value.workflow_runs)) { known = null; break; } known!.runs.push(...value.workflow_runs); } catch { known = null; break; }
      }
      const fresh = await workflows.run(known, read);
      const value: ChangeRequestChecks = { ...fresh };
      held.value = !fresh.checksUnavailable && !fresh.workflowApprovalsUnavailable && fresh.workflowApprovalsRequired !== undefined && fresh.headSha === head.sha ? structuredClone(value) : undefined;
      held.readAt = this.now(); return value;
    });
    held.tail = run;
    // A disconnected waiter stops waiting immediately; it never releases an
    // earlier reader's gate or cancels another caller's provider request.
    return new Promise((resolve, reject) => {
      const abort = () => reject(combined.reason); combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
      void run.then(resolve, reject).finally(() => combined.removeEventListener('abort', abort)).catch(() => {});
    });
  }
  invalidate(host: string, repository: string, number: number) {
    for (const key of this.#entries.keys()) { const [, h, r, n] = JSON.parse(key); if (h === host && r === repository && n === number) this.#entries.delete(key); }
  }
  clear() { this.#entries.clear(); }
  async close() { this.#lifetime.abort(new Error('GitHub 检查读取已关闭')); await Promise.allSettled([...this.#entries.values()].map(entry => entry.tail)); this.#entries.clear(); }
}
