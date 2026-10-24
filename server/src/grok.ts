import { isolatedTextGeneration } from './native-text-generation.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpProcess, acpRecord, type AcpRecord } from './acp-process.js';
import { acpMcpServer } from './acp-mcp.js';
import { acpSessionServers, acpPermissionRequest, acpModelOption, acpEffortOption, acpConfigValues } from './acp-protocol.js';
import { GrokConnection } from './grok-provider.js';
import { GrokSessions, type GrokNativeSession } from './grok-sessions.js';
import type { ApprovalDecision } from './provider-approvals.js';
import type { Approval, ExecutionImage, ExecutionRequest, Executor, TaskEvent, WorkItem } from './types.js';
import { taskPlanSteps } from './task-event-data.js';
import { NativeSubagentProjection } from './native-subagent-projection.js';
import { extractXAiAcpSubagentUpdate } from './vendor/t3-grok-subagents.mjs';

type Pending = { approval: Approval; params: AcpRecord; kind: 'permission' | 'question'; replied: boolean; resolve: (response: AcpRecord) => void; written: Promise<void>; dispose: () => void };
type Run = { client: AcpProcess; sessionId?: string; pending: Map<string, Pending>; start: () => Promise<void>; cancel: () => void };
const now = () => new Date().toISOString();
export function grokPermissionDecisions(options: AcpRecord[]): ApprovalDecision[] {
  const decisions: ApprovalDecision[] = ['cancel'];
  if (options.some(option => option.kind === 'reject_once')) decisions.push('decline');
  if (options.some(option => option.kind === 'allow_always' && option.optionId?.trim() === 'allow-edits-session')) decisions.push('acceptForSession');
  if (options.some(option => option.kind === 'allow_once')) decisions.push('accept');
  return decisions;
}
export function grokQuestionResponse(questions: AcpRecord[], answers: Record<string, string[]>): AcpRecord {
  const values: [string, string[]][] = [], annotations: [string, AcpRecord][] = [];
  for (const question of questions) {
    const key = question.id ?? question.question, answer = answers[key] ?? answers[question.question];
    if (!Array.isArray(answer) || !answer.length || answer.some(value => typeof value !== 'string') || !question.multiSelect && answer.length > 1) throw new Error('Grok 回答格式无效');
    const options = new Map<string, AcpRecord>((Array.isArray(question.options) ? question.options : []).map((value: AcpRecord) => [value.label, value]));
    const selected = answer.filter(value => options.has(value)), notes = answer.filter(value => !options.has(value));
    const preview = !question.multiSelect ? answer.map(value => options.get(value)?.preview?.trim()).find(Boolean) : undefined;
    values.push([question.question, selected.length ? selected : ['Other']]);
    if (preview || notes.length) annotations.push([question.question, { ...(preview ? { preview } : {}), ...(notes.length ? { notes: notes.join('\n') } : {}) }]);
  }
  return { outcome: 'accepted', answers: Object.fromEntries(values), ...(annotations.length ? { annotations: Object.fromEntries(annotations) } : {}) };
}
const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  const record = acpRecord(value); if (record?.type === 'text' && typeof record.text === 'string') return record.text;
  if (Array.isArray(value)) return value.map(part => contentText(acpRecord(part)?.content ?? part)).filter(Boolean).join('\n');
  return record && Array.isArray(record.content) ? contentText(record.content) : '';
};
const cancelled = () => new Error('任务已中止');

