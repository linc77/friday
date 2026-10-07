import type { Executor, ExecutionRequest } from './types.js';

/** Route both task execution and its live controls to the task's persisted agent. */
export class LocalAgentExecutor implements Executor {
  private live = new Map<string, Executor>();
  constructor(private executors: Record<string, Executor>) {}
  async run(request: ExecutionRequest) {
    const executor = this.executors[request.task.agent];
    if (!executor) throw new Error('此 Agent 尚未接入任务执行。');
    this.live.set(request.task.id, executor);
    try { return await executor.run(request); }
    finally { this.live.delete(request.task.id); }
  }
  private current(id: string) {
    const executor = this.live.get(id);
    if (!executor) throw new Error('任务已结束，请继续会话后再操作。');
    return executor;
  }
  async answer(id: string, approvalId: string, decision: 'accept' | 'decline', answers: Record<string, string[]>) { await this.current(id).answer(id, approvalId, decision, answers); }
  async steer(id: string, text: string, requestId: string) { await this.current(id).steer(id, text, requestId); }
}
