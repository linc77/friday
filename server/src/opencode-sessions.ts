import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { OpenCodeConnection, openCodeData } from './opencode-provider.js';
import { loadNativeProviderSettings, nativeProviderAccount } from './native-provider-config.js';
import { NativeSessionTools } from './native-session-tools.js';
import { NativeSessionIdle } from './native-session-idle.js';
import { NativeTurnObserver } from './native-turn-observer.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import type { ExecutionRequest, WorkItem } from './types.js';
import type { TaskSubagent } from './task-subagent-types.js';

// T3 8cd9641f provider-opencode v1 busy ownership and v2 automatic execution.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
type Runtime = Awaited<ReturnType<OpenCodeConnection['runtime']>>;
type Lease = Awaited<ReturnType<OpenCodeConnection['server']>>;
type Listener = { event(value: AcpRecord): void; fail(error: Error): void; done(): boolean; knows(id: string): boolean; pending(): boolean; sync(agent: TaskSubagent): void; close(): Promise<void> };
type Execute = (request: ExecutionRequest, session: OpenCodeNativeSession, nativeId?: string) => Promise<string>;
type Wake = { events: AcpRecord[]; listener?: Listener };
const sessionOf = (event: AcpRecord) => { const data = event.data ?? event.properties ?? {}; return data.sessionID ?? data.part?.sessionID ?? data.info?.sessionID ?? data.form?.sessionID ?? event.sessionID; };
const ends = new Set(['session.execution.succeeded', 'session.execution.interrupted', 'session.execution.failed', 'unreadable.execution.ended']);

