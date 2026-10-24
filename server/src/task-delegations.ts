// Behavior reference: T3 Code 8cd9641f OrchestratorMcpService and
// DelegatedCompletionDelivery. MIT notice: vendor/t3code/LICENSE.
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { Approval, TaskStatus, TaskWorkspacePlan, WorkItem, Workspace } from './types.js';
import { activeStatuses } from './types.js';
import { WorkspaceDoc } from './state.js';
import { assertWatchActor, type WatchActor } from './task-change-request-watch.js';
import { backgroundWorkPending } from './native-runtime-types.js';
import { taskProviderInstance } from './provider-instances.js';
import { nativeSessionActionBusy } from './task-session-actions.js';
import { taskGit } from './git-process.js';

export type TaskDelegationOrigin = { id: string; parentTaskId: string; parentRunId: string; role: string; isolation: 'shared' | 'worktree' };
export type TaskDelegation = TaskDelegationOrigin & {
  childTaskId: string; childRunId: string; observerId: number; digest: string; mode: 'async' | 'wait';
  status: TaskStatus; createdAt: string; updatedAt: string; summary?: string; resultContextTransferId?: string;
  hasPendingQuestion?: boolean; pendingChildren?: boolean; cancelRequested?: boolean; suppressed?: boolean;
  delivered?: boolean; waitDelivered?: boolean;
};
export type DelegationCreation = { childTaskId: string; origin: TaskDelegationOrigin; digest: string; mode: 'async' | 'wait'; actor: WatchActor; workspace: TaskWorkspacePlan };
type Transaction = Parameters<Parameters<Engine['root']['commit']>[0]>[0];
const stamp = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const pending = (task: WorkItem) => activeStatuses.includes(task.status) || backgroundWorkPending(task) || task.queue?.dispatcherId != null;
export const delegatedQuestion = (approval: Approval) => approval.state === 'pending' && /(?:requestUserInput|\/question|\/user_input)$/.test(approval.method) && approval.questions.length > 0 && approval.questions.every(question => question.isSecret !== true);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子任务参数无效');
  return value as Record<string, unknown>;
};
const text = (value: unknown, maximum: number, optional = false) => {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error('子任务文本或请求 ID 无效');
  return value.trim();
};

/** App-owned children use ordinary Friday execution tasks. This observer only
 * joins their existing durable lifetimes and delivers one immutable result. */
