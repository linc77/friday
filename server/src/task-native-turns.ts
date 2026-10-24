import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { NativeRuntimeUpdate, NativeTurnReceipt } from './native-runtime-types.js';
import { nativeObservedRunId, nativeTurnReceiptKey } from './native-runtime-types.js';
import { WorkspaceDoc } from './state.js';
import { projectSubagentEvent } from './task-subagent-types.js';
import { reconcileTaskSnooze } from './task-snooze.js';

type Input = { taskId: string; receiptKey: string };
const stamp = () => new Date().toISOString();

/** Observe work the existing native CLI already produced. No phase starts or
 * resumes a model, sends a prompt, or replays a native continuation. */
export class TaskNativeTurns {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'observe' }, { status: string }, {}>({
      name: 'friday.native_turn_observation', version: 1, initial: () => ({ phase: 'observe' }),
      phases: { observe: async (task, runtime, ctx) => {
        let receipt = (await this.engine.snapshot()).nativeTurnRequests?.[task.input.receiptKey];
        if (receipt?.status === 'running') {
          try {
            if (!this.engine.executor.waitNativeTurn) throw new Error('Native connection unavailable');
            await this.engine.executor.waitNativeTurn(receipt.taskId, receipt.sessionId, receipt.key, runtime.signal);
          } catch {
            if (runtime.signal.aborted) throw new Error('原生后续回复已中断');
            await this.interrupt(task.input);
          }
          receipt = (await this.engine.snapshot()).nativeTurnRequests?.[task.input.receiptKey];
          if (receipt?.status === 'running') { await this.interrupt(task.input); receipt = (await this.engine.snapshot()).nativeTurnRequests?.[task.input.receiptKey]; }
        }
        if (receipt) await this.finish(receipt);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: receipt?.status ?? 'missing' } } }), ctx);
      } },
      abort: async (task, runtime, ctx) => {
        const receipt = (await this.engine.snapshot()).nativeTurnRequests?.[task.input.receiptKey];
        if (receipt?.status === 'running') await this.engine.executor.interruptNativeTurn?.(receipt.taskId, receipt.sessionId, receipt.key);
        await this.interrupt(task.input);
        const current = (await this.engine.snapshot()).nativeTurnRequests?.[task.input.receiptKey]; if (current) await this.finish(current);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }

  async update(id: string, update: Extract<NativeRuntimeUpdate, { kind: 'nativeTurnStart' | 'nativeTurnUpdate' | 'nativeTurnFinish' }>) {
    const key = nativeTurnReceiptKey(id, update.sessionId, update.key);
    if (update.kind === 'nativeTurnStart') {
      if (update.provider !== undefined) await this.engine.providerInstances.get(update.provider, update.providerInstanceId ?? update.provider, true);
      await this.engine.root.commit(async tx => {
        const state = await tx.doc(WorkspaceDoc); const work = state.tasks.find(work => work.id === id);
        if (!work || work.agent !== (update.provider ?? 'claude') || update.providerInstanceId !== undefined && (work.providerInstanceId ?? work.agent) !== update.providerInstanceId || work.executionSessionId !== update.sessionId || work.threadId !== update.threadId || work.archivedAt || work.settledAt || work.settledOverride === 'settled' || work.archiveCleanup?.status === 'pending' || work.settleCleanup?.status === 'pending' || work.cwd !== update.parameters.cwd) throw new Error('原生后续回复的任务范围已失效');
        if (work.backgroundStop?.status === 'pending' && work.backgroundStop.sessionId === update.sessionId) throw new Error('正在停止这条原生会话');
        if (state.nativeTurnRequests?.[key]) return;
        const at = stamp(); const runId = nativeObservedRunId(update.key);
        const durableId = await tx.createTask(this.definition, { taskId: id, receiptKey: key }, { ownership: { kind: 'conversation' } });
        state.nativeTurnRequests ??= {};
        state.nativeTurnRequests[key] = { taskId: id, threadId: update.threadId, sessionId: update.sessionId, key: update.key, runId, durableId,
          turnId: update.turnId, provider: update.provider ?? 'claude', ...(update.providerInstanceId ? { providerInstanceId: update.providerInstanceId } : {}), status: 'running', result: '' };
        work.runs ??= []; const executionOrder = Math.max(0, ...work.runs.map(run => run.executionOrder ?? 0)) + 1;
        work.runs.push({ id: runId, durableId, messageId: 'notification:' + key, requestId: 'native:' + key, cwd: update.parameters.cwd,
          at, startedAt: at, status: 'running', turnId: update.turnId, threadId: update.threadId, executionOrder, mode: update.parameters.mode,
          interactionMode: update.parameters.interactionMode ?? 'default', modelOptions: update.parameters.modelOptions ?? work.modelOptions ?? [], ...(update.parameters.model ? { model: update.parameters.model } : {}), ...(update.parameters.reasoningEffort ? { reasoningEffort: update.parameters.reasoningEffort } : {}) });
        work.events.push({ id: 'notification:' + key, kind: 'notification', text: '后台任务的后续回复', at, runId });
        const current = work.runs.find(run => run.id === work.currentRunId);
        if (!['queued', 'running', 'waiting'].includes(work.status) || current && !['queued', 'running'].includes(current.status)) {
          work.currentRunId = runId; work.durableId = durableId; work.turnId = update.turnId; work.status = 'running'; work.result = ''; work.error = null; work.artifact = null; work.canSteer = false; work.backgroundWaiting = false;
        }
        work.updatedAt = at; reconcileTaskSnooze(work, Date.parse(at)); await this.engine.taskHistory.persist(tx, work); state.revision++;
      }, context);
      this.engine.harness.resume(); this.engine.taskSettlement.notify(); return;
    }
    const receipt = (await this.engine.snapshot()).nativeTurnRequests?.[key];
    if (!receipt || receipt.status !== 'running' || receipt.taskId !== id || receipt.threadId !== update.threadId || receipt.sessionId !== update.sessionId || (receipt.provider ?? 'claude') !== (update.provider ?? 'claude') || receipt.providerInstanceId !== update.providerInstanceId) return;
    if (update.kind === 'nativeTurnUpdate' && update.value.kind === 'commandOutput') {
      this.engine.commandOutputs.appendBackground(id, update.value.eventId, update.value.delta, receipt.runId, update.sessionId); return;
    }
    let accepted = false; let woke = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const saved = state.nativeTurnRequests?.[key]; const work = state.tasks.find(work => work.id === id);
      const run = work?.runs?.find(run => run.id === receipt.runId && !run.revertedAt && !run.executionExcludedAt);
      if (!saved || saved.status !== 'running' || !work || !run || work.executionSessionId !== update.sessionId || work.threadId !== update.threadId) return;
      if (update.kind === 'nativeTurnFinish') {
        saved.status = update.status; saved.result = update.result; if (update.error) saved.error = update.error; saved.completedAt = stamp();
        run.status = update.status; run.completedAt = saved.completedAt;
      } else {
        const value = update.value;
        if (value.kind === 'contextUsage') { run.contextUsage = value.usage; if (work.currentRunId === run.id) work.contextUsage = value.usage; }
        if (value.kind === 'nativeHead') { work.nativeHead = value.head; run.nativeHead = value.head; if (value.turnIds) run.nativeTurnIds = value.turnIds; }
        if (value.kind === 'output') { saved.result = value.text; if (work.currentRunId === run.id) work.result = value.text; }
        if (value.kind === 'ready' && work.currentRunId === run.id) work.canSteer = value.canSteer;
        if (value.kind === 'backgroundWaiting' && work.currentRunId === run.id) { work.backgroundWaiting = value.waiting; if (!work.approvals.some(approval => approval.state === 'pending')) work.status = value.waiting ? 'waiting' : 'running'; }
        if (value.kind === 'event') work.events.push({ id: 'native-event:' + randomUUID(), kind: value.eventKind, text: value.text, at: stamp(), runId: run.id });
        if (value.kind === 'item') {
          const index = work.events.findIndex(event => event.id === value.item.id);
          const original = work.events[index]; const event = { ...projectSubagentEvent(value.item, work.subagents), runId: run.id, ...(original ? { at: original.at, historyOrder: original.historyOrder } : {}) };
          if (index < 0) work.events.push(event); else work.events[index] = event;
        }
        if (value.kind === 'approval') { if (!work.approvals.some(approval => approval.id === value.approval.id)) work.approvals.push(value.approval); saved.approvalIds ??= []; if (!saved.approvalIds.includes(value.approval.id)) saved.approvalIds.push(value.approval.id); if (work.currentRunId === run.id) work.status = 'waiting'; }
        if (value.kind === 'approvalResolved') { const approval = work.approvals.find(approval => approval.id === value.id); if (approval) approval.state = 'answered'; if (work.currentRunId === run.id && !work.approvals.some(approval => approval.state === 'pending')) work.status = work.backgroundWaiting ? 'waiting' : 'running'; }
      }
      work.updatedAt = stamp(); woke = reconcileTaskSnooze(work, Date.parse(work.updatedAt)); await this.engine.taskHistory.persist(tx, work, update.kind === 'nativeTurnUpdate' && update.value.kind === 'item' ? [update.value.item.id] : []);
      state.revision++; accepted = true;
    }, context);
    if (accepted && update.kind === 'nativeTurnUpdate' && update.value.kind === 'item') this.engine.commandOutputs.trackBackground(id, update.value.item, receipt.runId, update.sessionId);
    if (woke) this.engine.taskSettlement.notify();
  }

  private async interrupt(input: Input) {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.nativeTurnRequests?.[input.receiptKey];
      if (!receipt || receipt.status !== 'running') return;
      receipt.status = 'interrupted'; receipt.error = '原生连接已中断，请检查已保留的回复后继续'; receipt.completedAt = stamp(); state.revision++;
    }, context);
  }
  private async finish(receipt: NativeTurnReceipt) {
    const work = (await this.engine.snapshot()).tasks.find(task => task.id === receipt.taskId);
    if (!work || receipt.status === 'running') return;
    await this.engine.taskRuns.finish(work.id, receipt.runId, receipt.status, 'completed');
    const artifact = work.id + '-native-' + nativeTurnReceiptKey(work.id, receipt.sessionId, receipt.key) + '.md';
    if (receipt.status === 'completed' && receipt.result) await writeFile(join(this.engine.directory, 'artifacts', artifact), `# ${work.title}\n\n${receipt.result}\n`, { mode: 0o600 });
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const current = state.tasks.find(task => task.id === receipt.taskId); if (!current) return;
      const messageId = 'assistant:' + receipt.runId;
      if (receipt.status === 'completed' && receipt.result && !current.messages?.some(message => message.id === messageId)) {
        current.messages ??= []; current.messages.push({ id: messageId, role: 'assistant', text: receipt.result, at: receipt.completedAt ?? stamp(), runId: receipt.runId, turnId: receipt.turnId });
      }
      if (current.currentRunId === receipt.runId) {
        current.status = receipt.status; current.result = receipt.result; current.error = receipt.error ?? null; current.canSteer = false; current.backgroundWaiting = false;
        if (receipt.status === 'completed' && receipt.result) { current.artifact = artifact; current.unread = true; }
      }
      current.approvals.forEach(approval => { if (receipt.approvalIds?.includes(approval.id) && approval.state === 'pending') approval.state = 'expired'; });
      reconcileTaskSnooze(current, Date.now());
      await this.engine.taskHistory.persist(tx, current); state.revision++;
    }, context);
    this.engine.taskSettlement.notify();
  }
}
