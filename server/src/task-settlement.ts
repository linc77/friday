/*!
 * Automatic settlement rules follow pingdotgg/t3code
 * 8cd9641f76874f2ce17d6c80acd71fab1f0b99d3/apps/server/src/orchestration-v2/ThreadSettlementService.ts
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { resolve } from 'node:path';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeFork, activeGitOperation, activeRewind, activeStatuses, type WorkItem, type Workspace } from './types.js';
import { taskPullRequests } from './task-pull-requests.js';
import { reconcileTaskSnooze, taskIsSnoozed, taskSnoozeWakeAt } from './task-snooze.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';
import { taskCanSettle } from './task-metadata.js';

export type TaskSettlementScope = { sidebarAutoSettleAfterDays?: number | null; sidebarAutoSettleOnMerge?: boolean; sidebarAutoSettleKeepPullRequests?: boolean };
export type TaskSettlementSettings = { version: number; defaults: TaskSettlementScope & { sidebarAutoSettleAfterDays: number | null }; projects: Record<string, TaskSettlementScope> };
export type TaskSettlementSnapshot = { version: number; projectId: string | null; defaults: Required<TaskSettlementScope>; overrides: TaskSettlementScope; effective: Required<TaskSettlementScope>; source: 'default' | 'host' | 'workspace'; sources: Record<keyof TaskSettlementScope, 'default' | 'host' | 'workspace'> };
const defaults: Required<TaskSettlementScope> = { sidebarAutoSettleAfterDays: 3, sidebarAutoSettleOnMerge: true, sidebarAutoSettleKeepPullRequests: false };
export const taskSettlementDefaults = (): TaskSettlementSettings => ({ version: 0, defaults: { ...defaults }, projects: {} });
export class TaskSettlementSettingsConflict extends Error { constructor(readonly version: number) { super('自动结束设置已在其他设备修改，请重新加载后重试。'); } }
const keys = Object.keys(defaults) as (keyof TaskSettlementScope)[];
const reserved = ['__proto__', 'constructor', 'prototype'];
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自动结束设置格式无效'); return value as Record<string, unknown>; };
export function taskSettlementChange(value: unknown) {
  const body = object(value);
  if (Object.keys(body).some(field => !['projectId', 'expectedVersion', 'changes', 'reset'].includes(field)) || body.projectId !== null && (typeof body.projectId !== 'string' || !body.projectId || body.projectId.length > 100 || reserved.includes(body.projectId))) throw new Error('自动结束设置范围无效');
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new Error('自动结束设置版本无效');
  const changes = body.changes === undefined ? {} : object(body.changes); const reset = body.reset ?? [];
  for (const [key, setting] of Object.entries(changes)) {
    if (!keys.includes(key as keyof TaskSettlementScope)) throw new Error('自动结束设置范围无效');
    if (key === 'sidebarAutoSettleAfterDays') { if (setting !== null && (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 1 || setting > 90)) throw new Error('自动结束天数需要在 1 到 90 之间'); }
    else if (typeof setting !== 'boolean') throw new Error('自动结束开关必须为 true 或 false');
  }
  if (!Array.isArray(reset) || reset.length > keys.length || new Set(reset).size !== reset.length || reset.some(field => !keys.includes(field) || Object.hasOwn(changes, field)) || !reset.length && !Object.keys(changes).length) throw new Error('自动结束设置重置范围无效');
  return { projectId: body.projectId as string | null, expectedVersion: body.expectedVersion as number, changes: changes as TaskSettlementScope, reset: reset as (keyof TaskSettlementScope)[] };
}
export function resolveTaskSettlement(state: Workspace, projectId: string | null): TaskSettlementSnapshot {
  const settings = state.taskSettlementSettings ?? taskSettlementDefaults();
  const stored = { ...defaults, ...settings.defaults }, overrides = projectId && Object.hasOwn(settings.projects, projectId) ? settings.projects[projectId]! : {};
  const effective = { ...stored, ...overrides } as Required<TaskSettlementScope>;
  const sources = Object.fromEntries(keys.map(key => [key, Object.hasOwn(overrides, key) ? 'workspace' : state.taskSettlementSettings && Object.hasOwn(settings.defaults, key) ? 'host' : 'default'])) as TaskSettlementSnapshot['sources'];
  return { version: settings.version, projectId, defaults: stored, overrides: { ...overrides }, effective, source: sources.sidebarAutoSettleAfterDays, sources };
}
const time = (value?: string | null): number | null => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const latest = (values: Array<number | null>) => values.reduce<number | null>((a, b) => b === null ? a : a === null ? b : Math.max(a, b), null);
export function taskSettlementAt(task: WorkItem, nowMs: number, days: number | null, options: Omit<TaskSettlementScope, 'sidebarAutoSettleAfterDays'> & { allowBranchOutcome?: boolean } = {}): string | null {
  if (!Number.isFinite(nowMs) || task.agent === 'friday' || task.archivedAt || task.settledAt || task.settledOverride != null || task.pinnedAt || task.autoSettle === false) return null;
  if (activeStatuses.includes(task.status) || task.status === 'needs_project' || task.approvals.some(approval => approval.state === 'pending') || task.queue?.dispatcherId != null && !task.queue.paused) return null;
  if (task.messages?.some(message => !message.revertedAt && (message.delivery === 'sending' || message.delivery === 'uncertain'))) return null;
  if (task.queue?.messages.some(message => ['queued', 'dispatching', 'steering', 'running', 'uncertain'].includes(message.status))) return null;
  if (activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || activeFork(task.forkOperation) || ['queued', 'running'].includes(task.branchChange?.status ?? '')) return null;
  const visible = taskPullRequests(task);
  const terminalTime = (pr: (typeof visible)[number]) => time(pr.snapshot?.state === 'merged' ? pr.snapshot.mergedAt : pr.snapshot?.closedAt) ?? -Infinity;
  const links = visible.filter(pr => !pr.snapshot || pr.snapshot.state === 'open' || time(pr.linkedAt) === null || terminalTime(pr) >= time(pr.linkedAt)!);
  if (links.some(pr => !pr.snapshot || pr.snapshot.state === 'open')) return null;
  if (task.changeRequestOperations?.some(op => ['queued', 'running'].includes(op.status))) return null;
  if (hasRunningBackgroundCommands(task)) return null;
  if (taskIsSnoozed(task, nowMs)) return null;
  const runs = task.runs?.filter(run => !run.revertedAt && !run.executionExcludedAt) ?? [];
  const run = runs.find(run => run.id === task.currentRunId) ?? runs.at(-1);
  const user = (task.messages ?? []).filter(message => message.role === 'user' && !message.revertedAt && message.creationSource !== 'monitor').reduce<number | null>((at, message) => latest([at, time(message.at)]), null);
  const legacy = task.messages === undefined && task.runs === undefined ? time(task.updatedAt) : null;
  const activity = latest([user, time(run?.at), time(run?.startedAt), time(run?.completedAt), legacy]);
  if (task.status !== 'failed' && user !== null && Math.abs(nowMs - user) <= 2 * 60_000 && [time(run?.at), time(run?.startedAt), time(run?.completedAt)].every(at => at === null || at < user)) return null;
  const terminal = links.length ? links.reduce((a, b) => terminalTime(b) > terminalTime(a) ? b : a) : visible.length || options.allowBranchOutcome === false ? undefined : task.branchPullRequest;
  if (terminal) {
    const state = terminal.snapshot?.state ?? terminal.state;
    const endedAt = terminalTime(terminal), userAnchor = latest([time(task.createdAt), user]);
    if ((state === 'closed' || state === 'merged' && options.sidebarAutoSettleOnMerge !== false) && userAnchor !== null && Number.isFinite(endedAt) && endedAt >= userAnchor) return new Date(activity ?? Date.parse(task.createdAt)).toISOString();
  }
  if (options.sidebarAutoSettleKeepPullRequests === true && (links.length > 0 || task.branchPullRequest != null)) return null;
  if (days === null || activity === null) return null;
  // A just-expired or explicitly woken Snooze restarts inactivity, so an old
  // task actually returns to the inbox before it can settle again.
  const anchor = latest([activity, time(task.lastSnoozeWakeAt), time(taskSnoozeWakeAt(task, nowMs))])!;
  return anchor < nowMs - days * 86_400_000 ? new Date(anchor).toISOString() : null;
}

/** Stateless reconciliation over Durable state, with no external execution or
 * side effects to replay. Timers are recreated after service restart. */
