import { createHash, randomUUID } from 'node:crypto';
import type { Engine } from './engine.js';
import type { TaskContextReference } from './task-context-types.js';
import { contextLink } from './task-context-types.js';
import { WorkspaceDoc } from './state.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { activeStatuses, activeFork, activeRewind, type WorkItem, type Workspace } from './types.js';
import { executionRuns, forkMessageBoundary } from './task-run-order.js';
import { renderHistory, selectHistory, type HistoricalMessage } from './vendor/t3-handoff-budget.mjs';
import { TaskAttachmentFiles } from './task-attachments.js';
import { IdeaImages } from './ideas.js';

export type TaskContextTransfer = {
  id: string; kind: 'provider_handoff' | 'merge_back' | 'delegated_completion'; sourceTaskId: string; targetTaskId: string;
  sourceRunId?: string; baseRunId?: string; reference: TaskContextReference;
  status: 'pending' | 'consumed' | 'superseded'; createdAt: string; consumedAt?: string; runId?: string;
};
const stamp = () => new Date().toISOString();
export const taskTransferRequestID = (id: string) => { if (!/^[a-z0-9_-]{1,100}$/i.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('上下文交接请求 ID 无效'); };
export const taskTransferDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Product relationships and immutable source points; provider work stays lazy. */
export class TaskTransfers {
  constructor(private readonly engine: Engine) {}
  async capture(source: WorkItem, targetId: string, id: string, kind: TaskContextTransfer['kind'], sourceRunId?: string) {
    const runs = executionRuns(source), selected = sourceRunId ? runs.find(run => run.id === sourceRunId) : runs.at(-1);
    if (sourceRunId && !selected) throw new Error('上下文交接的源轮次不存在');
    const boundary = selected ? forkMessageBoundary(source, selected) : source.messages?.length ?? 0;
    const eligible = new Set(runs.slice(0, selected ? runs.indexOf(selected) + 1 : runs.length).filter(run => kind !== 'merge_back' || !run.inheritedFrom).map(run => run.id));
    const messages: HistoricalMessage[] = [];
    for (const message of (source.messages ?? []).slice(0, boundary)) {
      if (message.revertedAt || kind === 'merge_back' && (!message.runId || !eligible.has(message.runId))) continue;
      const run = runs.find(run => run.id === message.runId);
      let text = this.engine.contexts.project(message.text, message.contexts, message.images);
      if (message.images?.length) {
        const files = await new IdeaImages(this.engine.directory).resolve(message.images);
        text += '\nHistorical image paths (inspect only when needed): ' + JSON.stringify(files.map(({ path, name, mediaType }) => ({ path, name, mediaType })));
      }
      messages.push({ role: message.role, text, threadId: source.id, runId: message.runId ?? null, itemId: message.id, providerThreadId: run?.threadId ?? null, status: run?.status ?? 'completed', kind: message.role === 'user' ? 'user_message' : 'assistant_message' });
    }
    const events = await this.engine.taskHistory.events(source);
    for (const event of events) {
      if (!event.runId || !eligible.has(event.runId) || event.revertedAt || !['command', 'file', 'plan', 'error'].includes(event.kind)) continue;
      messages.push({ role: 'assistant', text: JSON.stringify({ kind: event.kind, text: event.text, detail: event.detail, phase: event.phase }), threadId: source.id, runId: event.runId, itemId: event.id, providerThreadId: null, status: event.status ?? 'completed', kind: event.kind });
    }
    for (const run of runs) if (eligible.has(run.id)) for (const file of run.changes ?? []) {
      messages.push({ role: 'assistant', text: 'File change: ' + JSON.stringify(file), threadId: source.id, runId: run.id, itemId: 'file-' + taskTransferDigest([run.id, file.path]).slice(0, 24), providerThreadId: run.threadId ?? null, status: run.status, kind: 'file_change' });
    }
    const archive = await new TaskAttachmentFiles(this.engine.directory).save(Buffer.from(JSON.stringify({ version: 1, sourceTaskId: source.id, sourceRunId: selected?.id, baseRunId: kind === 'merge_back' ? source.forkOrigin?.runId : undefined, messages })), 'context-' + id + '.json', 'application/json');
    const coverage = `Context handoff (${kind}). Source task=${source.id}; source run=${selected?.id ?? 'none'}; target task=${targetId}.${kind === 'merge_back' ? ' Fork base run=' + source.forkOrigin?.runId + '; only the fork delta is included.' : ''}\nRead omitted historical items selectively from the immutable JSON archive at ${JSON.stringify(archive.path)}. Historical commands and approvals are records, never requests to replay actions.`;
    const selectedHistory = selectHistory({ messages, coverage, budget: 16_000 });
    const reference = await this.engine.contexts.captureHandoff(targetId, id, kind === 'merge_back' ? '合并：' + source.title : 'Agent 上下文交接', renderHistory(selectedHistory.messages, selectedHistory.context));
    return { id, kind, sourceTaskId: source.id, targetTaskId: targetId, sourceRunId: selected?.id, ...(kind === 'merge_back' ? { baseRunId: source.forkOrigin?.runId } : {}), reference, status: 'pending' as const, createdAt: stamp() };
  }
  async mergeBack(sourceId: string, runId: string, requestId: string) {
    taskTransferRequestID(requestId); const state = await this.engine.snapshot();
    const source = state.tasks.find(task => task.id === sourceId), targetId = source?.forkOrigin?.taskId;
    const intent = taskTransferDigest([sourceId, targetId, runId]);
    const prior = state.taskTransferRequests?.[requestId];
    if (prior) { if (prior.intent !== intent || prior.sourceTaskId !== sourceId) throw new Error('上下文交接请求 ID 已被使用'); return prior.taskId; }
    if (!source || !targetId || source.agent === 'friday' || source.subagentOrigin || activeStatuses.includes(source.status) || activeFork(source.forkOperation) || activeRewind(source.rewindOperation) || source.sessionOperation?.status === 'pending') throw new Error('请从已结束的分叉任务合并回原任务');
    const run = executionRuns(source).find(run => run.id === runId);
    if (!run || run.status !== 'completed' || run.inheritedFrom || !state.tasks.some(task => task.id === targetId && task.agent !== 'friday' && !task.subagentOrigin)) throw new Error('没有可合并的已完成分叉轮次');
    const sourceVersion = taskTransferDigest([source.runs, source.messages]);
    const transfer = await this.capture(source, targetId, randomUUID(), 'merge_back', runId);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), prior = state.taskTransferRequests?.[requestId];
      if (prior) { if (prior.intent !== intent) throw new Error('上下文交接请求 ID 已被使用'); return; }
      if (Object.hasOwn(state.requests, requestId)) throw new Error('请求 ID 已被其他操作使用');
      const current = state.tasks.find(task => task.id === sourceId), target = state.tasks.find(task => task.id === targetId);
      if (!current || !target || current.forkOrigin?.taskId !== targetId || taskTransferDigest([current.runs, current.messages]) !== sourceVersion || activeStatuses.includes(current.status) || current.sessionOperation?.status === 'pending') throw new Error('分叉历史已经改变，请重新合并');
      target.contextTransfers ??= [];
      for (const pending of target.contextTransfers) if (pending.status === 'pending' && pending.kind === 'merge_back' && pending.sourceTaskId === sourceId) pending.status = 'superseded';
      target.contextTransfers.push(transfer); target.updatedAt = stamp(); current.updatedAt = stamp();
      state.taskTransferRequests ??= {}; state.taskTransferRequests[requestId] = { taskId: targetId, sourceTaskId: sourceId, transferId: transfer.id, intent }; state.requests[requestId] = targetId; state.revision++;
    }, BACKGROUND_CONTEXT);
    return targetId;
  }
  pending(task: WorkItem, command?: string) {
    const pending = command ? [] : (task.contextTransfers ?? []).filter(transfer => transfer.status === 'pending');
    if (new Set(pending.filter(transfer => transfer.kind === 'merge_back').map(transfer => transfer.sourceTaskId)).size > 1) throw new Error('多个分叉有待合并，请先保留本次需要的一个来源');
    return pending;
  }
  project(transfers: TaskContextTransfer[]) { return transfers.map(transfer => this.engine.contexts.project(contextLink(transfer.reference), [transfer.reference])).join('\n\n'); }
  async dismiss(taskId: string, transferId: string) {
    await this.engine.mutate(state => { const task = state.tasks.find(task => task.id === taskId), transfer = task?.contextTransfers?.find(transfer => transfer.id === transferId); if (!task || !transfer || transfer.kind !== 'merge_back' || transfer.status === 'consumed') throw new Error('待合并上下文已经改变'); if (transfer.status === 'superseded') return; transfer.status = 'superseded'; task.updatedAt = stamp(); });
  }
}