export class OpenCodeNativeSession {
  readonly executionId = randomUUID();
  readonly tools = new NativeSessionTools(this.executionId);
  readonly server;
  threadId?: string;
  runtime: Runtime;
  source: ExecutionRequest;
  closed = false;
  readonly children = new Set<string>();
  nativePrompts?: Set<string>;
  private busy = new Set<string>();
  private listener?: Listener;
  private prior = new Set<Listener>();
  private observer?: NativeTurnObserver;
  private subscription?: Awaited<ReturnType<Lease['server']['subscribe']>>;
  private wakes = new Map<string, Wake>();
  private wireTarget?: string;
  private wireEnded = false;
  private expected?: string;
  private delivered = false;
  private closing?: Promise<void>;
  private idle: NativeSessionIdle;
  constructor(readonly owner: OpenCodeSessions, readonly lease: Lease, readonly cwd: string, readonly account: string, readonly policyKey: string, runtime: Runtime, request: ExecutionRequest) {
    this.server = lease.server; this.runtime = runtime; this.source = request;
    this.idle = new NativeSessionIdle(() => owner.claimed(request.task.id) || !!this.listener && !this.listener.done(), () => this.busy.size > 0 || this.wakes.size > 0 || [...this.prior, ...(this.listener ? [this.listener] : [])].some(value => value.pending()), () => this.close());
  }
  async start() { this.subscription = await this.server.subscribe(value => this.route(value), error => { void this.close(error); }); }
  bind(id: string) { if (this.threadId && this.threadId !== id) throw new Error('OpenCode 连接更换了原生会话'); this.threadId = id; this.observer ??= new NativeTurnObserver('opencode', () => this.source, this.executionId, id); }
  bindChild(id: unknown) { if (typeof id === 'string' && id && id.length < 2000) this.children.add(id); }
  listen(listener: Listener, nativeId?: string) {
    if (this.closed || this.listener && !this.listener.done()) throw new Error('OpenCode 原生回合仍在执行');
    if (this.listener?.pending()) this.prior.add(this.listener);
    this.listener = listener;
    if (nativeId) { const wake = this.wakes.get(nativeId); if (wake) { wake.listener = listener; for (const value of wake.events.splice(0)) listener.event(value); } }
    else { this.wireTarget = undefined; this.wireEnded = false; this.delivered = false; }
    this.idle.refresh();
  }
  expect(id: string) { this.expected = id; }
  private route(event: AcpRecord) {
    if (this.closed) return;
    const data = acpRecord(event.data ?? event.properties) ?? {}, id = sessionOf(event), info = this.server.generation === 1 ? data.info : data;
    const report = event.type === 'session.synthetic' ? data : event.type === 'session.inbox.enqueued' && data.item?.type === 'synthetic' ? data.item.payload : undefined;
    if (report?.metadata?.childID) { const origin = [...this.prior].find(value => value.knows(report.metadata.childID)); if (origin) { origin.event(event); return; } }
    if (event.type === 'session.created' && (info?.parentID === this.threadId || this.children.has(info?.parentID))) this.bindChild(info.id ?? info.sessionID);
    const known = id === this.threadId || typeof id === 'string' && this.children.has(id);
    if (known && typeof id === 'string') {
      if (['session.execution.started', 'unreadable.execution.started'].includes(event.type) || event.type === 'session.status' && ['busy', 'retry'].includes(data.status?.type)) this.busy.add(id);
      if (ends.has(event.type) || event.type === 'session.idle' || event.type === 'session.status' && data.status?.type === 'idle') this.busy.delete(id);
    }
    if (typeof id === 'string' && id !== this.threadId) {
      const child = [...this.prior, ...(this.listener ? [this.listener] : [])].find(value => value.knows(id));
      if (child) { child.event(event); this.idle.refresh(); return; }
    }
    if (!this.source.purpose && this.server.generation === 2 && id === this.threadId) {
      if (event.type === 'session.inbox.delivered' && data.inboxID === this.expected) this.delivered = true;
      if (['session.execution.started', 'unreadable.execution.started'].includes(event.type) && (this.wireEnded || !this.listener || this.listener.done())) this.observe();
      const wake = this.wireTarget && this.wakes.get(this.wireTarget);
      if (wake) { if (wake.listener) wake.listener.event(event); else wake.events.push(event); }
      else this.listener?.event(event);
      if (ends.has(event.type) && (wake || this.delivered)) this.wireEnded = true;
    } else this.listener?.event(event);
    for (const value of this.prior) if (!value.pending()) this.prior.delete(value);
    this.idle.refresh();
  }
  private observe() {
    const id = 'opencode-native:' + randomUUID(); this.wireTarget = id; this.wireEnded = false; this.wakes.set(id, { events: [] });
    const ready = (async () => { await this.verify(); const request = await this.observer!.open(id); await this.verify(); return request; })(), release = this.tools.select(ready);
    void (async () => {
      try { const request = await ready, result = await this.owner.execute(request, this, id); await this.observer!.finish(id, 'completed', result); }
      catch (error) { await this.observer!.finish(id, 'interrupted', undefined, error instanceof Error ? error.message : 'OpenCode 后续回复已中断').catch(() => {}); await this.close(); }
      finally { release(); this.wakes.delete(id); this.idle.refresh(); }
    })(); this.idle.refresh();
  }
  private async verify() { const settings = await loadNativeProviderSettings(this.owner.connection.directory, 'opencode'); if (!settings.enabled || nativeProviderAccount('opencode', settings) !== this.account || JSON.stringify([settings.permissionMode]) !== this.policyKey) throw new Error('OpenCode 后续回复所属账号或权限已改变'); }
  refresh() { this.idle.refresh(); }
  pending() { return this.busy.size > 0 || this.wakes.size > 0 || [...this.prior, ...(this.listener ? [this.listener] : [])].some(value => value.pending()); }
  sync(agent: TaskSubagent) { for (const listener of [...this.prior, ...(this.listener ? [this.listener] : [])]) listener.sync(agent); }
  wait(key: string, signal: AbortSignal) { if (!this.observer) throw new Error('OpenCode 后续连接不可用'); return this.observer.wait(key, signal); }
  async interrupt() {
    const ids = [...this.children, ...(this.threadId ? [this.threadId] : [])];
    for (const sessionID of ids) {
      try { if (this.server.v2) await this.server.v2.session.interrupt({ sessionID }, { signal: AbortSignal.timeout(3000) }); else await openCodeData(this.server.v1!.session.abort({ sessionID }, { signal: AbortSignal.timeout(3000) })); }
      catch (error) { if (!this.server.child) throw error; }
    }
    if (!this.server.child) {
      const active = this.server.v2 ? await this.server.v2.session.active({ signal: AbortSignal.timeout(3000) }) : await openCodeData(this.server.v1!.session.status({}, { signal: AbortSignal.timeout(3000) }));
      if (ids.some(id => this.server.v2 ? Object.hasOwn(active, id) : active[id] && active[id].type !== 'idle')) throw new Error('OpenCode 尚未确认后台会话停止');
    }
    await this.close(new Error('OpenCode 原生工作已中止'));
  }
  close(error = new Error('OpenCode 原生连接已中断')): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.tools.close(); this.idle.stop(); this.listener?.fail(error); for (const value of this.prior) value.fail(error);
      await this.subscription?.close(); if (this.server.child) await this.server.close();
      await this.observer?.close(); await Promise.allSettled([...new Set([this.listener, ...this.prior])].filter((value): value is Listener => !!value).map(value => value.close()));
      await this.lease.close(); this.owner.remove(this);
    })();
  }
}

