import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpProcess, acpRecord, type AcpRecord } from './acp-process.js';
import { GrokConnection, loadGrokSettings, grokSessionAccount } from './grok-provider.js';
import { NativeSessionTools } from './native-session-tools.js';
import { NativeSessionIdle, type NativeSessionIdlePolicy } from './native-session-idle.js';
import { NativeTurnObserver } from './native-turn-observer.js';
import type { ProviderBackgroundTask } from './native-runtime-types.js';
import type { ExecutionRequest, WorkItem } from './types.js';
import { extractXAiMonitorTaskId, isXAiPersistentMonitor, extractXAiBackgroundTaskCompletion, extractXAiKilledBackgroundTasks, extractXAiAcpBackgroundToolMutation, xAiBackgroundTaskLifecycleMutation, type GrokSubagentTool } from './vendor/t3-grok-subagents.mjs';

// Lifecycle and pure wire parsers follow T3 8cd9641f provider-grok and provider-acp.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export type GrokRuntime = Awaited<ReturnType<GrokConnection['runtime']>>;
type Listener = { notification(method: string, value: AcpRecord): void; request: NonNullable<AcpProcess['onRequest']>; exit(error: Error): void; done(): boolean; knows(id: string): boolean; pending(): boolean; close(): Promise<void> };
type Execute = (request: ExecutionRequest, session: GrokNativeSession, nativeId?: string) => Promise<string>;
const ended = (work: ProviderBackgroundTask) => ['completed', 'failed', 'stopped', 'interrupted'].includes(work.status);
const childId = (params: AcpRecord, root?: string) => params._meta?.childSessionId ?? params._meta?.child_session_id ?? params.update?.child_session_id ?? (root && params.sessionId && params.sessionId !== root ? params.sessionId : undefined);
const promptId = (params: AcpRecord) => params._meta?.promptId ?? params._meta?.requestId ?? params.update?._meta?.promptId ?? params.update?.prompt_id ?? params.update?.promptId ?? params.promptId;

