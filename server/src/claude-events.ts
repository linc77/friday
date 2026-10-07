import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionUpdate, TaskEvent } from './types.js';

/** Translate Claude's partial/full messages into the same persisted timeline as Codex. */
export class ClaudeEvents {
  private items = new Map<string, TaskEvent>();
  private messageId = '';
  private blocks = new Map<number, { id: string; input: string }>();
  result = '';
  constructor(private turnId: string, private update: (value: ExecutionUpdate) => Promise<void>) {}
  private async put(id: string, kind: string, text: string, changes: Partial<TaskEvent> = {}) {
    const previous = this.items.get(id);
    const item: TaskEvent = { id: `claude:${this.turnId}:${id}`, itemId: id, turnId: this.turnId, kind, text,
      at: previous?.at ?? new Date().toISOString(), status: 'running', ...previous, ...changes };
    this.items.set(id, item); await this.update({ kind: 'item', item });
  }
  private async tool(id: string, name: string, input: Record<string, unknown>) {
    const kind = name === 'Bash' ? 'command' : ['Write', 'Edit', 'NotebookEdit'].includes(name) ? 'files' : ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'].includes(name) ? 'search' : 'tool';
    const text = name === 'Bash' ? String(input.command ?? name) : `${name}${input.file_path || input.path ? ': ' + (input.file_path ?? input.path) : ''}`;
    await this.put(id, kind, text, { text, detail: JSON.stringify(input, null, 2).slice(0, 20_000) });
  }
  async start() { await this.put('turn', 'turn', 'Claude', { status: 'running' }); }
  async handle(message: SDKMessage) {
    if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      const event = message.event;
      if (event.type === 'message_start') { this.messageId = event.message.id; this.blocks.clear(); }
      if (event.type === 'content_block_start') {
        const block = event.content_block; const id = block.type === 'tool_use' ? block.id : `${this.messageId}:${event.index}`;
        this.blocks.set(event.index, { id, input: '' });
        if (block.type === 'text') await this.put(id, 'message', block.text, { phase: 'commentary' });
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
      for (const [index, block] of message.message.content.entries()) {
        if (block.type === 'text') {
          await this.put(`${message.message.id}:${index}`, 'message', block.text, { text: block.text, status: 'completed', phase: 'commentary', completedAt: new Date().toISOString() });
        } else if (block.type === 'tool_use') await this.tool(block.id, block.name, block.input as Record<string, unknown>);
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result') {
        const item = this.items.get(block.tool_use_id); if (!item) continue;
        const detail = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        await this.put(block.tool_use_id, item.kind, item.text, { status: block.is_error ? 'failed' : 'completed', detail: detail.slice(0, 20_000), completedAt: new Date().toISOString() });
      }
    }
  }
  async finish(status: 'completed' | 'failed' | 'interrupted', result?: string) {
    const completedAt = new Date().toISOString();
    if (status === 'completed') {
      this.result = result ?? this.result;
      const matching = [...this.items.values()].findLast(item => item.kind === 'message' && item.text === this.result);
      await this.put(matching?.itemId ?? 'result', 'message', this.result, { text: this.result, status: 'completed', phase: 'final_answer', completedAt });
      await this.update({ kind: 'output', text: this.result });
    }
    for (const [id, item] of this.items) if (item.status === 'running') await this.put(id, item.kind, item.text, { status, completedAt, durationMs: Date.parse(completedAt) - Date.parse(item.at) });
  }
}
