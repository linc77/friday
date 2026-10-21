/*!
 * Snooze rules follow pingdotgg/t3code
 * edb21555667dc926bec3f8b2fac41db817b16ae9/packages/client-runtime/src/state/threadSettled.ts
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
import type { WorkItem } from './types.js';

const time = (value?: string | null): number | null => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function canSnoozeTask(task: WorkItem): boolean {
  // A running turn can be put aside. Unadopted input or a request for the
  // user's answer must remain visible. Background/subagent work is not inferred.
  return task.status !== 'queued' && task.status !== 'needs_project'
    && !task.approvals.some(approval => approval.state === 'pending')
    && !(task.queue?.dispatcherId != null && !task.queue.paused && task.queue.messages.some(message => message.status === 'queued' || message.status === 'dispatching'))
    && !task.runs?.some(run => run.id === task.currentRunId && run.workspacePreparation?.status === 'preparing');
}

export function taskSnoozeWakeAt(task: WorkItem, now: number): string | null {
  const until = time(task.snoozedUntil);
  if (until === null || !Number.isFinite(now) || task.archivedAt || task.agent === 'friday') return null;
  // Preserve the first wake for this Snooze. Subsequent output and the original
  // deadline cannot create a second Woke notification after acknowledgment.
  if (time(task.snoozeWakeAt) !== null) return task.snoozeWakeAt!;
  const snoozedAt = time(task.snoozedAt);
  const runs = task.runs?.filter(run => !run.revertedAt && !run.executionExcludedAt) ?? [];
  const run = runs.find(run => run.id === task.currentRunId) ?? runs.at(-1);
  const completed = time(run?.completedAt);
  if (snoozedAt !== null && run?.status === 'completed' && completed !== null && completed > snoozedAt) return run!.completedAt!;
  const updated = time(task.updatedAt);
  if (task.approvals.some(approval => approval.state === 'pending')
    || task.status === 'failed' && (snoozedAt === null || updated !== null && updated > snoozedAt)) {
    return updated !== null && (snoozedAt === null || updated >= snoozedAt) ? task.updatedAt : task.snoozedAt ?? null;
  }
  return until <= now ? task.snoozedUntil! : null;
}

export function taskIsSnoozed(task: WorkItem, now: number): boolean {
  if (task.agent === 'friday' || task.archivedAt) return false;
  const until = time(task.snoozedUntil);
  return until !== null && until > now && taskSnoozeWakeAt(task, now) === null;
}

/** Metadata only: no model, external execution, or native-session replay. */
export function reconcileTaskSnooze(task: WorkItem, now: number): boolean {
  const wakeAt = taskSnoozeWakeAt(task, now);
  if (wakeAt === null || task.snoozeWakeAt === wakeAt) return false;
  task.snoozeWakeAt = wakeAt; task.lastSnoozeWakeAt = wakeAt;
  return true;
}

export function clearTaskSnooze(task: WorkItem, stamp?: string) {
  if (task.snoozedUntil && stamp) task.lastSnoozeWakeAt = stamp;
  task.snoozedUntil = null; task.snoozedAt = null; task.snoozeWakeAt = null;
}