export class GrokNativeSession {
  readonly executionId = randomUUID();
  readonly tools = new NativeSessionTools(this.executionId);
  readonly client: AcpProcess;
  initialized?: Awaited<ReturnType<GrokConnection['initialize']>>;
  setup?: AcpRecord;
  threadId?: string;
  source: ExecutionRequest;
  runtime: GrokRuntime;
  closed = false;
  private observer?: NativeTurnObserver;
  private listener?: Listener;
  private children = new Set<Listener>();
  private observing = new Map<string, { events: [string, AcpRecord][]; admitted: Promise<void>; admit(): void }>();
  private background = new Map<string, ProviderBackgroundTask>();
  private idle: NativeSessionIdle;
  private closing?: Promise<void>;
  constructor(readonly owner: GrokSessions, readonly cwd: string, readonly account: string, readonly policyKey: string, runtime: GrokRuntime, source: ExecutionRequest) {
    this.runtime = runtime; this.source = source;
    this.client = owner.connection.client(source.purpose ? { ...runtime, permissionMode: 'default', env: { ...runtime.env, GROK_DISABLE_AUTOUPDATER: '1' } } : runtime, cwd);
    this.client.onNotification = (method, value) => { const params = acpRecord(value); if (params) this.route(method, params); };
    this.client.onRequest = async request => {
      const params = acpRecord(request.params) ?? {}, unwrapped = acpRecord(params.params) ?? params, native = childId(unwrapped, this.threadId);
      const id = promptId(unwrapped), observation = typeof id === 'string' ? this.observing.get(id) : undefined;
      if (observation) await observation.admitted;
      const listener = typeof native === 'string' ? [...this.children, ...(this.listener ? [this.listener] : [])].find(value => value.knows(native)) ?? this.listener : this.listener;
      if (!listener || this.closed) throw RequestError.requestCancelled(); return listener.request(request);
    };
    this.client.onExit = error => { void this.close(error); };
    this.idle = new NativeSessionIdle(() => owner.claimed(source.task.id) || !!this.listener && !this.listener.done(), () => this.hasBackground() || this.observing.size > 0 || [...this.children].some(child => child.pending()), () => this.close(), owner.idlePolicy);
  }
  bind(id: string) {
    if (this.threadId && this.threadId !== id) throw new Error('Grok 原生连接更换了会话');
    this.threadId = id; this.observer ??= new NativeTurnObserver('grok', () => this.source, this.executionId, id);
  }
  listen(listener: Listener, nativeId?: string) {
    if (this.closed || this.listener && !this.listener.done()) throw new Error('Grok 原生回合仍在执行');
    if (this.listener?.pending()) this.children.add(this.listener);
    this.listener = listener;
    if (nativeId) { const buffered = this.observing.get(nativeId); for (const [method, value] of buffered?.events ?? []) listener.notification(method, value); if (buffered) { buffered.events = []; buffered.admit(); } }
    this.idle.refresh();
  }
  private route(method: string, params: AcpRecord) {
    if (this.closed) return;
    const native = childId(params, this.threadId);
    if (typeof native === 'string') {
      const child = [...this.children, ...(this.listener ? [this.listener] : [])].find(value => value.knows(native));
      if (child) { child.notification(method, params); return; }
    }
    const id = promptId(params);
    if (!this.source.purpose && params.sessionId === this.threadId && typeof id === 'string' && /^(task|subagent)-completed-/.test(id)) {
      if (!this.observing.has(id) && this.listener && !this.listener.done() && this.background.size === 0 && !id.startsWith('subagent-completed-')) return;
      if (this.observing.has(id)) {
        if (this.listener && !this.listener.done() && this.activeNativeId === id) this.listener.notification(method, params);
        else this.observing.get(id)!.events.push([method, params]);
      } else if (method === 'session/update' && ['agent_message_chunk', 'agent_message', 'agent_thought_chunk', 'agent_thought', 'tool_call', 'tool_call_update'].includes(params.update?.sessionUpdate)) this.observe(id, method, params);
      return;
    }
    this.listener?.notification(method, params);
    for (const child of this.children) if (!child.pending()) this.children.delete(child);
  }
  private activeNativeId?: string;
  private observe(id: string, method: string, params: AcpRecord) {
    let admit!: () => void; const admitted = new Promise<void>(resolve => { admit = resolve; });
    this.observing.set(id, { events: [[method, params]], admitted, admit });
    const ready = (async () => {
      await this.verify(); const request = await this.observer!.open(id); await this.verify(); return request;
    })();
    const release = this.tools.select(ready);
    void (async () => {
      try { const request = await ready; this.activeNativeId = id; const result = await this.owner.execute(request, this, id); await this.observer!.finish(id, 'completed', result); }
      catch (error) { await this.observer!.finish(id, 'interrupted', undefined, error instanceof Error ? error.message : 'Grok 后续回复已中断').catch(() => {}); await this.close(); }
      finally { if (this.activeNativeId === id) this.activeNativeId = undefined; release(); this.observing.delete(id); this.idle.refresh(); }
    })();
    this.idle.refresh();
  }
  private async verify() {
    const settings = await loadGrokSettings(this.owner.connection.directory);
    if (!settings.enabled || grokSessionAccount(settings) !== this.account || settings.permissionMode !== this.runtime.permissionMode) throw new Error('Grok 后续回复所属账号或权限已改变');
  }
  hasBackground() { return [...this.background.values()].some(work => !ended(work)); }
  holds(runId?: string) { return [...this.background.values()].some(work => !ended(work) && work.holdsCompletion && work.origin?.runId === runId); }
  async notice(method: string, params: AcpRecord) {
    if (params.sessionId !== this.threadId || !/^_?x\.ai\/task_(backgrounded|completed)$/.test(method)) return;
    const value = xAiBackgroundTaskLifecycleMutation(params, method.endsWith('completed') ? 'completed' : 'running'); if (!value) return;
    await this.change(value.taskId, value.status, value.output, false, value.report?.kind, value.report?.label);
  }
  async tool(tool: GrokSubagentTool, request: ExecutionRequest, turnId: string) {
    const id = extractXAiMonitorTaskId(tool);
    if (id) await this.change(id, 'running', undefined, false, acpRecord(tool.data.rawOutput)?.type === 'BackgroundTaskStarted' ? 'command' : 'monitor', tool.title, request, turnId, tool.toolCallId, !isXAiPersistentMonitor(tool));
    for (const value of [...extractXAiBackgroundTaskCompletion(tool), ...extractXAiKilledBackgroundTasks(tool)]) await this.change(value.taskId, value.status, value.appendOutput, true);
  }
  async text(value: string) { for (const mutation of extractXAiAcpBackgroundToolMutation(value)) await this.change(mutation.taskId, mutation.status, mutation.appendOutput, true); }
  private async change(id: string, status: 'running' | 'completed' | 'failed', output?: string, append = false, kind?: 'command' | 'monitor', description?: string, request = this.source, turnId?: string, toolUseId?: string, holdsCompletion = true) {
    if (!id || id.length > 512 || /[\x00-\x1f]/.test(id) || !this.threadId || request.purpose) return;
    const previous = this.background.get(id); if (previous && ended(previous) && status === 'running') return;
    const at = new Date().toISOString(), text = output === undefined ? previous?.output?.text : (append ? previous?.output?.text ?? '' : '') + output;
    const work: ProviderBackgroundTask = { id: previous?.id ?? `grok-background:${this.executionId}:${id}`, provider: 'grok', sessionId: this.threadId, transportId: this.executionId, taskId: id, generation: 0, kind: kind ?? previous?.kind ?? 'background_task', status, member: true, backgrounded: true, ambient: false, canStop: false,
      description: description ?? previous?.description ?? 'Grok background task', startedAt: previous?.startedAt ?? at, updatedAt: at, holdsCompletion: toolUseId ? holdsCompletion : previous?.holdsCompletion ?? holdsCompletion,
      ...(previous?.origin ? { origin: previous.origin } : request.task.currentRunId && turnId ? { origin: { runId: request.task.currentRunId, turnId, eventId: `${turnId}:tool:${toolUseId}` } } : {}), ...(toolUseId ? { toolUseId } : previous?.toolUseId ? { toolUseId: previous.toolUseId } : {}),
      ...(text !== undefined ? { output: { text: text.slice(-100_000), truncated: text.length > 100_000 || previous?.output?.truncated === true } } : {}), ...(['completed', 'failed'].includes(status) ? { completedAt: at } : {}) };
    this.background.set(id, work); await this.publish(); this.idle.refresh();
  }
  private async publish() { if (this.threadId) await this.source.update({ kind: 'nativeBackground', provider: 'grok', providerInstanceId: this.source.task.providerInstanceId ?? 'grok', threadId: this.threadId, sessionId: this.executionId, tasks: [...this.background.values()], connected: !this.closed }); }
  refresh() { this.idle.refresh(); }
  wait(key: string, signal: AbortSignal) { if (!this.observer) throw new Error('Grok 后续连接不可用'); return this.observer.wait(key, signal); }
  async close(error = new Error('Grok 原生连接已中断')): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.tools.close(); this.idle.stop(); this.listener?.exit(error); for (const child of this.children) child.exit(error);
      for (const observation of this.observing.values()) observation.admit();
      await this.owner.connection.release(this.client); await this.observer?.close();
      await Promise.allSettled([...new Set([this.listener, ...this.children])].filter((value): value is Listener => !!value).map(value => value.close())); this.children.clear();
      for (const work of this.background.values()) if (!ended(work)) { work.status = 'interrupted'; work.member = false; work.updatedAt = work.completedAt = new Date().toISOString(); }
      await this.publish().catch(() => {}); this.owner.remove(this);
    })();
  }
}

