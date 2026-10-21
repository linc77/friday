/*!
 * Sidebar ordering adapted from pingdotgg/t3code
 * edb21555667dc926bec3f8b2fac41db817b16ae9/packages/client-runtime/src/state/threadSort.ts
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
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { WorkItem, Workspace } from './types.js';
import { sidebarInboxReturnAt, sidebarWorkingSentAt, taskSidebarActivity } from './task-sidebar-activity.js';
import { clearTaskSnooze, taskIsSnoozed } from './task-snooze.js';
import { assertTaskCanSettle } from './task-metadata.js';

export type TaskSidebarSection = 'pinned' | 'active' | 'working' | 'snoozed' | 'settled';
const timestamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function taskSidebarSettledAt(task: WorkItem): string | undefined {
  if (timestamp(task.settledAt)) return task.settledAt!;
  const run = task.runs?.findLast(run => !run.revertedAt && !run.executionExcludedAt);
  const user = task.messages?.findLast(message => message.role === 'user' && !message.revertedAt && !message.delivery);
  const latest = Math.max(timestamp(user?.at), timestamp(run?.at), timestamp(run?.startedAt), timestamp(run?.completedAt)) || timestamp(task.updatedAt);
  return latest ? new Date(latest).toISOString() : undefined;
}
export function taskSidebarSection(task: WorkItem, now: string, workingShelfEnabled = false): TaskSidebarSection {
  const running = ['queued', 'running', 'waiting'].includes(task.status) || task.queue?.dispatcherId != null && !task.queue.paused;
  if (taskIsSnoozed(task, Date.parse(now))) return 'snoozed';
  if (task.settledAt) return 'settled';
  if (task.pinnedAt) return 'pinned';
  if (running || workingShelfEnabled && taskSidebarActivity(task).working) return workingShelfEnabled && taskSidebarActivity(task).working ? 'working' : 'active';
  return 'active';
}
export function sidebarTaskScope(state: Workspace, projectId: string | null, projectIds?: string[], includeUnassociated = false): WorkItem[] {
  if (projectId !== null && !state.projects.some(project => project.id === projectId)) throw new Error('Workspace 不存在');
  if (projectIds?.some(id => !state.projects.some(project => project.id === id))) throw new Error('Workspace 分组已改变');
  return state.tasks.filter(task => {
    if (task.agent === 'friday' || task.archivedAt || task.subagentOrigin) return false;
    const project = task.projectId ? state.projects.find(project => project.id === task.projectId) : state.projects.find(project => resolve(project.path) === resolve(task.cwd));
    if (task.projectId && !project) return false;
    if (projectIds) return project ? projectIds.includes(project.id) : (includeUnassociated || projectIds.length === 0) && task.projectId === null;
    return projectId === null || project?.id === projectId;
  });
}
export function sortSidebarSection(tasks: readonly WorkItem[], section: TaskSidebarSection, workingShelfEnabled = false): WorkItem[] {
  const key = (task: WorkItem) => section === 'pinned' ? task.pinOrderKey : task.activeOrderKey;
  return [...tasks].sort((left, right) => {
    if (section === 'working') return sidebarWorkingSentAt(right) - sidebarWorkingSentAt(left) || left.id.localeCompare(right.id);
    if (section === 'active' && workingShelfEnabled) return sidebarInboxReturnAt(right) - sidebarInboxReturnAt(left) || left.id.localeCompare(right.id);
    if (section === 'pinned' || section === 'active') {
      const a = key(left); const b = key(right);
      if (a != null && b != null) return (a < b ? -1 : a > b ? 1 : 0) || left.id.localeCompare(right.id);
      if ((a != null) !== (b != null)) return (a != null ? -1 : 1) * (section === 'active' ? -1 : 1);
      const anchor = (task: WorkItem) => section === 'pinned' ? timestamp(task.createdAt) : Math.max(timestamp(task.createdAt), timestamp(task.unsettledAt));
      return anchor(right) - anchor(left) || left.id.localeCompare(right.id);
    }
    if (section === 'snoozed') return timestamp(left.snoozedUntil) - timestamp(right.snoozedUntil) || left.id.localeCompare(right.id);
    return timestamp(taskSidebarSettledAt(right)) - timestamp(taskSidebarSettledAt(left)) || left.id.localeCompare(right.id);
  });
}
type SidebarOrderEntry = { id: string; key: string | null };
export type TaskSidebarMove = { requestId: string; projectId: string | null; projectIds?: string[]; includeUnassociated?: boolean; source: TaskSidebarSection; section: Exclude<TaskSidebarSection, 'snoozed' | 'working'>; expected: SidebarOrderEntry[]; orderedIds: string[]; workingShelfEnabled?: boolean };
export class TaskSidebarOrderConflict extends Error { constructor() { super('任务顺序已在其他设备修改，请刷新后重试。'); } }
export function taskSidebarMove(value: unknown): TaskSidebarMove {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('任务排序格式无效');
  const body = value as Record<string, unknown>; const id = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(value);
  if (Object.keys(body).some(key => !['requestId', 'projectId', 'projectIds', 'includeUnassociated', 'source', 'section', 'expected', 'orderedIds', 'workingShelfEnabled'].includes(key)) || !id(body.requestId) || body.projectId !== null && !id(body.projectId)) throw new Error('任务排序范围无效');
  if (body.projectIds !== undefined && (body.projectId !== null || !Array.isArray(body.projectIds) || body.projectIds.length > 1000 || body.projectIds.some(value => !id(value)) || new Set(body.projectIds).size !== body.projectIds.length)) throw new Error('Workspace 分组范围无效');
  if (body.includeUnassociated !== undefined && (typeof body.includeUnassociated !== 'boolean' || !Array.isArray(body.projectIds))) throw new Error('无项目任务的排序范围无效');
  if (Object.hasOwn(body, 'workingShelfEnabled') && typeof body.workingShelfEnabled !== 'boolean') throw new Error('Working 分组设置无效');
  if (!['pinned', 'active', 'working', 'snoozed', 'settled'].includes(String(body.source)) || typeof body.source !== 'string' || !['pinned', 'active', 'settled'].includes(String(body.section)) || typeof body.section !== 'string') throw new Error('不能移动到这个任务分组');
  if (!Array.isArray(body.expected) || body.expected.length > 10_000 || body.expected.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['id', 'key'].includes(key)) || !id(entry.id) || entry.key !== null && (typeof entry.key !== 'string' || entry.key.length > 2048))) throw new Error('任务排序快照无效');
  if (new Set(body.expected.map(entry => entry.id)).size !== body.expected.length || !Array.isArray(body.orderedIds) || body.orderedIds.length > 10_000 || body.orderedIds.some(value => !id(value)) || new Set(body.orderedIds).size !== body.orderedIds.length) throw new Error('任务排序不能包含重复或无效任务');
  return { requestId: body.requestId, projectId: body.projectId, ...(Array.isArray(body.projectIds) ? { projectIds: [...body.projectIds].sort() } : {}), source: body.source, section: body.section, ...(body.includeUnassociated === true ? { includeUnassociated: true } : {}),
    expected: body.expected.map(entry => ({ id: entry.id, key: entry.key })), orderedIds: [...body.orderedIds], ...(body.workingShelfEnabled === true ? { workingShelfEnabled: true } : {}) } as TaskSidebarMove;
}
export function applyTaskSidebarMove(state: Workspace, taskId: string, move: TaskSidebarMove, now: string) {
  const digest = createHash('sha256').update(JSON.stringify({ taskId, move })).digest('hex');
  const receipt = state.sidebarRequests && Object.hasOwn(state.sidebarRequests, move.requestId) ? state.sidebarRequests[move.requestId] : undefined;
  if (receipt) { if (receipt.taskId !== taskId || receipt.digest !== digest) throw new Error('任务排序请求 ID 已被使用'); return; }
  const visible = sidebarTaskScope(state, move.projectId, move.projectIds, move.includeUnassociated); const task = visible.find(task => task.id === taskId);
  if (!task) throw new Error('当前 Workspace 中没有这条任务');
  if (taskSidebarSection(task, now, move.workingShelfEnabled) !== move.source) throw new TaskSidebarOrderConflict();
  const key = (task: WorkItem) => (move.section === 'pinned' ? task.pinOrderKey : move.section === 'active' ? task.activeOrderKey : null) ?? null;
  const current = sortSidebarSection(visible.filter(task => taskSidebarSection(task, now, move.workingShelfEnabled) === move.section), move.section, move.workingShelfEnabled).map(task => ({ id: task.id, key: key(task) }));
  const timeOrdered = move.workingShelfEnabled && move.section === 'active';
  const matches = timeOrdered ? JSON.stringify(current.map(entry => entry.id).sort()) === JSON.stringify(move.expected.map(entry => entry.id).sort()) : JSON.stringify(current) === JSON.stringify(move.expected);
  if (!matches) throw new TaskSidebarOrderConflict();
  const destination = new Set([...current.map(entry => entry.id), taskId]);
  if (destination.size !== move.orderedIds.length || move.orderedIds.some(id => !destination.has(id))) throw new Error('任务排序范围已改变');
  if (move.section === 'settled') {
    assertTaskCanSettle(task);
    task.settledOverride = 'settled';
    if (move.source !== 'settled') { task.settledAt = now; task.unsettledAt = null; }
    task.pinnedAt = null; task.pinOrderKey = null; task.activeOrderKey = null; clearTaskSnooze(task);
  } else {
    const assignments = timeOrdered ? [] : planPinnedReorder({ orderedIds: move.orderedIds, keysById: new Map(state.tasks.map(task => [task.id, key(task)])), movedId: taskId });
    for (const assignment of assignments) {
      const target = visible.find(task => task.id === assignment.id)!;
      if (move.section === 'pinned') target.pinOrderKey = assignment.orderKey; else target.activeOrderKey = assignment.orderKey;
    }
    if (move.source === 'settled' || task.settledAt) { task.settledAt = null; task.settledOverride = 'active'; task.unsettledAt = now; }
    clearTaskSnooze(task, now);
    if (move.section === 'pinned') task.pinnedAt ??= now;
    else { task.pinnedAt = null; task.pinOrderKey = null; }
  }
  state.sidebarRequests ??= {}; state.sidebarRequests[move.requestId] = { taskId, digest };
}

const PIN_ORDER_DIGITS = "abcdefghijklmnopqrstuvwxyz";

function isValidPinOrderKey(key: string): boolean {
  if (key.length === 0) return false;
  for (const char of key) {
    if (!PIN_ORDER_DIGITS.includes(char)) return false;
  }
  // A trailing minimum digit would leave no room to sort a key immediately
  // before this one; generators never produce it, so treat it as corrupt.
  return key.at(-1) !== PIN_ORDER_DIGITS[0];
}

/** Midpoint of two digit strings interpreted as fractions in (0, 1).
    "" stands for the open bound on either side. Requires a < b. */