export class OpenCodeSessions {
  private sessions = new Map<string, OpenCodeNativeSession>();
  private running = new Set<string>();
  private closed = false;
  constructor(readonly connection: OpenCodeConnection, readonly execute: Execute) {}
  claimed(id: string) { return this.running.has(id); }
  has(id: string) { return this.sessions.get(id)?.closed === false; }
  sync(id: string, agent: TaskSubagent) { this.sessions.get(id)?.sync(agent); }
  remove(session: OpenCodeNativeSession) { if (this.sessions.get(session.source.task.id) === session) this.sessions.delete(session.source.task.id); }
  async run(request: ExecutionRequest) {
    if (this.closed || this.running.has(request.task.id)) throw new Error('OpenCode 会话仍在执行或已关闭');
    this.running.add(request.task.id); let session: OpenCodeNativeSession | undefined, release: (() => void) | undefined, finalized!: () => void;
    if (!request.finalized) request = { ...request, finalized: new Promise<void>(resolve => { finalized = resolve; }) };
    try {
      const runtime = await this.connection.runtime(request.task), policyKey = JSON.stringify([runtime.settings.permissionMode]), cwd = await realpath(request.task.cwd);
      if (request.task.nativeProviderAccount && request.task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 OpenCode 会话使用的账号配置');
      request.signal.throwIfAborted(); session = this.sessions.get(request.task.id);
      if (session && (session.closed || session.account !== runtime.account || session.policyKey !== policyKey || session.cwd !== cwd || session.threadId !== request.task.threadId)) { await session.close(); session = undefined; }
      if (!session) { const lease = await this.connection.server(runtime.settings, cwd, request.task.id); session = new OpenCodeNativeSession(this, lease, cwd, runtime.account, policyKey, runtime, request); this.sessions.set(request.task.id, session); await session.start(); }
      else { session.runtime = runtime; session.source = request; }
      release = session.tools.select(request); return await this.execute(request, session);
    } catch (error) { await session?.close(error instanceof Error ? error : undefined); throw error; }
    finally { release?.(); this.running.delete(request.task.id); finalized?.(); if (request.purpose) await session?.close(); else session?.refresh(); }
  }
  async wait(id: string, sessionId: string, key: string, signal: AbortSignal) { const session = this.sessions.get(id); if (!session || session.executionId !== sessionId) throw new Error('OpenCode 后续连接不可用'); await session.wait(key, signal); }
  async stop(id: string, sessionId: string) { const session = this.sessions.get(id); if (session?.executionId === sessionId) await session.interrupt(); }
  async settle(task: WorkItem) { const session = this.sessions.get(task.id); if (session && session.executionId !== task.executionSessionId) throw new Error('OpenCode 后台连接范围已改变'); await session?.interrupt(); }
  async beforeHistory(id: string) { const session = this.sessions.get(id); if (session) { if (this.claimed(id) || session.pending()) throw new Error('OpenCode 原生会话或后台工作仍在执行'); await session.close(); } }
  async close() { this.closed = true; await Promise.allSettled([...this.sessions.values()].map(session => session.close())); }
}
