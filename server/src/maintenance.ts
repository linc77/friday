import { pendingReviewGuides } from './task-review-guides.js';
import { setTimeout as delay } from 'node:timers/promises';
import { runningFork, activeGitOperation, activeRewind, activeStatuses, type Workspace } from './types.js';
import { switchingBranch } from './branch-switch.js';
import { queueRunning } from './task-queue.js';
import { pendingTaskTitles } from './task-titles.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';

/** A short owner-held write barrier; process death or expiry releases it. */
export class ServiceMaintenance {
  private expiresAt = 0;
  private writes = 0;
  constructor(private readonly snapshot: () => Promise<Workspace>, private readonly leaseMs = 120_000) {}
  get preparing() { return this.expiresAt > Date.now(); }
  enterWrite() {
    if (this.preparing) throw new Error('Friday 正在准备更新，请稍后重试。');
    this.writes++;
    return () => { this.writes--; };
  }
  async prepare() {
    if (this.preparing) throw new Error('已有更新正在准备，请稍后重试。');
    this.expiresAt = Date.now() + this.leaseMs;
    try {
      const deadline = Date.now() + Math.min(10_000, this.leaseMs);
      while (this.writes > 0) {
        if (Date.now() >= deadline) throw new Error('仍有请求正在保存，请稍后重试更新。');
        await delay(10);
      }
      const state = await this.snapshot();
      if (Object.values(state.providerCreditResets ?? {}).some(reset => ['queued', 'running'].includes(reset.status))) throw new Error('仍有配额重置正在确认，请等待完成后更新。');
      if (Object.values(state.taskFeedbackRequests ?? {}).some(value => ['queued', 'uploading'].includes(value.status))) throw new Error('仍有反馈正在提交，请等待完成后更新。');
      if (Object.values(state.usageSourceResetRequests ?? {}).some(value => ['queued', 'running'].includes(value.status))) throw new Error('仍有来源额度重置正在确认，请等待完成后更新。');
      if (state.tasks.some(task => task.settleCleanup?.status === 'pending' || task.archiveCleanup?.status === 'pending' || task.sessionOperation?.status === 'pending')) throw new Error('仍有会话正在清理或交接，请等待完成后更新。');
      if (state.changeRequestCheckouts?.some(p => ['queued', 'running'].includes(p.status))) throw new Error('仍在准备 PR／MR 目录，请等待完成或停止后更新。');
      if (state.projectScriptTerminalsBusy || state.projectScriptRuns?.some(r => ['queued','running'].includes(r.status))) throw new Error('仍有项目脚本正在运行，请停止后更新。');
      if (pendingReviewGuides(state)) throw new Error('仍在生成审查 Guide，请等待完成或停止后更新。');
      if (pendingTaskTitles(state)) throw new Error('仍在生成任务标题，请等待完成后再安装更新。');
      if (state.tasks.some(hasRunningBackgroundCommands)) throw new Error('仍有后台命令正在运行，请先停止后再安装更新。');
      if (state.tasks.some(task => task.changeRequestOperations?.some(op => ['queued', 'running'].includes(op.status)))) throw new Error('仍有 PR／MR 操作正在发送，请等待完成后再安装更新。');
      if (state.projectRepositoryOperations?.some(operation=>operation.status==='queued'||operation.status==='running'))throw new Error('仍在克隆或发布项目，请完成或取消后再安装更新。');
      if (state.tasks.some(task => activeStatuses.includes(task.status) || queueRunning(task) || activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || runningFork(task.forkOperation) || switchingBranch(task.branchChange))) throw new Error('仍有任务正在执行或等待处理。请完成或停止任务后再安装更新。');
      if (state.tasks.some(task => task.terminals?.some(terminal => terminal.hasRunningSubprocess || ['starting', 'closing'].includes(terminal.status)))) throw new Error('终端仍有程序正在运行，请先停止后再安装更新。');
      if (!this.preparing) throw new Error('更新准备已超时，请重试。');
    } catch (error) { this.cancel(); throw error; }
  }
  cancel() { this.expiresAt = 0; }
}