function pinOrderMidpoint(a: string, b: string): string {
  if (b !== "" && a >= b) throw new Error("pinOrderMidpoint: bounds out of order");
  if (b !== "") {
    let n = 0;
    while ((a.charAt(n) || PIN_ORDER_DIGITS[0]) === b.charAt(n)) n += 1;
    if (n > 0) return b.slice(0, n) + pinOrderMidpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : PIN_ORDER_DIGITS.indexOf(a.charAt(0));
  const digitB = b === "" ? PIN_ORDER_DIGITS.length : PIN_ORDER_DIGITS.indexOf(b.charAt(0));
  if (digitB - digitA > 1) {
    return PIN_ORDER_DIGITS.charAt(Math.round((digitA + digitB) / 2));
  }
  if (b.length > 1) return b.charAt(0);
  return PIN_ORDER_DIGITS.charAt(digitA) + pinOrderMidpoint(a.slice(1), "");
}

/** Key that sorts strictly between two neighbors; null bounds mean "top of
    the pinned block" / "bottom of the keyed run". Returns null instead of
    throwing when existing keys are corrupt or out of order — callers fall
    back to rewriting the section. */
export function pinOrderKeyBetween(before: string | null, after: string | null): string | null {
  const a = before ?? "";
  const b = after ?? "";
  if (a !== "" && !isValidPinOrderKey(a)) return null;
  if (b !== "" && !isValidPinOrderKey(b)) return null;
  if (b !== "" && a >= b) return null;
  return pinOrderMidpoint(a, b);
}

export function generateSpreadPinOrderKeys(count: number): string[] {
  let width = 2;
  let space = PIN_ORDER_DIGITS.length ** width;
  while (space <= (count + 1) * 2) {
    width += 1;
    space *= PIN_ORDER_DIGITS.length;
  }
  const step = space / (count + 1);
  const keys: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let value = Math.round(step * (i + 1));
    if (value % PIN_ORDER_DIGITS.length === 0) value += 1;
    let key = "";
    for (let digit = 0; digit < width; digit += 1) {
      key = PIN_ORDER_DIGITS.charAt(value % PIN_ORDER_DIGITS.length) + key;
      value = Math.floor(value / PIN_ORDER_DIGITS.length);
    }
    keys.push(key);
  }
  return keys;
}

