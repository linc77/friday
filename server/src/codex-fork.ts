import { realpath } from 'node:fs/promises';
import { CodexRpc } from './codex-rpc.js';
import type { CodexConnection } from './codex-provider.js';
import type { NativeForkRequest, NativeForkResult } from './types.js';

const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

/** Branch stored history only. No turn/start, tool execution, or source revert. */
export async function forkCodex(request: NativeForkRequest, command: string | null, connection?: CodexConnection): Promise<NativeForkResult> {
  const { task, run, signal } = request;
  if (!task.threadId || !run.turnId) throw new Error('所选轮次缺少原生 Codex 历史边界');
  const configured = await connection?.runtime(task);
  if (task.codexHome && configured && task.codexHome !== configured.home) throw new Error('请恢复这条会话使用的 Codex 账号目录后分叉');
  const executable = configured?.command ?? command;
  if (!executable) throw new Error('找不到 Codex，请先检查 Provider 连接');
  signal.throwIfAborted();
  const cwd = await realpath(task.cwd).catch(async error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || task.executionWorkspace?.mode !== 'worktree') throw error;
    return realpath(task.executionWorkspace.sourcePath);
  });
  const rpc = new CodexRpc(executable, cwd, configured);
  const abort = () => rpc.close(); signal.addEventListener('abort', abort, { once: true });
  rpc.onMessage = message => {
    if (message.id !== undefined && message.method) rpc.send({ id: message.id, error: { code: -32601, message: 'Forking stored history does not authorize tools or approvals.' } });
  };
  const read = async (id: string) => {
    const result = await rpc.call('thread/read', { threadId: id, includeTurns: false });
    if (result.thread?.id !== id) throw new Error('Codex 返回了不同的会话 ID');
    return result.thread;
  };
  const list = async (id: string, metadata: any) => {
    if (metadata.historyMode === 'legacy') {
      const result = await rpc.call('thread/read', { threadId: id, includeTurns: true });
      if (result.thread?.id !== id || !Array.isArray(result.thread.turns)) throw new Error('无法读取旧格式的 Codex 历史');
      return result.thread.turns as { id: string; status: string }[];
    }
    const turns: { id: string; status: string }[] = []; const cursors = new Set<string>(); let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page = await rpc.call('thread/turns/list', { threadId: id, limit: 100, sortDirection: 'asc', itemsView: 'summary', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Codex 没有返回完整的轮次列表');
      turns.push(...page.data);
      cursor = page.nextCursor ?? null;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 500)) throw new Error('无法完整读取 Codex 分叉边界');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return turns;
  };
  const validate = (turns: { id: string; status: string }[], whole: boolean) => {
    const partial = ['failed', 'cancelled', 'interrupted'].includes(run.status ?? '');
    const ids = turns.map(turn => turn.id);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Codex 历史包含无效或重复的轮次');
    const end = ids.indexOf(run.turnId!);
    const prefix = ids.slice(0, end + 1);
    if (request.prefixMode === 'observed') {
      let observed = 0;
      for (const id of prefix) if (id === request.expectedTurns[observed]) observed++;
      if (end < 0 || observed !== request.expectedTurns.length || request.expectedTurns.at(-1) !== run.turnId
        || whole && (!request.nativePrefix || !same(prefix, request.nativePrefix))) throw new Error('Codex 原生历史与所选子对话位置不一致');
      if (!partial && ['inProgress', 'running'].includes(turns[end].status)) throw new Error('所选 Codex 轮次仍在执行');
    } else {
      if (end < 0 || !same(prefix, request.expectedTurns)) throw new Error('Codex 原生历史与所选分叉位置不一致');
      if (turns.slice(0, end + 1).some((turn, index) => ['inProgress', 'running'].includes(turn.status) && !(partial && index === end))) throw new Error('所选 Codex 轮次仍在执行');
    }
    if (whole && end !== ids.length - 1) throw new Error('Codex 分叉包含所选位置之后的历史');
    return prefix;
  };
  try {
    await rpc.call('initialize', { clientInfo: { name: 'friday', title: 'Friday', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    rpc.send({ method: 'initialized' });
    if (!request.candidateId) {
      if (request.inspectOnly) throw new Error('原生分叉回执丢失，没有可核对的会话 ID；不会重复创建');
      const source = await read(task.threadId); const nativePrefix = validate(await list(task.threadId, source), false);
      await request.verifiedPrefix?.(nativePrefix); request = { ...request, nativePrefix };
      signal.throwIfAborted(); await request.started(); signal.throwIfAborted();
      const response = await rpc.call('thread/fork', { threadId: task.threadId, lastTurnId: run.turnId, cwd: task.cwd, approvalPolicy: 'never', sandbox: 'read-only', excludeTurns: true, deferGoalContinuation: true });
      const id = response.thread?.id;
      if (typeof id !== 'string' || !id || id === task.threadId) throw new Error('Codex 没有返回独立的分叉会话 ID');
      await request.candidate(id); request = { ...request, candidateId: id };
    }
    const forked = await read(request.candidateId!);
    if (forked.forkedFromId != null && forked.forkedFromId !== task.threadId) throw new Error('Codex 分叉来源与原会话不一致');
    const ids = validate(await list(request.candidateId!, forked), true);
    return { threadId: request.candidateId!, turnIds: Object.fromEntries(ids.map(id => [id, id])), headIds: {}, ...(configured ? { codexHome: configured.home } : {}) };
  } finally { signal.removeEventListener('abort', abort); rpc.close(); }
}
