/*
Adapted from T3 Code 8cd9641f PullRequestSyncReactor.ts / PullRequestService.ts.
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
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import { normalizeTaskChangeRequest, type SourceControlRepository } from './task-change-requests.js';
import { summaryFromRaw, type ChangeRequestSummary } from './task-change-request-summary.js';
import { SourceControlHTTPError } from './source-control-http-errors.js';

type Job = { pinned: PinnedSourceControlConnection; repository: SourceControlRepository; number: number; signal?: AbortSignal; resolve: (value: ChangeRequestSummary) => void; reject: (error: unknown) => void; abort: () => void; settled: boolean; cancelBatch?: () => void };
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

/** Twenty-five aliases share a pinned host and credential. A missing PR fails
 * only its own alias; cancellation never abandons another caller's response. */
export class GitHubSummaryBatcher {
  private readonly queue = new Map<string, Job[]>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  get(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, number: number, signal?: AbortSignal): Promise<ChangeRequestSummary> {
    if (this.closed || signal?.aborted) return Promise.reject(signal?.reason ?? new Error('PR 摘要读取已关闭'));
    if (!Number.isSafeInteger(number) || number < 1 || !pinned.fingerprint || pinned.provider !== 'github' || repository.provider !== 'github' || pinned.host !== repository.host || !pinned.graphqlRaw) return Promise.reject(new Error('GitHub 摘要连接无效'));
    return new Promise((resolve, reject) => {
      const job: Job = { pinned, repository, number, signal, resolve, reject, settled: false, abort: () => { this.finish(job, signal?.reason ?? new Error('PR 摘要读取已取消')); job.cancelBatch?.(); } };
      signal?.addEventListener('abort', job.abort, { once: true });
      const key = repository.host.toLowerCase() + '\0' + pinned.fingerprint, jobs = this.queue.get(key) ?? []; jobs.push(job); this.queue.set(key, jobs);
      this.timer ??= setTimeout(() => { this.timer = undefined; this.flush(); }, 10);
    });
  }
  private finish(job: Job, error?: unknown, value?: ChangeRequestSummary) {
    if (job.settled) return; job.settled = true; job.signal?.removeEventListener('abort', job.abort);
    if (value) job.resolve(value); else job.reject(error);
  }
  private flush() {
    const queued = [...this.queue.values()]; this.queue.clear();
    for (const values of queued) {
      const active = values.filter(job => !job.settled);
      for (let i = 0; i < active.length; i += 25) {
        const jobs = active.slice(i, i + 25), controller = new AbortController(); this.controllers.add(controller);
        for (const job of jobs) job.cancelBatch = () => { if (jobs.every(j => j.settled)) controller.abort(); };
        const run = this.read(jobs, controller.signal).catch(error => { for (const job of jobs) this.finish(job, error); }).finally(() => { this.controllers.delete(controller); });
        this.pending.add(run); void run.finally(() => this.pending.delete(run)).catch(() => {});
      }
    }
  }
  private async read(jobs: Job[], signal: AbortSignal) {
    const fields = 'number title url state isDraft mergeable reviewDecision additions deletions changedFiles updatedAt mergedAt closedAt headRefName baseRefName headRefOid author{login avatarUrl} latestReviews(first:20){nodes{state author{login}}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}';
    const variables: Record<string, unknown> = {}, declarations: string[] = [], selections: string[] = [];
    jobs.forEach((job, i) => {
      declarations.push(`$owner${i}:String!`, `$name${i}:String!`, `$number${i}:Int!`);
      variables['owner' + i] = job.repository.owner; variables['name' + i] = job.repository.name; variables['number' + i] = job.number;
      selections.push(`r${i}:repository(owner:$owner${i},name:$name${i}){pullRequest(number:$number${i}){${fields}${job.repository.host.toLowerCase() === 'github.com' ? ' stack{number}' : ''}}}`);
    });
    const observedAt = Date.now(), response = await jobs[0]!.pinned.graphqlRaw!(`query FridaySummaryBatch(${declarations.join(',')}){${selections.join(' ')}}`, variables, signal);
    signal.throwIfAborted();
    const data = record(response.data), errors = Array.isArray(response.errors) ? response.errors : [];
    jobs.forEach((job, i) => {
      if (job.settled) return;
      try {
        const raw = record(record(data['r' + i]).pullRequest);
        if (!raw.number || errors.some(error => !Array.isArray(record(error).path) || record(error).path[0] === 'r' + i)) throw new SourceControlHTTPError(404, '无法读取此 GitHub PR，请检查地址和权限');
        const pullRequest = normalizeTaskChangeRequest(job.repository, { number: raw.number, title: raw.title, html_url: raw.url, head: { ref: raw.headRefName }, base: { ref: raw.baseRefName }, state: raw.state === 'OPEN' ? 'open' : 'closed', merged: raw.state === 'MERGED' });
        if (pullRequest.number !== job.number || !['OPEN', 'CLOSED', 'MERGED'].includes(raw.state) || typeof raw.isDraft !== 'boolean') throw new SourceControlHTTPError(502, 'GitHub 摘要响应无效');
        const summary = summaryFromRaw(pullRequest, { ...raw, headOid: raw.headRefOid, draft: raw.isDraft }, observedAt);
        const reviews = Array.isArray(record(raw.latestReviews).nodes) ? raw.latestReviews.nodes : [];
        summary.snapshot.reviewDecision = raw.reviewDecision === 'APPROVED' ? 'approved' : raw.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : reviews.some((v: any) => v?.state === 'CHANGES_REQUESTED') ? 'changes-requested' : reviews.some((v: any) => v?.state === 'APPROVED') ? 'approved' : raw.reviewDecision === 'REVIEW_REQUIRED' ? 'review-required' : null;
        const rollup = record(record(record((record(raw.commits).nodes ?? [])[0]).commit).statusCheckRollup).state;
        summary.snapshot.checksState = rollup === 'SUCCESS' ? 'passing' : ['FAILURE', 'ERROR'].includes(rollup) ? 'failing' : rollup ? 'pending' : null;
        summary.snapshot.mergeability = raw.mergeable === 'CONFLICTING' ? 'conflicting' : raw.mergeable === 'MERGEABLE' ? 'mergeable' : 'unknown';
        if (raw.stack === null) summary.stack = null; else if (Number.isSafeInteger(raw.stack?.number) && raw.stack.number > 0) summary.stack = raw.stack.number;
        this.finish(job, undefined, summary);
      } catch (error) { this.finish(job, error); }
    });
  }
  async close() {
    this.closed = true; clearTimeout(this.timer);
    for (const jobs of this.queue.values()) for (const job of jobs) this.finish(job, new Error('PR 摘要读取已关闭'));
    this.queue.clear(); for (const controller of this.controllers) controller.abort(); await Promise.allSettled([...this.pending]);
  }
}
