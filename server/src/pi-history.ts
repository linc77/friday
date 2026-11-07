import { isAbsolute } from 'node:path';
import { piSessionAccount, type PiConnection } from './pi-provider.js';
import { piRecord, type PiRpc, type PiRecord } from './pi-rpc.js';
import type { NativeForkRequest, NativeForkResult, NativeRewindRequest, NativeRewindResult, WorkItem } from './types.js';

/** Pi entries are a tree. Append order includes discarded branches. */
export function piActiveBranch(value: unknown): PiRecord[] {
  const data = piRecord(value);
  if (!Array.isArray(data?.entries) || data.leafId !== null && typeof data.leafId !== 'string') throw new Error('Pi 没有返回可核对的会话树');
  const entries = new Map<string, PiRecord>();
  for (const item of data.entries) {
    const entry = piRecord(item);
    if (!entry || typeof entry.id !== 'string' || !entry.id || entries.has(entry.id) || entry.parentId !== null && typeof entry.parentId !== 'string') throw new Error('Pi 会话树包含无效或重复的条目');
    entries.set(entry.id, entry);
  }
  const result: PiRecord[] = [], visited = new Set<string>();
  let id = data.leafId as string | null;
  while (id !== null) {
    const entry = entries.get(id);
    if (!entry || visited.has(id)) throw new Error('Pi 活动分支不完整或存在循环');
    visited.add(id); result.push(entry); id = entry.parentId;
  }
  return result.reverse();
}
const users = (branch: PiRecord[]) => branch.filter(entry => entry.type === 'message' && entry.message?.role === 'user').map(entry => entry.id as string);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);

export function piReadOnlyArgs(args: string[]) {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (['--extension', '-e', '--tools', '-t', '--exclude-tools', '-xt'].includes(args[index]!)) { index++; continue; }
    if (!/^--(?:extension|tools|exclude-tools)=/.test(args[index]!)) result.push(args[index]!);
  }
  return [...result, '--no-extensions', '--no-tools'];
}

async function historyClient(connection: PiConnection, task: WorkItem, signal: AbortSignal, body: (rpc: PiRpc, launch: (source: string) => PiRpc) => Promise<any>) {
  signal.throwIfAborted();
  const runtime = await connection.runtime(task);
  if (task.piHome && task.piHome !== runtime.home) throw new Error('请恢复这条 Pi 会话使用的配置目录');
  if (task.nativeProviderAccount && task.nativeProviderAccount !== piSessionAccount(runtime.settings)) throw new Error('请恢复这条 Pi 会话使用的账号配置');
  const configured = { ...runtime, args: piReadOnlyArgs(runtime.args) }, clients: PiRpc[] = [];
  const client = (source?: string) => {
    const rpc = connection.client({ ...configured, args: [...configured.args, ...(source ? ['--fork', source] : [])] }, task.cwd, !source);
    rpc.onEvent = event => { if (event.type === 'extension_ui_request' || event.type === 'agent_start') void rpc.close(); };
    clients.push(rpc); return rpc;
  };
  const abort = () => { for (const rpc of clients) void rpc.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); return await body(client(), source => { signal.throwIfAborted(); return client(source); }); }
  finally { signal.removeEventListener('abort', abort); await Promise.all(clients.map(rpc => connection.release(rpc))); }
}
async function load(rpc: PiRpc, id: string) {
  if (!isAbsolute(id)) throw new Error('Pi 会话文件路径无效');
  if ((await rpc.request({ type: 'switch_session', sessionPath: id }))?.cancelled) throw new Error('Pi 取消了会话读取');
  const state = await rpc.request({ type: 'get_state' });
  if (state?.sessionFile !== id || state.isStreaming === true || state.isCompacting === true || (state.pendingMessageCount ?? 0) > 0) throw new Error('Pi 会话身份已改变或仍有原生工作');
  return piActiveBranch(await rpc.request({ type: 'get_entries' }));
}
async function created(rpc: PiRpc, source: string, candidate: (id: string) => Promise<void>) {
  const state = await rpc.request({ type: 'get_state' });
  if (typeof state?.sessionFile !== 'string' || !isAbsolute(state.sessionFile) || state.sessionFile === source) throw new Error('Pi 没有返回独立的原生会话文件；不会重复创建');
  await candidate(state.sessionFile);
  return { id: state.sessionFile as string, branch: piActiveBranch(await rpc.request({ type: 'get_entries' })) };
}

