import type { OpenCodeConnection } from './opencode-provider.js';
import type { OpenCodeServer } from './opencode-server.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import type { NativeForkRequest, NativeForkResult, NativeRewindRequest, NativeRewindResult, WorkItem, TaskEvent } from './types.js';
import type { CodexHistorySnapshot, CodexHistoryTurn } from './codex-history.js';

// History semantics follow the pinned T3 v1/v2 adapters. Rewind never asks
// OpenCode to restore files: Friday's existing checkpoint phase owns that.
type Message = { id: string; role: string; content: unknown; info: AcpRecord };
const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, index) => id === b[index]);
function unwrap(value: unknown): any {
  const result = acpRecord(value);
  if (!result || result.error) throw new Error('OpenCode 原生历史请求失败');
  return result.data ?? result;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'sessionID', 'messageID', 'parentID', 'time', 'timestamp'].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
  return value;
}
const signature = (message: Message) => JSON.stringify([message.role, canonical(message.content)]);
const prompts = (messages: Message[]) => messages.filter(message => ['user', 'synthetic'].includes(message.role)).map(message => message.id);
async function messages(server: OpenCodeServer, id: string, signal: AbortSignal): Promise<Message[]> {
  const values: AcpRecord[] = [];
  if (server.v2) {
    const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const page = await server.v2.message.list({ sessionID: id, order: 'asc', limit: 100, ...(cursor ? { cursor } : {}) }, { signal });
      if (!Array.isArray(page.data)) throw new Error('OpenCode 没有返回原生消息列表');
      values.push(...page.data); cursor = page.cursor?.next ?? undefined;
      if (cursor && (cursors.has(cursor) || cursors.size >= 500)) throw new Error('OpenCode 历史分页未完成');
      if (cursor) cursors.add(cursor);
    } while (cursor);
  } else {
    const data = unwrap(await server.v1!.session.messages({ sessionID: id }, { signal }));
    if (!Array.isArray(data)) throw new Error('OpenCode 没有返回原生消息列表');
    values.push(...data);
  }
  const seen = new Set<string>();
  return values.map(value => {
    const info = server.v2 ? value : value.info, role = server.v2 ? info?.type : info?.role;
    if (typeof info?.id !== 'string' || !info.id || seen.has(info.id) || typeof role !== 'string') throw new Error('OpenCode 历史包含无效或重复消息');
    seen.add(info.id); return { id: info.id, role, content: server.v2 ? info.text ?? info.content ?? info.payload ?? null : value.parts ?? [], info };
  });
}
async function quiet(server: OpenCodeServer, id: string, signal: AbortSignal) {
  const session = server.v2 ? await server.v2.session.get({ sessionID: id }, { signal }) : unwrap(await server.v1!.session.get({ sessionID: id }, { signal }));
  if (session.id !== id) throw new Error('OpenCode 返回了不同的会话 ID');
  if (session.revert) throw new Error('OpenCode 仍有待确认的原生回退，请先核对');
  const active = server.v2 ? await server.v2.session.active({ signal }) : unwrap(await server.v1!.session.status({}, { signal }));
  if (server.v2 ? Object.hasOwn(active, id) : active[id] && active[id].type !== 'idle') throw new Error('OpenCode 会话仍有原生工作');
}
async function withHistory<T>(connection: OpenCodeConnection, task: WorkItem, signal: AbortSignal, body: (server: OpenCodeServer) => Promise<T>): Promise<T> {
  signal.throwIfAborted(); const runtime = await connection.runtime(task);
  if (task.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 OpenCode 会话使用的账号配置');
  const lease = await connection.server(runtime.settings, task.cwd, task.id);
  try { signal.throwIfAborted(); return await body(lease.server); } finally { await lease.close(); }
}
function mapping(before: Message[], after: Message[]) {
  if (before.length !== after.length || before.some((message, index) => signature(message) !== signature(after[index]!))) throw new Error('OpenCode 分叉后的消息内容或边界尚未确认');
  return { turnIds: Object.fromEntries(before.flatMap((message, index) => ['user', 'synthetic'].includes(message.role) ? [[message.id, after[index]!.id]] : [])), headIds: Object.fromEntries(before.map((message, index) => [message.id, after[index]!.id])) };
}
async function createFork(server: OpenCodeServer, source: string, boundary: string | undefined, signal: AbortSignal) {
  const value = server.v2 ? await server.v2.session.fork({ sessionID: source, ...(boundary ? { before: boundary } : {}) }, { signal }) : unwrap(await server.v1!.session.fork({ sessionID: source, ...(boundary ? { messageID: boundary } : {}) }, { signal }));
  if (typeof value.id !== 'string' || !value.id || value.id === source) throw new Error('OpenCode 没有返回独立分叉会话；不会重复创建');
  return value.id as string;
}

export async function forkOpenCode(connection: OpenCodeConnection, request: NativeForkRequest): Promise<NativeForkResult> {
  const source = request.task.threadId;
  if (!source || !request.run.turnId) throw new Error('所选 OpenCode 轮次没有原生消息边界');
  return withHistory(connection, request.task, request.signal, async server => {
    await quiet(server, source, request.signal);
    const original = await messages(server, source, request.signal), end = original.findIndex(message => message.id === (request.run.nativeHead ?? request.run.turnId));
    const next = original.findIndex((message, index) => index > end && ['user', 'synthetic'].includes(message.role));
    const prefix = original.slice(0, next < 0 ? original.length : next);
    if (end < 0 || !same(prompts(prefix), request.expectedTurns)) throw new Error('OpenCode 历史与所选分叉位置不一致');
    let id = request.candidateId;
    if (!id) {
      if (request.inspectOnly) throw new Error('OpenCode 分叉回执丢失，没有可核对的会话 ID；不会重复创建');
      await request.verifiedPrefix?.(request.expectedTurns); request.signal.throwIfAborted(); await request.started(); request.signal.throwIfAborted();
      id = await createFork(server, source, next < 0 ? undefined : original[next]!.id, request.signal); await request.candidate(id);
    }
    if (id === source) throw new Error('OpenCode 分叉没有独立会话');
    await quiet(server, id, request.signal);
    const mapped = mapping(prefix, await messages(server, id, request.signal));
    // Automatic native turns may have no user message. Their actual assistant
    // head is still a verified boundary; keep display turns mapped to that head.
    for (const run of [request.run, ...(request.task.runs ?? [])]) if (run.turnId && run.nativeHead && !mapped.turnIds[run.turnId] && mapped.headIds[run.nativeHead]) mapped.turnIds[run.turnId] = mapped.headIds[run.nativeHead]!;
    return { threadId: id, ...mapped };
  });
}

export async function openCodeNativeHead(server: OpenCodeServer, id: string, signal: AbortSignal, through?: string) {
  const all = await messages(server, id, signal), boundary = through ? all.findIndex(message => message.id === through) : all.length - 1;
  if (through && boundary < 0) throw new Error('OpenCode 原生结果边界尚未写入历史');
  const prefix = all.slice(0, boundary + 1); return { head: prefix.at(-1)?.id, turns: prompts(prefix) };
}

/** Read native child data only; never resume, prompt, adopt a process or start a run. */
export async function readOpenCodeSubagentHistory(connection: OpenCodeConnection, task: WorkItem, parentThreadId: string, signal: AbortSignal): Promise<CodexHistorySnapshot> {
  if (!task.threadId || !task.subagentOrigin) throw new Error('OpenCode 子会话身份缺失');
  return withHistory(connection, task, signal, async server => {
    const id = task.threadId!, session = server.v2 ? await server.v2.session.get({ sessionID: id }, { signal }) : unwrap(await server.v1!.session.get({ sessionID: id }, { signal }));
    if (session.id !== id || session.parentID !== parentThreadId) throw new Error('OpenCode 子会话所属父会话已改变');
    const all = await messages(server, id, signal), active = server.v2 ? await server.v2.session.active({ signal }) : unwrap(await server.v1!.session.status({}, { signal }));
    const busy = server.v2 ? Object.hasOwn(active, id) : !!active[id] && active[id].type !== 'idle';
    const text = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).filter(Boolean).join('\n') : typeof acpRecord(value)?.text === 'string' ? acpRecord(value)!.text : '';
    const clock = (value: unknown, fallback: string) => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
    const turns: CodexHistoryTurn[] = [], byId = new Map<string, CodexHistoryTurn>(); let current: CodexHistoryTurn | undefined;
    for (const [index, message] of all.entries()) {
      const at = clock(message.info.time?.created, new Date(Date.parse(task.createdAt) + index).toISOString());
      if (message.role === 'user' || message.role === 'synthetic') {
        current = { id: message.id, status: 'completed', at, prompt: text(message.content), events: [] }; turns.push(current); byId.set(message.id, current);
        current.events.push({ id: `opencode-history:${id}:${message.id}:turn`, kind: 'turn', text: '', at, turnId: message.id, nativeTurnId: message.id, status: 'completed' });
      } else if (message.role === 'assistant') {
        const turn = byId.get(message.info.parentID) ?? current; if (!turn) continue;
        const parts = Array.isArray(message.content) ? message.content : [{ type: 'text', text: text(message.content) }];
        for (const [ordinal, part] of parts.entries()) {
          const value = acpRecord(part); if (!value) continue;
          const kind = value.type === 'reasoning' ? 'reasoning' : value.type === 'tool' ? value.tool === 'bash' || value.tool === 'shell' ? 'command' : 'tool' : value.type === 'text' ? 'message' : undefined; if (!kind) continue;
          const state = acpRecord(value.state), body = kind === 'command' ? state?.input?.command ?? value.tool : kind === 'tool' ? state?.title ?? value.tool ?? 'Tool' : value.text ?? '';
          const event: TaskEvent = { id: `opencode-history:${id}:${message.id}:${value.id ?? ordinal}`, kind, text: body, at, turnId: turn.id, nativeTurnId: turn.id, status: state?.status === 'error' ? 'failed' : 'completed', ...(kind === 'message' ? { phase: 'commentary' } : {}), ...(typeof state?.output === 'string' ? { detail: state.output } : {}) };
          turn.events.push(event);
        }
        turn.completedAt = clock(message.info.time?.completed, at); if (message.info.error) turn.status = 'failed';
      }
    }
    for (const turn of turns) {
      if (turn === turns.at(-1) && busy) { turn.status = 'inProgress'; delete turn.completedAt; }
      const answer = turn.events.findLast(event => event.kind === 'message'); if (answer) answer.phase = turn.status === 'inProgress' ? 'commentary' : 'final_answer';
      for (const event of turn.events) { if (event.kind === 'turn') event.status = turn.status === 'inProgress' ? 'running' : turn.status === 'failed' ? 'failed' : 'completed'; if (turn.completedAt) event.completedAt = turn.completedAt; }
    }
    return { threadId: id, parentThreadId, turns, canFork: server.generation === 1, ...(busy && task.executionSessionId ? { connectionId: task.executionSessionId } : {}) };
  });
}

