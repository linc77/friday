import type { Engine } from './engine.js';
import type { QueueMessageInput } from './task-queue.js';

// Compaction is a normal provider run in Friday's existing Durable execution
// lane. Its native session and external-started receipt precede the request;
// uncertain recovery never sends the compaction a second time.
export async function compactTask(engine: Engine, id: string, input: { requestId: string; threadId: string; nextMessage?: QueueMessageInput }) {
  const state = await engine.snapshot(), requestId = 'compact:' + id + ':' + input.requestId;
  if (Object.hasOwn(state.requests, requestId)) {
    if (state.requests[requestId] !== id) throw new Error('压缩请求已被其他任务使用');
    return id;
  }
  const task = state.tasks.find(task => task.id === id);
  if (!task || !['codex', 'claude', 'pi', 'grok', 'cursor', 'muse', 'opencode', 'acp-registry', 'antigravity'].includes(task.agent) || task.subagentOrigin || task.threadId !== input.threadId) throw new Error('原生会话已经改变，请刷新后重试');
  return engine.createTask({ command: 'compact', commandThreadId: input.threadId, prompt: '/compact', continueId: id, projectId: task.projectId,
    ...(input.nextMessage ? { commandMessage: { ...input.nextMessage, requestId: input.requestId } } : {}),
    agent: task.agent as 'codex' | 'claude' | 'pi' | 'grok' | 'cursor' | 'muse' | 'opencode' | 'acp-registry' | 'antigravity', mode: task.mode, interactionMode: task.interactionMode, requestId });
}
