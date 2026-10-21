import { createHash } from 'node:crypto';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionUpdate } from './types.js';
import type { NativeObservedUpdate } from './native-runtime-types.js';
import { subagentChildId, subagentEnded, subagentIdentity, type TaskSubagent } from './task-subagent-types.js';
import { ClaudeEvents } from './claude-events.js';
import { ClaudeTaskOutputReaders } from './claude-task-output.js';

type Origin = { runId: string; turnId: string; eventId?: string; parentSubagentId?: string };
type Launch = { origin: Origin; prompt: string; title: string; model?: string; effort?: string };
type Agent = { state: TaskSubagent; launchId?: string; transcript: ClaudeEvents; outputs: ClaudeTaskOutputReaders; lastText: string };
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
const text = (value: unknown, max = Infinity) => typeof value === 'string' ? value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
const stamp = () => new Date().toISOString();

/** Projects actual SDK task lifecycle and parent_tool_use_id frames. Pending
 * child frames are bounded; a tool's prose is never an execution receipt. */
export class ClaudeSubagents {
  private launches = new Map<string, Launch>();
  private agents = new Map<string, Agent>();
  private byLaunch = new Map<string, Agent>();
  private toolOwners = new Map<string, Agent>();
  private taskOwners = new Map<string, Agent>();
  private permissions = new Map<string, { agentId?: string }>();
  private plans = new Map<string, { agentId?: string; markdown: string }>();
  private pending = new Map<string, SDKMessage[]>();
  private seen = new Set<string>();
  private accepting = true;
  constructor(private readonly scope: { taskId: string; threadId: string; sessionId: string; outputRoot?: string; model?: string; effort?: string }, private readonly send: (value: ExecutionUpdate) => Promise<void>) {}
  active() { return [...this.agents.values()].some(agent => ['running', 'waiting'].includes(agent.state.status)); }
  ignoreFrames() { this.accepting = false; }
  ownsTool(tool: string) { return this.toolOwners.has(tool); }
  async permission(tool: string, waiting: boolean, agentId?: string) {
    if (waiting) this.permissions.set(tool, { agentId }); else this.permissions.delete(tool);
    const agent = this.toolOwners.get(tool) ?? (agentId ? this.agents.get(agentId) : undefined);
    if (!agent || !['running', 'waiting'].includes(agent.state.status)) return;
    this.toolOwners.set(tool, agent);
    const blocked = [...this.permissions].some(([id, value]) => value.agentId === agent.state.nativeId || this.toolOwners.get(id) === agent);
    const status = blocked ? 'waiting' : 'running';
    if (agent.state.status !== status) { agent.state.status = status; await this.emit(agent); }
  }
  async propose(tool: string, markdown: string, agentId?: string) {
    if (!this.accepting) return;
    const agent = this.toolOwners.get(tool) ?? (agentId ? this.agents.get(agentId) : undefined);
    if (agent) await agent.transcript.propose(tool, markdown); else this.plans.set(tool, { agentId, markdown });
  }
  private async associate(tool: string, agent: Agent) {
    this.toolOwners.set(tool, agent);
    if (this.permissions.has(tool)) await this.permission(tool, true, this.permissions.get(tool)?.agentId);
    const plan = this.plans.get(tool); if (plan) { this.plans.delete(tool); await agent.transcript.propose(tool, plan.markdown); }
  }
  async routeToolOutput(message: SDKMessage) {
    const value = message as any;
    if (value.type !== 'system' || !id(value.task_id)) return;
    const owner = id(value.tool_use_id) ? this.toolOwners.get(value.tool_use_id) : this.taskOwners.get(value.task_id);
    if (!owner || subagentEnded(owner.state.status) || owner.state.status === 'unknown') return;
    this.taskOwners.set(value.task_id, owner);
    await owner.outputs.handle(message);
  }
  private async emit(agent: Agent, value?: NativeObservedUpdate) {
    if (value?.kind !== 'commandOutput') agent.state.updatedAt = stamp();
    await this.send({ kind: 'subagent', sessionId: this.scope.sessionId, threadId: this.scope.threadId, subagent: { ...agent.state }, ...(value ? { value } : {}) });
  }
  private async register(message: SDKMessage, origin: Origin) {
    const value = message as any;
    const blocks = value.type === 'assistant' ? value.message?.content : value.type === 'stream_event' && value.event?.type === 'content_block_start' ? [value.event.content_block] : [];
    for (const block of Array.isArray(blocks) ? blocks : []) if (block.type === 'tool_use' && ['Agent', 'Task', 'SendMessage'].includes(block.name) && id(block.id)) {
      const input = object(block.input) ?? {}; const previous = this.launches.get(block.id);
      const launch: Launch = { origin: { ...origin, eventId: `claude:${origin.turnId}:${block.id}` }, prompt: text(input.prompt ?? input.message ?? input.content) || previous?.prompt || '', title: text(input.description, 512) || previous?.title || 'Subagent',
        ...(typeof input.model === 'string' && input.model !== 'inherit' ? { model: text(input.model, 512) } : previous?.model ? { model: previous.model } : {}),
        ...(typeof input.effort === 'string' ? { effort: text(input.effort, 32) } : previous?.effort ? { effort: previous.effort } : {}) };
      this.launches.set(block.id, launch);
      const agent = this.byLaunch.get(block.id);
      if (agent?.state.generation === 0 && !agent.state.prompt && launch.prompt) { agent.state.prompt = launch.prompt; await this.emit(agent); }
    }
  }
  async handle(message: SDKMessage, origin?: Origin): Promise<boolean> {
    const value = message as any;
    if (value.session_id && value.session_id !== this.scope.threadId || value.isReplay === true) return Boolean(value.parent_tool_use_id);
    const parent = value.parent_tool_use_id;
    if (id(parent)) {
      const agent = this.byLaunch.get(parent);
      if (agent) await this.frame(agent, message);
      else {
        const frames = this.pending.get(parent) ?? [];
        // Match T3's bounded early-frame staging, including an overall byte
        // ceiling so a lost lifecycle cannot retain arbitrary child output.
        if (frames.length < 128 && JSON.stringify([...frames, message]).length <= 1_048_576) { frames.push(message); this.pending.set(parent, frames); }
        if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
      }
      return true;
    }
    if (origin && ['assistant', 'stream_event'].includes(value.type)) await this.register(message, origin);
    if (value.type !== 'system' || !id(value.uuid) || this.seen.has(value.uuid) || !id(value.task_id)) return false;
    if (!['task_started', 'task_progress', 'task_notification'].includes(value.subtype) || value.run_id !== undefined && !id(value.run_id)) return false;
    let agent = this.agents.get(value.task_id);
    const launch = id(value.tool_use_id) ? this.launches.get(value.tool_use_id) : undefined;
    if (value.subtype === 'task_started') {
      if (value.ambient === true || value.skip_transcript === true || value.task_type && value.task_type !== 'local_agent') return false;
      if (!agent && !launch && value.task_type !== 'local_agent') return false;
      const owner = launch?.origin ?? origin;
      if (!owner) return false;
      if (agent?.state.nativeRunId !== undefined && (value.run_id === undefined || value.run_id < agent.state.nativeRunId)) return false;
      const resumed = agent && (agent.state.nativeRunId !== value.run_id || subagentEnded(agent.state.status) && id(value.tool_use_id) && value.tool_use_id !== agent.state.toolUseId);
      if (agent && subagentEnded(agent.state.status) && !resumed) return false;
      if (!agent || resumed) {
        const generation = agent ? agent.state.generation + 1 : 0;
        const identity = subagentIdentity(this.scope.sessionId, value.task_id); const at = stamp();
        const childTurnId = 'subagent-turn:' + createHash('sha256').update(JSON.stringify([identity, value.run_id ?? generation])).digest('hex');
        const ownerAgent = owner.parentSubagentId ? [...this.agents.values()].find(agent => agent.state.id === owner.parentSubagentId) : undefined;
        const parentId = agent ? agent.state.parentSubagentId : id(value.parent_task_id) ? this.agents.get(value.parent_task_id)?.state.id ?? owner.parentSubagentId : owner.parentSubagentId;
        const state: TaskSubagent = { id: identity, provider: 'claude', nativeId: value.task_id, sessionId: this.scope.sessionId, threadId: this.scope.threadId,
          runId: owner.runId, turnId: owner.turnId, eventId: owner.eventId ?? 'subagent-event:' + childTurnId, childTaskId: subagentChildId(this.scope.taskId, identity),
          ...(value.run_id ? { nativeRunId: value.run_id } : {}), generation, childTurnId,
          ...(id(value.tool_use_id) ? { toolUseId: value.tool_use_id } : {}), ...(parentId ? { parentSubagentId: parentId } : {}), ...(owner.parentSubagentId ? { eventOwnerSubagentId: owner.parentSubagentId } : {}),
          title: text(value.description, 512) || agent?.state.title || launch?.title || 'Subagent', prompt: text(value.prompt) || launch?.prompt || '',
          model: launch?.model ?? agent?.state.model ?? ownerAgent?.state.model ?? this.scope.model, reasoningEffort: launch?.effort ?? agent?.state.reasoningEffort ?? ownerAgent?.state.reasoningEffort,
          status: 'running', startedAt: at, updatedAt: at };
        const next = { state, launchId: agent?.launchId ?? (id(value.tool_use_id) ? value.tool_use_id : undefined), lastText: '', transcript: undefined!, outputs: undefined! } as Agent;
        next.transcript = new ClaudeEvents(childTurnId, async update => {
          if (update.kind === 'output') next.lastText = update.text;
          if (['item', 'output', 'commandOutput'].includes(update.kind)) await this.emit(next, update as NativeObservedUpdate);
        }, 'final_answer');
        next.outputs = new ClaudeTaskOutputReaders({ root: this.scope.outputRoot, sessionId: this.scope.threadId, parentTaskId: state.nativeId, isCommand: tool => next.transcript.isCommand(tool), onChunk: (tool, chunk) => next.transcript.commandOutput(tool, chunk) });
        if (agent) { await agent.outputs.close(); await agent.transcript.finish('interrupted'); }
        agent = next; this.agents.set(value.task_id, agent);
        if (agent.launchId) this.byLaunch.set(agent.launchId, agent);
        await this.emit(agent); await agent.transcript.start();
        for (const [tool, pending] of [...this.permissions, ...this.plans]) if (pending.agentId === state.nativeId) await this.associate(tool, agent);
      } else {
        if (value.prompt) agent.state.prompt = text(value.prompt);
        await this.emit(agent);
      }
      this.seen.add(value.uuid);
      if (agent.launchId) { const frames = this.pending.get(agent.launchId) ?? []; this.pending.delete(agent.launchId); for (const frame of frames) await this.frame(agent, frame); }
    } else if (agent) {
      if (agent.state.nativeRunId !== undefined && value.run_id !== agent.state.nativeRunId || subagentEnded(agent.state.status)) return false;
      this.seen.add(value.uuid);
      if (value.subtype === 'task_progress') { agent.state.progress = text(value.summary || value.description, 4_000); await this.emit(agent); }
      else if (['completed', 'failed', 'stopped'].includes(value.status)) await this.finish(agent, value.status === 'stopped' ? 'cancelled' : value.status, text(value.summary));
    }
    return false;
  }
  private async frame(agent: Agent, message: SDKMessage) {
    if (!this.accepting || subagentEnded(agent.state.status) || agent.state.status === 'unknown') return;
    const value = message as any;
    if (value.run_id !== undefined && value.run_id !== agent.state.nativeRunId) return;
    const scoped = { ...message, parent_tool_use_id: null } as SDKMessage;
    const blocks = value.type === 'assistant' ? value.message?.content : value.type === 'stream_event' && value.event?.type === 'content_block_start' ? [value.event.content_block] : [];
    for (const block of Array.isArray(blocks) ? blocks : []) if (block.type === 'tool_use' && id(block.id)) await this.associate(block.id, agent);
    await this.register(scoped, { runId: agent.state.runId, turnId: agent.state.childTurnId, parentSubagentId: agent.state.id });
    if (message.type === 'system') await this.handle(scoped, { runId: agent.state.runId, turnId: agent.state.childTurnId, parentSubagentId: agent.state.id });
    await agent.outputs.handle(scoped); await agent.transcript.handle(scoped);
    if (message.type === 'assistant') {
      if (message.message.model && message.message.model !== '<synthetic>') agent.state.model = message.message.model;
      const prose = message.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n\n');
      if (prose) { agent.lastText = prose; await this.emit(agent, { kind: 'output', text: prose }); }
    }
  }
  private async finish(agent: Agent, status: TaskSubagent['status'], summary?: string) {
    await agent.outputs.close();
    const result = agent.lastText || summary || '';
    await agent.transcript.finish(status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'interrupted', status === 'completed' ? result : undefined);
    agent.state.status = status; agent.state.result = result; agent.state.completedAt = stamp(); await this.emit(agent);
  }
  async close(interrupted = false) {
    this.accepting = false;
    for (const agent of this.agents.values()) if (!subagentEnded(agent.state.status) && agent.state.status !== 'unknown') await this.finish(agent, interrupted ? 'interrupted' : 'unknown');
    this.pending.clear();
    this.permissions.clear(); this.plans.clear();
  }
}
