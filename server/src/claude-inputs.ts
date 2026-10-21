import { readFile } from 'node:fs/promises';
import type { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionImage } from './types.js';

export class ClaudePromptQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  push(message: SDKUserMessage) { if (this.ended) throw new Error('任务已结束'); this.messages.push(message); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      if (this.messages.length) yield this.messages.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
export async function claudeUserMessage(sessionId: string, text: string, uuid: ReturnType<typeof randomUUID>, images: ExecutionImage[] = [], lastText?: { leadingText?: string; commandText: string }): Promise<SDKUserMessage> {
  const content: SDKUserMessage['message']['content'] = images.length ? [
    { type: 'text', text },
    ...await Promise.all(images.map(async image => ({ type: 'image' as const, source: { type: 'base64' as const,
      media_type: image.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: (await readFile(image.path)).toString('base64') } }))),
  ] : text;
  const dispatched = lastText ? [
    ...(lastText.leadingText ? [{ type: 'text' as const, text: lastText.leadingText }] : []),
    ...(Array.isArray(content) ? content.filter(value => value.type !== 'text') : []),
    { type: 'text' as const, text: lastText.commandText },
  ] : content;
  return { type: 'user', session_id: sessionId, uuid, parent_tool_use_id: null, message: { role: 'user', content: dispatched } };
}
