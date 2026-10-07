import { CodexRpc as Rpc } from './codex-rpc.js';
import type { CodexConnection } from './codex-provider.js';
import { randomUUID, createHash } from 'node:crypto';
import { findExecutable } from './agents.js';
import type { Approval, ExecutionRequest, Executor, Workspace } from './types.js';
import { CodexEvents } from './codex-events.js';


type LiveRun = { rpc: Rpc; threadId: string; turnId: string; approvals: Map<string, { wireId: string | number; method: string; params: any }> };
const fridayTools = [
  { type: 'function', name: 'friday_request_workspace', description: 'Ask the user to select a local project directory when their request needs one. End the turn after this call; Friday will resume after selection.', inputSchema: { type: 'object', properties: { reason: { type: 'string', description: 'Brief Chinese explanation of why a directory is needed.' } }, required: ['reason'], additionalProperties: false } },
  { type: 'function', name: 'friday_save_idea', description: 'Save an idea only when the user explicitly wants to record it without starting work.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { type: 'function', name: 'friday_remember', description: 'Save a long-term preference only when the user explicitly asks Friday to remember it.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
];
const personalTools = [
  { type: 'function', name: 'friday_workspace', description: 'Read Friday ideas, projects, explicit memories, and task summaries.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'friday_save_note', description: 'Save a requested Markdown note in Friday artifacts without needing a project directory.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['title', 'content'], additionalProperties: false } },
];
export class CodexExecutor implements Executor {
  private live = new Map<string, LiveRun>();
  constructor(private command = findExecutable('codex'), private connection?: CodexConnection, private workspace?: () => Promise<Workspace>) {}

