import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudeContextUsage, type TaskContextUsage } from './task-context-usage.js';
import type { ExecutionUpdate, TaskEvent } from './types.js';
import { taskPlanSteps } from './task-event-data.js';
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, type TerminalOutputState } from './vendor/t3-terminal-output.js';
import type { ClaudeOutputChunk } from './claude-task-output.js';

/** Translate Claude's partial/full messages into the same persisted timeline as Codex. */
export class ClaudeEvents {
  private items = new Map<string, TaskEvent>();
  private messageId = '';
  private blocks = new Map<number, { id: string; input: string }>();
  private commandTails = new Map<string, TerminalOutputState>();
  private toolNames = new Map<string, string>();
  private contextUsage?: TaskContextUsage;
  result = '';
  constructor(private turnId: string, private update: (value: ExecutionUpdate) => Promise<void>, private messagePhase: 'commentary' | 'final_answer' = 'commentary', private previousUsage?: TaskContextUsage | null) {}
  private async put(id: string, kind: string, text: string, changes: Partial<TaskEvent> = {}) {
    const previous = this.items.get(id);
    const item: TaskEvent = { id: `claude:${this.turnId}:${id}`, itemId: id, turnId: this.turnId, kind, text,
      at: previous?.at ?? new Date().toISOString(), status: 'running', ...previous, ...changes };
    this.items.set(id, item); await this.update({ kind: 'item', item });
  }
  private async tool(id: string, name: string, input: Record<string, unknown>) {
    this.toolNames.set(id, name);
    if (name === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) {
      await this.propose(id, input.plan); return;
    }
    const kind = ['Bash', 'Monitor'].includes(name) ? 'command' : name === 'TodoWrite' ? 'plan' : ['Write', 'Edit', 'NotebookEdit'].includes(name) ? 'files' : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(name) ? 'search' : 'tool';
    const text = kind === 'command' ? String(input.command ?? name) : `${name}${input.file_path || input.path ? ': ' + (input.file_path ?? input.path) : ''}`;
    const plan = kind === 'plan' && Array.isArray(input.todos) ? taskPlanSteps(input.todos.map(value => ({
      step: value.content, status: value.status === 'in_progress' ? 'inProgress' : value.status,
    }))) : undefined;
    const commandActions: TaskEvent['commandActions'] = name === 'Read' ? [{ type: 'read', command: name, path: String(input.file_path ?? ''), name: String(input.file_path ?? '') }]
      : ['Grep', 'Glob'].includes(name) ? [{ type: name === 'Glob' ? 'listFiles' : 'search', command: name, path: String(input.path ?? ''), query: String(input.pattern ?? '') }] : undefined;
    await this.put(id, kind, text, { text, ...(kind === 'command' ? {} : { detail: JSON.stringify(input, null, 2) }), ...(plan ? { plan } : {}), ...(commandActions ? { commandActions } : {}) });
  }
  isCommand(id: string) { const item = this.items.get(id); return item?.kind === 'command' && item.status === 'running'; }
  async commandOutput(id: string, chunk: ClaudeOutputChunk) {
    const item = this.items.get(id); if (!item || !this.isCommand(id)) return;
    const tail = appendTerminalOutput(chunk.reset ? EMPTY_TERMINAL_OUTPUT : this.commandTails.get(id) ?? EMPTY_TERMINAL_OUTPUT, chunk.text);
    this.commandTails.set(id, chunk.truncated ? { ...tail, truncated: true } : tail);
    await this.update({ kind: 'commandOutput', eventId: item.id, delta: chunk.text, ...(chunk.reset ? { reset: true } : {}), ...(chunk.truncated ? { truncated: true } : {}) });
  }
  async propose(id: string, markdown: string) {
    await this.put(id, 'proposal', markdown.trim(), { text: markdown.trim(), status: 'completed', completedAt: new Date().toISOString() });
  }
  async start() { await this.put('turn', 'turn', 'Claude', { status: 'running' }); }
  async handle(message: SDKMessage) {
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === 'message_start') { this.messageId = event.message.id; this.blocks.clear(); }
      if (event.type === 'content_block_start') {
        const block = event.content_block; const id = block.type === 'tool_use' ? block.id : `${this.messageId}:${event.index}`;
        this.blocks.set(event.index, { id, input: '' });
        if (block.type === 'text') await this.put(id, 'message', block.text, { phase: this.messagePhase });
        if (block.type === 'tool_use') await this.tool(id, block.name, block.input as Record<string, unknown>);
      }
      if (event.type === 'content_block_delta') {
        const block = this.blocks.get(event.index); if (!block) return;
        const item = this.items.get(block.id); const delta = event.delta;
        if (delta.type === 'text_delta') {
          const text = (item?.text ?? '') + delta.text;
          await this.put(block.id, 'message', text, { text });
          this.result = text; await this.update({ kind: 'output', text });
        } else if (delta.type === 'input_json_delta') block.input += delta.partial_json;
      }
    } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
      if (message.message.model !== '<synthetic>') {
        const previous = this.contextUsage ?? this.previousUsage;
        const usage = claudeContextUsage(message.message.usage, message.message.model, previous && previous.model === message.message.model ? previous.maxTokens : undefined);
        if (usage) { this.contextUsage = usage; await this.update({ kind: 'contextUsage', usage }); }
      }
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === 'text') {
          await this.put(`${message.message.id}:${index}`, 'message', block.text, { text: block.text, status: 'completed', phase: this.messagePhase, completedAt: new Date().toISOString() });
        } else if (block.type === 'tool_use') await this.tool(block.id, block.name, block.input as Record<string, unknown>);
      }
    } else if (message.type === 'result' && this.contextUsage) {
      const modelUsage = this.contextUsage.model ? message.modelUsage?.[this.contextUsage.model] : undefined;
      if (modelUsage && Number.isFinite(modelUsage.contextWindow) && modelUsage.contextWindow > 0) {
        this.contextUsage = { ...this.contextUsage, maxTokens: modelUsage.contextWindow, updatedAt: new Date().toISOString() };
        await this.update({ kind: 'contextUsage', usage: this.contextUsage });
      }
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const previous = this.contextUsage ?? this.previousUsage;
      const post = message.compact_metadata?.post_tokens, pre = message.compact_metadata?.pre_tokens;
      this.contextUsage = typeof post === 'number' && Number.isFinite(post) && post > 0
        ? { usedTokens: Math.round(post), maxTokens: previous?.maxTokens ?? null, updatedAt: new Date().toISOString(), ...(previous?.model ? { model: previous.model } : {}) } : undefined;
      await this.update({ kind: 'contextUsage', usage: this.contextUsage ?? null });
      const counts = [pre, post].filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0).map(value => Math.round(value!));
      await this.put(message.uuid ?? 'compact', 'compaction', '上下文压缩完成', { status: 'completed', completedAt: new Date().toISOString(), ...(counts.length ? { detail: counts.join(' → ') + ' Token' } : {}) });
    } else if (message.type === 'user' && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result') {
        const item = this.items.get(block.tool_use_id); if (!item) continue;
        if (item.kind === 'proposal') continue; // ExitPlanMode is deliberately denied after capturing its plan.
        const structured = message.tool_use_result && typeof message.tool_use_result === 'object' && !Array.isArray(message.tool_use_result) ? message.tool_use_result as Record<string, unknown> : undefined;
        const nativeTask = this.toolNames.get(block.tool_use_id) === 'Monitor' ? structured?.taskId : structured?.backgroundTaskId;
        if (item.kind === 'command' && !block.is_error && typeof nativeTask === 'string' && nativeTask) {
          const tail = this.commandTails.get(block.tool_use_id);
          await this.put(block.tool_use_id, item.kind, item.text, { background: true, status: 'running', ...(tail ? { detail: tail.text, detailTruncated: tail.truncated } : {}) }); continue;
        }
        const detail = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
          ? block.content.flatMap(value => value.type === 'text' && typeof value.text === 'string' ? [value.text] : []).join('\n') : '';
        this.commandTails.delete(block.tool_use_id);
        await this.put(block.tool_use_id, item.kind, item.text, { status: block.is_error ? 'failed' : 'completed', detail, completedAt: new Date().toISOString() });
      }
    }
  }
  async finish(status: 'completed' | 'failed' | 'interrupted', result?: string, retainCommands: ReadonlySet<string> = new Set()) {
    const completedAt = new Date().toISOString();
    if (status === 'completed' && (result ?? this.result).trim()) {
      this.result = result ?? this.result;
      const matching = [...this.items.values()].findLast(item => item.kind === 'message' && item.text === this.result);
      await this.put(matching?.itemId ?? 'result', 'message', this.result, { text: this.result, status: 'completed', phase: 'final_answer', completedAt });
      await this.update({ kind: 'output', text: this.result });
    }
    for (const [id, item] of this.items) if (item.status === 'running') {
      const tail = this.commandTails.get(id);
      if (item.kind === 'command' && retainCommands.has(id)) {
        await this.put(id, item.kind, item.text, { background: true, ...(tail ? { detail: tail.text, detailTruncated: tail.truncated } : {}) }); continue;
      }
      await this.put(id, item.kind, item.text, { status: status === 'completed' && item.kind === 'command' ? 'interrupted' : status,
        ...(tail ? { detail: tail.text, detailTruncated: tail.truncated } : {}), completedAt, durationMs: Date.parse(completedAt) - Date.parse(item.at) });
    }
    for (const id of this.commandTails.keys()) if (!retainCommands.has(id)) this.commandTails.delete(id);
  }
}
