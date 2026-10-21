import type { Executor, ExecutionRequest, ExecutionImage, NativeRewindRequest, NativeForkRequest, TextGenerationRequest } from './types.js';
import type { TaskBackgroundCommand } from './task-background-commands.js';

/** Route both task execution and its live controls to the task's persisted agent. */
export class LocalAgentExecutor implements Executor {
  private live = new Map<string, Executor>();
  private retained = new Map<string, Executor>();
  constructor(private executors: Record<string, Executor>) {}
  supportsTaskTools(agent: string) { return this.executors[agent]?.supportsTaskTools?.(agent) === true; }
  async uploadFeedback(task: import('./types.js').WorkItem, reason: string | undefined, signal: AbortSignal) {
    const executor = this.executors[task.agent]; if (!executor?.uploadFeedback) throw new Error('此 Agent 不支持提交反馈');
    return executor.uploadFeedback(task, reason, signal);
  }
  deferredStart(agent: string) { return this.executors[agent]?.deferredStart?.(agent) === true; }
  async run(request: ExecutionRequest) {
    const executor = this.executors[request.task.agent];
    if (!executor) throw new Error('此 Agent 尚未接入任务执行。');
    this.live.set(request.task.id, executor);
    try { return await executor.run(request); }
    finally {
      this.live.delete(request.task.id);
      if (executor.hasSession?.(request.task.id)) this.retained.set(request.task.id, executor); else this.retained.delete(request.task.id);
    }
  }
  async generateText(request: TextGenerationRequest) {
    const executor = this.executors[request.task.agent];
    if (!executor?.generateText) throw new Error('此 Agent 尚未支持文字生成');
    return executor.generateText(request);
  }
  private current(id: string) {
    const executor = this.live.get(id) ?? (this.retained.get(id)?.hasSession?.(id) ? this.retained.get(id) : undefined);
    if (!executor) throw new Error('任务已结束，请继续会话后再操作。');
    return executor;
  }
  async answer(id: string, approvalId: string, decision: import('./provider-approvals.js').ApprovalDecision, answers: Record<string, string[]>) { await this.current(id).answer(id, approvalId, decision, answers); }
  async steer(id: string, text: string, requestId: string, images?: ExecutionImage[]) { await this.current(id).steer(id, text, requestId, images); }
  async rewind(request: NativeRewindRequest) {
    if (this.live.has(request.task.id)) throw new Error('会话仍在执行，请先停止后回退');
    const executor = this.executors[request.task.agent];
    if (!executor?.rewind) throw new Error('此 Agent 尚未支持原生历史回退');
    return executor.rewind(request);
  }
  async fork(request: NativeForkRequest) {
    const executor = this.executors[request.task.agent];
    if (!executor?.fork) throw new Error('此 Agent 尚未支持原生历史分叉');
    return executor.fork(request);
  }
  async stopBackgroundCommand(task: import('./types.js').WorkItem, command: TaskBackgroundCommand) {
    const executor = this.executors[task.agent];
    if (!executor?.stopBackgroundCommand) throw new Error('此 Agent 不支持停止后台命令');
    await executor.stopBackgroundCommand(task, command);
  }
  async close() { await Promise.all(Object.values(this.executors).map(executor => executor.close?.())); }
  async readSubagentHistory(task: import('./types.js').WorkItem, parentThreadId: string, signal: AbortSignal) {
    const executor = this.executors[task.agent]; if (!executor?.readSubagentHistory) throw new Error('此 Agent 不支持读取原生子会话历史');
    return executor.readSubagentHistory(task, parentThreadId, signal);
  }
  async syncSubagentHistory(task: import('./types.js').WorkItem, snapshot: import('./codex-history.js').CodexHistorySnapshot, apply: (connected: boolean) => Promise<import('./codex-history.js').SubagentHistoryProjection | undefined>) {
    const executor = this.executors[task.agent]; if (executor?.syncSubagentHistory) await executor.syncSubagentHistory(task, snapshot, apply); else await apply(false);
  }
  hasSession(id: string) { return this.live.get(id)?.hasSession?.(id) === true || this.retained.get(id)?.hasSession?.(id) === true; }
  async waitNativeTurn(id: string, sessionId: string, key: string, signal: AbortSignal) {
    const executor = this.current(id); if (!executor.waitNativeTurn) throw new Error('此 Agent 不支持观察原生后续回复');
    await executor.waitNativeTurn(id, sessionId, key, signal);
  }
  async stopNativeSession(id: string, sessionId: string) {
    const executor = this.live.get(id) ?? this.retained.get(id); await executor?.stopNativeSession?.(id, sessionId);
  }
  async interruptNativeTurn(id: string, sessionId: string, key: string) {
    const executor = this.live.get(id) ?? this.retained.get(id); await executor?.interruptNativeTurn?.(id, sessionId, key);
  }
  async interruptExecution(task: import('./types.js').WorkItem, runId: string) { await this.executors[task.agent]?.interruptExecution?.(task, runId); }
  async settleNativeBackground(task: import('./types.js').WorkItem) {
    const executor = this.executors[task.agent]; if (!executor?.settleNativeBackground) throw new Error('此 Agent 不支持停止后台会话');
    await executor.settleNativeBackground(task);
  }
  async stopNativeBackground(task: import('./types.js').WorkItem, work: import('./native-runtime-types.js').NativeBackgroundWork) {
    const executor = this.executors[task.agent]; if (!executor?.stopNativeBackground) throw new Error('此 Agent 不支持停止原生后台任务');
    await executor.stopNativeBackground(task, work);
  }
  async stopSubagent(task: import('./types.js').WorkItem, agent: import('./task-subagent-types.js').TaskSubagent, signal: AbortSignal) {
    const executor = this.executors[task.agent]; if (!executor?.stopSubagent) throw new Error('此 Agent 不支持单独停止子线程');
    await executor.stopSubagent(task, agent, signal);
  }
}
