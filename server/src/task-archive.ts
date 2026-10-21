import { randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeFork, activeGitOperation, activeStatuses } from './types.js';
import { applyTaskMetadata, priorTaskMetadata, recordTaskMetadata, type TaskMetadataChange } from './task-metadata.js';

export type TaskArchiveCleanup = { id: string; durableId: number; status: 'pending' | 'completed' | 'interrupted'; startedAt: string; completedAt?: string; error?: string };
type Input = { taskId: string; id: string; runId?: string; durableId: number | null; sessionId: string };
const stamp = () => new Date().toISOString();

/** T3 archive detaches the provider and closes terminals. Pi Durable owns the
 * cleanup; the archive claim and cancellation boundary precede all effects. */
export class TaskArchives {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'cleanup' }, { status: string }, {}>({
      name: 'friday.archive_cleanup', version: 1, initial: () => ({ phase: 'cleanup' }),
      phases: { cleanup: async (task, runtime, ctx) => {
        const input = task.input;
        const work = (await engine.snapshot()).tasks.find(value => value.id === input.taskId);
        if (!work || work.archiveCleanup?.id !== input.id || work.archiveCleanup.status !== 'pending') {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'superseded' } } }), ctx); return;
        }
        try {
          // Closing an owned handle is repeatable; never start/resume a native
          // process, replay stdin or run an initialization/settle script here.
          await engine.taskQueue.stop(work.id);
          if (input.durableId != null && activeStatuses.includes(work.status)) {
            await engine.harness.abortTask(input.durableId as TaskId, ctx);
            await engine.harness.waitForTask(input.durableId as TaskId, ctx);
          }
          const current = (await engine.snapshot()).tasks.find(value => value.id === work.id);
          if (!current || current.archiveCleanup?.id !== input.id || current.currentRunId !== input.runId) throw new Error('归档执行范围已经改变');
          await engine.taskTitles.stop(work.id);
          await engine.projectScripts.stopTask(work.id);
          // Terminate retained native commands while their control transport
          // still exists; closing it first would only mark them interrupted.
          await engine.backgroundStops.cancelSettled(current);
          await engine.executor.stopNativeSession?.(work.id, current.executionSessionId ?? input.sessionId);
          await engine.terminals.archiveTask(work.id);
          for (const owner of new Set(engine.projectScripts.list(await engine.snapshot(), work.id).map(run => run.terminalOwner).filter(owner => owner !== work.id))) await engine.terminals.archiveTask(owner);
          await this.finish(input, 'completed');
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await this.finish(input, 'interrupted', '归档已保存；清理尚未确认，请检查后重新归档。');
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.finish(task.input, 'interrupted', '归档清理曾中断；原生操作不会重新执行。');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  async start(id: string, change: TaskMetadataChange) {
    let durableId: number | undefined;
    let applied = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), receipt = priorTaskMetadata(state, id, change);
      if (receipt) {
        const pending = state.tasks.find(task => task.id === id)?.archiveCleanup;
        if (pending?.status === 'pending' && pending.durableId === receipt.cleanupId) durableId = pending.durableId;
        return;
      }
      const task = state.tasks.find(value => value.id === id);
      if (!task || task.agent === 'friday' || task.subagentOrigin) throw new Error('本地任务不存在');
      if (activeFork(task.forkOperation)) throw new Error('请先完成会话分叉再归档或稍后处理');
      if (task.settleCleanup?.status === 'pending') throw new Error('正在清理结束跟进的会话，请等待完成后归档');
      if (activeGitOperation(task.gitOperation) || ['queued', 'running'].includes(task.branchChange?.status ?? '')) throw new Error('请先停止任务并处理排队消息再归档');
      const alreadyArchived = task.archivedAt != null;
      applyTaskMetadata(task, change, stamp(), true);
      state.revision++; applied = true;
      if (task.archiveCleanup?.status === 'pending') { durableId = task.archiveCleanup.durableId; recordTaskMetadata(state, id, change, durableId); return; }
      if (alreadyArchived && task.archiveCleanup?.status === 'completed') { recordTaskMetadata(state, id, change); return; }
      const operation = randomUUID();
      if (task.queue) {
        task.queue.paused = true; delete task.queue.heldOnRestart; delete task.queue.heldByRunId;
        for (const message of task.queue.messages) if (['queued', 'dispatching'].includes(message.status)) { message.status = 'cancelled'; message.error = null; }
      }
      const preparation = task.runs?.find(run => run.id === task.currentRunId)?.workspacePreparation;
      if (preparation?.status === 'preparing') preparation.cancelRequestedAt ??= stamp();
      durableId = await tx.createTask(this.definition, { taskId: id, id: operation, runId: task.currentRunId, durableId: task.durableId, sessionId: task.executionSessionId ?? '' }, { ownership: { kind: 'conversation' } });
      task.archiveCleanup = { id: operation, durableId, status: 'pending', startedAt: stamp() }; task.canSteer = false;
      recordTaskMetadata(state, id, change, durableId);
      state.revision++;
    }, context);
    this.engine.harness.resume();
    if (durableId !== undefined) await this.engine.harness.waitForTask(durableId as TaskId, context);
    return applied;
  }
  private async finish(input: Input, status: 'completed' | 'interrupted', error?: string) {
    await this.engine.mutate(state => {
      const task = state.tasks.find(task => task.id === input.taskId), operation = task?.archiveCleanup;
      if (!task || operation?.id !== input.id || operation.status !== 'pending') return;
      operation.status = status; operation.completedAt = stamp(); if (error) operation.error = error;
      if (status === 'completed' && task.currentRunId === input.runId) {
        if (activeStatuses.includes(task.status) || task.status === 'needs_project') task.status = 'cancelled';
        task.canSteer = false; task.backgroundWaiting = false;
        for (const approval of task.approvals) if (approval.state === 'pending') approval.state = 'expired';
      }
    });
  }
}
