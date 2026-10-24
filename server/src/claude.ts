import { REVIEW_GUIDE_OUTPUT_SCHEMA } from './task-review-guide-types.js';
import { reviewGuideTool } from './task-review-guide-tools.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage, type PermissionResult, type EffortLevel, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { claudePermissionResult, permissionDecisions, TaskExecutionCancelled } from './provider-approvals.js';
import type { ClaudeConnection } from './claude-provider.js';
import type { Executor, ExecutionRequest, Approval, ExecutionImage, NativeForkRequest, TextGenerationRequest, WorkItem } from './types.js';
import { TASK_TITLE_OUTPUT_SCHEMA } from './task-title-text.js';
import { ClaudeEvents } from './claude-events.js';
import { forkClaude } from './claude-fork.js';
import { claudeTaskOutputRoot, ClaudeTaskOutputReaders } from './claude-task-output.js';
import { ClaudeLiveSessions } from './claude-live-sessions.js';
import type { NativeBackgroundWork } from './native-runtime-types.js';

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
type PendingApproval = { input: Record<string, unknown>; toolName: string; toolUseID: string; suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]; questions: Approval['questions']; resolve: (value: PermissionResult) => void };
type LiveRun = { query?: Query; prompts: PromptQueue; sessionId: string; accepting: boolean; cancelled?: boolean; pendingMessages: Set<string>; approvals: Map<string, PendingApproval> };
async function userMessage(sessionId: string, text: string, uuid: ReturnType<typeof randomUUID>, images: ExecutionImage[] = []): Promise<SDKUserMessage> {
  const content: SDKUserMessage['message']['content'] = images.length ? [
    { type: 'text', text },
    ...await Promise.all(images.map(async image => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: (await readFile(image.path)).toString('base64') } }))),
  ] : text;
  return { type: 'user', session_id: sessionId, uuid, parent_tool_use_id: null, message: { role: 'user', content } };
}

