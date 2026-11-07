import type { Message } from '@earendil-works/pi-ai';
import type { EntryRecord, LiveState } from '@earendil-works/pi-durable';
import type { AssistantActivity, AssistantTool, ChatMessage, WorkItem } from './types.js';

export function finishAssistantTranscript(task: WorkItem) {
  delete task.assistantActivity;
  for (const message of task.messages ?? []) {
    delete message.streaming;
    for (const tool of message.tools ?? []) {
      if (['preparing', 'pending', 'running'].includes(tool.status)) tool.status = 'interrupted';
    }
  }
}

export function assistantMessageText(message: Message): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

/** Project only provider-visible text, thinking and tool results, never signatures
 * or private provider metadata. Generation IDs survive the partial/final handoff. */
export function assistantTranscript(entries: readonly EntryRecord[], live?: LiveState) {
  const messages: ChatMessage[] = [];
  const calls = new Map<string, AssistantTool>();
  const append = (message: Message, id: string, streaming = false) => {
    if (message.role === 'toolResult') {
      const tool = calls.get(message.toolCallId);
      if (tool) {
        tool.status = message.isError ? 'failed' : 'completed';
        tool.output = assistantMessageText(message).slice(-8000);
      }
      return;
    }
    if (message.role !== 'user' && message.role !== 'assistant') return;
    const text = assistantMessageText(message).slice(-80_000);
    const thinking = message.role === 'assistant'
      ? message.content.filter(part => part.type === 'thinking').map(part => part.thinking).join('\n').slice(-80_000) : '';
    const tools: AssistantTool[] = message.role === 'assistant'
      ? message.content.filter(part => part.type === 'toolCall').map(part => ({ id: part.id, name: part.name, status: streaming ? 'preparing' : 'pending' })) : [];
    for (const tool of tools) calls.set(tool.id, tool);
    if (text || thinking || tools.length) messages.push({ id, role: message.role, text,
      ...(thinking ? { thinking } : {}), ...(tools.length ? { tools } : {}), ...(streaming ? { streaming: true } : {}) });
  };
  for (const entry of entries) (entry.model ?? []).forEach((message, index) => {
    const id = message.role === 'assistant' && entry.byTaskId !== undefined
      ? `friday-response:${entry.byTaskId}:${message.timestamp}:${index}` : index === 0 ? String(entry.id) : `${entry.id}:${index}`;
    append(message, id);
  });
  if (live?.generation?.message && live.run) {
    const id = `friday-response:${live.run.taskId}:${live.generation.message.timestamp}:0`;
    if (!messages.some(message => message.id === id)) append(live.generation.message as Message, id, true);
  }
  for (const slot of live?.tools ?? []) {
    const tool = calls.get(slot.callId);
    if (!tool || tool.status === 'completed' || tool.status === 'failed') continue;
    tool.status = slot.status === 'done' ? 'completed' : slot.status;
    if (slot.output) tool.output = slot.output.slice(-8000);
  }
  // A stopped run cannot leave its last tool permanently marked as running.
  if (live && !live.run) for (const tool of calls.values()) {
    if (['preparing', 'pending', 'running'].includes(tool.status)) tool.status = 'interrupted';
  }
  let activity: AssistantActivity | undefined;
  if (live?.run) {
    const content = live.generation?.message?.content;
    const last = content?.at(-1);
    const tool = live.tools?.find(tool => tool.status !== 'done');
    const phase = live.compactions?.some(value => value.blocking) ? 'compacting'
      : live.generation?.retry ? 'retrying' : tool ? 'tools'
      : last?.type === 'thinking' ? 'thinking' : last?.type === 'text' ? 'responding'
      : last?.type === 'toolCall' ? 'preparingTool' : 'preparing';
    activity = { phase, round: live.run.turns + 1, ...(tool ? { tool: tool.name } : {}) };
  }
  return { messages, activity };
}
