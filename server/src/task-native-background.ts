import { randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { NativeRuntimeUpdate, NativeBackgroundWork } from './native-runtime-types.js';
import { nativeCompletionPending } from './native-runtime-types.js';
import type { TaskEvent } from './types.js';
import { WorkspaceDoc } from './state.js';
import { claudeBackgroundEnded as ended } from './claude-background.js';

type StopInput = { taskId: string; workId: string; sessionId: string; requestId: string };
const publicEventStatus = (work: NativeBackgroundWork): NonNullable<TaskEvent['status']> => work.status === 'completed' ? 'completed' : work.status === 'failed' ? 'failed' : ['stopped', 'interrupted', 'unknown'].includes(work.status) ? 'interrupted' : 'running';

export class TaskNativeBackground {
  readonly definition;
  private origins = new Map<string, { sessionId: string; eventId: string }>();
  private sources = new Map<string, { sessionId: string; threadId: string; provider: string; providerInstanceId?: string }>();
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<StopInput, { phase: 'stop' }, { status: string }, {}>({
      name: 'friday.native_background_stop', version: 1, initial: () => ({ phase: 'stop' }),
      phases: { stop: async (task, runtime, ctx) => {
        const input = task.input;
        const finish = async (status: 'completed' | 'uncertain', error?: string) => {
          await this.finishStop(input, status, error);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const state = await this.engine.snapshot(); const item = state.tasks.find(work => work.id === input.taskId);
        const work = item?.nativeBackgroundWork?.find(work => work.id === input.workId && work.transportId === input.sessionId);
        if (!item || !work || work.stop?.requestId !== input.requestId) { await finish('uncertain', '后台任务已不在当前范围中'); return; }
        if (ended(work)) { await finish('completed'); return; }
        const receipt = await runtime.memo<boolean>('stopped', ctx);
        if (receipt === undefined && await runtime.memo<boolean>('started', ctx)) { await finish('uncertain', '停止结果尚未确认，请检查后台任务后再操作'); return; }
        if (receipt === undefined) {
          try {
            runtime.signal.throwIfAborted(); if (!this.engine.executor.stopNativeBackground) throw new Error('Unsupported');
            await runtime.memo('started', true, ctx); await this.engine.executor.stopNativeBackground(item, work); await runtime.memo('stopped', true, ctx);
          } catch {
            if (runtime.signal.aborted) throw new Error('停止请求已中断');
            const current = (await this.engine.snapshot()).tasks.find(task => task.id === input.taskId)?.nativeBackgroundWork?.find(work => work.id === input.workId && work.transportId === input.sessionId);
            if (current && ended(current)) { await finish('completed'); return; }
            await finish('uncertain', '后台任务的停止结果未确认，已保留当前状态'); return;
          }
        }
        await finish('completed');
      } },
      abort: async (task, runtime, ctx) => {
        await this.finishStop(task.input, 'uncertain', '停止请求已中断，请检查后台任务状态');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx);
      },
    });
  }

  async update(id: string, update: Extract<NativeRuntimeUpdate, { kind: 'nativeBackground' | 'nativeBackgroundOutput' | 'nativeBackgroundItem' }>) {
    const provider = update.provider ?? 'claude';
    if (update.kind === 'nativeBackgroundItem') {
      const source = this.sources.get(id);
      if (source?.sessionId !== update.sessionId || source.threadId !== update.threadId || source.provider !== provider || source.providerInstanceId !== update.providerInstanceId) return;
      await this.engine.root.commit(async tx => {
        const state = await tx.doc(WorkspaceDoc), task = state.tasks.find(task => task.id === id);
        const run = task?.runs?.find(run => run.id === update.runId && !run.revertedAt && !run.executionExcludedAt);
        if (!task || !run?.turnId || task.agent !== provider || task.executionSessionId !== update.sessionId || task.threadId !== update.threadId || update.providerInstanceId !== undefined && (task.providerInstanceId ?? task.agent) !== update.providerInstanceId || update.item.turnId !== run.turnId || !update.item.id.startsWith(run.turnId + ':')) return;
        const previous = task.events.find(event => event.id === update.item.id);
        if (previous && (previous.runId !== run.id || previous.revertedAt)) return;
        const event = { ...update.item, runId: run.id, ...(previous ? { at: previous.at, historyOrder: previous.historyOrder } : {}) };
        if (previous) task.events[task.events.indexOf(previous)] = event; else task.events.push(event);
        await this.engine.taskHistory.persist(tx, task, [event.id]); state.revision++;
      }, context);
      return;
    }
    if (update.kind === 'nativeBackgroundOutput') {
      const source = this.sources.get(id); if (source?.sessionId !== update.sessionId || source.threadId !== update.threadId || source.provider !== provider || source.providerInstanceId !== update.providerInstanceId) return;
      // The sender's process token was installed before query() or input. This
      // path is view-only and never writes a Workspace revision per chunk.
      this.engine.commandOutputs.appendNativeBackground(id, update.workId, update.delta, update.sessionId, update);
      const origin = this.origins.get(JSON.stringify([id, update.workId]));
      if (origin?.sessionId === update.sessionId) this.engine.commandOutputs.appendNativeBackground(id, origin.eventId, update.delta, update.sessionId, update);
      return;
    }
    if (update.tasks.some(work => work.provider !== provider || work.transportId !== update.sessionId || work.sessionId !== update.threadId)) return;
    const snapshot = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!snapshot || snapshot.executionSessionId !== update.sessionId || snapshot.threadId !== update.threadId) return;
    const originalIDs = [...new Set(update.tasks.flatMap(work => work.origin?.eventId ? [work.origin.eventId] : []))];
    const originals = new Map<string, TaskEvent>();
    for (let index = 0; index < originalIDs.length; index += 128) {
      const page = await this.engine.taskHistory.eventItems(id, originalIDs.slice(index, index + 128));
      for (const event of page.events) if (!event.revertedAt) originals.set(event.id, event);
    }
    let accepted: NativeBackgroundWork[] = []; let acceptedScope = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const task = state.tasks.find(task => task.id === id);
      if (!task || task.agent !== provider || update.providerInstanceId !== undefined && (task.providerInstanceId ?? task.agent) !== update.providerInstanceId || task.executionSessionId !== update.sessionId || task.threadId !== update.threadId) return;
      acceptedScope = true;
      const pendingBefore = nativeCompletionPending(task); task.nativeBackgroundConnected = update.connected !== false; task.nativeBackgroundWork ??= [];
      for (const work of task.nativeBackgroundWork) if (work.transportId !== update.sessionId && !ended(work)) { work.member = false; work.status = 'unknown'; }
      const touched: string[] = [];
      for (const incoming of update.tasks) {
        const previous = task.nativeBackgroundWork.find(work => work.id === incoming.id);
        const output = incoming.output ?? this.engine.commandOutputs.nativeTail(id, incoming.id) ?? previous?.output;
        const work: NativeBackgroundWork = { ...structuredClone(incoming), ...(previous?.stop ? { stop: { ...previous.stop } } : {}),
          ...((ended(incoming) || !incoming.member || update.connected === false) && output ? { output: { ...output } } : {}) };
        const index = task.nativeBackgroundWork.findIndex(value => value.id === work.id);
        if (index < 0) task.nativeBackgroundWork.push(work); else task.nativeBackgroundWork[index] = work;
        accepted.push(work);
        if (work.origin?.eventId && (work.backgrounded || work.member || previous?.backgrounded)) {
          const run = task.runs?.find(run => run.id === work.origin!.runId && !run.revertedAt && !run.executionExcludedAt);
          const event = task.events.find(event => event.id === work.origin!.eventId) ?? originals.get(work.origin.eventId);
          if (run && event?.kind === 'command' && !event.revertedAt && event.runId === work.origin.runId) {
            if (!task.events.some(value => value.id === event.id)) task.events.push({ ...event });
            const saved = task.events.find(value => value.id === event.id)!;
            saved.background = true; saved.status = publicEventStatus(work);
            if (work.completedAt) saved.completedAt = work.completedAt;
            if (work.output) { saved.detail = work.output.text; saved.detailTruncated = work.output.truncated; }
            touched.push(saved.id);
          }
        }
      }
      if (pendingBefore && !nativeCompletionPending(task) && task.status === 'completed' && update.tasks.some(work => work.kind !== 'command' && !work.ambient && ended(work))) task.unread = true;
      if (touched.length) await this.engine.taskHistory.persist(tx, task, touched);
      state.revision++;
    }, context);
    if (acceptedScope) this.sources.set(id, { sessionId: update.sessionId, threadId: update.threadId, provider, providerInstanceId: update.providerInstanceId });
    for (const work of accepted) {
      const event: TaskEvent = { id: work.id, kind: 'command', text: work.description, at: work.startedAt, status: publicEventStatus(work), ...(work.output ? { detail: work.output.text } : {}) };
      this.engine.commandOutputs.trackNativeBackground(id, work.id, update.sessionId, work.member && !ended(work) && update.connected !== false, work.output);
      if (work.origin?.runId && (work.backgrounded || work.member)) {
        this.origins.set(JSON.stringify([id, work.id]), { sessionId: update.sessionId, eventId: work.origin.eventId });
        this.engine.commandOutputs.trackBackground(id, { ...event, id: work.origin.eventId }, work.origin.runId, update.sessionId);
      }
    }
    this.engine.taskSettlement.notify();
  }

  async recover() {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); let changed = false;
      for (const task of state.tasks) {
        if (task.nativeBackgroundConnected) { task.nativeBackgroundConnected = false; changed = true; }
        if (task.backgroundWaiting) { task.backgroundWaiting = false; changed = true; }
        for (const work of task.nativeBackgroundWork ?? []) if (!ended(work) && (work.member || work.status !== 'unknown')) { work.member = false; work.status = 'unknown'; changed = true; }
      }
      if (changed) state.revision++;
    }, context);
  }
  async stop(taskId: string, workId: string, sessionId: string, requestId: string) {
    if (![taskId, workId, sessionId, requestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\x00-\x1f]/.test(value)) || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('后台任务停止请求无效');
    let durableId = 0;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.nativeBackgroundRequests?.[requestId];
      if (receipt) { if (receipt.taskId !== taskId || receipt.workId !== workId || receipt.sessionId !== sessionId) throw new Error('后台任务请求 ID 已被使用'); durableId = receipt.durableId; return; }
      const task = state.tasks.find(task => task.id === taskId); const work = task?.nativeBackgroundWork?.find(work => work.id === workId && work.transportId === sessionId);
      if (!task || task.executionSessionId !== sessionId || !task.nativeBackgroundConnected || !work || task.agent !== work.provider || work.canStop === false || !work.member && !work.backgrounded && work.kind !== 'subagent' || ended(work) || work.ambient || work.stop?.status === 'pending') throw new Error('此后台任务当前不可停止，请刷新后重试');
      durableId = await tx.createTask(this.definition, { taskId, workId, sessionId, requestId }, { ownership: { kind: 'conversation' } });
      work.stop = { requestId, durableId, status: 'pending' }; state.nativeBackgroundRequests ??= {}; state.nativeBackgroundRequests[requestId] = { taskId, workId, sessionId, durableId }; state.revision++;
    }, context);
    this.engine.harness.resume(); return durableId;
  }
  private async finishStop(input: StopInput, status: 'completed' | 'uncertain', error?: string) {
    await this.engine.mutate(state => {
      const work = state.tasks.find(task => task.id === input.taskId)?.nativeBackgroundWork?.find(work => work.id === input.workId && work.transportId === input.sessionId);
      if (!work?.stop || work.stop.requestId !== input.requestId || work.stop.status !== 'pending') return;
      work.stop.status = status; if (error) work.stop.error = error;
    });
  }
  async stopBeforeDelete(taskId: string) {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === taskId);
    for (const work of task?.nativeBackgroundWork ?? []) {
      if (!work.member || work.ambient || ended(work)) continue;
      const id = work.stop?.status === 'pending' ? work.stop.durableId : await this.stop(taskId, work.id, work.transportId, 'delete:' + randomUUID());
      await this.engine.harness.waitForTask(id as TaskId, context);
      const current = (await this.engine.snapshot()).tasks.find(task => task.id === taskId)?.nativeBackgroundWork?.find(value => value.id === work.id);
      if (current && !ended(current)) throw new Error('后台任务停止结果尚未确认，任务已保留');
    }
  }
}
