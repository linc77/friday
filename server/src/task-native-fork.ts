import type { TaskEvent, TaskStatus, WorkItem } from './types.js';

// These are observed provider turns, never Friday executions or Durable jobs.
export function nativeForkTurns(source: WorkItem) {
  if (source.agent !== 'codex' || !source.threadId) return [];
  const seen = new Set<string>();
  return source.events.flatMap(event => {
    if (event.kind !== 'turn' || event.runId || event.revertedAt || !event.turnId || seen.has(event.turnId)) return [];
    const nativeId = event.nativeTurnId ?? (event.id.startsWith('codex:') && event.id.endsWith(':turn') ? event.id.slice(6, -5) : undefined);
    if (!nativeId) return [];
    seen.add(event.turnId);
    return [{ id: event.turnId, nativeId, status: event.status, at: event.at, completedAt: event.completedAt }];
  });
}

export function nativeForkPrefix(source: WorkItem, boundaryId: string) {
  const turns = nativeForkTurns(source), end = turns.findIndex(turn => turn.id === boundaryId), selected = turns[end];
  if (!selected || !['completed', 'failed', 'interrupted', 'declined'].includes(selected.status ?? '')) throw new Error('只能从已结束的原生轮次分叉');
  const kept = turns.slice(0, end + 1);
  if (kept.some(turn => turn.status === 'running')) throw new Error('所选原生历史中仍有未结束的轮次');
  const ids = new Map(kept.map(turn => [turn.id, turn.nativeId]));
  const messageTurn = (message: NonNullable<WorkItem['messages']>[number]) => message.turnId && ids.has(message.turnId) ? message.turnId
    : kept.find(turn => message.id === turn.id + ':prompt' || message.id === turn.id + ':answer')?.id;
  const messages = (source.messages ?? []).filter(message => !message.revertedAt && messageTurn(message)).map(message => {
    const result = { ...message, turnId: ids.get(messageTurn(message)!) }; delete result.runId; return result;
  });
  const events = source.events.filter(event => !event.revertedAt && event.turnId && ids.has(event.turnId)).map(event => {
    const result: TaskEvent = { ...event, turnId: ids.get(event.turnId!) };
    delete result.runId; delete result.historyDigest; delete result.processId; delete result.background;
    if (result.status === 'running') { result.status = 'interrupted'; result.completedAt = selected.completedAt ?? selected.at; }
    return result;
  });
  const result = messages.findLast(message => message.role === 'assistant' && message.turnId === selected.nativeId)?.text
    ?? events.findLast(event => event.turnId === selected.nativeId && (event.kind === 'message' && event.phase !== 'commentary' || event.kind === 'proposal'))?.text ?? '';
  const status: TaskStatus = selected.status === 'completed' ? 'completed' : selected.status === 'failed' ? 'failed' : 'interrupted';
  return { selected: { id: selected.id, threadId: source.threadId!, turnId: selected.nativeId, status }, expectedTurns: kept.map(turn => turn.nativeId),
    result, messages, events, runs: [] as NonNullable<WorkItem['runs']>, runID: undefined, prefixMode: 'observed' as const };
}
