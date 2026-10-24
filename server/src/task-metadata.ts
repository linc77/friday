import { createHash } from 'node:crypto';
import { activeFork, runningFork, activeGitOperation, activeRewind, activeStatuses, type TaskRun, type WorkItem, type Workspace } from './types.js';
import { queueRunning } from './task-queue.js';
import { canSnoozeTask, clearTaskSnooze, reconcileTaskSnooze, taskSnoozeWakeAt } from './task-snooze.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';

export type TaskMetadataChange = {
  title?: string; pinned?: boolean; archived?: boolean; settled?: boolean;
  autoSettle?: boolean; snoozedUntil?: string | null; read?: boolean; seenAt?: string; seenWakeAt?: string;
  pinOrderKey?: string;
  requestId?: string;
};

export function taskMetadataChange(input: unknown): TaskMetadataChange {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('任务设置格式无效');
  const value = input as Record<string, unknown>;
  const allowed = ['title', 'pinned', 'archived', 'settled', 'autoSettle', 'snoozedUntil', 'read', 'seenAt', 'seenWakeAt', 'pinOrderKey', 'requestId'];
  if (!Object.keys(value).length || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('任务设置包含不支持的字段');
  const result: TaskMetadataChange = {};
  if (Object.hasOwn(value, 'requestId')) {
    if (typeof value.requestId !== 'string' || !value.requestId || value.requestId.length > 100 || /[\x00-\x1f]/.test(value.requestId) || ['__proto__', 'constructor', 'prototype'].includes(value.requestId)) throw new Error('任务操作请求 ID 无效');
    if (Object.keys(value).length === 1) throw new Error('任务设置包含不支持的字段');
    result.requestId = value.requestId;
  }
  if (Object.hasOwn(value, 'pinOrderKey')) {
    // T3 accepts an opaque TrimmedNonEmptyString, including legacy keys that
    // the current generator would repair on a subsequent reorder.
    if (value.pinned !== true || typeof value.pinOrderKey !== 'string' || !value.pinOrderKey.trim()) throw new Error('置顶位置无效');
    result.pinOrderKey = value.pinOrderKey.trim();
  }
  if (Object.hasOwn(value, 'title')) {
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.trim().length > 200 || /[\x00-\x1f]/.test(value.title)) throw new Error('任务名称不能为空，最多 200 个字符且不能包含换行');
    result.title = value.title.trim();
  }
  for (const key of ['pinned', 'archived', 'settled', 'autoSettle', 'read'] as const) {
    if (!Object.hasOwn(value, key)) continue;
    if (typeof value[key] !== 'boolean') throw new Error('任务设置需要布尔值');
    result[key] = value[key];
  }
  if (Object.hasOwn(value, 'snoozedUntil')) {
    if (value.snoozedUntil !== null && (typeof value.snoozedUntil !== 'string' || !Number.isFinite(Date.parse(value.snoozedUntil)))) throw new Error('稍后处理时间无效');
    result.snoozedUntil = value.snoozedUntil === null ? null : new Date(value.snoozedUntil as string).toISOString();
  }
  if (Object.hasOwn(value, 'seenAt')) {
    if (value.read !== true || typeof value.seenAt !== 'string' || !Number.isFinite(Date.parse(value.seenAt))) throw new Error('已读时间无效');
    result.seenAt = new Date(value.seenAt).toISOString();
  }
  if (Object.hasOwn(value, 'seenWakeAt')) {
    if (value.read !== true || typeof value.seenWakeAt !== 'string' || !Number.isFinite(Date.parse(value.seenWakeAt))) throw new Error('唤醒已读时间无效');
    result.seenWakeAt = new Date(value.seenWakeAt).toISOString();
  }
  return result;
}

export type TaskMetadataReceipt = { taskId: string; digest: string; cleanupId?: number };
const metadataDigest = (change: TaskMetadataChange) => createHash('sha256').update(JSON.stringify(Object.keys(change).filter(key => key !== 'requestId').sort().map(key => [key, change[key as keyof TaskMetadataChange]]))).digest('hex');
export function priorTaskMetadata(state: Workspace, taskId: string, change: TaskMetadataChange): TaskMetadataReceipt | undefined {
  if (!change.requestId) return;
  const key = 'metadata:' + change.requestId, receipt = state.taskMetadataRequests?.[key];
  if (receipt && (receipt.taskId !== taskId || receipt.digest !== metadataDigest(change))) throw new Error('任务操作请求 ID 已用于其他内容');
  return receipt;
}
export function recordTaskMetadata(state: Workspace, taskId: string, change: TaskMetadataChange, cleanupId?: number) {
  if (!change.requestId) return;
  state.taskMetadataRequests ??= {}; state.taskMetadataRequests['metadata:' + change.requestId] = { taskId, digest: metadataDigest(change), ...(cleanupId !== undefined ? { cleanupId } : {}) };
}