export async function rewindOpenCode(connection: OpenCodeConnection, request: NativeRewindRequest): Promise<NativeRewindResult> {
  const source = request.original?.threadId ?? request.task.threadId;
  if (!source) return { state: 'applied', threadId: null, turns: [] };
  return withHistory(connection, request.task, request.signal, async server => {
    const current = request.task.threadId!, keep = request.original?.keep ?? request.keepTurns ?? [];
    await quiet(server, current, request.signal);
    const active = await messages(server, current, request.signal), turns = prompts(active);
    if (server.v2 && request.original && same(turns, keep)) return { state: 'applied', threadId: current, turns };
    if (current !== source && request.original) {
      await quiet(server, source, request.signal);
      const original = await messages(server, source, request.signal), boundary = original.findIndex(message => message.id === request.targetTurnId);
      if (boundary < 0 || !same(prompts(original), request.original.turns)) throw new Error('OpenCode 原会话历史已改变，无法核对回退');
      return { state: 'applied', threadId: current, turns, ...mapping(original.slice(0, boundary), active) };
    }
    if (!same(turns, [...keep, ...request.removeTurns]) || request.targetTurnId !== (request.removeTurns[0] ?? null)) throw new Error('OpenCode 原生历史与已确认的回退边界不一致');
    if (request.inspectOnly) return { state: 'unchanged', threadId: current, turns };
    if (!request.targetTurnId) return { state: 'applied', threadId: current, turns };
    const boundary = active.findIndex(message => message.id === request.targetTurnId);
    request.signal.throwIfAborted(); await request.started({ threadId: source, turns, keep }); request.signal.throwIfAborted();
    if (server.v2) {
      const staged = await server.v2.session.revert.stage({ sessionID: source, messageID: request.targetTurnId, files: false }, { signal: request.signal });
      if (staged.messageID !== request.targetTurnId) throw new Error('OpenCode 没有确认所选原生回退边界');
      await server.v2.session.revert.commit({ sessionID: source }, { signal: request.signal });
      const after = await messages(server, source, request.signal);
      if (!same(prompts(after), keep)) throw new Error('OpenCode 回退后的历史尚未确认');
      return { state: 'applied', threadId: source, turns: keep };
    }
    const id = await createFork(server, source, request.targetTurnId, request.signal); await request.candidate(id);
    const after = await messages(server, id, request.signal);
    return { state: 'applied', threadId: id, turns: prompts(after), ...mapping(active.slice(0, boundary), after) };
  });
}
