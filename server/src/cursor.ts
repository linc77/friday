import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CursorConnection } from './cursor-provider.js';
import { NativeTurnProjection } from './native-turn-projection.js';
import { acpRecord, type AcpRecord, type AcpProcess } from './acp-process.js';
import { taskPlanSteps } from './task-event-data.js';
import type { ExecutionRequest, Executor, ExecutionImage } from './types.js';
import { cursorSkills, rewriteCursorSkills } from './cursor-skills.js';

// Native SDK policy and event mapping follow T3 8cd9641f provider-cursor.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.

const cancelled = () => new Error('任务已中止');
export class CursorExecutor implements Executor {
  private runs = new Map<string, { client: AcpProcess; cancel: () => void }>();
  constructor(private connection: CursorConnection) {}
  supportsTaskTools(agent: string) { return agent === 'cursor'; }
  deferredStart(agent: string) { return agent === 'cursor'; }
  async run(request: ExecutionRequest) {
    const { task, update, signal } = request;
    if (this.runs.has(task.id)) throw new Error('Cursor 会话仍在执行');
    const runtime = await this.connection.runtime({ model: task.model, reasoningEffort: task.reasoningEffort });
    if (task.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 Cursor 会话使用的账号');
    signal.throwIfAborted(); const client = await this.connection.client(runtime.settings, task.cwd);
    let projection: NativeTurnProjection | undefined, runId = '', sessionId = task.threadId ?? '', chain = Promise.resolve(), interruption: Promise<unknown> | undefined, terminal = false;
    let resolve!: (result: AcpRecord) => void, reject!: (error: Error) => void;
    const completion = new Promise<AcpRecord>((yes, no) => { resolve = yes; reject = no; }); void completion.catch(() => {});
    const finish = (value?: AcpRecord, error?: Error) => { if (!terminal) { terminal = true; error ? reject(error) : resolve(value ?? {}); } };
    const buffered: [string, AcpRecord][] = []; let active = false, block = 0, current: string | undefined, lastKind = '', lastShell: string | undefined;
    const apply = async (method: string, value: AcpRecord) => {
      if (terminal || !projection || value.agentId !== sessionId || value.runId !== runId) return;
      if (method === 'cursor/completed') { if (value.error) finish(undefined, new Error(value.error)); else finish(value.result); return; }
      if (method !== 'cursor/delta') return;
      const change = acpRecord(value.update); if (!change) return;
      if (['text-delta', 'thinking-delta'].includes(change.type) && typeof change.text === 'string') {
        const kind = change.type === 'text-delta' ? 'message' : 'reasoning'; if (lastKind !== kind || !current) current = `message:${++block}`; lastKind = kind;
        projection.put(current, kind, (projection.items.get(current)?.text ?? '') + change.text, { phase: 'commentary' });
      } else if (['tool-call-started', 'partial-tool-call', 'tool-call-completed'].includes(change.type)) {
        current = undefined; lastKind = '';
        const tool = acpRecord(change.toolCall); if (!tool || typeof change.callId !== 'string') return;
        const key = `tool:${change.callId}`, previous = projection.items.get(key), args = acpRecord(tool.args), result = acpRecord(tool.result), body = acpRecord(result?.value);
        const kind = tool.type === 'shell' ? 'command' : ['write', 'edit', 'delete', 'generateImage'].includes(tool.type) ? 'files' : ['read', 'grep', 'glob', 'ls', 'semSearch', 'readLints'].includes(tool.type) ? 'search' : 'tool';
        const detail = result?.status === 'error' ? result.error?.message ?? result.error ?? 'Cursor 工具执行失败' : typeof body?.stdout === 'string' ? body.stdout + (body.stderr ?? '') : typeof body?.text === 'string' ? body.text : typeof body?.content === 'string' ? body.content : previous?.detail;
        if (tool.type === 'shell') lastShell = key;
        projection.put(key, kind, tool.type === 'shell' ? args?.command ?? previous?.text ?? 'Shell' : args?.path ?? args?.pattern ?? args?.query ?? tool.type, { status: change.type === 'tool-call-completed' ? result?.status === 'error' ? 'failed' : 'completed' : 'running', ...(detail !== undefined ? { detail: typeof detail === 'string' ? detail : JSON.stringify(detail) } : {}), ...(typeof body?.exitCode === 'number' ? { exitCode: body.exitCode } : {}) });
        if (tool.type === 'updateTodos' && Array.isArray(args?.todos)) projection.put('todo', 'plan', 'Plan', { plan: taskPlanSteps(args.todos.map((todo: AcpRecord) => ({ step: todo.content ?? todo.text, status: todo.status === 'in_progress' ? 'inProgress' : todo.status }))) });
        if (tool.type === 'createPlan' && change.type === 'tool-call-completed' && result?.status === 'success') { const text = body?.plan ?? args?.plan ?? args?.content; if (typeof text === 'string') projection.put(`proposal:${change.callId}`, 'proposal', text, { status: 'completed' }); }
      } else if (change.type === 'shell-output-delta' && lastShell) {
        const event = acpRecord(change.event), chunk = event?.data ?? event?.text ?? event?.stdout ?? ''; const previous = projection.items.get(lastShell);
        if (typeof chunk === 'string' && previous) projection.put(lastShell, 'command', previous.text, { detail: (previous.detail ?? '') + chunk });
      } else if (['thinking-completed', 'step-completed', 'turn-ended'].includes(change.type)) { current = undefined; lastKind = ''; }
    };
    const enqueue = (method: string, value: AcpRecord) => { chain = chain.then(() => apply(method, value)).catch(error => finish(undefined, error instanceof Error ? error : new Error('Cursor 输出失败'))); };
    client.onNotification = (method, value) => { const record = acpRecord(value); if (!record) return; if (!active) buffered.push([method, record]); else enqueue(method, record); };
    client.onExit = error => finish(undefined, error);
    const cancel = () => { interruption ??= (async () => { let timer: NodeJS.Timeout | undefined; try { await Promise.race([client.call('cursor/cancel', {}, 1000), new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })]); } catch {} finally { clearTimeout(timer); await client.close(); finish(undefined, cancelled()); } })(); };
    signal.addEventListener('abort', cancel, { once: true }); this.runs.set(task.id, { client, cancel });
    try {
      const opened = await client.call('cursor/open', { ...(task.threadId ? { agentId: task.threadId } : {}), fingerprint: runtime.fingerprint, cwd: task.cwd, stateRoot: this.connection.stateRoot(task.cwd), model: runtime.nativeModel, name: `Friday ${task.id}`, fullAccess: runtime.settings.permissionMode === 'fullAccess', mode: task.interactionMode === 'plan' ? 'plan' : 'agent', ...(request.taskMcp ? { mcpServers: { friday: { type: 'http', url: request.taskMcp.url, headers: request.taskMcp.headers } } } : {}) });
      if (typeof opened.agentId !== 'string' || !opened.agentId || task.threadId && task.threadId !== opened.agentId) throw new Error('Cursor 返回了不同或无效的原生会话 ID');
      sessionId = opened.agentId; await update({ kind: 'session', threadId: sessionId, model: runtime.model, reasoningEffort: runtime.effort, nativeProviderAccount: runtime.account, executionSessionId: randomUUID() });
      if (task.threadId) await update({ kind: 'resumeApplied' }); await request.beforeStart?.(); if (signal.aborted) throw cancelled();
      const text = request.command === 'compact' ? '/compress' : request.prompt, images = [];
      for (const image of request.images ?? []) images.push({ data: (await readFile(image.path)).toString('base64'), mimeType: image.mediaType });
      const nativeText = /(^|\s)\p{Sc}(?=[a-zA-Z0-9:_-]*[a-zA-Z])/u.test(text) ? rewriteCursorSkills(text, new Set((await cursorSkills(task.cwd, runtime.env)).map(skill => skill.name))) : text;
      const started = await client.call('cursor/send', { message: images.length ? { text: nativeText, images } : nativeText, model: runtime.nativeModel, mode: task.interactionMode === 'plan' ? 'plan' : 'agent', idempotencyKey: `friday:${task.id}:${task.currentRunId ?? randomUUID()}` });
      if (typeof started.runId !== 'string' || started.agentId !== sessionId) throw new Error('Cursor 未确认原生执行回合');
      runId = started.runId; projection = new NativeTurnProjection(request, runId); await update({ kind: 'turn', turnId: runId }); await update({ kind: 'ready', canSteer: false }); active = true;
      for (const [method, value] of buffered) enqueue(method, value); buffered.length = 0;
      const result = await completion; await chain;
      if (signal.aborted || result.status === 'cancelled') throw cancelled();
      if (result.status !== 'finished') throw new Error(result.error?.message ?? 'Cursor SDK 原生执行失败');
      if (!projection.output && typeof result.result === 'string' && result.result) projection.put('final', 'message', result.result);
      return await projection.finish('completed');
    } catch (error) { await projection?.finish(signal.aborted ? 'interrupted' : 'failed'); throw signal.aborted ? cancelled() : error; }
    finally { active = false; signal.removeEventListener('abort', cancel); projection?.dispose(); await interruption; await this.connection.release(client); await chain; this.runs.delete(task.id); }
  }
  async answer(): Promise<void> { throw new Error('Cursor SDK 不提供交互式审批回调；请在 Providers 中选择原生审核或完全访问'); }
  async steer(_id: string, _text: string, _requestId: string, _images?: ExecutionImage[]): Promise<void> { throw new Error('当前 Cursor 适配不提供原生 Steer，请使用队列'); }
  async close() { for (const run of this.runs.values()) run.cancel(); await this.connection.close(); }
}
