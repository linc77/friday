import type { Engine } from './engine.js';
import { taskHistoryEpoch } from './task-history.js';
import { compactTaskEvent } from './task-output.js';
import { fallbackHistoryItems, historyEncodedBytes, historyEntries, jsonBytes, selectHistoryEntries, type TaskHistoryEntry } from './task-history-window.js';
import { activeStatuses, type TaskConversationPage, type WorkItem, type Workspace } from './types.js';

export const recentConversationTurns = 10;
export const earlierConversationTurns = 20;
const encode = (task: WorkItem, before: number) => before > 0 ? Buffer.from(JSON.stringify({ v: 1, kind: 'conversation', taskId: task.id, epoch: taskHistoryEpoch(task), before, anchor: task.messages?.[before]?.id })).toString('base64url') : null;
const turnStarts = (task: WorkItem) => {
  const starts = new Set(task.runs?.filter(run => !run.revertedAt).map(run => run.messageId));
  return (task.messages ?? []).flatMap((message, index) => !message.revertedAt && message.role === 'user' && !message.delivery && (starts.has(message.id) || !message.runId) ? [index] : []);
};

/** T3 keeps ordinary turns whole: ten recent user turns, twenty per older
 * page, and up to forty to reach a selected older entry. Storage stays in
 * Durable; this is an explicitly partial transport projection. */
