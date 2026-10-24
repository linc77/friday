import { providerOptionSelections } from './provider-models.js';
import { randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { IdeaImages } from './ideas.js';
import { branchBlocksTask } from './branch-switch.js';
import { activeFork, headForkSourceBusy, activeRewind, activeStatuses, failedWorkspacePreparation, taskExecutionScopeMatches, type TaskExecutionScope, type IdeaImage, type QueuedTaskMessage, type WorkItem, type TaskInteractionMode, type Workspace } from './types.js';
import type { WatchNotification } from './task-change-request-watch-types.js';
import { endPullRequestWatch } from './task-change-request-watch.js';

const pending = (item: QueuedTaskMessage) => ['queued', 'dispatching', 'running'].includes(item.status);
export const queueRunning = (task: WorkItem) => task.queue?.dispatcherId != null && !task.queue.paused;
const stamp = () => new Date().toISOString();
// Durable document values are transaction-scoped overlays, not cloneable objects.
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validRequest = (id: string) => {
  if (!id || id.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('请求 ID 无效');
};
const localTask = (task: WorkItem | undefined): WorkItem => {
  if (!task || task.agent === 'friday') throw new Error('本地任务不存在');
  if (task.subagentOrigin) throw new Error('原生子 Agent 不接收排队输入，请返回父任务');
  return task;
};
type QueueInput = { id: string; predecessor: number | null; explicit: boolean };
type Checkpoint = { phase: 'wait' | 'dispatch' } | { phase: 'after'; messageId: string };
export type QueueMessageInput = { text: string; images?: IdeaImage[]; contextIds?: string[]; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[]; interactionMode?: TaskInteractionMode };

/** Durable owns waiting and recovery; the workspace document is the queue projection. */
export class TaskQueue {
  readonly definition;
  constructor(private engine: Engine) {
    this.definition = defineTask<QueueInput, Checkpoint, { status: string }, {}>({
      name: 'friday.task_queue', version: 1, initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (task, runtime, ctx) => {
          await runtime.commit(() => task.input.predecessor === null
            ? { status: 'running', checkpoint: { phase: 'dispatch' } }
            : { status: 'waiting', checkpoint: { phase: 'dispatch' }, on: [task.input.predecessor as TaskId], policy: 'allSettled' }, ctx);
        },
        dispatch: async (task, runtime, ctx) => {
          let entry: QueuedTaskMessage | undefined;
          let work: WorkItem | undefined;
          await engine.mutate(state => {
            const current = state.tasks.find(item => item.id === task.input.id);
            if (!current?.queue || current.queue.dispatcherId !== task.id) return;
            const queue = current.queue;
            // A claim or child receipt survives a crash before the wait checkpoint.
            const inFlight = queue.messages.find(item => item.status === 'dispatching' || item.status === 'running');
            if (queue.paused || (!inFlight && !task.input.explicit && current.status !== 'completed')) {
              if (!queue.paused && failedWorkspacePreparation(current)) queue.heldByRunId = current.currentRunId;
              queue.paused = queue.messages.some(pending);
              queue.dispatcherId = null;
              queue.error = queue.paused ? queue.error ?? '任务已停止或中断，请检查结果后继续排队消息。' : null;
              return;
            }
            const next = inFlight ?? queue.messages.find(item => item.status === 'queued');
            if (!next) { queue.dispatcherId = null; queue.error = null; return; }
            if (next.creationSource === 'monitor' && (current.archivedAt || current.settledAt || current.settledOverride === 'settled' || current.subagentOrigin)) {
              next.status = 'cancelled'; queue.dispatcherId = null; return;
            }
            if (next.status === 'queued') { next.status = 'dispatching'; next.error = null; }
            entry = snapshot(next); work = snapshot(current);
          });
          if (!entry || !work) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'idle' } } }), ctx);
            return;
          }
          try {
            runtime.signal.throwIfAborted();
            let runId = entry.runId;
            if (runId === undefined) {
              await engine.createTask({ continueId: work.id, prompt: entry.text, images: entry.images, contextIds: entry.contexts?.map(ref => ref.id),
                projectId: work.projectId, mode: work.mode, requestId: entry.dispatchId,
                model: entry.model, reasoningEffort: entry.reasoningEffort, modelOptions: entry.modelOptions, interactionMode: entry.interactionMode,
                queueMessageId: entry.id, queueDispatcherId: task.id });
              const current = (await engine.snapshot()).tasks.find(item => item.id === work!.id);
              runId = current?.queue?.messages.find(item => item.id === entry!.id)?.runId;
            }
            if (runId === undefined) throw new Error('排队消息未取得持久执行回执');
            await runtime.commit(() => ({ status: 'waiting', checkpoint: { phase: 'after', messageId: entry!.id }, on: [runId as TaskId], policy: 'allSettled' }), ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await engine.mutate(state => {
              const current = state.tasks.find(item => item.id === task.input.id);
              if (!current?.queue || current.queue.dispatcherId !== task.id) return;
              const item = current.queue.messages.find(item => item.id === entry!.id);
              if (item?.status === 'dispatching') item.status = 'queued';
              const message = error instanceof Error ? error.message : '无法开始排队消息';
              if (item) item.error = message;
              current.queue.paused = true; current.queue.error = message; current.queue.dispatcherId = null;
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'paused' } } }), ctx);
          }
        },
        after: async (task, runtime, ctx) => {
          await engine.mutate(state => {
            const work = state.tasks.find(item => item.id === task.input.id);
            if (!work?.queue || work.queue.dispatcherId !== task.id) return;
            const entry = work.queue.messages.find(item => item.id === task.state.checkpoint.messageId);
            if (entry?.status === 'running') {
              entry.status = work.status === 'completed' ? 'completed' : 'failed';
              entry.error = work.error;
            }
            if (work.status !== 'completed') {
              if (!work.queue.paused && failedWorkspacePreparation(work)) work.queue.heldByRunId = work.currentRunId;
              work.queue.paused = work.queue.messages.some(pending);
              work.queue.error = work.queue.paused ? '任务已停止或中断，请检查结果后继续排队消息。' : null;
            }
          });
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'dispatch' } }), ctx);
        },
      },
      abort: async (task, runtime, ctx) => {
        await engine.mutate(state => {
          const work = state.tasks.find(item => item.id === task.input.id);
          if (!work?.queue || work.queue.dispatcherId !== task.id) return;
          for (const item of work.queue.messages) if (item.status === 'dispatching') item.status = 'queued';
          work.queue.paused = work.queue.messages.some(pending); work.queue.dispatcherId = null;
        });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'paused' } } }), ctx);
      },
    });
  }

  /** Called by the watch's existing Durable root transaction. Advancing the
   * watermark and publishing its queued wake must succeed together. */
  async enqueueMonitor(tx: Parameters<Parameters<Engine['root']['commit']>[0]>[0], state: Workspace, task: WorkItem, text: string, notification: WatchNotification, requestId: string) {
    if (Object.hasOwn(state.requests, requestId)) return;
    task.queue ??= { dispatcherId: null, paused: false, messages: [] };
    task.queue.messages.push({ id: requestId, dispatchId: randomUUID(), text, images: [], createdAt: stamp(), status: 'queued', creationSource: 'monitor', notification, interactionMode: task.interactionMode ?? 'default' });
    state.requests[requestId] = task.id;
    if (!task.queue.paused && task.queue.dispatcherId === null) {
      task.queue.dispatcherId = await tx.createTask(this.definition, { id: task.id, predecessor: task.backgroundStop?.status === 'pending' ? task.backgroundStop.durableId : task.durableId, explicit: !activeStatuses.includes(task.status) }, { ownership: { kind: 'conversation' } });
    }
  }

  async enqueue(id: string, input: QueueMessageInput, requestId: string) {
    validRequest(requestId);
    const images = await new IdeaImages(this.engine.directory).validate(input.images);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      if (Object.hasOwn(state.requests, requestId)) {
        if (state.requests[requestId] !== id) throw new Error('请求 ID 已被其他任务使用');
        return;
      }
      const task = localTask(state.tasks.find(task => task.id === id));
      const references = await this.engine.contexts.references(input.text, input.contextIds, { task, project: state.projects.find(project => project.id === task.projectId) });
      if (activeRewind(task.rewindOperation)) throw new Error('请先处理会话回退，再发送排队消息');
      if (activeFork(task.forkOperation) || headForkSourceBusy(state.tasks, task.id)) throw new Error('请先处理会话分叉，再发送排队消息');
      if (task.claudeResumeSessionAt && task.claudeResumePendingRun) throw new Error('Claude 回退续接结果待核对，请先处理会话历史');
      if (task.archivedAt) throw new Error('请先恢复归档任务');
      task.queue ??= { dispatcherId: null, paused: false, messages: [] };
      if (!task.queue.paused && failedWorkspacePreparation(task)) {
        task.queue.paused = true; task.queue.heldByRunId = task.currentRunId;
        task.queue.error = '工作区准备失败，重试后继续排队消息。';
      }
      task.queue.messages.push({ id: requestId, dispatchId: randomUUID(), text: input.text, images, createdAt: stamp(), status: 'queued',
        ...(references.length ? { contexts: references } : {}),
        interactionMode: input.interactionMode ?? task.interactionMode ?? 'default',
        ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.modelOptions !== undefined ? { modelOptions: providerOptionSelections(input.modelOptions) } : {}) });
      state.requests[requestId] = id;
      if (!task.queue.paused) task.queue.error = null;
      if (task.queue.dispatcherId === null && !task.queue.paused) {
        task.queue.dispatcherId = await tx.createTask(this.definition, { id, predecessor: task.backgroundStop?.status === 'pending' ? task.backgroundStop.durableId : task.durableId, explicit: !activeStatuses.includes(task.status) }, { ownership: { kind: 'conversation' } });
      }
      state.revision++;
    }, context);
    this.engine.harness.resume();
    return id;
  }

  /** Save the user's next message in the SAME root transaction as compact.
   * The existing queue waits for that command and holds input on any failure. */
  async enqueueAfterCompaction(tx: Parameters<Parameters<Engine['root']['commit']>[0]>[0], state: Workspace, task: WorkItem, input: QueueMessageInput & { requestId: string }) {
    validRequest(input.requestId);
    if (Object.hasOwn(state.requests, input.requestId)) throw new Error('发送请求已经使用，请刷新后核对');
    const references = await this.engine.contexts.references(input.text, input.contextIds, { task, project: state.projects.find(project => project.id === task.projectId) });
    task.queue ??= { dispatcherId: null, paused: false, messages: [] };
    task.queue.paused = false; task.queue.error = null; delete task.queue.heldByRunId; delete task.queue.heldOnRestart;
    task.queue.messages.push({ id: input.requestId, dispatchId: randomUUID(), text: input.text, images: input.images ?? [], createdAt: stamp(), status: 'queued',
      ...(references.length ? { contexts: references } : {}), interactionMode: input.interactionMode ?? task.interactionMode ?? 'default',
      ...(input.model !== undefined ? { model: input.model } : {}), ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}), ...(input.modelOptions !== undefined ? { modelOptions: providerOptionSelections(input.modelOptions) } : {}) });
    state.requests[input.requestId] = task.id;
    task.queue.dispatcherId = await tx.createTask(this.definition, { id: task.id, predecessor: task.durableId, explicit: false }, { ownership: { kind: 'conversation' } });
  }

  async edit(id: string, messageId: string, input: QueueMessageInput) {
    const images = input.images === undefined ? undefined : await new IdeaImages(this.engine.directory).validate(input.images);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const task = localTask(state.tasks.find(task => task.id === id));
      const message = task.queue?.messages.find(item => item.id === messageId);
      if (!message || message.status !== 'queued') throw new Error('这条消息已经开始发送，不能再编辑');
      message.contexts = await this.engine.contexts.references(input.text, input.contextIds ?? message.contexts?.map(ref => ref.id), { task, project: state.projects.find(project => project.id === task.projectId) });
      message.text = input.text; if (images !== undefined) message.images = images; message.error = null;
      if (input.model !== undefined) message.model = input.model;
      if (input.reasoningEffort !== undefined) message.reasoningEffort = input.reasoningEffort;
      if (input.modelOptions !== undefined) message.modelOptions = providerOptionSelections(input.modelOptions);
      if (input.interactionMode !== undefined) message.interactionMode = input.interactionMode;
      state.revision++;
    }, context);
  }

  async move(id: string, messageId: string, beforeId: string | null) {
    await this.engine.mutate(state => {
      const task = localTask(state.tasks.find(task => task.id === id));
      const messages = task.queue?.messages ?? [];
      const index = messages.findIndex(item => item.id === messageId && item.status === 'queued');
      if (index < 0) throw new Error('这条消息已经开始发送，不能再排序');
      if (beforeId === messageId) return;
      if (beforeId !== null && !messages.some(item => item.id === beforeId && item.status === 'queued')) throw new Error('排序目标已改变，请刷新后重试');
      const [item] = messages.splice(index, 1);
      const destination = beforeId === null ? messages.length : messages.findIndex(item => item.id === beforeId);
      messages.splice(destination, 0, item);
    });
  }

  async remove(id: string, messageId: string) {
    await this.engine.mutate(state => {
      const task = localTask(state.tasks.find(task => task.id === id));
      const message = task.queue?.messages.find(item => item.id === messageId);
      if (!message) throw new Error('排队消息不存在');
      if (message.status === 'cancelled') return;
      if (message.status !== 'queued') throw new Error('这条消息已经开始发送，不能从队列删除');
      message.status = 'cancelled'; message.error = null;
    });
  }

  async promote(id: string, messageId: string) {
    let message!: QueuedTaskMessage;
    await this.engine.mutate(state => {
      const task = localTask(state.tasks.find(task => task.id === id));
      const entry = task.queue?.messages.find(item => item.id === messageId);
      if (!entry || entry.status !== 'queued' || task.canSteer === false || !['running', 'waiting'].includes(task.status)) throw new Error('当前不能把这条消息补充到执行中');
      if ((entry.interactionMode ?? task.interactionMode ?? 'default') !== (task.interactionMode ?? 'default')) throw new Error('交互模式不同，请保留在队列中等待下一轮');
      entry.status = 'steering'; message = snapshot(entry);
    });
    try {
      await this.engine.steer(id, message.text, message.dispatchId, message.images, message.contexts?.map(ref => ref.id));
      await this.engine.mutate(state => {
        const item = state.tasks.find(task => task.id === id)?.queue?.messages.find(item => item.id === messageId);
        if (item) { item.status = 'completed'; item.error = null; }
      });
    } catch (error) {
      await this.engine.mutate(state => {
        const task = state.tasks.find(task => task.id === id);
        const item = task?.queue?.messages.find(item => item.id === messageId);
        const receipt = task?.messages?.find(item => item.id === message.dispatchId)?.delivery;
        if (item) {
          item.status = receipt === 'sent' ? 'completed' : receipt ? 'uncertain' : 'queued';
          item.error = error instanceof Error ? error.message : '发送结果尚未确认';
          if (item.status === 'queued' && task?.queue?.dispatcherId === null) {
            task.queue.paused = true; task.queue.error = item.error;
          }
        }
      });
      throw error;
    }
  }

  async resume(id: string, requestId: string) {
    validRequest(requestId);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      if (Object.hasOwn(state.requests, requestId)) {
        if (state.requests[requestId] !== id) throw new Error('请求 ID 已被其他任务使用');
        return;
      }
      const task = localTask(state.tasks.find(task => task.id === id));
      if (!task.queue?.messages.some(item => item.status === 'queued')) throw new Error('没有等待继续的排队消息');
      if (failedWorkspacePreparation(task) && task.executionWorkspace?.state !== 'ready') throw new Error('请先重试工作区准备，再继续排队消息');
      if (branchBlocksTask(state, task.cwd)) throw new Error('工作区有 Git 操作正在进行，请完成后再继续队列');
      if (activeStatuses.includes(task.status)) throw new Error('请等待当前任务结束后再恢复暂停的队列');
      for (const item of task.queue.messages) if (item.status === 'running') { item.status = task.status === 'completed' ? 'completed' : 'failed'; item.error = task.error; }
      task.queue.paused = false; task.queue.error = null; delete task.queue.heldByRunId; delete task.queue.heldOnRestart;
      task.queue.dispatcherId = await tx.createTask(this.definition, { id, predecessor: task.backgroundStop?.status === 'pending' ? task.backgroundStop.durableId : task.durableId, explicit: true }, { ownership: { kind: 'conversation' } });
      state.requests[requestId] = id; state.revision++;
    }, context);
    this.engine.harness.resume();
  }

  async pause(id: string, scope?: TaskExecutionScope) {
    await this.engine.mutate(state => {
      const task = state.tasks.find(task => task.id === id);
      if (scope && (!task || !taskExecutionScopeMatches(task, scope))) throw new Error('停止请求所属的回复已经改变，请刷新后重试');
      if (task?.currentRunId) task.lastStoppedRunId = task.currentRunId;
      if (task?.queue) { task.queue.paused = true; delete task.queue.heldByRunId; delete task.queue.heldOnRestart; }
      for (const link of task?.changeRequests ?? []) if (link.watch) endPullRequestWatch(link);
    });
  }

  async recover() {
    await this.hold();
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      for (const task of state.tasks) {
        const queue = task.queue, entries = queue?.messages.filter(pending);
        if (!queue?.heldOnRestart || !entries?.length || task.archivedAt || task.settledAt || task.subagentOrigin
          || !entries.every(item => item.creationSource === 'monitor' && (item.status === 'queued' || item.status === 'dispatching' && item.runId === undefined))) continue;
        // The watermark's wake was saved before any external run began. Resume
        // only these monitor entries; human holds and uncertain turns stay held.
        queue.paused = false; queue.error = null; delete queue.heldOnRestart;
        if (queue.dispatcherId === null) queue.dispatcherId = await tx.createTask(this.definition, { id: task.id, predecessor: task.durableId, explicit: true }, { ownership: { kind: 'conversation' } });
        state.revision++;
      }
    }, context);
  }

  async hold() {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      for (const task of state.tasks) {
        if (!task.queue || !task.queue.messages.some(pending)) continue;
        // Match T3's queueHeld contract on startup and shutdown, even when the
        // preceding turn already completed. Resuming is an explicit user action.
        if (!task.queue.paused) task.queue.heldOnRestart = true;
        task.queue.paused = true;
        delete task.queue.heldByRunId;
        task.queue.error ??= '服务已重新连接，请确认后继续排队消息。';
        for (const item of task.queue.messages) if (item.status === 'dispatching' && item.runId === undefined) item.status = 'queued';
        state.revision++;
      }
    }, context);
  }

  async stop(id: string) {
    await this.pause(id);
    const dispatcher = (await this.engine.snapshot()).tasks.find(task => task.id === id)?.queue?.dispatcherId;
    if (dispatcher != null) {
      await this.engine.harness.abortTask(dispatcher as TaskId, context);
      await this.engine.harness.waitForTask(dispatcher as TaskId, context);
    }
  }
}
