import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Approval, ExecutionImage, ExecutionRequest, Executor, TaskEvent } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';
import { PiConnection } from './pi-provider.js';
import { type PiRecord, PiRpc, piRecord } from './pi-rpc.js';

type PendingPrompt = { nativeId: string; method: string; key: string; approval: Approval; timer?: NodeJS.Timeout };
type PiRun = { rpc: PiRpc; update: ExecutionRequest['update']; approvals: Map<string, PendingPrompt>; grants: Set<string>; active: boolean; generation: number; cancel: () => void };
const now = () => new Date().toISOString();
const toolText = (value: unknown): string => {
  const record = piRecord(value);
  return Array.isArray(record?.content) ? record.content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n') : '';
};
async function piImages(images: ExecutionImage[] = []) {
  return Promise.all(images.map(async image => ({ type: 'image', data: (await readFile(image.path)).toString('base64'), mimeType: image.mediaType })));
}

/** Native Pi RPC sessions, rather than invoking its one-shot text command.
 * Protocol behavior follows the pinned T3 Pi adapter (8cd9641f); Pi Durable
 * remains the execution owner and must persist the session before prompt. */
export class PiExecutor implements Executor {
  private runs = new Map<string, PiRun>();
  private sessionGrants = new Map<string, Set<string>>();
  constructor(private connection: PiConnection) {}
  supportsTaskTools(agent: string) { return agent === 'pi'; }
  async run(request: ExecutionRequest): Promise<string> {
    const { task, update, signal } = request;
    if (this.runs.has(task.id)) throw new Error('这条 Pi 会话仍在执行');
    if (task.interactionMode === 'plan') throw new Error('Pi 未提供原生计划模式，请使用默认模式');
    const runtime = await this.connection.runtime({ model: task.model, reasoningEffort: task.reasoningEffort, modelOptions: task.modelOptions });
    if (task.piHome && task.piHome !== runtime.home) throw new Error('请恢复这条 Pi 会话使用的配置目录');
    if (signal.aborted) throw new Error('任务已中止');
    const extension = await this.connection.extension(), token = request.taskMcp?.headers.Authorization?.match(/^Bearer (.+)$/i)?.[1];
    const environment: NodeJS.ProcessEnv = { FRIDAY_MCP_URL: request.taskMcp?.url, FRIDAY_MCP_BEARER_TOKEN: token, FRIDAY_PI_MCP_EXTENSION_PATH: extension,
      FRIDAY_PI_RUNTIME_MODE: runtime.permissionMode === 'auto' ? 'full-access' : runtime.permissionMode === 'acceptEdits' ? 'auto-accept-edits' : 'approval-required' };
    const rpc = this.connection.client(runtime, task.cwd, false, extension, environment);
    let complete!: () => void, fail!: (error: Error) => void, done = false;
    const completion = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    void completion.catch(() => {});
    const settle = (error?: Error) => { if (!done) { done = true; error ? fail(error) : complete(); } };
    const run: PiRun = { rpc, update, approvals: new Map(), grants: new Set(), active: false, generation: 0, cancel: () => settle(new Error('任务已中止')) };
    this.runs.set(task.id, run);
    const turnId = `pi:${task.currentRunId ?? randomUUID()}`, items = new Map<string, TaskEvent>(), dirty = new Set<string>();
    let chain = Promise.resolve(), timer: NodeJS.Timeout | undefined, messageOrdinal = 0, result = '', latestText = '', failure: Error | undefined, sawActivity = false;
    let outputDirty = false, sessionKey: string | undefined;
    const flush = async () => {
      clearTimeout(timer); timer = undefined;
      const pending = [...dirty]; dirty.clear();
      for (const id of pending) { const item = items.get(id); if (item) await update({ kind: 'item', item: { ...item } }); }
      if (outputDirty) { outputDirty = false; await update({ kind: 'output', text: latestText }); }
    };
    const enqueue = (work: () => Promise<void>) => { chain = chain.then(work).catch(error => settle(error instanceof Error ? error : new Error('Pi 更新失败'))); };
    const schedule = () => { timer ??= setTimeout(() => enqueue(flush), 50); };
    const item = (key: string, kind: string, text: string, changes: Partial<TaskEvent> = {}) => {
      const previous = items.get(key), value: TaskEvent = { id: `pi:${turnId}:${key}`, itemId: key, turnId, kind, text, at: previous?.at ?? now(), status: 'running', ...(kind === 'message' ? { phase: 'commentary' as const } : {}), ...previous, ...changes };
      items.set(key, value); dirty.add(key); schedule(); return value;
    };
    const idle = async (generation: number) => {
      if (!run.active || done || run.approvals.size) return;
      const state = await rpc.request({ type: 'get_state' }, 5000);
      if (generation !== run.generation || state?.isStreaming === true || state?.isCompacting === true || (state?.pendingMessageCount ?? 0) > 0) return;
      // get_state is ordered after the native settlement event. Never use an
      // elapsed timer or agent_end as evidence that extensions have settled.
      if (failure) { settle(failure); return; }
      const stats = await rpc.request({ type: 'get_session_stats' }, 5000).catch(() => undefined), usage = piRecord(stats?.contextUsage);
      if (generation !== run.generation) return;
      if (typeof usage?.tokens === 'number' && Number.isFinite(usage.tokens)) await update({ kind: 'contextUsage', usage: { usedTokens: Math.max(0, usage.tokens), maxTokens: typeof usage.contextWindow === 'number' && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null, updatedAt: now(), model: runtime.model } });
      run.active = false;
      for (const [key, value] of items) {
        if (value.status === 'running') item(key, value.kind, value.text, { status: 'completed', completedAt: now() });
        if (value.kind === 'message' && key.startsWith(`${messageOrdinal}:`)) item(key, value.kind, value.text, { phase: 'final_answer' });
      }
      await flush(); settle();
    };
    const prompt = async (event: PiRecord) => {
      if (!['confirm', 'select', 'input', 'editor'].includes(event.method) || typeof event.id !== 'string') return;
      const key = JSON.stringify([event.title ?? '', event.message ?? '']);
      if (event.method === 'confirm' && run.grants.has(key)) { await rpc.send({ type: 'extension_ui_response', id: event.id, confirmed: true }); return; }
      const id = `pi:${event.id}`, title = typeof event.title === 'string' ? event.title : 'Pi';
      const options = Array.isArray(event.options) ? event.options.filter((value: unknown) => typeof value === 'string').map((label: string) => ({ label, description: '' })) : [];
      const approval: Approval = { id, method: `pi/extension/${event.method}`, title, detail: typeof event.message === 'string' ? event.message : title, state: 'pending',
        questions: event.method === 'confirm' ? [] : [{ id: event.id, header: title, question: event.message ?? title, options, multiSelect: false, isOther: event.method !== 'select', isSecret: event.password === true || event.secret === true }],
        ...(event.method === 'confirm' ? { decisions: ['cancel', 'decline', 'acceptForSession', 'accept'] as ApprovalDecision[] } : {}) };
      const pending: PendingPrompt = { nativeId: event.id, method: event.method, key, approval };
      run.approvals.set(id, pending); await flush(); await update({ kind: 'approval', approval });
      if (typeof event.timeout === 'number' && Number.isFinite(event.timeout) && event.timeout !== 0) pending.timer = setTimeout(() => {
        if (run.approvals.get(id) !== pending) return;
        run.approvals.delete(id); void update({ kind: 'approvalResolved', id }).catch(error => settle(error));
      }, Math.min(2_147_483_647, Math.max(0, event.timeout)));
    };
    const handle = async (event: PiRecord, generation: number) => {
      if (event.type === 'extension_ui_request') { await prompt(event); return; }
      if (!run.active || done) return;
      if (event.type === 'agent_start') { sawActivity = true; return; }
      if (event.type === 'message_start' && event.message?.role === 'assistant') { messageOrdinal++; latestText = ''; return; }
      if (event.type === 'message_update') {
        const delta = piRecord(event.assistantMessageEvent); if (!delta) return;
        sawActivity = true;
        const kind = String(delta.type).startsWith('thinking') ? 'reasoning' : 'message', key = `${messageOrdinal}:${kind}:${delta.contentIndex ?? 0}`;
        if (['text_delta', 'thinking_delta'].includes(delta.type)) {
          const text = (items.get(key)?.text ?? '') + (typeof delta.delta === 'string' ? delta.delta : ''); item(key, kind, text, { text });
        } else if (['text_end', 'thinking_end'].includes(delta.type)) {
          const text = delta.content ?? delta.thinking ?? items.get(key)?.text ?? ''; item(key, kind, text, { text, status: 'completed', completedAt: now() });
        } else return;
        if (kind === 'message') { latestText = [...items.values()].filter(value => value.kind === 'message' && value.itemId?.startsWith(`${messageOrdinal}:`)).map(value => value.text).join('\n'); result = latestText; outputDirty = true; schedule(); }
        return;
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const message = event.message, content = Array.isArray(message.content) ? message.content : [];
        for (let index = 0; index < content.length; index++) {
          const block = content[index], kind = block?.type === 'thinking' ? 'reasoning' : block?.type === 'text' ? 'message' : undefined;
          if (kind) { const text = kind === 'reasoning' ? block.thinking : block.text; if (typeof text === 'string') item(`${messageOrdinal}:${kind}:${index}`, kind, text, { text, status: 'completed', completedAt: now() }); }
        }
        latestText = content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('\n');
        if (latestText) { result = latestText; outputDirty = true; }
        if (message.stopReason === 'error') failure = new Error(typeof message.errorMessage === 'string' ? message.errorMessage : 'Pi 模型调用失败');
        schedule(); return;
      }
      if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type) && typeof event.toolCallId === 'string') {
        sawActivity = true;
        const key = `tool:${event.toolCallId}`, previous = items.get(key), name = event.toolName ?? previous?.text ?? 'Tool', args = piRecord(event.args);
        const kind = name === 'bash' ? 'command' : ['write', 'edit'].includes(name) ? 'files' : ['read', 'grep', 'find', 'ls'].includes(name) ? 'search' : 'tool';
        const text = args ? kind === 'command' ? String(args.command ?? name) : `${name}${args.path ? ': ' + args.path : ''}` : previous?.text ?? name;
        const detail = toolText(event.result ?? event.partialResult), final = event.type === 'tool_execution_end';
        item(key, kind, text, { text, ...(detail ? { detail } : {}), ...(final ? { status: event.isError ? 'failed' : 'completed', completedAt: now() } : {}) }); return;
      }
      if (event.type === 'auto_retry_end' && event.success === true) { failure = undefined; return; }
      if (event.type === 'auto_retry_end' && event.success === false) { failure = new Error(event.finalError ?? 'Pi 重试失败'); return; }
      if (event.type === 'extension_error') { failure = new Error(event.error ?? 'Pi 扩展执行失败'); return; }
      if (event.type === 'agent_settled') {
        if (event.aborted === true) { settle(new Error('Pi 原生执行已中止')); return; }
        await idle(generation); return;
      }
      if (event.type === 'response' && ['prompt', 'compact'].includes(event.command)) {
        if (event.success === false) { settle(new Error(typeof event.error === 'string' ? event.error : `Pi ${event.command} 失败`)); return; }
        if (event.command === 'compact' || !sawActivity) await idle(generation);
      }
    };
    rpc.onEvent = event => {
      if (['agent_start', 'compaction_start', 'tool_execution_start', 'message_start', 'extension_ui_request'].includes(event.type)) run.generation++;
      if (run.active && ['agent_start', 'tool_execution_start', 'message_start'].includes(event.type)) sawActivity = true;
      const generation = run.generation;
      enqueue(() => handle(event, generation));
    };
    rpc.onExit = error => settle(error);
    const cancel = () => { run.cancel(); void rpc.close(); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) throw new Error('任务已中止');
      if (task.threadId) {
        const switched = await rpc.request({ type: 'switch_session', sessionPath: task.threadId });
        if (switched?.cancelled) throw new Error('Pi 扩展取消了会话续接');
      }
      const state = await rpc.request({ type: 'get_state' });
      if (typeof state?.sessionFile !== 'string' || !isAbsolute(state.sessionFile) || task.threadId && state.sessionFile !== task.threadId) throw new Error('Pi 没有确认原生会话文件，已停止执行');
      if (state.isStreaming === true) throw new Error('Pi 会话仍在运行，未发送新提示词');
      sessionKey = JSON.stringify([task.id, runtime.home, state.sessionFile]);
      run.grants = this.sessionGrants.get(sessionKey) ?? new Set(); this.sessionGrants.set(sessionKey, run.grants);
      if (runtime.model !== 'default') {
        const separator = runtime.model.indexOf('/'); if (separator < 1) throw new Error('Pi 模型需要 provider/model 格式');
        await rpc.request({ type: 'set_model', provider: runtime.model.slice(0, separator), modelId: runtime.model.slice(separator + 1) });
      }
      if (runtime.effort) await rpc.request({ type: 'set_thinking_level', level: runtime.effort });
      await update({ kind: 'session', threadId: state.sessionFile, piHome: runtime.home, model: runtime.model, reasoningEffort: runtime.effort, executionSessionId: randomUUID() });
      if (task.threadId) await update({ kind: 'resumeApplied' });
      const images = await piImages(request.images);
      await request.beforeStart?.();
      if (signal.aborted) throw new Error('任务已中止');
      await update({ kind: 'turn', turnId });
      run.active = true;
      if (request.command === 'compact') {
        const instructions = (request.userText ?? request.prompt).trim().replace(/^\/compact(?:\s+|$)/, '').trim();
        await rpc.send({ type: 'compact', ...(instructions ? { customInstructions: instructions } : {}) });
      }
      else await rpc.send({ type: 'prompt', message: request.prompt, streamingBehavior: 'steer', ...(images.length ? { images } : {}) });
      await update({ kind: 'ready', canSteer: true });
      await completion; await chain; await flush();
      return result;
    } catch (error) {
      if (sessionKey) this.sessionGrants.delete(sessionKey);
      for (const [key, value] of items) if (value.status === 'running') item(key, value.kind, value.text, { status: signal.aborted ? 'interrupted' : 'failed', completedAt: now() });
      await flush(); throw error;
    } finally {
      signal.removeEventListener('abort', cancel); clearTimeout(timer); run.active = false;
      for (const pending of run.approvals.values()) clearTimeout(pending.timer);
      run.approvals.clear(); await this.connection.release(rpc); await chain;
      if (this.runs.get(task.id) === run) this.runs.delete(task.id);
    }
  }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) {
    const run = this.runs.get(id), pending = run?.approvals.get(approvalId);
    if (!run || !pending) throw new Error('Pi 问题已结束或超时');
    if (decision === 'acceptAlways') throw new Error('Pi 不支持永久授权');
    const response: PiRecord = { type: 'extension_ui_response', id: pending.nativeId };
    if (pending.method === 'confirm') response.confirmed = decision === 'accept' || decision === 'acceptForSession';
    else if (decision === 'cancel' || decision === 'decline') response.cancelled = true;
    else {
      const value = answers[pending.nativeId];
      if (!value || value.length !== 1 || typeof value[0] !== 'string' || pending.method === 'select' && !pending.approval.questions[0]?.options.some(option => option.label === value[0])) throw new Error('Pi 回答格式无效或选项已失效');
      response.value = value[0];
    }
    await run.rpc.send(response);
    if (decision === 'acceptForSession' && pending.method === 'confirm') run.grants.add(pending.key);
    clearTimeout(pending.timer); run.approvals.delete(approvalId);
  }
  async steer(id: string, text: string, _requestId: string, images?: ExecutionImage[]) {
    const run = this.runs.get(id); if (!run?.active) throw new Error('Pi 回合已结束，请继续会话');
    run.generation++;
    await run.rpc.request({ type: 'prompt', message: text, streamingBehavior: 'steer', images: await piImages(images) });
  }
  async close() { for (const run of this.runs.values()) run.cancel(); await this.connection.close(); this.sessionGrants.clear(); }
}