export class TaskSettlement {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private dirty = false;
  private stopped = false;
  constructor(private readonly engine: Engine, private readonly intervalMs = 60_000) {}
  async snapshot(projectId: string | null) {
    const state = await this.engine.snapshot();
    if (projectId !== null && !state.projects.some(project => project.id === projectId)) throw new Error('Workspace 不存在');
    return resolveTaskSettlement(state, projectId);
  }
  async save(value: unknown) {
    const change = taskSettlementChange(value);
    await this.engine.mutate(state => {
      if (change.projectId && !state.projects.some(project => project.id === change.projectId)) throw new Error('Workspace 不存在');
      const settings = state.taskSettlementSettings ?? taskSettlementDefaults();
      if (settings.version !== change.expectedVersion) throw new TaskSettlementSettingsConflict(settings.version);
      state.taskSettlementSettings ??= settings; const stored = state.taskSettlementSettings;
      if (change.projectId) {
        if (!Object.hasOwn(stored.projects, change.projectId)) stored.projects[change.projectId] = {};
        Object.assign(stored.projects[change.projectId], change.changes);
        for (const key of change.reset) delete stored.projects[change.projectId]![key];
        if (!Object.keys(stored.projects[change.projectId]).length) delete stored.projects[change.projectId];
      } else {
        Object.assign(stored.defaults, change.changes);
        for (const key of change.reset) Object.assign(stored.defaults, { [key]: defaults[key] });
      }
      stored.version++;
    });
    this.notify(); return this.snapshot(change.projectId);
  }
  async sweep(at = Date.now()) {
    // Branch references are a fallback, not manual associations. A terminal
    // fallback that would newly settle work is confirmed outside the root
    // transaction; the transaction then rechecks activity, scope and proof.
    const before = await this.engine.snapshot(), confirmations: string[] = [];
    for (const task of before.tasks) {
      if (!task.projectId || !task.branchPullRequest || taskPullRequests(task).length) continue;
      const project = before.projects.find(project => project.id === task.projectId); if (!project) continue;
      const settings = resolveTaskSettlement(before, project.id).effective;
      if (taskSettlementAt(task, at, settings.sidebarAutoSettleAfterDays, { ...settings, allowBranchOutcome: false }) !== null) continue;
      if (taskSettlementAt(task, at, null, settings) !== null && !this.engine.changeRequestDiscovery.hasFreshValidation(task, project.path)) confirmations.push(task.id);
    }
    if (confirmations.length) await this.engine.changeRequestDiscovery.confirm(confirmations);
    let nextWake: number | null = null; const detach: number[] = [];
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); let changed = false;
      for (const task of state.tasks) {
        // Wakes are independent of auto-settlement preferences and workspace
        // registration. Restart catch-up retains the original deadline.
        if (reconcileTaskSnooze(task, at)) changed = true;
        if (taskIsSnoozed(task, at)) { const until = time(task.snoozedUntil)!; nextWake = nextWake === null ? until : Math.min(nextWake, until); }
        if (task.projectId && !state.projects.some(project => project.id === task.projectId)) continue;
        const projectId = task.projectId ?? state.projects.find(project => resolve(project.path) === resolve(task.cwd))?.id ?? null;
        const settings = resolveTaskSettlement(state, projectId).effective;
        const anyConfigured = state.taskSettlementSettings ? state.taskSettlementSettings.defaults.sidebarAutoSettleAfterDays !== null || state.taskSettlementSettings.defaults.sidebarAutoSettleOnMerge !== false || Object.values(state.taskSettlementSettings.projects).some(scope => scope.sidebarAutoSettleOnMerge === true || typeof scope.sidebarAutoSettleAfterDays === 'number') : true;
        const project = state.projects.find(project => project.id === projectId);
        const allowBranchOutcome = !!project && this.engine.changeRequestDiscovery.hasFreshValidation(task, project.path);
        const settledAt = anyConfigured ? taskSettlementAt(task, at, settings.sidebarAutoSettleAfterDays, { ...settings, allowBranchOutcome }) : null;
        if (!settledAt || !taskCanSettle(task)) continue;
        const id = await this.engine.settles.prepare(tx, state, task, { settled: true }, settledAt); if (id !== undefined) detach.push(id);
        changed = true;
      }
      if (changed) { await this.engine.projectScripts.captureSettles(tx, state); state.revision++; }
    }, context);
    if (detach.length) { this.engine.harness.resume(); await Promise.all(detach.map(id => this.engine.harness.waitForTask(id as import('@earendil-works/pi-durable').TaskId, context))); }
    return nextWake;
  }
  async start() {
    this.schedule(await this.sweep());
  }
  private schedule(nextWake: number | null) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    const delay = Math.max(1, Math.min(this.intervalMs, nextWake === null ? Infinity : nextWake - Date.now()));
    this.timer = setTimeout(() => { this.timer = undefined; this.notify(); }, delay); this.timer.unref();
  }
  notify() {
    if (this.stopped) return;
    this.dirty = true;
    clearTimeout(this.timer);
    if (this.running) return;
    let nextWake: number | null = null;
    this.running = (async () => {
      while (this.dirty && !this.stopped) { this.dirty = false; nextWake = await this.sweep(); }
    })().catch(() => { console.error('[Friday runtime] task settlement failed'); }).finally(() => {
      this.running = undefined;
      if (this.dirty && !this.stopped) this.notify(); else this.schedule(nextWake);
    });
  }
  async close() { this.stopped = true; clearTimeout(this.timer); await this.running; }
}
