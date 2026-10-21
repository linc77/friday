import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { allTaskChangeRequestLinks } from './task-change-request-links.js';
import { activeFork, activeRewind, activeStatuses, type NativeForkResult, type TaskForkOperation, type TaskRun, type WorkItem } from './types.js';
import { clearExcludedExecution, executionPosition, executionRuns, forkMessageBoundary, hasExecution } from './task-run-order.js';
import { nativeForkPrefix } from './task-native-fork.js';
import { visibleSubagentIds } from './task-subagent-types.js';

const stamp = () => new Date().toISOString();
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const validID = (id: string) => { if (!id || id.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('分叉请求 ID 无效'); };
type Input = { id: string; operationId: string; attempt: number };
const forkable = (run: TaskRun) => !run.revertedAt && !run.executionExcludedAt && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status);

function prefix(source: WorkItem, runID: string, targetID: string) {
  if (source.agent === 'friday' || activeFork(source.forkOperation) || activeRewind(source.rewindOperation)) throw new Error('请先处理原任务的会话操作，再分叉历史');
  const runs = source.runs?.filter(run => !run.revertedAt) ?? []; const index = runs.findIndex(run => run.id === runID);
  const selected = runs[index];
  if (!selected || !forkable(selected)) throw new Error('只能从已结束且未回退的轮次分叉');
  if (source.agent === 'claude' && activeStatuses.includes(source.status)) throw new Error('请先结束当前 Claude 轮次再分叉');
  const messages = source.messages ?? [];
  const start = messages.findIndex(message => message.id === selected.messageId && message.role === 'user');
  const stop = forkMessageBoundary(source, selected);
  if (start < 0 || stop < start) throw new Error('所选轮次没有可核对的消息边界');
  const visible = messages.slice(0, stop).filter(message => !message.revertedAt);
  const visibleIDs = new Set(visible.map(message => message.id));
  const kept = runs.filter(run => visibleIDs.has(run.messageId)); const ids = new Map(kept.map((run, i) => [run.id, `fork-${targetID}-${i}`]));
  const ordered = executionRuns(source); const executionIndex = ordered.findIndex(run => run.id === selected.id);
  const executed = executionIndex >= 0 ? ordered.slice(0, executionIndex + 1) : ordered.filter(run => executionPosition(source, run) < stop);
  const executionIDs = new Set(executed.map(run => run.id));
  const keptTurns = new Set([...executed.flatMap(run => run.nativeTurnIds ?? (run.turnId ? [run.turnId] : [])),
    ...visible.filter(message => !message.runId && message.turnId && !runs.some(run => run.turnId === message.turnId && !executionIDs.has(run.id))).map(message => message.turnId!)]);
  const endedAt = Date.parse(selected.completedAt ?? messages[stop]?.at ?? ''); const endTime = Number.isFinite(endedAt) ? endedAt : Infinity;
  const events = source.events.filter(event => !event.revertedAt && (event.runId ? executionIDs.has(event.runId) || event.kind === 'user' && ids.has(event.runId) : event.turnId ? keptTurns.has(event.turnId) : Date.parse(event.at) < endTime));
  const result = visible.findLast(message => message.role === 'assistant' && (message.runId === selected.id || selected.turnId && message.turnId === selected.turnId))?.text
    ?? visible.slice(executionPosition(source, selected)).findLast(message => message.role === 'assistant' && !message.runId && !message.turnId)?.text
    ?? events.findLast(event => (event.runId === selected.id || event.turnId != null && event.turnId === selected.turnId) && event.kind === 'message' && event.phase !== 'commentary')?.text
    ?? (source.currentRunId === selected.id || source.currentRunId === undefined && source.status === 'completed' && selected.status === 'completed' && index === runs.length - 1 ? source.result : '');
  let expectedTurns = [...new Set([
    ...visible.filter(message => !message.runId && message.turnId && !runs.some(run => run.turnId === message.turnId && !executionIDs.has(run.id))).map(message => message.turnId!),
    ...executed.filter(run => run.threadId === selected.threadId && run.turnId).flatMap(run => run.nativeTurnIds ?? [run.turnId!]),
  ])];
  const inherited = source.forkOperation?.nativeResult;
  if (inherited && inherited.threadId === selected.threadId) {
    const base = (source.forkOperation!.nativePrefix ?? source.forkOperation!.expectedTurns).flatMap(id => inherited.turnIds[id] ? [inherited.turnIds[id]] : []);
    const selectedIndex = base.indexOf(selected.turnId ?? '');
    expectedTurns = [...new Set([...(selectedIndex < 0 ? base : base.slice(0, selectedIndex + 1)), ...expectedTurns])];
  }
  return {
    selected, expectedTurns, result,
    messages: copy(visible.filter(message => !message.runId || ids.has(message.runId))).map(message => ({ ...message, ...(message.runId ? { runId: ids.get(message.runId)! } : {}) })),
    events: copy(events).map(event => { delete event.historyDigest; return { ...event, ...(event.runId ? { runId: ids.get(event.runId)! } : {}) }; }),
    runs: copy(kept).map(run => {
      const originalID = run.id;
      run.executionMessagePosition = messages.slice(0, Math.min(stop, executionPosition(source, run))).filter(message => !message.revertedAt).length;
      if (!executionIDs.has(run.id) && hasExecution(run)) clearExcludedExecution(run, selected.completedAt ?? stamp());
      return { ...run, id: ids.get(run.id)!, durableId: null, inheritedFrom: { taskId: source.id, runId: originalID } };
    }),
    runID: ids.get(selected.id)!, prefixMode: inherited?.threadId === selected.threadId && source.forkOperation?.prefixMode === 'observed' ? 'observed' as const : undefined,
  };
}