export const automaticallyQueuedRun = (task: WorkItem, run: TaskRun) => !run.revertedAt && !run.executionExcludedAt && run.status === 'queued' && !run.startedAt && !run.before && !run.workspacePreparation && task.messages?.some(message => message.id === run.messageId && !message.revertedAt && message.creationSource !== undefined) === true;
export function assertTaskCanSettle(task: WorkItem) {
  if (task.agent === 'friday' || task.subagentOrigin || task.archivedAt || task.archiveCleanup?.status === 'pending') throw new Error('当前任务不能结束跟进');
  if (task.delegatedTasks?.some(child => !child.suppressed && (['queued','running','waiting'].includes(child.status) || child.pendingChildren))) throw new Error('请先停止委派子任务再结束跟进');
  if (task.approvals.some(approval => approval.state === 'pending') || task.pendingSubagentRequest) throw new Error('请先处理审批或问题再结束跟进');
  const runs = (task.runs ?? []).filter(run => !run.revertedAt && !run.executionExcludedAt);
  const automatic = new Set(runs.filter(run => automaticallyQueuedRun(task, run)).map(run => run.id));
  if (runs.some(run => ['running', 'waiting'].includes(run.status)) || ['running', 'waiting', 'needs_project'].includes(task.status) || task.status === 'queued' && !automatic.has(task.currentRunId ?? '')) throw new Error('请先停止正在运行的任务再结束跟进');
  if (runs.some(run => run.status === 'queued' && !automatic.has(run.id)) || task.queue?.messages.some(message => ['queued', 'dispatching', 'steering', 'running', 'uncertain'].includes(message.status) && !(message.creationSource !== undefined && ['queued', 'dispatching'].includes(message.status) && message.runId === undefined)) || task.messages?.some(message => !message.revertedAt && message.creationSource === undefined && ['sending', 'uncertain'].includes(message.delivery ?? ''))) throw new Error('请先发送或移除排队消息再结束跟进');
  if (activeGitOperation(task.gitOperation) || activeFork(task.forkOperation) || activeRewind(task.rewindOperation) || ['queued', 'running'].includes(task.branchChange?.status ?? '')) throw new Error('请先处理 Git 或会话操作再结束跟进');
}
export function taskCanSettle(task: WorkItem) { if (task.settleCleanup?.status === 'pending') return false; try { assertTaskCanSettle(task); return true; } catch { return false; } }

export function applyTaskMetadata(task: WorkItem, change: TaskMetadataChange, stamp: string, archiveLifecycle = false) {
  if (task.agent === 'friday') throw new Error('请在我的任务中管理本地 Agent 会话');
  if (change.settled === true) assertTaskCanSettle(task);
  if (change.archived === true && !archiveLifecycle && hasRunningBackgroundCommands(task)) throw new Error('请先停止后台命令再归档');
  if ((change.archived === true || change.snoozedUntil) && runningFork(task.forkOperation)) throw new Error('请先完成会话分叉再归档或稍后处理');
  if ((change.archived === true || change.snoozedUntil) && activeRewind(task.rewindOperation)) throw new Error('请先处理会话回退再归档或稍后处理');
  if (change.archived === true && !archiveLifecycle && (activeStatuses.includes(task.status) || queueRunning(task) || activeGitOperation(task.gitOperation) || task.queue?.messages.some(item => ['queued', 'dispatching', 'steering', 'running'].includes(item.status)) || ['queued', 'running'].includes(task.branchChange?.status ?? ''))) throw new Error('请先停止任务并处理排队消息再归档');
  if (change.snoozedUntil) {
    if (!canSnoozeTask(task) || activeGitOperation(task.gitOperation)) throw new Error('请先处理待开始的任务或等待确认的操作');
    if (Date.parse(change.snoozedUntil) <= Date.parse(stamp)) throw new Error('请选择未来的稍后处理时间');
  }
  if (change.title !== undefined) { task.title = change.title; task.titleRegeneration = null; }
  if (change.archived !== undefined) {
    task.archivedAt = change.archived ? task.archivedAt ?? stamp : null;
    // T3 archives preserve pin/order/snooze state. Unarchive and Undo expose
    // those same records again; archive is not settlement or deletion.
  }
  if (change.pinned !== undefined) {
    if (change.pinned && task.archivedAt) throw new Error('请先恢复已归档任务再置顶');
    task.pinnedAt = change.pinned ? task.pinnedAt ?? stamp : null;
    if (change.pinned) { if (task.settledAt || task.settledOverride === 'settled') task.settledOverride = 'active'; task.settledAt = null; clearTaskSnooze(task, stamp); }
    else task.pinOrderKey = null;
    if (change.pinned && change.pinOrderKey !== undefined) task.pinOrderKey = change.pinOrderKey;
  }
  if (change.settled !== undefined) {
    const alreadyActive = task.settledOverride === 'active';
    task.settledOverride = change.settled ? 'settled' : 'active';
    task.settledAt = change.settled ? task.settledAt ?? stamp : null;
    task.unsettledAt = change.settled ? null : alreadyActive ? task.unsettledAt ?? null : stamp;
    if (change.settled) { task.pinnedAt = null; task.pinOrderKey = null; task.activeOrderKey = null; clearTaskSnooze(task); }
  }
  if (change.autoSettle !== undefined) task.autoSettle = change.autoSettle;
  if (change.snoozedUntil !== undefined) {
    if (change.snoozedUntil === null) clearTaskSnooze(task, stamp);
    else {
      if (change.requestId || task.snoozedUntil !== change.snoozedUntil) { task.snoozedAt = stamp; task.snoozeWakeAt = null; }
      task.snoozedUntil = change.snoozedUntil;
    }
  }
  if (change.read === false) task.unread = true;
  if (change.read === true) {
    reconcileTaskSnooze(task, Date.parse(stamp));
    // Wake and output receipts are independent. A stale output receipt may
    // acknowledge the wake it actually displayed, but never a different wake.
    if (change.seenWakeAt && Date.parse(change.seenWakeAt) <= Date.parse(stamp) && change.seenWakeAt === taskSnoozeWakeAt(task, Date.parse(stamp))) task.seenSnoozeWakeAt = change.seenWakeAt;
    // A late read receipt cannot acknowledge output the client has not seen.
    const seenAt = change.seenAt ?? (change.seenWakeAt === undefined ? stamp : undefined);
    if (seenAt && Date.parse(seenAt) <= Date.parse(stamp) && Date.parse(seenAt) >= Date.parse(task.updatedAt)) {
      task.readAt = seenAt; task.unread = false;
    }
  }
}
