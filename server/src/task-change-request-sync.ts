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
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { TaskPullRequest, WorkItem } from './types.js';
import type { ChangeRequestStack, SavedChangeRequestStack } from './task-change-request-stack-types.js';
import { taskPullRequests } from './task-pull-requests.js';
import { changeRequestSyncKey, siblingChangeRequest, supersedesSummary, sameChangeRequestMetadata, type ChangeRequestSummary } from './task-change-request-summary.js';
import { sourceControlRateFailure } from './source-control-request-policy.js';
import { linkTaskChangeRequest } from './task-change-request-links.js';

type Entry = { task: WorkItem; link: TaskPullRequest };
const unsettled = (task: WorkItem) => !task.settledAt && task.settledOverride !== 'settled';
const comparableStack = (value: SavedChangeRequestStack | null | undefined) => value ? { ...value, syncedAt: undefined } : null;
const comparableSnapshot = (value: TaskPullRequest['snapshot']) => value ? { ...value, syncedAt: undefined } : null;
const closeCommand = /\b(?:gh\s+pr|glab\s+mr)\s+(?:merge|close)\b/u;

/** A drainable read-only reactor over the existing Durable document. External
 * mutations remain exclusively in the registered Pi Durable tasks. */
export class TaskChangeRequestSync {
  private readonly controller = new AbortController();
  private readonly requested = new Map<string, number>();
  private readonly last = new Map<string, number>();
  private readonly retryStacks = new Set<string>();
  private readonly paused = new Map<string, number>();
  private readonly commandRuns = new Set<string>();
  private generation = 0;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private queued?: NodeJS.Timeout;
  private pending: 'all' | 'requested' | undefined;
  private started = false;
  private stopped = false;
  constructor(private readonly engine: Engine, private readonly intervalMs = 60_000, readonly now: () => number = Date.now) {}
  start() {
    if (this.started || this.stopped || this.intervalMs <= 0) return;
    this.started = true; this.enqueue('all');
  }
  notify() { if (this.started) this.enqueue('requested'); }
  poll() { if (this.started) this.enqueue('all'); }
  request(taskId: string, url: string) {
    if (this.stopped || this.intervalMs <= 0) return;
    this.requested.set(taskId + '\0' + url, ++this.generation); this.notify();
  }
  command(taskId: string, runId: string | undefined, command: string) {
    if (closeCommand.test(command)) this.commandRuns.add(taskId + '\0' + (runId ?? ''));
  }
  async completed(taskId: string, runId?: string) {
    if (!this.commandRuns.delete(taskId + '\0' + (runId ?? ''))) return;
    const task = (await this.engine.snapshot()).tasks.find(t => t.id === taskId);
    for (const pr of task ? taskPullRequests(task) : []) if (pr.state === 'open') this.request(taskId, pr.url);
  }
  private enqueue(scope: 'all' | 'requested') {
    if (this.stopped || !this.started) return;
    if (this.pending !== 'all') this.pending = scope;
    if (this.running || this.queued) return;
    this.queued = setTimeout(() => { this.queued = undefined; this.launch(); }, 20); this.queued.unref();
  }
  private launch() {
    if (this.running || this.stopped) return;
    this.running = (async () => {
      while (this.pending && !this.stopped) {
        const mode = this.pending; this.pending = undefined; await this.sweep(mode);
        // Schedule from the completed sweep: a timer anchored before a slow
        // read would hit the sixty-second summary cache just before it expires.
        if (mode === 'all' && !this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => this.enqueue('all'), this.intervalMs); this.timer.unref(); }
      }
    })().catch(() => { if (!this.stopped) console.warn('[Friday runtime] PR synchronization failed'); }).finally(() => {
      this.running = undefined; if (this.pending && !this.stopped) this.launch();
    });
  }
  async drain() {
    clearTimeout(this.queued); this.queued = undefined;
    if (this.pending && !this.running) this.launch();
    while (this.running) await this.running;
  }
  private async sweep(mode: 'all' | 'requested') {
    const state = await this.engine.snapshot(), groups = new Map<string, Entry[]>(), knownRequests = new Set<string>();
    for (const task of state.tasks) {
      if (task.agent === 'friday' || task.archivedAt || task.projectId && !state.projects.some(p => p.id === task.projectId)) continue;
      for (const link of taskPullRequests(task)) {
        try {
          const key = JSON.stringify([task.projectId ?? task.cwd, changeRequestSyncKey(link)]);
          const entries = groups.get(key) ?? []; entries.push({ task, link }); groups.set(key, entries);
          knownRequests.add(task.id + '\0' + link.url);
        } catch { /* Old malformed links cannot choose a credential destination. */ }
      }
    }
    for (const key of this.last.keys()) if (!groups.has(key)) { this.last.delete(key); this.retryStacks.delete(key); }
    for (const key of this.requested.keys()) if (!knownRequests.has(key)) this.requested.delete(key);
    const entries = [...groups]; let index = 0, failures = 0;
    const read = async () => {
      while (index < entries.length && !this.stopped) {
        const [key, group] = entries[index++]!, first = group[0]!;
        const requested = group.flatMap(e => { const k = e.task.id + '\0' + e.link.url, generation = this.requested.get(k); return generation === undefined ? [] : [{ key: k, generation }]; });
        const missing = group.some(e => !e.link.snapshot), active = group.filter(e => unsettled(e.task));
        if (mode === 'requested' && !requested.length && !missing) continue;
        const terminal = active.every(e => e.link.snapshot?.state === 'merged' && e.link.snapshot.mergedAt != null);
        const open = active.some(e => e.link.snapshot?.state === 'open');
        if (!requested.length && !missing && !this.retryStacks.has(key) && (terminal || !open && this.now() - (this.last.get(key) ?? -Infinity) < 15 * 60_000)) continue;
        const pauseKey = JSON.stringify([first.task.projectId ?? first.task.cwd, new URL(first.link.url).host.toLowerCase()]);
        if ((this.paused.get(pauseKey) ?? 0) > this.now()) continue;
        const missingMergeTime = group.some(e => e.link.snapshot?.state === 'merged' && !e.link.snapshot.mergedAt);
        try {
          const summary = await this.engine.changeRequests.summary(first.task.id, first.link.url, this.controller.signal, !!requested.length || missingMergeTime);
          const needsStack = !!requested.length || this.retryStacks.has(key) || group.some(e => !e.link.snapshot || !sameChangeRequestMetadata(comparableSnapshot(e.link.snapshot), summary.snapshot)
            || summary.stack !== undefined && (e.task.changeRequestStacks?.[e.link.url]?.number ?? null) !== summary.stack);
          let stack: ChangeRequestStack | null | undefined;
          if (needsStack) {
            try { stack = summary.stack === null && group.every(e => !e.task.changeRequestStacks?.[e.link.url]) ? null : await this.engine.changeRequests.stack(first.task.id, first.link.url, this.controller.signal, false); }
            catch (error) { this.retryStacks.add(key); throw error; }
            this.retryStacks.delete(key);
          }
          this.controller.signal.throwIfAborted();
          if (group.some(e => !sameChangeRequestMetadata(comparableSnapshot(e.link.snapshot), summary.snapshot))) await this.engine.changeRequests.invalidatePresentation(summary.pullRequest);
          await this.persist(group, summary, stack);
          this.last.set(key, this.now());
          for (const r of requested) if (this.requested.get(r.key) === r.generation) this.requested.delete(r.key);
        } catch (error) {
          if (this.stopped) return;
          const rate = sourceControlRateFailure(error);
          if (rate) this.paused.set(pauseKey, Math.max(rate.retryAt ?? this.now() + 30_000, this.paused.get(pauseKey) ?? 0));
          failures++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(25, entries.length) }, read));
    for (const [key, until] of this.paused) if (until <= this.now()) this.paused.delete(key);
    if (failures && !this.stopped) console.warn('[Friday runtime] PR synchronization skipped', { count: failures });
  }
  private async persist(entries: Entry[], summary: ChangeRequestSummary, stack: ChangeRequestStack | null | undefined) {
    let changed = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), syncedAt = new Date(this.now()).toISOString();
      for (const entry of entries) {
        const task = state.tasks.find(t => t.id === entry.task.id); if (!task || task.archivedAt) continue;
        const existing = taskPullRequests(task).find(pr => changeRequestSyncKey(pr) === changeRequestSyncKey(entry.link));
        if (!existing || existing.state === 'merged' && summary.pullRequest.state !== 'merged'
          || existing.snapshot && !supersedesSummary({ snapshot: existing.snapshot, observedAt: existing.observedAt ?? 0 }, summary)) continue;
        task.changeRequests ??= [];
        // Link siblings in the same transaction before publishing a terminal
        // snapshot. Tombstones count as present and are never re-added.
        if (stack && unsettled(task)) for (let i = 0; i < stack.layers.length; i++) {
          const layer = stack.layers[i]!, sibling = siblingChangeRequest(summary.pullRequest, layer, i ? stack.layers[i - 1]!.headBranch : stack.base);
          if (!sibling || [...task.changeRequests, ...taskPullRequests(task)].some(pr => changeRequestSyncKey(pr) === changeRequestSyncKey(sibling))) continue;
          if (linkTaskChangeRequest(task, sibling, 'stack', syncedAt)) changed = true;
        }
        const previousStack = task.changeRequestStacks?.[existing.url];
        const nextStack: SavedChangeRequestStack | null | undefined = stack === undefined ? previousStack : stack ? { ...stack, layers: stack.layers.map(({ headSha: _, ...layer }) => layer), syncedAt } : null;
        const snapshotChanged = !sameChangeRequestMetadata(comparableSnapshot(existing.snapshot), summary.snapshot);
        const stackChanged = stack !== undefined && !sameChangeRequestMetadata(comparableStack(previousStack), comparableStack(nextStack));
        if (!snapshotChanged && !stackChanged) continue;
        const next: TaskPullRequest = { ...summary.pullRequest, linkedAt: existing.linkedAt ?? syncedAt, ...(existing.linkSource ? { linkSource: existing.linkSource } : {}), ...(existing.watch ? { watch: existing.watch } : {}), ...(existing.endedWatch ? { endedWatch: existing.endedWatch } : {}), snapshot: snapshotChanged ? { ...summary.snapshot, syncedAt } : existing.snapshot, observedAt: summary.observedAt };
        const at = task.changeRequests.findIndex(pr => changeRequestSyncKey(pr) === changeRequestSyncKey(existing));
        if (at >= 0) task.changeRequests[at] = next; else task.changeRequests.push(next);
        if (stackChanged) { task.changeRequestStacks ??= {}; task.changeRequestStacks[existing.url] = nextStack ?? null; }
        changed = true;
      }
      if (changed) state.revision++;
    }, context);
    if (changed) this.engine.taskSettlement.notify();
  }
  async close() {
    this.stopped = true; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.queued); this.pending = undefined;
    await this.running; this.requested.clear(); this.last.clear(); this.retryStacks.clear(); this.paused.clear(); this.commandRuns.clear();
  }
}
