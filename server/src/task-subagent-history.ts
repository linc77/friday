import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeRewind, type ChatMessage, type TaskEvent, type Workspace } from './types.js';
import { codexChildTurnIdentity, visibleSubagentIds, type TaskSubagent } from './task-subagent-types.js';
import type { CodexHistorySnapshot, SubagentHistoryProjection } from './codex-history.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const digest = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const native = (event: TaskEvent) => event.nativeTurnId ?? (event.id.startsWith('codex:') && event.id.endsWith(':turn') ? event.id.slice(6, -5) : undefined);
const answer = (events: TaskEvent[]) => events.findLast(event => event.kind === 'message' && event.phase === 'final_answer')?.text
  || events.findLast(event => event.kind === 'message' && !event.phase)?.text || events.findLast(event => event.kind === 'proposal')?.text;
function scope(state: Workspace, id: string) {
  const child = state.tasks.find(task => task.id === id && ['codex', 'opencode'].includes(task.agent) && task.subagentOrigin);
  const root = child && state.tasks.find(task => task.id === child.subagentOrigin!.rootTaskId);
  const agent = root?.subagents?.find(agent => agent.id === child?.subagentOrigin!.subagentId && agent.provider === child.agent);
  if (!root || !child || !agent || root.threadId !== agent.threadId || activeRewind(root.rewindOperation) || child.threadId !== (agent.provider === 'codex' ? agent.nativeId : agent.nativeThreadId) || !child.threadId || child.subagentOrigin!.sessionId !== agent.sessionId
    || !visibleSubagentIds(state.tasks).has(id)) return;
  const parentAgent = agent.parentSubagentId ? root.subagents?.find(value => value.id === agent.parentSubagentId) : undefined;
  const parent = parentAgent ? parentAgent.provider === 'codex' ? parentAgent.nativeId : parentAgent.nativeThreadId : agent.threadId;
  if (!parent) return;
  const key = digest([child.id, child.threadId, child.cwd, child.codexHome, child.nativeProviderAccount, child.providerInstanceId, child.executionWorkspace, child.subagentOrigin,
    root.executionSessionId, root.threadId, agent.sessionId, agent.nativeId, agent.nativeRunId, agent.generation, agent.childTurnId, agent.status, parent]);
  return { root, child, agent, parent, key };
}

/** Read-only provider history is a projection into the existing conversation.
 * It never creates a TaskRun, starts a model, or takes over a native session. */
