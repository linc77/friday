import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeFork, headForkSourceBusy, activeGitOperation, activeRewind, activeStatuses, type NativeRewindResult, type TaskRewindOperation, type WorkItem, type Workspace } from './types.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';
import { branchBlocksTask, switchingBranch } from './branch-switch.js';
import { assertIsolatedRestore, rewindFingerprint, rewindTarget } from './task-rewind-safety.js';
import { readRestoreReview } from './managed-worktree.js';
import { executionRuns } from './task-run-order.js';
import { nativeSessionActionBusy, providerEpoch } from './task-session-actions.js';

const stamp = () => new Date().toISOString();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const requestID = (id: string) => { if (!id || id.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('回退请求 ID 无效'); };
type Input = { id: string; operationId: string; attempt: number };

export class TaskRewinds {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'execute' }, { status: string }, {}>({
      name: 'friday.rewind', version: 1, initial: () => ({ phase: 'execute' }),
      phases: {
        execute: async (task, runtime, ctx) => {
          const finish = async (status: TaskRewindOperation['status'], error?: string) => {
            await this.patch(task.input, { status, ...(error ? { error } : { error: undefined }), ...(status === 'completed' ? { phase: 'completed' } : {}) });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
          };
          let state = await engine.snapshot(); let work = state.tasks.find(work => work.id === task.input.id);
          let operation = work?.rewindOperation;
          if (!work || !operation || operation.id !== task.input.operationId || operation.attempt !== task.input.attempt) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'superseded' } } }), ctx); return;
          }
          if (operation.status === 'completed' || operation.status === 'failed') { await finish(operation.status, operation.error); return; }
          try {
            this.assertIdle(state, work, true);
            if (!operation.projectedAt && rewindFingerprint(work, operation.fingerprintVersion ?? 1) !== operation.fingerprint) throw new Error('任务历史已经改变，请重新选择回退位置');
            if (operation.restoreFiles && operation.resolution !== 'keep_files') {
              await assertIsolatedRestore(state, work, engine.directory, operation.checkpoint);
              if (!operation.backup && !(await readRestoreReview(work, engine.directory)).missing) {
                const backup = await engine.taskRuns.checkpoints.capture(work, 'rewind-' + operation.id, 'before', runtime.signal);
                if (backup.status !== 'ready') throw new Error('无法保存恢复前的源文件备份：' + (backup.status === 'unavailable' ? backup.error : '仓库不可用'));
                await this.patch(task.input, { backup }); operation = { ...operation, backup };
              }
            }
            await this.patch(task.input, { status: 'running' });
            let native = operation.nativeResult;
            if (operation.resolution === 'new_session') native = { state: 'applied', threadId: null };
            if (!native) {
              if (work.agent === 'claude') {
                const removed = new Set(operation.removedExecutionRunIds ?? operation.removedRunIds);
                const previous = executionRuns(work).filter(run => !removed.has(run.id)).at(-1);
                if (previous && (!previous.threadId || !previous.nativeHead)) throw new Error('保留的 Claude 轮次没有 SDK 消息游标，无法安全续接；可以从保留历史建立新会话');
                native = { state: 'applied', threadId: previous?.threadId ?? null, ...(previous?.nativeHead ? { resumeSessionAt: previous.nativeHead } : {}) };
              } else if (!operation.sourceThreadId) native = { state: 'applied', threadId: null, turns: [] };
              else {
                if (!engine.executor.rewind) throw new Error('这个执行器尚未支持原生会话回退');
                const inspecting = !!await runtime.memo<boolean>('native-started', ctx) || operation.resolution === 'inspect';
                native = await engine.executor.rewind({
                  task: { ...work, threadId: operation.nativeCandidate ?? operation.sourceThreadId }, targetTurnId: operation.targetTurnId, removeTurns: operation.removeTurns, keepTurns: operation.keepTurns,
                  ...(operation.nativeStart ? { original: operation.nativeStart } : {}), inspectOnly: inspecting, signal: runtime.signal,
                  started: async original => { await this.patch(task.input, { nativeStart: original }); await runtime.memo('native-started', true, ctx); },
                  candidate: async threadId => { await this.patch(task.input, { nativeCandidate: threadId }); },
                });
                if (native.state === 'unchanged') { await finish('failed', '已核对原生历史：回退未生效，文件和任务记录均未回退。可以重新发起明确的回退请求。'); return; }
              }
              await this.patch(task.input, { nativeResult: native }); await runtime.memo('native-result', native, ctx);
            }
            operation = { ...operation, nativeResult: native };
            await this.project(task.input, operation, native);
            await this.patch(task.input, { phase: operation.restoreFiles ? 'files' : 'completed' });
            if (operation.restoreFiles && operation.resolution !== 'keep_files') {
              state = await engine.snapshot(); work = state.tasks.find(work => work.id === task.input.id)!;
              await assertIsolatedRestore(state, work, engine.directory, operation.checkpoint);
              if (operation.filesStartedAt && !operation.filesCompletedAt) {
                await finish('needs_review', '文件恢复曾中断；请查看当前文件，再明确选择重新恢复或保留当前文件。'); return;
              }
              if (!operation.filesCompletedAt) {
                const review = await readRestoreReview(work, engine.directory);
                if (review.fingerprint !== operation.fileFingerprint) throw new Error('工作区文件或 HEAD 已改变；会话已经回退，请检查当前改动后选择重新恢复或保留文件。');
                await this.patch(task.input, { filesStartedAt: stamp() }); await runtime.memo('files-started', true, ctx);
                await engine.taskRuns.checkpoints.restore(work, operation.checkpoint!, runtime.signal);
                await this.patch(task.input, { filesCompletedAt: stamp() }); await runtime.memo('files-completed', true, ctx);
              }
            }
            await finish('completed');
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            const current = (await engine.snapshot()).tasks.find(work => work.id === task.input.id)?.rewindOperation;
            await finish(current?.nativeResult || current?.projectedAt ? 'needs_review' : current?.nativeStart ? 'interrupted' : 'failed', error instanceof Error ? error.message : '回退失败');
          }
        },
      },
      abort: async (task, runtime, ctx) => {
        const operation = (await engine.snapshot()).tasks.find(work => work.id === task.input.id)?.rewindOperation;
        await this.patch(task.input, { status: operation?.projectedAt ? 'needs_review' : 'interrupted', error: '回退已中断；请核对已保存的原生回执和文件状态后继续。' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }

  private assertIdle(state: Workspace, work: WorkItem, own = false) {
    if (work.delegationOrigin) throw new Error('委派子任务不接收历史编辑；下一轮请重新委派');
    if (nativeSessionActionBusy(work)) throw new Error('请先完成或核对 Agent 会话操作');
    if (work.settleCleanup?.status === 'pending') throw new Error('正在清理结束跟进的会话，请等待完成后回退');
    if (hasRunningBackgroundCommands(work)) throw new Error('请先停止后台命令再回退会话');
    if (activeFork(work.forkOperation) || headForkSourceBusy(state.tasks, work.id)) throw new Error('请先处理这条会话的分叉结果再回退');
    if (activeStatuses.includes(work.status) || activeGitOperation(work.gitOperation) || switchingBranch(work.branchChange)
      || work.queue?.dispatcherId != null || work.queue?.messages.some(message => ['queued', 'dispatching', 'steering', 'running'].includes(message.status))) throw new Error('请先停止任务并处理排队消息，再回退会话');
    if (!own && activeRewind(work.rewindOperation)) throw new Error('这条会话还有待处理的回退操作');
    if (branchBlocksTask({ ...state, tasks: state.tasks.filter(task => !own || task.id !== work.id) }, work.cwd)) throw new Error('工作区有 Git、分支或回退操作正在进行');
  }

  async options(id: string, messageID: string) {
    const state = await this.engine.snapshot(); const work = state.tasks.find(work => work.id === id);
    if (!work || work.agent === 'friday') throw new Error('本地任务不存在');
    this.assertIdle(state, work);
    const { target, removed, executionKeep, executionRemoved } = rewindTarget(work, messageID);
    const checkpoint = executionRemoved[0]?.before;
    let restoreReason: string | undefined; let fileFingerprint: string | undefined;
    try {
      if (checkpoint?.status !== 'ready') throw new Error('这轮执行没有可用的起始文件检查点');
      await assertIsolatedRestore(state, work, this.engine.directory, checkpoint);
      fileFingerprint = (await readRestoreReview(work, this.engine.directory)).fingerprint;
    } catch (error) { restoreReason = error instanceof Error ? error.message : '不能恢复文件'; }
    const previous = executionKeep.at(-1);
    const crossesProvider = [...executionRemoved, ...(previous ? [previous] : [])].some(run => run.providerEpoch && run.providerEpoch !== providerEpoch(work));
    const nativeReason = crossesProvider ? '所选历史跨越 Agent 交接；可以从保留历史建立新会话'
      : work.agent === 'claude' && previous && (!previous.nativeHead || !previous.threadId) ? '保留的 Claude 轮次没有 SDK 消息游标，无法安全续接；可从保留历史建立新会话'
      : !['codex', 'claude', 'pi', 'opencode'].includes(work.agent) ? '此 Provider 没有可用的原生回退；可以从保留历史建立新会话'
      : work.agent === 'pi' && executionRemoved.some(run => run.turnId && !run.nativeTurnIds?.length) ? '所选 Pi 轮次没有捕获会话树游标；可以从保留历史建立新会话'
      : work.agent !== 'claude' && executionRemoved.some(run => run.threadId && run.threadId !== work.threadId) ? '所选历史跨越多个原生会话；可从保留历史建立新会话' : undefined;
    const logical = new Set(removed.map(run => run.id));
    return { fingerprint: rewindFingerprint(work), messageId: messageID, runId: target.id, removedTurns: removed.length,
      additionalExecutionCount: executionRemoved.filter(run => !logical.has(run.id)).length, canRestore: !restoreReason, restoreReason, fileFingerprint, nativeReason };
  }

  async start(id: string, input: { requestId: string; messageId: string; fingerprint: string; restoreFiles: boolean; fileFingerprint?: string; newSession?: boolean }) {
    requestID(input.requestId);
    const existing = (await this.engine.snapshot()).rewindRequests?.[input.requestId];
    if (existing) { if (existing.taskId !== id) throw new Error('回退请求 ID 已被其他任务使用'); return existing.operationId; }
    const options = await this.options(id, input.messageId);
    if (options.fingerprint !== input.fingerprint) throw new Error('任务历史已经改变，请重新选择回退位置');
    if (options.nativeReason && !input.newSession) throw new Error(options.nativeReason);
    if (input.restoreFiles && (!options.canRestore || input.fileFingerprint !== options.fileFingerprint)) throw new Error(options.restoreReason ?? '工作区文件已经改变，请重新检查');
    const operationID = randomUUID();
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.rewindRequests?.[input.requestId];
      if (receipt) { if (receipt.taskId !== id) throw new Error('回退请求 ID 已被其他任务使用'); return; }
      const work = state.tasks.find(work => work.id === id); if (!work) throw new Error('本地任务不存在');
      this.assertIdle(state, work);
      if (rewindFingerprint(work) !== input.fingerprint) throw new Error('任务历史已经改变，请重新选择回退位置');
      const { target, removed, message, executionRemoved, executionKeep } = rewindTarget(work, input.messageId);
      if (!input.newSession && [...executionRemoved, ...executionKeep.slice(-1)].some(run => run.providerEpoch && run.providerEpoch !== providerEpoch(work))) throw new Error('所选历史跨越 Agent 交接，请从保留历史建立新会话');
      const removeTurns = executionRemoved.filter(run => run.turnId && run.threadId === work.threadId).flatMap(run => run.nativeTurnIds ?? [run.turnId!]);
      const activeMessages = work.messages?.filter(message => !message.revertedAt) ?? [];
      const legacyTurns = activeMessages.slice(0, activeMessages.findIndex(value => value.id === message.id)).filter(value => !value.runId && value.turnId).map(value => value.turnId!);
      const removedNative = new Set(removeTurns);
      const keepTurns = [...new Set([...legacyTurns.filter(turn => !removedNative.has(turn)), ...executionKeep.filter(run => run.threadId === work.threadId && run.turnId).flatMap(run => run.nativeTurnIds ?? [run.turnId!])])];
      if (!input.newSession && work.agent !== 'claude' && executionRemoved.some(run => run.threadId && run.threadId !== work.threadId)) throw new Error('所选历史跨越多个原生会话，请从保留历史建立新会话');
      const durableId = await tx.createTask(this.definition, { id, operationId: operationID, attempt: 0 }, { ownership: { kind: 'conversation' } });
      const editorSelection = target.providerEpoch && target.providerEpoch !== providerEpoch(work) ? { interactionMode: work.interactionMode ?? 'default', model: work.model, reasoningEffort: work.reasoningEffort, modelOptions: work.modelOptions } : target;
      if (work.rewindOperation) { work.rewindOperations ??= []; work.rewindOperations.push(copy(work.rewindOperation)); }
      work.rewindOperation = { id: operationID, durableId, requestId: input.requestId, messageId: message.id, runId: target.id, removedRunIds: removed.map(run => run.id),
        removedExecutionRunIds: executionRemoved.map(run => run.id),
        status: 'queued', phase: 'native', restoreFiles: input.restoreFiles, cwd: work.cwd, fingerprint: input.fingerprint, fingerprintVersion: 3,
        createdAt: stamp(), updatedAt: stamp(), sourceThreadId: work.threadId, sourceTurnId: work.turnId, targetTurnId: removeTurns[0] ?? null, removeTurns, keepTurns,
        ...(executionRemoved[0]?.before ? { checkpoint: copy(executionRemoved[0].before) } : {}), ...(input.fileFingerprint ? { fileFingerprint: input.fileFingerprint } : {}), ...(input.newSession ? { resolution: 'new_session' } : {}), attempt: 0,
        editor: { text: message.text, images: copy(message.images ?? []), ...(message.contexts?.length ? { contexts: copy(message.contexts) } : {}), interactionMode: editorSelection.interactionMode, modelOptions: editorSelection.modelOptions ?? [], ...(editorSelection.model ? { model: editorSelection.model } : {}), ...(editorSelection.reasoningEffort ? { reasoningEffort: editorSelection.reasoningEffort } : {}) } };
      state.rewindRequests ??= {}; state.rewindRequests[input.requestId] = { taskId: id, operationId: operationID }; state.revision++;
    }, context);
    this.engine.harness.resume();
    return (await this.engine.snapshot()).rewindRequests![input.requestId].operationId;
  }

  async resolve(id: string, operationID: string, input: { requestId: string; action: NonNullable<TaskRewindOperation['resolution']>; fileFingerprint?: string }) {
    requestID(input.requestId);
    const existing = (await this.engine.snapshot()).rewindRequests?.[input.requestId];
    if (existing) { if (existing.taskId !== id || existing.operationId !== operationID) throw new Error('回退请求 ID 已被使用'); return; }
    if (!['retry_files', 'keep_files', 'inspect', 'new_session'].includes(input.action)) throw new Error('回退处理方式无效');
    const snapshot = await this.engine.snapshot(); const work = snapshot.tasks.find(task => task.id === id); const operation = work?.rewindOperation;
    const actionable = operation && (['needs_review', 'interrupted'].includes(operation.status) || operation.status === 'failed' && input.action === 'new_session');
    if (!work || operation?.id !== operationID || !actionable) throw new Error('这次回退不需要处理，或仍在执行');
    if (!operation.projectedAt && rewindFingerprint(work, operation.fingerprintVersion ?? 1) !== operation.fingerprint) throw new Error('任务历史已经改变，请重新选择回退位置');
    this.assertIdle(snapshot, work, true);
    if (['retry_files', 'keep_files'].includes(input.action) && !operation.projectedAt) throw new Error('原生回退结果尚未确认，请先核对或建立新会话');
    if (input.action === 'retry_files') {
      await assertIsolatedRestore(snapshot, work, this.engine.directory, operation.checkpoint);
      const review = await readRestoreReview(work, this.engine.directory);
      if (!input.fileFingerprint || review.fingerprint !== input.fileFingerprint) throw new Error('文件已经改变，请查看当前改动后重新确认');
    }
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const task = state.tasks.find(task => task.id === id); const current = task?.rewindOperation;
      if (state.rewindRequests?.[input.requestId]) return;
      if (!task || current?.id !== operationID || current.attempt !== operation.attempt || !(['needs_review', 'interrupted'].includes(current.status) || current.status === 'failed' && input.action === 'new_session')) throw new Error('回退状态已经改变，请刷新');
      this.assertIdle(state, task, true);
      current.attempt++; current.resolution = input.action; current.status = 'queued'; delete current.error;
      if (input.action === 'retry_files') { current.fileFingerprint = input.fileFingerprint; delete current.filesStartedAt; delete current.filesCompletedAt; }
      current.durableId = await tx.createTask(this.definition, { id, operationId: operationID, attempt: current.attempt }, { ownership: { kind: 'conversation' } });
      state.rewindRequests ??= {}; state.rewindRequests[input.requestId] = { taskId: id, operationId: operationID }; state.revision++;
    }, context);
    this.engine.harness.resume();
  }

  private async patch(input: Input, change: Partial<TaskRewindOperation>) {
    await this.engine.mutate(state => { const operation = state.tasks.find(task => task.id === input.id)?.rewindOperation;
      if (operation?.id === input.operationId && operation.attempt === input.attempt) Object.assign(operation, change, { updatedAt: stamp() }); });
  }

  async fileReview(id: string, operationID: string) {
    const work = (await this.engine.snapshot()).tasks.find(task => task.id === id);
    if (!work || work.rewindOperation?.id !== operationID) throw new Error('回退操作不存在');
    return readRestoreReview(work, this.engine.directory);
  }

  private async project(input: Input, operation: TaskRewindOperation, native: NativeRewindResult) {
    const work = (await this.engine.snapshot()).tasks.find(work => work.id === input.id)!;
    const removed = new Set(operation.removedRunIds);
    const removedExecutions = new Set(operation.removedExecutionRunIds ?? operation.removedRunIds);
    const activeMessages = work.messages?.filter(message => !message.revertedAt) ?? [];
    const targetIndex = activeMessages.findIndex(message => message.id === operation.messageId);
    const keptMessages = operation.projectedAt ? activeMessages : activeMessages.slice(0, targetIndex);
    const result = keptMessages.findLast(message => message.role === 'assistant')?.text ?? '';
    if (result) await writeFile(join(this.engine.directory, 'artifacts', work.id + '.md'), `# ${work.title}\n\n${result}\n`, { mode: 0o600 });
    await this.engine.mutate(state => {
      const task = state.tasks.find(work => work.id === input.id); const current = task?.rewindOperation;
      if (!task || current?.id !== input.operationId || current.attempt !== input.attempt) throw new Error('回退状态已经改变');
      if (!current.projectedAt) {
        if (rewindFingerprint(task, operation.fingerprintVersion ?? 1) !== operation.fingerprint) throw new Error('任务历史已经改变，不能覆盖当前记录');
        const at = stamp(); const removedMessages = new Set(activeMessages.slice(targetIndex).map(message => message.id));
        for (const run of task.runs ?? []) if (removed.has(run.id) && !run.revertedAt) run.revertedAt = at;
        for (const run of task.runs ?? []) if (removedExecutions.has(run.id) && !removed.has(run.id)) run.executionExcludedAt = at;
        for (const message of task.messages ?? []) if (!message.revertedAt) {
          if (removedMessages.has(message.id)) message.revertedAt = at;
          else if (message.runId && removedExecutions.has(message.runId)) { delete message.turnId; this.engine.taskHistory.messageChanged(task, message.id); }
        }
        const removedDurable = new Set((task.runs ?? []).filter(run => removed.has(run.id) || removedExecutions.has(run.id)).flatMap(run => run.durableId == null ? [] : [run.durableId]));
        for (const message of task.queue?.messages ?? []) if (removedMessages.has(message.id) || removedMessages.has(message.dispatchId) || message.runId != null && removedDurable.has(message.runId)) {
          message.status = 'cancelled'; message.error = '所属轮次已回退；此前发送回执保留在历史记录中。';
        }
        if (task.queue && !task.queue.messages.some(message => ['queued', 'dispatching', 'steering', 'running', 'uncertain', 'failed'].includes(message.status))) task.queue.error = null;
        const removedTurns = new Set([...operation.removeTurns, ...(task.runs ?? []).filter(run => (removed.has(run.id) || removedExecutions.has(run.id)) && run.turnId).map(run => run.turnId!)]);
        const targetTime = Date.parse(activeMessages[targetIndex]?.at ?? task.runs?.find(run => run.id === operation.runId)?.at ?? '');
        for (const event of task.events) if (!event.revertedAt && (event.runId && (removed.has(event.runId) || event.kind !== 'user' && removedExecutions.has(event.runId)) || event.turnId && removedTurns.has(event.turnId)
          || !event.runId && !event.turnId && Number.isFinite(targetTime) && Date.parse(event.at) >= targetTime)) event.revertedAt = at;
        if (native.turnIds) {
          const mapped = (id?: string) => id && Object.hasOwn(native.turnIds!, id) ? native.turnIds![id] : id;
          for (const run of task.runs ?? []) if (!run.revertedAt && !run.executionExcludedAt && run.threadId === operation.sourceThreadId) {
            run.turnId = mapped(run.turnId);
            if (run.nativeTurnIds) run.nativeTurnIds = run.nativeTurnIds.map(id => mapped(id)!);
            if (run.nativeHead && native.headIds && Object.hasOwn(native.headIds, run.nativeHead)) run.nativeHead = native.headIds[run.nativeHead];
          }
          for (const message of task.messages ?? []) if (!message.revertedAt && message.turnId) { message.turnId = mapped(message.turnId); this.engine.taskHistory.messageChanged(task, message.id); }
          for (const event of task.events) if (!event.revertedAt) { if (event.turnId) event.turnId = mapped(event.turnId); if (event.nativeTurnId) event.nativeTurnId = mapped(event.nativeTurnId); }
        }
        current.projectedAt = at;
      }
      const previous = executionRuns(task).at(-1);
      task.currentRunId = previous?.id; task.durableId = previous?.durableId ?? null; task.turnId = previous?.turnId ?? null;
      const needsContext = task.agent === 'codex' && native.turns?.length === 0 && keptMessages.length > 0;
      task.threadId = needsContext ? null : native.threadId; task.nativeHead = previous?.nativeHead; task.claudeResumeSessionAt = native.resumeSessionAt; delete task.claudeResumePendingRun;
      if (!task.threadId) { delete task.nativeHead; task.providerEpoch = randomUUID(); }
      if (!task.threadId || task.threadId !== operation.sourceThreadId) task.goal = null;
      task.contextUsage = task.threadId ? previous?.contextUsage ?? null : null;
      if (native.threadId && native.threadId !== operation.sourceThreadId && ['codex', 'pi', 'opencode'].includes(task.agent)) for (const run of task.runs ?? []) if (!run.revertedAt && run.threadId === operation.sourceThreadId) run.threadId = native.threadId;
      task.status = 'completed'; task.error = null; task.result = result; task.artifact = result ? task.id + '.md' : null;
      task.canSteer = false; task.workspaceRequest = null; task.unread = false; task.readAt = stamp(); task.updatedAt = stamp();
      task.approvals.forEach(approval => { if (approval.state === 'pending') approval.state = 'expired'; });
      current.nativeResult = native;
    });
  }
}
