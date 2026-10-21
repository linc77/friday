/*!
 * Working and inbox ordering follow pingdotgg/t3code
 * edb21555667dc926bec3f8b2fac41db817b16ae9/packages/client-runtime/src/state/threadInbox.ts
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
import type { TaskSidebarActivity, WorkItem } from './types.js';

const time = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const iso = (value: number) => value ? new Date(value).toISOString() : null;
export function taskSidebarActivity(task: WorkItem): TaskSidebarActivity {
  const run = task.runs?.find(value => value.id === task.currentRunId && !value.revertedAt && !value.executionExcludedAt)
    ?? task.runs?.findLast(value => !value.revertedAt && !value.executionExcludedAt);
  const runRequest = run && task.queue?.messages.find(message => message.id === run.messageId);
  const publishedAuthored = task.messages === undefined
    ? task.events.reduce((latest, event) => event.kind === 'user' && !event.revertedAt ? Math.max(latest, time(event.at)) : latest, task.prompt.trim() ? time(task.createdAt) : 0)
    : task.messages.reduce((latest, message) => {
      if (message.role !== 'user' || message.revertedAt || message.creationSource === 'monitor') return latest;
      const queued = task.queue?.messages.find(queued => queued.id === message.id);
      return Math.max(latest, time(queued?.createdAt) || time(message.at));
    }, 0);
  // Accepted queue entries are human sends even before they become a visible
  // conversation message. Activation must not give an old send a new date.
  const reverted = new Set([...(task.messages ?? []).filter(message => message.revertedAt).map(message => message.id), ...(task.runs ?? []).filter(run => run.revertedAt).map(run => run.messageId)]);
  const authored = (task.queue?.messages ?? []).reduce((latest, message) => message.creationSource !== 'monitor' && message.status !== 'cancelled' && !reverted.has(message.id) ? Math.max(latest, time(message.createdAt)) : latest, publishedAuthored);
  const executing = ['queued', 'running', 'waiting'].includes(task.status) || task.queue?.dispatcherId != null && !task.queue.paused || task.changeRequests?.some(pr => pr.watch && !pr.dismissedAt && pr.linkSource !== 'stack-dismissed') === true;
  return { working: task.agent !== 'friday' && executing && !task.backgroundWaiting && !task.approvals.some(approval => approval.state === 'pending'),
    latestUserAuthoredMessageAt: iso(authored), latestRunRequestedAt: iso(time(runRequest?.createdAt) || time(run?.at)), latestRunCompletedAt: iso(time(run?.completedAt)) };
}
export function sidebarInboxReturnAt(task: WorkItem): number {
  const activity = taskSidebarActivity(task);
  return Math.max(time(task.createdAt), time(task.unsettledAt), time(activity.latestRunRequestedAt), time(activity.latestRunCompletedAt));
}
export function sidebarWorkingSentAt(task: WorkItem): number {
  return Math.max(time(task.createdAt), time(taskSidebarActivity(task).latestUserAuthoredMessageAt));
}
