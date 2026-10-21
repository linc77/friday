import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { MuseConnection, type MuseProcess } from './muse-provider.js';
import { NativeTurnProjection } from './native-turn-projection.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { taskPlanSteps } from './task-event-data.js';
import type { Approval, ExecutionImage, ExecutionRequest, Executor } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';

// Native control behavior follows T3 8cd9641f provider-muse/adapter and protocol.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export function museApprovalChoices(value: AcpRecord): Map<ApprovalDecision, AcpRecord> {
  const choices = new Map<ApprovalDecision, AcpRecord>();
  const rank = (choice: AcpRecord) => (choice.scope === 'once' ? 0 : choice.scope === 'session' ? 2 : 4) + (choice.decision.endsWith('PolicyAmendment') ? 1 : 0);
  for (const choice of Array.isArray(value.availableChoices) ? value.availableChoices : []) {
    if (typeof choice?.choiceId !== 'string' || typeof choice.decision !== 'string') continue;
    const decision: ApprovalDecision | undefined = choice.decision === 'approved' ? 'accept' : choice.decision === 'approvedForSession' ? 'acceptForSession'
      : choice.decision === 'approvedPolicyAmendment' ? choice.scope === 'session' ? 'acceptForSession' : choice.scope === 'localPersistent' ? 'acceptAlways' : undefined
      : ['denied', 'deniedPolicyAmendment'].includes(choice.decision) ? 'decline' : choice.decision === 'abort' ? 'cancel' : undefined;
    if (decision && (!choices.has(decision) || rank(choice) < rank(choices.get(decision)!))) choices.set(decision, choice);
  }
  if (!choices.has('decline') && choices.has('cancel')) choices.set('decline', choices.get('cancel')!);
  return choices;
}
export function museQuestionAnswers(questions: AcpRecord[], answers: Record<string, string[]>) {
  return questions.map(question => {
    const raw = answers[question.id]; if (!Array.isArray(raw) || raw.some(value => typeof value !== 'string')) throw new Error('Muse 回答格式无效');
    const values = [...new Set(raw)], selected = values.filter(value => question.options.some((option: AcpRecord) => option.label === value)), freeText = values.filter(value => !selected.includes(value)).join('\n'), selection = acpRecord(question.selection);
    if ((!freeText && !selected.length) || freeText.length > 500 || selection?.mode === 'single' && selected.length > 1 || selected.length && (selected.length < (selection?.minSelections ?? 0) || selected.length > (selection?.maxSelections ?? Infinity))) throw new Error('Muse 回答的选项数量或补充文字无效');
    return { questionId: question.id, ...(selected.length ? selection?.mode === 'single' ? { selectedLabel: selected[0] } : { selectedLabels: selected } : {}), ...(freeText ? selected.length ? { note: freeText } : { freeText } : {}) };
  });
}
type Pending = { approval: Approval; value: AcpRecord; kind: 'approval' | 'question'; responding: boolean; command?: { body: string; id: string } };
type Live = { client: MuseProcess; sessionId: string; turnId: string; pending: Map<string, Pending>; cancel: () => void; projection: NativeTurnProjection; model: string; effort: string; cwd: string; steers: Map<string, { body: string; result: Promise<void> }> };
const cancelled = () => new Error('任务已中止');
const status = (value: unknown) => value === 'inProgress' ? 'running' as const : value === 'completed' ? 'completed' as const : value === 'cancelled' ? 'interrupted' as const : 'failed' as const;

