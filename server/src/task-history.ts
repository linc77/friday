import { createHash } from 'node:crypto';
import { defineDocFamily, type Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { ChatMessage, TaskEvent, TaskEventPage, TaskHistoryInfo, TaskHistoryPage, WorkItem } from './types.js';
import { WorkspaceDoc } from './state.js';

export const historyPageSize = 128;
export const liveEventLimit = 600;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const PageDoc = defineDocFamily<{ taskId: string; page: number; events: TaskEvent[] }, { taskId: string; page: number }>({
  kind: 'friday.task_history_page', version: 1, scope: 'session', family: true,
  initial: seed => ({ ...seed, events: [] }),
});
const EventIndex = defineDocFamily<{ taskId: string; eventId: string; position: number | null }, { taskId: string; eventId: string }>({
  kind: 'friday.task_history_index', version: 1, scope: 'session', family: true,
  initial: seed => ({ ...seed, position: null }),
});
const key = (taskID: string, page: number) => `${sha(taskID)}:${page}`;
const eventKey = (taskID: string, eventID: string) => sha(taskID + '\0' + eventID);
const digest = (event: TaskEvent) => { const { historyDigest: _, ...body } = event; return sha(JSON.stringify(body)); };
const timelineEvent = (event: TaskEvent) => !['user', 'status', 'turn', 'recovery', 'error'].includes(event.kind);

export function taskHistoryEpoch(task: WorkItem) {
  return sha(JSON.stringify([task.id, [...(task.rewindOperations ?? []), ...(task.rewindOperation ? [task.rewindOperation] : [])].filter(op => op.projectedAt).map(op => [op.id, op.projectedAt]), task.forkOperation?.projectedAt ?? null, task.forkOperation?.projectedStrategy ?? null, ...(task.nativeHistory?.epoch ? [task.nativeHistory.epoch] : [])]));
}
const cursor = (task: WorkItem, before: number) => before > 0 ? Buffer.from(JSON.stringify({ v: 1, taskId: task.id, epoch: taskHistoryEpoch(task), before })).toString('base64url') : null;

/** Only evicted event bodies live here. Their writes and workspace trimming are
 * in the same Pi Durable transaction; no second store or recovery runner. */
export class TaskHistory {
  constructor(private readonly engine: Engine) {}
  info(task: WorkItem): TaskHistoryInfo {
    const { runPages: _, ...info } = task.eventArchive ?? { count: 0, version: 0, coverage: 'legacy' as const, recent: [] };
    return { ...info, epoch: taskHistoryEpoch(task), nextCursor: cursor(task, task.eventArchive?.count ?? 0) };
  }
  messageChanged(task: WorkItem, id: string) {
    if (task.agent === 'friday') return;
    task.eventArchive ??= { count: 0, version: 0, coverage: 'legacy', recent: [] };
    task.eventArchive.messageVersion = (task.eventArchive.messageVersion ?? 0) + 1;
    task.eventArchive.messageTouches = [...(task.eventArchive.messageTouches ?? []).filter(value => value !== id), id].slice(-historyPageSize);
  }
  private indexRun(task: WorkItem, event: TaskEvent, page: number) {
    if (!event.runId && ['user', 'status', 'turn', 'recovery', 'error'].includes(event.kind)) return;
    const ranges = task.eventArchive!.runPages!; const id = event.runId ?? '';
    const range = Object.hasOwn(ranges, id) ? ranges[id] : undefined;
    ranges[id] = { first: Math.min(range?.first ?? page, page), last: Math.max(range?.last ?? page, page) };
  }
  private async ensureIndex(tx: Tx, task: WorkItem) {
    if (!task.eventArchive) return;
    const indexRuns = !task.eventArchive.runPages;
    const indexTime = task.eventArchive.firstTimelineAt === undefined || task.eventArchive.hasNotifications === undefined;
    if (!indexRuns && !indexTime) return;
    if (indexRuns) task.eventArchive.runPages = {};
    if (indexTime) { task.eventArchive.firstTimelineAt = null; task.eventArchive.hasNotifications = false; }
    for (let page = 0; page * historyPageSize < task.eventArchive.count; page++) {
      const data = await this.pageData(task, page, tx);
      for (const event of data.events) {
        if (indexRuns) this.indexRun(task, event, page);
        if (indexTime) this.indexTime(task, event);
      }
    }
  }
  private indexTime(task: WorkItem, event: TaskEvent) {
    if (timelineEvent(event) && (!task.eventArchive!.firstTimelineAt || event.at < task.eventArchive!.firstTimelineAt)) task.eventArchive!.firstTimelineAt = event.at;
    if (event.kind === 'notification') task.eventArchive!.hasNotifications = true;
  }
  async recoverIndexes() {
    const snapshot = await this.engine.snapshot();
    for (const saved of snapshot.tasks) if (saved.agent !== 'friday' && saved.eventArchive?.count && (!saved.eventArchive.runPages || saved.eventArchive.firstTimelineAt === undefined || saved.eventArchive.hasNotifications === undefined)) {
      await this.engine.root.commit(async tx => {
        const state = await tx.doc(WorkspaceDoc); const task = state.tasks.find(task => task.id === saved.id);
        if (task && task.eventArchive && (!task.eventArchive.runPages || task.eventArchive.firstTimelineAt === undefined || task.eventArchive.hasNotifications === undefined)) { await this.ensureIndex(tx, task); state.revision++; }
      }, context);
    }
  }
  async persist(tx: Tx, task: WorkItem, updatedIDs: string[] = []) {
    if (task.agent === 'friday') { if (task.events.length > liveEventLimit) task.events.splice(0, task.events.length - liveEventLimit); return; }
    task.eventArchive ??= { count: 0, version: 0, coverage: 'legacy', recent: [] };
    await this.ensureIndex(tx, task);
    const removed = Math.max(0, task.events.length - liveEventLimit);
    const victims = task.events.slice(0, removed);
    const victimIDs = new Set(victims.map(event => event.id));
    const updates = task.events.slice(removed).filter(event => updatedIDs.includes(event.id));
    let nextOrder = task.eventArchive.nextOrder ?? 0;
    for (const event of task.events) {
      this.indexTime(task, event);
      if (event.historyOrder === undefined) event.historyOrder = nextOrder++;
      else nextOrder = Math.max(nextOrder, event.historyOrder + 1);
      if (!event.historyDigest || updatedIDs.includes(event.id)) event.historyDigest = digest(event);
    }
    task.eventArchive.nextOrder = nextOrder;
    for (const event of [...victims, ...updates]) {
      const index = await tx.doc(EventIndex, eventKey(task.id, event.id), { taskId: task.id, eventId: event.id });
      if (index.taskId !== task.id || index.eventId !== event.id) throw new Error('任务历史索引与事件不一致');
      if (index.position === null && !victimIDs.has(event.id)) continue;
      const fresh = index.position === null;
      const position: number = index.position ?? task.eventArchive.count;
      const page = Math.floor(position / historyPageSize);
      const data = await tx.doc(PageDoc, key(task.id, page), { taskId: task.id, page });
      if (data.taskId !== task.id || data.page !== page) throw new Error('任务历史分页身份不一致');
      const slot = position % historyPageSize;
      if (!fresh && data.events[slot]?.historyOrder !== undefined) event.historyOrder = data.events[slot].historyOrder;
      event.historyDigest = digest(event);
      if (!fresh && data.events[slot]?.id !== event.id) throw new Error('任务历史事件位置已改变');
      if (fresh && data.events.length !== slot) throw new Error('任务历史分页存在缺口');
      this.indexRun(task, event, page);
      if (!fresh && data.events[slot].historyDigest === event.historyDigest) continue;
      if (fresh) { data.events.push(copy(event)); index.position = position; task.eventArchive.count++; }
      else data.events[slot] = copy(event);
      task.eventArchive.version++;
      task.eventArchive.recent = [...task.eventArchive.recent.filter(value => value.id !== event.id), { id: event.id, position, digest: event.historyDigest }].slice(-historyPageSize);
    }
    if (removed) task.events.splice(0, removed);
    for (const id of new Set(updatedIDs)) {
      const event = task.events.find(event => event.id === id) ?? victims.find(event => event.id === id);
      if (!event) continue;
      if (task.eventArchive.touches?.find(value => value.id === id)?.digest === event.historyDigest) continue;
      task.eventArchive.touchVersion = (task.eventArchive.touchVersion ?? 0) + 1;
      task.eventArchive.touches = [...(task.eventArchive.touches ?? []).filter(value => value.id !== id), { id, digest: event.historyDigest! }].slice(-historyPageSize);
    }
  }

  private async pageData(task: WorkItem, page: number, tx?: Tx) {
    const value = tx ? await tx.doc(PageDoc, key(task.id, page), { taskId: task.id, page }) : await this.engine.harness.snapshot(PageDoc, key(task.id, page), context);
    if (!value || value.taskId !== task.id || value.page !== page) throw new Error('任务历史分页不可用，请重新连接后重试');
    return value;
  }
  private project(task: WorkItem, value: TaskEvent): TaskEvent {
    const event = copy(value); const run = task.runs?.find(run => run.id === event.runId);
    if (run?.revertedAt) event.revertedAt = run.revertedAt;
    if (run?.executionExcludedAt && event.kind !== 'user') event.revertedAt = run.executionExcludedAt;
    if (run?.inheritedFrom && task.forkOrigin) { if (run.turnId) event.turnId = run.turnId; else delete event.turnId; }
    if (!event.revertedAt) for (const operation of [...(task.rewindOperations ?? []), ...(task.rewindOperation ? [task.rewindOperation] : [])]) {
      if (!operation.projectedAt) continue;
      const from = task.messages?.find(message => message.id === operation.messageId)?.at;
      const removedTurns = new Set([...operation.removeTurns, ...(task.runs ?? []).filter(run => (operation.removedRunIds.includes(run.id) || operation.removedExecutionRunIds?.includes(run.id)) && run.turnId).map(run => run.turnId!)]);
      if (event.runId && (operation.removedRunIds.includes(event.runId) || event.kind !== 'user' && operation.removedExecutionRunIds?.includes(event.runId)) || event.turnId && removedTurns.has(event.turnId)
        || !event.runId && !event.turnId && from && Date.parse(event.at) >= Date.parse(from) && Date.parse(event.at) <= Date.parse(operation.projectedAt)) event.revertedAt = operation.projectedAt;
    }
    const backgroundRunning = event.background && (task.backgroundCommands?.some(command => command.id === event.id && command.runId === event.runId && command.status === 'running')
      || task.nativeBackgroundWork?.some(work => work.origin?.eventId === event.id && work.member && !['completed', 'failed', 'stopped', 'interrupted', 'unknown'].includes(work.status)));
    if (event.status === 'running' && !backgroundRunning && run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) {
      event.status = run.status === 'failed' ? 'failed' : run.status === 'completed' && event.kind === 'message' ? 'completed' : 'interrupted';
      if (run.completedAt) event.completedAt = run.completedAt;
    }
    return event;
  }
  async events(task: WorkItem, tx?: Tx) {
    const count = task.eventArchive?.count ?? 0; const entries = new Map<string, TaskEvent>();
    for (let page = 0; page * historyPageSize < count; page++) {
      const data = await this.pageData(task, page, tx);
      const length = Math.min(historyPageSize, count - page * historyPageSize);
      if (data.events.length < length) throw new Error('任务历史分页存在缺口');
      for (const event of data.events.slice(0, length)) entries.set(event.id, event);
    }
    for (const event of task.events) entries.set(event.id, event);
    return [...entries.values()].map(event => this.project(task, event));
  }
  async eventsForRuns(task: WorkItem, runs: Set<string>, fromAt?: string, toAt?: string) {
    const include = (event: TaskEvent) => event.runId ? runs.has(event.runId) : (!fromAt || event.at >= fromAt) && (!toAt || event.at < toAt);
    const pages = new Set<number>(); const count = task.eventArchive?.count ?? 0;
    const ranges = task.eventArchive?.runPages;
    if (!ranges) for (let page = 0; page * historyPageSize < count; page++) pages.add(page);
    else for (const id of [...runs, '']) {
      const range = Object.hasOwn(ranges, id) ? ranges[id] : undefined; if (!range) continue;
      for (let page = range.first; page <= range.last && page * historyPageSize < count; page++) pages.add(page);
    }
    const entries = new Map<string, TaskEvent>();
    for (const page of [...pages].sort((a, b) => a - b)) {
      for (const event of (await this.pageData(task, page)).events) if (include(event)) entries.set(event.id, event);
    }
    for (const event of task.events) { if (include(event)) entries.set(event.id, event); else entries.delete(event.id); }
    return [...entries.values()].map(event => this.project(task, event)).filter(event => !event.revertedAt)
      .sort((a, b) => (a.historyOrder ?? 0) - (b.historyOrder ?? 0) || a.at.localeCompare(b.at));
  }
  async eventItems(id: string, ids: string[]): Promise<TaskEventPage> {
    if (!Array.isArray(ids) || ids.length > historyPageSize || ids.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error('历史事件范围无效');
    const state = await this.engine.snapshot(); const task = state.tasks.find(task => task.id === id);
    if (!task || task.agent === 'friday') throw new Error('本地任务不存在');
    const live = new Map(task.events.map(event => [event.id, event])); const data = new Map<number, Awaited<ReturnType<TaskHistory['pageData']>>>();
    const messages: ChatMessage[] = []; const events: TaskEvent[] = []; const missing: string[] = [];
    const messageMap = new Map((task.messages ?? []).map((message, historyOrder) => [message.id, { ...message, historyOrder }]));
    for (const eventID of new Set(ids)) {
      const message = messageMap.get(eventID); if (message) messages.push(message);
      let event = live.get(eventID);
      if (!event) {
        const index = await this.engine.harness.snapshot(EventIndex, eventKey(task.id, eventID), context);
        if (index?.taskId === id && index.eventId === eventID && index.position !== null) {
          const page = Math.floor(index.position / historyPageSize);
          if (!data.has(page)) data.set(page, await this.pageData(task, page));
          const candidate = data.get(page)!.events[index.position % historyPageSize]; if (candidate?.id === eventID) event = candidate;
        }
      }
      if (event) events.push(this.project(task, event)); else if (!message) missing.push(eventID);
    }
    const current = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!current || taskHistoryEpoch(current) !== taskHistoryEpoch(task)) throw new Error('历史已改变，请重新加载记录');
    return { taskId: id, epoch: taskHistoryEpoch(task), sequence: state.revision, events, messages, missing };
  }
  async page(id: string, before?: string, requestedLimit = historyPageSize, range?: { beforePosition: number; epoch: string }): Promise<TaskHistoryPage> {
    const state = await this.engine.snapshot(); const task = state.tasks.find(task => task.id === id);
    if (!task || task.agent === 'friday') throw new Error('本地任务不存在');
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > historyPageSize) throw new Error('历史分页大小无效');
    const count = task.eventArchive?.count ?? 0; let to = count;
    if (range) {
      if (before || range.epoch !== taskHistoryEpoch(task) || !Number.isSafeInteger(range.beforePosition) || range.beforePosition < 0 || range.beforePosition > count) throw new Error('历史范围已经改变，请重新加载记录');
      to = range.beforePosition;
    }
    if (before) {
      if (before.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(before)) throw new Error('历史分页游标无效');
      let value: any; try { value = JSON.parse(Buffer.from(before, 'base64url').toString('utf8')); } catch { throw new Error('历史分页游标无效'); }
      if (value.v !== 1 || value.taskId !== id || value.epoch !== taskHistoryEpoch(task) || !Number.isSafeInteger(value.before) || value.before < 0 || value.before > count) throw new Error('历史已改变，请重新加载记录');
      to = value.before;
    }
    const from = Math.max(0, to - requestedLimit); const events: TaskEvent[] = [];
    for (let page = Math.floor(from / historyPageSize); page * historyPageSize < to; page++) {
      const data = await this.pageData(task, page);
      const start = Math.max(from, page * historyPageSize) - page * historyPageSize;
      const end = Math.min(to, (page + 1) * historyPageSize) - page * historyPageSize;
      if (data.events.length < end) throw new Error('任务历史分页存在缺口');
      events.push(...data.events.slice(start, end).map(event => this.project(task, event)));
    }
    const current = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!current || taskHistoryEpoch(current) !== taskHistoryEpoch(task)) throw new Error('历史已改变，请重新加载记录');
    return { taskId: id, epoch: taskHistoryEpoch(task), count, version: task.eventArchive?.version ?? 0, from, to, events, nextCursor: cursor(task, from), coverage: task.eventArchive?.coverage ?? 'legacy' };
  }
}
