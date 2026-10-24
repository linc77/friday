import { createHash } from 'node:crypto';
import { subagentIdentity, subagentChildId, subagentEnded, type TaskSubagent } from './task-subagent-types.js';
import type { Approval, ExecutionRequest } from './types.js';

type Observation = { nativeId: string; nativeChildId?: string; generation?: number; hydrationOnly?: boolean; title?: string; prompt?: string; model?: string; status: TaskSubagent['status']; progress?: string; result?: string; parentNativeId?: string; messages?: string[] };
const text = (value: unknown, limit = 20_000) => typeof value === 'string' ? value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '') : undefined;

/** Projects native lifecycle facts. It never starts, resumes or stops a child.
 * Call IDs are scoped to the owning native transport and persisted parent run. */
export class NativeSubagentProjection {
  private entries = new Map<string, TaskSubagent>();
  private aliases = new Map<string, string>();
  private childText = new Map<string, string>();
  constructor(private request: ExecutionRequest, private provider: TaskSubagent['provider'], readonly sessionId: string, readonly threadId: string, readonly turnId: string) {}
  async observe(value: Observation) {
    if (this.request.purpose || !this.request.task.currentRunId) return;
    if (typeof value.nativeId !== 'string' || !value.nativeId || value.nativeId.length > 2000 || /[\x00-\x1f]/.test(value.nativeId)) throw new Error('原生子 Agent 标识无效');
    const nativeId = value.nativeChildId && this.aliases.get(value.nativeChildId) || this.aliases.get(value.nativeId) || value.nativeId;
    const previous = this.entries.get(nativeId);
    if (!previous && value.hydrationOnly) return;
    const generation = value.generation ?? previous?.generation ?? 0;
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('原生子 Agent 代次无效');
    if (previous && (generation < previous.generation || generation === previous.generation && subagentEnded(previous.status) && !subagentEnded(value.status))) return;
    if (previous && generation > previous.generation) this.childText.delete(nativeId);
    const prior = previous?.generation === generation ? previous : previous ? { ...previous, result: undefined, progress: undefined, completedAt: undefined, startedAt: undefined, childTurnId: undefined } : undefined;
    const parent = value.parentNativeId ? this.entries.get(value.parentNativeId) : undefined;
    if (value.parentNativeId && !parent) return;
    const id = subagentIdentity(this.sessionId, nativeId), at = new Date().toISOString(), ended = subagentEnded(value.status);
    const agent: TaskSubagent = {
      ...prior, id, provider: this.provider, nativeId, sessionId: this.sessionId, threadId: this.threadId,
      runId: this.request.task.currentRunId, turnId: this.turnId, eventId: previous?.eventId ?? `${this.provider}:${this.turnId}:subagent:${id}`,
      childTaskId: subagentChildId(this.request.task.id, id), generation, childTurnId: prior?.childTurnId ?? `${this.provider}-child:${createHash('sha256').update(generation ? JSON.stringify([id, generation]) : id).digest('hex')}`,
      title: text(value.title, 200) || previous?.title || 'Subagent', prompt: text(value.prompt) ?? previous?.prompt ?? '',
      status: value.status, startedAt: prior?.startedAt ?? at, updatedAt: at,
      ...(typeof value.model === 'string' && value.model ? { model: text(value.model, 500)! } : {}),
      ...(value.progress !== undefined ? { progress: text(value.progress, 2000) } : {}), ...(value.result !== undefined ? { result: text(value.result, 100_000) } : {}),
      ...(ended ? { completedAt: prior?.completedAt ?? at } : {}),
      ...(parent ? { parentSubagentId: parent.id, eventOwnerSubagentId: parent.id } : {}), canStop: false,
    };
    if (ended) delete agent.progress;
    this.entries.set(nativeId, agent);
    if (value.nativeChildId) this.aliases.set(value.nativeChildId, nativeId);
    await this.request.update({ kind: 'subagent', sessionId: this.sessionId, threadId: this.threadId, subagent: agent });
    for (const [index, message] of (value.messages ?? []).entries()) {
      if (!message) continue;
      await this.request.update({ kind: 'subagent', sessionId: this.sessionId, threadId: this.threadId, subagent: agent,
        value: { kind: 'item', item: { id: `${agent.childTurnId}:message:${index}`, turnId: agent.childTurnId, kind: 'message', text: text(message, 100_000)!, at: agent.startedAt,
          phase: index === value.messages!.length - 1 && ended ? 'final_answer' : 'commentary', status: ended ? 'completed' : 'running', ...(ended ? { completedAt: agent.completedAt } : {}) } } });
    }
  }
  knowsNative(id: string) { return this.entries.has(id) || this.aliases.has(id); }
  hasPending() { return [...this.entries.values()].some(agent => !subagentEnded(agent.status)); }
  identityForNative(id: string) { return this.entries.get(this.aliases.get(id) ?? id)?.id; }
  bindNativeChild(id: string, child: unknown) {
    const nativeId = this.aliases.get(id) ?? id;
    if (this.entries.has(nativeId) && typeof child === 'string' && child && child.length <= 2000 && !/[\x00-\x1f]/.test(child) && !this.aliases.has(child)) this.aliases.set(child, nativeId);
  }
  async nativeMessage(id: string, value: string, replace = false) {
    const nativeId = this.aliases.get(id) ?? id, agent = this.entries.get(nativeId);
    if (!agent || !value) return;
    const message = text((replace ? '' : this.childText.get(nativeId) ?? '') + value, 100_000)!;
    this.childText.set(nativeId, message);
    await this.observe({ nativeId, status: agent.status, ...(subagentEnded(agent.status) ? { result: message } : { progress: message }), messages: [message] });
  }
  async nativeFinish(id: string, status: 'completed' | 'failed' | 'cancelled', result?: string) {
    const nativeId = this.aliases.get(id) ?? id;
    if (!this.entries.has(nativeId)) return;
    const output = result ?? this.childText.get(nativeId);
    await this.observe({ nativeId, status, ...(output !== undefined ? { result: output, messages: [output] } : {}) });
  }
  async nativeApproval(id: string, approval: Approval) {
    const agent = this.entries.get(this.aliases.get(id) ?? id);
    if (!agent || subagentEnded(agent.status)) return;
    await this.observe({ nativeId: agent.nativeId, status: 'waiting' });
    await this.request.update({ kind: 'subagent', sessionId: this.sessionId, threadId: this.threadId, subagent: this.entries.get(agent.nativeId)!, value: { kind: 'approval', approval: { ...approval, subagentId: agent.id, ownerRunId: agent.runId } } });
  }
  async nativeApprovalResolved(id: string, approvalId: string) {
    const agent = this.entries.get(this.aliases.get(id) ?? id);
    if (!agent) return;
    if (agent.status === 'waiting') await this.observe({ nativeId: agent.nativeId, status: 'running' });
    await this.request.update({ kind: 'subagent', sessionId: this.sessionId, threadId: this.threadId, subagent: this.entries.get(agent.nativeId)!, value: { kind: 'approvalResolved', id: approvalId } });
  }
  async finish(status: 'completed' | 'failed' | 'interrupted', unfinished: TaskSubagent['status'] = 'completed') {
    for (const agent of this.entries.values()) if (!subagentEnded(agent.status)) await this.observe({ nativeId: agent.nativeId, status: status === 'completed' ? unfinished : 'interrupted', ...(agent.parentSubagentId ? { parentNativeId: [...this.entries.values()].find(value => value.id === agent.parentSubagentId)?.nativeId } : {}) });
  }
}

export function cursorChildMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(step => { const message = step?.type === 'assistantMessage' ? step.message?.text : step?.assistantMessage?.text; return typeof message === 'string' && message ? [message] : []; });
}
