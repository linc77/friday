import { setTimeout as delay } from 'node:timers/promises';
import { defineTask, type TaskId, type Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { IdeaImages } from './ideas.js';
import { displayContextText } from './task-context-types.js';
import { formatTaskTitleContext, generatedTaskTitle, limitTitleMessage, taskTitlePrompt } from './task-title-text.js';
import type { Workspace, WorkItem } from './types.js';
import { resolveTaskTitleLinks } from './task-title-links.js';

type TitleInput = { id: string; requestId: string; kind: 'initial' | 'regenerate'; messageId: string; previousTitle: string };
type Checkpoint = { phase: 'generate'; attempt: number; notBefore: number };
type TitleStatus = NonNullable<Workspace['titleRequests']>[string]['status'];
export const pendingTaskTitles = (state: Workspace, agent?: string) => Object.values(state.titleRequests ?? {}).some(request =>
  request.status === 'pending' && (agent === undefined || (request.modelSelection?.agent ?? state.tasks.find(task => task.id === request.taskId)?.agent) === agent));

export class TaskTitles {
  readonly definition;
  resolveLinks = resolveTaskTitleLinks;
  private live = new Map<number, { id: string; requestId: string; controller: AbortController }>();
  private stopping = false;
  get supported() { return typeof this.engine.executor.generateText === 'function'; }
  constructor(private readonly engine: Engine) {
    this.resolveLinks = input => resolveTaskTitleLinks(input, { connections: this.engine.sourceControl });
    this.definition = defineTask<TitleInput, Checkpoint, { status: string }, {}>({
      name: 'friday.task_title', version: 1, initial: () => ({ phase: 'generate', attempt: 0, notBefore: 0 }),
      phases: { generate: async (task, runtime, ctx) => {
        const input = task.input; const attempt = task.state.checkpoint.attempt; const key = `attempt-${attempt}`;
        const finish = async (status: TitleStatus, title?: string) => {
          await this.finish(input.id, input.requestId, status, title);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const state = await this.engine.snapshot(); const work = state.tasks.find(work => work.id === input.id);
        if (!work || work.titleRegeneration?.requestId !== input.requestId) { await finish('superseded'); return; }
        if (this.stopping) { await finish('interrupted'); return; }
        if (!state.projects.some(project => project.id === work.projectId)) { await finish('completed'); return; }
        const wait = task.state.checkpoint.notBefore - Date.now();
        if (wait > 0) await delay(Math.min(wait, 4000), undefined, { signal: runtime.signal });
        const receipt = await runtime.memo<string>(key + '-text', ctx);
        if (receipt === undefined && await runtime.memo<boolean>(key + '-started', ctx)) {
          // A lost model receipt is never replayed after process death. A fresh
          // explicit request may generate another title, using its own session.
          await finish('interrupted'); return;
        }
        const controller = new AbortController(); this.live.set(task.id, { id: input.id, requestId: input.requestId, controller });
        const signal = AbortSignal.any([runtime.signal, controller.signal, AbortSignal.timeout(180_000)]);
        let retryable = false; let terminal = false; let title: string | undefined;
        try {
          let raw = receipt;
          if (raw === undefined) {
            const current = (await this.engine.snapshot()).tasks.find(work => work.id === input.id);
            if (this.stopping || current?.titleRegeneration?.requestId !== input.requestId) { await finish('superseded'); return; }
            const content = this.contents(current, input);
            if (!content.message.trim() && !content.images.length) { await finish('completed'); return; }
            const before = await this.engine.snapshot();
            const selected = before.titleRequests?.[input.requestId]?.modelSelection ?? await this.engine.textGeneration.select(before, current.projectId, 'title');
            await this.engine.mutate(state => { const request = state.titleRequests?.[input.requestId]; if (request) request.modelSelection ??= selected; });
            const cwd = current.executionWorkspace && current.executionWorkspace.state !== 'ready' ? current.executionWorkspace.sourcePath : current.cwd;
            let linked = await runtime.memo<{ context: string | null }>(key + '-linked-context', ctx);
            if (!linked) {
              linked = { context: await this.resolveLinks({ message: content.linkMessage, cwd, signal }) ?? null };
              signal.throwIfAborted();
              await runtime.memo(key + '-linked-context', linked, ctx);
            }
            const images = await new IdeaImages(this.engine.directory).resolve(content.images);
            const prompt = taskTitlePrompt(content.message, input.kind === 'regenerate' ? input.previousTitle : undefined, linked.context ?? undefined);
            const generation: WorkItem = { ...current, ...selected, id: `title-${task.id}-${attempt}`, threadId: null, turnId: null,
              cwd,
              mode: 'research', interactionMode: 'default', prompt, result: '', events: [], messages: [], approvals: [],
              lastRequestId: `title-${task.id}-${attempt}`, queue: undefined, gitOperation: undefined, gitOperations: undefined,
              claudeResumeSessionAt: undefined, claudeResumePendingRun: undefined };
            signal.throwIfAborted();
            await runtime.memo(key + '-started', true, ctx);
            signal.throwIfAborted();
            if (!this.engine.executor.generateText) throw new Error('此 Agent 尚未支持标题生成');
            try { raw = await this.engine.executor.generateText({ task: generation, prompt, images, purpose: 'task_title', signal, update: async update => {
              // These private Durable receipts survive manual rename, deletion
              // and replacement of the public request token. Await before the
              // provider can start a turn; never attach to the user's session.
              if (update.kind === 'session' || update.kind === 'turn') await this.engine.mutate(state => {
                const request = state.titleRequests?.[input.requestId]; if (!request || request.durableId !== task.id) throw new Error('标题生成记录不存在');
                request.sessions ??= {};
                if (update.kind === 'session') request.sessions[key] = { threadId: update.threadId,
                  ...(update.codexHome ? { codexHome: update.codexHome } : {}), ...(update.claudeHome ? { claudeHome: update.claudeHome } : {}) };
                else if (request.sessions[key]) request.sessions[key].turnId = update.turnId;
                else throw new Error('标题生成尚未保存原生会话');
              });
              if (update.kind === 'item' && update.item.kind === 'turn' && ['completed', 'failed', 'interrupted'].includes(update.item.status ?? '')) terminal = true;
              if (['approval', 'idea', 'memory', 'note', 'workspace'].includes(update.kind)) throw new Error('标题生成不能执行工具或改变用户数据');
              signal.throwIfAborted();
            } }); } catch (error) { retryable = terminal; throw error; }
            await runtime.memo(key + '-text', raw, ctx);
          }
          try { title = generatedTaskTitle(raw); } catch (error) { retryable = true; throw error; }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          // Retry only a confirmed finished attempt (bad structured output or a
          // received terminal provider event), never an uncertain timeout/exit.
          if (!this.stopping && !signal.aborted && retryable && input.kind === 'initial' && attempt < 2) {
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'generate', attempt: attempt + 1, notBefore: Date.now() + 2000 * 2 ** attempt } }), ctx);
          } else await finish(signal.aborted ? 'interrupted' : 'failed');
          return;
        } finally { this.live.delete(task.id); }
        // Projection/storage errors must not be mistaken for model failures.
        // The saved text receipt is reused if this phase is recovered.
        await finish('completed', title);
      } },
      abort: async (task, runtime, ctx) => {
        await this.finish(task.input.id, task.input.requestId, 'interrupted');
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }

  private contents(work: WorkItem, input: TitleInput) {
    const excluded = new Set(work.runs?.filter(run => run.revertedAt || run.executionExcludedAt).map(run => run.id));
    const messages = work.messages?.filter(message => !message.revertedAt && (message.role === 'user' || !message.runId || !excluded.has(message.runId))) ?? [];
    if (input.kind === 'initial') {
      const first = messages.find(message => message.id === input.messageId && message.role === 'user');
      const text = displayContextText(first?.text ?? '');
      return { message: limitTitleMessage(text, 8000), linkMessage: text, images: first?.images?.slice(0, 4) ?? [] };
    }
    const content = formatTaskTitleContext(messages.length ? messages : [{ role: 'user', text: work.prompt }, ...(work.result ? [{ role: 'assistant', text: work.result }] : [])]);
    return { ...content, linkMessage: content.message };
  }

  async schedule(tx: Tx, state: Workspace, id: string, requestId: string, kind: TitleInput['kind'], messageId = '') {
    const existing = state.titleRequests && Object.hasOwn(state.titleRequests, requestId) ? state.titleRequests[requestId] : undefined;
    if (existing) { if (existing.taskId !== id || existing.kind !== kind) throw new Error('标题请求 ID 已用于其他任务'); return existing.durableId; }
    const task = state.tasks.find(task => task.id === id);
    if (!task || task.agent === 'friday' || task.subagentOrigin) throw new Error('此对话不支持生成标题');
    // Auxiliary titling must not prevent submission of the user's main task.
    // If settings are unavailable, the independent title phase owns failure.
    let selected;
    try { selected = await this.engine.textGeneration.select(state, task.projectId, 'title'); } catch {}
    const durableId = await tx.createTask(this.definition, { id, requestId, kind, messageId, previousTitle: task.title }, { ownership: { kind: 'conversation' } });
    task.titleRegeneration = { requestId, startedAt: new Date().toISOString() };
    state.titleRequests ??= {}; state.titleRequests[requestId] = { taskId: id, durableId, kind, status: 'pending', ...(selected ? { modelSelection: selected } : {}) };
    return durableId;
  }
  async start(id: string, requestId: string) {
    if (!this.supported || this.stopping) throw new Error('当前 Agent 不支持标题生成');
    if (!requestId || requestId.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('标题请求 ID 无效');
    const durableId = await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const durableId = await this.schedule(tx, state, id, requestId, 'regenerate'); state.revision++; return durableId;
    }, context);
    // A retry of an older request returns its saved receipt, without canceling
    // whichever newer request currently owns the title.
    await this.cancelSuperseded(id); this.engine.harness.resume(); return durableId;
  }
  async cancelSuperseded(id: string) {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    this.cancelStale(id, task?.titleRegeneration?.requestId);
  }
  cancelStale(id: string, requestId?: string) {
    for (const run of this.live.values()) if (run.id === id && run.requestId !== requestId) run.controller.abort();
  }
  beginShutdown() { this.stopping = true; for (const run of this.live.values()) run.controller.abort(); }
  async recover() {
    const state = await this.engine.snapshot();
    for (const [id, request] of Object.entries(state.titleRequests ?? {})) {
      if (request.status !== 'pending') continue;
      const task = await this.engine.harness.getTask(request.durableId as TaskId, context);
      if (!task || task.state.status === 'terminal') await this.finish(request.taskId, id, 'interrupted');
    }
    if (state.tasks.some(task => task.titleRegeneration && state.titleRequests?.[task.titleRegeneration.requestId]?.taskId !== task.id)) {
      await this.engine.mutate(state => {
        for (const task of state.tasks) if (task.titleRegeneration && state.titleRequests?.[task.titleRegeneration.requestId]?.taskId !== task.id) task.titleRegeneration = null;
      });
    }
  }
  async stop(id: string) {
    this.cancelStale(id);
    const state = await this.engine.snapshot();
    for (const request of Object.values(state.titleRequests ?? {})) if (request.taskId === id && request.status === 'pending') {
      await this.engine.harness.abortTask(request.durableId as TaskId, context); await this.engine.harness.waitForTask(request.durableId as TaskId, context);
    }
  }
  private async finish(id: string, requestId: string, status: TitleStatus, title?: string) {
    await this.engine.mutate(state => {
      const request = state.titleRequests && Object.hasOwn(state.titleRequests, requestId) ? state.titleRequests[requestId] : undefined;
      if (!request || request.taskId !== id) return;
      const task = state.tasks.find(task => task.id === id);
      if (task?.titleRegeneration?.requestId !== requestId) { request.status = 'superseded'; return; }
      task.titleRegeneration = null;
      if (title && title !== task.title.trim()) task.title = title;
      request.status = status;
    });
  }
}