  async run({ task, prompt, signal, update }: ExecutionRequest): Promise<string> {
    const configured = await this.connection?.runtime(task);
    const command = configured?.command ?? this.command;
    if (!command) throw new Error('找不到 Codex。请先安装并登录 Codex CLI。');
    if (task.threadId && task.codexHome && configured && task.codexHome !== configured.home) throw new Error('此对话使用另一个 Codex 账号目录，请恢复原目录后续聊，或开始新对话。');
    const rpc = new Rpc(command, task.cwd, configured);
    const run: LiveRun = { rpc, threadId: '', turnId: '', approvals: new Map() };
    this.live.set(task.id, run);
    let chain = Promise.resolve();
    const transcript = new CodexEvents(update);
    let finished = false;
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
          if (message.method === 'item/tool/call') {
            let response = 'Unsupported Friday tool.'; let success = false;
            if (p.tool === 'friday_request_workspace' && !task.projectId && typeof p.arguments?.reason === 'string' && p.arguments.reason.trim() && p.arguments.reason.length <= 4000) {
              await update({ kind: 'workspace', reason: p.arguments.reason.trim() });
              response = 'Friday will show the workspace picker. End this turn now with a brief question and do not perform any file operations. The user has not selected a directory yet.'; success = true;
            } else if (p.tool === 'friday_save_idea' && typeof p.arguments?.text === 'string' && p.arguments.text.trim() && p.arguments.text.length <= 12_000) {
              await update({ kind: 'idea', id: `note-${task.id}-${createHash('sha256').update(task.lastRequestId).digest('hex').slice(0, 16)}`, text: p.arguments.text.trim() });
              response = 'The idea is saved. Acknowledge briefly; do not execute it.'; success = true;
            } else if (p.tool === 'friday_remember' && typeof p.arguments?.text === 'string' && p.arguments.text.trim() && p.arguments.text.length <= 4000) {
              await update({ kind: 'memory', id: `memory-${task.id}-${createHash('sha256').update(task.lastRequestId + ':' + p.callId).digest('hex').slice(0, 16)}`, text: p.arguments.text.trim() });
              response = 'The preference is saved in Friday long-term memory.'; success = true;
            } else if (p.tool === 'friday_workspace' && this.workspace) {
              const state = await this.workspace();
              response = JSON.stringify({ ideas: state.ideas.slice(0, 100), projects: state.projects, memories: state.memories, tasks: state.tasks.slice(-30).map(t => ({ id: t.id, title: t.title, status: t.status })) }); success = true;
            } else if (p.tool === 'friday_save_note' && this.workspace && typeof p.arguments?.title === 'string' && p.arguments.title.trim() && p.arguments.title.length <= 120 && typeof p.arguments?.content === 'string' && p.arguments.content.length <= 80_000) {
              const id = `note-${task.id}-${createHash('sha256').update(task.lastRequestId + ':' + p.callId).digest('hex').slice(0, 16)}`;
              await update({ kind: 'note', id, title: p.arguments.title.trim(), content: p.arguments.content });
              response = `The Markdown note is saved in Friday artifacts as ${id}.md.`; success = true;
            }
            rpc.send({ id: message.id, result: { contentItems: [{ type: 'inputText', text: response }], success } });
            return;
          }
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
          run.turnId = p.turn.id; await update({ kind: 'turn', turnId: run.turnId }); await transcript.startTurn(run.turnId);
        } else if (message.method === 'turn/completed') {
          await transcript.finishTurn(p.turn.id, p.turn.status === 'completed' ? 'completed' : p.turn.status === 'interrupted' ? 'interrupted' : 'failed');
          finished = true;
          if (p.turn.status === 'completed') settle(transcript.result);
          else fail(new Error(p.turn.error?.message ?? `Codex 任务${p.turn.status}`));
        } else if (message.method === 'serverRequest/resolved') {
          for (const [id, approval] of run.approvals) if (approval.wireId === p.requestId) {
            run.approvals.delete(id); await update({ kind: 'approvalResolved', id });
          }
        } else await transcript.handle(message.method, p, run.turnId);
      }).catch(fail);
    };
    try {
      if (signal.aborted) throw new Error('任务已中止');
      await rpc.call('initialize', { clientInfo: { name: 'friday', version: '0.1.0', title: 'Friday' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' });
      const unscoped = !task.projectId;
      const params = { cwd: task.cwd, model: configured?.model, approvalPolicy: unscoped ? 'never' : 'on-request', approvalsReviewer: 'user', sandbox: task.mode === 'research' || unscoped ? 'read-only' : 'workspace-write' };
      const response = task.threadId
        ? await rpc.call('thread/resume', { ...params, threadId: task.threadId })
        : await rpc.call('thread/start', { ...params, dynamicTools: this.workspace ? [...fridayTools, ...personalTools] : fridayTools, developerInstructions: 'You are Codex, a local execution agent working on a specific task delegated by Friday. Friday owns the main conversation and user context. Respond naturally in Chinese and stay within this task. Without a selected workspace, answer and research read-only; call friday_request_workspace when local project access is needed, then end the turn and wait for selection. Use friday_workspace to read personal context and friday_save_note for requested notes when available. Use friday_save_idea only for explicit capture-only requests. Use friday_remember only when the user explicitly asks to save a long-term preference. Stay within the user\'s task and selected workspace. Do not commit, push, deploy, purchase, or send messages to other people unless explicitly requested. Report concrete results and limitations. Do not create or message other Codex chats or spawn subagents unless explicitly requested.' });
      run.threadId = response.thread.id;
      await update({ kind: 'session', threadId: run.threadId, codexHome: configured?.home, model: configured?.model, reasoningEffort: configured?.effort });
      // The session identifier is durably saved before the external turn can start.
      if (signal.aborted) throw new Error('任务已中止');
      const turn = await rpc.call('turn/start', { threadId: run.threadId, model: configured?.model, effort: configured?.effort, clientUserMessageId: task.lastRequestId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      run.turnId = turn.turn.id;
      await update({ kind: 'turn', turnId: run.turnId });
      await transcript.startTurn(run.turnId);
      const result = await completion; await chain;
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort); this.live.delete(task.id); rpc.close();
      // Drain queued notifications before terminalizing items on disconnect/cancel.
      await chain;
      if (!finished && run.turnId) await transcript.finishTurn(run.turnId, signal.aborted ? 'interrupted' : 'failed');
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