export class GrokExecutor implements Executor {
  private runs = new Map<string, Run>();
  private pendingResponses = new Map<string, { taskId: string; run: Run; pending: Pending }>();
  private sessions: GrokSessions;
  constructor(private connection: GrokConnection) { this.sessions = new GrokSessions(connection, (request, session, nativeId) => this.runNative(request, session, nativeId)); }
  supportsTaskTools(agent: string) { return agent === 'grok'; }
  deferredStart(agent: string) { return agent === 'grok'; }
  async generateText(request: import('./types.js').TextGenerationRequest) { return this.run(request); }
  async run(request: ExecutionRequest): Promise<string> { return request.purpose ? isolatedTextGeneration(request, prepared => this.sessions.run(prepared)) : this.sessions.run(request); }
  private async runNative(request: ExecutionRequest, owned: GrokNativeSession, nativeId?: string): Promise<string> {
    const { task, update, signal } = request;
    if (task.interactionMode === 'plan') throw new Error('Grok 未提供原生交互模式切换，请使用默认模式');
    const runtime = owned.runtime;
    if (task.grokHome && task.grokHome !== runtime.home) throw new Error('请恢复这条 Grok 会话使用的配置目录');
    if (signal.aborted) throw cancelled();
    const client = owned.client, turnId = nativeId ?? `grok:${task.currentRunId ?? randomUUID()}`, executionSessionId = owned.executionId;
    let start: Promise<void> | undefined, sessionPersisted = !!nativeId, active = !!nativeId, terminal = false, nativeCancellation: Promise<void> | undefined, protocolGeneration = owned.initialized?.protocolGeneration ?? 1, children: NativeSubagentProjection | undefined, promptResult: AcpRecord | undefined;
    let acknowledgeCancel!: () => void; const cancelAcknowledged = new Promise<void>(resolve => { acknowledgeCancel = resolve; });
    let rejectCompletion!: (error: Error) => void, resolveCompletion!: (response: AcpRecord) => void;
    const completion = new Promise<AcpRecord>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; }); void completion.catch(() => {});
    const finish = (response?: AcpRecord, error?: Error) => {
      if (!error && response) { promptResult = response; if (owned.holds(task.currentRunId) || children?.hasPending()) return; }
      if (terminal) return; terminal = true; error ? rejectCompletion(error) : resolveCompletion(response ?? {});
    };
    const run: Run = { client, sessionId: task.threadId ?? undefined, pending: new Map(), start: () => start ??= Promise.resolve().then(async () => { if (!sessionPersisted) throw new Error('Grok 会话尚未持久化'); if (signal.aborted) throw cancelled(); await request.beforeStart?.(); }), cancel: () => finish(undefined, cancelled()) };
    this.runs.set(task.id, run);
    const bind = async (sessionId: unknown) => {
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 2000 || run.sessionId && run.sessionId !== sessionId) throw new Error('Grok 返回了不同或无效的原生会话 ID，已停止执行');
      run.sessionId = sessionId;
      if (!sessionPersisted) { await update({ kind: 'session', threadId: sessionId, grokHome: runtime.home, nativeProviderAccount: owned.account, model: runtime.model, reasoningEffort: runtime.effort, executionSessionId }); sessionPersisted = true; }
      owned.bind(sessionId);
      children ??= new NativeSubagentProjection(request, 'grok', executionSessionId, sessionId, turnId);
      return sessionId;
    };
    const items = new Map<string, TaskEvent>(), dirty = new Set<string>(), terminals = new Map<string, StringDecoder>(); let chain = Promise.resolve(), timer: NodeJS.Timeout | undefined, message = '', outputDirty = false, messageOrdinal = 0, currentBlock: string | undefined, finalMessage: string | undefined, lastKind: string | undefined;
    const promptId = nativeId ?? randomUUID(), nativeCalls = new Map<string, AcpRecord>();
    const put = (key: string, kind: string, text: string, changes: Partial<TaskEvent> = {}) => {
      const previous = items.get(key), item: TaskEvent = { id: `${turnId}:${key}`, itemId: key, turnId, kind, text, at: previous?.at ?? now(), status: 'running', ...(kind === 'message' ? { phase: 'commentary' as const } : {}), ...previous, ...changes };
      items.set(key, item); dirty.add(key); timer ??= setTimeout(() => enqueue(flush), 50); return item;
    };
    const flush = async () => {
      clearTimeout(timer); timer = undefined;
      const keys = [...dirty]; dirty.clear();
      for (const key of keys) { const value = items.get(key); if (value) await update({ kind: 'item', item: { ...value } }); }
      if (outputDirty) { outputDirty = false; await update({ kind: 'output', text: message }); }
    };
    const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(error => finish(undefined, error instanceof Error ? error : new Error('Grok 更新失败'))); };
    const isOwned = (params: AcpRecord) => params.sessionId === run.sessionId && !params._meta?.childSessionId && !params._meta?.child_session_id && !params.update?.child_session_id && !params.update?._meta?.childSessionId;
    const belongsToPrompt = (params: AcpRecord) => {
      const id = params._meta?.promptId ?? params._meta?.requestId ?? params.update?._meta?.promptId ?? params.update?._meta?.requestId ?? params.update?.prompt_id ?? params.update?.promptId;
      return id === undefined || id === promptId;
    };
    const handleUpdate = async (params: AcpRecord) => {
      const nativeChild = params.sessionId !== run.sessionId ? params.sessionId : params._meta?.childSessionId ?? params._meta?.child_session_id ?? params.update?.child_session_id;
      if (typeof nativeChild === 'string' && children?.knowsNative(nativeChild)) {
        const change = acpRecord(params.update);
        if (change && ['agent_message_chunk', 'agent_message'].includes(change.sessionUpdate)) await children.nativeMessage(nativeChild, contentText(change.content), change.sessionUpdate === 'agent_message');
        return;
      }
      if (!active || terminal) return;
      if (!isOwned(params) || !belongsToPrompt(params)) return;
      const change = acpRecord(params.update); if (!change) return;
      const kind = change.sessionUpdate;
      if (['agent_message_chunk', 'agent_thought_chunk', 'agent_message', 'agent_thought'].includes(kind)) {
        const text = contentText(change.content), thought = kind.startsWith('agent_thought'), snapshot = !kind.endsWith('_chunk'), streamKind = thought ? 'reasoning' : 'message';
        if (!thought) await owned.text(text);
        if (snapshot && !Object.hasOwn(change, 'content') || !snapshot && !text) return;
        if (typeof change.messageId === 'string') currentBlock = `${streamKind}:${change.messageId}`;
        else if (lastKind !== streamKind || !currentBlock) currentBlock = `message:${++messageOrdinal}`;
        lastKind = streamKind;
        const previous = items.get(currentBlock!), value = snapshot ? text : (previous?.text ?? '') + text;
        put(currentBlock!, streamKind, value, { text: value });
        if (!thought) { message = value; finalMessage = currentBlock; outputDirty = true; }
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const key = `tool:${change.toolCallId}`, previous = items.get(key); if (typeof change.toolCallId !== 'string') return;
        const native = { ...nativeCalls.get(change.toolCallId), ...change }; nativeCalls.set(change.toolCallId, native);
        const child = extractXAiAcpSubagentUpdate({ toolCallId: change.toolCallId, title: native.title, status: native.status, data: { rawInput: native.rawInput, rawOutput: native.rawOutput, content: native.content } });
        if (child && (child.prompt || child.title || children?.knowsNative(child.childSessionId ?? child.nativeTaskId))) {
          await children?.observe({ nativeId: child.nativeTaskId, ...(child.childSessionId ? { nativeChildId: child.childSessionId } : {}), title: child.title ?? undefined, prompt: child.prompt, model: child.model ?? undefined, status: child.status,
            hydrationOnly: !child.prompt && !child.title, ...(child.result !== null ? { result: child.result, messages: [child.result] } : {}) });
          return;
        }
        await owned.tool({ toolCallId: change.toolCallId, title: native.title, status: native.status, data: { rawInput: native.rawInput, rawOutput: native.rawOutput, content: native.content } }, request, turnId);
        const nativeKind = change.kind, type = nativeKind === 'execute' || previous?.kind === 'command' ? 'command' : ['edit', 'delete', 'move'].includes(nativeKind) ? 'files' : ['read', 'search', 'fetch'].includes(nativeKind) ? 'search' : previous?.kind ?? 'tool';
        const input = acpRecord(change.rawInput), text = type === 'command' && typeof input?.command === 'string' ? input.command : typeof change.title === 'string' ? change.title : previous?.text ?? change.toolCallId;
        const detail = contentText(change.content) || contentText(change.rawOutput), status = change.status === 'completed' ? 'completed' : change.status === 'failed' ? 'failed' : change.status === undefined ? previous?.status ?? 'running' : 'running';
        put(key, type, text, { text, status, ...(detail ? { detail } : {}), ...(['completed', 'failed'].includes(status) ? { completedAt: now() } : {}) });
        currentBlock = undefined; lastKind = undefined;
      } else if (kind === 'tool_call_content_chunk' && typeof change.toolCallId === 'string') {
        const key = `tool:${change.toolCallId}`, previous = items.get(key), text = contentText([change.content]);
        if (text) put(key, previous?.kind ?? 'tool', previous?.text ?? change.toolCallId, { detail: (previous?.detail ?? '') + text });
      } else if (['terminal_update', 'terminal_output_chunk'].includes(kind) && typeof change.terminalId === 'string') {
        const key = `terminal:${change.terminalId}`, previous = items.get(key);
        let decoder = terminals.get(key); if (!decoder || Object.hasOwn(change, 'output')) { decoder = new StringDecoder('utf8'); terminals.set(key, decoder); }
        const data = kind === 'terminal_output_chunk' ? change.data : change.output?.data;
        const detail = typeof data === 'string' ? (kind === 'terminal_output_chunk' ? previous?.detail ?? '' : '') + decoder.write(Buffer.from(data, 'base64')) : change.output === null ? '' : previous?.detail;
        const exit = acpRecord(change.exitStatus), status = exit ? (exit.exitCode === 0 ? 'completed' : 'failed') : previous?.status ?? 'running';
        put(key, 'command', typeof change.command === 'string' ? change.command : previous?.text ?? change.terminalId, { status, ...(detail !== undefined ? { detail: detail + (exit ? decoder.end() : '') } : {}), ...(typeof exit?.exitCode === 'number' ? { exitCode: exit.exitCode } : {}), ...(exit ? { completedAt: now() } : {}) });
      } else if (kind === 'plan' || kind === 'plan_update' && change.plan?.type === 'items') {
        const plan = kind === 'plan' ? change : change.plan;
        if (Array.isArray(plan.entries)) put(typeof plan.planId === 'string' ? `plan:${plan.planId}` : 'plan', 'plan', 'Plan', { plan: taskPlanSteps(plan.entries.map((entry: AcpRecord) => ({ step: entry.content, status: entry.status === 'in_progress' ? 'inProgress' : entry.status }))) });
      } else if (kind === 'usage_update' && Number.isFinite(change.used) && change.used >= 0) {
        await update({ kind: 'contextUsage', usage: { usedTokens: change.used, maxTokens: Number.isFinite(change.size) && change.size > 0 ? change.size : null, updatedAt: now(), model: runtime.model } });
      } else if (protocolGeneration === 2 && kind === 'state_update' && change.state === 'idle') {
        finish({ stopReason: change.stopReason ?? 'end_turn', ...(change._meta ? { _meta: change._meta } : {}) });
      }
    };
    const completeFromNotification = (params: AcpRecord) => {
      if (!active || terminal || params.sessionId !== run.sessionId) return;
      const change = acpRecord(params.update), id = params.promptId ?? change?.prompt_id ?? change?.promptId;
      if (id !== promptId) return;
      if (change && change.sessionUpdate !== 'turn_completed') return;
      const stopReason = params.stopReason ?? change?.stop_reason ?? change?.stopReason ?? 'end_turn', agentResult = params.agentResult ?? change?.agent_result;
      finish({ stopReason, _meta: { promptId, agentResult } });
    };
    const notification = (method: string, input: unknown) => {
      const params = acpRecord(input); if (!params) return;
      if (signal.aborted && params.sessionId === run.sessionId && belongsToPrompt(params) && (params.update?.state === 'idle' || params.promptId === promptId)) acknowledgeCancel();
      enqueue(async () => {
        await owned.notice(method, params);
        if (params.sessionId === run.sessionId && params.update?.sessionUpdate === 'subagent_finished' && typeof params.update.child_session_id === 'string' && ['completed', 'failed', 'cancelled'].includes(params.update.status)) {
          const value = params.update;
          await children?.nativeFinish(value.child_session_id, value.status, value.status === 'completed' ? typeof value.output === 'string' ? value.output : undefined : typeof value.error === 'string' ? value.error : undefined);
        }
        if (method === 'session/update') await handleUpdate(params);
        if (['x.ai/session/prompt_complete', '_x.ai/session/prompt_complete', 'x.ai/session_notification', '_x.ai/session_notification', '_x.ai/session/update'].includes(method)) completeFromNotification(params);
        if (promptResult && !terminal) finish(promptResult);
      });
    };
    const nativeRequest: NonNullable<AcpProcess['onRequest']> = async context => {
      if (request.purpose) { const error = new Error('独立文字生成不接受工具或交互式请求'); finish(undefined, error); throw RequestError.invalidRequest(error.message); }
      const input = acpRecord(context.params); if (!input) throw RequestError.invalidParams();
      const method = context.method.replace(/^_/, ''), permission = method === 'session/request_permission', question = method === 'x.ai/ask_user_question';
      if (!permission && !question && method !== 'x.ai/exit_plan_mode') throw RequestError.methodNotFound(context.method);
      const unwrapped: AcpRecord = acpRecord(input.params) && typeof input.method === 'string' ? { ...input.params, _meta: { ...acpRecord(input._meta), ...acpRecord(input.params._meta) } } : input;
      const params = permission ? acpPermissionRequest(unwrapped, context.requestId) : unwrapped;
      await chain;
      const childNativeId = params._meta?.childSessionId ?? params.child_session_id ?? (run.sessionId && params.sessionId !== run.sessionId ? params.sessionId : undefined);
      const childIdentity = typeof childNativeId === 'string' ? children?.identityForNative(childNativeId) : undefined;
      if (childNativeId && !childIdentity || !childIdentity && (!belongsToPrompt(params) || terminal)) throw RequestError.requestCancelled();
      if (!childIdentity) await bind(params.sessionId);
      if (method === 'x.ai/exit_plan_mode') {
        const text = typeof params.planContent === 'string' && params.planContent.trim() ? params.planContent.trim() : message.trim();
        if (!text) throw RequestError.invalidParams();
        put(`proposal:${randomUUID()}`, 'proposal', text, { text, status: 'completed', completedAt: now() }); await flush();
        return { outcome: 'abandoned', feedback: "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn." };
      }
      const questions = question && Array.isArray(params.questions) ? params.questions : [];
      if (question && (!questions.length || questions.length > 8 || questions.some((value: any) => typeof value?.question !== 'string' || !value.question.trim()))) throw RequestError.invalidParams();
      const id = `grok:${randomUUID()}`, receipt = client.watchReply(context.requestId);
      const options = permission && Array.isArray(params.options) ? params.options.filter((value: any) => typeof value?.optionId === 'string' && typeof value.kind === 'string') : [];
      const approval: Approval = { id, method: permission ? 'grok/session/requestPermission' : 'grok/session/requestUserInput', title: permission ? '需要你的授权' : '需要你的补充', detail: permission ? [params.toolCall?.title, typeof params.toolCall?.rawInput === 'string' ? params.toolCall.rawInput : params.toolCall?.rawInput ? JSON.stringify(params.toolCall.rawInput, null, 2) : ''].filter(Boolean).join('\n') : '', state: 'pending',
        questions: questions.map((value: AcpRecord) => ({ id: value.id ?? value.question, header: value.header ?? '', question: value.question, multiSelect: value.multiSelect === true, isOther: true, isSecret: value.isSecret === true, options: (Array.isArray(value.options) ? value.options : []).filter((entry: any) => typeof entry?.label === 'string').slice(0, 64).map((entry: AcpRecord) => ({ label: entry.label, description: typeof entry.description === 'string' ? entry.description : '' })) })),
        ...(permission ? { decisions: grokPermissionDecisions(options) } : {}) };
      let resolve!: (response: AcpRecord) => void;
      const response = new Promise<AcpRecord>(yes => { resolve = yes; });
      const pending: Pending = { approval, params: { ...params, options }, kind: permission ? 'permission' : 'question', replied: false, resolve, ...receipt };
      if (childIdentity) { approval.subagentId = childIdentity; approval.ownerRunId = task.currentRunId; }
      run.pending.set(id, pending);
      this.pendingResponses.set(id, { taskId: task.id, run, pending });
      const abort = () => { if (!pending.replied) { pending.replied = true; resolve(permission ? { outcome: { outcome: 'cancelled' } } : { outcome: 'cancelled' }); void (childIdentity ? children!.nativeApprovalResolved(childNativeId, id) : update({ kind: 'approvalResolved', id })).catch(() => {}); } };
      context.signal.addEventListener('abort', abort, { once: true });
      try { await flush(); if (childIdentity) await children!.nativeApproval(childNativeId, approval); else await update({ kind: 'approval', approval }); if (context.signal.aborted || signal.aborted && !terminal) abort(); return await response; }
      finally { context.signal.removeEventListener('abort', abort); run.pending.delete(id); this.pendingResponses.delete(id); }
    };
    if (nativeId) children = new NativeSubagentProjection(request, 'grok', executionSessionId, owned.threadId!, turnId);
    owned.listen({ notification, request: nativeRequest, exit: error => finish(undefined, error), done: () => terminal, knows: id => children?.knowsNative(id) === true, pending: () => children?.hasPending() === true || run.pending.size > 0,
      close: async () => { for (const pending of run.pending.values()) { pending.resolve(pending.kind === 'permission' ? { outcome: { outcome: 'cancelled' } } : { outcome: 'cancelled' }); pending.dispose(); } await children?.finish('interrupted'); } }, nativeId);
    const cancel = () => {
      run.cancel();
      nativeCancellation ??= (async () => {
        let timer: NodeJS.Timeout | undefined;
        if (run.sessionId) await Promise.race([(async () => { await client.notify('session/cancel', { sessionId: run.sessionId, _meta: { cancelTrigger: 'ctrl_c' } }); await cancelAcknowledged; })().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 250); })]);
        clearTimeout(timer); await owned.close();
      })();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (!nativeId) {
      const initialized = owned.initialized ??= await this.connection.initialize(client);
      protocolGeneration = initialized.protocolGeneration;
      if (signal.aborted) throw cancelled();
      const mcp = await owned.tools.connection(request);
      const mcpServers = acpSessionServers(mcp ? [await acpMcpServer(this.connection.directory, mcp, initialized.agentCapabilities?.mcpCapabilities?.http === true)] : [], protocolGeneration);
      const setup = async () => {
        if (!task.threadId) return client.call('session/new', { cwd: task.cwd, mcpServers });
        const capabilities = initialized.agentCapabilities;
        if (protocolGeneration === 2 && capabilities?.sessionCapabilities?.resume != null) return client.call('session/resume', { sessionId: task.threadId, cwd: task.cwd, mcpServers, replayFrom: { type: 'start' } });
        if (capabilities?.loadSession === true) return client.call('session/load', { sessionId: task.threadId, cwd: task.cwd, mcpServers });
        if (capabilities?.sessionCapabilities?.resume != null) return client.call('session/resume', { sessionId: task.threadId, cwd: task.cwd, mcpServers });
        throw new Error('Grok 未声明载入原会话的能力，已停止；不会另建会话');
      };
      let session: AcpRecord;
      try { session = owned.setup ??= await setup(); }
      catch (error) {
        if (!(error instanceof RequestError) || error.code !== -32000) throw error;
        const methodId = runtime.env.XAI_API_KEY?.trim() ? 'xai.api_key' : 'cached_token';
        const auth = initialized.authMethods?.find((value: AcpRecord) => value.id === methodId);
        if (Array.isArray(initialized.authMethods) && !auth) throw new Error('Grok 未声明当前账号的原生认证方式，请在主机完成登录');
        if (auth?.type && auth.type !== 'agent') throw new Error('Grok 需要在主机完成登录后再继续');
        await client.call(protocolGeneration === 2 ? 'auth/login' : 'authenticate', { methodId }); session = owned.setup = await setup();
      }
      await bind(session.sessionId ?? task.threadId);
      if (task.threadId) await update({ kind: 'resumeApplied' });
      const modelOption = acpModelOption(session), effortOption = acpEffortOption(session);
      const current = modelOption?.currentValue ?? session.models?.currentModelId ?? initialized._meta?.modelState?.currentModelId, target = runtime.model === 'grok-build' ? current : runtime.model;
      if (protocolGeneration === 2) {
        if (target && target !== current) await client.call('session/set_config_option', { sessionId: run.sessionId, configId: modelOption?.configId ?? modelOption?.id ?? 'model', type: 'id', value: target });
        if (runtime.effort) {
          if (!effortOption || !acpConfigValues(effortOption).includes(runtime.effort)) throw new Error('Grok 未提供当前推理选项的原生配置，请重新选择');
          if (runtime.effort !== effortOption.currentValue) await client.call('session/set_config_option', { sessionId: run.sessionId, configId: effortOption.configId ?? effortOption.id, type: 'id', value: runtime.effort });
        }
      } else if (target && (target !== current || runtime.effort)) await client.call('session/set_model', { sessionId: run.sessionId, modelId: target, ...(runtime.effort ? { _meta: { reasoningEffort: runtime.effort } } : {}) });
      const images: AcpRecord[] = [];
      // T3's Grok adapter accepts native image blocks even when Grok's legacy
      // initialize incorrectly reports image:false.
      for (const image of request.images ?? []) images.push({ type: 'image', data: (await readFile(image.path)).toString('base64'), mimeType: image.mediaType });
      await run.start(); await update({ kind: 'turn', turnId }); if (signal.aborted) throw cancelled();
      active = true; await update({ kind: 'ready', canSteer: false });
      const text = request.command === 'compact' ? '/compact' : request.prompt;
      const prompt = client.call('session/prompt', { sessionId: run.sessionId, prompt: [{ type: 'text', text }, ...images], _meta: { promptId, requestId: promptId } }, null);
      void prompt.then(result => {
        if (signal.aborted) acknowledgeCancel();
        if (typeof result.stopReason === 'string' && result._meta?.xAiStopReasonMissing !== true) enqueue(async () => finish(result));
      }, error => enqueue(async () => finish(undefined, error)));
      } else await update({ kind: 'ready', canSteer: false });
      const response = await completion; await chain;
      const stop = response.stopReason;
      if (['error', 'rate_limit'].includes(stop)) throw new Error(typeof response._meta?.agentResult === 'string' ? response._meta.agentResult : stop === 'rate_limit' ? 'Grok 账号额度暂不可用' : 'Grok 原生执行失败');
      if (stop === 'cancelled') throw cancelled();
      if (!stop) throw new Error('Grok 未确认回合完成状态');
      for (const [key, value] of items) {
        if (value.status === 'running') put(key, value.kind, value.text, { status: 'completed', completedAt: now() });
        if (key === finalMessage && value.kind === 'message') put(key, value.kind, value.text, { phase: 'final_answer' });
      }
      await flush(); return message;
    } catch (error) {
      await children?.finish(signal.aborted ? 'interrupted' : 'failed');
      for (const [key, value] of items) if (value.status === 'running') put(key, value.kind, value.text, { status: signal.aborted ? 'interrupted' : 'failed', completedAt: now() });
      await flush(); throw signal.aborted ? cancelled() : error;
    } finally {
      signal.removeEventListener('abort', cancel); active = false; clearTimeout(timer);
      await nativeCancellation; await chain; if (this.runs.get(task.id) === run) this.runs.delete(task.id);
    }
  }
  private reply(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const saved = this.pendingResponses.get(approvalId), run = saved?.taskId === id ? saved.run : undefined, pending = saved?.taskId === id ? saved.pending : undefined;
    if (!run || !pending || pending.replied) throw new Error('Grok 问题已结束或已回答');
    let response: AcpRecord;
    if (pending.kind === 'question') {
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('Grok 问题未提供此回答选项');
      response = ['decline', 'cancel'].includes(decision) ? { outcome: 'cancelled' } : grokQuestionResponse(pending.params.questions, answers);
    }
    else {
      if (!pending.approval.decisions?.includes(decision)) throw new Error('Grok 未提供此授权选项');
      if (decision === 'cancel') response = { outcome: { outcome: 'cancelled' } };
      else {
        const option = pending.params.options.find((value: AcpRecord) => decision === 'accept' ? value.kind === 'allow_once' : decision === 'decline' ? value.kind === 'reject_once' : value.kind === 'allow_always' && value.optionId?.trim() === 'allow-edits-session');
        if (!option) throw new Error('Grok 授权选项已失效'); response = { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
    }
    return { run, pending, response };
  }
  validateAnswer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) { this.reply(id, approvalId, decision, answers); }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const { run, pending, response } = this.reply(id, approvalId, decision, answers);
    await run.start(); pending.replied = true; pending.resolve(response);
    try { await pending.written; } finally { pending.dispose(); }
  }
  async steer(_id: string, _text: string, _requestId: string, _images?: ExecutionImage[]): Promise<void> { throw new Error('Grok ACP 不支持原生 Steer，请使用队列'); }
  hasSession(id: string) { return this.sessions.has(id); }
  waitNativeTurn(id: string, sessionId: string, key: string, signal: AbortSignal) { return this.sessions.wait(id, sessionId, key, signal); }
  interruptNativeTurn(id: string, sessionId: string, _key: string) { return this.sessions.stop(id, sessionId); }
  stopNativeSession(id: string, sessionId: string) { return this.sessions.stop(id, sessionId); }
  settleNativeBackground(task: WorkItem) { return this.sessions.settle(task); }
  async interruptExecution(task: WorkItem, runId: string) { if (task.currentRunId === runId) await this.sessions.stop(task.id, task.executionSessionId ?? ''); }
  async close() { await this.sessions.close(); await this.connection.close(); }
}