export function planPinnedReorder(input: {
  readonly orderedIds: readonly string[];
  /** Include retained keys from hidden rows; only orderedIds receive writes. */
  readonly keysById: ReadonlyMap<string, string | null | undefined>;
  readonly movedId: string;
}): ReadonlyArray<{ readonly id: string; readonly orderKey: string }> {
  const { orderedIds, keysById, movedId } = input;
  const visibleIds = new Set(orderedIds);
  const reservedKeys = new Set(
    [...keysById].flatMap(([id, key]) => (!visibleIds.has(id) && key != null ? [key] : [])),
  );
  const movedIndex = orderedIds.indexOf(movedId);
  if (movedIndex === -1) return [];
  const beforeId = movedIndex > 0 ? orderedIds[movedIndex - 1] : null;
  const afterId = movedIndex < orderedIds.length - 1 ? orderedIds[movedIndex + 1] : null;
  const beforeKey = beforeId != null ? (keysById.get(beforeId) ?? null) : null;
  const afterKey = afterId != null ? (keysById.get(afterId) ?? null) : null;
  const beforeUsable = beforeId === null || beforeKey != null;
  const afterUsable = afterId === null || afterKey != null;
  if (beforeUsable && afterUsable) {
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    if (key !== null) return [{ id: movedId, orderKey: key }];
  }
  const keys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  return orderedIds.flatMap((id, index) => {
    const key = keys[index]!;
    return keysById.get(id) === key ? [] : [{ id, orderKey: key }];
  });
}
