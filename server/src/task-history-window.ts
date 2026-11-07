import { compactTaskEvent } from './task-output.js';
import type { ChatMessage, TaskEvent, WorkItem } from './types.js';

// Match T3 threadHistoryPaging: byte/item budgets are a fallback for histories
// without user turn starts. Ordinary turns remain whole, including tool rows.
export const fallbackHistoryItems = 75;
export const historyEncodedBytes = 1_048_576;
export const historyRawTurnLimit = 150;
export type TaskHistoryEntry = { key: string; at: string; message?: ChatMessage; event?: TaskEvent; userTurn: boolean; turnStart: boolean };
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

export function historyEntries(task: WorkItem, events: TaskEvent[]): TaskHistoryEntry[] {
  const starts = new Set(task.runs?.filter(run => !run.revertedAt).map(run => run.messageId));
  const entries: TaskHistoryEntry[] = [];
  const messages = task.messages ?? [];
  // Old saved answers have no timestamps. Match the native transcript: place
  // them before their next user input instead of moving them to the live tail.
  const userEvents = events.filter(event => event.kind === 'user');
  const times = messages.map(message => {
    if (message.at) return message.at;
    if (message.role !== 'user') return task.updatedAt;
    const match = userEvents.findIndex(event => event.text === message.text);
    return match < 0 ? task.createdAt : userEvents.splice(match, 1)[0].at;
  });
  let nextUser: string | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') nextUser = times[index];
    else if (!message.at && nextUser && Number.isFinite(Date.parse(nextUser))) times[index] = new Date(Date.parse(nextUser) - 1).toISOString();
  }
  for (const [index, message] of messages.entries()) if (!message.revertedAt) {
    const userTurn = message.role === 'user' && !message.delivery && (starts.has(message.id) || !message.runId);
    entries.push({ key: 'm:' + message.id, at: times[index],
      message: { ...message, historyOrder: index }, userTurn, turnStart: userTurn });
  }
  for (const event of events) if (!event.revertedAt) entries.push({ key: 'e:' + event.id, at: event.at, event, userTurn: false, turnStart: false });
  entries.sort((a, b) => a.at.localeCompare(b.at) || (a.message && b.message ? a.message.historyOrder! - b.message.historyOrder!
    : a.event && b.event ? (a.event.historyOrder ?? 0) - (b.event.historyOrder ?? 0) : a.message ? -1 : 1) || a.key.localeCompare(b.key));
  // A notification can start a background run. It does not consume a user-turn
  // slot, but T3 caps these raw starts so a wake-heavy prefix remains bounded.
  const started = new Set<string>();
  for (const entry of entries) {
    const runId = entry.message?.runId ?? entry.event?.runId;
    if (entry.message?.role !== 'user' && entry.event?.kind !== 'notification') continue;
    if (entry.event?.kind === 'notification' && runId && !started.has(runId)) entry.turnStart = true;
    if (runId) started.add(runId);
  }
  return entries;
}

export function selectHistoryEntries(entries: TaskHistoryEntry[], to: number, input: { userTurns: number; maxItems?: number; maxBytes?: number; compactItems?: boolean }) {
  const hasUserTurns = entries.slice(0, to).some(entry => entry.userTurn);
  let from = to; let bytes = 0; let userTurns = 0; let rawTurns = 0;
  while (from > 0) {
    const entry = entries[from - 1];
    const cost = hasUserTurns ? 0 : jsonBytes(entry.message ?? (input.compactItems ? compactTaskEvent(entry.event!) : entry.event))
      + (entry.message ? jsonBytes(entry.message.id) + 1 : 0) + 1;
    if (from < to && (hasUserTurns ? userTurns >= input.userTurns || rawTurns >= historyRawTurnLimit
      : to - from >= (input.maxItems ?? fallbackHistoryItems) || bytes + cost > (input.maxBytes ?? historyEncodedBytes))) break;
    from--; bytes += cost;
    if (entry.userTurn) userTurns++;
    if (entry.turnStart) rawTurns++;
  }
  return { from, to, entries: entries.slice(from, to) };
}
