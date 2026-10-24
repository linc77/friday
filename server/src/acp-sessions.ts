import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { acpSessionServers } from './acp-protocol.js';
import { acpMcpServer } from './acp-mcp.js';
import { NativeSessionTools } from './native-session-tools.js';
import { NativeSessionIdle } from './native-session-idle.js';
import type { AcpNativeConnection, AcpNativeLease, AcpNativeRuntime } from './acp-native.js';
import type { ExecutionRequest, NativeForkRequest, NativeForkResult, WorkItem } from './types.js';

// T3 8cd9641f ACP session/fork operates on the negotiated current head only.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export class AcpOwnedSession {
  readonly id = randomUUID();
  readonly tools = new NativeSessionTools(this.id);
  setup?: AcpRecord;
  closed = false;
  readonly idle: NativeSessionIdle;
  private endings = new Map<() => Promise<unknown>, () => boolean>();
  private closing?: Promise<void>;
  constructor(readonly owner: AcpSessions, readonly taskId: string, readonly cwd: string, public runtime: AcpNativeRuntime, readonly lease: AcpNativeLease) {
    this.idle = new NativeSessionIdle(() => owner.running.has(taskId), () => [...this.endings.values()].some(pending => pending()), () => this.close());
  }
  remember(end: () => Promise<unknown>, pending: () => boolean) { this.endings.set(end, pending); return () => { this.endings.delete(end); }; }
  close(): Promise<void> { return this.closing ??= (async () => { this.closed = true; this.tools.close(); this.idle.stop(); await this.lease.close(); await Promise.allSettled([...this.endings.keys()].map(end => end())); this.endings.clear(); this.owner.remove(this); })(); }
}

