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
import { access } from 'node:fs/promises';
import { WorkspaceDoc } from './state.js';
import type { Engine } from './engine.js';
import type { TaskPullRequest, WorkItem } from './types.js';
import { readTaskGitStatus } from './task-git-status.js';
import { resolveCreationContext, verifyCreationRemotes } from './task-change-request-creation.js';
import { findTaskChangeRequest, pinTaskChangeRequest, readTaskChangeRequestSummary } from './task-change-requests.js';
import { sameChangeRequestMetadata, changeRequestSyncKey, supersedesSummary } from './task-change-request-summary.js';
import { sourceControlRateFailure } from './source-control-request-policy.js';
const branch = (task: WorkItem) => task.executionWorkspace?.branch ?? (task.branchChange?.status === 'completed' ? task.branchChange.branch : task.gitOperation?.branch) ?? null;
const active = (task: WorkItem) => !task.settledAt && task.settledOverride !== 'settled';
const comparable = (pr: TaskPullRequest | null | undefined) => pr ? { ...pr, observedAt: undefined, snapshot: pr.snapshot ? { ...pr.snapshot, syncedAt: undefined } : undefined } : null;

/** Branch discovery keeps its own reference, so merely finding or viewing a PR
 * never creates a manual association. No checkout, fetch, hook or model runs. */
export class TaskChangeRequestDiscovery {
  private readonly controller = new AbortController();
  private readonly requested = new Map<string, number>();
  private readonly backfill = new Map<string, number>();
  private readonly paused = new Map<string, number>();
  private readonly validations = new Map<string, { at: number; signature: string }>();
  private generation = 0;
  private pending: 'all' | 'requested' | undefined;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private queued?: NodeJS.Timeout;
  private started = false;
  private stopped = false;
  private initialized = false;
  constructor(private readonly engine: Engine, private readonly intervalMs = 60_000) {}
  start() { if (this.started || this.stopped || this.intervalMs <= 0) return; this.started = true; this.enqueue('all'); }
  request(id: string) { this.engine.changeRequestDiscovery.invalidateValidation(id); if (this.stopped || this.intervalMs <= 0) return; this.requested.set(id, ++this.generation); if (this.started) this.enqueue('requested'); }
  poll() { if (this.started) this.enqueue('all'); }
  private validationSignature(task: WorkItem, projectPath: string) { return JSON.stringify([task.projectId, projectPath, task.cwd, branch(task), task.updatedAt, task.branchPullRequest ? changeRequestSyncKey(task.branchPullRequest) : null, task.branchPullRequest?.snapshot?.state, task.branchPullRequest?.snapshot?.updatedAt, task.branchPullRequest?.snapshot?.headSha]); }
  invalidateValidation(id: string) { this.validations.delete(id); }
  private noteValidation(task: WorkItem, projectPath: string) {
    this.validations.delete(task.id); this.validations.set(task.id, { at: Date.now(), signature: this.validationSignature(task, projectPath) });
    while (this.validations.size > 512) this.validations.delete(this.validations.keys().next().value!);
  }
  hasFreshValidation(task: WorkItem, projectPath: string) {
    const value = this.validations.get(task.id); return !!value && Date.now() - value.at < 5000 && value.signature === this.validationSignature(task, projectPath);
  }
  async confirm(ids: readonly string[]) {
    if (!this.started || this.stopped || this.intervalMs <= 0) return;
    for (const id of ids) this.request(id);
    await this.drain();
  }

