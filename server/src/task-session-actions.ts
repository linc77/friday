import { randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeFork, activeRewind, activeGitOperation, activeStatuses, headForkSourceBusy, type WorkItem } from './types.js';
import { backgroundWorkPending } from './native-runtime-types.js';
import { taskProviderInstance, providerDrivers, providerInstanceID, type ProviderDriver } from './provider-instances.js';
import { providerOptionSelections, type ProviderOptionSelection } from './provider-models.js';
import { taskTransferDigest, taskTransferRequestID, type TaskContextTransfer } from './task-transfers.js';

export type TaskProviderSelection = { agent: ProviderDriver; providerInstanceId: string; model?: string; reasoningEffort?: string; modelOptions?: ProviderOptionSelection[]; interactionMode: 'default' | 'plan' };
export type TaskProviderHistory = { epoch: string; agent: string; providerInstanceId: string; threadId: string | null; executionSessionId?: string; nativeProviderAccount?: string; codexHome?: string; claudeHome?: string; piHome?: string; grokHome?: string; runId?: string; at: string };
export type TaskSessionOperation = {
  id: string; requestId: string; durableId: number; kind: 'disconnect' | 'handoff'; status: 'pending' | 'completed' | 'uncertain';
  source: TaskProviderHistory; target?: TaskProviderSelection; transfer?: TaskContextTransfer;
  createdAt: string; completedAt?: string; error?: string;
};
type Input = { taskId: string; id: string };
const stamp = () => new Date().toISOString();
export const providerEpoch = (task: WorkItem) => task.providerEpoch ?? task.agent + ':' + taskProviderInstance(task) + ':initial';
export const nativeSessionActionBusy = (task: WorkItem) => task.sessionOperation?.status === 'pending' || task.sessionOperation?.status === 'uncertain';
const sourceIdentity = (task: WorkItem) => ({ epoch: providerEpoch(task), agent: task.agent, providerInstanceId: taskProviderInstance(task), threadId: task.threadId, executionSessionId: task.executionSessionId, runId: task.currentRunId });
const sameLogicalSource = (task: WorkItem, source: Pick<TaskProviderHistory, 'epoch' | 'agent' | 'providerInstanceId' | 'runId'>) => providerEpoch(task) === source.epoch && task.agent === source.agent && taskProviderInstance(task) === source.providerInstanceId && task.currentRunId === source.runId;
const matchesSource = (task: WorkItem, source: TaskProviderHistory) => taskTransferDigest(sourceIdentity(task)) === taskTransferDigest({ epoch: source.epoch, agent: source.agent, providerInstanceId: source.providerInstanceId, threadId: source.threadId, executionSessionId: source.executionSessionId, runId: source.runId });

/** Detach only the owned old transport. A handoff creates no native replacement
 * and sends no user input: its next ordinary Durable execution does that. */
