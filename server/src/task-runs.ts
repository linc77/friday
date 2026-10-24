import type { Engine } from './engine.js';
import { TaskCheckpoints } from './task-checkpoints.js';
import type { TaskRun, TaskStatus, WorkItem } from './types.js';
import { recordExecution } from './task-run-order.js';
import { nativeSessionActionBusy, providerEpoch } from './task-session-actions.js';

export class TaskRuns {
  readonly checkpoints: TaskCheckpoints;
  constructor(private readonly engine: Engine) { this.checkpoints = new TaskCheckpoints(engine.directory); }

  async ensure(id: string, durableID: number, runID = String(durableID)) {
    await this.engine.mutate(state => {
      const task = state.tasks.find(task => task.id === id);
      if (!task || task.durableId !== durableID) return;
      task.currentRunId = runID;
      task.runs ??= [];
      if (task.runs.some(run => run.id === runID)) return;
      const message = task.messages?.findLast(message => message.role === 'user');
      task.runs.push({ id: runID, durableId: durableID, agent: task.agent, providerInstanceId: task.providerInstanceId ?? task.agent, providerEpoch: providerEpoch(task), requestId: task.lastRequestId, messageId: message?.id ?? '', cwd: task.cwd,
        at: message?.at ?? task.updatedAt, status: task.status, mode: task.mode, interactionMode: task.interactionMode ?? 'default' });
      if (message) message.runId = runID;
    });
  }

  async before(id: string, runID: string, signal?: AbortSignal) {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    const run = task?.runs?.find(run => run.id === runID);
    if (!task || !run) return;
    const before = run.before ?? await this.checkpoints.capture(task, runID, 'before', signal);
    await this.engine.mutate(state => {
      const current = state.tasks.find(task => task.id === id); const run = current?.runs?.find(run => run.id === runID);
      if (!current || !run || current.currentRunId !== runID) return;
      if (nativeSessionActionBusy(current) || current.archivedAt || current.archiveCleanup?.status === 'pending' || current.settleCleanup?.status === 'pending') throw new Error('会话已归档或正在操作，未启动新的原生操作');
      if (run.workspacePreparation?.cancelRequestedAt) throw new Error('工作区准备已请求停止');
      recordExecution(current, run);
      Object.assign(run, { before, cwd: task.cwd, status: 'running', startedAt: run.startedAt ?? new Date().toISOString(), ...(task.model ? { model: task.model } : {}), ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) });
    });
    if (task.claudeResumeSessionAt) await this.engine.mutate(state => { const current = state.tasks.find(task => task.id === id); if (current?.currentRunId === runID) current.claudeResumePendingRun = runID; });
  }

  async finish(id: string, runID: string, status: TaskStatus, recovery?: 'uncertain' | 'completed') {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    const run = task?.runs?.find(run => run.id === runID);
    if (!task || !run) return;
    const change: Partial<TaskRun> = { status, completedAt: new Date().toISOString() };
    if (!run.turnId && task.claudeResumePendingRun === runID) await this.engine.mutate(state => { const current = state.tasks.find(task => task.id === id); if (current?.claudeResumePendingRun === runID) delete current.claudeResumePendingRun; });
    if (recovery === 'uncertain') {
      // Files changed while the service was offline cannot be attributed to the
      // interrupted run. Keep per-tool receipts rather than fabricating a diff.
      if (run.before) change.diffError = '服务曾中断，这轮执行缺少已确认的结束检查点';
    } else if (run.before) {
      let after = run.after;
      try { after ??= recovery === 'completed' ? await this.checkpoints.saved(id, runID, 'after', run.before) ?? undefined : await this.checkpoints.capture(task, runID, 'after'); }
      catch (error) { change.diffError = error instanceof Error ? error.message : '无法读取结束检查点'; }
      if (!after) {
        if (run.before.status === 'not_repository') { await this.patch(id, runID, change); return; }
        change.diffError ??= '服务曾中断，这轮执行的结束检查点尚未保存';
        await this.patch(id, runID, change); return;
      }
      change.after = after;
      if (run.before.status === 'ready' && after.status === 'ready') {
        try { change.changes = await this.checkpoints.changes(run.before, after); }
        catch (error) { change.diffError = error instanceof Error ? error.message : '无法读取整轮文件改动'; }
      } else if (run.before.status === 'unavailable' || after.status === 'unavailable') {
        change.diffError = (run.before.status === 'unavailable' ? run.before.error : undefined) ?? (after.status === 'unavailable' ? after.error : undefined) ?? '这轮执行缺少文件检查点';
      }
    }
    await this.patch(id, runID, change);
  }

  private async patch(id: string, runID: string, change: Partial<TaskRun>) {
    await this.engine.mutate(state => {
      const run = state.tasks.find(task => task.id === id)?.runs?.find(run => run.id === runID);
      if (run) Object.assign(run, change);
    });
  }

  async diff(task: WorkItem, runID: string, path: string) {
    const run = task.runs?.find(run => run.id === runID && !run.revertedAt && !run.executionExcludedAt);
    if (!run?.before || !run.after || !run.changes) throw new Error('这轮执行没有完整的文件检查点');
    return this.checkpoints.diff(run.before, run.after, run.changes, path);
  }
}
