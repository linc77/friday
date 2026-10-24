import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { PiConnection, loadPiSettings, piSessionAccount } from './pi-provider.js';
import type { PiRpc, PiRecord } from './pi-rpc.js';
import type { ExecutionRequest, WorkItem } from './types.js';
import { NativeSessionTools } from './native-session-tools.js';
import { NativeSessionIdle, type NativeSessionIdlePolicy } from './native-session-idle.js';
import { NativeTurnObserver } from './native-turn-observer.js';

// Native lifecycle semantics follow T3 8cd9641f provider-pi/adapter and
// ProviderSessionManager. MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export type PiRuntime = Awaited<ReturnType<PiConnection['runtime']>>;
type Listener = { event(value: PiRecord): void; exit(error: Error): void; done(): boolean };
type Execute = (request: ExecutionRequest, session: PiNativeSession, observed: boolean) => Promise<string>;

/** An owned RPC transport. The existing execution task owns foreground work;
 * NativeTurnObserver uses Pi Durable to record provider-started work. */
export class PiNativeSession {
  readonly executionId = randomUUID();
  readonly tools = new NativeSessionTools(this.executionId);
  rpc!: PiRpc;
  threadId?: string;
  nativeHead: string | null | undefined;
  closed = false;
  runtime: PiRuntime;
  source: ExecutionRequest;
  private observer?: NativeTurnObserver;
  private listener?: Listener;
  private startup: PiRecord[] = [];
  private waiting?: { events: PiRecord[] };
  private observations = new Set<Promise<void>>();
  private endings = new Set<() => Promise<unknown>>();
  private closing?: Promise<void>;
  private idle: NativeSessionIdle;
  constructor(readonly owner: PiSessions, readonly cwd: string, readonly account: string, readonly policyKey: string, runtime: PiRuntime, source: ExecutionRequest) {
    this.runtime = runtime; this.source = source;
    this.idle = new NativeSessionIdle(() => owner.claimed(source.task.id) || !!this.listener && !this.listener.done(), () => this.observing, () => this.close(), owner.idlePolicy);
  }
  get observing() { return this.observations.size > 0 || !!this.waiting; }
  async start() {
    const extension = await this.owner.connection.extension(), mcp = await this.tools.connection(this.source);
    this.source.signal.throwIfAborted(); if (this.closed) throw new Error('Pi 原生连接已关闭');
    const token = mcp?.headers.Authorization?.match(/^Bearer (.+)$/i)?.[1];
    this.rpc = this.owner.connection.client(this.runtime, this.cwd, false, extension, { FRIDAY_MCP_URL: mcp?.url, FRIDAY_MCP_BEARER_TOKEN: token, FRIDAY_PI_MCP_EXTENSION_PATH: extension,
      FRIDAY_PI_RUNTIME_MODE: this.runtime.permissionMode === 'auto' ? 'full-access' : this.runtime.permissionMode === 'acceptEdits' ? 'auto-accept-edits' : 'approval-required' });
    this.rpc.onEvent = value => this.receive(value);
    this.rpc.onExit = error => { this.listener?.exit(error); void this.close(error); };
  }
  adopt(threadId: string) {
    if (this.threadId && this.threadId !== threadId) throw new Error('Pi 原生连接更换了会话文件');
    this.threadId = threadId;
    this.observer ??= new NativeTurnObserver('pi', () => this.source, this.executionId, threadId);
  }
  listen(listener: Listener) {
    if (this.closed || this.listener && !this.listener.done()) throw new Error('Pi 原生回合仍在执行');
    this.listener = listener;
    const buffered = this.waiting?.events ?? this.startup; this.waiting = undefined; this.startup = [];
    for (const event of buffered) listener.event(event);
    this.idle.refresh();
    return () => { if (this.listener === listener) this.listener = undefined; this.idle.refresh(); };
  }
  remember(end: () => Promise<unknown>) { this.endings.add(end); return () => { this.endings.delete(end); }; }
  private receive(value: PiRecord) {
    if (this.closed) return;
    if (this.listener && !this.listener.done()) { this.listener.event(value); return; }
    if (this.waiting) { this.waiting.events.push(value); return; }
    if (value.type === 'agent_start' && this.observer) { this.observe(value); return; }
    if (!this.threadId) this.startup.push(value);
  }
  private observe(first: PiRecord) {
    this.waiting = { events: [first] };
    const nativeId = 'pi-native:' + randomUUID();
    const ready = (async () => {
      const request = await this.observer!.open(nativeId, async () => {
        const settings = await loadPiSettings(this.owner.connection.directory);
        if (!settings.enabled || piSessionAccount(settings) !== this.account || settings.permissionMode !== this.runtime.permissionMode) throw new Error('Pi 后续回复所属账号或权限配置已改变');
      });
      const current = await loadPiSettings(this.owner.connection.directory);
      if (!current.enabled || piSessionAccount(current) !== this.account || current.permissionMode !== this.runtime.permissionMode) throw new Error('Pi 后续回复所属账号或权限配置已改变');
      return request;
    })();
    const releaseTools = this.tools.select(ready);
    let work!: Promise<void>;
    work = (async () => {
      try {
        const request = await ready;
        const result = await this.owner.execute(request, this, true);
        await this.observer!.finish(nativeId, 'completed', result);
      } catch (error) {
        await this.observer!.finish(nativeId, 'interrupted', undefined, error instanceof Error ? error.message : 'Pi 原生后续回复已中断').catch(() => {});
        await this.close(error instanceof Error ? error : new Error('Pi 原生后续回复已中断'));
      } finally { releaseTools(); this.observations.delete(work); this.idle.refresh(); }
    })();
    this.observations.add(work); this.idle.refresh();
  }
  refresh() { this.idle.refresh(); }
  has(key: string) { return this.observer?.has(key) === true; }
  async wait(key: string, signal: AbortSignal) { if (!this.observer) throw new Error('Pi 原生后续连接不可用'); await this.observer.wait(key, signal); }
  async interrupt(key: string) {
    if (!this.observer?.has(key)) return;
    await this.close(new Error('Pi 原生后续回复已中止'));
  }
  close(error = new Error('Pi 原生连接已中断')): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.tools.close(); this.idle.stop(); this.listener?.exit(error); this.listener = undefined; this.waiting = undefined; this.startup = [];
      if (this.rpc) await this.owner.connection.release(this.rpc);
      await this.observer?.close();
      await Promise.allSettled([...this.endings].map(end => end())); this.endings.clear(); this.owner.remove(this);
    })();
  }
}

