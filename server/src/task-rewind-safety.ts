import { createHash } from 'node:crypto';
import { canonicalWorkspacePath } from './workspace-privacy.js';
import { directoriesOverlap } from './branch-switch.js';
import type { TaskCheckpoint, WorkItem, Workspace } from './types.js';
import { managedWorktreeLocation } from './managed-worktree.js';
import { rewindExecutions } from './task-run-order.js';

export const sharedRestoreMessage = '文件恢复需要独占 Worktree；这个目录可能包含其他任务的改动。可以回退会话并保留当前文件。';
export const rewindFingerprint = (task: WorkItem, version: 1 | 2 = 2) => createHash('sha256').update(JSON.stringify({
  cwd: task.cwd, threadId: task.threadId, turnId: task.turnId, durableId: task.durableId, nativeHead: task.nativeHead,
  messages: task.messages?.filter(message => !message.revertedAt).map(message => [message.id, message.turnId, message.runId, message.delivery, message.contexts]),
  runs: task.runs?.filter(run => !run.revertedAt).map(run => [run.id, run.threadId, run.turnId, run.nativeHead, run.status, ...(version === 2 ? [run.executionOrder, run.executionMessagePosition, run.executionExcludedAt, ...(run.nativeTurnIds ? [run.nativeTurnIds] : [])] : [])]),
})).digest('hex');

export function rewindTarget(task: WorkItem, messageID: string) {
  const message = task.messages?.find(message => message.id === messageID && message.role === 'user' && !message.revertedAt);
  const runs = task.runs?.filter(run => !run.revertedAt) ?? [];
  const index = runs.findIndex(run => run.messageId === message?.id);
  if (!message || index < 0) throw new Error('这条消息没有可对应的执行轮次；运行中的补充要求不能单独回退');
  const removed = runs.slice(index);
  const executions = rewindExecutions(task, message.id, new Set(removed.map(run => run.id)));
  return { message, keep: runs.slice(0, index), removed, target: runs[index]!, executionKeep: executions.keep, executionRemoved: executions.removed };
}

export async function assertIsolatedRestore(state: Workspace, work: WorkItem, directory: string, checkpoint?: TaskCheckpoint) {
  const plan = work.executionWorkspace;
  if (plan?.mode !== 'worktree' || plan.state !== 'ready') throw new Error(sharedRestoreMessage);
  const cwd = await canonicalWorkspacePath(work.cwd); const root = await canonicalWorkspacePath(plan.root);
  if (cwd !== root) throw new Error(sharedRestoreMessage);
  if (checkpoint && (checkpoint.status !== 'ready' || checkpoint.cwd !== root || checkpoint.root !== root || checkpoint.prefix)) throw new Error('所选文件检查点属于另一个工作区，不能恢复当前目录');
  await managedWorktreeLocation(work, directory);
  for (const other of state.tasks) {
    if (other.id === work.id) continue;
    const paths = [other.cwd, ...(other.executionWorkspace ? [other.executionWorkspace.root] : []), ...(other.runs ?? []).flatMap(run => [run.cwd, ...(run.before ? [run.before.cwd] : []), ...(run.after ? [run.after.cwd] : [])])];
    // Archived threads retain their checkout and native history too.
    if (paths.some(path => directoriesOverlap(root, path))) throw new Error(sharedRestoreMessage);
  }
  return root;
}
