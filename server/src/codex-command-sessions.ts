import type { CodexRpc, Wire } from './codex-rpc.js';
import type { CodexSubagents } from './codex-subagents.js';

export type CodexCommandRoute = {
  turnId: () => string; owns: (itemId: string) => boolean;
  handle: (message: Wire) => void; disconnect: (error: Error) => Promise<void>;
  confirmStopped: (itemId: string) => Promise<void>;
  retain?: () => boolean;
  ownsGoal?: () => boolean;
  pauseGoal?: () => Promise<void>;
  retireGoal?: () => void;
  ownsTurn?: (turnId: string) => boolean;
  admitTurn?: (turnId: string) => void;
};
export type CodexCommandSession = {
  key: string; identity: string; token: string; rpc: CodexRpc; threadId: string;
  routes: Set<CodexCommandRoute>; current?: CodexCommandRoute; closed: boolean;
  closing?: Promise<void>;
  subagents?: CodexSubagents;
};

/** Transport ownership, not execution scheduling. Pi Durable still starts every
 * model turn and records external command-control intent before sending it. */
export class CodexCommandSessions {
  private sessions = new Map<string, CodexCommandSession>();
  private closing = new Set<Promise<void>>();
  private stopping = false;
  get(key: string) { return this.sessions.get(key); }
  open(key: string, identity: string, token: string, create: () => CodexRpc) {
    if (this.stopping) throw new Error('Codex 正在停止，请稍后重试');
    const previous = this.sessions.get(key);
    if (previous) {
      if (previous.identity !== identity || previous.current) throw new Error('此会话仍有后台命令，请先停止后再切换执行目录或账号');
      return { session: previous, reused: true };
    }
    const session: CodexCommandSession = { key, identity, token, rpc: create(), threadId: '', routes: new Set(), closed: false };
    this.sessions.set(key, session);
    session.rpc.onMessage = message => {
      const p = message.params ?? {};
      if (session.closed) return;
      if (session.subagents?.accept(message)) return;
      if ((p.threadId ?? p.conversationId) && session.threadId && (p.threadId ?? p.conversationId) !== session.threadId) return;
      const turnId = p.turnId ?? p.turn?.id;
      let route = typeof turnId === 'string' ? [...session.routes].find(route => route.turnId() === turnId || route.ownsTurn?.(turnId)) : undefined;
      if (!route && message.method === 'turn/started') route = session.current?.ownsGoal?.() ? session.current : [...session.routes].findLast(route => route.ownsGoal?.());
      if (!route && !turnId) {
        const itemId = p.itemId ?? p.item?.id;
        const owners = typeof itemId === 'string' ? [...session.routes].filter(route => route.owns(itemId)) : [];
        if (owners.length === 1) route = owners[0];
        else if (owners.length > 1) return;
        else route = session.current ?? (message.method?.startsWith('thread/goal/') ? [...session.routes].findLast(route => route.ownsGoal?.()) : undefined);
      }
      if (!route && session.current && !session.current.turnId()) route = session.current;
      // Admission must happen before asynchronous Durable writes: a complete
      // native turn can arrive in one stdout chunk immediately after started.
      if (route && message.method === 'turn/started' && typeof turnId === 'string') route.admitTurn?.(turnId);
      route?.handle(message);
    };
    session.rpc.onExit = error => { void this.forceClose(session, error); };
    session.rpc.onIdle = () => this.prune(session);
    return { session, reused: false };
  }
  attach(session: CodexCommandSession, route: CodexCommandRoute) { for (const previous of session.routes) previous.retireGoal?.(); session.routes.add(route); session.current = route; this.prune(session); }
  release(session: CodexCommandSession, route: CodexCommandRoute, retain: boolean) {
    if (session.current === route) session.current = undefined;
    if (!retain) session.routes.delete(route);
    this.closeIfIdle(session);
  }
  private closeIfIdle(session: CodexCommandSession) {
    if (!session.routes.size && !session.closed && !session.rpc.pending.size && !session.subagents?.retained()) {
      session.closed = true; if (this.sessions.get(session.key) === session) this.sessions.delete(session.key); session.rpc.close();
    }
  }
  prune(session: CodexCommandSession) {
    for (const route of session.routes) if (route !== session.current && route.retain?.() === false) session.routes.delete(route);
    this.closeIfIdle(session);
  }
  forceClose(session: CodexCommandSession, error: Error, interrupted = false) {
    if (session.closed) return session.closing ?? Promise.resolve();
    session.closed = true; if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    session.rpc.close();
    const closing = Promise.allSettled([...session.routes].map(route => route.disconnect(error)).concat(session.subagents ? [session.subagents.disconnect(interrupted)] : [])).then(() => {});
    session.closing = closing;
    this.closing.add(closing); void closing.finally(() => this.closing.delete(closing)); return closing;
  }
  async close() {
    this.stopping = true;
    // Active Durable runs receive their normal abort during Harness.close.
    await Promise.all([...this.sessions.values()].filter(session => !session.current).map(async session => { await Promise.allSettled([...session.routes].map(route => route.pauseGoal?.())); await this.forceClose(session, new Error('Friday 服务已停止')); }));
    await Promise.all([...this.closing]);
  }
}
