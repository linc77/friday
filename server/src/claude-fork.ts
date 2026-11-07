import type { ClaudeConnection } from './claude-provider.js';
import type { NativeForkRequest, NativeForkResult } from './types.js';
import { claudeSessionCall } from './claude-session.js';

export async function forkClaude(request: NativeForkRequest, connection: ClaudeConnection): Promise<NativeForkResult> {
  const { task, run, signal } = request;
  if (!task.threadId || !run.nativeHead) throw new Error('所选轮次缺少原生 Claude 消息游标');
  const configured = await connection.runtime(task);
  if (task.claudeHome && task.claudeHome !== configured.home) throw new Error('请恢复这条会话使用的 Claude 配置目录后分叉');
  const source = await claudeSessionCall(configured.home, { action: 'read', sessionId: task.threadId, dir: task.cwd }, signal);
  const index = source.findIndex(message => message.uuid === run.nativeHead && message.parent_tool_use_id == null);
  if (index < 0) throw new Error('Claude 原生历史中找不到所选轮次的消息游标');
  const prefix = source.slice(0, index + 1);
  if (!request.candidateId) {
    if (request.inspectOnly) throw new Error('原生分叉回执丢失，没有可核对的会话 ID；不会重复创建');
    signal.throwIfAborted(); await request.started(); signal.throwIfAborted();
    const result = await claudeSessionCall(configured.home, { action: 'fork', sessionId: task.threadId, dir: task.cwd, upToMessageId: run.nativeHead, title: request.title }, signal);
    if (typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId === task.threadId) throw new Error('Claude 没有返回独立的分叉会话 ID');
    await request.candidate(result.sessionId); request = { ...request, candidateId: result.sessionId };
  }
  const messages = await claudeSessionCall(configured.home, { action: 'read', sessionId: request.candidateId!, dir: task.cwd }, signal);
  if (messages.length !== prefix.length) throw new Error('Claude 分叉后的历史与所选轮次不一致');
  const mapped = Object.fromEntries(prefix.map((message, i) => [message.uuid, messages[i].uuid]));
  if (Object.values(mapped).some(id => typeof id !== 'string' || !id) || new Set(Object.values(mapped)).size !== prefix.length) throw new Error('Claude 分叉后的消息游标无效');
  const remap = (value: unknown): unknown => {
    if (typeof value === 'string') return Object.hasOwn(mapped, value) ? mapped[value] : value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
    return value;
  };
  if (prefix.some((message, i) => message.type !== messages[i]?.type || JSON.stringify(remap(message.message)) !== JSON.stringify(messages[i]?.message))) throw new Error('Claude 分叉后的历史与所选轮次不一致');
  return { threadId: request.candidateId!, turnIds: mapped, headIds: mapped, claudeHome: configured.home };
}
