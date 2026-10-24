import type { ExecutionRequest, TaskMcpConnection } from './types.js';

/** One ephemeral MCP credential for one owned native transport. The provider
 * can retain its MCP connection, while the existing task tool service checks
 * the exact currently admitted Durable run on every call. No prompt is sent. */
export class NativeSessionTools {
  private controller = new AbortController();
  private selected?: { request: Promise<ExecutionRequest> };
  private binding?: Promise<TaskMcpConnection>;
  constructor(readonly sessionId: string) {}
  select(request: ExecutionRequest | Promise<ExecutionRequest>) {
    const selected = { request: Promise.resolve(request) };
    this.selected = selected;
    // Reserving before an unsolicited turn is persisted holds its tool calls
    // behind the same admission barrier as its output and approvals.
    void selected.request.catch(() => {});
    return () => { if (this.selected === selected) this.selected = undefined; };
  }
  async connection(request: ExecutionRequest): Promise<TaskMcpConnection | undefined> {
    this.controller.signal.throwIfAborted();
    if (!request.createNativeTaskMcp) return request.taskMcp;
    if (!this.binding) this.binding = request.createNativeTaskMcp(this.sessionId, async () => {
      const selected = this.selected;
      if (!selected) return undefined;
      const request = await selected.request;
      return this.selected === selected && !this.controller.signal.aborted ? request.task.currentRunId : undefined;
    }, this.controller.signal);
    return this.binding;
  }
  close() { this.selected = undefined; this.controller.abort(); }
}
