import { createHash, randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { activeStatuses, type WorkItem, type TaskEvent } from './types.js';
import { WorkspaceDoc } from './state.js';
import { queueRunning } from './task-queue.js';
import { claudeBackgroundEnded } from './claude-background.js';
import { backgroundWorkPending as pendingWork } from './native-runtime-types.js';

export type TaskBackgroundStop = {
  requestId: string; durableId: number; sessionId: string; startedAt: string; completedAt?: string;
  runId?: string | null;
  status: 'pending' | 'completed' | 'uncertain'; error?: string;
};
type Input = { taskId: string; sessionId: string; threadId: string; runId: string | null; agent: string; requestId: string; commandIds: string[] };
const commandEnded = (status: string) => ['completed', 'failed', 'stopped', 'interrupted'].includes(status);
const source = (task: WorkItem, input: Input) => task.executionSessionId === input.sessionId && task.threadId === input.threadId
  && (task.currentRunId ?? null) === input.runId && task.agent === input.agent;

/** T3's settled Stop owns the old provider process, never a newer turn. */
export class TaskBackgroundStops {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'stop' }, { status: string }, {}>({
      name: 'friday.background_work_settle', version: 1, initial: () => ({ phase: 'stop' }),
      phases: { stop: async (task, runtime, ctx) => {
        const input = task.input;
        const finish = async (status: 'completed' | 'uncertain', error?: string) => {
          await this.finish(input, status, error);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const work = (await this.engine.snapshot()).tasks.find(task => task.id === input.taskId);
        if (!work || !source(work, input) || work.backgroundStop?.requestId !== input.requestId || activeStatuses.includes(work.status)) {
          await finish('uncertain', '后台工作的执行范围已变化，未停止新的回复'); return;
        }
        try {
          runtime.signal.throwIfAborted();
          // Missing transport after a disconnect/restart is a metadata-only
          // settle, matching T3's no-live-CLI Stop. Never start a replacement.
          if (!this.engine.executor.hasSession?.(work.id)) {
            await this.interruptMissing(input); await finish('completed'); return;
          }
          if (input.agent === 'claude' || input.agent === 'muse') {
            if (!await runtime.memo<boolean>('closed', ctx)) {
              if (await runtime.memo<boolean>('started', ctx)) { await finish('uncertain', '后台停止结果尚未确认，请检查后重试'); return; }
              if (!this.engine.executor.settleNativeBackground) throw new Error('Unsupported native background Stop');
              await runtime.memo('started', true, ctx);
              await this.engine.executor.settleNativeBackground(work);
              await runtime.memo('closed', true, ctx);
            }
            await this.interruptMissing(input);
          } else if (input.agent === 'codex') {
            await this.engine.subagents.settle(work.id, input.sessionId, input.requestId, runtime.signal);
            for (let index = 0; index < input.commandIds.length; index++) {
              runtime.signal.throwIfAborted();
              const current = (await this.engine.snapshot()).tasks.find(task => task.id === input.taskId);
              if (!current || !source(current, input)) throw new Error('Source changed');
              const command = current.backgroundCommands?.find(command => command.id === input.commandIds[index] && command.sessionId === input.sessionId);
              if (!command || commandEnded(command.status) && command.stop?.status !== 'pending') continue;
              const childRequest = 'settle:' + createHash('sha256').update(JSON.stringify([input.requestId, index])).digest('hex');
              const id = command.stop?.status === 'pending' ? command.stop.durableId
                : await this.engine.backgroundCommands.stop(input.taskId, command.id, input.sessionId, childRequest);
              await this.waitControl(id, runtime.signal);
              const ended = (await this.engine.snapshot()).tasks.find(task => task.id === input.taskId)?.backgroundCommands?.find(value => value.id === command.id);
              if (ended && !commandEnded(ended.status)) throw new Error('Command stop uncertain');
            }
          } else throw new Error('Unsupported background Stop');
          await finish('completed');
        } catch {
          if (runtime.signal.aborted) throw new Error('后台停止请求已中断');
          await finish('uncertain', '后台工作的停止结果尚未确认，已保留当前记录');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.finish(task.input, 'uncertain', '后台停止请求已中断，请检查当前状态');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx);
      },
    });
  }
  async start(taskId: string, sessionId: string, requestId: string, runId?: string) {
    if (![taskId, sessionId, requestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f]/.test(value)) || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('后台停止请求无效');
    let id = 0;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const previous = state.backgroundStopRequests?.[requestId];
      if (previous) { if (previous.taskId !== taskId || previous.sessionId !== sessionId || runId !== undefined && previous.runId !== runId) throw new Error('后台停止请求 ID 已被使用'); id = previous.durableId; return; }
      const task = state.tasks.find(task => task.id === taskId);
      const reconciliation = task?.backgroundStop?.status === 'uncertain' && task.backgroundStop.sessionId === sessionId;
      if (!task || !['codex', 'claude', 'muse'].includes(task.agent) || task.executionSessionId !== sessionId || runId !== undefined && task.currentRunId !== runId || !task.threadId || activeStatuses.includes(task.status) || queueRunning(task) || task.backgroundStop?.status === 'pending' || !pendingWork(task) && !reconciliation) throw new Error('当前后台工作不能停止，请刷新后重试');
      id = await tx.createTask(this.definition, { taskId, sessionId, requestId, threadId: task.threadId, runId: task.currentRunId ?? null, agent: task.agent,
        commandIds: (task.backgroundCommands ?? []).filter(command => command.sessionId === sessionId && (!commandEnded(command.status) || command.stop?.status === 'pending')).map(command => command.id) }, { ownership: { kind: 'conversation' } });
      task.backgroundStop = { requestId, durableId: id, sessionId, runId: task.currentRunId ?? null, status: 'pending', startedAt: new Date().toISOString() };
      state.backgroundStopRequests ??= {}; state.backgroundStopRequests[requestId] = { taskId, sessionId, runId: task.currentRunId ?? null, durableId: id }; state.revision++;
    }, context);
    this.engine.harness.resume(); return id;
  }
  private async finish(input: Input, status: 'completed' | 'uncertain', error?: string) {
    await this.engine.mutate(state => {
      const operation = state.tasks.find(task => task.id === input.taskId)?.backgroundStop;
      if (operation?.requestId !== input.requestId || operation.sessionId !== input.sessionId || operation.status !== 'pending') return;
      operation.status = status; operation.completedAt = new Date().toISOString(); if (error) operation.error = error;
    });
    this.engine.taskSettlement.notify();
  }
  private async interruptMissing(input: Input) {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === input.taskId); if (!task || !source(task, input)) return;
    if (input.agent === 'claude' || input.agent === 'muse') {
      const stamp = new Date().toISOString();
      await this.engine.nativeBackground.update(task.id, { kind: 'nativeBackground', provider: input.agent, sessionId: input.sessionId, threadId: input.threadId, connected: false,
        tasks: (task.nativeBackgroundWork ?? []).filter(work => work.transportId === input.sessionId).map(work => claudeBackgroundEnded(work) ? { ...work, member: false } : { ...work, member: false, status: 'interrupted', completedAt: stamp, updatedAt: stamp }) });
      await this.engine.subagents.interruptSource(task.id, input.sessionId);
      return;
    }
    const events: TaskEvent[] = [];
    for (let index = 0; index < input.commandIds.length; index += 128) events.push(...(await this.engine.taskHistory.eventItems(task.id, input.commandIds.slice(index, index + 128))).events);
    const accepted: Array<{ event: TaskEvent; runId: string }> = [];
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const work = state.tasks.find(task => task.id === input.taskId);
      if (!work || !source(work, input)) return;
      const touched: string[] = [];
      for (const id of input.commandIds) {
        const command = work.backgroundCommands?.find(command => command.id === id && command.sessionId === input.sessionId); if (!command || commandEnded(command.status)) continue;
        command.status = 'interrupted'; command.completedAt = new Date().toISOString();
        const saved = work.events.find(event => event.id === id) ?? events.find(event => event.id === id && !event.revertedAt);
        if (!saved) continue;
        const tail = this.engine.commandOutputs.nativeTail(task.id, id);
        const event = { ...saved, status: 'interrupted' as const, completedAt: command.completedAt, ...(tail ? { detail: tail.text, detailTruncated: tail.truncated } : {}) };
        accepted.push({ event, runId: command.runId });
        const index = work.events.findIndex(value => value.id === id); if (index < 0) work.events.push(event); else work.events[index] = event; touched.push(id);
      }
      await this.engine.taskHistory.persist(tx, work, touched); state.revision++;
    }, context);
    for (const { event, runId } of accepted) this.engine.commandOutputs.trackBackground(task.id, event, runId, input.sessionId);
    await this.engine.subagents.interruptSource(task.id, input.sessionId);
  }
  async wait(taskId: string) {
    const operation = (await this.engine.snapshot()).tasks.find(task => task.id === taskId)?.backgroundStop;
    if (operation?.status === 'pending') await this.engine.harness.waitForTask(operation.durableId as TaskId, context);
  }
  async cancelSettled(expected: WorkItem) {
    const current = async () => (await this.engine.snapshot()).tasks.find(task => task.id === expected.id);
    const same = (task: WorkItem) => task.executionSessionId === expected.executionSessionId && task.currentRunId === expected.currentRunId && task.threadId === expected.threadId;
    const task = await current(); if (!task || !same(task) || activeStatuses.includes(task.status) || queueRunning(task) || !task.executionSessionId) return;
    let id = task.backgroundStop?.status === 'pending' ? task.backgroundStop.durableId : undefined;
    if (id === undefined) {
      const reconciliation = task.backgroundStop?.status === 'uncertain' && task.backgroundStop.sessionId === task.executionSessionId;
      if (!pendingWork(task) && !reconciliation) return;
      try { id = await this.start(task.id, task.executionSessionId, 'cancel:' + randomUUID(), task.currentRunId); }
      catch (error) {
        const latest = await current(); if (!latest || !same(latest)) return;
        if (latest.backgroundStop?.status === 'completed' && !pendingWork(latest)) return;
        if (latest.backgroundStop?.status !== 'pending') throw error;
        id = latest.backgroundStop.durableId;
      }
    }
    await this.engine.harness.waitForTask(id as TaskId, context);
    const result = await current(); if (result && same(result) && result.backgroundStop?.durableId === id && result.backgroundStop.status === 'uncertain') throw new Error(result.backgroundStop.error ?? '后台停止结果尚未确认');
  }
  private async waitControl(id: number, signal: AbortSignal) {
    let timer: NodeJS.Timeout | undefined; let abort!: () => void;
    try {
      await Promise.race([this.engine.harness.waitForTask(id as TaskId, context), new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Stop aborted')); signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Native Stop confirmation timeout')), 10_000); if (signal.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
