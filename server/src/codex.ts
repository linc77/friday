import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { findExecutable } from './agents.js';
import type { Approval, ExecutionRequest, Executor } from './types.js';

type Wire = { id?: string | number; method?: string; params?: any; result?: any; error?: { message: string; code?: number } };
class Rpc {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  nextId = 1;
  onMessage: (message: Wire) => void = () => {};
  onExit: (error: Error) => void = () => {};
  stderr = '';
  constructor(command: string, cwd: string) {
    const env = { ...process.env };
    delete env.CODEX_THREAD_ID;
    this.child = spawn(command, ['app-server', '--listen', 'stdio://'], { cwd, env, stdio: 'pipe' });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message: Wire;
      try { message = JSON.parse(line); } catch { return; }
      if (!message.method && typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else this.onMessage(message);
    });
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-4000); });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', code => this.fail(new Error(`Codex 连接结束（${code ?? 'signal'}）。可稍后继续此任务。`)));
    this.child.stdin.on('error', () => {});
  }
  send(message: Wire) { if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  call(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 请求超时`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  fail(error: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.onExit(error);
  }
  close() { this.onExit = () => {}; this.child.stdin.end(); this.child.kill('SIGTERM'); }
}

type LiveRun = { rpc: Rpc; threadId: string; turnId: string; approvals: Map<string, { wireId: string | number; method: string; params: any }> };
export class CodexExecutor implements Executor {
  private live = new Map<string, LiveRun>();
  constructor(private command = findExecutable('codex')) {}

  async run({ task, prompt, signal, update }: ExecutionRequest): Promise<string> {
    const command = this.command;
    if (!command) throw new Error('找不到 Codex。请先安装并登录 Codex CLI。');
    const rpc = new Rpc(command, task.cwd);
    const run: LiveRun = { rpc, threadId: '', turnId: '', approvals: new Map() };
    this.live.set(task.id, run);
    let chain = Promise.resolve();
    const messages = new Map<string, string>();
    let finalText = ''; let lastFlush = 0;
    let settle!: (text: string) => void; let fail!: (error: Error) => void;
    const completion = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
    // Attach immediately: an early process exit must not create an unhandled rejection.
    void completion.catch(() => {});
    rpc.onExit = fail;
    const onAbort = () => {
      if (run.turnId) void rpc.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
      fail(new Error('任务已中止')); rpc.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    rpc.onMessage = message => {
      chain = chain.then(async () => {
        const p = message.params ?? {};
        if (p.threadId && run.threadId && p.threadId !== run.threadId) return;
        if (message.id !== undefined && message.method) {
          const id = randomUUID();
          const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput'];
          if (!supported.includes(message.method)) {
            // Fail closed for new permission types until the UI can present their exact scope.
            if (message.method === 'item/permissions/requestApproval') rpc.send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
            else if (message.method === 'mcpServer/elicitation/request') rpc.send({ id: message.id, result: { action: 'decline', content: null } });
            else rpc.send({ id: message.id, error: { code: -32601, message: 'Friday does not support this request type yet' } });
            await update({ kind: 'event', eventKind: 'permission', text: `未执行暂不支持的授权请求：${message.method}` });
            return;
          }
          run.approvals.set(id, { wireId: message.id, method: message.method, params: p });
          const approval: Approval = {
            id, method: message.method, state: 'pending',
            title: message.method.includes('requestUserInput') ? '需要你的补充' : '需要你的授权',
            detail: [p.reason, p.command, p.cwd, p.grantRoot].filter(Boolean).join('\n') || '请检查执行记录中的文件改动后决定是否允许。',
            questions: (p.questions ?? []).map((q: any) => ({ id: q.id, header: q.header ?? '', question: q.question, options: q.options ?? [] })),
          };
          await update({ kind: 'approval', approval });
        } else if (message.method === 'turn/started') {
          run.turnId = p.turn.id; await update({ kind: 'turn', turnId: run.turnId });
        } else if (message.method === 'item/agentMessage/delta') {
          messages.set(p.itemId, (messages.get(p.itemId) ?? '') + p.delta);
          if (Date.now() - lastFlush > 150) {
            lastFlush = Date.now(); await update({ kind: 'output', text: [...messages.values()].join('\n\n').slice(-80_000) });
          }
        } else if (message.method === 'item/completed') {
          const item = p.item;
          if (item.type === 'agentMessage') {
            messages.set(item.id, item.text);
            if (item.phase === 'final_answer') finalText = item.text;
            await update({ kind: 'output', text: [...messages.values()].join('\n\n').slice(-80_000) });
          } else if (item.type === 'commandExecution') {
            await update({ kind: 'event', eventKind: 'command', text: `${item.command}\n${item.aggregatedOutput ?? ''}\n退出码：${item.exitCode ?? '—'}`.slice(-12_000) });
          } else if (item.type === 'fileChange') {
            await update({ kind: 'event', eventKind: 'files', text: JSON.stringify(item.changes, null, 2).slice(-20_000) });
          } else if (item.type === 'plan') await update({ kind: 'event', eventKind: 'plan', text: item.text });
        } else if (message.method === 'item/started' && p.item?.type === 'commandExecution') {
          await update({ kind: 'event', eventKind: 'command', text: `正在执行：${p.item.command}` });
        } else if (message.method === 'item/started' && p.item?.type === 'fileChange') {
          await update({ kind: 'event', eventKind: 'files', text: JSON.stringify(p.item.changes, null, 2).slice(-20_000) });
        } else if (message.method === 'turn/completed') {
          if (p.turn.status === 'completed') settle(finalText || [...messages.values()].join('\n\n') || '任务已完成，详见执行记录。');
          else fail(new Error(p.turn.error?.message ?? `Codex 任务${p.turn.status}`));
        } else if (message.method === 'serverRequest/resolved') {
          for (const [id, approval] of run.approvals) if (approval.wireId === p.requestId) {
            run.approvals.delete(id); await update({ kind: 'approvalResolved', id });
          }
        }
      }).catch(fail);
    };
    try {
      if (signal.aborted) throw new Error('任务已中止');
      await rpc.call('initialize', { clientInfo: { name: 'friday', version: '0.1.0', title: 'Friday' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' });
      const params = { cwd: task.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: task.mode === 'research' ? 'read-only' : 'workspace-write' };
      const response = task.threadId
        ? await rpc.call('thread/resume', { ...params, threadId: task.threadId })
        : await rpc.call('thread/start', { ...params, developerInstructions: 'You are executing a task delegated by Friday, the user\'s personal agent. Stay within the user\'s task and chosen workspace. Do not commit, push, deploy, purchase, or send messages to other people unless explicitly requested. Report concrete results, verification, and remaining limitations in Chinese. Do not create or message other Codex chats. Do not spawn subagents unless the user explicitly requests delegation.' });
      run.threadId = response.thread.id;
      await update({ kind: 'session', threadId: run.threadId });
      // The session identifier is durably saved before the external turn can start.
      if (signal.aborted) throw new Error('任务已中止');
      const turn = await rpc.call('turn/start', { threadId: run.threadId, clientUserMessageId: task.lastRequestId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      run.turnId = turn.turn.id;
      await update({ kind: 'turn', turnId: run.turnId });
      const result = await completion; await chain;
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort); this.live.delete(task.id); rpc.close();
    }
  }
  async answer(taskId: string, approvalId: string, decision: 'accept' | 'decline', answers: Record<string, string[]>) {
    const run = this.live.get(taskId); const approval = run?.approvals.get(approvalId);
    if (!run || !approval) throw new Error('这次授权请求已过期，请恢复任务后重新处理。');
    const result = approval.method === 'item/tool/requestUserInput'
      ? { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { answers: value }])) }
      : { decision };
    run.rpc.send({ id: approval.wireId, result }); run.approvals.delete(approvalId);
  }
  async steer(taskId: string, text: string, requestId: string) {
    const run = this.live.get(taskId);
    if (!run?.turnId) throw new Error('任务尚未进入可补充要求的阶段。');
    await run.rpc.call('turn/steer', { threadId: run.threadId, expectedTurnId: run.turnId, clientUserMessageId: requestId, input: [{ type: 'text', text, text_elements: [] }] });
  }
}