export class PiSessions {
  private sessions = new Map<string, PiNativeSession>();
  private running = new Set<string>();
  private closed = false;
  constructor(readonly connection: PiConnection, readonly execute: Execute, readonly idlePolicy: NativeSessionIdlePolicy = {}) {}
  claimed(id: string) { return this.running.has(id); }
  has(id: string) { return this.sessions.get(id)?.closed === false; }
  remove(session: PiNativeSession) { if (this.sessions.get(session.source.task.id) === session) this.sessions.delete(session.source.task.id); }
  async run(request: ExecutionRequest) {
    if (this.closed || this.running.has(request.task.id)) throw new Error('Pi 会话仍在执行或已关闭');
    this.running.add(request.task.id); let session: PiNativeSession | undefined, releaseTools: (() => void) | undefined;
    try {
      if (request.task.interactionMode === 'plan') throw new Error('Pi 未提供原生计划模式，请使用默认模式');
      const runtime = await this.connection.runtime(request.task), account = piSessionAccount(runtime.settings), policyKey = JSON.stringify([account, runtime.permissionMode]);
      if (request.task.piHome && request.task.piHome !== runtime.home || request.task.nativeProviderAccount && request.task.nativeProviderAccount !== account) throw new Error('请恢复这条 Pi 会话使用的配置目录与账号');
      request.signal.throwIfAborted(); const cwd = await realpath(request.task.cwd);
      request = { ...request, task: { ...request.task, piHome: runtime.home, nativeProviderAccount: account, model: runtime.model, reasoningEffort: runtime.effort } };
      session = this.sessions.get(request.task.id);
      if (session?.observing) throw new Error('Pi 原生后续轮次仍在执行，请补充到当前轮次或等待完成');
      if (session && (session.closed || session.account !== account || session.policyKey !== policyKey || session.cwd !== cwd || session.threadId !== request.task.threadId)) { await session.close(); session = undefined; }
      if (!session) { session = new PiNativeSession(this, cwd, account, policyKey, runtime, request); this.sessions.set(request.task.id, session); releaseTools = session.tools.select(request); await session.start(); }
      else { session.source = request; session.runtime = runtime; releaseTools = session.tools.select(request); }
      request.signal.throwIfAborted(); return await this.execute(request, session, false);
    } catch (error) { if (session && !session.observing) await session.close(error instanceof Error ? error : undefined); throw error; }
    finally { releaseTools?.(); this.running.delete(request.task.id); this.sessions.get(request.task.id)?.refresh(); }
  }
  async wait(id: string, sessionId: string, key: string, signal: AbortSignal) { const session = this.sessions.get(id); if (!session || session.executionId !== sessionId) throw new Error('Pi 原生后续连接不可用'); await session.wait(key, signal); }
  async interrupt(id: string, sessionId: string, key: string) { const session = this.sessions.get(id); if (session?.executionId === sessionId) await session.interrupt(key); }
  async stop(id: string, sessionId?: string) { const session = this.sessions.get(id); if (session && (!sessionId || session.executionId === sessionId)) await session.close(); }
  async settle(task: WorkItem) { const session = this.sessions.get(task.id); if (session && session.executionId !== task.executionSessionId) throw new Error('Pi 后台连接范围已改变'); await session?.close(); }
  async beforeHistory(id: string, threadId: string | null | undefined) { const session = this.sessions.get(id); if (!session) return; if (this.claimed(id) || session.observing || session.threadId !== threadId) throw new Error('Pi 原生会话仍在执行或范围已改变'); await session.close(); }
  async close() { if (this.closed) return; this.closed = true; await Promise.allSettled([...this.sessions.values()].map(session => session.close())); }
}
