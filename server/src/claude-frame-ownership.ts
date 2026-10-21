/*!
 * Echo ownership rules follow pingdotgg/t3code
 * edb21555667dc926bec3f8b2fac41db817b16ae9/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts
 * MIT License
 * Copyright (c) 2026 T3 Tools Inc.
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
export type ClaudeEchoMode = 'unknown' | 'early' | 'result_only' | 'acknowledged';
export function claudeEchoes(message: SDKMessage): string[] {
  const value = message as SDKMessage & { user_message_uuid?: unknown; user_message_uuids?: unknown };
  return Array.isArray(value.user_message_uuids) ? value.user_message_uuids.filter((value): value is string => typeof value === 'string')
    : typeof value.user_message_uuid === 'string' ? [value.user_message_uuid] : [];
}
export function claudeGatedFrame(message: SDKMessage) {
  return message.type === 'result' || (message.type === 'assistant' || message.type === 'user' || message.type === 'stream_event') && !message.parent_tool_use_id;
}
export function claudeForeignResult(message: SDKMessage, prompt: string, mode: ClaudeEchoMode) {
  if (message.type !== 'result') return false;
  const echoed = claudeEchoes(message);
  return echoed.length ? !echoed.includes(prompt) : mode !== 'unknown' && message.origin !== undefined && message.origin.kind !== 'human';
}
