import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { WorkItem, TaskEvent } from './types.js';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { createHash } from 'node:crypto';
import { reconcileTaskSnooze } from './task-snooze.js';
import { subagentChildId, subagentEnded, subagentIdentity, codexSubagentIdentity, projectSubagentEvent, type SubagentRuntimeUpdate, type TaskSubagent, type SubagentBackgroundUpdate } from './task-subagent-types.js';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const eventStatus = (status: TaskSubagent['status']): NonNullable<TaskEvent['status']> => ['running', 'waiting'].includes(status) ? 'running' : status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted';
const childStatus = (status: TaskSubagent['status']): WorkItem['status'] => status === 'unknown' ? 'interrupted' : status;

/** Passive provider-owned conversations. Creating a projection never creates
 * a Durable execution, starts a model, or resumes the child's native session. */
export class TaskSubagents {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<{ rootId: string; agentId: string; sessionId: string; childTurnId: string; requestId: string }, { phase: 'stop' }, { status: string }, {}>({
      name: 'friday.subagent_stop', version: 1, initial: () => ({ phase: 'stop' }),
      phases: { stop: async (task, runtime, ctx) => {
        const input = task.input;
        const finish = async (status: 'completed' | 'uncertain', error?: string) => {
          await this.engine.mutate(state => { const agent = state.tasks.find(task => task.id === input.rootId)?.subagents?.find(agent => agent.id === input.agentId && agent.sessionId === input.sessionId && agent.childTurnId === input.childTurnId);
            if (agent?.stop?.requestId === input.requestId && agent.stop.status === 'pending') { agent.stop.status = status; if (error) agent.stop.error = error; } });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const root = (await this.engine.snapshot()).tasks.find(task => task.id === input.rootId);
        const agent = root?.subagents?.find(agent => agent.id === input.agentId && agent.sessionId === input.sessionId && agent.childTurnId === input.childTurnId);
        if (!root || !agent || root.executionSessionId !== input.sessionId || agent.stop?.requestId !== input.requestId) { await finish('uncertain', '子 Agent 的执行范围已改变'); return; }
        if (!subagentEnded(agent.status) && await runtime.memo<boolean>('started', ctx)) { await finish('uncertain', '子 Agent 停止结果尚未确认，不会自动重复停止'); return; }
        if (!this.engine.executor.hasSession?.(root.id)) {
          await this.interruptSource(root.id, input.sessionId, agent.id);
          await finish('completed'); return;
        }
        try {
          runtime.signal.throwIfAborted();
          if (!subagentEnded(agent.status)) { if (!this.engine.executor.stopSubagent) throw new Error('Unsupported subagent Stop'); await runtime.memo('started', true, ctx); await this.engine.executor.stopSubagent(root, agent, runtime.signal); }
          await this.stopCommands(root.id, agent, input.requestId, runtime.signal); await finish('completed');
        } catch {
          if (runtime.signal.aborted) throw new Error('子 Agent 停止请求已中断');
          await finish('uncertain', '子 Agent 的停止结果尚未确认，已保留记录');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.engine.mutate(state => { const agent = state.tasks.find(work => work.id === task.input.rootId)?.subagents?.find(agent => agent.id === task.input.agentId);
          if (agent?.stop?.requestId === task.input.requestId && agent.stop.status === 'pending') { agent.stop.status = 'uncertain'; agent.stop.error = '停止请求已中断'; } });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx);
      },
    });
  }
  async stop(rootId: string, subagentId: string, sessionId: string, childTurnId: string, requestId: string) {
    const root = (await this.engine.snapshot()).tasks.find(task => task.id === rootId);
    const agent = root?.subagents?.find(agent => agent.id === subagentId && agent.sessionId === sessionId);
    if (root && agent?.provider === 'codex') {
      if (agent.childTurnId !== childTurnId || root.executionSessionId !== sessionId || root.threadId !== agent.threadId) throw new Error('子 Agent 的执行范围已改变');
      let id = 0;
      await this.engine.root.commit(async tx => {
        const state = await tx.doc(WorkspaceDoc); const receipt = state.subagentStopRequests?.[requestId];
        if (!requestId || requestId.length > 100 || /[\x00-\x1f]/.test(requestId) || ['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('子 Agent 停止请求无效');
        if (receipt) { if (receipt.rootId !== rootId || receipt.agentId !== subagentId || receipt.sessionId !== sessionId || receipt.childTurnId !== childTurnId) throw new Error('子 Agent 停止请求 ID 已被使用'); id = receipt.durableId; return; }
        const current = state.tasks.find(task => task.id === rootId); const owned = current?.subagents?.find(agent => agent.id === subagentId && agent.sessionId === sessionId && agent.childTurnId === childTurnId);
        if (!current || !owned || current.executionSessionId !== sessionId || subagentEnded(owned.status) && !(owned.backgroundCommands || owned.unknownCommands) || owned.stop?.status === 'pending') throw new Error('子 Agent 当前不能停止');
        id = await tx.createTask(this.definition, { rootId, agentId: subagentId, sessionId, childTurnId, requestId }, { ownership: { kind: 'conversation' } });
        owned.stop = { requestId, durableId: id, status: 'pending' }; state.subagentStopRequests ??= {}; state.subagentStopRequests[requestId] = { rootId, agentId: subagentId, sessionId, childTurnId, durableId: id }; state.revision++;
      }, context);
      this.engine.harness.resume(); return id;
    }
    const work = root?.nativeBackgroundWork?.find(work => work.taskId === agent?.nativeId && work.transportId === sessionId && work.nativeRunId === agent?.nativeRunId);
    if (!root || root.subagentOrigin || !agent || agent.childTurnId !== childTurnId || !work || root.executionSessionId !== sessionId || root.threadId !== agent.threadId || work.kind !== 'subagent') throw new Error('子 Agent 的原生执行范围已经改变，请刷新后重试');
    return this.engine.nativeBackground.stop(rootId, work.id, sessionId, requestId);
  }
  async update(rootId: string, update: SubagentRuntimeUpdate) {
    const incoming = update.subagent;
    if (incoming.sessionId !== update.sessionId || incoming.threadId !== update.threadId || incoming.childTaskId !== subagentChildId(rootId, incoming.id)
      || incoming.parentSubagentId === incoming.id || update.value?.kind === 'item' && update.value.item.turnId !== incoming.childTurnId) return;
    const read = await this.engine.snapshot(); const snapshot = read.tasks.find(task => task.id === rootId);
    if (!snapshot || snapshot.subagentOrigin || snapshot.agent !== incoming.provider || snapshot.executionSessionId !== update.sessionId || snapshot.threadId !== update.threadId) return;
    const savedIdentity = snapshot.subagents?.find(agent => agent.id === incoming.id && agent.provider === 'codex' && agent.nativeId === incoming.nativeId && agent.threadId === incoming.threadId);
    if (incoming.id !== subagentIdentity(update.sessionId, incoming.nativeId) && !(incoming.provider === 'codex' && (incoming.id === codexSubagentIdentity(update.threadId, incoming.nativeId) || savedIdentity))) return;
    if (update.value?.kind === 'commandOutput') {
      const current = snapshot.subagents?.find(agent => agent.id === incoming.id && agent.childTurnId === incoming.childTurnId && agent.generation === incoming.generation);
      if (current && !subagentEnded(current.status)) this.engine.commandOutputs.append(incoming.childTaskId, update.value.eventId, update.value.delta, incoming.childTurnId, update.value);
      return;
    }
    const ownerId = incoming.eventOwnerSubagentId ? subagentChildId(rootId, incoming.eventOwnerSubagentId) : rootId;
    const original = read.tasks.find(task => task.id === ownerId)?.events.find(event => event.id === incoming.eventId && !event.revertedAt);
    const originals = original ? { events: [original] } : await this.engine.taskHistory.eventItems(ownerId, [incoming.eventId]);
    let captured: { taskId: string; event: TaskEvent; turnId: string } | undefined;
    let outputOwner: { taskId: string; turnId: string } | undefined;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const root = state.tasks.find(task => task.id === rootId);
      if (!root || root.executionSessionId !== update.sessionId || root.threadId !== update.threadId) return;
      const run = root.runs?.find(run => run.id === incoming.runId && !run.revertedAt && !run.executionExcludedAt);
      if (!run) return;
      root.subagents ??= [];
      const old = root.subagents.find(agent => agent.id === incoming.id);
      if (old && (old.provider !== incoming.provider || old.nativeId !== incoming.nativeId || old.threadId !== incoming.threadId)) return;
      const adopting = incoming.provider === 'codex' && old && old.sessionId !== update.sessionId && old.sessionId === update.previousSessionId
        && old.generation === incoming.generation && old.childTurnId === incoming.childTurnId
        && old.runId === incoming.runId && old.turnId === incoming.turnId && old.eventId === incoming.eventId
        && old.parentSubagentId === incoming.parentSubagentId && old.eventOwnerSubagentId === incoming.eventOwnerSubagentId
        && root.runs?.some(run => run.id === old.runId && !run.revertedAt && !run.executionExcludedAt);
      if (update.previousSessionId && !adopting) return;
      if (old && old.sessionId !== update.sessionId && !adopting) return;
      if (old && (old.generation > incoming.generation || old.generation === incoming.generation && old.childTurnId !== incoming.childTurnId
        || subagentEnded(old.status) && !subagentEnded(incoming.status) && old.generation === incoming.generation)) return;
      const related = (agent: TaskSubagent) => agent.sessionId === update.sessionId || incoming.provider === 'codex' && agent.provider === 'codex' && agent.threadId === update.threadId && root.runs?.some(run => run.id === agent.runId && !run.revertedAt && !run.executionExcludedAt);
      const parentAgent = incoming.parentSubagentId && root.subagents.find(agent => agent.id === incoming.parentSubagentId && related(agent));
      if (incoming.parentSubagentId && !parentAgent) return;
      const eventOwner = incoming.eventOwnerSubagentId && root.subagents.find(agent => agent.id === incoming.eventOwnerSubagentId && related(agent));
      if (incoming.eventOwnerSubagentId && !eventOwner) return;
      const at = incoming.startedAt;
      let child = state.tasks.find(task => task.id === incoming.childTaskId);
      if (!child) {
        child = { id: incoming.childTaskId, title: incoming.title || 'Subagent', prompt: incoming.prompt, projectId: root.projectId, cwd: root.cwd,
          agent: root.agent, mode: root.mode, status: childStatus(incoming.status), createdAt: at, updatedAt: incoming.updatedAt,
          durableId: null, threadId: null, turnId: incoming.childTurnId, result: '', error: null, events: [], approvals: [], messages: [],
          artifact: null, lastRequestId: '', canSteer: false, autoSettle: false, unread: false,
          ...(incoming.model || incoming.provider === 'claude' && root.model ? { model: incoming.model ?? root.model } : {}), ...(incoming.reasoningEffort ? { reasoningEffort: incoming.reasoningEffort } : {}),
          subagentOrigin: { rootTaskId: rootId, parentTaskId: parentAgent ? parentAgent.childTaskId : rootId, subagentId: incoming.id, sessionId: update.sessionId, threadId: update.threadId, nativeId: incoming.nativeId, status: incoming.status } };
        state.tasks.push(child);
      }
      if (child.subagentOrigin?.rootTaskId !== rootId || child.subagentOrigin.subagentId !== incoming.id || child.subagentOrigin.nativeId !== incoming.nativeId || child.subagentOrigin.threadId !== update.threadId
        || child.subagentOrigin.sessionId !== update.sessionId && !(adopting && child.subagentOrigin.sessionId === old?.sessionId)) return;
      if (adopting) {
        child.subagentOrigin.sessionId = update.sessionId;
        for (const approval of root.approvals) if (approval.subagentId === incoming.id && approval.state === 'pending') approval.state = 'expired';
      }
      outputOwner = { taskId: child.id, turnId: incoming.childTurnId };
      const { canStop: _canStop, stop: _stop, ...persisted } = incoming; const metadata: TaskSubagent = copy(persisted);
      if (old?.sessionId === metadata.sessionId) {
        if (old.stop && old.childTurnId === metadata.childTurnId) metadata.stop = copy(old.stop);
        if (old.backgroundCommands !== undefined) metadata.backgroundCommands = old.backgroundCommands;
        if (old.unknownCommands !== undefined) metadata.unknownCommands = old.unknownCommands;
      }
      const index = root.subagents.findIndex(agent => agent.id === metadata.id);
      if (index < 0) root.subagents.push(metadata); else root.subagents[index] = metadata;
      child.status = childStatus(metadata.status); child.turnId = metadata.childTurnId; child.updatedAt = metadata.updatedAt;
      child.subagentOrigin.status = metadata.status;
      if (metadata.provider === 'codex') { child.threadId = metadata.nativeId; child.executionSessionId = metadata.sessionId; }
      if (metadata.provider === 'codex' && root.codexHome) child.codexHome = root.codexHome;
      if (metadata.provider === 'codex' && root.executionWorkspace) child.executionWorkspace = copy(root.executionWorkspace);
      if (metadata.model) child.model = metadata.model;
      if (metadata.reasoningEffort) child.reasoningEffort = metadata.reasoningEffort;
      child.messages ??= [];
      if (metadata.prompt && !child.messages.some(message => message.id === metadata.childTurnId + ':prompt')) {
        if (!child.prompt) child.prompt = metadata.prompt;
        const id = metadata.childTurnId + ':prompt';
        child.messages.push({ id, role: 'user', text: metadata.prompt, at, turnId: metadata.childTurnId }); this.engine.taskHistory.messageChanged(child, id);
      }
      if (metadata.result !== undefined) child.result = metadata.result;
      const touched: string[] = [];
      const value = update.value;
      if (value?.kind === 'approval') {
        if (!root.approvals.some(approval => approval.id === value.approval.id)) root.approvals.push({ ...copy(value.approval), subagentId: metadata.id, ownerRunId: metadata.runId });
        reconcileTaskSnooze(root, Date.now());
      }
      if (value?.kind === 'approvalResolved') {
        const approval = root.approvals.find(approval => approval.id === value.id && approval.subagentId === metadata.id);
        if (approval) approval.state = value.expired ? 'expired' : 'answered';
      }
      if (value?.kind === 'output') child.result = value.text;
      if (value?.kind === 'item') {
        const item = projectSubagentEvent(copy(value.item), root.subagents.filter(agent => agent.eventOwnerSubagentId === metadata.id)); delete item.runId;
        const i = child.events.findIndex(event => event.id === item.id);
        if (i < 0) child.events.push(item); else child.events[i] = { ...item, at: child.events[i].at, historyOrder: child.events[i].historyOrder };
        touched.push(item.id); captured = { taskId: child.id, event: item, turnId: metadata.childTurnId };
      }
      if (subagentEnded(metadata.status)) {
        for (const item of child.events) if (metadata.provider !== 'codex' && item.turnId === metadata.childTurnId && item.status === 'running' && !(item.kind === 'command' && item.background)) { item.status = eventStatus(metadata.status); item.completedAt = metadata.completedAt; touched.push(item.id); }
        if (metadata.result) {
          const id = metadata.childTurnId + ':answer'; const answer = { id, role: 'assistant' as const, text: metadata.result, at: metadata.completedAt ?? metadata.updatedAt, turnId: metadata.childTurnId };
          const i = child.messages.findIndex(message => message.id === id);
          if (i < 0) child.messages.push(answer); else child.messages[i] = answer;
          this.engine.taskHistory.messageChanged(child, id);
        }
      }
      const owner = eventOwner ? state.tasks.find(task => task.id === eventOwner.childTaskId) : root;
      if (owner) {
        const original = owner.events.find(event => event.id === metadata.eventId) ?? originals.events.find(event => event.id === metadata.eventId && !event.revertedAt);
        const event: TaskEvent = { ...(original ?? { id: metadata.eventId, at, turnId: metadata.turnId, ...(eventOwner ? {} : { runId: metadata.runId }) }),
          kind: 'subagent', text: metadata.title, status: eventStatus(metadata.status), subagentId: metadata.id,
          detail: metadata.progress ?? metadata.result ?? '', ...(metadata.completedAt ? { completedAt: metadata.completedAt } : {}) };
        const i = owner.events.findIndex(item => item.id === event.id); if (i < 0) owner.events.push(event); else owner.events[i] = event;
        await this.engine.taskHistory.persist(tx, owner, [event.id]);
      }
      await this.engine.taskHistory.persist(tx, child, touched); state.revision++;
    }, context);
    if (outputOwner) this.engine.commandOutputs.own(outputOwner.taskId, outputOwner.turnId);
    if (captured) this.engine.commandOutputs.track(captured.taskId, captured.event, captured.turnId);
  }
  async updateBackground(rootId: string, update: SubagentBackgroundUpdate) {
    const state = await this.engine.snapshot(); const root = state.tasks.find(task => task.id === rootId);
    const agent = root?.subagents?.find(agent => agent.id === update.subagentId && agent.provider === 'codex' && agent.nativeId === update.nativeId && agent.sessionId === update.sessionId);
    const child = state.tasks.find(task => task.id === update.childTaskId && task.subagentOrigin?.subagentId === update.subagentId && task.subagentOrigin?.sessionId === update.sessionId);
    if (!root || !agent || !child || agent.childTaskId !== child.id || root.executionSessionId !== update.sessionId || root.threadId !== update.threadId) return;
    const value = update.value;
    if (value.kind === 'commandOutput') {
      const command = child.backgroundCommands?.find(command => command.id === value.eventId && command.sessionId === update.sessionId && command.turnId === update.nativeTurnId && command.runId === update.childTurnId);
      if (command) this.engine.commandOutputs.appendBackground(child.id, command.id, value.delta, command.runId, command.sessionId); return;
    }
    const event = value.item;
    if (event.kind !== 'command' || !event.itemId || event.turnId !== update.nativeTurnId || event.id !== `codex:${update.nativeTurnId}:${event.itemId}`) return;
    const original = (await this.engine.taskHistory.eventItems(child.id, [event.id])).events.find(item => item.kind === 'command' && !item.revertedAt && item.turnId === update.childTurnId && item.itemId === event.itemId);
    if (!original) return;
    let saved: TaskEvent | undefined;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const root = state.tasks.find(task => task.id === rootId); const own = root?.subagents?.find(agent => agent.id === update.subagentId && agent.sessionId === update.sessionId);
      const child = state.tasks.find(task => task.id === update.childTaskId);
      if (!root || !own || root.executionSessionId !== update.sessionId || !child || child.subagentOrigin?.sessionId !== update.sessionId) return;
      saved = { ...copy(event), at: original.at, turnId: update.childTurnId, ...(original.historyOrder !== undefined ? { historyOrder: original.historyOrder } : {}) }; delete saved.runId;
      const index = child.events.findIndex(item => item.id === event.id); if (index < 0) child.events.push(saved); else child.events[index] = saved;
      child.backgroundCommands ??= [];
      const previous = child.backgroundCommands.find(command => command.id === event.id);
      const command: import('./task-background-commands.js').TaskBackgroundCommand = { id: event.id, sessionId: update.sessionId, threadId: update.nativeId, turnId: update.nativeTurnId, itemId: event.itemId!, runId: update.childTurnId,
        command: event.text, status: update.disconnected ? 'unknown' : update.hostInterrupted ? 'interrupted' : event.status === 'running' ? 'running' : event.status === 'completed' ? 'completed' : event.status === 'failed' ? 'failed' : 'stopped', startedAt: original.at, updatedAt: new Date().toISOString(),
        ...(event.processId ? { processId: event.processId } : {}), ...(event.completedAt ? { completedAt: event.completedAt } : {}), ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}), ...(previous?.stop ? { stop: copy(previous.stop) } : {}) };
      const i = child.backgroundCommands.findIndex(command => command.id === event.id); if (i < 0) child.backgroundCommands.push(command); else child.backgroundCommands[i] = command;
      own.backgroundCommands = child.backgroundCommands.filter(command => command.sessionId === update.sessionId && command.status === 'running').length;
      own.unknownCommands = child.backgroundCommands.filter(command => command.sessionId === update.sessionId && command.status === 'unknown').length;
      await this.engine.taskHistory.persist(tx, child, [event.id]); state.revision++;
    }, context);
    if (saved) { this.engine.commandOutputs.session(child.id, update.sessionId); this.engine.commandOutputs.trackBackground(child.id, saved, update.childTurnId, update.sessionId); }
  }
  private async stopCommands(rootId: string, expected: TaskSubagent, requestId: string, signal: AbortSignal) {
    const state = await this.engine.snapshot(); const root = state.tasks.find(task => task.id === rootId); const agent = root?.subagents?.find(agent => agent.id === expected.id);
    if (!root || root.executionSessionId !== expected.sessionId || agent?.childTurnId !== expected.childTurnId) throw new Error('子线程执行范围已改变');
    const child = state.tasks.find(task => task.id === expected.childTaskId);
    for (const command of child?.backgroundCommands ?? []) if (command.sessionId === expected.sessionId && (command.status === 'running' || command.stop?.status === 'pending')) {
      signal.throwIfAborted(); const key = 'subagent:' + createHash('sha256').update(JSON.stringify([requestId, command.id])).digest('hex');
      const id = command.stop?.status === 'pending' ? command.stop.durableId : await this.engine.backgroundCommands.stop(child!.id, command.id, command.sessionId, key);
      await this.waitControl(id, signal);
      const result = (await this.engine.snapshot()).tasks.find(task => task.id === child!.id)?.backgroundCommands?.find(value => value.id === command.id);
      if (result?.status === 'running' || result?.status === 'unknown') throw new Error('子线程命令停止结果尚未确认');
    }
    if ((await this.engine.snapshot()).tasks.find(task => task.id === expected.childTaskId)?.backgroundCommands?.some(command => command.sessionId === expected.sessionId && command.status === 'unknown')) throw new Error('子线程命令状态尚未确认');
  }
  async recover() {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); let changed = false;
      for (const root of state.tasks) for (const agent of root.subagents ?? []) if (agent.provider === 'codex') {
        const commands = state.tasks.find(task => task.id === agent.childTaskId)?.backgroundCommands?.filter(command => command.sessionId === agent.sessionId) ?? [];
        const running = commands.filter(command => command.status === 'running').length, unknown = commands.filter(command => command.status === 'unknown').length;
        if ((agent.backgroundCommands ?? 0) !== running || (agent.unknownCommands ?? 0) !== unknown) { agent.backgroundCommands = running; agent.unknownCommands = unknown; changed = true; }
      }
      for (const root of state.tasks) for (const agent of root.subagents ?? []) if (['running', 'waiting'].includes(agent.status)) {
        agent.status = 'unknown'; const child = state.tasks.find(task => task.id === agent.childTaskId);
        if (child) { child.status = 'interrupted'; if (child.subagentOrigin) child.subagentOrigin.status = 'unknown'; const touched: string[] = []; for (const item of child.events) if (item.status === 'running') { item.status = 'interrupted'; touched.push(item.id); } await this.engine.taskHistory.persist(tx, child, touched); }
        const owner = agent.eventOwnerSubagentId ? state.tasks.find(task => task.id === subagentChildId(root.id, agent.eventOwnerSubagentId!)) : root;
        if (owner) { const touched: string[] = []; for (const item of owner.events) if (item.subagentId === agent.id && item.status === 'running') { item.status = 'interrupted'; touched.push(item.id); } if (touched.length) await this.engine.taskHistory.persist(tx, owner, touched); }
        changed = true;
      }
      for (const root of state.tasks) for (const approval of root.approvals) if (approval.subagentId && approval.state === 'pending') { approval.state = 'expired'; changed = true; }
      if (changed) state.revision++;
    }, context);
  }
  async interruptSource(rootId: string, sessionId: string, onlyId?: string) {
    const state = await this.engine.snapshot(); const root = state.tasks.find(task => task.id === rootId);
    if (!root || root.executionSessionId !== sessionId) return;
    for (const agent of root.subagents ?? []) if (agent.sessionId === sessionId && (!onlyId || agent.id === onlyId)) {
      const child = state.tasks.find(task => task.id === agent.childTaskId);
      if (!subagentEnded(agent.status)) await this.update(rootId, { kind: 'subagent', sessionId, threadId: agent.threadId,
        subagent: { ...agent, status: 'interrupted', completedAt: new Date().toISOString(), ...(child?.result ? { result: child.result } : {}) } });
      if (agent.provider !== 'codex') continue;
      for (const command of child?.backgroundCommands ?? []) if (command.sessionId === sessionId && ['running', 'unknown'].includes(command.status)) {
        const saved = (await this.engine.taskHistory.eventItems(child!.id, [command.id])).events.find(event => event.id === command.id && !event.revertedAt);
        if (!saved) continue;
        const tail = this.engine.commandOutputs.nativeTail(child!.id, command.id);
        await this.updateBackground(rootId, { kind: 'subagentBackground', sessionId, threadId: agent.threadId, subagentId: agent.id, childTaskId: child!.id, nativeId: agent.nativeId,
          nativeTurnId: command.turnId, childTurnId: command.runId, hostInterrupted: true,
          value: { kind: 'item', item: { ...saved, turnId: command.turnId, status: 'interrupted', completedAt: new Date().toISOString(), ...(tail ? { detail: tail.text, detailTruncated: tail.truncated } : {}) } } });
      }
    }
  }
  async settle(rootId: string, sessionId: string, requestId: string, signal: AbortSignal) {
    const root = (await this.engine.snapshot()).tasks.find(task => task.id === rootId);
    if (!root || root.executionSessionId !== sessionId) throw new Error('子线程执行范围已改变');
    for (const agent of root.subagents ?? []) if (agent.provider === 'codex' && agent.sessionId === sessionId && (!subagentEnded(agent.status) || agent.backgroundCommands || agent.unknownCommands || agent.stop?.status === 'pending')) {
      signal.throwIfAborted();
      const key = 'settle-child:' + createHash('sha256').update(JSON.stringify([requestId, agent.id, agent.childTurnId])).digest('hex');
      const id = agent.stop?.status === 'pending' ? agent.stop.durableId : await this.stop(rootId, agent.id, sessionId, agent.childTurnId, key);
      await this.waitControl(id, signal);
      const ended = (await this.engine.snapshot()).tasks.find(task => task.id === rootId)?.subagents?.find(value => value.id === agent.id);
      if (ended && (ended.stop?.status === 'uncertain' || !subagentEnded(ended.status) || ended.backgroundCommands || ended.unknownCommands)) throw new Error('子线程停止结果尚未确认');
    }
  }
  async stopBeforeDelete(rootId: string) {
    const root = (await this.engine.snapshot()).tasks.find(task => task.id === rootId);
    if (root?.agent === 'codex' && root.executionSessionId) await this.settle(rootId, root.executionSessionId, 'delete:' + rootId, new AbortController().signal);
  }
  private async waitControl(id: number, signal: AbortSignal) {
    let timer: NodeJS.Timeout | undefined; let abort = () => {};
    try {
      await Promise.race([this.engine.harness.waitForTask(id as TaskId, context), new Promise<never>((_, reject) => {
        abort = () => reject(new Error('Subagent Stop aborted')); signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Subagent Stop confirmation timeout')), 10_000); if (signal.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
}