  private enqueue(mode: 'all' | 'requested') {
    if (this.stopped) return; if (this.pending !== 'all') this.pending = mode;
    if (!this.running && !this.queued) { this.queued = setTimeout(() => { this.queued = undefined; this.launch(); }, 20); this.queued.unref(); }
  }
  private launch() {
    if (this.running || this.stopped) return;
    this.running = (async () => { while (this.pending && !this.stopped) { const mode = this.pending; this.pending = undefined; await this.sweep(mode);
      if (mode === 'all' && !this.stopped) { clearTimeout(this.timer); this.timer = setTimeout(() => this.enqueue('all'), this.intervalMs); this.timer.unref(); }
    } })().catch(() => { if (!this.stopped) console.warn('[Friday runtime] branch PR discovery failed'); }).finally(() => { this.running = undefined; if (this.pending && !this.stopped) this.launch(); });
  }
  async drain() { clearTimeout(this.queued); this.queued = undefined; if (this.pending && !this.running) this.launch(); while (this.running) await this.running; }
  private async sweep(mode: 'all' | 'requested') {
    const state = await this.engine.snapshot(), projects = new Map(state.projects.map(p => [p.id, p]));
    if (!this.initialized) { for (const task of state.tasks) if (!active(task) && !task.branchPullRequest && branch(task)) this.backfill.set(task.id, 5); this.initialized = true; }
    const groups = new Map<string, WorkItem[]>();
    for (const task of state.tasks) {
      if (task.agent === 'friday' || task.subagentOrigin || task.archivedAt || !task.projectId || !projects.has(task.projectId) || !branch(task) || !active(task) && !this.requested.has(task.id) && !this.backfill.has(task.id)) continue;
      if (mode === 'requested' && !this.requested.has(task.id)) continue;
      const key = JSON.stringify([task.projectId, task.cwd, branch(task)]), group = groups.get(key) ?? []; group.push(task); groups.set(key, group);
    }
    const live = new Set(state.tasks.map(t => t.id)); for (const id of this.requested.keys()) if (!live.has(id)) this.requested.delete(id); for (const id of this.backfill.keys()) if (!live.has(id)) this.backfill.delete(id);
    const values = [...groups.values()]; let index = 0, failures = 0;
    const read = async () => { while (index < values.length && !this.stopped) {
      const tasks = values[index++]!, first = tasks[0]!, project = projects.get(first.projectId!)!, expectedBranch = branch(first)!;
      const generations = new Map(tasks.map(task => [task.id, this.requested.get(task.id)])), refresh = [...generations.values()].some(generation => generation !== undefined);
      let pauseKey: string | undefined;
      try {
        let cwd = first.cwd; try { await access(cwd); } catch { cwd = project.path; }
        const review = await readTaskGitStatus(cwd, { directory: this.engine.directory, workspace: first.executionWorkspace }, this.engine.sourceControl); this.controller.signal.throwIfAborted();
        if (review.status !== 'repository' || !review.remote || !review.sourceControl) { for (const task of tasks) this.backfill.delete(task.id); continue; }
        pauseKey = first.projectId + '\0' + review.sourceControl.host; if ((this.paused.get(pauseKey) ?? 0) > Date.now()) continue;
        const selected = { ...review, branch: expectedBranch };
        const scope = 'branch:' + JSON.stringify([project.id, project.path, cwd, expectedBranch]);
        if (refresh) await this.engine.sourceControl.reads.invalidate(scope);
        const contextKey = JSON.stringify(['branch-context', scope, review.trackingFingerprint, await this.engine.sourceControl.revision()]);
        const creation = await this.engine.sourceControl.reads.get(contextKey, signal => resolveCreationContext(cwd, selected, this.engine.sourceControl, {}, signal), { signal: this.controller.signal, scopes: [scope, 'project:' + project.id], bucket: 'branch-context', ttl: 15 * 60_000 });
        const pinned = await pinTaskChangeRequest(cwd, creation.target, this.engine.sourceControl, this.controller.signal);
        const key = JSON.stringify([scope, creation.sourceRemoteFingerprint, creation.targetRemoteFingerprint, creation.source.path, creation.target.path, creation.sourceBranch, review.trackingFingerprint, pinned.fingerprint]);

        let detected = await this.engine.sourceControl.reads.get(key, signal => findTaskChangeRequest(pinned, creation.target, creation.sourceBranch, signal, { source: creation.source, sourceProjectID: creation.sourceProjectID, targetProjectID: creation.targetProjectID, includeTerminal: true }), { signal: this.controller.signal, scopes: [scope, 'project:' + project.id], bucket: 'branch', ttl: 2 * 60_000 });
        const defaultBranch = review.defaultBranch ?? creation.baseBranch;
        if (detected && detected.state !== 'open' && (expectedBranch === defaultBranch || !defaultBranch && ['main', 'master'].includes(expectedBranch))) detected = null;
        const previous = first.branchPullRequest;
        let retained: TaskPullRequest | null = detected;
        if (!detected && previous && previous.head === creation.sourceBranch && previous.host === creation.target.host && previous.repository?.toLowerCase() === creation.target.path.toLowerCase()) {
          const summary = await readTaskChangeRequestSummary(pinned, creation.target, previous.number, this.controller.signal);
          if (summary.pullRequest.state !== 'open') retained = { ...summary.pullRequest, snapshot: { ...summary.snapshot, syncedAt: new Date().toISOString() }, observedAt: summary.observedAt };
        }
        await verifyCreationRemotes(cwd, creation, this.engine.sourceControl); this.controller.signal.throwIfAborted();
        const fresh = await readTaskGitStatus(cwd, { directory: this.engine.directory, workspace: first.executionWorkspace }, this.engine.sourceControl);
        if (fresh.trackingFingerprint !== review.trackingFingerprint) continue;
        let changed = false;
        await this.engine.root.commit(async tx => {
          const current = await tx.doc(WorkspaceDoc); if (current.projects.find(p => p.id === project.id)?.path !== project.path) return;
          for (const expected of tasks) {
            const task = current.tasks.find(t => t.id === expected.id);
            if (!task || task.projectId !== expected.projectId || task.cwd !== expected.cwd || branch(task) !== expectedBranch || task.updatedAt !== expected.updatedAt) continue;
            if (retained?.snapshot && task.branchPullRequest?.snapshot && changeRequestSyncKey(retained) === changeRequestSyncKey(task.branchPullRequest)
              && !supersedesSummary({ snapshot: task.branchPullRequest.snapshot, observedAt: task.branchPullRequest.observedAt ?? 0 }, { snapshot: retained.snapshot, observedAt: retained.observedAt ?? 0 })) continue;
            if (!sameChangeRequestMetadata(comparable(task.branchPullRequest), comparable(retained))) { task.branchPullRequest = retained; current.revision++; changed = true; }
            // Only an explicitly uncached lookup can confirm settlement. A
            // cached periodic result or a superseded request cannot renew proof.
            if (refresh && this.requested.get(task.id) === generations.get(task.id)) this.engine.changeRequestDiscovery.noteValidation(task, project.path);
            this.backfill.delete(task.id);
            if (this.requested.get(task.id) === generations.get(task.id)) this.requested.delete(task.id);
          }
        }, context);
        if (changed || !refresh && retained && retained.state !== 'open') this.engine.taskSettlement.notify();
      } catch (error) {
        if (this.stopped) return; failures++;
        const limited = sourceControlRateFailure(error); if (limited && pauseKey) this.paused.set(pauseKey, limited.retryAt ?? Date.now() + 30_000);
        for (const task of tasks) { this.engine.changeRequestDiscovery.invalidateValidation(task.id); const remaining = this.backfill.get(task.id); if (remaining !== undefined) { if (remaining <= 1) this.backfill.delete(task.id); else this.backfill.set(task.id, remaining - 1); } }
      }
    } };
    await Promise.all(Array.from({ length: Math.min(8, values.length) }, read));
    if (failures && !this.stopped) console.warn('[Friday runtime] branch PR discovery skipped', { count: failures });
  }
  async close() { this.stopped = true; this.controller.abort(); clearTimeout(this.timer); clearTimeout(this.queued); this.pending = undefined; await this.running; this.requested.clear(); this.backfill.clear(); this.paused.clear(); this.validations.clear(); }
}
