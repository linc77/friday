import type { TaskRun, WorkItem } from './types.js';

export const hasExecution = (run: TaskRun) => !run.revertedAt && !run.executionExcludedAt &&
  (run.executionOrder !== undefined || run.before !== undefined || run.startedAt !== undefined || run.turnId !== undefined || run.nativeHead !== undefined);

// Execution positions are captured before the provider starts. For older
// records, saved responses and checkpoint timestamps provide the same order;
// provider adapters still verify the actual native prefix before changing it.
export function executionPosition(task: WorkItem, run: TaskRun): number {
  if (run.executionMessagePosition !== undefined) return run.executionMessagePosition;
  const messages = task.messages ?? [];
  const answer = messages.findLastIndex(message => !message.revertedAt && message.role === 'assistant' && (message.runId === run.id || run.turnId && message.turnId === run.turnId));
  if (answer >= 0) return answer;
  const started = Date.parse(run.startedAt ?? run.before?.at ?? '');
  if (Number.isFinite(started)) {
    const next = messages.findIndex(message => !message.revertedAt && Number.isFinite(Date.parse(message.at ?? '')) && Date.parse(message.at!) >= started);
    return next >= 0 ? next : messages.length;
  }
  return Math.max(0, messages.findIndex(message => message.id === run.messageId) + 1);
}

export function executionRuns(task: WorkItem): TaskRun[] {
  const runs = task.runs?.filter(hasExecution) ?? [];
  if (runs.every(run => run.executionOrder !== undefined)) return runs.sort((a, b) => a.executionOrder! - b.executionOrder!);
  const positions = new Map(runs.map(run => [run.id, executionPosition(task, run)]));
  const indexes = new Map((task.runs ?? []).map((run, index) => [run.id, index]));
  return runs.sort((a, b) => positions.get(a.id)! - positions.get(b.id)!
    || (a.executionOrder !== undefined && b.executionOrder !== undefined ? a.executionOrder - b.executionOrder : 0)
    || (a.durableId !== null && b.durableId !== null ? a.durableId - b.durableId : 0)
    || indexes.get(a.id)! - indexes.get(b.id)!);
}

export function recordExecution(task: WorkItem, run: TaskRun) {
  if (run.executionOrder === undefined) {
    const older = executionRuns(task).filter(other => other.id !== run.id);
    if (older.some(other => other.executionOrder === undefined)) older.forEach((other, index) => { other.executionOrder = index; });
    run.executionOrder = Math.max(-1, ...(task.runs ?? []).map(other => other.executionOrder ?? -1)) + 1;
  }
  run.executionMessagePosition ??= task.messages?.length ?? 0;
}

export function rewindExecutions(task: WorkItem, messageID: string, removedRunIds: Set<string>) {
  const messages = task.messages?.filter(message => !message.revertedAt) ?? [];
  const index = messages.findIndex(message => message.id === messageID);
  const fullIndex = task.messages?.findIndex(message => message.id === messageID) ?? index;
  const ordered = executionRuns(task);
  const removed = new Set(ordered.filter(run => removedRunIds.has(run.id) || executionPosition(task, run) > fullIndex).map(run => run.id));
  // Native reverts remove a suffix, including later executions whose original
  // user input was earlier (a previously failed preparation can run later).
  const native = ordered.filter(run => run.threadId === task.threadId && run.turnId);
  const first = native.findIndex(run => removed.has(run.id));
  if (first >= 0) for (const run of native.slice(first)) removed.add(run.id);
  return { ordered, removed: ordered.filter(run => removed.has(run.id)), keep: ordered.filter(run => !removed.has(run.id)) };
}

export function forkMessageBoundary(task: WorkItem, selected: TaskRun) {
  const messages = task.messages ?? [];
  const answer = messages.findLastIndex(message => !message.revertedAt && message.role === 'assistant' && (message.runId === selected.id || selected.turnId && message.turnId === selected.turnId));
  if (answer >= 0) return answer + 1;
  const originalPosition = executionPosition(task, selected);
  const primary = new Set((task.runs ?? []).map(run => run.messageId));
  const next = messages.findIndex((message, index) => !message.revertedAt && index >= originalPosition && message.role === 'user' && message.id !== selected.messageId && !message.delivery && (primary.has(message.id) || !message.runId));
  return next >= 0 ? next : messages.length;
}

export function clearExcludedExecution(run: TaskRun, at: string) {
  run.executionExcludedAt = at;
  delete run.threadId; delete run.turnId; delete run.nativeHead; delete run.nativeTurnIds;
  delete run.before; delete run.after; delete run.changes; delete run.diffError;
  delete run.startedAt; delete run.completedAt;
}