export class TaskSessionActions {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'detach' }, { status: string }, {}>({
      name: 'friday.native_session_action', version: 1, initial: () => ({ phase: 'detach' }),
      phases: { detach: async (job, runtime, ctx) => {
        const current = async () => (await engine.snapshot()).tasks.find(work => work.id === job.input.taskId);
        const work = await current(), operation = work?.sessionOperation;
        const done = async (status: 'completed' | 'uncertain', error?: string) => {
          await engine.mutate(state => { const task = state.tasks.find(work => work.id === job.input.taskId); if (task?.sessionOperation?.id === job.input.id) { Object.assign(task.sessionOperation, { status, completedAt: stamp(), ...(error ? { error } : {}) }); task.updatedAt = stamp(); } });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        if (!work || operation?.id !== job.input.id || operation.status !== 'pending') { await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'superseded' } } }), ctx); return; }
        let ownedSource = operation.source;
        const alignSource = async (latest: WorkItem) => {
          if (matchesSource(latest, ownedSource)) return;
          if (!sameLogicalSource(latest, ownedSource)) throw new Error('会话范围已改变，未断开新的 Agent');
          const refreshed: TaskProviderHistory = JSON.parse(JSON.stringify({ ...ownedSource, ...sourceIdentity(latest) }));
          await engine.mutate(state => {
            const current = state.tasks.find(task => task.id === latest.id);
            if (!current || current.sessionOperation?.id !== operation.id || !matchesSource(current, refreshed)) throw new Error('原生会话范围已改变');
            current.sessionOperation.source = refreshed;
          });
          ownedSource = refreshed;
        };
        try {
          await alignSource(work);
          if (!await runtime.memo<boolean>('closed', ctx)) {
            if (await runtime.memo<boolean>('started', ctx)) { await done('uncertain', '原生会话断开结果尚未确认，请核对后重试'); return; }
            await runtime.memo('started', true, ctx);
            if (activeStatuses.includes(work.status)) await engine.cancel(work.id);
            else { await engine.taskQueue.stop(work.id); await engine.backgroundStops.cancelSettled(work); }
            const latest = await current(); if (!latest) throw new Error('原生会话范围已改变'); await alignSource(latest);
            await engine.executor.stopNativeSession?.(work.id, ownedSource.executionSessionId ?? '');
            await runtime.memo('closed', true, ctx);
          }
          if (operation.kind === 'handoff') {
            if (!operation.target || !operation.transfer) throw new Error('缺少上下文交接快照');
            await engine.mutate(state => {
              const task = state.tasks.find(work => work.id === job.input.taskId);
              if (!task || task.sessionOperation?.id !== operation.id || !matchesSource(task, ownedSource)) throw new Error('Agent 交接的源会话已经改变');
              for (const run of task.runs ?? []) { run.agent ??= task.agent; run.providerInstanceId ??= taskProviderInstance(task); run.providerEpoch ??= providerEpoch(task); }
              task.providerHistory ??= []; task.providerHistory.push(ownedSource);
              task.contextTransfers ??= []; for (const transfer of task.contextTransfers) if (transfer.kind === 'provider_handoff' && transfer.status === 'pending') transfer.status = 'superseded';
              task.contextTransfers.push(operation.transfer!);
              task.agent = operation.target!.agent; task.providerInstanceId = operation.target!.providerInstanceId; task.providerEpoch = randomUUID();
              task.model = operation.target!.model; task.reasoningEffort = operation.target!.reasoningEffort; task.modelOptions = operation.target!.modelOptions ?? []; task.interactionMode = operation.target!.interactionMode;
              task.threadId = null; task.turnId = null; task.canSteer = false; task.contextUsage = null; task.goal = null;
              delete task.currentRunId;
              for (const key of ['executionSessionId','nativeProviderAccount','nativeHead','codexHome','claudeHome','piHome','grokHome','claudeResumeSessionAt','claudeResumePendingRun','nativeHeadForkSupported','nativeHistory'] as const) delete task[key];
              task.nativeBackgroundConnected = false; task.backgroundWaiting = false;
              for (const approval of task.approvals) if (approval.state === 'pending') approval.state = 'expired';
              task.sessionOperation.status = 'completed'; task.sessionOperation.completedAt = stamp(); task.updatedAt = stamp();
            });
          }
          await done('completed');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await done('uncertain', error instanceof Error ? error.message : '原生会话操作尚未确认');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await engine.mutate(state => { const work = state.tasks.find(work => work.id === task.input.taskId); if (work?.sessionOperation?.id === task.input.id && work.sessionOperation.status === 'pending') { work.sessionOperation.status = 'uncertain'; work.sessionOperation.error = '原生会话操作已中断，请核对后重试'; work.updatedAt = stamp(); } });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx);
      },
    });
  }
  async start(taskId: string, input: { requestId: string; kind: 'disconnect' | 'handoff'; target?: TaskProviderSelection }) {
    taskTransferRequestID(input.requestId);
    if (!['disconnect','handoff'].includes(input.kind)) throw new Error('原生会话操作无效');
    const state = await this.engine.snapshot(), work = state.tasks.find(work => work.id === taskId);
    const target = input.kind === 'handoff' ? this.selection(input.target) : undefined;
    const intent = taskTransferDigest([taskId, input.kind, target]);
    const prior = state.taskSessionRequests?.[input.requestId];
    if (prior) { if (prior.taskId !== taskId || prior.intent !== intent) throw new Error('会话操作请求 ID 已被使用'); await this.engine.harness.waitForTask(prior.durableId as TaskId, BACKGROUND_CONTEXT); return; }
    if (!work || work.agent === 'friday' || work.subagentOrigin || work.archivedAt) throw new Error('请选择可操作的本地 Agent 任务');
    if (target && target.agent === work.agent && target.providerInstanceId === taskProviderInstance(work)) throw new Error('请选择其他 Agent 或 Provider 实例');
    if (target && (activeStatuses.includes(work.status) || backgroundWorkPending(work) || work.queue?.dispatcherId != null || work.queue?.messages.some(message => ['queued','dispatching','steering','running'].includes(message.status)) || work.approvals.some(approval => approval.state === 'pending'))) throw new Error('请在前台、后台和队列均空闲时切换 Agent');
    if (target) await this.engine.validateTaskProviderSelection(target);
    const version = taskTransferDigest([sourceIdentity(work), work.runs, work.messages]);
    const transfer = target ? await this.engine.transfers.capture(work, taskId, randomUUID(), 'provider_handoff') : undefined;
    let durableId = 0;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), prior = state.taskSessionRequests?.[input.requestId];
      if (prior) { if (prior.intent !== intent) throw new Error('会话操作请求 ID 已被使用'); durableId = prior.durableId; return; }
      if (Object.hasOwn(state.requests, input.requestId)) throw new Error('请求 ID 已被其他操作使用');
      const task = state.tasks.find(work => work.id === taskId);
      if (!task || (target ? taskTransferDigest([sourceIdentity(task), task.runs, task.messages]) !== version : !sameLogicalSource(task, sourceIdentity(work))) || task.sessionOperation?.status === 'pending' || activeFork(task.forkOperation) || activeRewind(task.rewindOperation) || headForkSourceBusy(state.tasks, taskId) || activeGitOperation(task.gitOperation) || task.backgroundStop?.status === 'pending' || task.archiveCleanup?.status === 'pending' || task.settleCleanup?.status === 'pending') throw new Error('会话正在变化，请等待当前操作完成');
      if (target && (activeStatuses.includes(task.status) || backgroundWorkPending(task) || task.queue?.dispatcherId != null || task.queue?.messages.some(message => ['queued','dispatching','steering','running'].includes(message.status)) || task.approvals.some(approval => approval.state === 'pending'))) throw new Error('请在前台、后台和队列均空闲时切换 Agent');
      const id = randomUUID(); durableId = await tx.createTask(this.definition, { taskId, id }, { ownership: { kind: 'conversation' } });
      const source: TaskProviderHistory = { ...sourceIdentity(task), nativeProviderAccount: task.nativeProviderAccount, codexHome: task.codexHome, claudeHome: task.claudeHome, piHome: task.piHome, grokHome: task.grokHome, at: stamp() };
      task.sessionOperation = JSON.parse(JSON.stringify({ id, requestId: input.requestId, durableId, kind: input.kind, source, ...(target ? { target, transfer } : {}), status: 'pending', createdAt: stamp() }));
      if (task.queue) task.queue.paused = true;
      task.canSteer = false; task.updatedAt = stamp();
      state.taskSessionRequests ??= {}; state.taskSessionRequests[input.requestId] = { taskId, durableId, intent }; state.requests[input.requestId] = taskId; state.revision++;
    }, BACKGROUND_CONTEXT);
    this.engine.harness.resume(); await this.engine.harness.waitForTask(durableId as TaskId, BACKGROUND_CONTEXT);
  }
  async retry(taskId: string, requestId: string) {
    const work = (await this.engine.snapshot()).tasks.find(task => task.id === taskId), operation = work?.sessionOperation;
    if (!operation || operation.status !== 'uncertain') throw new Error('没有待核对的原生会话操作');
    await this.start(taskId, { requestId, kind: operation.kind, target: operation.target });
  }
  private selection(value?: TaskProviderSelection): TaskProviderSelection {
    if (!value || !providerDrivers.includes(value.agent)) throw new Error('请选择已接入的 Agent');
    const model = (value: unknown) => { if (value === undefined || value === '') return undefined; if (typeof value !== 'string' || value.length > 120 || /[\x00-\x1f]/.test(value)) throw new Error('模型参数无效'); return value; };
    const interactionMode = value.interactionMode ?? 'default'; if (!['default','plan'].includes(interactionMode)) throw new Error('交互模式无效');
    return { agent: value.agent, providerInstanceId: providerInstanceID(value.providerInstanceId ?? value.agent), model: model(value.model), reasoningEffort: model(value.reasoningEffort), modelOptions: providerOptionSelections(value.modelOptions) ?? [], interactionMode };
  }
}