export class GrokSessions {
  private sessions = new Map<string, GrokNativeSession>();
  private running = new Set<string>();
  private closed = false;
  constructor(readonly connection: GrokConnection, readonly execute: Execute, readonly idlePolicy: NativeSessionIdlePolicy = {}) {}
  claimed(id: string) { return this.running.has(id); }
  has(id: string) { return this.sessions.get(id)?.closed === false; }
  remove(session: GrokNativeSession) { if (this.sessions.get(session.source.task.id) === session) this.sessions.delete(session.source.task.id); }
  async run(request: ExecutionRequest) {
    if (this.closed || this.running.has(request.task.id)) throw new Error('Grok 会话仍在执行或已关闭');
    this.running.add(request.task.id); let session: GrokNativeSession | undefined, release: (() => void) | undefined, finalized!: () => void;
    if (!request.finalized) request = { ...request, finalized: new Promise<void>(resolve => { finalized = resolve; }) };
    try {
      const runtime = await this.connection.runtime(request.task), account = grokSessionAccount(runtime.settings), policyKey = JSON.stringify([account, runtime.permissionMode]), cwd = await realpath(request.task.cwd);
      if (request.task.grokHome && request.task.grokHome !== runtime.home || request.task.nativeProviderAccount && request.task.nativeProviderAccount !== account) throw new Error('请恢复这条 Grok 会话使用的账号配置目录');
      request.signal.throwIfAborted(); session = this.sessions.get(request.task.id);
      if (session && (session.closed || session.account !== account || session.policyKey !== policyKey || session.cwd !== cwd || session.threadId !== request.task.threadId)) { await session.close(); session = undefined; }
      if (!session) { session = new GrokNativeSession(this, cwd, account, policyKey, runtime, request); this.sessions.set(request.task.id, session); }
      else { session.runtime = runtime; session.source = request; }
      release = session.tools.select(request); return await this.execute(request, session);
    } catch (error) { await session?.close(error instanceof Error ? error : undefined); throw error; }
    finally { release?.(); this.running.delete(request.task.id); finalized?.(); if (request.purpose) await session?.close(); else session?.refresh(); }
  }
  async wait(id: string, sessionId: string, key: string, signal: AbortSignal) { const session = this.sessions.get(id); if (!session || session.executionId !== sessionId) throw new Error('Grok 后续连接不可用'); await session.wait(key, signal); }
  async stop(id: string, sessionId: string) { const session = this.sessions.get(id); if (session?.executionId === sessionId) await session.close(); }
  async settle(task: WorkItem) { const session = this.sessions.get(task.id); if (session && task.executionSessionId !== session.executionId) throw new Error('Grok 后台连接范围已改变'); await session?.close(); }
  async close() { this.closed = true; await Promise.allSettled([...this.sessions.values()].map(session => session.close())); }
}