export async function forkPi(connection: PiConnection, request: NativeForkRequest): Promise<NativeForkResult> {
  const source = request.task.threadId;
  if (!source || !request.run.nativeHead) throw new Error('所选 Pi 轮次没有捕获会话树游标；可以从可见历史建立新会话');
  return historyClient(connection, request.task, request.signal, async (rpc, launch) => {
    let id = request.candidateId, branch: PiRecord[];
    if (id) branch = await load(rpc, id);
    else {
      if (request.inspectOnly) throw new Error('Pi 分叉回执丢失，没有可核对的会话文件；不会重复创建');
      const original = await load(rpc, source), end = original.findIndex(entry => entry.id === request.run.nativeHead);
      if (end < 0 || !same(users(original.slice(0, end + 1)), request.expectedTurns)) throw new Error('Pi 活动分支与所选分叉位置不一致');
      const next = original.slice(end + 1).find(entry => entry.type === 'message' && entry.message?.role === 'user');
      await request.verifiedPrefix?.(request.expectedTurns); request.signal.throwIfAborted(); await request.started(); request.signal.throwIfAborted();
      const fork = launch(source);
      if (next && (await fork.request({ type: 'fork', entryId: next.id }))?.cancelled) throw new Error('Pi 取消了会话分叉');
      ({ id, branch } = await created(fork, source, request.candidate));
    }
    if (id === source || !same(users(branch), request.expectedTurns) || !branch.some(entry => entry.id === request.run.nativeHead)) throw new Error('Pi 分叉后的历史边界尚未确认');
    const turnIds = Object.fromEntries(request.expectedTurns.map(value => [value, value]));
    for (const run of request.task.runs ?? []) if (run.turnId && run.nativeTurnIds?.length && run.nativeTurnIds.every(value => request.expectedTurns.includes(value))) turnIds[run.turnId] = run.nativeTurnIds.at(-1)!;
    if (request.run.turnId) turnIds[request.run.turnId] ??= request.expectedTurns.at(-1)!;
    return { threadId: id!, turnIds, headIds: Object.fromEntries(branch.map(entry => [entry.id, entry.id])) };
  });
}

export async function rewindPi(connection: PiConnection, request: NativeRewindRequest): Promise<NativeRewindResult> {
  const source = request.original?.threadId ?? request.task.threadId;
  if (!source) return { state: 'applied', threadId: null, turns: [] };
  return historyClient(connection, request.task, request.signal, async (rpc, launch) => {
    const current = request.task.threadId!, branch = await load(rpc, current), turns = users(branch), keep = request.original?.keep ?? request.keepTurns ?? [];
    if (request.original && current !== source) {
      if (!same(turns, keep)) throw new Error('Pi 回退后的原生分支已改变，请核对');
      return { state: 'applied', threadId: current, turns };
    }
    if (!same(turns, [...keep, ...request.removeTurns]) || request.targetTurnId !== (request.removeTurns[0] ?? null)) throw new Error('Pi 原生历史与已确认的回退边界不一致');
    if (request.inspectOnly) return { state: 'unchanged', threadId: current, turns };
    if (!request.targetTurnId) return { state: 'applied', threadId: current, turns };
    request.signal.throwIfAborted(); await request.started({ threadId: source, turns, keep }); request.signal.throwIfAborted();
    const fork = launch(source);
    if ((await fork.request({ type: 'fork', entryId: request.targetTurnId }))?.cancelled) throw new Error('Pi 取消了原生回退');
    const candidate = await created(fork, source, request.candidate);
    if (!same(users(candidate.branch), keep)) throw new Error('Pi 回退后的历史尚未确认');
    return { state: 'applied', threadId: candidate.id, turns: keep };
  });
}