/** A fork is a Durable history operation; it never starts a provider turn. */
export class TaskForks {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'fork' }, { status: string }, {}>({
      name: 'friday.fork', version: 1, initial: () => ({ phase: 'fork' }),
      phases: { fork: async (task, runtime, ctx) => {
        const finish = async (status: TaskForkOperation['status'], error?: string) => {
          await this.patch(task.input, { status, ...(error ? { error } : { error: undefined }) });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        let work = (await engine.snapshot()).tasks.find(work => work.id === task.input.id); const operation = work?.forkOperation;
        if (!work || !operation || operation.id !== task.input.operationId || operation.attempt !== task.input.attempt) {
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'superseded' } } }), ctx); return;
        }
        if (operation.status === 'completed') { await finish('completed'); return; }
        try {
          await this.patch(task.input, { status: 'running' });
          if (operation.strategy === 'visible_history') { await this.apply(task.input); await finish('completed'); return; }
          let result = operation.nativeResult;
          if (!result) {
            if (!engine.executor.fork) throw new Error('这个执行器尚未支持原生分叉；可以明确选择从可见历史建立新会话');
            const selected = work.runs?.find(run => run.id === work.currentRunId);
            if ((!selected && operation.prefixMode !== 'observed') || !operation.sourceThreadId) throw new Error('所选轮次缺少原生会话边界；可以从可见历史建立新会话');
            result = await engine.executor.fork({
              task: { ...work, id: operation.sourceTaskId, threadId: operation.sourceThreadId, turnId: operation.sourceTurnId ?? null },
              run: { ...selected, status: operation.sourceStatus ?? selected?.status, threadId: operation.sourceThreadId, turnId: operation.sourceTurnId, nativeHead: operation.sourceHead },
              title: work.title, expectedTurns: operation.expectedTurns, candidateId: operation.candidateId, inspectOnly: !!operation.startedAt, signal: runtime.signal,
              prefixMode: operation.prefixMode, nativePrefix: operation.nativePrefix,
              verifiedPrefix: async nativePrefix => { await this.patch(task.input, { nativePrefix }); },
              started: async () => { await this.patch(task.input, { startedAt: stamp() }); await runtime.memo('native-started', true, ctx); },
              candidate: async candidateId => { await this.patch(task.input, { candidateId }); },
            });
            if (!result.threadId || result.threadId === operation.sourceThreadId) throw new Error('分叉结果没有独立的原生会话 ID');
            await this.patch(task.input, { nativeResult: result }); await runtime.memo('native-result', result, ctx);
          }
          await this.apply(task.input, result); await finish('completed');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const current = (await engine.snapshot()).tasks.find(work => work.id === task.input.id)?.forkOperation;
          await finish(current?.startedAt ? 'interrupted' : 'failed', error instanceof Error ? error.message : '分叉失败');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.patch(task.input, { status: 'interrupted', error: '分叉已中断；请核对已保存的会话回执。不会重复创建未知的原生会话。' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }

  async start(sourceID: string, input: { requestId: string; runId: string; title?: string }) {
    validID(input.requestId);
    if (input.title !== undefined && (!input.title.trim() || input.title.trim().length > 200 || /[\x00-\x1f]/.test(input.title))) throw new Error('分叉名称无效');
    const intent = createHash('sha256').update(JSON.stringify([sourceID, input.runId, input.title ?? null])).digest('hex');
    const targetID = randomUUID(); const operationID = randomUUID();
    const id = await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.forkRequests?.[input.requestId];
      if (receipt) {
        if (receipt.sourceTaskId !== sourceID || receipt.sourceRunId !== input.runId || receipt.action || receipt.intent !== intent) throw new Error('请求 ID 已被其他分叉操作使用');
        return receipt.taskId;
      }
      if (Object.hasOwn(state.requests, input.requestId)) throw new Error('请求 ID 已被其他操作使用');
      let source = state.tasks.find(task => task.id === sourceID);
      if (!source || source.agent === 'friday') throw new Error('原任务不存在');
      if (source.subagentOrigin) {
        const origin = source.subagentOrigin, root = state.tasks.find(task => task.id === origin.rootTaskId);
        const agent = root?.subagents?.find(agent => agent.id === origin.subagentId && agent.nativeId === origin.nativeId && agent.childTaskId === sourceID);
        if (source.agent !== 'codex' || agent?.provider !== 'codex' || agent.threadId !== origin.threadId || source.threadId !== origin.nativeId || !visibleSubagentIds(state.tasks).has(sourceID)) throw new Error('此原生子 Agent 尚不支持分叉或已不在可见历史中');
        source = { ...source, codexHome: source.codexHome ?? root?.codexHome, executionWorkspace: source.executionWorkspace ?? root?.executionWorkspace };
      }
      if (source.backgroundStop?.status === 'pending' || source.settleCleanup?.status === 'pending') throw new Error('正在停止后台工作，请等待完成后分叉');
      const complete = { ...copy(source), events: await this.engine.taskHistory.events(source, tx) };
      if (activeFork(source.forkOperation) || activeRewind(source.rewindOperation)) throw new Error('请先处理原任务的会话操作，再分叉历史');
      const history = !source.runs?.some(run => run.id === input.runId) ? nativeForkPrefix(complete, input.runId) : prefix(complete, input.runId, targetID);
      const at = stamp(); const selected = history.selected;
      const result = history.result;
      const durableId = await tx.createTask(this.definition, { id: targetID, operationId: operationID, attempt: 0 }, { ownership: { kind: 'conversation' } });
      const task: WorkItem = {
        id: targetID, title: input.title?.trim() ?? `${source.title.slice(0, 195)} fork`, prompt: source.prompt, projectId: source.projectId, cwd: source.cwd,
        agent: source.agent, mode: source.mode, status: 'completed', createdAt: at, updatedAt: at,
        durableId: null, threadId: null, turnId: null, result, error: null, events: history.events, approvals: [], artifact: null, lastRequestId: input.requestId,
        messages: history.messages, runs: history.runs, currentRunId: history.runID, canSteer: false, unread: false, readAt: at,
        interactionMode: source.interactionMode ?? 'default', model: source.model, reasoningEffort: source.reasoningEffort,
        eventArchive: { count: 0, version: 0, coverage: source.eventArchive?.coverage ?? 'legacy', recent: [] },
        ...(source.executionWorkspace ? { executionWorkspace: copy(source.executionWorkspace) } : {}),
        ...(source.codexHome ? { codexHome: source.codexHome } : {}), ...(source.claudeHome ? { claudeHome: source.claudeHome } : {}),
        ...(source.autoSettle !== undefined ? { autoSettle: source.autoSettle } : {}),
        changeRequests: copy(allTaskChangeRequestLinks(source).map(({ watch, ...link }) => link)), changeRequestLinksRevision: 0,
        ...(source.changeRequestStacks ? { changeRequestStacks: copy(source.changeRequestStacks) } : {}),
        ...(source.branchPullRequest !== undefined ? { branchPullRequest: copy(source.branchPullRequest) } : {}),
        forkOrigin: { taskId: source.id, runId: selected.id, title: source.title, rootTaskId: source.forkOrigin?.rootTaskId ?? source.subagentOrigin?.rootTaskId ?? source.id },
        forkOperation: { id: operationID, durableId, requestId: input.requestId, sourceTaskId: source.id, sourceRunId: selected.id,
          sourceThreadId: selected.threadId ?? null, sourceTurnId: selected.turnId, sourceHead: 'nativeHead' in selected ? selected.nativeHead : undefined, expectedTurns: history.expectedTurns, prefixMode: history.prefixMode, sourceStatus: selected.status,
          status: 'queued', createdAt: at, updatedAt: at, attempt: 0, strategy: 'native' },
      };
      await this.engine.taskHistory.persist(tx, task);
      state.tasks.push(copy(task)); state.requests[input.requestId] = targetID; state.forkRequests ??= {};
      state.forkRequests[input.requestId] = { taskId: targetID, sourceTaskId: sourceID, sourceRunId: input.runId, operationId: operationID, intent }; state.revision++;
      return targetID;
    }, context);
    this.engine.harness.resume(); return id;
  }

  async resolve(id: string, input: { requestId: string; action: 'inspect' | 'retry' | 'new_session' }) {
    validID(input.requestId);
    if (!['inspect', 'retry', 'new_session'].includes(input.action)) throw new Error('分叉处理方式无效');
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const receipt = state.forkRequests?.[input.requestId];
      if (receipt) { if (receipt.taskId !== id || receipt.action !== input.action) throw new Error('请求 ID 已被使用'); return; }
      if (Object.hasOwn(state.requests, input.requestId)) throw new Error('请求 ID 已被其他操作使用');
      const work = state.tasks.find(task => task.id === id); const current = work?.forkOperation;
      if (!work || !current || !['failed', 'interrupted'].includes(current.status)) throw new Error('分叉仍在进行或已经完成');
      if (input.action === 'retry' && current.startedAt) throw new Error('原生分叉已经发起，不能重复创建；请核对回执或从可见历史建立新会话');
      if (input.action === 'inspect' && !current.candidateId) throw new Error('没有收到原生会话 ID，无法只读核对；可以从可见历史建立新会话');
      current.attempt++; current.status = 'queued'; delete current.error;
      if (input.action === 'new_session') current.strategy = 'visible_history';
      current.durableId = await tx.createTask(this.definition, { id, operationId: current.id, attempt: current.attempt }, { ownership: { kind: 'conversation' } });
      state.forkRequests ??= {}; state.forkRequests[input.requestId] = { taskId: id, sourceTaskId: current.sourceTaskId, sourceRunId: current.sourceRunId, operationId: current.id, action: input.action };
      state.requests[input.requestId] = id; state.revision++;
    }, context);
    this.engine.harness.resume();
  }

  private async patch(input: Input, change: Partial<TaskForkOperation>) {
    await this.engine.mutate(state => { const work = state.tasks.find(work => work.id === input.id); const operation = work?.forkOperation;
      if (operation?.id === input.operationId && operation.attempt === input.attempt) { Object.assign(operation, change, { updatedAt: stamp() }); work!.updatedAt = stamp(); }
    });
  }
  private async apply(input: Input, result?: NativeForkResult) {
    const work = (await this.engine.snapshot()).tasks.find(work => work.id === input.id);
    if (!work) throw new Error('分叉任务不存在');
    if (work.result) await writeFile(join(this.engine.directory, 'artifacts', work.id + '.md'), `# ${work.title}\n\n${work.result}\n`, { mode: 0o600 });
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const task = state.tasks.find(work => work.id === input.id); const operation = task?.forkOperation;
      if (!task || !operation || operation.id !== input.operationId || operation.attempt !== input.attempt) throw new Error('分叉状态已经改变');
      const strategy = result ? 'native' : 'visible_history';
      if (operation.projectedAt && operation.projectedStrategy === strategy) return;
      task.events = await this.engine.taskHistory.events(task, tx);
      const mapped = (ids: Record<string, string>, id?: string) => id && Object.hasOwn(ids, id) ? ids[id] : undefined;
      if (result && operation.sourceTurnId && !mapped(result.turnIds, operation.sourceTurnId)) throw new Error('分叉结果缺少所选轮次的原生边界');
      if (result && task.agent === 'claude' && operation.sourceHead && !mapped(result.headIds, operation.sourceHead)) throw new Error('分叉结果缺少所选 Claude 消息游标');
      for (const run of task.runs ?? []) {
        // Old native sessions are provenance, never executable ownership of the
        // child. A rollback must not attach a fork back to its source session.
        if (result && run.threadId === operation.sourceThreadId && mapped(result.turnIds, run.turnId)) {
          run.threadId = result.threadId; run.turnId = mapped(result.turnIds, run.turnId); run.nativeHead = mapped(result.headIds, run.nativeHead);
          if (run.nativeTurnIds) run.nativeTurnIds = run.nativeTurnIds.flatMap(id => mapped(result.turnIds, id) ? [mapped(result.turnIds, id)!] : []);
        } else { delete run.threadId; delete run.turnId; delete run.nativeHead; delete run.nativeTurnIds; }
      }
      if (result) {
        for (const message of task.messages ?? []) message.turnId = mapped(result.turnIds, message.turnId);
        for (const event of task.events) event.turnId = mapped(result.turnIds, event.turnId);
        for (const event of task.events) if (event.nativeTurnId) event.nativeTurnId = mapped(result.turnIds, event.nativeTurnId);
        task.threadId = result.threadId; task.turnId = mapped(result.turnIds, operation.sourceTurnId) ?? null;
        task.nativeHead = mapped(result.headIds, operation.sourceHead);
        if (result.codexHome) task.codexHome = result.codexHome;
        if (result.claudeHome) task.claudeHome = result.claudeHome;
      } else {
        for (const message of task.messages ?? []) delete message.turnId;
        for (const event of task.events) delete event.turnId;
        task.threadId = null; task.turnId = null; delete task.nativeHead;
      }
      task.durableId = null; task.artifact = task.result ? task.id + '.md' : null; task.updatedAt = stamp();
      operation.projectedAt = stamp(); operation.projectedStrategy = strategy;
      await this.engine.taskHistory.persist(tx, task, task.events.map(event => event.id)); state.revision++;
    }, context);
  }
}
