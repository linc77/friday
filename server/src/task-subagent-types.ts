import { createHash } from 'node:crypto';
import type { NativeObservedUpdate } from './native-runtime-types.js';
import type { TaskEvent, WorkItem } from './types.js';

export type TaskSubagent = {
  id: string; provider: 'claude' | 'codex'; nativeId: string; sessionId: string; threadId: string;
  runId: string; turnId: string; eventId: string; childTaskId: string;
  nativeRunId?: string; generation: number; childTurnId: string; toolUseId?: string;
  parentSubagentId?: string;
  eventOwnerSubagentId?: string;
  title: string; prompt: string; model?: string; reasoningEffort?: string;
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown';
  progress?: string; result?: string; startedAt: string; updatedAt: string; completedAt?: string;
  canStop?: boolean;
  backgroundCommands?: number; unknownCommands?: number;
  stop?: { requestId: string; durableId: number; status: string; error?: string };
};
export type TaskSubagentOrigin = {
  rootTaskId: string; parentTaskId: string; subagentId: string;
  sessionId: string; threadId: string; nativeId: string;
  status?: TaskSubagent['status'];
};
export type SubagentRuntimeUpdate = {
  kind: 'subagent'; sessionId: string; threadId: string; subagent: TaskSubagent;
  previousSessionId?: string;
  value?: NativeObservedUpdate;
};
export type SubagentBackgroundUpdate = { kind: 'subagentBackground'; sessionId: string; threadId: string; subagentId: string; childTaskId: string; nativeId: string; nativeTurnId: string; childTurnId: string;
  value: { kind: 'item'; item: TaskEvent } | { kind: 'commandOutput'; eventId: string; delta: string }; disconnected?: boolean; hostInterrupted?: boolean };
export const subagentIdentity = (sessionId: string, nativeId: string) => createHash('sha256').update(JSON.stringify([sessionId, nativeId])).digest('hex');
export const codexSubagentIdentity = (threadId: string, nativeId: string) => createHash('sha256').update(JSON.stringify(['codex', threadId, nativeId])).digest('hex');
export const codexChildTurnIdentity = (id: string, generation: number) => 'codex-child:' + createHash('sha256').update(JSON.stringify([id, generation])).digest('hex');
export const subagentChildId = (root: string, id: string) => 'subagent:' + createHash('sha256').update(JSON.stringify([root, id])).digest('hex');
export const subagentEnded = (status: TaskSubagent['status']) => !['running', 'waiting', 'unknown'].includes(status);
export const providerSubagentActive = (task: WorkItem) => task.subagents?.some(agent => agent.sessionId === task.executionSessionId && (['running', 'waiting'].includes(agent.status) || (agent.backgroundCommands ?? 0) > 0)) === true;
export function projectSubagentEvent(event: TaskEvent, agents: readonly TaskSubagent[] = []): TaskEvent {
  const agent = agents.find(agent => agent.eventId === event.id);
  if (!agent) return event;
  return { ...event, kind: 'subagent', subagentId: agent.id, text: agent.title, detail: agent.progress ?? agent.result ?? '',
    status: ['running', 'waiting'].includes(agent.status) ? 'running' : agent.status === 'completed' ? 'completed' : agent.status === 'failed' ? 'failed' : 'interrupted',
    ...(agent.completedAt ? { completedAt: agent.completedAt } : {}) };
}
/** Native conversations follow the root's visible execution prefix. Hidden
 * audit records cannot become searchable or navigable after a rewind. */
export function visibleSubagentIds(tasks: readonly WorkItem[]) {
  const ids = new Set<string>();
  for (const root of tasks) if (!root.subagentOrigin) {
    const runs = new Set(root.runs?.filter(run => !run.revertedAt && !run.executionExcludedAt).map(run => run.id));
    const candidates = (root.subagents ?? []).filter(agent => runs.has(agent.runId));
    const byId = new Map(candidates.map(agent => [agent.id, agent]));
    for (const agent of candidates) {
      const seen = new Set([agent.id]); let parent = agent.parentSubagentId; let valid = true;
      while (parent) { if (seen.has(parent) || !byId.has(parent)) { valid = false; break; } seen.add(parent); parent = byId.get(parent)!.parentSubagentId; }
      if (valid) ids.add(agent.childTaskId);
    }
  }
  return ids;
}
