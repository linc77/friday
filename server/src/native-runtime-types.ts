import { createHash } from 'node:crypto';
import type { Approval, TaskEvent, TaskInteractionMode, TaskMode, WorkItem } from './types.js';
import type { ClaudeBackgroundTask } from './claude-background.js';
import { claudeBackgroundEnded } from './claude-background.js';
import type { ProviderDriver } from './provider-instances.js';

export type NativeObservedUpdate =
  | { kind: 'contextUsage'; usage: import('./task-context-usage.js').TaskContextUsage | null }
  | { kind: 'item'; item: TaskEvent }
  | { kind: 'commandOutput'; eventId: string; delta: string; reset?: boolean; truncated?: boolean }
  | { kind: 'output'; text: string }
  | { kind: 'nativeHead'; head: string; turnIds?: string[] }
  | { kind: 'ready'; canSteer: boolean }
  | { kind: 'backgroundWaiting'; waiting: boolean }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'approvalResolved'; id: string; expired?: boolean }
  | { kind: 'event'; eventKind: string; text: string };
export type NativeTurnParameters = { cwd: string; mode: TaskMode; interactionMode?: TaskInteractionMode; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[] };
type NativeTurnScope = { provider?: ProviderDriver; providerInstanceId?: string };
export type ProviderBackgroundTask = Omit<ClaudeBackgroundTask, 'provider'> & { provider: ProviderDriver; canStop?: boolean; holdsCompletion?: boolean; output?: { text: string; truncated: boolean } };
export type NativeRuntimeUpdate =
  | ({ kind: 'nativeBackground'; threadId: string; sessionId: string; tasks: ProviderBackgroundTask[]; connected?: boolean } & NativeTurnScope)
  | ({ kind: 'nativeBackgroundOutput'; threadId: string; sessionId: string; workId: string; delta: string; reset?: boolean; truncated?: boolean } & NativeTurnScope)
  | ({ kind: 'nativeBackgroundItem'; threadId: string; sessionId: string; runId: string; item: TaskEvent } & NativeTurnScope)
  | ({ kind: 'nativeTurnStart'; threadId: string; sessionId: string; key: string; turnId: string; parameters: NativeTurnParameters } & NativeTurnScope)
  | ({ kind: 'nativeTurnUpdate'; threadId: string; sessionId: string; key: string; value: NativeObservedUpdate } & NativeTurnScope)
  | ({ kind: 'nativeTurnFinish'; threadId: string; sessionId: string; key: string; status: 'completed' | 'failed' | 'interrupted'; result: string; error?: string } & NativeTurnScope);
export type NativeBackgroundWork = ProviderBackgroundTask & {
  stop?: { requestId: string; durableId: number; status: 'pending' | 'completed' | 'failed' | 'uncertain'; error?: string };
  output?: { text: string; truncated: boolean };
};
export type NativeTurnReceipt = {
  provider?: ProviderDriver; providerInstanceId?: string;
  taskId: string; threadId: string; sessionId: string; key: string; runId: string; durableId: number; turnId: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted'; result: string; error?: string; completedAt?: string;
  approvalIds?: string[];
};
export const nativeObservedRunId = (key: string) => 'native:' + createHash('sha256').update(key).digest('hex');
export const nativeTurnReceiptKey = (id: string, session: string, key: string) => createHash('sha256').update(JSON.stringify([id, session, key])).digest('hex');
export const backgroundWorkPending = (task: WorkItem) => task.backgroundCommands?.some(work => work.sessionId === task.executionSessionId
  && (!['completed', 'failed', 'stopped', 'interrupted'].includes(work.status) || work.stop?.status === 'pending'))
  || task.nativeBackgroundWork?.some(work => work.transportId === task.executionSessionId && !work.ambient && (work.member || work.backgrounded) && (!claudeBackgroundEnded(work) || work.stop?.status === 'pending'))
  || task.subagents?.some(agent => agent.sessionId === task.executionSessionId && (['running', 'waiting', 'unknown'].includes(agent.status) || (agent.backgroundCommands ?? 0) + (agent.unknownCommands ?? 0) > 0));
export const activeNativeBackground = (task: { nativeBackgroundWork?: NativeBackgroundWork[] }) => (task.nativeBackgroundWork ?? []).filter(work => work.member && !work.ambient && !claudeBackgroundEnded(work));
export const nativeCompletionPending = (task: { nativeBackgroundWork?: NativeBackgroundWork[]; executionSessionId?: string }) => {
  const latest = new Map<string, NativeBackgroundWork>();
  for (const work of task.nativeBackgroundWork ?? []) if (work.transportId === task.executionSessionId && (!latest.has(work.taskId) || latest.get(work.taskId)!.generation < work.generation)) latest.set(work.taskId, work);
  return [...latest.values()].some(work => work.member && work.backgrounded && !work.ambient && (work.holdsCompletion ?? work.kind !== 'command') && !claudeBackgroundEnded(work));
};
