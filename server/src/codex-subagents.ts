import { randomUUID } from 'node:crypto';
import type { CodexRpc, Wire } from './codex-rpc.js';
import { CodexEvents } from './codex-events.js';
import type { Approval, ExecutionUpdate } from './types.js';
import type { NativeObservedUpdate } from './native-runtime-types.js';
import { subagentChildId, subagentEnded, codexSubagentIdentity, codexChildTurnIdentity, type TaskSubagent } from './task-subagent-types.js';
import type { SubagentHistoryProjection } from './codex-history.js';
import { codexApprovalKind, codexLegacyDecision, codexPermissionResponse, permissionDecisions, type CodexApprovalScope } from './provider-approvals.js';
import { describeMcpElicitation, toMcpElicitationResponse } from './codex-mcp-elicitation.js';

type Origin = { runId: string; turnId: string; parentSubagentId?: string };
type Turn = { id: string; state: TaskSubagent; events: CodexEvents; finished: boolean; hasText: boolean };
type Child = { state: TaskSubagent; turns: Map<string, Turn>; current?: Turn; prompt?: string; wire: Map<string, Wire[]>; seed?: TaskSubagent; previousSessionId?: string; selectionVersion: number; followups: Set<string> };
type Request = { child: Child; turn: Turn; wireId: string | number; method: string; threadId: string; sent?: boolean; scope?: CodexApprovalScope; params: any };
const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const stamp = () => new Date().toISOString();
const terminal = (status: string): TaskSubagent['status'] => status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed';
const states: Record<string, TaskSubagent['status']> = { pendingInit: 'running', running: 'running', interrupted: 'interrupted', completed: 'completed', errored: 'failed', shutdown: 'cancelled', notFound: 'failed' };

/** Observe only threads named by a native spawn/activity on an owned turn.
 * This class never starts, resumes, or sends user input to a child model. */
