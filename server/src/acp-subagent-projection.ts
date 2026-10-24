import { acpRecord, type AcpRecord } from './acp-process.js';
import { NativeSubagentProjection } from './native-subagent-projection.js';

// Native opt-in and attribution match T3 8cd9641f devinAcp.ts / copilotAcp.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export type AcpSubagentFlavor = 'devin' | 'copilot';
export const registrySubagentCapabilities = (flavor?: AcpSubagentFlavor): AcpRecord | undefined => flavor === 'devin'
  ? { 'cognition.ai/subagentSupport': true, 'cognition.ai/messageGrouping': true }
  : flavor === 'copilot' ? { 'github.com/copilot': { events: ['subagent.started', 'subagent.completed', 'subagent.failed', 'assistant.message_delta', 'assistant.reasoning_delta'] } } : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const contentText = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(contentText).join('') : acpRecord(value)?.type === 'text' ? string(acpRecord(value)?.text) ?? '' : '';

export class AcpSubagentProjection {
  private tools = new Map<string, AcpRecord>();
  private taskByAgentId = new Map<string, string>();
  private delta?: { kind: string; text: string; task?: string };
  constructor(private flavor: AcpSubagentFlavor, private root: string, private children: NativeSubagentProjection) {}
  async notification(method: string, params: AcpRecord): Promise<AcpRecord | undefined> {
    if (method === 'github.com/copilot/sessionEvent' && this.flavor === 'copilot') {
      if (params.sessionId !== this.root) return;
      const data = acpRecord(params.data) ?? {}, task = string(data.parentToolCallId);
      if (['assistant.message_delta', 'assistant.reasoning_delta'].includes(params.type) && typeof data.deltaContent === 'string') this.delta = { kind: params.type, text: data.deltaContent, ...(task ? { task } : {}) };
      else if (params.type === 'subagent.started' && typeof params.agentId === 'string' && typeof data.toolCallId === 'string') this.taskByAgentId.set(params.agentId, data.toolCallId);
      else if (['subagent.completed', 'subagent.failed'].includes(params.type)) {
        if (typeof params.agentId === 'string') this.taskByAgentId.delete(params.agentId);
        if (typeof data.toolCallId === 'string') await this.children.nativeFinish('copilot-task:' + data.toolCallId, params.type === 'subagent.failed' ? 'failed' : 'completed', string(data.error));
      }
      return;
    }
    if (method !== 'session/update') return;
    const update = acpRecord(params.update); if (!update) return;
    let target = params.sessionId;
    const meta = acpRecord(update._meta) ?? {};
    if (this.flavor === 'devin') {
      const context = acpRecord(meta['cognition.ai/subagent_context']);
      if (typeof context?.parentAgentId === 'string' && context.parentAgentId !== 'root') target = context.parentAgentId;
    } else {
      let task: string | undefined;
      if (['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
        const delta = this.delta; this.delta = undefined;
        if (delta?.kind === (update.sessionUpdate === 'agent_message_chunk' ? 'assistant.message_delta' : 'assistant.reasoning_delta') && update.content?.type === 'text' && update.content.text === delta.text) task = delta.task;
      } else { const agentId = acpRecord(meta['github.com/copilot'])?.agentId; if (typeof agentId === 'string') task = this.taskByAgentId.get(agentId); }
      if (task) target = 'copilot-task:' + task;
    }
    if (target !== this.root) {
      if (['agent_message_chunk', 'agent_message_update'].includes(update.sessionUpdate) && this.children.knowsNative(target)) await this.children.nativeMessage(target, contentText(update.content), update.sessionUpdate.endsWith('_update'));
      return;
    }
    if (typeof update.toolCallId === 'string' && ['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const tool = { ...this.tools.get(update.toolCallId), ...update }; this.tools.set(update.toolCallId, tool);
      if (this.flavor === 'devin') {
        const started = acpRecord(acpRecord(tool._meta)?.['cognition.ai/subagent_started']), completed = acpRecord(acpRecord(tool._meta)?.['cognition.ai/subagent_completed']), nativeId = (completed ?? started)?.agentId;
        if (typeof nativeId === 'string') { await this.children.observe({ nativeId, nativeChildId: nativeId, title: string(started?.title), prompt: string(started?.task), model: string(started?.model), status: completed ? completed.success === false ? 'failed' : 'completed' : 'running', ...(typeof completed?.summary === 'string' ? { result: completed.summary, messages: [completed.summary] } : {}) }); return; }
      } else {
        const input = acpRecord(tool.rawInput);
        if (typeof input?.agent_type === 'string' && typeof input.prompt === 'string') {
          const status = tool.status === 'failed' ? 'failed' : tool.status === 'completed' && input.mode !== 'background' ? 'completed' : 'running', output = acpRecord(tool.rawOutput)?.content;
          await this.children.observe({ nativeId: tool.toolCallId, nativeChildId: 'copilot-task:' + tool.toolCallId, prompt: input.prompt, title: string(input.description), model: string(input.model), status, ...(status !== 'running' && typeof output === 'string' ? { result: output, messages: [output] } : {}) });
          return;
        }
      }
    }
    return params;
  }
}
