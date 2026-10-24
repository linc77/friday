import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { ExecutionUpdate, WorkItem } from './types.js';
import { activeNativeBackground, nativeCompletionPending, backgroundWorkPending } from './native-runtime-types.js';
import { providerSubagentActive } from './task-subagent-types.js';

export type TaskBackgroundCommand = {
  id: string; sessionId: string; threadId: string; turnId: string; itemId: string; runId: string;
  processId?: string; command: string; status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'unknown';
  startedAt: string; updatedAt: string; completedAt?: string; exitCode?: number;
  stop?: { requestId: string; durableId: number; status: 'pending' | 'completed' | 'failed' | 'uncertain'; error?: string };
};
export const hasRunningBackgroundCommands = (task: WorkItem) => task.backgroundStop?.status === 'pending' || (task.backgroundCommands?.some(command => command.status === 'running') ?? false) || activeNativeBackground(task).length > 0 || providerSubagentActive(task);
export const backgroundCommandActivity = (task: WorkItem) => {
  const native = activeNativeBackground(task); const unknown = (task.nativeBackgroundWork ?? []).filter(work => !work.ambient && work.backgrounded && work.status === 'unknown');
  const stop = task.backgroundStop;
  const children = (task.subagents ?? []).filter(agent => agent.provider !== 'claude' && agent.sessionId === task.executionSessionId);
  return { commands: (task.backgroundCommands?.filter(command => command.status === 'running').length ?? 0) + native.filter(work => work.kind === 'command').length + children.reduce((count, agent) => count + (agent.backgroundCommands ?? 0), 0),
    unknownCommands: (task.backgroundCommands?.filter(command => command.status === 'unknown').length ?? 0) + unknown.filter(work => work.kind === 'command').length + children.reduce((count, agent) => count + (agent.unknownCommands ?? 0), 0),
    monitors: native.filter(work => work.kind === 'monitor').length, subagents: native.filter(work => work.kind === 'subagent').length + children.filter(agent => ['running', 'waiting'].includes(agent.status)).length,
    backgroundTasks: native.filter(work => work.kind === 'background_task').length, unknownTasks: unknown.length + children.filter(agent => agent.status === 'unknown').length,
    canStop: Boolean(['codex', 'claude', 'muse', 'pi'].includes(task.agent) && (backgroundWorkPending(task) || stop && stop.sessionId === task.executionSessionId && (!stop.runId || stop.runId === task.currentRunId) && ['pending', 'uncertain'].includes(stop.status))),
    waiting: task.backgroundWaiting === true || nativeCompletionPending(task) && task.nativeBackgroundConnected === true };
};
type StopInput = { taskId: string; eventId: string; sessionId: string; requestId: string };

/** A provider command's native lifetime can outlast the originating model turn.
 * It never grants ownership of a later turn's result or external execution. */
export class TaskBackgroundCommands {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<StopInput, { phase: 'execute' }, { status: string }, {}>({
      name: 'friday.background_command_stop', version: 1, initial: () => ({ phase: 'execute' }),
      phases: { execute: async (task, runtime, ctx) => {
        const input = task.input;
        const finish = async (status: 'completed' | 'failed' | 'uncertain', error?: string) => {
          await this.finishStop(input, status, error);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const work = (await this.engine.snapshot()).tasks.find(work => work.id === input.taskId);
        const command = work?.backgroundCommands?.find(command => command.id === input.eventId && command.sessionId === input.sessionId);
        if (!work || !command || command.stop?.requestId !== input.requestId) { await finish('failed', '后台命令已不在当前任务中'); return; }
        if (['completed', 'failed', 'stopped', 'interrupted'].includes(command.status)) { await finish('completed'); return; }
        const result = await runtime.memo<boolean>('stopped', ctx);
        if (result === undefined && (command.status === 'unknown' || await runtime.memo<boolean>('started', ctx))) {
          await finish('uncertain', '停止结果尚未确认，请检查命令状态后再操作'); return;
        }
        if (result === undefined) {
          try {
            runtime.signal.throwIfAborted();
            if (!this.engine.executor.stopBackgroundCommand) throw new Error('此 Agent 不支持停止后台命令');
            await runtime.memo('started', true, ctx);
            await this.engine.executor.stopBackgroundCommand(work, command);
            await runtime.memo('stopped', true, ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            const current = (await this.engine.snapshot()).tasks.find(work => work.id === input.taskId)?.backgroundCommands?.find(command => command.id === input.eventId && command.sessionId === input.sessionId);
            if (current && ['completed', 'failed', 'stopped', 'interrupted'].includes(current.status)) { await finish('completed'); return; }
            await finish('uncertain', '未确认后台命令是否已停止，请检查后重试'); return;
          }
        }
        await finish('completed');
      } },
      abort: async (task, runtime, ctx) => {
        await this.finishStop(task.input, 'uncertain', '停止请求已中断，结果尚未确认');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx);
      },
    });
  }

