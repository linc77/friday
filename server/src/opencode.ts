import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { OpenCodeConnection, openCodeData } from './opencode-provider.js';
import { type OpenCodeServer } from './opencode-server.js';
import { NativeTurnProjection } from './native-turn-projection.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { taskPlanSteps } from './task-event-data.js';
import type { ExecutionRequest, Executor, Approval, ExecutionImage } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';

// Protocol and permission behavior follow T3 8cd9641f provider-opencode adapters.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
const cancelled = () => new Error('任务已中止');
const promptId = (session: string, request: string) => 'msg_friday_' + createHash('sha256').update(JSON.stringify([session, request])).digest('hex');
export function openCodeRules(generation: 1 | 2, mode: string, plan: boolean, mcp?: string): AcpRecord[] {
  if (generation === 1) {
    if (mode === 'auto') return [{ permission: '*', pattern: '*', action: 'allow' }];
    const restricted = ['bash', 'edit', 'webfetch', 'websearch', 'codesearch', 'external_directory', 'doom_loop'];
    return [{ permission: '*', pattern: '*', action: 'deny' }, ...restricted.map(permission => ({ permission, pattern: '*', action: 'deny' })), { permission: '*', pattern: '*', action: 'ask' }, ...restricted.map(permission => ({ permission, pattern: '*', action: 'ask' })),
      ...['question', 'read', 'glob', 'grep', 'lsp', 'todowrite', 'task', 'skill'].map(permission => ({ permission, pattern: '*', action: 'allow' })), { permission: 'read', pattern: '*.env', action: 'ask' }, { permission: 'read', pattern: '*.env.*', action: 'ask' }, { permission: 'read', pattern: '*.env.example', action: 'allow' }, ...(plan ? [{ permission: 'edit', pattern: '*', action: 'deny' }] : [])];
  }
  return [...(mode === 'auto' ? [{ action: '*', resource: '*', effect: 'allow' }] : ['shell', 'edit', 'external_directory'].map(action => ({ action, resource: '*', effect: 'ask' }))), ...(plan ? [{ action: 'edit', resource: '*', effect: 'deny' }] : []), ...(mcp ? [{ action: 'friday-*', resource: '*', effect: 'deny' }, { action: `${mcp}_*`, resource: '*', effect: 'allow' }] : [])];
}
type Pending = { value: AcpRecord; kind: 'permission' | 'question' | 'form'; approval: Approval; answering: boolean };
type Live = { server: OpenCodeServer; sessionId: string; nativeId: string; pending: Map<string, Pending>; rules: AcpRecord[]; cancel: () => void; steers: Map<string, { body: string; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }> };

