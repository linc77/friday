// Native MSP lifecycle and workflow semantics follow T3 Code 8cd9641f
// packages/provider-muse/src/server/{adapter,protocol}.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { MuseConnection, type MuseProcess } from './muse-provider.js';
import { loadNativeProviderSettings, nativeProviderAccount } from './native-provider-config.js';
import { NativeTurnProjection } from './native-turn-projection.js';
import { NativeSubagentProjection } from './native-subagent-projection.js';
import { NativeTurnObserver } from './native-turn-observer.js';
import { NativeSessionTools } from './native-session-tools.js';
import { NativeSessionIdle, type NativeSessionIdlePolicy } from './native-session-idle.js';
import { taskPlanSteps } from './task-event-data.js';
import { museApprovalChoices, museQuestionAnswers } from './muse-interactions.js';
import type { Approval, ExecutionImage, ExecutionRequest, WorkItem } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';
import type { ProviderBackgroundTask } from './native-runtime-types.js';

type Runtime = Awaited<ReturnType<MuseConnection['runtime']>>;
type Ready = { request: ExecutionRequest; projection: NativeTurnProjection; children: NativeSubagentProjection };
type Context = {
  id: string; foreground: boolean; compact: boolean; ready: Promise<Ready>; chain: Promise<void>; items: Map<string, AcpRecord>;
  nativeIds: Set<string>; pendingNativeIds: Set<string>; wirePendingIds: Set<string>; admitted: boolean; terminal?: AcpRecord; finished: boolean; done: Promise<AcpRecord>;
  resolve(value: AcpRecord): void; reject(error: Error): void; releaseTools(): void; steers: Map<string, { body: string; result: Promise<void> }>;
};
type Pending = { context: Context; approval: Approval; value: AcpRecord; kind: 'approval' | 'question'; child?: string; responding: boolean; command?: { body: string; id: string } };
const stamp = () => new Date().toISOString();
const cancelled = () => new Error('任务已中止');
const nativeStatus = (value: unknown) => value === 'inProgress' ? 'running' as const : value === 'pending' ? 'waiting' as const : value === 'completed' ? 'completed' as const : value === 'cancelled' ? 'interrupted' as const : 'failed' as const;

/** A native MSP transport and its projections. Pi Durable owns all user runs
 * and observes unsolicited provider turns through NativeTurnObserver. */