  async update(id: string, update: Extract<ExecutionUpdate, { kind: 'backgroundCommand' | 'backgroundCommandOutput' }>, runId?: string) {
    if (!runId) return;
    if (update.kind === 'backgroundCommandOutput') {
      this.engine.commandOutputs.appendBackground(id, update.eventId, update.delta, runId, update.sessionId);
      return;
    }
    const event = update.item;
    if (event.kind !== 'command' || !event.background || !event.itemId || !event.turnId || event.id !== `codex:${event.turnId}:${event.itemId}`) return;
    const current = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!current || current.executionSessionId !== update.sessionId || !current.runs?.some(run => run.id === runId && !run.revertedAt && !run.executionExcludedAt)) return;
    const history = await this.engine.taskHistory.eventItems(id, [event.id]);
    const original = history.events.find(item => item.id === event.id && item.kind === 'command' && !item.revertedAt);
    if (!original || original.runId !== runId || original.turnId !== event.turnId) return;
    let accepted = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const work = state.tasks.find(work => work.id === id);
      const run = work?.runs?.find(run => run.id === runId && !run.revertedAt && !run.executionExcludedAt && run.turnId === event.turnId);
      if (!work || !run || work.agent !== 'codex' || work.executionSessionId !== update.sessionId || work.threadId !== update.threadId) return;
      const previous = work.backgroundCommands?.find(command => command.id === event.id);
      if (previous && (previous.sessionId !== update.sessionId || previous.runId !== runId || previous.status !== 'running' && event.status === 'running')) return;
      const item = { ...event, at: original.at, runId, ...(original.historyOrder !== undefined ? { historyOrder: original.historyOrder } : {}) };
      const index = work.events.findIndex(item => item.id === event.id);
      if (index < 0) work.events.push(item); else work.events[index] = item;
      const stamp = new Date().toISOString();
      const command: TaskBackgroundCommand = { id: event.id, sessionId: update.sessionId, threadId: update.threadId, turnId: event.turnId!, itemId: event.itemId!, runId,
        command: event.text, status: update.disconnected ? 'unknown' : event.status === 'running' ? 'running' : event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped',
        startedAt: original.at, updatedAt: stamp, ...(event.processId ? { processId: event.processId } : previous?.processId ? { processId: previous.processId } : {}),
        ...(event.completedAt ? { completedAt: event.completedAt } : {}), ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}), ...(previous?.stop ? { stop: { ...previous.stop } } : {}) };
      work.backgroundCommands ??= [];
      const position = work.backgroundCommands.findIndex(value => value.id === event.id);
      if (position < 0) work.backgroundCommands.push(command); else work.backgroundCommands[position] = command;
      await this.engine.taskHistory.persist(tx, work, [event.id]);
      state.revision++; accepted = true;
    }, context);
    if (accepted) {
      this.engine.commandOutputs.trackBackground(id, event, runId, update.sessionId);
      this.engine.taskSettlement.notify();
    }
  }

  async recover() {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); let changed = false;
      for (const work of state.tasks) for (const command of work.backgroundCommands ?? []) if (command.status === 'running') {
        command.status = 'unknown'; command.updatedAt = new Date().toISOString(); changed = true;
      }
      if (changed) state.revision++;
    }, context);
  }

  async stopBeforeDelete(taskId: string) {
    const work = (await this.engine.snapshot()).tasks.find(work => work.id === taskId);
    for (const command of work?.backgroundCommands ?? []) {
      if (command.status !== 'running') continue;
      const durableId = command.stop?.status === 'pending' ? command.stop.durableId : await this.stop(taskId, command.id, command.sessionId, 'delete:' + randomUUID());
      await this.engine.harness.waitForTask(durableId as TaskId, context);
      const current = (await this.engine.snapshot()).tasks.find(work => work.id === taskId)?.backgroundCommands?.find(value => value.id === command.id && value.sessionId === command.sessionId);
      if (current && !['completed', 'failed', 'stopped'].includes(current.status)) throw new Error('后台命令停止结果尚未确认，任务已保留，请检查后重试删除');
    }
  }

  async stop(taskId: string, eventId: string, sessionId: string, requestId: string) {
    if (![taskId, eventId, sessionId, requestId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 250 && !/[\x00-\x1f]/.test(value)) || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('后台命令停止请求无效');
    let durableId = 0;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.backgroundCommandRequests?.[requestId];
      if (receipt) {
        if (receipt.taskId !== taskId || receipt.eventId !== eventId || receipt.sessionId !== sessionId) throw new Error('后台命令请求 ID 已被使用');
        durableId = receipt.durableId; return;
      }
      const work = state.tasks.find(work => work.id === taskId); const command = work?.backgroundCommands?.find(command => command.id === eventId && command.sessionId === sessionId);
      if (!work || work.agent !== 'codex' || work.executionSessionId !== sessionId || !command || command.status !== 'running' || !command.processId || command.stop?.status === 'pending') throw new Error('此后台命令当前不可停止，请刷新后重试');
      const run = work.runs?.find(run => run.id === command.runId && !run.revertedAt && !run.executionExcludedAt);
      const origin = work.subagentOrigin;
      const root = origin && state.tasks.find(task => task.id === origin.rootTaskId && task.executionSessionId === sessionId && task.threadId === origin.threadId);
      const agent = root?.subagents?.find(agent => agent.id === origin!.subagentId && agent.childTaskId === work.id && agent.sessionId === sessionId && agent.nativeId === command.threadId);
      const childRun = agent && root?.runs?.some(run => run.id === agent.runId && !run.revertedAt && !run.executionExcludedAt);
      if (!run && !childRun) throw new Error('后台命令已不在当前任务历史中');
      durableId = await tx.createTask(this.definition, { taskId, eventId, sessionId, requestId }, { ownership: { kind: 'conversation' } });
      command.stop = { requestId, durableId, status: 'pending' };
      state.backgroundCommandRequests ??= {}; state.backgroundCommandRequests[requestId] = { taskId, eventId, sessionId, durableId };
      state.revision++;
    }, context);
    this.engine.harness.resume(); return durableId;
  }

  private async finishStop(input: StopInput, status: 'completed' | 'failed' | 'uncertain', error?: string) {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const work = state.tasks.find(work => work.id === input.taskId);
      const command = work?.backgroundCommands?.find(command => command.id === input.eventId && command.sessionId === input.sessionId);
      if (!work || !command?.stop || command.stop.requestId !== input.requestId || command.stop.status !== 'pending') return;
      command.stop.status = status; if (error) command.stop.error = error;
      // The native termination receipt proves absence, never successful exit.
      if (status === 'completed' && command.status === 'running') {
        command.status = 'stopped'; command.completedAt = new Date().toISOString();
        const event = work.events.find(event => event.id === command.id);
        if (event) { event.status = 'interrupted'; event.completedAt = command.completedAt; await this.engine.taskHistory.persist(tx, work, [event.id]); }
      }
      state.revision++;
    }, context);
    this.engine.taskSettlement.notify();
  }
}
