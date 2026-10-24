import { isolatedTextGeneration } from './native-text-generation.js';
import { selectedProviderOptions, type ProviderModelSelection } from './provider-models.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { RequestError } from '@agentclientprotocol/sdk';
import { AcpProcess, acpRecord, type AcpRecord } from './acp-process.js';
import { acpConfigValues, acpEffortOption, acpModelOption, acpPermissionRequest, acpSessionServers } from './acp-protocol.js';
import { acpMcpServer } from './acp-mcp.js';
import { NativeTurnProjection } from './native-turn-projection.js';
import { taskPlanSteps } from './task-event-data.js';
import type { Approval, ExecutionImage, ExecutionRequest, Executor } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';

// Native ACP behavior follows T3 8cd9641f provider-acp/AcpSessionRuntime and
// adapter. MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export type AcpNativeRuntime = { provider: string; name: string; model: string; effort: string; account: string; command: string; args: string[]; env: NodeJS.ProcessEnv; authMethod?: string; authenticateEagerly?: boolean; resumeMethod?: 'load' | 'resume'; nativeMode?: string; defaultMode?: string; restoreBuildMode?: boolean; defaultModel?: string; compactCommand?: string; modelOptions?: Record<string, string | boolean>; clientFiles?: boolean; autoApprove?: boolean };
export type AcpNativeLease = { client: AcpProcess; initialized: AcpRecord; authorizationURL?: string; close(): Promise<void> };
export type AcpNativePermission = { questions?: Approval['questions']; options?: Approval['options']; decisions: ApprovalDecision[]; respond(decision: ApprovalDecision, answers: Record<string, string[]>): AcpRecord };
export interface AcpNativeConnection {
  readonly provider: string;
  readonly directory: string;
  runtime(selection?: ProviderModelSelection & { interactionMode?: string }): Promise<AcpNativeRuntime>;
  client(runtime: AcpNativeRuntime, cwd: string): Promise<AcpNativeLease>;
  normalize?(update: AcpRecord): AcpRecord;
  permission?(params: AcpRecord): AcpNativePermission;
  clientFile?(runtime: AcpNativeRuntime, cwd: string, method: string, params: AcpRecord): Promise<AcpRecord>;
  close(): Promise<unknown>;
}
const cancellation = () => new Error('任务已中止');
export function acpNativePermission(params: AcpRecord): AcpNativePermission {
  const options: AcpRecord[] = Array.isArray(params.options) ? params.options : [], kinds: [ApprovalDecision, string[]][] = [['accept', ['allow_once']], ['acceptForSession', ['allow_always']], ['decline', ['reject_once', 'reject_always']]], selected = new Map<ApprovalDecision, AcpRecord>();
  for (const [decision, accepted] of kinds) { const option = accepted.flatMap(kind => options.filter(value => value.kind === kind)).find(value => typeof value.optionId === 'string' && !!value.optionId); if (option) selected.set(decision, option); }
  return { decisions: ['cancel', 'decline', 'acceptForSession', 'accept'].filter(value => value === 'cancel' || selected.has(value as ApprovalDecision)) as ApprovalDecision[], respond: decision => { if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }; const option = selected.get(decision); if (!option) throw new Error('ACP 工具未提供此授权选项'); return { outcome: { outcome: 'selected', optionId: option.optionId } }; } };
}
const textContent = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(value => textContent(value)).filter(Boolean).join('\n') : acpRecord(value)?.type === 'text' && typeof acpRecord(value)?.text === 'string' ? acpRecord(value)!.text : acpRecord(value)?.content ? textContent(acpRecord(value)!.content) : '';
export async function acpNativeAuthenticate(client: AcpProcess, initialized: AcpRecord, method: string) { return client.call(initialized.protocolGeneration === 2 ? 'auth/login' : 'authenticate', { methodId: method }, 60000); }
export async function acpNativeSession(client: AcpProcess, initialized: AcpRecord, input: { cwd: string; sessionId?: string | null; resumeMethod?: string; mcpServers: AcpRecord[] }) {
  const params = { cwd: input.cwd, mcpServers: acpSessionServers(input.mcpServers, initialized.protocolGeneration) };
  if (!input.sessionId) return client.call('session/new', params);
  const capabilities = initialized.agentCapabilities;
  if (initialized.protocolGeneration === 2 || input.resumeMethod === 'resume' && capabilities?.sessionCapabilities?.resume) return client.call('session/resume', { ...params, sessionId: input.sessionId });
  if (capabilities?.loadSession === true) return client.call('session/load', { ...params, sessionId: input.sessionId });
  if (capabilities?.sessionCapabilities?.resume) return client.call('session/resume', { ...params, sessionId: input.sessionId });
  throw new Error('ACP 工具未声明原生会话恢复能力');
}
export async function acpNativeSelection(client: AcpProcess, initialized: AcpRecord, session: AcpRecord, runtime: AcpNativeRuntime) {
  const sessionId = session.sessionId, modern = initialized.protocolGeneration === 2, model = acpModelOption(session);
  const set = async (option: AcpRecord, value: string) => { const result = await client.call('session/set_config_option', { sessionId, configId: option.configId ?? option.id, ...(modern ? { type: 'id' } : {}), value }); if (Array.isArray(result.configOptions)) session.configOptions = result.configOptions; };
  const current = model?.currentValue ?? session.models?.currentModelId, target = runtime.model === runtime.defaultModel ? current : runtime.model;
  if (model && target && target !== current) { if (!acpConfigValues(model).includes(target)) throw new Error('ACP 原生模型已改变，请重新选择'); await set(model, target); }
  else if (!model && target && target !== current) { const result = await client.call('session/set_model', { sessionId, modelId: target }); if (Array.isArray(result.configOptions)) session.configOptions = result.configOptions; }
  const effort = acpEffortOption(session);
  if (runtime.effort) { if (!effort || !acpConfigValues(effort).includes(runtime.effort)) throw new Error('ACP 工具未提供此原生推理选项'); if (effort.currentValue !== runtime.effort) await set(effort, runtime.effort); }
  for (const [id, value] of Object.entries(runtime.modelOptions ?? {})) {
    if (id === 'reasoningEffort') continue;
    const option = (session.configOptions ?? []).find((option: AcpRecord) => (option.configId ?? option.id) === id && !['model', 'mode', 'collaboration_mode'].includes(option.category));
    if (!option || typeof value !== 'string' || !acpConfigValues(option).includes(value)) throw new Error('ACP 原生模型选项已改变，请重新选择');
    if (option.currentValue !== value) await set(option, value);
  }
  let selectedMode = runtime.nativeMode;
  if (!selectedMode && runtime.restoreBuildMode) {
    const modeOption = session.configOptions?.find((value: AcpRecord) => ['mode', 'collaboration_mode'].includes(value.category)), current = session.modes?.currentModeId ?? modeOption?.currentValue;
    if (['plan', 'architect'].includes(current)) { const modes: string[] = [...(session.modes?.availableModes ?? []).map((value: AcpRecord) => value.id), ...(modeOption ? acpConfigValues(modeOption) : [])]; selectedMode = [runtime.defaultMode, 'default', 'build', 'agent', 'code'].find((value): value is string => typeof value === 'string' && modes.includes(value) && !['plan', 'architect'].includes(value)); if (!selectedMode) throw new Error('ACP 工具未提供可恢复的原生构建模式'); }
  }
  if (selectedMode) {
    const mode = Array.isArray(session.configOptions) ? session.configOptions.find((value: AcpRecord) => ['mode', 'collaboration_mode'].includes(value.category) && acpConfigValues(value).includes(selectedMode!)) : undefined;
    if (mode) { if (mode.currentValue !== selectedMode) await set(mode, selectedMode); }
    else if (session.modes?.availableModes?.some((value: AcpRecord) => value.id === selectedMode)) { if (session.modes.currentModeId !== selectedMode) await client.call('session/set_mode', { sessionId, modeId: selectedMode }); }
    else throw new Error('ACP 工具未提供所选原生运行模式');
  }
}
type Pending = { resolve(value: AcpRecord): void; written: Promise<void>; dispose(): void; permission: AcpNativePermission; answering: boolean };
type Live = { cancel(): void; start(): Promise<void>; pending: Map<string, Pending> };
export class AcpNativeExecutor implements Executor {
  private runs = new Map<string, Live>();
  constructor(private connection: AcpNativeConnection) {}
  supportsTaskTools(agent: string) { return agent === this.connection.provider; }
  deferredStart(agent: string) { return agent === this.connection.provider; }
  async generateText(request: import('./types.js').TextGenerationRequest) { return this.run(request); }
  async run(request: ExecutionRequest): Promise<string> { return request.purpose ? isolatedTextGeneration(request, prepared => this.runNative(prepared)) : this.runNative(request); }
  private async runNative(request: ExecutionRequest): Promise<string> {
    const { task, signal, update } = request; if (this.runs.has(task.id)) throw new Error('ACP 会话仍在执行');
    const runtime = await this.connection.runtime({ model: task.model, reasoningEffort: task.reasoningEffort, modelOptions: task.modelOptions, interactionMode: request.purpose ? 'plan' : task.interactionMode });
    if (request.purpose) { runtime.clientFiles = false; runtime.autoApprove = false; }
    if (task.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条原生 ACP 会话使用的工具与账号配置');
    if (request.command === 'compact' && !runtime.compactCommand) throw new Error('此 ACP 工具未声明原生压缩命令');
    signal.throwIfAborted(); const lease = await this.connection.client(runtime, task.cwd), { client, initialized } = lease, turn = randomUUID(), projection = new NativeTurnProjection(request, turn);
    let sessionId = task.threadId ?? '', bound = false, active = false, terminal = false, started: Promise<void> | undefined, interruption: Promise<unknown> | undefined, chain = Promise.resolve(), block = 0, current: string | undefined, previousKind = '';
    let resolve!: (value: AcpRecord) => void, reject!: (error: Error) => void; const completion = new Promise<AcpRecord>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
    const finish = (value?: AcpRecord, error?: Error) => { if (!terminal) { terminal = true; error ? reject(error) : resolve(value ?? {}); } };
    const bind = async (id: unknown) => { if (typeof id !== 'string' || !id || id.length > 2000 || sessionId && sessionId !== id) throw new Error('ACP 返回了不同或无效的原生会话标识'); sessionId = id; if (!bound) { await update({ kind: 'session', threadId: sessionId, nativeProviderAccount: runtime.account, model: runtime.model, reasoningEffort: runtime.effort, executionSessionId: randomUUID() }); bound = true; } };
    const start = () => started ??= (async () => { if (!bound) throw new Error('ACP 原生会话尚未持久保存'); signal.throwIfAborted(); await request.beforeStart?.(); })();
    const pending = new Map<string, Pending>();
    const apply = async (params: AcpRecord) => {
      if (!active || terminal || params.sessionId !== sessionId || params._meta?.childSessionId) return;
      let change = acpRecord(params.update); if (!change || change._meta?.childSessionId || change.child_session_id) return;
      const nativePrompt = params._meta?.promptId ?? change._meta?.promptId; if (nativePrompt && nativePrompt !== turn) return;
      change = this.connection.normalize?.(change) ?? change; const kind = change.sessionUpdate;
      if (['agent_message_chunk', 'agent_thought_chunk', 'agent_message_update', 'agent_thought_update'].includes(kind)) {
        const type = kind.includes('thought') ? 'reasoning' : 'message', snapshot = kind.endsWith('_update'), content = textContent(change.content ?? change.message?.content); if (!content && !snapshot) return;
        if (previousKind !== type || !current || snapshot) current = `${type}:${++block}`; previousKind = type;
        projection.put(current, type, snapshot ? content : (projection.items.get(current)?.text ?? '') + content, { phase: 'commentary' });
      } else if (['tool_call', 'tool_call_update'].includes(kind) && typeof change.toolCallId === 'string') {
        current = undefined; previousKind = ''; const key = 'tool:' + change.toolCallId, previous = projection.items.get(key), input = acpRecord(change.rawInput), type = change.kind === 'execute' || previous?.kind === 'command' ? 'command' : ['edit', 'delete', 'move'].includes(change.kind) ? 'files' : ['read', 'search', 'fetch'].includes(change.kind) ? 'search' : previous?.kind ?? 'tool';
        projection.put(key, type, type === 'command' && typeof input?.command === 'string' ? input.command : change.title ?? previous?.text ?? change.toolCallId, { status: change.status === 'completed' ? 'completed' : change.status === 'failed' ? 'failed' : previous?.status ?? 'running', detail: textContent(change.content) || textContent(change.rawOutput) || previous?.detail, ...(Number.isSafeInteger(change.nativeExitCode) ? { exitCode: change.nativeExitCode } : {}) });
      } else if (kind === 'tool_call_content_chunk' && typeof change.toolCallId === 'string') { const key = 'tool:' + change.toolCallId, previous = projection.items.get(key); projection.put(key, previous?.kind ?? 'tool', previous?.text ?? change.toolCallId, { detail: (previous?.detail ?? '') + textContent(change.content) }); }
      else if (kind === 'plan' && Array.isArray(change.entries)) projection.put('plan', 'plan', 'Plan', { plan: taskPlanSteps(change.entries.map((value: AcpRecord) => ({ step: value.content, status: value.status === 'in_progress' ? 'inProgress' : value.status }))) });
      else if (kind === 'usage_update' && Number.isFinite(change.used) && change.used >= 0) await update({ kind: 'contextUsage', usage: { usedTokens: change.used, maxTokens: Number.isFinite(change.size) && change.size > 0 ? change.size : null, updatedAt: new Date().toISOString(), model: runtime.model } });
      else if (initialized.protocolGeneration === 2 && kind === 'state_update' && change.state === 'idle') finish({ stopReason: change.stopReason ?? 'end_turn' });
    };
    const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(error => finish(undefined, error instanceof Error ? error : new Error('ACP 输出失败'))); };
    client.onNotification = (method, params) => { if (method === 'session/update' && acpRecord(params)) enqueue(() => apply(params as AcpRecord)); };
    client.onExit = error => finish(undefined, error);
    client.onRequest = async context => {
      if (request.purpose) { const error = new Error('独立文字生成不接受工具或交互式请求'); finish(undefined, error); throw RequestError.invalidRequest(error.message); }
      if (terminal || signal.aborted) { if (context.method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }; throw RequestError.invalidRequest('Native turn has ended'); }
      const params = acpRecord(context.params); if (!params) throw RequestError.invalidParams();
      if (params.sessionId && (!sessionId || params.sessionId === sessionId)) await bind(params.sessionId);
      if (params.sessionId !== sessionId) throw RequestError.invalidParams('Request belongs to another session');
      if (['fs/read_text_file', 'fs/write_text_file'].includes(context.method) && runtime.clientFiles && this.connection.clientFile) { if (context.method === 'fs/write_text_file') await start(); return this.connection.clientFile(runtime, task.cwd, context.method, params); }
      if (context.method !== 'session/request_permission') throw RequestError.methodNotFound(context.method);
      const value = acpPermissionRequest(params, context.requestId), permission = this.connection.permission?.(value) ?? acpNativePermission(value), id = `${runtime.provider}:${turn}:${randomUUID()}`, receipt = client.watchReply(context.requestId);
      const automatic = ['accept', 'acceptForSession'].find(value => permission.decisions.includes(value as ApprovalDecision)) as ApprovalDecision | undefined;
      if (runtime.autoApprove && !permission.questions?.length && automatic) { await start(); receipt.dispose(); return permission.respond(automatic, {}); }
      let resolve!: (value: AcpRecord) => void; const result = new Promise<AcpRecord>(yes => { resolve = yes; }); pending.set(id, { resolve, ...receipt, permission, answering: false });
      await projection.flush(); await update({ kind: 'approval', approval: { id, method: 'session/request_permission', title: value.toolCall?.title ?? '需要你的授权', detail: textContent(value.toolCall?.content) || JSON.stringify(value.toolCall?.rawInput ?? {}), questions: permission.questions ?? [], decisions: permission.decisions, ...(permission.options ? { options: permission.options } : {}), state: 'pending' } });
      return result;
    };
    const cancel = () => { interruption ??= (async () => { try { if (sessionId) await client.notify('session/cancel', { sessionId }); } catch {} finally { await new Promise(resolve => setTimeout(resolve, 250)); await client.close(); finish(undefined, cancellation()); } })(); };
    this.runs.set(task.id, { cancel, start, pending }); signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted(); if (runtime.authenticateEagerly && runtime.authMethod) await acpNativeAuthenticate(client, initialized, runtime.authMethod);
      const servers = request.taskMcp ? [await acpMcpServer(this.connection.directory, request.taskMcp, initialized.agentCapabilities?.mcpCapabilities?.http === true)] : [];
      const session = await acpNativeSession(client, initialized, { cwd: task.cwd, sessionId: task.threadId, resumeMethod: runtime.resumeMethod, mcpServers: servers }); await bind(session.sessionId ?? sessionId); if (task.threadId) await update({ kind: 'resumeApplied' });
      await acpNativeSelection(client, initialized, { ...session, sessionId }, runtime);
      const images = []; for (const image of request.images ?? []) { if (initialized.agentCapabilities?.promptCapabilities?.image !== true) throw new Error('ACP 工具未声明原生图片输入能力'); images.push({ type: 'image', data: (await readFile(image.path)).toString('base64'), mimeType: image.mediaType }); }
      await chain; await start(); signal.throwIfAborted(); await update({ kind: 'turn', turnId: turn }); active = true; await update({ kind: 'ready', canSteer: false });
      const prompt = client.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: request.command === 'compact' ? '/' + runtime.compactCommand : request.prompt }, ...images], _meta: { promptId: turn } }, null);
      void prompt.then(value => { if (typeof value.stopReason === 'string') enqueue(async () => finish(value)); }, error => enqueue(async () => finish(undefined, error)));
      const result = await completion; await chain; if (signal.aborted || result.stopReason === 'cancelled') throw cancellation(); if (!result.stopReason || ['error', 'rate_limit'].includes(result.stopReason)) throw new Error(typeof result._meta?.message === 'string' ? result._meta.message : 'ACP 原生执行失败');
      return await projection.finish('completed');
    } catch (error) { await projection.finish(signal.aborted ? 'interrupted' : 'failed'); throw signal.aborted ? cancellation() : error; }
    finally { active = false; signal.removeEventListener('abort', cancel); for (const value of pending.values()) value.resolve({ outcome: { outcome: 'cancelled' } }); await interruption; projection.dispose(); await lease.close(); for (const value of pending.values()) value.dispose(); await chain; this.runs.delete(task.id); }
  }
  async answer(taskId: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const run = this.runs.get(taskId), pending = run?.pending.get(approvalId); if (!run || !pending || pending.answering) throw new Error('ACP 授权已经结束或正在回答');
    if (!pending.permission.decisions.includes(decision)) throw new Error('ACP 工具未提供此回答选项'); const value = pending.permission.respond(decision, answers); await run.start(); pending.answering = true; pending.resolve(value);
    try { await pending.written; run.pending.delete(approvalId); } finally { pending.dispose(); }
  }
  async steer(_task: string, _text: string, _requestId: string, _images?: ExecutionImage[]): Promise<void> { throw new Error('此 ACP 接入请使用队列补充消息'); }
  async close() { for (const run of this.runs.values()) run.cancel(); await this.connection.close(); }
}