export class TaskSubagentHistory {
  private pending = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private cache = new Map<string, { key: string; at: number }>();
  private closed = false;
  constructor(private engine: Engine) {}
  available(state: Workspace, id: string) { return !!this.engine.executor.readSubagentHistory && !!scope(state, id); }
  async ensure(id: string, force = false) {
    if (this.closed || !this.engine.executor.readSubagentHistory) return;
    const running = this.pending.get(id); if (running) return running.promise;
    const own = scope(await this.engine.snapshot(), id); if (!own || this.closed) return;
    const cached = this.cache.get(id);
    if (!force && cached?.key === own.key && Date.now() - cached.at < (['running', 'waiting', 'unknown'].includes(own.agent.status) ? 2500 : 15_000)) return;
    // A second viewer may have started a read while snapshot() was pending.
    const other = this.pending.get(id); if (other) return other.promise;
    const controller = new AbortController();
    const promise = this.read(own, controller.signal, force).finally(() => {
      this.pending.delete(id); this.cache.delete(id); this.cache.set(id, { key: own.key, at: Date.now() });
      while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    });
    this.pending.set(id, { controller, promise }); return promise;
  }
  private async read(own: NonNullable<ReturnType<typeof scope>>, signal: AbortSignal, force: boolean) {
    try {
      const before = await this.engine.taskHistory.events(own.child);
      if (!own.child.nativeHistory || force) await this.state(own.child.id, own.key, 'loading');
      signal.throwIfAborted();
      const snapshot = await this.engine.executor.readSubagentHistory!({ ...own.child, events: before }, own.parent, signal);
      if (snapshot.threadId !== own.child.threadId || snapshot.parentThreadId !== own.parent) throw new Error('History scope changed');
      signal.throwIfAborted();
      const apply = async (connected: boolean) => {
        signal.throwIfAborted(); return this.project(own, before, snapshot, connected);
      };
      if (this.engine.executor.syncSubagentHistory) await this.engine.executor.syncSubagentHistory(own.child, snapshot, apply); else await apply(false);
    } catch {
      if (!signal.aborted) await this.state(own.child.id, own.key, 'failed');
    }
  }
  private async state(id: string, key: string, status: 'loading' | 'failed') {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const own = scope(state, id); if (own?.key !== key) return;
      if (own.child.nativeHistory?.status === status) return;
      own.child.nativeHistory = copy({ status, epoch: own.child.nativeHistory?.epoch, canFork: own.child.nativeHistory?.canFork, updatedAt: new Date().toISOString() }); state.revision++;
    }, context);
  }
  private async project(own: NonNullable<ReturnType<typeof scope>>, before: TaskEvent[], snapshot: CodexHistorySnapshot, connected: boolean) {
    let projection: SubagentHistoryProjection | undefined;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const current = scope(state, own.child.id); if (current?.key !== own.key) return;
      const { child, agent } = current; const all = await this.engine.taskHistory.events(child, tx);
      const previous = new Map(before.map(event => [event.id, event])); const events = new Map(all.map(event => [event.id, event]));
      const display = new Map<string, string>();
      for (const event of all) if (event.kind === 'turn' && native(event) && event.turnId) display.set(native(event)!, event.turnId);
      if (agent.nativeRunId) display.set(agent.nativeRunId, agent.childTurnId);
      const knownIndex = agent.nativeRunId ? snapshot.turns.findIndex(turn => turn.id === agent.nativeRunId) : -1;
      const adopted = !agent.nativeRunId ? snapshot.turns.at(-1)?.id : undefined;
      if (adopted) display.set(adopted, agent.childTurnId);
      let generation = agent.generation; let changed = false; const touched: string[] = [];
      const imported: SubagentHistoryProjection['turns'] = [];
      const mutable = connected && ['running', 'waiting'].includes(agent.status);
      const messages = child.messages ??= [];
      const message = (value: ChatMessage) => {
        const index = messages.findIndex(item => item.id === value.id); const old = index < 0 ? undefined : messages[index];
        if (old && digest(old) === digest(value)) return;
        if (index < 0) messages.push(value); else messages[index] = value;
        this.engine.taskHistory.messageChanged(child, value.id); changed = true;
      };
      for (const [index, turn] of snapshot.turns.entries()) {
        if (mutable && (turn.id === agent.nativeRunId || turn.id === adopted || knownIndex >= 0 && index > knownIndex) || connected && turn.status === 'inProgress') continue;
        let turnId = display.get(turn.id);
        if (!turnId) {
          turnId = knownIndex >= 0 && index > knownIndex ? codexChildTurnIdentity(agent.id, ++generation)
            : 'codex-history:' + createHash('sha256').update(digest([agent.id, turn.id])).digest('hex');
          display.set(turn.id, turnId);
        }
        const accepted: TaskEvent[] = [];
        for (const source of turn.events) {
          const existing = events.get(source.id), baseline = previous.get(source.id);
          // Native history has no revision token for mutable items. Live writes
          // during this read and owned command tails always take precedence.
          if (existing && digest(existing) !== digest(baseline) || existing?.kind === 'command' && existing.status === 'running') continue;
          const event = { ...copy(source), turnId, nativeTurnId: turn.id }; delete event.runId;
          if (existing) { event.at = existing.at; if (existing.historyOrder !== undefined) event.historyOrder = existing.historyOrder; }
          if (event.status === 'running') { event.status = 'interrupted'; delete event.background; delete event.processId; delete event.completedAt; }
          // Loading a rollout cannot establish live process ownership.
          if (event.kind === 'command' && !child.backgroundCommands?.some(command => command.id === event.id && command.status === 'running')) { delete event.background; delete event.processId; }
          const clean = ({ historyDigest: _digest, historyOrder: _order, ...body }: TaskEvent) => body;
          if (!existing || digest(clean(event)) !== digest(clean(existing))) { events.set(event.id, event); touched.push(event.id); changed = true; }
          accepted.push(event);
        }
        imported.push({ id: turn.id, childTurnId: turnId, events: accepted });
        const oldPrompt = messages.find(item => item.id === turnId + ':prompt');
        if (turn.prompt) message({ id: turnId + ':prompt', role: 'user', text: turn.prompt, at: oldPrompt?.at ?? turn.at, turnId });
        const text = answer([...events.values()].filter(event => event.turnId === turnId));
        const oldAnswer = messages.find(item => item.id === turnId + ':answer');
        if (text && turn.status !== 'inProgress') message({ id: turnId + ':answer', role: 'assistant', text, at: oldAnswer?.at ?? turn.completedAt ?? turn.at, turnId });
      }
      const last = snapshot.turns.at(-1), lastDisplay = last && display.get(last.id);
      if (!mutable && last && lastDisplay && (!connected || last.status !== 'inProgress') && (knownIndex >= 0 || adopted)) {
        const next: TaskSubagent = { ...agent, generation, nativeRunId: last.id, childTurnId: lastDisplay,
          status: last.status === 'inProgress' ? 'unknown' : last.status as TaskSubagent['status'],
          ...(last.completedAt ? { completedAt: last.completedAt } : {}), ...(last.prompt ? { prompt: last.prompt } : {}) };
        const text = answer([...events.values()].filter(event => event.turnId === lastDisplay)); if (text) next.result = text;
        if (digest(next) !== digest(agent)) {
          Object.assign(agent, next); child.turnId = lastDisplay; child.status = next.status === 'unknown' ? 'interrupted' : next.status;
          child.subagentOrigin!.status = next.status; if (text) child.result = text; changed = true;
        }
      }
      if (!connected) {
        if (snapshot.model && child.model === own.child.model && snapshot.model !== child.model) { child.model = snapshot.model; agent.model = snapshot.model; changed = true; }
        if (snapshot.effort && child.reasoningEffort === own.child.reasoningEffort && snapshot.effort !== child.reasoningEffort) { child.reasoningEffort = snapshot.effort; agent.reasoningEffort = snapshot.effort; changed = true; }
      }
      const statusChanged = child.nativeHistory?.status !== 'ready';
      if (changed || statusChanged) {
        child.nativeHistory = copy({ status: 'ready', epoch: changed ? randomUUID() : child.nativeHistory?.epoch, canFork: snapshot.canFork ?? true, updatedAt: new Date().toISOString() });
        if (changed) {
          child.events = [...events.values()].sort((a, b) => a.at.localeCompare(b.at) || (a.historyOrder ?? 0) - (b.historyOrder ?? 0));
          messages.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? ''));
          await this.engine.taskHistory.persist(tx, child, touched);
        }
        state.revision++;
      }
      projection = { agent: copy(agent), turns: imported };
    }, context);
    return projection;
  }
  async close() {
    this.closed = true; for (const value of this.pending.values()) value.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(value => value.promise));
  }
}