export class MuseExecutor implements Executor {
  private runs = new Map<string, Live>();
  constructor(private connection: MuseConnection) {}
  supportsTaskTools(agent: string) { return agent === 'muse'; }
  deferredStart(agent: string) { return agent === 'muse'; }
  async run(request: ExecutionRequest): Promise<string> {
    const { task, signal, update } = request;
    if (this.runs.has(task.id)) throw new Error('Muse 会话仍在执行');
    if (task.interactionMode === 'plan') throw new Error('Muse 未提供专用计划模式');
    const runtime = await this.connection.runtime({ model: task.model, reasoningEffort: task.reasoningEffort });
    if (task.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 Muse 会话使用的账号配置');
    signal.throwIfAborted();
    const cwd = await realpath(task.cwd), client = await this.connection.client(runtime.settings, cwd);
    const sessionId = task.threadId ?? client.connection.mintCommandId(), nativeTurnId = client.connection.mintCommandId(), projection = new NativeTurnProjection(request, nativeTurnId);
    let resolve!: (value: AcpRecord) => void, reject!: (error: Error) => void, terminal = false, active = false, interruption: Promise<unknown> | undefined;
    const completion = new Promise<AcpRecord>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
    const finish = (value?: AcpRecord, error?: Error) => { if (!terminal) { terminal = true; error ? reject(error) : resolve(value ?? {}); } };
    let chain = Promise.resolve(); const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(error => finish(undefined, error instanceof Error ? error : new Error('Muse 更新失败'))); };
    const items = new Map<string, AcpRecord>(), pending = new Map<string, Pending>();
    const owned = (value: AcpRecord) => value.sessionId === sessionId && !value.subagentOrigin && (!value.turnId || value.turnId === nativeTurnId);
    const publish = (item: AcpRecord) => {
      if (['userMessage', 'reminderChild'].includes(item.kind)) return;
      const text = item.text ?? item.summary?.join('\n') ?? item.fallbackText ?? '', state = status(item.status);
      if (item.kind === 'agentMessage' || item.kind === 'reasoning') {
        projection.put(item.itemId, item.kind === 'agentMessage' ? 'message' : 'reasoning', text, { status: state }); return;
      }
      if (item.kind === 'toolCall' && ['write_todos', 'request_user_input', 'workflow'].includes(item.tool) && state !== 'failed') return;
      let args: AcpRecord | undefined; try { args = acpRecord(JSON.parse(item.args ?? '{}')); } catch { /* Opaque native arguments stay visible as text. */ }
      const command = item.kind === 'userShell' || /shell|bash|exec_command/i.test(item.tool ?? ''), kind = item.kind === 'compaction' ? 'compaction' : command ? 'command' : /write|edit|patch/i.test(item.tool ?? '') ? 'files' : /web|browse|fetch|search|read/i.test(item.tool ?? '') ? 'search' : 'tool';
      const body = command ? item.commandText ?? args?.command ?? args?.cmd ?? item.args ?? '' : item.tool ?? item.objective ?? item.kind;
      const detail = item.visibleOutput ?? item.result?.summary ?? text;
      projection.put(item.itemId, kind, body, { status: state, detail: [item.failureReason, detail].filter(Boolean).join('\n'), ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}), ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}), ...(item.truncated ? { detailTruncated: true } : {}) });
    };
    const publishRequest = async (kind: 'approval' | 'question', value: AcpRecord) => {
      if (!active || terminal || !owned(value)) return;
      const nativeId = kind === 'approval' ? value.approvalId : value.userInputId;
      if (typeof nativeId !== 'string') throw new Error('Muse 返回了无效的问题标识');
      const id = `muse:${kind}:${nativeId}:${kind === 'approval' ? value.currentRequirementId?.sourceIndex ?? 0 : 0}`;
      for (const [key, previous] of pending) if (key !== id && previous.kind === kind && (kind === 'approval' ? previous.value.approvalId : previous.value.userInputId) === nativeId) { pending.delete(key); await update({ kind: 'approvalResolved', id: key }); }
      const choices = museApprovalChoices(value), decisions = [...choices].filter(([decision, choice]) => decision !== 'cancel' || choice.choiceId !== choices.get('decline')?.choiceId).map(([decision]) => decision);
      if (kind === 'question' && (!Array.isArray(value.questions) || !value.questions.length)) throw new Error('Muse 返回了无效的问题');
      const approval: Approval = { id, method: kind === 'approval' ? 'muse/approval/request' : 'muse/userInput/request', title: kind === 'approval' ? '需要你的授权' : '需要你的补充', detail: kind === 'approval' ? [value.toolName, value.rawArgs, value.subject?.command, value.subject?.path].filter(Boolean).join('\n') : '', state: 'pending', questions: [],
        ...(kind === 'approval' ? { decisions } : { questions: value.questions.map((question: AcpRecord) => ({ id: question.id, header: question.header ?? '', question: question.question, multiSelect: question.selection?.mode === 'multiple', isOther: true, isSecret: false, options: question.options.map((option: AcpRecord) => ({ label: option.label, description: option.description ?? '' })) })) }) };
      pending.set(id, { approval, value, kind, responding: false }); await projection.flush(); await update({ kind: 'approval', approval });
    };
    client.onNotification = (method, value) => enqueue(async () => {
      if (!active || terminal || value.sessionId !== sessionId) return;
      if (method === 'view/gap') throw new Error('Muse 原生事件流出现缺口，已停止；不会猜测缺失的执行结果');
      if (!owned(value)) return;
      if (['item/started', 'item/updated', 'item/completed'].includes(method)) {
        const item = acpRecord(value.item);
        if (!item || typeof item.itemId !== 'string' || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error('Muse 原生输出格式无效');
        if (item.turnId && item.turnId !== nativeTurnId) return;
        if ((items.get(item.itemId)?.revision ?? 0) >= item.revision) return;
        items.set(item.itemId, item); publish(item);
        if (request.command === 'compact' && item.kind === 'compaction' && item.status !== 'inProgress') finish({ terminal: item.status === 'completed' && (!item.outcome || item.outcome === 'compacted') ? 'completed' : 'failed', reason: item.failureReason ?? item.reason });
      } else if (method === 'item/delta') {
        const previous = items.get(value.itemId); if (!previous || previous.status !== 'inProgress' || typeof value.delta !== 'string') return;
        const field = value.field ?? 'text', item = { ...previous };
        if (field === 'text') item.text = (item.text ?? '') + value.delta;
        else if (['visibleOutput', 'output'].includes(field)) item.visibleOutput = (item.visibleOutput ?? '') + value.delta;
        else if (/^summary\.\d+$/.test(field)) { const index = Number(field.slice(8)); if (index >= 100) return; item.summary = [...(item.summary ?? [])]; item.summary[index] = (item.summary[index] ?? '') + value.delta; }
        else return;
        items.set(item.itemId, item); publish(item);
      } else if (method === 'turn/completed' && value.turnId === nativeTurnId && request.command !== 'compact') finish(value);
      else if (['approval/requested', 'approval/updated'].includes(method)) await publishRequest('approval', value);
      else if (method === 'userInput/requested') await publishRequest('question', value);
      else if (['approval/resolved', 'userInput/settled'].includes(method)) {
        for (const [id, entry] of pending) if (entry.kind === 'approval' ? entry.value.approvalId === value.approvalId : entry.value.userInputId === value.userInputId) { pending.delete(id); await update({ kind: 'approvalResolved', id }); }
      } else if (method === 'session/contextUsage' && Number.isFinite(value.usedTokens) && value.usedTokens >= 0) await update({ kind: 'contextUsage', usage: { usedTokens: value.usedTokens, maxTokens: Number.isFinite(value.windowTokens) && value.windowTokens > 0 ? value.windowTokens : null, updatedAt: new Date().toISOString(), model: runtime.model } });
      else if (method === 'session/todoListChanged' && Array.isArray(value.items)) projection.put('todo', 'plan', 'Plan', { plan: taskPlanSteps(value.items.filter((item: AcpRecord) => item.status !== 'cancelled').map((item: AcpRecord) => ({ step: item.text, status: item.status }))) });
    });
    client.onFailure = error => finish(undefined, error);
    const cancel = () => {
      if (interruption) return;
      interruption = (async () => { let timer: NodeJS.Timeout | undefined; try { await Promise.race([client.call('turn/interrupt', { sessionId, turnId: nativeTurnId }, true), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); } catch { /* Process shutdown still owns cancellation. */ } finally { clearTimeout(timer); await client.close(); finish(undefined, cancelled()); } })();
    };
    this.runs.set(task.id, { client, sessionId, turnId: nativeTurnId, pending, cancel, projection, model: runtime.model, effort: runtime.effort, cwd, steers: new Map() });
    signal.addEventListener('abort', cancel, { once: true });
    try {
      await update({ kind: 'session', threadId: sessionId, model: runtime.model, reasoningEffort: runtime.effort, nativeProviderAccount: runtime.account, executionSessionId: randomUUID() });
      if (signal.aborted) throw cancelled();
      if (request.taskMcp && !client.host!.initializeResult.grantedCapabilities.includes('sessionMcp')) throw new Error('Muse 尚未支持会话 MCP，请升级主机上的 Muse');
      const config = request.taskMcp ? { mcpServers: { friday: { transport: 'streamableHttp', mode: 'optional', url: request.taskMcp.url, headers: request.taskMcp.headers } } } : undefined;
      const permissionProfile = runtime.settings.permissionMode === 'auto' ? ':unrestricted' : ':ask-me', approvalMode = runtime.settings.permissionMode === 'auto' ? 'allowAll' : 'promptUnmatched';
      const setup = await client.call(task.threadId ? 'session/resume' : 'session/start', { sessionId, ...(task.threadId ? { excludeItems: true } : { workspaceRoot: cwd, modelId: runtime.model, providerId: 'meta', approvalMode }), permissionProfile, ...(config ? { config } : {}) }, true);
      if (acpRecord(setup.session)?.sessionId !== sessionId) throw new Error('Muse 返回了不同的原生会话 ID，已停止执行');
      if (task.threadId) { await client.call('session/setApprovalMode', { sessionId, mode: approvalMode }, true); await update({ kind: 'resumeApplied' }); }
      if (acpRecord(setup.session)?.modelId !== runtime.model) await client.call('session/setModel', { sessionId, model: { modelId: runtime.model, providerId: 'meta' } }, true);
      await request.beforeStart?.(); if (signal.aborted) throw cancelled();
      await update({ kind: 'turn', turnId: nativeTurnId }); active = true; await update({ kind: 'ready', canSteer: request.command !== 'compact' });
      if (request.command === 'compact') {
        const result = await client.call('session/compact', { sessionId }, true, nativeTurnId);
        if (result.status !== 'accepted') throw new Error(typeof result.reason === 'string' ? result.reason : 'Muse 未接受上下文压缩');
      } else {
        const input: AcpRecord[] = [{ type: 'text', text: request.prompt }];
        for (const image of request.images ?? []) input.push({ type: 'image', base64Data: (await readFile(image.path)).toString('base64'), mediaType: image.mediaType });
        const result = await client.call('turn/start', { sessionId, input, displayText: request.prompt || 'Image attachment', workspaceRoots: [cwd], ifBusy: 'queue', ...(runtime.effort ? { reasoningEffort: runtime.effort } : {}) }, true, nativeTurnId);
        if (result.turnId !== nativeTurnId) throw new Error('Muse 未使用已保存的原生回合 ID，已停止执行');
      }
      const result = await completion; await chain;
      if (signal.aborted || result.terminal === 'cancelled') throw cancelled();
      if (result.terminal !== 'completed') throw new Error(result.error?.message ?? result.reason ?? 'Muse 原生执行失败');
      return await projection.finish('completed');
    } catch (error) { await projection.finish(signal.aborted ? 'interrupted' : 'failed'); throw signal.aborted ? cancelled() : error; }
    finally { signal.removeEventListener('abort', cancel); active = false; projection.dispose(); await interruption; await this.connection.release(client); await chain; this.runs.delete(task.id); }
  }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const run = this.runs.get(id), pending = run?.pending.get(approvalId);
    if (!run || !pending || pending.responding) throw new Error('Muse 问题已经结束或正在回答');
    let method: string, params: AcpRecord;
    if (pending.kind === 'approval') {
      const choice = museApprovalChoices(pending.value).get(decision); if (!choice) throw new Error('Muse 未提供此授权选项');
      method = 'approval/decide'; params = { sessionId: run.sessionId, approvalId: pending.value.approvalId, requirementId: pending.value.currentRequirementId, choiceId: choice.choiceId };
    } else {
      if (decision !== 'accept') throw new Error('Muse 问题需要回答选项；如需取消请停止当前任务');
      method = 'userInput/answer'; params = { sessionId: run.sessionId, userInputId: pending.value.userInputId, answers: museQuestionAnswers(pending.value.questions, answers) };
    }
    const body = JSON.stringify([method, params]); if (pending.command?.body !== body) pending.command = { body, id: run.client.connection.mintCommandId() };
    pending.responding = true;
    try { await run.client.call(method, params, true, pending.command.id); }
    finally { pending.responding = false; }
  }
  async steer(id: string, text: string, requestId: string, images?: ExecutionImage[]) {
    const run = this.runs.get(id); if (!run) throw new Error('Muse 当前没有可补充的原生回合');
    const input: AcpRecord[] = [{ type: 'text', text }]; for (const image of images ?? []) input.push({ type: 'image', base64Data: (await readFile(image.path)).toString('base64'), mediaType: image.mediaType });
    const params = { sessionId: run.sessionId, expectedTurnId: run.turnId, input }, body = JSON.stringify(params), previous = run.steers.get(requestId);
    if (previous) { if (previous.body !== body) throw new Error('补充请求 ID 已用于不同的 Muse 输入'); return previous.result; }
    const result = (async () => { const result = await run.client.call('turn/steer', params, true); if (result.turnId !== run.turnId) throw new Error('Muse 补充请求未确认原生回合'); })();
    run.steers.set(requestId, { body, result }); return result;
  }
  async close() { for (const run of this.runs.values()) run.cancel(); await this.connection.close(); }
}