export class TaskDelegations {
  readonly definition;
  private stopping = false;
  constructor(private engine: Engine) {
    engine.once('closing', () => { this.stopping = true; });
    this.definition = defineTask<{ id: string }, { phase: 'observe' }, { status: string }, {}>({
      name: 'friday.delegated_task', version: 1, initial: () => ({ phase: 'observe' }),
      phases: { observe: async (task, runtime, ctx) => {
        for (;;) {
          runtime.signal.throwIfAborted();
          const state = await engine.snapshot(), receipt = state.taskDelegations?.[task.input.id];
          if (!receipt || receipt.delivered || receipt.suppressed) break;
          if (this.stopping) { await this.change(runtime.signal, state.revision); continue; }
          const child = state.tasks.find(child => child.id === receipt.childTaskId);
          const parent = state.tasks.find(parent => parent.id === receipt.parentTaskId);
          if (!child || !parent || parent.archivedAt || parent.settledAt || parent.lastStoppedRunId === receipt.parentRunId) {
            await this.patch(receipt.id, value => { value.suppressed = true; }); break;
          }
          await this.project(receipt, child);
          if (!pending(child)) {
            // A visible terminal projection can precede the execution's final
            // checkpoint. Do not wake the parent before that checkpoint lands.
            if (child.durableId) await engine.harness.waitForTask(child.durableId as TaskId, ctx);
            const fresh = await engine.snapshot(), latest = fresh.taskDelegations?.[receipt.id];
            const finalChild = fresh.tasks.find(value => value.id === receipt.childTaskId);
            const finalParent = fresh.tasks.find(value => value.id === receipt.parentTaskId);
            if (!latest || !finalChild || !finalParent || pending(finalChild)) continue;
            if (latest.mode === 'wait' && finalParent.currentRunId === latest.parentRunId && activeStatuses.includes(finalParent.status) && !latest.waitDelivered) {
              await this.change(runtime.signal, fresh.revision); continue;
            }
            const transfer = await engine.transfers.capture(finalChild, finalParent.id, 'delegation-' + receipt.id, 'delegated_completion');
            const delivered = await engine.root.commit(async tx => {
              const state = await tx.doc(WorkspaceDoc), r = state.taskDelegations?.[receipt.id];
              const parent = state.tasks.find(value => value.id === receipt.parentTaskId), child = state.tasks.find(value => value.id === receipt.childTaskId);
              if (this.stopping || !r || r.delivered || r.suppressed || !parent || !child || pending(child)) return false;
              if (parent.lastStoppedRunId === r.parentRunId || parent.archivedAt || parent.settledAt) { r.suppressed = true; state.revision++; return; }
              r.resultContextTransferId = transfer.id; r.delivered = true;
              if (!r.waitDelivered) await engine.taskQueue.enqueueDelegated(tx, state, parent, child, transfer.reference, 'child-result-' + r.id);
              state.revision++;
              return true;
            }, ctx);
            if (!delivered) continue;
            engine.harness.resume(); break;
          }
          await this.change(runtime.signal, state.revision);
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'observed' } } }), ctx);
      } },
      abort: async (task, runtime, ctx) => {
        await this.patch(task.input.id, value => { value.suppressed = true; });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'stopped' } } }), ctx);
      },
    });
  }
  async attach(tx: Transaction, state: Workspace, task: WorkItem, creation: DelegationCreation) {
    const parent = state.tasks.find(value => value.id === creation.origin.parentTaskId);
    if (!parent || parent.agent === 'friday' || parent.subagentOrigin || nativeSessionActionBusy(parent)) throw new Error('父任务不可用');
    assertWatchActor(parent, creation.actor);
    if (parent.cwd !== creation.workspace.sourcePath) throw new Error('父任务执行目录已改变');
    if ((parent.delegatedTasks ?? []).filter(value => !value.suppressed && (activeStatuses.includes(value.status) || value.pendingChildren)).length >= 20) throw new Error('同时执行的子任务不能超过 20 个');
    const observerId = await tx.createTask(this.definition, { id: creation.origin.id }, { ownership: { kind: 'conversation' } });
    const receipt: TaskDelegation = { ...creation.origin, childTaskId: task.id, childRunId: task.currentRunId!, observerId, digest: creation.digest, mode: creation.mode, status: task.status, createdAt: stamp(), updatedAt: stamp() };
    task.delegationOrigin = copy(creation.origin);
    state.taskDelegations ??= {}; state.taskDelegations[receipt.id] = receipt;
    parent.delegatedTasks ??= []; parent.delegatedTasks.push(this.public(receipt)); parent.updatedAt = stamp();
  }
  private public(receipt: TaskDelegation) {
    const { digest: _, observerId: _observer, summary: _summary, ...visible } = receipt; return copy(visible);
  }
  async start(parentId: string, actor: WatchActor, raw: unknown, fallbackRequestId: string, signal: AbortSignal) {
    const value = object(raw);
    if (Object.keys(value).some(key => !['task','target','title','role','isolation','mode','timeoutMs','clientRequestId','runtimeMode','interactionMode'].includes(key))) throw new Error('子任务参数无效');
    const prompt = text(value.task, 120_000)!, title = text(value.title, 512, true), clientId = text(value.clientRequestId ?? fallbackRequestId, 256)!;
    if (value.role !== undefined && !['implementation','research','review','design','test','general'].includes(String(value.role))) throw new Error('子任务角色无效');
    if (value.isolation !== undefined && !['shared','worktree'].includes(String(value.isolation)) || value.mode !== undefined && !['async','wait'].includes(String(value.mode))) throw new Error('子任务执行方式无效');
    if (value.timeoutMs !== undefined && (typeof value.timeoutMs !== 'number' || !Number.isFinite(value.timeoutMs) || value.timeoutMs < 0)) throw new Error('等待时长无效');
    if (value.runtimeMode !== undefined && value.runtimeMode !== 'inherit') throw new Error('此主机的子任务继承所选 Provider 实例权限；请在 Providers 中配置监督权限');
    const state = await this.engine.snapshot(), parent = state.tasks.find(task => task.id === parentId);
    if (!parent || parent.agent === 'friday' || parent.subagentOrigin) throw new Error('父任务不可用'); assertWatchActor(parent, actor);
    const id = hash([parentId, clientId]), digest = hash({ ...value, timeoutMs: undefined, clientRequestId: undefined });
    const existing = state.taskDelegations?.[id];
    if (existing && existing.digest !== digest) throw new Error('子任务请求 ID 已用于不同内容');
    if (!existing) {
      const target = value.target === undefined ? {} : object(value.target);
      if (Object.keys(target).some(key => !['providerInstanceId','driverKind','model','options'].includes(key))) throw new Error('目标 Provider 参数无效');
      const instances = await this.engine.providerInstances.list();
      const instance = instances.find(instance => target.providerInstanceId !== undefined ? instance.instanceId === target.providerInstanceId : target.driverKind !== undefined ? instance.driver === target.driverKind : instance.instanceId === taskProviderInstance(parent));
      if (!instance || !instance.enabled || target.driverKind !== undefined && target.driverKind !== instance.driver) throw new Error('目标 Provider 实例不可用');
      const sameInstance = instance.instanceId === taskProviderInstance(parent), agent = instance.driver;
      const inheritSelection = sameInstance && (target.model === undefined || target.model === parent.model);
      const model = text(target.model, 1024, true) ?? (sameInstance ? parent.model : undefined);
      const options = target.options === undefined ? inheritSelection ? parent.modelOptions : [] : Array.isArray(target.options) ? target.options : Object.entries(object(target.options)).map(([id,value]) => ({id,value}));
      const interactionMode = value.interactionMode === undefined || value.interactionMode === 'inherit' ? parent.interactionMode ?? 'default' : value.interactionMode;
      if (interactionMode !== 'default' && interactionMode !== 'plan') throw new Error('子任务交互模式无效');
      const selection = { agent, providerInstanceId: instance.instanceId, model, modelOptions: options as WorkItem['modelOptions'], reasoningEffort: inheritSelection && target.options === undefined ? parent.reasoningEffort : undefined, interactionMode: interactionMode as 'default' | 'plan' };
      await this.engine.validateTaskProviderSelection(selection);
      const childId = randomUUID(), isolation = value.isolation === 'worktree' ? 'worktree' : 'shared';
      const workspace = await this.workspace(parent, childId, isolation, signal);
      signal.throwIfAborted();
      await this.engine.createTask({ prompt, requestId: 'delegate-' + id, projectId: parent.projectId, mode: parent.mode, title: title ?? prompt.slice(0, 120), ...selection }, {
        childTaskId: childId,
        origin: { id, parentTaskId: parent.id, parentRunId: actor.runId, role: String(value.role ?? 'general'), isolation },
        digest, mode: value.mode === 'wait' ? 'wait' : 'async', actor, workspace,
      });
    }
    if (value.mode === 'wait') {
      const deadline = Date.now() + Math.min(Number(value.timeoutMs ?? 600_000), 86_400_000);
      for (;;) {
        const state = await this.engine.snapshot(), receipt = state.taskDelegations?.[id];
        const child = state.tasks.find(task => task.id === receipt?.childTaskId);
        if (!receipt || !child) throw new Error('子任务已不可用');
        if (!pending(child) || child.approvals.some(value => value.state === 'pending')) {
          if (!pending(child)) await this.patch(id, value => { value.waitDelivered = true; });
          return this.status(parentId, id);
        }
        const remaining = deadline - Date.now(); if (remaining <= 0) return { ...await this.status(parentId, id), waitTimedOut: true };
        await this.change(signal, state.revision, remaining);
      }
    }
    return this.status(parentId, id);
  }
  private async workspace(parent: WorkItem, id: string, isolation: 'shared' | 'worktree', signal: AbortSignal): Promise<TaskWorkspacePlan> {
    const cwd = await realpath(parent.cwd);
    if (isolation === 'shared') return { mode: 'checkout', sourcePath: parent.cwd, root: cwd, cwd, branch: null, commit: null, state: 'ready' };
    const root = await realpath((await taskGit(cwd, ['rev-parse','--show-toplevel'], { signal })).stdout.trim());
    if (root !== cwd) throw new Error('隔离子任务需要仓库根目录；子目录任务请使用 shared');
    const commit = (await taskGit(cwd, ['rev-parse','--verify','HEAD^{commit}'], { signal })).stdout.trim();
    const target = join(await realpath(this.engine.directory), 'worktrees', id);
    return { mode: 'worktree', sourcePath: parent.cwd, root: target, cwd: target, branch: null, commit, targetBranch: 'linc/task-' + id, startFromOrigin: false, submoduleMode: null, state: 'pending' };
  }
  async status(parentId: string, id: string) {
    const state = await this.engine.snapshot(), r = state.taskDelegations?.[id];
    if (!r || r.parentTaskId !== parentId) throw new Error('子任务不属于当前父任务');
    const child = state.tasks.find(task => task.id === r.childTaskId); if (!child) throw new Error('子任务已删除');
    const active = !!backgroundWorkPending(child), terminal = !activeStatuses.includes(child.status);
    return { taskId: r.id, childThreadId: r.childTaskId, childRunId: child.currentRunId ?? null, childNodeId: r.id,
      status: child.status, workState: !terminal ? 'working' : active ? 'waiting_for_children' : 'result_available', hasPendingChildRuns: active,
      latestTerminalRunId: terminal ? child.currentRunId ?? null : null, latestTerminalStatus: terminal ? child.status : null,
      latestTerminalSummary: terminal ? child.result.slice(0, 16_000) || child.error : null, latestTerminalResultContextTransferId: r.resultContextTransferId ?? null,
      providerInstanceId: taskProviderInstance(child), model: child.model ?? null, summary: terminal ? child.result.slice(0,16_000) || child.error : null,
      resultContextTransferId: r.resultContextTransferId ?? null, hasPendingQuestion: child.approvals.some(delegatedQuestion), waitTimedOut: false };
  }
  async cancel(parentId: string, id: string, actor?: WatchActor) {
    const state = await this.engine.snapshot(), r = state.taskDelegations?.[id], parent = state.tasks.find(task => task.id === parentId);
    if (!r || !parent || r.parentTaskId !== parentId) throw new Error('子任务不属于当前父任务'); assertWatchActor(parent, actor);
    await this.patch(id, value => { value.cancelRequested = true; });
    const child = (await this.engine.snapshot()).tasks.find(task => task.id === r.childTaskId);
    if (child && pending(child)) await this.engine.cancel(child.id);
    const current = await this.status(parentId, id);
    return { taskId: id, status: ['completed','failed','cancelled','interrupted'].includes(current.status) ? current.status : 'cancel_requested' };
  }
  async stopChildren(parentId: string) {
    const receipts = Object.values((await this.engine.snapshot()).taskDelegations ?? {}).filter(value => value.parentTaskId === parentId && !value.suppressed);
    for (const receipt of receipts) {
      await this.patch(receipt.id, value => { value.suppressed = true; });
      const child = (await this.engine.snapshot()).tasks.find(task => task.id === receipt.childTaskId);
      if (child && pending(child)) await this.engine.cancel(child.id);
    }
  }
  private async patch(id: string, update: (value: TaskDelegation) => void) {
    await this.engine.root.commit(async tx => { const state = await tx.doc(WorkspaceDoc), receipt = state.taskDelegations?.[id]; if (!receipt) return; update(receipt); receipt.updatedAt = stamp(); this.projectIn(state, receipt); state.revision++; }, context);
  }
  private projectIn(state: Workspace, receipt: TaskDelegation) {
    const parent = state.tasks.find(task => task.id === receipt.parentTaskId), index = parent?.delegatedTasks?.findIndex(value => value.id === receipt.id) ?? -1;
    if (parent?.delegatedTasks && index >= 0) { parent.delegatedTasks[index] = this.public(receipt); parent.updatedAt = stamp(); }
  }
  private async project(receipt: TaskDelegation, child: WorkItem) {
    const summary = child.result.slice(0, 2000), question = child.approvals.some(delegatedQuestion), children = !!backgroundWorkPending(child);
    if (receipt.status === child.status && receipt.summary === summary && receipt.hasPendingQuestion === question && receipt.pendingChildren === children) return;
    await this.patch(receipt.id, value => { value.status = child.status; value.summary = summary; value.hasPendingQuestion = question; value.pendingChildren = children; });
  }
  private change(signal: AbortSignal, revision: number, timeout?: number) {
    return new Promise<void>((resolve, reject) => {
      let checking = false, again = false, settled = false; let timer: NodeJS.Timeout | undefined;
      const done = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); this.engine.off('change', changed); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
      const changed = () => { if (checking) { again = true; return; } checking = true; void this.engine.snapshot().then(state => { if (state.revision !== revision) done(); }).catch(error => done(error)).finally(() => { checking = false; if (again && !settled) { again = false; changed(); } }); };
      const aborted = () => done(new Error('子任务等待已中断'));
      this.engine.on('change', changed); signal.addEventListener('abort', aborted, { once: true });
      if (timeout !== undefined) { timer = setTimeout(() => done(), Math.min(timeout, 2_147_483_647)); timer.unref(); }
      if (signal.aborted) aborted(); else changed();
    });
  }
}