export class ClaudeExecutor implements Executor {
  supportsTaskTools() { return true; }
  private live = new Map<string, LiveRun>();
  private sessions: ClaudeLiveSessions;
  constructor(private connection: ClaudeConnection) { this.sessions = new ClaudeLiveSessions(connection); connection.onClose(() => this.sessions.close()); }
  generateText(request: TextGenerationRequest) { return this.run(request); }
  deferredStart() { return true; }
  async fork(request: NativeForkRequest) {
    if (this.live.has(request.task.id) || this.sessions.active(request.task.id)) throw new Error('Claude 会话仍在执行，请结束当前轮次后分叉');
    return forkClaude(request, this.connection);
  }
  async run(request: ExecutionRequest): Promise<string> {
    if (!request.purpose) return this.sessions.run(request);
    const { task, prompt, images = [], purpose, signal, update, beforeStart } = request;
    const investigating = purpose === 'review_guide';
    const background = purpose === 'git_text' || purpose === 'task_title' || investigating;
    const configured = await this.connection.runtime(task);
    const planning = task.interactionMode === 'plan';
    if (signal.aborted) throw new Error('任务已中止');
    if (task.threadId && task.claudeHome && task.claudeHome !== configured.home) throw new Error('此对话使用另一个 Claude 配置目录，请恢复原目录后续聊，或开始新任务。');
    const sessionId = task.threadId ?? randomUUID(); const turnId = randomUUID();
    // Allocate and persist the external identity BEFORE even starting its process.
    await update({ kind: 'session', threadId: sessionId, claudeHome: configured.home, model: configured.model, reasoningEffort: configured.effort ?? '' });
    if (signal.aborted) throw new Error('任务已中止');
    const run: LiveRun = { prompts: new PromptQueue(), sessionId, accepting: false, pendingMessages: new Set(), approvals: new Map() };
    this.live.set(task.id, run);
    const abortController = new AbortController(); const transcript = new ClaudeEvents(turnId, update); let finished = false;
    const outputs = new ClaudeTaskOutputReaders({ ...(background ? {} : { root: claudeTaskOutputRoot(configured.env, task.cwd) }), sessionId,
      isCommand: id => transcript.isCommand(id), onChunk: (id, chunk) => transcript.commandOutput(id, chunk) });
    const abort = () => { run.accepting = false; run.prompts.close(); abortController.abort(); run.query?.close(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await transcript.start();
      run.query = query({ prompt: run.prompts, options: {
        cwd: task.cwd, pathToClaudeCodeExecutable: configured.command, env: configured.env,
        model: configured.apiModel, effort: configured.apiEffort as EffortLevel | undefined, settings: configured.modelSettings,
        ...(task.threadId ? { resume: sessionId, ...(task.claudeResumeSessionAt ? { resumeSessionAt: task.claudeResumeSessionAt } : {}) } : { sessionId }),
        abortController, includePartialMessages: true, permissionMode: investigating ? 'dontAsk' : planning ? 'plan' : configured.permissionMode, settingSources: background ? [] : configured.settingSources,
        ...(background ? { tools: investigating ? ['Read','Grep','Glob','Bash'] : [], mcpServers: {}, strictMcpConfig: true, plugins: [] } : {}),
        ...(investigating || purpose === 'task_title' ? { outputFormat: { type: 'json_schema', schema: investigating ? REVIEW_GUIDE_OUTPUT_SCHEMA : TASK_TITLE_OUTPUT_SCHEMA } } : {}),
        ...(investigating ? { allowedTools: ['Read','Grep','Glob','Bash(git diff:*)','Bash(git log:*)','Bash(git show:*)'], settings: { ...configured.modelSettings, disableAllHooks: true } } : {}),
        // Independent local tasks do not spawn more agents. Research stays read-only.
        disallowedTools: ['Agent', 'Task', ...(investigating ? ['Bash(git * --output*)','Bash(git * -o *)'] : []), ...(task.mode === 'research' || !task.projectId ? [...(investigating ? [] : ['Bash']), 'Write', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'] : [])],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Claude Code executing a specific local task delegated by Friday. Respond naturally in Chinese. Stay within the user request and selected workspace. Friday owns the main conversation. Do not commit, push, deploy, purchase, send messages, or spawn subagents unless explicitly requested. On continuation inspect current results before repeating any external action. Report concrete results and limitations.' },
        canUseTool: async (name, input, options) => {
          if (investigating) return reviewGuideTool(name, input, task.cwd);
          if (background) return { behavior: 'deny', message: 'Tools are unavailable during text generation.' };
          if (name === 'ExitPlanMode') {
            if (typeof input.plan === 'string' && input.plan.trim()) await transcript.propose(options.toolUseID, input.plan);
            return { behavior: 'deny', message: 'Friday captured your proposed plan. Stop here and wait for feedback or an explicit implementation request in a later turn.' };
          }
          if (planning && ['Bash', 'Write', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'].includes(name)) {
            return { behavior: 'deny', message: 'This turn is in Plan mode. Only inspect and propose a plan; do not run commands that require broader permissions or modify project files.' };
          }
          const id = randomUUID();
          const raw = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions as Record<string, any>[] : [];
          const questions = raw.map((q, index) => ({ id: `q${index}`, header: String(q.header ?? ''), question: String(q.question ?? ''),
            options: (Array.isArray(q.options) ? q.options : []).map((option: any) => ({ label: String(option.label), description: String(option.description ?? '') })),
            multiSelect: q.multiSelect === true, isOther: q.isOther !== false, isSecret: q.isSecret === true }));
          if (name === 'AskUserQuestion' && !questions.length) return { behavior: 'deny', message: 'Unsupported question format.' };
          const result = new Promise<PermissionResult>(resolve => { run.approvals.set(id, { input, questions, toolName: name, toolUseID: options.toolUseID, suggestions: options.suggestions, resolve }); });
          const cancel = () => { run.approvals.get(id)?.resolve({ behavior: 'deny', message: '任务已中止', interrupt: true }); run.approvals.delete(id); };
          options.signal.addEventListener('abort', cancel, { once: true });
          try {
            await update({ kind: 'approval', approval: { id, method: questions.length ? 'claude/tool/requestUserInput' : 'claude/tool/requestApproval', title: questions.length ? '需要你的补充' : '需要你的授权', detail: [name, options.decisionReason, options.blockedPath, JSON.stringify(input, null, 2)].filter(Boolean).join('\n'), questions, state: 'pending', ...(!questions.length ? { decisions: permissionDecisions } : {}) } });
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
      const message = await userMessage(sessionId, configured.promptEffort ? configured.promptEffort + '\n\n' + prompt : prompt, turnId, images);
      await beforeStart?.();
      await update({ kind: 'turn', turnId });
      run.prompts.push(message);
      await update({ kind: 'ready', canSteer: true });
      for await (const message of run.query) {
        if ('session_id' in message && message.session_id && message.session_id !== sessionId) throw new Error('Claude 返回了不同的会话 ID，已停止执行。');
        if (message.type === 'assistant' && message.parent_tool_use_id == null && message.message.model !== '<synthetic>' && message.uuid
          || message.type === 'user' && message.parent_tool_use_id == null && !('isReplay' in message && message.isReplay) && message.uuid) {
          await update({ kind: 'nativeHead', head: message.uuid! });
        }
        // Current CLIs echo consumed client message IDs, including inputs folded into a turn.
        const receipt = message as SDKMessage & { user_message_uuid?: string; user_message_uuids?: string[] };
        for (const id of receipt.user_message_uuids ?? (receipt.user_message_uuid ? [receipt.user_message_uuid] : [])) run.pendingMessages.delete(id);
        await outputs.handle(message);
        await transcript.handle(message);
        if (message.type === 'result') {
          if (run.cancelled) throw new TaskExecutionCancelled();
          if (message.subtype !== 'success' || message.is_error) throw new Error(message.subtype === 'success' ? 'Claude 任务执行失败' : message.errors.join('\n') || 'Claude 任务执行失败');
          if (run.pendingMessages.size) {
            if (!receipt.user_message_uuid && !receipt.user_message_uuids) throw new Error('Claude 未确认补充要求。已保留会话，请检查结果后继续任务。');
            continue;
          }
          await update({ kind: 'resumeApplied' });
          run.accepting = false; await update({ kind: 'ready', canSteer: false });
          await outputs.close();
          await transcript.finish('completed', message.result); finished = true;
          return (purpose === 'task_title' || investigating) && message.structured_output !== undefined ? JSON.stringify(message.structured_output) : transcript.result;
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
      run.query?.close();
      // close() initiates stdin EOF; returning the SDK generator also awaits its
      // bounded subprocess cleanup, including aborts before iteration began.
      try { await run.query?.return(undefined); }
      catch { if (finished && !signal.aborted) throw new Error('Claude 任务已返回结果，但进程收尾尚未确认。会话已保留，请核对后继续。'); }
      finally { await outputs.close(); this.live.delete(task.id); }
      if (!finished) await transcript.finish(signal.aborted || run.cancelled ? 'interrupted' : 'failed');
    }
  }
  async answer(taskId: string, approvalId: string, decision: import('./provider-approvals.js').ApprovalDecision, answers: Record<string, string[]>) {
    const run = this.live.get(taskId); const approval = run?.approvals.get(approvalId);
    if (!approval) return this.sessions.answer(taskId, approvalId, decision, answers);
    let updatedInput = approval.input;
    if (approval.questions.length) updatedInput = { ...approval.input, answers: Object.fromEntries(approval.questions.map(question => [question.question, (answers[question.id] ?? []).join(', ')])) };
    if (decision === 'cancel') run!.cancelled = true;
    approval.resolve(claudePermissionResult({ toolName: approval.toolName, toolUseID: approval.toolUseID, toolInput: updatedInput, suggestions: approval.suggestions, decision }));
    run!.approvals.delete(approvalId);
  }
  async steer(taskId: string, text: string, requestId: string, images: ExecutionImage[] = []) {
    const run = this.live.get(taskId);
    if (!run?.accepting) return this.sessions.steer(taskId, text, images);
    const uuid = randomUUID();
    const message = await userMessage(run.sessionId, text, uuid, images);
    run.pendingMessages.add(uuid); run.prompts.push(message);
  }
  hasSession(id: string) { return this.sessions.has(id); }
  waitNativeTurn(id: string, sessionId: string, key: string, signal: AbortSignal) { return this.sessions.waitNative(id, sessionId, key, signal); }
  stopNativeSession(id: string, sessionId: string) { return this.sessions.stopNative(id, sessionId); }
  interruptNativeTurn(id: string, sessionId: string, key: string) { return this.sessions.interruptNative(id, sessionId, key); }
  interruptExecution(task: WorkItem, runId: string) { return this.sessions.interruptExecution(task, runId); }
  settleNativeBackground(task: WorkItem) { return this.sessions.settleBackground(task); }
  stopNativeBackground(task: WorkItem, work: NativeBackgroundWork) { return this.sessions.stopBackground(task, work); }
  async close() { await this.sessions.close(); }
}