export class AcpSessions {
  private sessions = new Map<string, AcpOwnedSession>();
  private preparing = new Set<AcpOwnedSession>();
  readonly running = new Set<string>();
  private closed = false;
  constructor(readonly connection: AcpNativeConnection, private execute: (request: ExecutionRequest, session: AcpOwnedSession) => Promise<string>) {}
  has(id: string) { return this.sessions.get(id)?.closed === false; }
  remove(session: AcpOwnedSession) { if (this.sessions.get(session.taskId) === session) this.sessions.delete(session.taskId); }
  private compatible(session: AcpOwnedSession, runtime: AcpNativeRuntime, cwd: string, threadId?: string | null) { return !session.closed && session.cwd === cwd && session.runtime.account === runtime.account && session.runtime.autoApprove === runtime.autoApprove && session.runtime.clientFiles === runtime.clientFiles && session.setup?.sessionId === threadId; }
  async run(request: ExecutionRequest) {
    const id = request.task.id; if (this.closed || this.running.has(id)) throw new Error('ACP 会话仍在执行或已关闭'); this.running.add(id);
    let session: AcpOwnedSession | undefined, release: (() => void) | undefined;
    try {
      const runtime = await this.connection.runtime({ ...request.task, interactionMode: request.purpose ? 'plan' : request.task.interactionMode }), cwd = await realpath(request.task.cwd);
      if (request.task.nativeProviderAccount && request.task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条原生 ACP 会话使用的工具与账号配置');
      if (request.purpose) { runtime.clientFiles = false; runtime.autoApprove = false; }
      request.signal.throwIfAborted(); session = this.sessions.get(id);
      if (session && !this.compatible(session, runtime, cwd, request.task.threadId)) { await session.close(); session = undefined; }
      if (!session) { session = new AcpOwnedSession(this, id, cwd, runtime, await this.connection.client(runtime, cwd)); this.sessions.set(id, session); }
      else session.runtime = runtime;
      release = session.tools.select(request); return await this.execute(request, session);
    } catch (error) { await session?.close(); throw error; }
    finally { release?.(); this.running.delete(id); if (request.purpose) await session?.close(); else session?.idle.refresh(); }
  }
  async fork(request: NativeForkRequest, retain = true): Promise<NativeForkResult> {
    if (!request.headOnly || !request.task.threadId || !request.targetTaskId) throw new Error('ACP 原生分叉仅支持显式的当前会话头');
    if (this.running.has(request.task.id)) throw new Error('原生会话仍在执行，不能分叉当前会话头');
    if (request.inspectOnly && !request.candidateId) throw new Error('原生分叉回执丢失，没有候选会话 ID；不会重复创建');
    const runtime = await this.connection.runtime(request.task), cwd = await realpath(request.task.cwd);
    if (request.task.nativeProviderAccount && request.task.nativeProviderAccount !== runtime.account) throw new Error('原生分叉所属账号配置已改变');
    request.signal.throwIfAborted(); const lease = await this.connection.client(runtime, cwd), session = new AcpOwnedSession(this, request.targetTaskId, cwd, runtime, lease); let adopted = false;
    this.preparing.add(session); const abort = () => { void session.close(); }; request.signal.addEventListener('abort', abort, { once: true });
    try {
      const { client, initialized } = lease;
      if (!acpRecord(initialized.agentCapabilities?.sessionCapabilities?.fork)) throw new Error('此 ACP 工具未协商原生 session/fork');
      client.onRequest = async context => context.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : Promise.reject(new Error('分叉不执行工具或交互式请求'));
      client.onExit = () => { void session.close(); };
      if (runtime.authenticateEagerly && runtime.authMethod) await client.call(initialized.protocolGeneration === 2 ? 'auth/login' : 'authenticate', { methodId: runtime.authMethod }, 60000);
      const mcp = await session.tools.connection({ task: { ...request.task, id: request.targetTaskId }, prompt: '', signal: request.signal, update: async () => {}, createNativeTaskMcp: request.createNativeTaskMcp });
      const servers = acpSessionServers(mcp ? [await acpMcpServer(this.connection.directory, mcp, initialized.agentCapabilities?.mcpCapabilities?.http === true)] : [], initialized.protocolGeneration);
      if (request.candidateId) {
        const method = initialized.protocolGeneration === 2 || initialized.agentCapabilities?.sessionCapabilities?.resume ? 'session/resume' : initialized.agentCapabilities?.loadSession === true ? 'session/load' : undefined;
        if (!method) throw new Error('此工具不能只读核对丢失的分叉回执；不会重建');
        session.setup = await client.call(method, { sessionId: request.candidateId, cwd, mcpServers: servers });
      } else {
        await request.started(); request.signal.throwIfAborted();
        session.setup = await client.call('session/fork', { sessionId: request.task.threadId, cwd, mcpServers: servers });
        const id = session.setup.sessionId;
        if (typeof id !== 'string' || !id || id === request.task.threadId || id.length > 2000 || /[\x00-\x1f]/.test(id)) throw new Error('ACP 没有返回独立的原生分叉会话');
        await request.candidate(id);
      }
      if (!session.setup?.sessionId || request.candidateId && session.setup.sessionId !== request.candidateId) throw new Error('ACP 未确认保存的候选分叉会话');
      const turns = [...new Set([...request.expectedTurns, ...(request.run.turnId ? [request.run.turnId] : [])])];
      const result: NativeForkResult = { threadId: session.setup.sessionId, turnIds: Object.fromEntries(turns.map(id => [id, id])), headIds: {} };
      if (retain) { const prior = this.sessions.get(request.targetTaskId); if (prior) await prior.close(); this.sessions.set(request.targetTaskId, session); adopted = true; session.idle.refresh(); }
      return result;
    } finally { request.signal.removeEventListener('abort', abort); this.preparing.delete(session); if (!adopted) await session.close(); }
  }
  async stop(id: string, sessionId: string) { const session = this.sessions.get(id); if (session?.id === sessionId) await session.close(); }
  async settle(task: WorkItem) { const session = this.sessions.get(task.id); if (session && task.executionSessionId !== session.id) throw new Error('ACP 后台连接范围已改变'); await session?.close(); }
  async close() { this.closed = true; await Promise.allSettled([...new Set([...this.sessions.values(), ...this.preparing])].map(session => session.close())); }
}
