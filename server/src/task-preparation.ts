import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { TaskId } from '@earendil-works/pi-durable';
import type { Engine, ExecutionTaskInput } from './engine.js';
import { assertCheckoutIdle, branchBlocksTask } from './branch-switch.js';
import { WorkspaceDoc } from './state.js';
import { retryWorkspacePlan } from './task-workspace.js';
import { activeFork, headForkSourceBusy, activeGitOperation, activeRewind, activeStatuses, failedWorkspacePreparation } from './types.js';
import { nativeSessionActionBusy } from './task-session-actions.js';
import { clearTaskSnooze } from './task-snooze.js';

// A preparation retry continues the same run and original Durable input. A new
// Durable attempt owns scheduling; a terminal task is never edited or replayed.
export class TaskPreparations {
  constructor(private readonly engine: Engine) {}

  async cancel(id: string, runId: unknown, attempt: unknown) {
    if (typeof runId !== 'string' || !runId || runId.length > 100 || !Number.isSafeInteger(attempt) || Number(attempt) < 1) throw new Error('停止准备请求无效');
    let abort = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), task = state.tasks.find(task => task.id === id && task.agent !== 'friday' && !task.subagentOrigin);
      const run = task?.runs?.find(run => run.id === runId && !run.revertedAt && !run.inheritedFrom), preparation = run?.workspacePreparation;
      if (!task || !run || !preparation || task.currentRunId !== runId || preparation.attempt !== attempt) throw new Error('准备范围已改变，请刷新后重试');
      if (!preparation.cancelRequestedAt) {
        if (!activeStatuses.includes(task.status) || run.startedAt || run.before || run.turnId) throw new Error('Agent 已启动或准备已结束，不能再停止准备');
        preparation.cancelRequestedAt = new Date().toISOString(); state.revision++;
      }
      abort = activeStatuses.includes(task.status);
    }, context);
    if (abort) await this.engine.cancel(id, { runId });
    return { cancelled: true };
  }

  async recoverMetadata() {
    const snapshot = await this.engine.snapshot();
    for (const saved of snapshot.tasks) {
      if (saved.agent === 'friday' || saved.status !== 'failed' || saved.durableId == null || !saved.executionWorkspace || saved.executionWorkspace.state === 'ready' || saved.threadId || saved.turnId) continue;
      if (saved.runs?.some(run => run.id === saved.currentRunId && run.workspacePreparation)) continue;
      const record = await this.engine.harness.getTask(saved.durableId as TaskId, context);
      if (!record || record.kind !== 'friday.execute' || record.state.status !== 'terminal' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input) || record.input.id !== saved.id) continue;
      const runId = typeof record.input.runId === 'string' ? record.input.runId : String(record.id);
      await this.engine.mutate(state => {
        const task = state.tasks.find(task => task.id === saved.id);
        if (!task || task.durableId !== record.id || task.status !== 'failed' || task.executionWorkspace?.state === 'ready' || task.threadId || task.turnId) return;
        task.runs ??= [];
        let run = task.runs.find(run => run.id === runId);
        if (run?.workspacePreparation || run?.before || run?.turnId || run?.inheritedFrom) return;
        if (!run) {
          const message = task.messages?.findLast(message => message.role === 'user' && !message.revertedAt);
          if (!message) return;
          run = { id: runId, durableId: record.id, messageId: message.id, requestId: task.lastRequestId, cwd: task.cwd, at: message.at ?? task.createdAt,
            status: 'failed', mode: task.mode, interactionMode: task.interactionMode ?? 'default', model: task.model, reasoningEffort: task.reasoningEffort };
          task.runs.push(run); message.runId = runId;
          // Reacquire the transaction overlay after insertion; mutating the
          // local object used for push would not update the persisted document.
          run = task.runs.find(candidate => candidate.id === runId)!;
        }
        task.currentRunId = runId;
        run.workspacePreparation = { status: 'failed', attempt: 1, startedAt: run.at, completedAt: task.updatedAt, error: task.error ?? '工作区准备失败' };
      });
    }
  }

  async retry(id: string, runId: string, requestId: string) {
    if (!requestId || requestId.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('请求 ID 无效');
    const snapshot = await this.engine.snapshot();
    const receipt = snapshot.preparationRequests && Object.hasOwn(snapshot.preparationRequests, requestId) ? snapshot.preparationRequests[requestId] : undefined;
    if (receipt) {
      if (receipt.taskId !== id || receipt.runId !== runId) throw new Error('请求 ID 已被其他准备重试使用');
      return id;
    }
    const original = snapshot.tasks.find(task => task.id === id);
    const failed = original && failedWorkspacePreparation(original, runId);
    if (!original || original.agent === 'friday' || !failed?.durableId || !original.executionWorkspace) throw new Error('这轮没有失败的工作区准备可以重试');
    const record = await this.engine.harness.getTask(failed.durableId as TaskId, context);
    if (!record || record.kind !== 'friday.execute' || !record.input || typeof record.input !== 'object' || Array.isArray(record.input)) throw new Error('找不到原始执行输入，无法重试工作区准备');
    const input = record.input as unknown as ExecutionTaskInput;
    if (input.id !== id || typeof input.prompt !== 'string' || (input.runId ?? String(record.id)) !== runId) throw new Error('原始执行输入与轮次不匹配');
    if (record.state.status !== 'terminal') await this.engine.harness.waitForTask(record.id, context);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const receipt = state.preparationRequests && Object.hasOwn(state.preparationRequests, requestId) ? state.preparationRequests[requestId] : undefined;
      if (receipt) {
        if (receipt.taskId !== id || receipt.runId !== runId) throw new Error('请求 ID 已被其他准备重试使用');
        return;
      }
      const task = state.tasks.find(task => task.id === id);
      const run = task && failedWorkspacePreparation(task, runId);
      if (!task || !run || run.durableId !== failed.durableId || !task.executionWorkspace) throw new Error('准备状态已改变，请重新查看');
      if (task.archivedAt) throw new Error('请先恢复归档任务');
      if (activeStatuses.includes(task.status) || task.runs?.some(other => other.id !== runId && !other.revertedAt && activeStatuses.includes(other.status))) throw new Error('请等待当前执行结束后重试工作区准备');
      if (nativeSessionActionBusy(task) || activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || activeFork(task.forkOperation) || headForkSourceBusy(state.tasks, task.id) || task.branchChange?.status === 'queued' || task.branchChange?.status === 'running') throw new Error('请先处理这条会话的工作区或会话操作');
      if (branchBlocksTask(state, task.cwd)) throw new Error('当前工作区有操作正在进行，请完成后重试');
      const plan = await retryWorkspacePlan(JSON.parse(JSON.stringify(task.executionWorkspace)));
      if (plan.mode === 'checkout' && !plan.scratch && plan.state !== 'ready') assertCheckoutIdle({ ...state, tasks: state.tasks.filter(other => other.id !== id) }, plan.root);
      const stamp = new Date().toISOString();
      const durableId = await tx.createTask(this.engine.execution, { ...input, predecessor: record.id, runId }, { ownership: { kind: 'conversation' } });
      const failureOwnsQueue = task.runs?.filter(run => !run.revertedAt).at(-1)?.id === runId;
      const queue = task.queue;
      const follows = queue && failureOwnsQueue && (!queue.paused || queue.heldByRunId === runId);
      const entry = queue?.messages.find(entry => entry.id === run.messageId && entry.runId === run.durableId);
      if (entry) { entry.status = 'running'; entry.runId = durableId; entry.error = null; }
      if (queue && follows) {
        queue.paused = false; queue.error = null; delete queue.heldByRunId;
        queue.dispatcherId = await tx.createTask(this.engine.taskQueue.definition, { id, predecessor: durableId, explicit: false }, { ownership: { kind: 'conversation' } });
      }
      run.durableId = durableId; run.status = 'queued'; delete run.completedAt; delete run.startedAt;
      run.workspacePreparation = { status: 'preparing', attempt: run.workspacePreparation!.attempt + 1, startedAt: stamp };
      task.currentRunId = runId; task.durableId = durableId; task.status = 'queued'; task.canSteer = false;
      task.lastRequestId = run.requestId; task.error = null; task.result = ''; task.artifact = null; task.workspaceRequest = null; task.turnId = null;
      task.mode = run.mode; task.interactionMode = run.interactionMode;
      if (run.model !== undefined) task.model = run.model; else delete task.model;
      if (run.reasoningEffort !== undefined) task.reasoningEffort = run.reasoningEffort; else delete task.reasoningEffort;
      task.executionWorkspace = plan; task.cwd = plan.cwd; task.updatedAt = stamp; task.unread = false;
      task.settledAt = null; clearTaskSnooze(task);
      state.preparationRequests ??= {}; state.preparationRequests[requestId] = { taskId: id, runId, durableId };
      state.queueTail = durableId; state.revision++;
    }, context);
    this.engine.harness.resume();
    return id;
  }
}