class MuseSession {
  readonly executionId = randomUUID();
  private nativeTools = new NativeSessionTools(this.executionId);
  readonly pending = new Map<string, Pending>();
  readonly contexts = new Map<string, Context>();
  private childOwners = new Map<string, Context>();
  private background = new Map<string, ProviderBackgroundTask>();
  private foreground?: Context;
  private latestNative?: Context;
  private idle: NativeSessionIdle;
  private closing?: Promise<void>;
  closed = false;
  latest: ExecutionRequest;
  readonly observer: NativeTurnObserver;
  constructor(readonly owner: MuseSessions, readonly client: MuseProcess, public runtime: Runtime, readonly cwd: string, readonly threadId: string, source: ExecutionRequest, readonly ephemeral: boolean) {
    this.latest = source;
    this.idle = new NativeSessionIdle(() => owner.claimed(this.latest.task.id) || !!(this.foreground && !this.foreground.finished || this.latestNative && !this.latestNative.finished), () => this.hasPending(), () => this.close(), owner.idlePolicy);
    this.observer = new NativeTurnObserver('muse', () => this.latest, this.executionId, threadId);
    client.onNotification = (method, value) => this.route(method, value);
    client.onFailure = error => { void this.close(error); };
  }
  private context(id: string, request: Promise<ExecutionRequest>, foreground: boolean, compact = false): Context {
    let resolve!: Context['resolve'], reject!: Context['reject'];
    const done = new Promise<AcpRecord>((yes, no) => { resolve = yes; reject = no; }); void done.catch(() => {});
    const context: Context = { id, foreground, compact, ready: undefined!, chain: Promise.resolve(), items: new Map(), nativeIds: new Set([id]), pendingNativeIds: new Set([id]), wirePendingIds: new Set([id]), admitted: !foreground, finished: false, done, resolve, reject, releaseTools: this.nativeTools.select(request), steers: new Map() };
    context.ready = request.then(async request => {
      if (this.closed) throw new Error('Muse 原生连接已关闭');
      const projectionRequest: ExecutionRequest = { ...request, update: async update => {
        if (update.kind === 'item' && context.finished && context.items.get(update.item.itemId ?? '')?.kind === 'workflow' && request.task.currentRunId) {
          await this.latest.update({ kind: 'nativeBackgroundItem', provider: 'muse', providerInstanceId: request.task.providerInstanceId ?? 'muse', sessionId: this.executionId, threadId: this.threadId, runId: request.task.currentRunId, item: update.item });
        } else await request.update(update);
      } };
      const value = { request, projection: new NativeTurnProjection(projectionRequest, id), children: new NativeSubagentProjection(request, 'muse', this.executionId, this.threadId, id) };
      if (!foreground) await request.update({ kind: 'ready', canSteer: true });
      return value;
    });
    void context.ready.catch(error => { void this.fail(context, error instanceof Error ? error : new Error('Muse 原生范围已失效')); });
    this.contexts.set(id, context); return context;
  }
  private push(context: Context, method: string, value: AcpRecord) {
    context.chain = context.chain.then(() => this.apply(context, method, value)).catch(error => this.fail(context, error instanceof Error ? error : new Error('Muse 原生更新失败')));
  }
  private route(method: string, value: AcpRecord) {
    if (this.closed || value.sessionId !== this.threadId) return;
    if (method === 'view/gap') { void this.close(new Error('Muse 原生事件流出现缺口；未重发任何输入')); return; }
    const item = acpRecord(value.item), nativeId = typeof value.turnId === 'string' ? value.turnId : typeof item?.turnId === 'string' ? item.turnId : undefined;
    let context = nativeId ? this.contexts.get(nativeId) : undefined;
    const origin = acpRecord(value.subagentOrigin);
    if (origin) context = this.childOwners.get(origin.subagentId) ?? this.childOwners.get(origin.childSessionId) ?? context;
    if (item && typeof item.itemId === 'string' && this.childOwners.has(item.itemId)) context = this.childOwners.get(item.itemId);
    if (item?.kind === 'compaction' && this.foreground?.compact && !this.foreground.finished) context = this.foreground;
    if (!context && method === 'turn/started' && nativeId) {
      if (this.foreground && !this.foreground.finished && this.foreground.wirePendingIds.size > 0) {
        context = this.foreground; context.nativeIds.add(nativeId); context.pendingNativeIds.add(nativeId); context.wirePendingIds.add(nativeId); this.contexts.set(nativeId, context);
      } else {
        if (this.ephemeral) { void this.close(new Error('独立文字生成不能启动后台后续回复')); return; }
        const ready = (async () => {
          const settings = await loadNativeProviderSettings(this.owner.connection.directory, 'muse');
          if (!settings.enabled || nativeProviderAccount('muse', settings) !== this.runtime.account) throw new Error('Muse 后续回复所属账号配置已改变');
          const request = await this.observer.open(nativeId);
          const current = await loadNativeProviderSettings(this.owner.connection.directory, 'muse');
          if (!current.enabled || nativeProviderAccount('muse', current) !== this.runtime.account) throw new Error('Muse 后续回复所属账号配置已改变');
          return request;
        })();
        context = this.context(nativeId, ready, false); this.latestNative = context;
      }
    }
    context ??= !nativeId ? this.foreground && !this.foreground.finished ? this.foreground : this.latestNative && !this.latestNative.finished ? this.latestNative : undefined : undefined;
    if (!context) return;
    if (method === 'turn/completed') context.wirePendingIds.delete(nativeId!);
    if (item && ['subagent', 'workflow'].includes(item.kind)) {
      for (const id of [item.itemId, item.subagentId, item.childSessionId]) if (typeof id === 'string') this.childOwners.set(id, context);
      if (item.kind === 'workflow') for (const child of item.children ?? []) if (typeof child.childId === 'string') this.childOwners.set(child.childId, context);
    }
    this.push(context, method, value);
    this.scheduleIdle();
  }
  private async apply(context: Context, method: string, value: AcpRecord) {
    if (this.closed) return;
    const ready = await context.ready;
    const item = acpRecord(value.item), childRequest = !!value.subagentOrigin;
    if (!context.admitted && !['approval/requested', 'approval/updated', 'userInput/requested', 'approval/resolved', 'userInput/settled'].includes(method)) {
      const id = value.turnId ?? item?.turnId;
      if (id === context.id || !context.nativeIds.has(id)) return;
      await ready.request.beforeStart?.();
    }
    if (context.finished && !(item && ['subagent', 'workflow'].includes(item.kind)) && !childRequest && !['approval/resolved', 'userInput/settled'].includes(method)) return;
    if (['item/started', 'item/updated', 'item/completed'].includes(method)) {
      if (!item || typeof item.itemId !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Muse 原生输出格式无效');
      if (item.turnId && !context.nativeIds.has(item.turnId) && !(context.compact && item.kind === 'compaction')) return;
      if ((context.items.get(item.itemId)?.revision ?? 0) >= item.revision) return;
      context.items.set(item.itemId, item); await this.publish(context, ready, item);
      if (context.finished) await ready.projection.flush();
      if (ready.request.command === 'compact' && item.kind === 'compaction' && item.status !== 'inProgress') await this.complete(context, { terminal: item.status === 'completed' && (!item.outcome || item.outcome === 'compacted') ? 'completed' : 'failed', reason: item.failureReason ?? item.reason });
    } else if (method === 'item/delta') {
      const previous = context.items.get(value.itemId); if (!previous || previous.status !== 'inProgress' || typeof value.delta !== 'string') return;
      const item = { ...previous }, field = value.field ?? 'text';
      if (field === 'text') item.text = (item.text ?? '') + value.delta;
      else if (['visibleOutput', 'output'].includes(field)) item.visibleOutput = (item.visibleOutput ?? '') + value.delta;
      else if (/^summary\.\d+$/.test(field)) { const index = Number(field.slice(8)); if (index >= 100) return; item.summary = [...(item.summary ?? [])]; item.summary[index] = (item.summary[index] ?? '') + value.delta; }
      else return;
      context.items.set(item.itemId, item); await this.publish(context, ready, item);
    } else if (method === 'turn/completed' && ready.request.command !== 'compact') {
      context.pendingNativeIds.delete(value.turnId);
      if (value.turnId === context.id) context.terminal = value;
      if (context.terminal && context.pendingNativeIds.size === 0) await this.complete(context, context.terminal);
    } else if (['approval/requested', 'approval/updated'].includes(method)) await this.requestInput(context, ready, 'approval', value);
    else if (method === 'userInput/requested') await this.requestInput(context, ready, 'question', value);
    else if (['approval/resolved', 'userInput/settled'].includes(method)) {
      for (const [id, entry] of this.pending) if (entry.kind === 'approval' ? entry.value.approvalId === value.approvalId : entry.value.userInputId === value.userInputId) {
        this.pending.delete(id);
        await this.resolveInput(id, entry);
      }
    } else if (method === 'session/contextUsage' && Number.isFinite(value.usedTokens) && value.usedTokens >= 0) await ready.request.update({ kind: 'contextUsage', usage: { usedTokens: value.usedTokens, maxTokens: Number.isFinite(value.windowTokens) && value.windowTokens > 0 ? value.windowTokens : null, updatedAt: stamp(), model: this.runtime.model } });
    else if (method === 'session/todoListChanged' && Array.isArray(value.items)) ready.projection.put('todo', 'plan', 'Plan', { plan: taskPlanSteps(value.items.filter((item: AcpRecord) => item.status !== 'cancelled').map((item: AcpRecord) => ({ step: item.text, status: item.status }))) });
    this.scheduleIdle();
  }
  private async publish(context: Context, ready: Ready, item: AcpRecord) {
    if (['userMessage', 'reminderChild'].includes(item.kind)) return;
    const state = nativeStatus(item.status), text = item.text ?? (Array.isArray(item.summary) ? item.summary.join('\n') : undefined) ?? item.fallbackText ?? '';
    if (item.kind === 'subagent') {
      const result = item.result?.text ?? item.result?.summary ?? item.failureReason;
      await ready.children.observe({ nativeId: item.itemId, ...(typeof item.subagentId === 'string' ? { nativeChildId: item.subagentId } : {}), title: item.role, prompt: item.objective ?? item.fallbackText, status: state, ...(typeof result === 'string' ? { result, messages: [result] } : {}) });
      ready.children.bindNativeChild(item.itemId, item.childSessionId); return;
    }
    if (item.kind === 'workflow' && !ready.request.purpose && ready.request.task.currentRunId) {
      const id = 'muse-workflow:' + createHash('sha256').update(JSON.stringify([this.executionId, item.itemId])).digest('hex'), previous = this.background.get(id), at = stamp();
      this.background.set(id, { id, provider: 'muse', sessionId: this.threadId, transportId: this.executionId, taskId: item.itemId, nativeRunId: context.id, generation: 0,
        kind: 'background_task', status: state === 'waiting' ? 'running' : state === 'running' ? 'running' : state, member: true, backgrounded: true, ambient: false,
        description: typeof item.objective === 'string' ? item.objective : 'Muse workflow', startedAt: previous?.startedAt ?? at, updatedAt: at, ...(!['running', 'waiting'].includes(state) ? { completedAt: previous?.completedAt ?? at } : {}), canStop: false,
        ...(typeof item.result?.text === 'string' ? { summary: item.result.text.slice(0, 2000) } : {}) });
      await this.broadcast();
      for (const [index, child] of [...new Map<string, AcpRecord>((item.children ?? []).map((child: AcpRecord) => [child.childId, child])).values()].entries()) {
        const status = child.terminal === 'completed' && child.failureKind === undefined ? 'completed' : child.terminal === 'cancelled' ? 'cancelled' : child.terminal !== undefined ? 'failed' : !['running', 'waiting'].includes(state) ? state : child.status === 'scheduled' ? 'waiting' : 'running';
        const result = child.failureReason ?? child.failureKind;
        const nativeId = item.itemId + ':agent:' + child.childId;
        await ready.children.observe({ nativeId, nativeChildId: child.childId, generation: child.attempt, title: child.label?.trim() || (!ready.children.knowsNative(nativeId) ? 'Agent ' + (index + 1) : undefined), prompt: child.label?.trim() || undefined, status,
          ...(typeof result === 'string' ? { result, messages: [result] } : {}) });
      }
    }
    if (item.kind === 'agentMessage' || item.kind === 'reasoning') { ready.projection.put(item.itemId, item.kind === 'agentMessage' ? 'message' : 'reasoning', text, { status: state === 'waiting' ? 'running' : state }); return; }
    if (item.kind === 'toolCall' && ['write_todos', 'request_user_input', 'workflow'].includes(item.tool) && state !== 'failed') return;
    let args: AcpRecord | undefined; try { args = acpRecord(JSON.parse(item.args ?? '{}')); } catch {}
    const command = item.kind === 'userShell' || /shell|bash|exec_command/i.test(item.tool ?? ''), kind = item.kind === 'compaction' ? 'compaction' : command ? 'command' : /write|edit|patch/i.test(item.tool ?? '') ? 'files' : /web|browse|fetch|search|read|grep|glob/i.test(item.tool ?? '') ? 'search' : 'tool';
    const body = command ? item.commandText ?? args?.command ?? args?.cmd ?? item.args ?? '' : item.tool ?? item.objective ?? item.kind;
    const detail = item.visibleOutput ?? item.finalSummary ?? item.result?.summary ?? text;
    ready.projection.put(item.itemId, kind, body, { status: state === 'waiting' ? 'running' : state, detail: [item.failureReason, detail].filter(Boolean).join('\n'), ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}), ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}), ...(item.truncated ? { detailTruncated: true } : {}) });
  }
  private async requestInput(context: Context, ready: Ready, kind: Pending['kind'], value: AcpRecord) {
    if (ready.request.purpose) throw new Error('独立文字生成不接受工具授权或用户输入');
    const origin = acpRecord(value.subagentOrigin), child = typeof origin?.subagentId === 'string' ? ready.children.identityForNative(origin.subagentId) : undefined;
    if (origin && (kind !== 'approval' || !child) || context.finished && !child) return;
    const nativeId = kind === 'approval' ? value.approvalId : value.userInputId;
    if (typeof nativeId !== 'string') throw new Error('Muse 返回了无效的问题标识');
    const id = 'muse:' + kind + ':' + nativeId + ':' + (kind === 'approval' ? value.currentRequirementId?.sourceIndex ?? 0 : 0);
    for (const [key, previous] of this.pending) if (key !== id && previous.kind === kind && (kind === 'approval' ? previous.value.approvalId : previous.value.userInputId) === nativeId) { this.pending.delete(key); await this.resolveInput(key, previous); }
    const choices = museApprovalChoices(value), decisions = [...choices].filter(([decision, choice]) => decision !== 'cancel' || choice.choiceId !== choices.get('decline')?.choiceId).map(([decision]) => decision);
    if (kind === 'question' && (!Array.isArray(value.questions) || !value.questions.length)) throw new Error('Muse 返回了无效的问题');
    const approval: Approval = { id, method: kind === 'approval' ? 'muse/approval/request' : 'muse/userInput/request', title: kind === 'approval' ? '需要你的授权' : '需要你的补充',
      detail: kind === 'approval' ? [value.toolName, value.rawArgs, value.subject?.command, value.subject?.path].filter(Boolean).join('\n') : '', state: 'pending', questions: [],
      ...(kind === 'approval' ? { decisions } : { questions: value.questions.map((question: AcpRecord) => ({ id: question.id, header: question.header ?? '', question: question.question, multiSelect: question.selection?.mode === 'multiple', isOther: true, isSecret: false, options: (question.options ?? []).map((option: AcpRecord) => ({ label: option.label, description: option.description ?? '' })) })) }),
      ...(child ? { subagentId: child, ownerRunId: ready.request.task.currentRunId } : {}) };
    this.pending.set(id, { context, approval, value, kind, ...(origin ? { child: origin.subagentId } : {}), responding: false });
    await ready.projection.flush();
    if (child) await ready.children.nativeApproval(origin!.subagentId, approval);
    else await ready.request.update({ kind: 'approval', approval });
  }
  private async resolveInput(id: string, entry: Pending) {
    const ready = await entry.context.ready;
    if (entry.child) await ready.children.nativeApprovalResolved(entry.child, id);
    else await ready.request.update({ kind: 'approvalResolved', id });
  }
  private async complete(context: Context, value: AcpRecord) {
    if (context.finished) return; context.finished = true;
    const ready = await context.ready, status = value.terminal === 'completed' ? 'completed' : value.terminal === 'cancelled' ? 'interrupted' : 'failed';
    const retained = new Set([...context.items.values()].filter(item => ['subagent', 'workflow'].includes(item.kind) && ['inProgress', 'pending'].includes(item.status)).map(item => item.itemId));
    const result = await ready.projection.finish(status, retained);
    if (!context.foreground) await this.observer.finish(context.id, status, result, status === 'failed' ? value.error?.message ?? value.reason ?? 'Muse 原生后续回复失败' : undefined);
    context.releaseTools();
    context.resolve(value); this.scheduleIdle();
  }
  private async fail(context: Context, error: Error) {
    if (!context.finished) { context.finished = true; context.reject(error); }
    if (!context.foreground) await this.observer.finish(context.id, 'interrupted', undefined, error.message).catch(() => {});
    await this.close(error);
  }
  async broadcast(connected = true) {
    if (this.ephemeral) return;
    await this.latest.update({ kind: 'nativeBackground', provider: 'muse', providerInstanceId: this.latest.task.providerInstanceId ?? 'muse', sessionId: this.executionId, threadId: this.threadId, connected, tasks: [...this.background.values()] });
  }
  async run(request: ExecutionRequest, runtime: Runtime) {
    if (this.closed) throw new Error('Muse 原生连接已关闭');
    if (this.foreground && !this.foreground.finished || this.latestNative && !this.latestNative.finished) throw new Error('Muse 原生回合仍在执行');
    request = { ...request, task: { ...request.task, model: runtime.model, reasoningEffort: runtime.effort, nativeProviderAccount: runtime.account } };
    this.latest = request; this.runtime = runtime;
    const id = this.client.connection.mintCommandId(), context = this.context(id, Promise.resolve(request), true, request.command === 'compact'); this.foreground = context;
    this.scheduleIdle();
    const abort = () => { void this.interrupt(context).finally(() => this.close(cancelled())); };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      request.signal.throwIfAborted();
      await request.update({ kind: 'session', threadId: this.threadId, nativeProviderAccount: runtime.account, model: runtime.model, reasoningEffort: runtime.effort, executionSessionId: this.executionId });
      const taskMcp = await this.nativeTools.connection(request);
      if (taskMcp && !this.client.host!.initializeResult.grantedCapabilities.includes('sessionMcp')) throw new Error('Muse 尚未支持会话 MCP，请升级主机上的 Muse');
      const config = taskMcp ? { mcpServers: { friday: { transport: 'streamableHttp', mode: 'optional', url: taskMcp.url, headers: taskMcp.headers } } } : undefined;
      const approvalMode = request.purpose ? 'denyUnmatched' : runtime.settings.permissionMode === 'auto' ? 'allowAll' : 'promptUnmatched', permissionProfile = runtime.settings.permissionMode === 'auto' && !request.purpose ? ':unrestricted' : ':ask-me';
      const setup = await this.client.call(request.task.threadId ? 'session/resume' : 'session/start', { sessionId: this.threadId, ...(request.task.threadId ? { excludeItems: true } : { workspaceRoot: this.cwd, modelId: runtime.model, providerId: 'meta', approvalMode }), permissionProfile, ...(config ? { config } : {}) }, true);
      if (acpRecord(setup.session)?.sessionId !== this.threadId) throw new Error('Muse 返回了不同的原生会话 ID');
      if (request.task.threadId) { await this.client.call('session/setApprovalMode', { sessionId: this.threadId, mode: approvalMode }, true); await request.update({ kind: 'resumeApplied' }); }
      if (acpRecord(setup.session)?.modelId !== runtime.model) await this.client.call('session/setModel', { sessionId: this.threadId, model: { modelId: runtime.model, providerId: 'meta' } }, true);
      await request.beforeStart?.(); request.signal.throwIfAborted(); await request.update({ kind: 'turn', turnId: id }); context.admitted = true; await request.update({ kind: 'ready', canSteer: request.command !== 'compact' });
      if (request.command === 'compact') {
        const result = await this.client.call('session/compact', { sessionId: this.threadId }, true, id);
        if (result.status !== 'accepted') throw new Error(typeof result.reason === 'string' ? result.reason : 'Muse 未接受上下文压缩');
      } else {
        const input = await this.input(request.prompt, request.images);
        const result = await this.client.call('turn/start', { sessionId: this.threadId, input, displayText: request.prompt || 'Image attachment', workspaceRoots: [this.cwd], ifBusy: 'queue', ...(runtime.effort ? { reasoningEffort: runtime.effort } : {}) }, true, id);
        if (result.turnId !== id) throw new Error('Muse 未使用已保存的原生回合 ID');
      }
      const result = await context.done; await context.chain;
      if (request.signal.aborted || result.terminal === 'cancelled') throw cancelled();
      if (result.terminal !== 'completed') throw new Error(result.error?.message ?? result.reason ?? 'Muse 原生执行失败');
      return (await context.ready).projection.output;
    } catch (error) { await this.close(error instanceof Error ? error : new Error('Muse 原生执行失败')); throw request.signal.aborted ? cancelled() : error; }
    finally { request.signal.removeEventListener('abort', abort); if (this.foreground === context) this.foreground = undefined; this.scheduleIdle(); }
  }
  private reply(id: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const pending = this.pending.get(id); if (!pending || pending.responding || this.closed) throw new Error('Muse 问题已经结束或正在回答');
    let method: string, params: AcpRecord;
    if (pending.kind === 'approval') {
      const choice = museApprovalChoices(pending.value).get(decision); if (!choice || !pending.approval.decisions?.includes(decision)) throw new Error('Muse 未提供此授权选项');
      method = 'approval/decide'; params = { sessionId: this.threadId, approvalId: pending.value.approvalId, requirementId: pending.value.currentRequirementId, choiceId: choice.choiceId };
    } else {
      if (decision !== 'accept') throw new Error('Muse 问题需要回答选项；如需取消请停止当前任务');
      method = 'userInput/answer'; params = { sessionId: this.threadId, userInputId: pending.value.userInputId, answers: museQuestionAnswers(pending.value.questions, answers) };
    }
    const body = JSON.stringify(params);
    if (pending.command && pending.command.body !== body) throw new Error('Muse 回答已经保存，不能替换为另一个回答');
    return { pending, method, params, body };
  }
  validateAnswer(id: string, decision: ApprovalDecision, answers: Record<string, string[]>) { this.reply(id, decision, answers); }
  async answer(id: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    await this.reply(id, decision, answers).pending.context.ready;
    const { pending, method, params, body } = this.reply(id, decision, answers);
    pending.command ??= { body, id: this.client.connection.mintCommandId() }; pending.responding = true;
    try { await this.client.call(method, params, true, pending.command.id); } finally { pending.responding = false; }
  }
  async steer(text: string, requestId: string, images?: ExecutionImage[]) {
    const context = this.foreground && !this.foreground.finished ? this.foreground : this.latestNative && !this.latestNative.finished ? this.latestNative : undefined;
    if (!context || this.closed) throw new Error('Muse 当前没有可补充的原生回合');
    const params = { sessionId: this.threadId, expectedTurnId: context.id, input: await this.input(text, images) }, body = JSON.stringify(params), previous = context.steers.get(requestId);
    if (previous) { if (previous.body !== body) throw new Error('补充请求 ID 已用于不同的 Muse 输入'); return previous.result; }
    const result = this.client.call('turn/steer', params, true).then(value => { if (value.turnId !== context.id) throw new Error('Muse 补充请求未确认原生回合'); });
    context.steers.set(requestId, { body, result }); return result;
  }
  private async input(text: string, images?: ExecutionImage[]) {
    const input: AcpRecord[] = [{ type: 'text', text }];
    for (const image of images ?? []) input.push({ type: 'image', base64Data: (await readFile(image.path)).toString('base64'), mediaType: image.mediaType });
    return input;
  }
  async interrupt(context: Context) {
    if (context.finished || this.closed) return;
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([(async () => { for (const id of context.pendingNativeIds) if (id !== context.id) await this.client.call('turn/interrupt', { sessionId: this.threadId, turnId: id }, true); await this.client.call('turn/interrupt', { sessionId: this.threadId, turnId: context.id }, true); })(), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); }
    finally { clearTimeout(timer); }
  }
  async interruptKey(key: string) {
    const id = this.observer.nativeId(key), context = id ? this.contexts.get(id) : undefined;
    if (context) { try { await this.interrupt(context); } finally { await this.close(); } }
  }
  private hasPending() {
    if (this.pending.size || [...this.background.values()].some(work => ['running', 'paused', 'unknown'].includes(work.status))) return true;
    for (const context of new Set(this.contexts.values())) for (const item of context.items.values()) if (item.kind === 'subagent' && ['inProgress', 'pending'].includes(item.status)) return true;
    return false;
  }
  private scheduleIdle() { if (!this.ephemeral && !this.closed) this.idle.refresh(); }
  releaseLease() { this.scheduleIdle(); }
  close(error?: Error): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.nativeTools.close(); this.idle.stop();
      for (const context of new Set(this.contexts.values())) if (!context.finished) { context.finished = true; context.reject(error ?? new Error('Muse 原生连接已关闭')); }
      await this.owner.connection.release(this.client);
      await this.observer.close();
      for (const context of new Set(this.contexts.values())) {
        const ready = await context.ready.catch(() => undefined); if (!ready) continue;
        await ready.children.finish('interrupted').catch(() => {}); await ready.projection.finish('interrupted').catch(() => {}); ready.projection.dispose();
      }
      for (const work of this.background.values()) if (['running', 'paused'].includes(work.status)) { work.status = 'interrupted'; work.completedAt = stamp(); work.updatedAt = work.completedAt; work.member = false; }
      await this.broadcast(false).catch(() => {});
      this.owner.remove(this);
    })();
  }
}

