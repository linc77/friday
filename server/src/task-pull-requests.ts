import type { TaskPullRequest, WorkItem } from './types.js';
import { changeRequestSyncKey } from './task-change-request-summary.js';

/** Public PR metadata survives subsequent Git operations in the overview. */
export function taskPullRequests(task: WorkItem): TaskPullRequest[] {
  const seen = new Set<string>(); const values: TaskPullRequest[] = [];
  const identity = (pr: TaskPullRequest) => { try { return changeRequestSyncKey(pr); } catch { return pr.url; } };
  for (const pr of task.changeRequests ?? []) { if (!seen.has(identity(pr))) { seen.add(identity(pr)); if (!pr.dismissedAt && pr.linkSource !== 'stack-dismissed') values.push(pr); } }
  for (const operation of task.changeRequestLinksRevision === undefined ? [task.gitOperation, ...(task.gitOperations ?? []).slice().reverse()] : []) {
    const pr = operation?.pullRequest;
    if (!pr || seen.has(identity(pr))) continue;
    seen.add(identity(pr)); values.push(pr);
  }
  return values;
}