export class OpenCodeExecutor implements Executor {
  private runs = new Map<string, Live>();
  constructor(private connection: OpenCodeConnection) {}
  supportsTaskTools(agent: string) { return agent === 'opencode'; }
  deferredStart(agent: string) { return agent === 'opencode'; }
  async run(request: ExecutionRequest) {
    const { task, signal, update } = request;
    if (this.runs.has(task.id)) throw new Error('OpenCode 会话仍在执行');
    const runtime = await this.connection.runtime({ model: task.model, reasoningEffort: task.reasoningEffort, modelOptions: task.modelOptions });
    if (task.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 OpenCode 会话使用的账号配置');
    signal.throwIfAborted(); const lease = await this.connection.server(runtime.settings, task.cwd, task.id), server = lease.server, v1 = server.v1, v2 = server.v2;
    let sessionId = task.threadId ?? '', nativeId = '', projection: NativeTurnProjection | undefined, active = false, delivered = false, admission = false, idle = false, succeeded = false, terminal = false, interruption: Promise<unknown> | undefined, chain = Promise.resolve();
    let resolve!: () => void, reject!: (error: Error) => void;
    const completion = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
    const finish = (error?: Error) => { if (!terminal) { terminal = true; error ? reject(error) : resolve(); } };
    const pending = new Map<string, Pending>(), infos = new Map<string, AcpRecord>(), parts = new Map<string, AcpRecord>(), earlyParts = new Map<string, AcpRecord[]>(), tools = new Map<string, AcpRecord>();
    const mcpName = 'friday-' + createHash('sha256').update(task.id).digest('hex').slice(0, 16), mcp = !!request.taskMcp && !!server.child;
    const rules = openCodeRules(server.generation, runtime.settings.permissionMode, task.interactionMode === 'plan', mcp ? mcpName : undefined);
    const ownInfo = (id: string) => infos.get(id)?.role === 'assistant' && infos.get(id)?.parentID === nativeId;
    const settleV1 = () => { if (delivered && admission && idle && [...infos.values()].some(info => ownInfo(info.id) && info.time?.completed && info.finish !== 'tool-calls')) finish(); };
    const publishPart = (part: AcpRecord) => {
      if (!projection || !ownInfo(part.messageID)) return;
      parts.set(part.id, part);
      if (part.type === 'text' || part.type === 'reasoning') projection.put(part.id, part.type === 'text' ? 'message' : 'reasoning', part.text ?? '', { status: part.time?.end ? 'completed' : 'running' });
      else if (part.type === 'tool') {
        const state = acpRecord(part.state), name = typeof part.tool === 'string' ? part.tool : 'Tool', input = acpRecord(state?.input), kind = name === 'bash' || name === 'shell' ? 'command' : /edit|write|patch/i.test(name) ? 'files' : /read|grep|glob|search|fetch/i.test(name) ? 'search' : 'tool';
        projection.put(part.id, kind, kind === 'command' ? input?.command ?? state?.title ?? name : state?.title ?? input?.path ?? name, { status: state?.status === 'completed' ? 'completed' : state?.status === 'error' ? 'failed' : 'running', detail: typeof state?.output === 'string' ? state.output : typeof state?.error === 'string' ? state.error : '', ...(typeof state?.metadata?.exit === 'number' ? { exitCode: state.metadata.exit } : {}) });
      }
    };
    const publishRequest = async (kind: Pending['kind'], value: AcpRecord) => {
      if (!active || terminal || value.sessionID !== sessionId) return;
      const native = value.id, id = `opencode:${kind}:${native}`; if (typeof native !== 'string' || pending.has(id)) return;
      let questions: AcpRecord[] = [], decisions: ApprovalDecision[] | undefined;
      if (kind === 'permission') decisions = ['cancel', 'decline', ...(server.generation === 1 || value.save?.length ? ['acceptForSession' as const] : []), 'accept'];
      else if (kind === 'question') questions = (value.questions ?? []).map((question: AcpRecord, index: number) => ({ id: `q${index}`, header: question.header ?? '', question: question.question, multiSelect: question.multiple === true, isOther: question.custom !== false, isSecret: false, options: question.options ?? [] }));
      else {
        for (const [index, field] of (Array.isArray(value.fields) ? value.fields : []).entries()) {
          if (!['string', 'multiselect'].includes(field.type) || field.hidden || field.when?.length) { await v2!.session.form.cancel({ sessionID: sessionId, formID: native }); throw new Error('OpenCode 请求了当前界面不能显示的表单，已拒绝'); }
          questions.push({ id: field.key, header: field.title || `Question ${index + 1}`, question: field.description || field.title || `Question ${index + 1}`, multiSelect: field.type === 'multiselect', isOther: field.custom === true || !field.options?.length, isSecret: false, options: (field.options ?? []).map((option: AcpRecord) => ({ label: option.label || option.value, description: option.description || option.label || option.value })) });
        }
      }
      const approval: Approval = { id, method: `opencode/${kind}`, title: kind === 'permission' ? '需要你的授权' : '需要你的补充', detail: kind === 'permission' ? [value.action ?? value.permission, ...(value.resources ?? value.patterns ?? [])].filter(Boolean).join('\n') : '', state: 'pending', questions: questions as Approval['questions'], ...(decisions ? { decisions } : {}) };
      pending.set(id, { value, kind, approval, answering: false }); await projection?.flush(); await update({ kind: 'approval', approval });
    };
    const apply = async (event: AcpRecord) => {
      if (!active || terminal || !projection) return;
      const data = acpRecord(event.data ?? event.properties); if (!data) return;
      const eventSession = data.sessionID ?? data.part?.sessionID ?? data.info?.sessionID ?? data.form?.sessionID;
      if (eventSession !== sessionId) return;
      if (server.generation === 2) {
        if (event.type === 'session.inbox.delivered') {
          if (data.inboxID === nativeId) delivered = true;
          const steer = this.runs.get(task.id)?.steers.get(data.inboxID); steer?.resolve(); return;
        }
        if (event.type === 'session.inbox.cancelled') { this.runs.get(task.id)?.steers.get(data.inboxID)?.reject(new Error('OpenCode 未交付补充消息')); if (data.inboxID === nativeId) finish(cancelled()); return; }
        if (!delivered) return;
        if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
          const kind = event.type.startsWith('session.text.') ? 'message' : 'reasoning', key = `${kind}:${data.assistantMessageID}:${data.ordinal}`;
          projection.put(key, kind, typeof data.text === 'string' ? data.text : (projection.items.get(key)?.text ?? '') + (data.delta ?? ''), { status: event.type.endsWith('.ended') ? 'completed' : 'running' });
        } else if (event.type === 'session.tool.input.started') tools.set(data.id, { name: data.name, input: {} });
        else if (event.type === 'session.tool.input.ended') { const tool = tools.get(data.id); if (tool) tool.input = data.input; }
        else if (['session.tool.called', 'session.tool.success', 'session.tool.failed'].includes(event.type)) {
          if (event.type === 'session.tool.called' && tools.has(data.id) && acpRecord(data.input)) tools.get(data.id)!.input = data.input;
          const tool = tools.get(data.id), name = tool?.name ?? 'Tool', input = acpRecord(tool?.input), kind = name === 'shell' ? 'command' : /edit|write|patch/.test(name) ? 'files' : /read|grep|glob|search/.test(name) ? 'search' : 'tool';
          const text = Array.isArray(data.content) ? data.content.filter((part: AcpRecord) => part.type === 'text').map((part: AcpRecord) => part.text).join('\n') : '';
          projection.put(`tool:${data.id}`, kind, kind === 'command' ? input?.command ?? name : input?.path ?? name, { status: event.type === 'session.tool.success' ? 'completed' : event.type === 'session.tool.failed' ? 'failed' : 'running', detail: data.error?.message ?? text, ...(typeof data.metadata?.exitCode === 'number' ? { exitCode: data.metadata.exitCode } : {}) });
        } else if (event.type === 'session.execution.succeeded') finish();
        else if (event.type === 'session.execution.interrupted') finish(cancelled());
        else if (event.type === 'session.execution.failed') finish(new Error(data.error?.message ?? 'OpenCode 原生执行失败'));
        else if (event.type === 'permission.asked') await publishRequest('permission', data);
        else if (event.type === 'form.created') await publishRequest('form', data.form);
        else if (event.type === 'session.compaction.started') projection.put('compaction', 'compaction', '', { status: 'running' });
        else if (event.type === 'session.compaction.ended') projection.put('compaction', 'compaction', data.text ?? '', { status: 'completed' });
        else if (event.type === 'session.compaction.failed') { projection.put('compaction', 'compaction', '', { status: 'failed' }); if (request.command === 'compact') finish(new Error('OpenCode 原生压缩失败')); }
        else if (['session.step.ended', 'session.step.failed'].includes(event.type) && data.tokens) {
          const tokens = data.tokens, used = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
          if (Number.isFinite(used) && used >= 0) await update({ kind: 'contextUsage', usage: { usedTokens: used, maxTokens: runtime.contextWindow ?? null, updatedAt: new Date().toISOString(), model: runtime.model } });
        }
      } else {
        if (event.type === 'message.updated') {
          const info = acpRecord(data.info); if (!info || typeof info.id !== 'string') return; infos.set(info.id, info);
          if (info.id === nativeId && info.role === 'user') delivered = true;
          if (ownInfo(info.id)) {
            for (const part of earlyParts.get(info.id) ?? []) publishPart(part); earlyParts.delete(info.id);
            if (info.error) finish(new Error(info.error.data?.message ?? info.error.name ?? 'OpenCode 原生执行失败'));
            const tokens = info.tokens, used = tokens ? (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) : undefined;
            if (Number.isFinite(used)) await update({ kind: 'contextUsage', usage: { usedTokens: used, maxTokens: runtime.contextWindow ?? null, updatedAt: new Date().toISOString(), model: runtime.model } });
            settleV1();
          }
        } else if (event.type === 'message.part.updated') {
          const part = acpRecord(data.part); if (!part || typeof part.id !== 'string') return;
          parts.set(part.id, part);
          if (ownInfo(part.messageID)) publishPart(part); else { const list = earlyParts.get(part.messageID) ?? []; list.push(part); earlyParts.set(part.messageID, list); }
        } else if (event.type === 'message.part.delta') {
          const previous = parts.get(data.partID); if (previous && typeof data.delta === 'string' && data.field === 'text') { const part: AcpRecord = { ...previous, text: (previous.text ?? '') + data.delta }; parts.set(part.id, part); if (ownInfo(part.messageID)) publishPart(part); else { const list = earlyParts.get(part.messageID) ?? []; list.push(part); earlyParts.set(part.messageID, list); } }
        } else if (event.type === 'session.idle' || event.type === 'session.status' && data.status?.type === 'idle') {
          if (delivered) idle = true; settleV1();
        } else if (event.type === 'permission.asked' || event.type === 'permission.updated') await publishRequest('permission', data);
        else if (event.type === 'question.asked') await publishRequest('question', data);
        else if (event.type === 'todo.updated') projection.put('todo', 'plan', 'Plan', { plan: taskPlanSteps((data.todos ?? []).map((todo: AcpRecord) => ({ step: todo.content, status: todo.status === 'in_progress' ? 'inProgress' : todo.status }))) });
        else if (event.type === 'session.error' && delivered) finish(new Error(data.error?.data?.message ?? 'OpenCode 原生执行失败'));
      }
      if (['permission.replied', 'question.replied', 'question.rejected', 'form.replied', 'form.cancelled'].includes(event.type)) for (const [id, item] of pending) if (item.value.id === (data.requestID ?? data.id)) { pending.delete(id); await update({ kind: 'approvalResolved', id }); }
    };
    const enqueue = (event: AcpRecord) => { chain = chain.then(() => apply(event)).catch(error => finish(error instanceof Error ? error : new Error('OpenCode 输出失败'))); };
    let subscription: Awaited<ReturnType<OpenCodeServer['subscribe']>>;
    try { subscription = await server.subscribe(enqueue, error => finish(error)); } catch (error) { await lease.close(); throw error; }
    const cancel = () => { interruption ??= (async () => { try { if (sessionId) { if (v2) await v2.session.interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(1000) }); else await openCodeData(v1!.session.abort({ sessionID: sessionId }, { signal: AbortSignal.timeout(1000) })); } } catch {} finally { if (server.child) await server.close(); finish(cancelled()); } })(); };
    const live: Live = { server, sessionId, nativeId, pending, rules, cancel, steers: new Map() }; this.runs.set(task.id, live); signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (v2 && (runtime.settings.permissionMode !== 'auto' || task.interactionMode === 'plan')) {
        const agents = await v2.agent.list({ location: { directory: task.cwd } }, { signal: AbortSignal.timeout(5000) }).catch(() => ({ data: [] }));
        const paths = agents.data.filter(agent => [task.interactionMode === 'plan' ? 'plan' : runtime.agent ?? 'build'].includes(agent.id)).flatMap(agent => agent.permissions.filter(rule => rule.effect === 'allow' && rule.resource !== '*' && ['edit', 'external_directory'].includes(rule.action)));
        rules.splice(mcp ? rules.length - 2 : rules.length, 0, ...paths);
      }
      if (task.threadId) {
        const session = v2 ? await v2.session.get({ sessionID: sessionId }) : await openCodeData(v1!.session.get({ sessionID: sessionId }));
        if (session.id !== sessionId) throw new Error('OpenCode 未确认原生会话 ID');
        if (v2) { await v2.session.update({ sessionID: sessionId, permissions: rules as any }); if (session.location?.directory !== task.cwd) await v2.session.move({ sessionID: sessionId, directory: task.cwd }); }
        else await server.updateV1Permissions(sessionId, rules);
        await update({ kind: 'resumeApplied' });
      } else {
        const session = v2 ? await v2.session.create({ location: { directory: task.cwd }, model: { providerID: runtime.providerID, id: runtime.modelID, ...(runtime.effort ? { variant: runtime.effort } : {}) }, title: task.title || 'Friday task', permissions: rules as any }) : await openCodeData(v1!.session.create({ permission: rules as any }));
        if (typeof session.id !== 'string' || !session.id) throw new Error('OpenCode 未返回原生会话 ID'); sessionId = session.id; live.sessionId = sessionId;
      }
      nativeId = promptId(sessionId, task.currentRunId ?? randomUUID()); live.nativeId = nativeId; projection = new NativeTurnProjection(request, nativeId);
      await update({ kind: 'session', threadId: sessionId, nativeProviderAccount: runtime.account, model: runtime.model, reasoningEffort: runtime.effort, executionSessionId: randomUUID() });
      if (mcp) {
        const config = { type: 'remote' as const, url: request.taskMcp!.url, headers: request.taskMcp!.headers, oauth: false as const };
        if (v2) await v2.mcp.add({ server: mcpName, location: { directory: task.cwd }, config }); else await openCodeData(v1!.mcp.add({ name: mcpName, config }));
      }
      if (v2) {
        await v2.session.switchModel({ sessionID: sessionId, model: { providerID: runtime.providerID, id: runtime.modelID, ...(runtime.effort ? { variant: runtime.effort } : {}) } });
        await v2.session.switchAgent({ sessionID: sessionId, agent: task.interactionMode === 'plan' ? 'plan' : runtime.agent ?? 'build' });
      }
      await request.beforeStart?.(); if (signal.aborted) throw cancelled(); await update({ kind: 'turn', turnId: nativeId }); active = true; await update({ kind: 'ready', canSteer: v2 !== undefined && request.command !== 'compact' });
      if (request.command === 'compact') {
        if (v2) await v2.session.compact({ sessionID: sessionId, id: nativeId });
        else { await openCodeData(v1!.session.summarize({ sessionID: sessionId, providerID: runtime.providerID, modelID: runtime.modelID, auto: false })); finish(); }
      } else if (v2) {
        const files = []; for (const image of request.images ?? []) files.push({ uri: `data:${image.mediaType};base64,${(await readFile(image.path)).toString('base64')}`, name: image.name });
        const result = await v2.session.prompt({ sessionID: sessionId, id: nativeId, text: request.prompt, ...(files.length ? { files } : {}) }); if (result.id !== nativeId) throw new Error('OpenCode 未确认提示词标识');
      } else {
        const parts: any[] = [{ type: 'text', text: request.prompt }]; for (const image of request.images ?? []) parts.push({ type: 'file', mime: image.mediaType, filename: image.name, url: `data:${image.mediaType};base64,${(await readFile(image.path)).toString('base64')}` });
        await openCodeData(v1!.session.promptAsync({ sessionID: sessionId, messageID: nativeId, model: { providerID: runtime.providerID, modelID: runtime.modelID }, variant: runtime.effort || undefined, agent: task.interactionMode === 'plan' ? 'plan' : runtime.agent ?? 'build', parts })); admission = true; settleV1();
      }
      await completion; await chain; if (signal.aborted) throw cancelled(); const result = await projection.finish('completed'); succeeded = true; return result;
    } catch (error) { await projection?.finish(signal.aborted ? 'interrupted' : 'failed'); throw signal.aborted ? cancelled() : error; }
    finally { active = false; signal.removeEventListener('abort', cancel); projection?.dispose(); for (const steer of live.steers.values()) steer.reject(new Error('OpenCode 回合已经结束')); await interruption; await subscription.close(); if (v2 && mcp && server.available) await v2.mcp.remove({ server: mcpName, location: { directory: task.cwd } }, { signal: AbortSignal.timeout(3000) }).catch(() => {}); if (!succeeded && server.child) await server.close(); await lease.close(); await chain; this.runs.delete(task.id); }
  }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const run = this.runs.get(id), pending = run?.pending.get(approvalId); if (!run || !pending || pending.answering) throw new Error('OpenCode 请求已经结束或正在回答');
    const v1 = run.server.v1, v2 = run.server.v2, value = pending.value;
    pending.answering = true;
    try {
      if (pending.kind === 'permission') {
        if (!pending.approval.decisions?.includes(decision)) throw new Error('OpenCode 未提供此授权选项');
        if (v2) {
          if (decision === 'acceptForSession') { run.rules.push(...value.save.map((resource: string) => ({ action: value.action, resource, effect: 'allow' }))); await v2.session.update({ sessionID: run.sessionId, permissions: run.rules as any }); }
          await v2.permission.reply({ sessionID: run.sessionId, requestID: value.id, decision: ['accept', 'acceptForSession'].includes(decision) ? 'once' : 'reject', ...(decision === 'decline' ? { message: 'The user declined this request.' } : {}) });
        } else await openCodeData(v1!.permission.reply({ requestID: value.id, reply: decision === 'accept' ? 'once' : decision === 'acceptForSession' ? 'always' : 'reject' }));
      } else if (pending.kind === 'question') {
        if (decision !== 'accept') await openCodeData(v1!.question.reject({ requestID: value.id }));
        else await openCodeData(v1!.question.reply({ requestID: value.id, answers: value.questions.map((_question: AcpRecord, index: number) => { const answer = answers[`q${index}`]; if (!answer?.length) throw new Error('请回答 OpenCode 的全部问题'); return answer; }) }));
      } else if (decision !== 'accept') await v2!.session.form.cancel({ sessionID: run.sessionId, formID: value.id });
      else {
        const answer: Record<string, string | string[]> = {};
        for (const field of value.fields) {
          const raw = answers[field.key]; if (!raw?.length) throw new Error('请回答 OpenCode 的全部问题');
          const values = raw.map(label => field.options?.find((option: AcpRecord) => (option.label || option.value) === label)?.value ?? label);
          answer[field.key] = field.type === 'multiselect' ? values : values.join(', ');
        }
        await v2!.session.form.reply({ sessionID: run.sessionId, formID: value.id, answer });
      }
    } finally { pending.answering = false; }
  }
  async steer(id: string, text: string, requestId: string, images?: ExecutionImage[]) {
    const run = this.runs.get(id); if (!run?.server.v2) throw new Error('当前 OpenCode 协议请使用队列补充消息');
    const native = promptId(run.sessionId, 'steer:' + requestId), body = JSON.stringify([text, images]);
    const previous = run.steers.get(native); if (previous) { if (previous.body !== body) throw new Error('OpenCode 补充请求 ID 已用于不同输入'); return previous.promise; }
    let resolve!: () => void, reject!: (error: Error) => void, timer: NodeJS.Timeout | undefined; const delivered = new Promise<void>((yes, no) => { resolve = () => { clearTimeout(timer); yes(); }; reject = error => { clearTimeout(timer); no(error); }; }); void delivered.catch(() => {});
    timer = setTimeout(() => reject(new Error('OpenCode 补充消息的交付回执未确认')), 10000);
    const promise = (async () => { try { const files = []; for (const image of images ?? []) files.push({ uri: `data:${image.mediaType};base64,${(await readFile(image.path)).toString('base64')}`, name: image.name }); const result = await run.server.v2!.session.prompt({ sessionID: run.sessionId, id: native, text, delivery: 'steer', ...(files.length ? { files } : {}) }, { signal: AbortSignal.timeout(8000) }); if (result.id !== native) throw new Error('OpenCode 未确认补充消息标识'); await delivered; } catch (error) { clearTimeout(timer); throw error; } })();
    run.steers.set(native, { body, promise, resolve, reject }); return promise;
  }
  async close() { for (const run of this.runs.values()) run.cancel(); await this.connection.close(); }
}
