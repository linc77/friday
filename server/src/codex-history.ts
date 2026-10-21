import type { CodexRpc } from './codex-rpc.js';
import { CodexEvents } from './codex-events.js';
import type { TaskEvent, WorkItem } from './types.js';
import type { TaskSubagent } from './task-subagent-types.js';

export type CodexHistoryTurn = { id: string; status: string; at: string; completedAt?: string; prompt: string; events: TaskEvent[] };
export type CodexHistorySnapshot = { threadId: string; parentThreadId: string; connectionId?: string; model?: string; effort?: string; turns: CodexHistoryTurn[] };
export type SubagentHistoryProjection = { agent: TaskSubagent; turns: { id: string; childTurnId: string; events: TaskEvent[] }[] };
const valid = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\x00-\x1f]/.test(id);
const iso = (value: unknown, factor: number, fallback: string) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value * factor) < 8.64e15 ? new Date(value * factor).toISOString() : fallback;
const terminal = (status: string) => ['completed', 'failed', 'interrupted'].includes(status);

/** Read stored provider data only. The caller owns the RPC and closes only a
 * dedicated reader, never a borrowed execution connection. */
export async function readCodexHistory(rpc: Pick<CodexRpc, 'call'>, task: WorkItem, parentThreadId: string, signal: AbortSignal): Promise<CodexHistorySnapshot> {
  const deadline = Date.now() + 25_000;
  const call = async (method: string, params: unknown) => {
    signal.throwIfAborted(); const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error('Native history read timeout');
    const result = await rpc.call(method, params, Math.min(5000, remaining)); signal.throwIfAborted(); return result;
  };
  const metadata = async (id: string) => {
    const response = await call('thread/read', { threadId: id, includeTurns: false });
    if (response?.thread?.id !== id) throw new Error('Native history thread identity changed'); return response.thread;
  };
  const list = async (id: string, meta: any): Promise<any[]> => {
    if (meta.historyMode === 'legacy') {
      const response = await call('thread/read', { threadId: id, includeTurns: true });
      if (response?.thread?.id !== id || !Array.isArray(response.thread.turns)) throw new Error('Invalid legacy native history'); return response.thread.turns;
    }
    const turns: any[] = [], cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await call('thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || page.nextCursor !== null && !valid(page.nextCursor)) throw new Error('Invalid native turn page');
      turns.push(...page.data); cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 500)) throw new Error('Native turn cursor repeated'); if (cursor) cursors.add(cursor);
    } while (cursor);
    return turns;
  };
  const items = async (id: string, turn: any, legacy: boolean) => {
    if (legacy || turn.itemsView === 'full') {
      if (!Array.isArray(turn.items)) throw new Error('Native full turn omitted its items');
      return turn.items.map((item: any) => ({ item, startedAtMs: null, completedAtMs: null }));
    }
    const entries: any[] = [], cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const page = await call('thread/items/list', { threadId: id, turnId: turn.id, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || page.nextCursor !== null && !valid(page.nextCursor) || page.data.some((entry: any) => entry.turnId !== turn.id || !valid(entry.item?.id))) throw new Error('Invalid native item page');
      entries.push(...page.data); cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= 500)) throw new Error('Native item cursor repeated'); if (cursor) cursors.add(cursor);
    } while (cursor);
    return entries;
  };
  if (!valid(task.threadId) || !valid(parentThreadId)) throw new Error('Missing native history scope');
  const meta = await metadata(task.threadId), reportedParent = meta.parentThreadId ?? meta.source?.subAgent?.thread_spawn?.parent_thread_id;
  if (reportedParent != null && reportedParent !== parentThreadId) throw new Error('Native history parent identity changed');
  const all = await list(task.threadId, meta), ids = all.map(turn => turn.id);
  if (ids.some(id => !valid(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid native history turn identities');
  const parentMeta = await metadata(parentThreadId), parentTurns = await list(parentThreadId, parentMeta);
  const parentIDs = new Set(parentTurns.map(turn => turn.id));
  if (parentTurns.some(turn => !valid(turn.id)) || parentIDs.size !== parentTurns.length) throw new Error('Invalid native parent history');
  const ownTurns = all.filter(turn => !parentIDs.has(turn.id));
  // Older rollouts can omit turn clocks. Anchor missing clocks to already
  // observed native turns so a newly recovered reply cannot move before them.
  const observed = new Map<string, { at: string; end: string }>();
  for (const event of task.events ?? []) if (event.kind === 'turn') {
    const id = event.nativeTurnId ?? (event.id.startsWith('codex:') && event.id.endsWith(':turn') ? event.id.slice(6, -5) : undefined);
    if (id && Number.isFinite(Date.parse(event.at))) observed.set(id, { at: event.at, end: event.completedAt ?? event.at });
  }
  const anchors = ownTurns.map(turn => {
    const saved = observed.get(turn.id); const at = iso(turn.startedAt, 1000, saved?.at ?? '');
    return at ? { at, end: iso(turn.completedAt, 1000, saved?.end ?? at) } : undefined;
  });
  const next: number[] = []; let nearest = -1;
  for (let index = anchors.length - 1; index >= 0; index--) { if (anchors[index]) nearest = index; next[index] = nearest; }
  let previous = -1;
  const starts = anchors.map((value, index) => {
    if (value) { previous = index; return value.at; }
    if (previous >= 0) return new Date(Date.parse(anchors[previous]!.end) + index - previous).toISOString();
    return next[index] >= 0 ? new Date(Date.parse(anchors[next[index]]!.at) - next[index] + index).toISOString()
      : new Date(Date.parse(task.createdAt) + index).toISOString();
  });
  const result: CodexHistoryTurn[] = [];
  for (const [ordinal, turn] of ownTurns.entries()) {
    if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) throw new Error('Unknown native turn status');
    const at = starts[ordinal], completedAt = terminal(turn.status) ? iso(turn.completedAt, 1000, observed.get(turn.id)?.end ?? at) : undefined;
    const stored = new Map<string, TaskEvent>(), times = new Map<string, { at: string; completedAt: string }>(), entries = await items(task.threadId, turn, meta.historyMode === 'legacy'); const seen = new Set<string>(); let prompt = '';
    const events = new CodexEvents(async value => { if (value.kind === 'item') stored.set(value.item.id, value.item); });
    await events.startTurn(turn.id);
    for (const entry of entries) {
      const item = entry.item; if (!valid(item?.id) || seen.has(item.id)) throw new Error('Duplicate native item identity'); seen.add(item.id);
      if (item.type === 'userMessage') {
        prompt = (item.content ?? []).filter((part: any) => part.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n'); continue;
      }
      const running = item.status === 'inProgress' || !terminal(turn.status) && entry.completedAtMs == null && ['agentMessage', 'reasoning', 'plan'].includes(item.type);
      await events.handle(running ? 'item/started' : 'item/completed', { turnId: turn.id, item }, turn.id);
      times.set(`codex:${turn.id}:${item.id}`, { at: iso(entry.startedAtMs, 1, at), completedAt: iso(entry.completedAtMs, 1, completedAt ?? at) });
    }
    if (terminal(turn.status)) await events.finishTurn(turn.id, turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : 'interrupted', true);
    const projected = [...stored.values()].map(event => {
      const started = times.get(event.id)?.at ?? at, ended = times.get(event.id)?.completedAt ?? completedAt ?? at;
      return { ...event, nativeTurnId: turn.id, at: started, ...(event.status !== 'running'
        ? { completedAt: ended, durationMs: Math.max(0, Date.parse(ended) - Date.parse(started)) }
        : { completedAt: undefined, durationMs: undefined }) };
    });
    result.push({ id: turn.id, status: turn.status, at, ...(completedAt ? { completedAt } : {}), prompt, events: projected });
  }
  return { threadId: task.threadId, parentThreadId, turns: result,
    ...(typeof meta.model === 'string' && meta.model ? { model: meta.model } : {}), ...(typeof meta.reasoningEffort === 'string' ? { effort: meta.reasoningEffort } : {}) };
}
