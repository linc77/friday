import { CodexRpc } from './codex-rpc.js';
import type { CodexConnection } from './codex-provider.js';
import type { NativeRewindRequest, NativeRewindResult, NativeRewindStart } from './types.js';
import { realpath } from 'node:fs/promises';

const same = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index]);

export async function rewindCodex(request: NativeRewindRequest, command: string | null, connection?: CodexConnection): Promise<NativeRewindResult> {
  const { task, signal } = request;
  if (!task.threadId) return { state: 'applied', threadId: null, turns: [] };
  const configured = await connection?.runtime(task);
  if (task.codexHome && configured && task.codexHome !== configured.home) throw new Error('此对话使用另一个 Codex 账号目录，请恢复原目录后回退');
  const executable = configured?.command ?? command;
  if (!executable) throw new Error('找不到 Codex，请先检查 Provider 连接');
  signal.throwIfAborted();
  const cwd = await realpath(task.cwd).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || task.executionWorkspace?.mode !== 'worktree') throw error;
    return realpath(task.executionWorkspace.sourcePath);
  });
  const rpc = new CodexRpc(executable, cwd, configured);
  const abort = () => rpc.close(); signal.addEventListener('abort', abort, { once: true });
  rpc.onMessage = message => { if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'Rewind does not execute tools or accept approval requests.' } }); };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'friday', version: '0.1.0', title: 'Friday' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    const metadata = await rpc.call('thread/read', { threadId: task.threadId, includeTurns: false });
    if (metadata.thread?.id !== task.threadId) throw new Error('Codex 返回了不同的会话 ID');
    if (metadata.thread.historyMode !== 'paginated') throw new Error('这个 Codex 会话使用旧历史格式，当前协议无法安全回退；可从保留的历史重新建立会话');
    if (metadata.thread.status?.type === 'active') throw new Error('Codex 会话仍在运行，请先停止后回退');
    const list = async (threadId: string) => {
      const turns: string[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
      do {
        const page = await rpc.call('thread/turns/list', { threadId, limit: 100, sortDirection: 'asc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw new Error('Codex 没有返回完整的轮次列表');
        for (const turn of page.data) {
          if (typeof turn.id !== 'string' || !turn.id || turns.includes(turn.id) || ['inProgress', 'running'].includes(turn.status)) throw new Error('Codex 历史包含重复或运行中的轮次');
          turns.push(turn.id);
        }
        cursor = page.nextCursor ?? null;
        if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 500)) throw new Error('无法完整读取 Codex 历史');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return turns;
    };
    const turns = await list(task.threadId);
    let original: NativeRewindStart;
    if (request.original) {
      original = request.original;
      if (same(turns, original.keep)) return { state: 'applied', threadId: task.threadId, turns };
      if (!same(turns, original.turns)) throw new Error('原生会话历史已改变，无法确认回退结果；请核对或从保留历史建立新会话');
    } else {
      const index = request.targetTurnId ? turns.indexOf(request.targetTurnId) : turns.length;
      if (index < 0 || !same(turns.slice(index), request.removeTurns)) throw new Error('原生会话与任务记录不一致，回退会移除未确认的轮次；请先核对');
      const keep = turns.slice(0, index); const expected = request.keepTurns ?? [];
      if (expected.length ? keep.length < expected.length || !same(keep.slice(-expected.length), expected) : keep.length > 0) throw new Error('原生历史存在任务记录之外的轮次，无法确认回退边界；请核对或建立新会话');
      original = { threadId: task.threadId, turns, keep };
    }
    if (request.inspectOnly) return { state: same(turns, original.keep) ? 'applied' : 'unchanged', threadId: task.threadId, turns };
    if (!request.targetTurnId) return { state: 'applied', threadId: task.threadId, turns };
    if (metadata.thread.status?.type === 'notLoaded') {
      const resumed = await rpc.call('thread/resume', { threadId: task.threadId, excludeTurns: true, cwd, approvalPolicy: 'never', sandbox: 'read-only' });
      if (resumed.thread?.id !== task.threadId) throw new Error('Codex 载入了不同的会话，已停止回退');
    }
    signal.throwIfAborted();
    await request.started(original);
    signal.throwIfAborted();
    const response = await rpc.call('thread/revert', { threadId: task.threadId, beforeTurnId: request.targetTurnId });
    const threadId = response.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex 没有返回回退后的会话 ID');
    await request.candidate(threadId);
    const after = await list(threadId);
    if (!same(after, original.keep)) throw new Error('Codex 回退后的历史尚未确认，请核对后继续');
    return { state: 'applied', threadId, turns: after };
  } finally { signal.removeEventListener('abort', abort); rpc.close(); }
}
