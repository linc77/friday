import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage, type PermissionResult, type EffortLevel, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConnection } from './claude-provider.js';
import type { Executor, ExecutionRequest, Approval } from './types.js';
import { ClaudeEvents } from './claude-events.js';

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private wake?: () => void;
  private ended = false;
  push(message: SDKUserMessage) { if (this.ended) throw new Error('任务已结束'); this.messages.push(message); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      if (this.messages.length) yield this.messages.shift()!;
      else await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
type PendingApproval = { input: Record<string, unknown>; questions: Approval['questions']; resolve: (value: PermissionResult) => void };
type LiveRun = { query?: Query; prompts: PromptQueue; sessionId: string; accepting: boolean; pendingMessages: Set<string>; approvals: Map<string, PendingApproval> };
const userMessage = (sessionId: string, text: string, uuid: ReturnType<typeof randomUUID>): SDKUserMessage => ({ type: 'user', session_id: sessionId, uuid, parent_tool_use_id: null, message: { role: 'user', content: text } });

export class ClaudeExecutor implements Executor {
  private live = new Map<string, LiveRun>();
  constructor(private connection: ClaudeConnection) {}
  async run({ task, prompt, signal, update }: ExecutionRequest): Promise<string> {
    const configured = await this.connection.runtime(task);
    if (signal.aborted) throw new Error('任务已中止');
    if (task.threadId && task.claudeHome && task.claudeHome !== configured.home) throw new Error('此对话使用另一个 Claude 配置目录，请恢复原目录后续聊，或开始新任务。');
    const sessionId = task.threadId ?? randomUUID(); const turnId = randomUUID();
    // Allocate and persist the external identity BEFORE even starting its process.
    await update({ kind: 'session', threadId: sessionId, claudeHome: configured.home, model: configured.model, reasoningEffort: configured.effort ?? '' });
    await update({ kind: 'turn', turnId });
    if (signal.aborted) throw new Error('任务已中止');
    const run: LiveRun = { prompts: new PromptQueue(), sessionId, accepting: false, pendingMessages: new Set(), approvals: new Map() };
    this.live.set(task.id, run);
    const abortController = new AbortController(); const transcript = new ClaudeEvents(turnId, update); let finished = false;
    const abort = () => { run.accepting = false; run.prompts.close(); abortController.abort(); run.query?.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await transcript.start();
      run.query = query({ prompt: run.prompts, options: {
        cwd: task.cwd, pathToClaudeCodeExecutable: configured.command, env: configured.env,
        model: configured.model, effort: configured.effort as EffortLevel | undefined,
        ...(task.threadId ? { resume: sessionId } : { sessionId }),
        abortController, includePartialMessages: true, permissionMode: configured.permissionMode, settingSources: configured.settingSources,
        // Independent local tasks do not spawn more agents. Research stays read-only.
        disallowedTools: ['Agent', 'Task', ...(task.mode === 'research' || !task.projectId ? ['Bash', 'Write', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'] : [])],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Claude Code executing a specific local task delegated by Friday. Respond naturally in Chinese. Stay within the user request and selected workspace. Friday owns the main conversation. Do not commit, push, deploy, purchase, send messages, or spawn subagents unless explicitly requested. On continuation inspect current results before repeating any external action. Report concrete results and limitations.' },
        canUseTool: async (name, input, options) => {
          const id = randomUUID();
          const raw = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions as Record<string, any>[] : [];
          const questions = raw.map((q, index) => ({ id: `q${index}`, header: String(q.header ?? ''), question: String(q.question ?? ''), options: (Array.isArray(q.options) ? q.options : []).map((option: any) => ({ label: String(option.label), description: String(option.description ?? '') })) }));
          if (name === 'AskUserQuestion' && !questions.length) return { behavior: 'deny', message: 'Unsupported question format.' };
          const result = new Promise<PermissionResult>(resolve => { run.approvals.set(id, { input, questions, resolve }); });
          const cancel = () => { run.approvals.get(id)?.resolve({ behavior: 'deny', message: '任务已中止', interrupt: true }); run.approvals.delete(id); };
          options.signal.addEventListener('abort', cancel, { once: true });
          try {
            await update({ kind: 'approval', approval: { id, method: questions.length ? 'claude/tool/requestUserInput' : 'claude/tool/requestApproval', title: questions.length ? '需要你的补充' : '需要你的授权', detail: [name, options.decisionReason, options.blockedPath, JSON.stringify(input, null, 2)].filter(Boolean).join('\n'), questions, state: 'pending' } });
            if (options.signal.aborted || signal.aborted) cancel();
            return await result;
          } finally { options.signal.removeEventListener('abort', cancel); run.approvals.delete(id); }
        },
        // Errors are surfaced through typed SDK results; stderr may contain credentials.
        stderr: () => {},
      } });
      await run.query.initializationResult();
      if (signal.aborted) throw new Error('任务已中止');
      run.accepting = true;
      run.prompts.push(userMessage(sessionId, prompt, randomUUID()));
      for await (const message of run.query) {
        if ('session_id' in message && message.session_id && message.session_id !== sessionId) throw new Error('Claude 返回了不同的会话 ID，已停止执行。');
        // Current CLIs echo consumed client message IDs, including inputs folded into a turn.
        const receipt = message as SDKMessage & { user_message_uuid?: string; user_message_uuids?: string[] };
        for (const id of receipt.user_message_uuids ?? (receipt.user_message_uuid ? [receipt.user_message_uuid] : [])) run.pendingMessages.delete(id);
        await transcript.handle(message);
        if (message.type === 'result') {
          if (message.subtype !== 'success' || message.is_error) throw new Error(message.subtype === 'success' ? 'Claude 任务执行失败' : message.errors.join('\n') || 'Claude 任务执行失败');
          if (run.pendingMessages.size) {
            if (!receipt.user_message_uuid && !receipt.user_message_uuids) throw new Error('Claude 未确认补充要求。已保留会话，请检查结果后继续任务。');
            continue;
          }
          run.accepting = false;
          await transcript.finish('completed', message.result); finished = true; return transcript.result;
        }
      }
      throw new Error(signal.aborted ? '任务已中止' : 'Claude 已断开，未返回任务结果；会话已保留。');
    } catch (error) {
      if (signal.aborted) throw new Error('任务已中止');
      // The SDK's process error embeds raw stderr, which can echo private configuration.
      if (error && typeof error === 'object' && 'errorClass' in error) throw new Error('Claude Code 连接或进程已断开。会话已保留，请检查主机配置后继续任务。');
      throw error;
    } finally {
      signal.removeEventListener('abort', abort); run.accepting = false; run.prompts.close();
      for (const approval of run.approvals.values()) approval.resolve({ behavior: 'deny', message: '任务已结束', interrupt: true });
      run.query?.close(); this.live.delete(task.id);
      if (!finished) await transcript.finish(signal.aborted ? 'interrupted' : 'failed');
    }
  }
  async answer(taskId: string, approvalId: string, decision: 'accept' | 'decline', answers: Record<string, string[]>) {
    const run = this.live.get(taskId); const approval = run?.approvals.get(approvalId);
    if (!approval) throw new Error('这次授权请求已过期，请恢复任务后重新处理。');
    let updatedInput = approval.input;
    if (approval.questions.length) updatedInput = { ...approval.input, answers: Object.fromEntries(approval.questions.map(question => [question.question, (answers[question.id] ?? []).join(', ')])) };
    approval.resolve(decision === 'accept' ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: '用户拒绝了本次操作。' });
    run!.approvals.delete(approvalId);
  }
  async steer(taskId: string, text: string, requestId: string) {
    const run = this.live.get(taskId);
    if (!run?.accepting) throw new Error('任务尚未进入可补充要求的阶段。');
    const uuid = randomUUID(); run.pendingMessages.add(uuid);
    run.prompts.push(userMessage(run.sessionId, text, uuid));
  }
}