export class TaskConversationHistory {
  constructor(private readonly engine: Engine) {}
  private itemWindow(task: WorkItem) {
    const starts = turnStarts(task);
    if (!starts.length || starts[0] > 0 || task.eventArchive?.hasNotifications) return true;
    const first = task.messages![starts[0]].at ?? task.createdAt;
    return !!task.eventArchive?.firstTimelineAt && task.eventArchive.firstTimelineAt < first;
  }
  private changeMetadata(task: WorkItem) {
    return { touchVersion: task.eventArchive?.touchVersion ?? 0, touches: task.eventArchive?.touches ?? [],
      messageVersion: task.eventArchive?.messageVersion ?? 0, messageTouches: task.eventArchive?.messageTouches ?? [] };
  }
  private async itemEntries(task: WorkItem) { return historyEntries(task, await this.engine.taskHistory.events(task)); }
  private itemPage(task: WorkItem, sequence: number, entries: TaskHistoryEntry[], to: number, input: { turns: number; controls: boolean; compactItems: boolean; through?: string }): TaskConversationPage {
    const through = input.through === undefined ? -1 : entries.findIndex(entry => entry.message?.id === input.through || entry.event?.id === input.through || entry.event?.itemId === input.through);
    const targeting = through >= 0 && through < to;
    const userTurns = targeting ? Math.min(earlierConversationTurns * 2, Math.max(input.turns,
      entries.slice(through, to).filter(entry => entry.userTurn).length + (entries[through].userTurn ? 0 : 1))) : input.turns;
    const control = { ...task, messages: [], events: [] }; delete control.eventArchive;
    const metadata = { taskId: task.id, epoch: taskHistoryEpoch(task), sequence, ...this.changeMetadata(task), kind: 'items' as const, payloadBudgetExceeded: false };
    const reserve = jsonBytes(input.controls ? { ...control, conversationHistory: metadata } : metadata) + 1024;
    const selected = selectHistoryEntries(entries, to, { userTurns, maxItems: fallbackHistoryItems * (targeting ? 2 : 1),
      maxBytes: Math.max(0, historyEncodedBytes - reserve), compactItems: input.compactItems });
    const messages = selected.entries.flatMap(entry => entry.message ? [entry.message] : []);
    const visibleMessageIds = messages.map(message => message.id);
    if (input.controls) {
      const latest = task.runs?.filter(run => !run.revertedAt).at(-1)?.id;
      const retained = new Set((task.runs ?? []).filter(run => !run.revertedAt && (run.id === latest || run.id === task.currentRunId || activeStatuses.includes(run.status))).map(run => run.id));
      const ids = new Set(visibleMessageIds);
      for (const [historyOrder, message] of (task.messages ?? []).entries()) if (!message.revertedAt && message.runId && retained.has(message.runId) && !ids.has(message.id)) messages.push({ ...message, historyOrder });
    }
    const nextCursor = selected.from > 0 ? Buffer.from(JSON.stringify({ v: 1, kind: 'conversationItems', taskId: task.id, epoch: metadata.epoch,
      before: selected.from, anchor: entries[selected.from].key })).toString('base64url') : null;
    const result: TaskConversationPage = { ...metadata, from: selected.from, to, count: entries.length, nextCursor, hasEarlier: nextCursor !== null,
      visibleMessageIds, messages, events: selected.entries.flatMap(entry => entry.event ? [entry.event] : []) };
    result.payloadBudgetExceeded = jsonBytes({ ...result, events: input.compactItems ? result.events.map(compactTaskEvent) : result.events }) > historyEncodedBytes;
    return result;
  }
  private async window(task: WorkItem, sequence: number, to: number, limit: number, controls: boolean): Promise<TaskConversationPage> {
    const starts = turnStarts(task).filter(index => index < to);
    const from = starts.length >= limit ? starts[starts.length - limit] : 0;
    const messages = (task.messages ?? []).flatMap((message, index) => !message.revertedAt && index >= from && index < to ? [{ ...message, historyOrder: index }] : []);
    const ids = new Set(messages.map(message => message.id));
    const runs = new Set((task.runs ?? []).filter(run => !run.revertedAt && ids.has(run.messageId)).map(run => run.id));
    for (const message of messages) if (message.runId) runs.add(message.runId);
    if (controls) {
      const latest = task.runs?.filter(run => !run.revertedAt).at(-1)?.id;
      const retained = new Set((task.runs ?? []).filter(run => !run.revertedAt && (run.id === latest || run.id === task.currentRunId || activeStatuses.includes(run.status))).map(run => run.id));
      for (const id of retained) runs.add(id);
      for (let index = 0; index < (task.messages?.length ?? 0); index++) {
        const message = task.messages![index];
        if (!message.revertedAt && message.runId && retained.has(message.runId) && !ids.has(message.id)) messages.push({ ...message, historyOrder: index });
      }
    }
    const fromAt = task.messages?.[from]?.at ?? (from === 0 ? task.createdAt : undefined);
    const events = await this.engine.taskHistory.eventsForRuns(task, runs, fromAt, task.messages?.[to]?.at);
    return { taskId: task.id, epoch: taskHistoryEpoch(task), sequence, from, to, count: task.messages?.length ?? 0,
      nextCursor: encode(task, from), hasEarlier: from > 0, messages, events,
      touchVersion: task.eventArchive?.touchVersion ?? 0, touches: task.eventArchive?.touches ?? [],
      messageVersion: task.eventArchive?.messageVersion ?? 0, messageTouches: task.eventArchive?.messageTouches ?? [] };
  }
  async project(task: WorkItem, sequence: number, compactItems = false, itemHistory = true): Promise<WorkItem> {
    if (task.agent === 'friday' || !itemHistory && !turnStarts(task).length) return task;
    const items = itemHistory && this.itemWindow(task);
    const entries = items ? await this.itemEntries(task) : undefined;
    const { messages, events, taskId: _, ...conversationHistory } = entries
      ? this.itemPage(task, sequence, entries, entries.length, { turns: recentConversationTurns, controls: true, compactItems })
      : await this.window(task, sequence, task.messages!.length, recentConversationTurns, true);
    const result = { ...task, messages: task.messages === undefined ? undefined : messages, events, conversationHistory };
    delete result.eventArchive;
    result.conversationHistory.payloadBudgetExceeded = jsonBytes({ ...result, events: compactItems ? events.map(compactTaskEvent) : events,
      conversationHistory: { ...conversationHistory, payloadBudgetExceeded: false } }) > historyEncodedBytes;
    return result;
  }
  async snapshot(state: Workspace, compactItems = false, itemHistory = true): Promise<Workspace> {
    return { ...state, tasks: await Promise.all(state.tasks.map(task => this.project(task, state.revision, compactItems, itemHistory))) };
  }
  async page(id: string, before: string, through?: string, compactItems = false): Promise<TaskConversationPage> {
    const state = await this.engine.snapshot(); const task = state.tasks.find(task => task.id === id);
    if (!task || task.agent === 'friday') throw new Error('本地任务不存在');
    if (typeof before !== 'string' || before.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(before)) throw new Error('对话分页游标无效');
    let cursor: { v?: number; kind?: string; taskId?: string; epoch?: string; before?: number; anchor?: string };
    try { cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch { throw new Error('对话分页游标无效'); }
    if (!cursor || cursor.v !== 1 || !['conversation', 'conversationItems'].includes(cursor.kind ?? '') || cursor.taskId !== id || cursor.epoch !== taskHistoryEpoch(task)
      || !Number.isSafeInteger(cursor.before) || cursor.before! < 0 || typeof cursor.anchor !== 'string') throw new Error('对话历史已改变，请重新加载记录');
    if (through !== undefined && (!through || through.length > 200)) throw new Error('历史目标无效');
    if (cursor.kind === 'conversationItems') {
      const entries = await this.itemEntries(task); const to = entries.findIndex(entry => entry.key === cursor.anchor);
      if (to < 0) throw new Error('对话历史已改变，请重新加载记录');
      const page = this.itemPage(task, state.revision, entries, to, { turns: earlierConversationTurns, controls: false, compactItems, through });
      const current = (await this.engine.snapshot()).tasks.find(task => task.id === id);
      if (!current || taskHistoryEpoch(current) !== page.epoch) throw new Error('对话历史已改变，请重新加载记录');
      return { ...page, beforeCursor: before };
    }
    if (cursor.before! > (task.messages?.length ?? 0) || cursor.anchor !== task.messages?.[cursor.before!]?.id) throw new Error('对话历史已改变，请重新加载记录');
    let limit = earlierConversationTurns;
    if (through !== undefined) {
      let target = task.messages?.findIndex(message => message.id === through) ?? -1;
      if (target < 0) {
        const event = (await this.engine.taskHistory.eventItems(id, [through])).events[0];
        const run = task.runs?.find(run => run.id === event?.runId);
        if (run) target = task.messages?.findIndex(message => message.id === run.messageId) ?? -1;
      }
      if (target >= 0 && target < cursor.before!) {
        const starts = turnStarts(task);
        limit = Math.min(earlierConversationTurns * 2, Math.max(earlierConversationTurns, starts.filter(index => index >= target && index < cursor.before!).length + (starts.includes(target) ? 0 : 1)));
      }
    }
    const page = await this.window(task, state.revision, cursor.before!, limit, false);
    const current = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!current || taskHistoryEpoch(current) !== page.epoch) throw new Error('对话历史已改变，请重新加载记录');
    return page;
  }
}
