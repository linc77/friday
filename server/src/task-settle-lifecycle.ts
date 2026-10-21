import { randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { WorkItem, Workspace } from './types.js';
import { WorkspaceDoc } from './state.js';
import { applyTaskMetadata, automaticallyQueuedRun, priorTaskMetadata, recordTaskMetadata, type TaskMetadataChange } from './task-metadata.js';

export type TaskSettleCleanup = { id: string; durableId: number; status: 'pending' | 'completed' | 'interrupted'; startedAt: string; completedAt?: string; error?: string };
type Input = { taskId: string; id: string; runId?: string; sessionId?: string; cancel: number[] };
const stamp = () => new Date().toISOString();
type Transaction = Parameters<Parameters<Engine['root']['commit']>[0]>[0];

/** T3 thread.settle rejects active work, then detaches only the idle provider.
 * The existing Durable engine freezes that boundary before any native effect.
 * Project settle scripts are admitted only after this detach has completed. */
export class TaskSettles {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'detach' }, { status: string }, {}>({
      name: 'friday.settle_cleanup', version: 1, initial: () => ({ phase: 'detach' }),
      phases: { detach: async (task, runtime, ctx) => {
        const input = task.input;
        const current = async () => {
          const work = (await engine.snapshot()).tasks.find(value => value.id === input.taskId);
          return work?.settleCleanup?.id === input.id && work.settleCleanup.status === 'pending' && work.currentRunId === input.runId && work.executionSessionId === input.sessionId ? work : undefined;
        };
        if (!await current()) { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'superseded' } } }), ctx); return; }
        try {
          await engine.taskQueue.stop(input.taskId);
          for (const id of input.cancel) { await engine.harness.abortTask(id as TaskId, ctx); await engine.harness.waitForTask(id as TaskId, ctx); }
          const work = await current(); if (!work) throw new Error('结束跟进的执行范围已经改变');
          await engine.backgroundStops.cancelSettled(work);
          if (!await current()) throw new Error('结束跟进的执行范围已经改变');
          await engine.executor.stopNativeSession?.(work.id, input.sessionId ?? '');
          await this.finish(input, 'completed');
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await this.finish(input, 'interrupted');
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.finish(task.input, 'interrupted');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  async prepare(tx: Transaction, state: Workspace, task: WorkItem, change: TaskMetadataChange, at = stamp(), forceDetach = false) {
    const cancel = task.runs?.filter(run => automaticallyQueuedRun(task, run)).map(run => run.durableId).filter((id): id is number => id !== null) ?? [];
    const alreadySettled = !!task.settledAt;
    applyTaskMetadata(task, change, at);
    for (const run of task.runs ?? []) if (automaticallyQueuedRun(task, run)) { run.status = 'cancelled'; run.completedAt = at; }
    if (task.status === 'queued') task.status = 'cancelled';
    if (task.queue) {
      task.queue.paused = true;
      for (const message of task.queue.messages) if (message.creationSource === 'monitor' && ['queued', 'dispatching'].includes(message.status)) { message.status = 'cancelled'; message.error = null; }
    }
    if (task.settleCleanup?.status === 'pending') { recordTaskMetadata(state, task.id, change, task.settleCleanup.durableId); return task.settleCleanup.durableId; }
    if (!forceDetach && alreadySettled && task.settleCleanup?.status === 'completed') { recordTaskMetadata(state, task.id, change); return; }
    if (!task.executionSessionId && !cancel.length) {
      if (task.settleCleanup) { task.settleCleanup.status = 'completed'; task.settleCleanup.completedAt = stamp(); delete task.settleCleanup.error; }
      recordTaskMetadata(state, task.id, change); return;
    }
    const id = randomUUID(), durableId = await tx.createTask(this.definition, { taskId: task.id, id, runId: task.currentRunId, sessionId: task.executionSessionId, cancel }, { ownership: { kind: 'conversation' } });
    task.settleCleanup = { id, durableId, status: 'pending', startedAt: stamp() }; task.canSteer = false;
    recordTaskMetadata(state, task.id, change, durableId);
    return durableId;
  }
  async start(id: string, change: TaskMetadataChange) {
    let durableId: number | undefined, applied = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), receipt = priorTaskMetadata(state, id, change);
      if (receipt) { const pending = state.tasks.find(task => task.id === id)?.settleCleanup; if (pending?.status === 'pending' && pending.durableId === receipt.cleanupId) durableId = pending.durableId; return; }
      const task = state.tasks.find(task => task.id === id); if (!task) throw new Error('任务不存在');
      durableId = await this.prepare(tx, state, task, change); await this.engine.projectScripts.captureSettles(tx, state); state.revision++; applied = true;
    }, context);
    this.engine.harness.resume();
    if (durableId !== undefined) await this.engine.harness.waitForTask(durableId as TaskId, context);
    this.engine.taskSettlement.notify(); return applied;
  }
  private async finish(input: Input, status: 'completed' | 'interrupted') {
    await this.engine.mutate(state => {
      const task = state.tasks.find(task => task.id === input.taskId), operation = task?.settleCleanup;
      if (!task || operation?.id !== input.id || operation.status !== 'pending') return;
      operation.status = status; operation.completedAt = stamp();
      if (status === 'interrupted') operation.error = '结束跟进已保存；会话清理尚未确认，请检查后重新结束跟进。';
    });
  }
}