export class MuseSessions {
  private sessions = new Map<string, MuseSession>();
  private running = new Set<string>();
  private closed = false;
  constructor(readonly connection: MuseConnection, readonly idlePolicy: NativeSessionIdlePolicy = {}) {}
  claimed(id: string) { return this.running.has(id); }
  remove(session: MuseSession) { if (this.sessions.get(session.latest.task.id) === session) this.sessions.delete(session.latest.task.id); }
  hasSession(id: string) { return this.sessions.get(id)?.closed === false; }
  async run(request: ExecutionRequest) {
    if (this.closed || this.running.has(request.task.id)) throw new Error('Muse 会话仍在执行或已关闭');
    this.running.add(request.task.id); let session: MuseSession | undefined;
    try {
      if (request.task.interactionMode === 'plan') throw new Error('Muse 未提供专用计划模式');
      const runtime = await this.connection.runtime(request.task);
      if (request.task.nativeProviderAccount && request.task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 Muse 会话使用的账号配置');
      request.signal.throwIfAborted(); const cwd = await realpath(request.task.cwd), ephemeral = !!request.purpose;
      session = !ephemeral ? this.sessions.get(request.task.id) : undefined;
      if (session && (session.runtime.account !== runtime.account || session.cwd !== cwd || session.threadId !== request.task.threadId || session.closed)) { await session.close(); session = undefined; }
      if (!session) {
        const client = await this.connection.client(runtime.settings, cwd, ephemeral);
        if (this.closed || request.signal.aborted) { await this.connection.release(client); throw cancelled(); }
        session = new MuseSession(this, client, runtime, cwd, request.task.threadId ?? client.connection.mintCommandId(), request, ephemeral);
        this.sessions.set(request.task.id, session);
      }
      return await session.run(request, runtime);
    } finally { this.running.delete(request.task.id); if (request.purpose && session) await session.close(); else this.sessions.get(request.task.id)?.releaseLease(); }
  }
  validateAnswer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) { const session = this.sessions.get(id); if (!session) throw new Error('Muse 原生会话已结束'); session.validateAnswer(approvalId, decision, answers); }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) { const session = this.sessions.get(id); if (!session) throw new Error('Muse 原生会话已结束'); await session.answer(approvalId, decision, answers); }
  async steer(id: string, text: string, requestId: string, images?: ExecutionImage[]) { const session = this.sessions.get(id); if (!session) throw new Error('Muse 当前没有可补充的原生回合'); await session.steer(text, requestId, images); }
  async waitNativeTurn(id: string, sessionId: string, key: string, signal: AbortSignal) { const session = this.sessions.get(id); if (!session || session.executionId !== sessionId) throw new Error('Muse 原生后续连接不可用'); await session.observer.wait(key, signal); }
  async interruptNativeTurn(id: string, sessionId: string, key: string) { const session = this.sessions.get(id); if (session?.executionId === sessionId) await session.interruptKey(key); }
  async stopNativeSession(id: string, sessionId: string) { const session = this.sessions.get(id); if (session?.executionId === sessionId) await session.close(); }
  async settleNativeBackground(task: WorkItem) { const session = this.sessions.get(task.id); if (session && task.executionSessionId !== session.executionId) throw new Error('Muse 后台连接范围已改变'); await session?.close(); }
  async interruptExecution(task: WorkItem, runId: string) { if (task.currentRunId === runId) await this.stopNativeSession(task.id, task.executionSessionId ?? ''); }
  async close() { if (this.closed) return; this.closed = true; await Promise.allSettled([...this.sessions.values()].map(session => session.close())); }
}