export class CodexSubagents {
  private children = new Map<string, Child>();
  private pending = new Map<string, Wire[]>();
  private requests = new Map<string, Request>();
  private pendingSpawns = new Set<string>();
  private chain = Promise.resolve();
  private queued = 0;
  private closed = false;
  private stopping = false;
  private interrupts = new Map<string, Promise<void>>();
  private reads = new Set<string>();
  onIdle: () => void = () => {};
  constructor(private scope: { taskId: string; sessionId: string; threadId: () => string; known?: () => Promise<readonly TaskSubagent[]>; approvalScope?: (threadId: string, runId: string) => CodexApprovalScope | undefined }, private rpc: CodexRpc, private send: (update: ExecutionUpdate) => Promise<void>) {}
  retained(runId?: string) {
    return this.queued > 0 || this.reads.size > 0 || this.pendingSpawns.size > 0 || [...this.children.values()].some(child => (!runId || child.state.runId === runId)
      && (['running', 'waiting'].includes(child.state.status) || [...child.turns.values()].some(turn => turn.events.backgroundCommands.length > 0))) || this.requests.size > 0;
  }
  owns(threadId: string) { return this.children.has(threadId); }
  retainHistory() {
    const key = 'history:' + randomUUID(); this.reads.add(key);
    return () => { this.reads.delete(key); this.onIdle(); };
  }
  reconcileHistory(native: string, apply: () => Promise<SubagentHistoryProjection | undefined>) {
    return this.enqueue(async () => {
      const child = this.children.get(native); if (!child || this.closed) return;
      const projection = await apply(); if (!projection) return;
      for (const saved of projection.turns) {
        let turn = child.turns.get(saved.id);
        if (turn && !turn.finished) continue;
        if (!turn) {
          turn = this.makeTurn(saved.id, { ...projection.agent, nativeRunId: saved.id, childTurnId: saved.childTurnId });
          turn.finished = true; child.turns.set(saved.id, turn);
        }
        turn.events.restore(saved.events.map(event => ({ ...event, turnId: saved.id })));
        turn.hasText ||= saved.events.some(event => ['message', 'proposal'].includes(event.kind) && !!event.text);
      }
      if (!child.current || child.current.finished) {
        child.state = { ...projection.agent }; child.seed = { ...projection.agent };
        if (projection.agent.nativeRunId) child.current = child.turns.get(projection.agent.nativeRunId);
        if (child.current) child.current.state = child.state;
      }
    });
  }
  private enqueue(work: () => Promise<void>) {
    this.queued++;
    const operation = this.chain.then(work);
    this.chain = operation.catch(() => {}).finally(() => { this.queued--; this.onIdle(); });
    return operation;
  }
  async drain() { await this.chain; }
  accept(message: Wire) {
    if (this.closed) return false;
    const p = message.params ?? {}; const native = p.threadId ?? p.thread?.id ?? p.conversationId;
    const resolved = message.method === 'serverRequest/resolved' && [...this.requests.values()].some(request => request.wireId === p.requestId);
    if (resolved || valid(native) && this.children.has(native)) { void this.enqueue(() => this.handleChild(native, message)); return true; }
    if (valid(native) && native !== this.scope.threadId()) {
      const frames = this.pending.get(native) ?? [];
      if (frames.length < 128 && JSON.stringify([...frames, message]).length <= 1_048_576) { frames.push(message); this.pending.set(native, frames); }
      if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
      return true;
    }
    return false;
  }
  root(message: Wire, origin: Origin) {
    const item = message.params?.item;
    if (!['item/started', 'item/completed'].includes(message.method ?? '') || !['collabAgentToolCall', 'subAgentActivity'].includes(item?.type)) return Promise.resolve(false);
    return this.enqueue(async () => { await this.lifecycle(message, origin); }).then(() => true);
  }
  private async emit(state: TaskSubagent, value?: NativeObservedUpdate) {
    if (value?.kind !== 'commandOutput') state.updatedAt = stamp();
    const child = this.children.get(state.nativeId), previousSessionId = child?.previousSessionId;
    await this.send({ kind: 'subagent', sessionId: this.scope.sessionId, threadId: this.scope.threadId(), subagent: { ...state }, ...(previousSessionId ? { previousSessionId } : {}), ...(value ? { value } : {}) });
    if (child && previousSessionId) delete child.previousSessionId;
  }
  private async background(turn: Turn, value: { kind: 'item'; item: import('./types.js').TaskEvent } | { kind: 'commandOutput'; eventId: string; delta: string }, disconnected = false) {
    await this.send({ kind: 'subagentBackground', sessionId: this.scope.sessionId, threadId: this.scope.threadId(), subagentId: turn.state.id, childTaskId: turn.state.childTaskId,
      nativeId: turn.state.nativeId, nativeTurnId: turn.id, childTurnId: turn.state.childTurnId, value, ...(disconnected ? { disconnected: true } : {}) });
  }
  private async register(native: string, origin: Origin, item: any, index = 0, knownOnly = false) {
    if (!valid(native) || native === this.scope.threadId() || this.stopping) return;
    const existing = this.children.get(native);
    if (existing) return existing;
    const seed = (await this.scope.known?.())?.find(agent => agent.provider === 'codex' && agent.threadId === this.scope.threadId() && agent.nativeId === native);
    if (knownOnly && !seed || this.closed || this.stopping) return;
    const id = seed?.id ?? codexSubagentIdentity(this.scope.threadId(), native); const at = stamp();
    const fresh: TaskSubagent = { id, provider: 'codex', nativeId: native, sessionId: this.scope.sessionId, threadId: this.scope.threadId(),
      runId: origin.runId, turnId: origin.turnId, eventId: `codex:${origin.turnId}:${item.id}:${native}`, childTaskId: subagentChildId(this.scope.taskId, id),
      generation: 0, childTurnId: this.childTurn(id, 0), title: item.agentPath || `Subagent ${index + 1}`, prompt: typeof item.prompt === 'string' ? item.prompt : '',
      ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}), ...(typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {}),
      ...(origin.parentSubagentId ? { parentSubagentId: origin.parentSubagentId, eventOwnerSubagentId: origin.parentSubagentId } : {}), status: 'running', startedAt: at, updatedAt: at };
    const state: TaskSubagent = seed ? { ...seed, sessionId: this.scope.sessionId, status: ['running', 'waiting'].includes(seed.status) ? 'unknown' : seed.status, updatedAt: at, backgroundCommands: 0, unknownCommands: 0 } : fresh;
    delete state.canStop; delete state.stop;
    const child: Child = { state, turns: new Map(), wire: new Map(), selectionVersion: 0, followups: new Set(), ...(seed ? { seed: { ...seed }, ...(seed.sessionId !== this.scope.sessionId ? { previousSessionId: seed.sessionId } : {}) } : {}) };
    if (seed && item.type === 'collabAgentToolCall' && item.tool !== 'spawnAgent') { child.followups.add(origin.turnId + ':' + item.id); if (typeof item.prompt === 'string') child.prompt = item.prompt; }
    this.children.set(native, child);
    await this.emit(state);
    const frames = this.pending.get(native) ?? []; this.pending.delete(native);
    for (const frame of frames) await this.handleChild(native, frame);
    if (seed || !state.model) this.readSelection(child);
    return child;
  }
  private readSelection(child: Child) {
    const native = child.state.nativeId, version = child.selectionVersion;
    this.reads.add(native);
    void this.rpc.call('thread/read', { threadId: native, includeTurns: false }, 5_000).then(response => this.enqueue(async () => {
      if (this.closed || response?.thread?.id !== native || child.selectionVersion !== version) return;
      this.selection(child, response.thread); await this.emit(child.state);
    })).catch(() => {}).finally(() => { this.reads.delete(native); this.onIdle(); });
  }
  private selection(child: Child, value: any) {
    if (typeof value?.model === 'string' && value.model.trim()) child.state.model = value.model;
    const effort = value?.reasoningEffort ?? value?.effort;
    if (typeof effort === 'string') child.state.reasoningEffort = effort;
    else if (value?.reasoningEffort === null || value?.effort === null) delete child.state.reasoningEffort;
  }
  private childTurn(id: string, generation: number) { return codexChildTurnIdentity(id, generation); }
  private async lifecycle(message: Wire, origin?: Origin) {
    const item = message.params?.item; if (!item || !valid(item.id)) return;
    if (item.type === 'collabAgentToolCall') {
      if (item.tool === 'spawnAgent' && origin) {
        const key = origin.turnId + ':' + item.id;
        if (message.method === 'item/started') this.pendingSpawns.add(key); else this.pendingSpawns.delete(key);
        if (Array.isArray(item.receiverThreadIds)) for (const [index, native] of item.receiverThreadIds.entries()) await this.register(native, origin, item, index);
      } else if (['sendInput', 'sendMessage', 'followupTask', 'resumeAgent'].includes(item.tool)) {
        for (const native of item.receiverThreadIds ?? []) {
          const child = this.children.get(native) ?? (origin && await this.register(native, origin, item, 0, true)); const key = origin?.turnId + ':' + item.id;
          if (child && !child.followups.has(key)) { child.followups.add(key); if (typeof item.prompt === 'string') child.prompt = item.prompt; }
        }
      }
      if (message.method !== 'item/completed') return;
      for (const [native, value] of Object.entries(item.agentsStates ?? {})) {
        const child = this.children.get(native); const state = value as any; const status = states[state?.status];
        if (!child || !status || subagentEnded(child.state.status) && ['running', 'waiting'].includes(status)) continue;
        if (['running', 'waiting'].includes(status)) continue; // Actual turn/started re-opens a native child.
        await this.finish(child, status, typeof state.message === 'string' ? state.message : undefined);
      }
    } else if (item.type === 'subAgentActivity') {
      if (item.kind === 'started' && origin) await this.register(item.agentThreadId, origin, item);
      else { const child = this.children.get(item.agentThreadId); if (child && ['completed', 'interrupted'].includes(item.kind)) await this.finish(child, item.kind); }
    }
  }
  private async startTurn(child: Child, native: string) {
    if (!valid(native)) return;
    if (child.turns.has(native)) return child.turns.get(native);
    const previous = child.current;
    if (previous && !previous.finished) { await previous.events.finishTurn(previous.id, 'interrupted'); previous.finished = true; }
    const sameSeed = !previous && child.seed?.nativeRunId === native;
    const newTurn = !!previous || !sameSeed && (child.prompt !== undefined || child.seed?.nativeRunId !== undefined);
    const generation = newTurn ? child.state.generation + 1 : child.state.generation;
    const lateStart = !newTurn && subagentEnded(child.state.status);
    const state: TaskSubagent = { ...child.state, generation, nativeRunId: native, childTurnId: this.childTurn(child.state.id, generation),
      prompt: newTurn ? child.prompt ?? '' : child.state.prompt, status: lateStart ? child.state.status : 'running', startedAt: lateStart || sameSeed ? child.state.startedAt : stamp(), updatedAt: stamp() };
    if (sameSeed) state.childTurnId = child.seed!.childTurnId;
    if (!lateStart) { delete state.completedAt; delete state.result; delete state.progress; } child.prompt = undefined;
    const turn = this.makeTurn(native, state);
    child.current = turn; child.state = state; child.turns.set(native, turn);
    await this.emit(state); await turn.events.startTurn(native);
    const waiting = child.wire.get(native) ?? []; child.wire.delete(native);
    for (const frame of waiting) await this.handleChild(state.nativeId, frame);
    return turn;
  }
  private makeTurn(native: string, state: TaskSubagent): Turn {
    const turn: Turn = { id: native, state, finished: false, hasText: false, events: undefined! };
    turn.events = new CodexEvents(async value => {
      if (value.kind === 'item') {
        if (value.item.kind === 'command' && value.item.background) { await this.background(turn, value); return; }
        if (['message', 'proposal'].includes(value.item.kind) && value.item.text) turn.hasText = true;
        await this.emit(turn.state, { kind: 'item', item: { ...value.item, turnId: turn.state.childTurnId, nativeTurnId: turn.id } });
      } else if (value.kind === 'commandOutput' && turn.events.isBackground(value.eventId)) await this.background(turn, value);
      else if (value.kind === 'output' || value.kind === 'commandOutput') await this.emit(turn.state, value);
    });
    return turn;
  }
  private async handleChild(native: string | undefined, message: Wire) {
    if (message.method === 'serverRequest/resolved') {
      for (const [id, request] of this.requests) if (request.wireId === message.params?.requestId) await this.resolve(id, false);
      return;
    }
    const child = native && this.children.get(native); if (!child) return;
    const p = message.params ?? {};
    if (message.method === 'thread/started' || message.method === 'thread/settings/updated') {
      const value = message.method === 'thread/started' ? p.thread : p.threadSettings;
      child.selectionVersion++; this.selection(child, value);
      const parent = value?.parentThreadId ?? value?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if (parent && parent !== this.scope.threadId() && this.children.has(parent)) child.state.parentSubagentId = this.children.get(parent)!.state.id;
      await this.emit(child.state); return;
    }
    const turnId = p.turnId ?? p.turn?.id;
    if (message.method === 'turn/started') { await this.startTurn(child, turnId); return; }
    let turn = typeof turnId === 'string' ? child.turns.get(turnId) : child.current;
    if (!turn) {
      if (valid(turnId)) { const frames = child.wire.get(turnId) ?? []; if (frames.length < 128) { frames.push(message); child.wire.set(turnId, frames); } if (child.wire.size > 16) child.wire.delete(child.wire.keys().next().value!); }
      return;
    }
    if (message.id !== undefined && message.method) {
      const legacy = ['execCommandApproval','applyPatchApproval'].includes(message.method);
      if (turn !== child.current || turn.finished || subagentEnded(turn.state.status) || this.stopping || !legacy && p.turnId !== turn.id) { this.deny(message); return; }
      const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval'];
      if (!supported.includes(message.method)) { this.deny(message); return; }
      const elicitation = message.method === 'mcpServer/elicitation/request';
      if (elicitation && (typeof p.serverName !== 'string' || typeof p.message !== 'string' || toMcpElicitationResponse(p, 'accept').action !== 'accept')) { this.deny(message); return; }
      if (message.method === 'item/permissions/requestApproval' && (!p.permissions || typeof p.permissions !== 'object' || Array.isArray(p.permissions))) { this.deny(message); return; }
      const kind = codexApprovalKind(message.method), scope = kind ? this.scope.approvalScope?.(native!, turn.state.runId) : undefined;
      if (kind && scope?.allows(kind)) { this.rpc.send({ id: message.id, result: { decision: legacy ? codexLegacyDecision('acceptForSession') : 'acceptForSession' } }); return; }
      const id = randomUUID(); this.requests.set(id, { child, turn, wireId: message.id, method: message.method, threadId: native!, scope, params: p });
      turn.state.status = 'waiting';
      const approval: Approval = { id, method: message.method, state: 'pending', title: message.method.includes('requestUserInput') ? '需要你的补充' : '需要你的授权',
        ...(kind || message.method === 'item/permissions/requestApproval' ? { decisions: permissionDecisions } : {}),
        ...(elicitation ? { appName: describeMcpElicitation(p).appName, options: [...describeMcpElicitation(p).options] } : {}),
        detail: [turn.state.title, p.reason, elicitation ? p.message : '', Array.isArray(p.command) ? p.command.join(' ') : p.command, p.cwd, p.grantRoot, p.permissions ? JSON.stringify(p.permissions,null,2) : '', p.changes ? JSON.stringify(p.changes,null,2) : ''].filter(Boolean).join('\n'),
        questions: (Array.isArray(p.questions) ? p.questions : []).map((q: any) => ({ id: q.id, header: q.header ?? '', question: q.question, options: (q.options ?? []).map((option: any) => ({ label: option.label, description: option.description ?? '' })), multiSelect: q.multiSelect === true, isOther: q.isOther === true, isSecret: q.isSecret === true })) };
      await this.emit(turn.state, { kind: 'approval', approval }); return;
    }
    if (message.method === 'turn/completed') {
      if (turn.finished || turn !== child.current) return;
      await this.finish(child, terminal(p.turn.status)); return;
    }
    if (['item/started', 'item/completed'].includes(message.method ?? '') && ['collabAgentToolCall', 'subAgentActivity'].includes(p.item?.type)) {
      await this.lifecycle(message, { runId: turn.state.runId, turnId: turn.state.childTurnId, parentSubagentId: turn.state.id }); return;
    }
    if (turn.finished) {
      const itemId = p.itemId ?? p.item?.id;
      if (!valid(itemId) || !turn.events.owns(itemId) || !['item/completed', 'item/commandExecution/outputDelta'].includes(message.method ?? '')) return;
    }
    if (p.item?.type === 'userMessage') {
      const prompt = (p.item.content ?? []).filter((value: any) => value.type === 'text' && typeof value.text === 'string').map((value: any) => value.text).join('\n');
      if (prompt) { turn.state.prompt = prompt; await this.emit(turn.state); } return;
    }
    await turn.events.handle(message.method!, p, turn.id);
  }
  private deny(message: Wire) {
    if (message.method === 'item/permissions/requestApproval') this.rpc.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
    else if (message.method === 'mcpServer/elicitation/request') this.rpc.send({ id: message.id, result: { action: 'decline', content: null } });
    else if (message.method === 'item/tool/requestUserInput') this.rpc.send({ id: message.id, error: { code: -32601, message: 'This native turn cannot ask for input' } });
    else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method ?? '')) this.rpc.send({ id: message.id, result: { decision: 'decline' } });
    else if (['execCommandApproval', 'applyPatchApproval'].includes(message.method ?? '')) this.rpc.send({ id: message.id, result: { decision: codexLegacyDecision('decline') } });
    else this.rpc.send({ id: message.id, error: { code: -32601, message: 'Unsupported native subagent request' } });
  }
  private async resolve(id: string, expired: boolean) {
    const request = this.requests.get(id); if (!request) return; this.requests.delete(id);
    if (request.turn === request.child.current && !request.turn.finished && ![...this.requests.values()].some(value => value.turn === request.turn)) request.turn.state.status = 'running';
    await this.emit(request.turn.state, { kind: 'approvalResolved', id, ...(expired ? { expired: true } : {}) });
  }
  async answer(id: string, decision: import('./provider-approvals.js').ApprovalDecision, answers: Record<string, string[]>) {
    const request = this.requests.get(id); if (!request || request.sent || request.turn.finished || this.closed || this.rpc.child.stdin.destroyed) return false;
    const kind = codexApprovalKind(request.method);
    const structured = request.method === 'item/permissions/requestApproval', elicitation = request.method === 'mcpServer/elicitation/request';
    if (decision === 'acceptForSession' && !structured && !elicitation && (!kind || !request.scope)) throw new Error('此请求不支持会话授权');
    if (decision === 'acceptAlways' && !elicitation) throw new Error('此请求不支持永久授权');
    request.sent = true;
    this.rpc.send({ id: request.wireId, result: request.method === 'item/tool/requestUserInput' ? { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }])) }
      : structured ? codexPermissionResponse(request.params.permissions, decision)
      : elicitation ? toMcpElicitationResponse(request.params, decision)
      : { decision: ['execCommandApproval','applyPatchApproval'].includes(request.method) ? codexLegacyDecision(decision) : decision } });
    if (decision === 'acceptForSession' && kind) request.scope!.grant(kind);
    await this.enqueue(() => this.resolve(id, false)); return true;
  }
  private async finish(child: Child, status: TaskSubagent['status'], result?: string) {
    const turn = child.current;
    if (turn && !turn.finished) { await turn.events.finishTurn(turn.id, status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted', true); turn.finished = true; }
    const state = child.state; state.status = status; state.completedAt = stamp();
    if (turn?.hasText) state.result = turn.events.result; else if (result !== undefined) state.result = result;
    for (const [id, request] of [...this.requests]) if (request.child === child) { this.deny({ id: request.wireId, method: request.method }); await this.resolve(id, true); }
    await this.emit(state);
  }
  async stop(expected: TaskSubagent, signal: AbortSignal) {
    const child = this.children.get(expected.nativeId); const current = child?.current;
    if (!child || !current || child.state.childTurnId !== expected.childTurnId || current.id !== expected.nativeRunId || this.closed) throw new Error('子线程执行范围已改变');
    if (subagentEnded(child.state.status)) return;
    const key = expected.nativeId + ':' + current.id;
    let operation = this.interrupts.get(key);
    if (!operation) {
      operation = (async () => {
        signal.throwIfAborted(); await this.rpc.call('turn/interrupt', { threadId: expected.nativeId, turnId: current.id });
        const deadline = Date.now() + 10_000;
        while (!subagentEnded(child.state.status)) {
          signal.throwIfAborted(); if (this.closed || child.current !== current || Date.now() >= deadline) throw new Error('子线程停止结果尚未确认');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      })(); this.interrupts.set(key, operation);
    }
    await operation;
  }
  async disconnect(interrupted = false) {
    if (this.closed) return; this.closed = true; this.stopping = true; await this.chain;
    this.pendingSpawns.clear(); this.pending.clear();
    for (const child of this.children.values()) {
      if (!subagentEnded(child.state.status)) await this.finish(child, interrupted ? 'interrupted' : 'unknown');
      for (const turn of child.turns.values()) for (const item of turn.events.backgroundCommands) await this.background(turn, { kind: 'item', item: { ...item, status: 'interrupted', completedAt: stamp() } }, true);
    }
  }
  async interruptAll() {
    this.stopping = true;
    await this.drain();
    await Promise.allSettled([...this.children.values()].filter(child => child.current && !subagentEnded(child.state.status))
      .map(child => this.stop({ ...child.state }, new AbortController().signal)));
  }
  async confirmStopped(threadId: string, turnId: string, itemId: string) {
    await this.enqueue(async () => { const turn = this.children.get(threadId)?.turns.get(turnId); if (turn) await turn.events.confirmStopped(itemId); });
  }
}
