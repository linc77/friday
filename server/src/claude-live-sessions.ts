import { randomUUID, createHash } from 'node:crypto';
import { TASK_TOOL_INSTRUCTIONS, taskRuntimeToolDefinitions } from './task-runtime-tools.js';
import { query, type Query, type SDKMessage, type PermissionResult, type EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeConnection } from './claude-provider.js';
import type { ExecutionRequest, ExecutionUpdate, ExecutionImage, Approval, WorkItem, TaskMcpConnection } from './types.js';
import type { NativeBackgroundWork, NativeObservedUpdate } from './native-runtime-types.js';
import { nativeObservedRunId } from './native-runtime-types.js';
import { ClaudeBackground, claudeBackgroundEnded as ended, type ClaudeBackgroundTask } from './claude-background.js';
import { ClaudeEvents } from './claude-events.js';
import { ClaudeSubagents } from './claude-subagents.js';
import { ClaudePromptQueue, claudeUserMessage } from './claude-inputs.js';
import { discoverClaudeSkills } from './claude-skills.js';
import { hasSkillMention, planClaudeSkillDispatch } from './vendor/t3-claude-skill-dispatch.js';
import { claudeEchoes, claudeForeignResult, claudeGatedFrame, type ClaudeEchoMode } from './claude-frame-ownership.js';
import { ClaudeTaskOutputReaders, ClaudeTaskOutputTail, claudeTaskOutputRoot } from './claude-task-output.js';
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, type TerminalOutputState } from './vendor/t3-terminal-output.js';
import { claudePermissionResult, permissionDecisions, TaskExecutionCancelled } from './provider-approvals.js';

type Configuration = Awaited<ReturnType<ClaudeConnection['runtime']>>;
type Context = {
  id: ReturnType<typeof randomUUID>; key?: string; task: WorkItem; native: boolean; started: boolean; finished: boolean; accepting: boolean;
  transcript: ClaudeEvents; outputs: ClaudeTaskOutputReaders; update: (value: ExecutionUpdate) => Promise<void>;
  resolve: (text: string) => void; reject: (error: Error) => void; done: Promise<string>;
  resultSeen: boolean; result: string; pending: Set<string>; confirmed: boolean; gatedCount: number; held: SDKMessage[];
  finalized?: Promise<void>;
  activation?: Promise<void>;
  interrupted?: boolean; interruption?: Promise<void>;
  cancelled?: boolean;
  taskMcp?: TaskMcpConnection;
};
type Session = {
  taskId: string; threadId: string; token: string; identity: string; configuration: Configuration; task: WorkItem;
  query?: Query; inputs: ClaudePromptQueue; controller: AbortController; reader?: Promise<void>; closing: boolean;
  current?: Context; contexts: Map<string, Context>; tools: Map<string, { name: string; context: Context }>;
  background: ClaudeBackground; files: Map<string, ClaudeTaskOutputTail>; tails: Map<string, TerminalOutputState>; finalReads: Set<string>;
  subagents: ClaudeSubagents;
  publishedTerminal: Set<string>;
  stopRequested?: boolean;
  approvals: Map<string, { input: Record<string, unknown>; toolName: string; toolUseID: string; suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]; context: Context; questions: Approval['questions']; resolve: (result: PermissionResult) => void }>;
  send: (update: ExecutionUpdate) => Promise<void>; echoMode: ClaudeEchoMode; idle?: NodeJS.Timeout; listeners: Set<() => void>;
};
const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const publicFrame = (message: SDKMessage) => (message.type === 'assistant' || message.type === 'stream_event') && !message.parent_tool_use_id;
const errorMessage = (error: unknown) => error instanceof Error && !('errorClass' in error) ? error : new Error('Claude Code 连接或进程已断开。会话已保留，请检查后继续。');

/** Resident SDK transport. All prompts still enter through an owning Durable
 * execution. Native wake output is observed by a separate Durable task. */
export class ClaudeLiveSessions {
  private sessions = new Map<string, Session>();
  private stopping = false;
  constructor(private connection: ClaudeConnection, private idleMs = 60_000) {}
  has(id: string) { return this.sessions.has(id); }
  active(id: string) { return this.sessions.get(id)?.current !== undefined; }
  private wake(session: Session) { for (const listener of session.listeners) listener(); }
  private identity(task: WorkItem, configured: Configuration) {
    // query() writes its own package version into process.env on first use.
    // That SDK bookkeeping must not invalidate the first resident transport.
    const env: NodeJS.ProcessEnv = { ...configured.env }; delete env.CLAUDE_AGENT_SDK_VERSION;
    return createHash('sha256').update(JSON.stringify({ cwd: task.cwd, command: configured.command, home: configured.home, env,
      settings: configured.settingSources, research: task.mode === 'research' })).digest('hex');
  }
  private context(session: Session, task: WorkItem, update: Context['update'], native = false, key?: string, id = randomUUID()): Context {
    let resolve!: Context['resolve']; let reject!: Context['reject'];
    const done = new Promise<string>((yes, no) => { resolve = yes; reject = no; }); void done.catch(() => {});
    const transcript = new ClaudeEvents(id, async value => {
      if (value.kind === 'contextUsage' && session.current?.id === id) session.task.contextUsage = value.usage;
      await update(value);
    }, 'commentary', task.contextUsage);
    const outputs = new ClaudeTaskOutputReaders({ root: claudeTaskOutputRoot(session.configuration.env, task.cwd), sessionId: session.threadId,
      isCommand: tool => transcript.isCommand(tool), onChunk: (tool, chunk) => transcript.commandOutput(tool, chunk) });
    const context: Context = { id, key, task, native, started: native, finished: false, accepting: false, transcript, outputs, update,
      resolve, reject, done, resultSeen: false, result: '', pending: new Set(), confirmed: native, gatedCount: 0, held: [] };
    session.contexts.set(id, context); return context;
  }
  private armIdle(session: Session) {
    clearTimeout(session.idle);
    if (session.closing || session.current || session.background.active().length || session.subagents.active()) return;
    session.idle = setTimeout(() => { if (!session.current && !session.background.active().length && !session.subagents.active()) void this.closeSession(session); }, this.idleMs); session.idle.unref();
  }
  private async nativeContext(session: Session, message: SDKMessage): Promise<Context> {
    const current = session.current;
    if (current) { await current.activation; if (!current.finished) return current; }
    const key = createHash('sha256').update(JSON.stringify([session.token, 'uuid' in message ? message.uuid : randomUUID()])).digest('hex');
    const id = randomUUID();
    const task = { ...session.task, currentRunId: nativeObservedRunId(key), turnId: id };
    const context = this.context(session, task, value => {
      if (['item', 'output', 'commandOutput', 'nativeHead', 'ready', 'approval', 'approvalResolved', 'event', 'backgroundWaiting', 'contextUsage'].includes(value.kind)) {
        return session.send({ kind: 'nativeTurnUpdate', key, sessionId: session.token, threadId: session.threadId, value: value as NativeObservedUpdate });
      }
      return Promise.resolve();
    }, true, key, id);
    session.current = context;
    context.activation = (async () => {
      await session.send({ kind: 'nativeTurnStart', key, sessionId: session.token, threadId: session.threadId, turnId: id,
        parameters: { cwd: session.task.cwd, mode: session.task.mode, interactionMode: session.task.interactionMode,
          model: session.configuration.model, reasoningEffort: session.configuration.effort } });
      await context.transcript.start(); await context.update({ kind: 'ready', canSteer: true }); context.accepting = true;
    })();
    await context.activation; return context;
  }

  async run(request: ExecutionRequest): Promise<string> {
    const configured = await this.connection.runtime(request.task); const task = request.task;
    if (this.stopping || request.signal.aborted) throw new Error('任务已中止');
    if (task.threadId && task.claudeHome && task.claudeHome !== configured.home) throw new Error('此对话使用另一个 Claude 配置目录，请恢复原目录后续聊，或开始新任务。');
    let session = this.sessions.get(task.id); const identity = this.identity(task, configured);
    const forceResume = task.claudeResumeSessionAt && task.claudeResumePendingRun === task.currentRunId;
    if (session?.current?.native) await this.withSignal(session.current.done.catch(() => {}), request.signal);
    if (session && (session.identity !== identity || forceResume || session.configuration.effort && !configured.effort)) {
      if (session.current || session.background.active().length || session.subagents.active()) throw new Error('Claude 仍有后台任务，请先停止后再切换执行范围或配置');
      await this.closeSession(session); session = undefined;
    }
    if (!session) {
      const threadId = task.threadId ?? randomUUID();
      session = { taskId: task.id, threadId, token: randomUUID(), identity, configuration: configured, task: { ...task }, inputs: new ClaudePromptQueue(),
        controller: new AbortController(), closing: false, contexts: new Map(), tools: new Map(), background: new ClaudeBackground(threadId, ''),
        files: new Map(), tails: new Map(), finalReads: new Set(), publishedTerminal: new Set(), approvals: new Map(), send: request.update, echoMode: 'unknown', listeners: new Set(), subagents: undefined! };
      session.background = new ClaudeBackground(threadId, session.token); this.sessions.set(task.id, session);
      const created = session;
      session.subagents = new ClaudeSubagents({ taskId: task.id, threadId, sessionId: session.token, outputRoot: claudeTaskOutputRoot(configured.env, task.cwd), model: configured.model, effort: configured.effort }, value => created.send(value));
    }
    const source = session; clearTimeout(source.idle);
    let owned: Context | undefined;
    const abort = () => { if (owned && source.current === owned) void this.interruptContext(source, owned).catch(() => {}); };
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      if (source.current) {
        if (!source.current.native) throw new Error('Claude 仍有轮次正在执行，请先排队或补充要求');
        await this.withSignal(source.current.done.catch(() => {}), request.signal);
      }
      if (source.closing || request.signal.aborted) throw new Error('任务已中止');
      const context = this.context(source, request.contextBeforeCompaction ? { ...task, contextUsage: request.contextBeforeCompaction } : task, request.update); context.finalized = request.finalized; context.taskMcp = request.taskMcp; source.current = context; owned = context;
      await request.update({ kind: 'session', threadId: source.threadId, executionSessionId: source.token, claudeHome: configured.home,
        model: configured.model, reasoningEffort: configured.effort ?? '' });
      if (source.closing || request.signal.aborted) throw new Error('任务已中止');
      if (!source.query) {
        source.configuration = configured; source.task = { ...task };
        source.query = query({ prompt: source.inputs, options: {
          cwd: task.cwd, pathToClaudeCodeExecutable: configured.command, env: configured.env, model: configured.model, effort: configured.effort as EffortLevel | undefined,
          ...(task.threadId ? { resume: source.threadId, ...(task.claudeResumeSessionAt ? { resumeSessionAt: task.claudeResumeSessionAt } : {}) } : { sessionId: source.threadId }),
          abortController: source.controller, includePartialMessages: true, permissionMode: task.interactionMode === 'plan' ? 'plan' : configured.permissionMode,
          settingSources: configured.settingSources, ...(task.mode === 'research' ? { tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] } : {}),
          ...(request.taskMcp ? { mcpServers: { friday_tasks: { type: 'http', ...request.taskMcp } } } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: 'You are Claude Code executing a specific local task delegated by Friday. Respond naturally in Chinese. Stay within the user request and selected workspace. Friday owns the main conversation. Do not commit, push, deploy, purchase, send messages, or spawn subagents unless explicitly requested. On continuation inspect current results before repeating any external action. Report concrete results and limitations.' + (request.taskMcp ? '\n\n' + TASK_TOOL_INSTRUCTIONS : '') },
          canUseTool: (name, input, options) => this.permission(source, name, input, options), stderr: () => {},
        } });
        source.reader = this.read(source); await source.query.initializationResult();
      } else {
        if (request.taskMcp) {
          const updated = await source.query.setMcpServers({ friday_tasks: { type: 'http', ...request.taskMcp } });
          if (Object.keys(updated.errors ?? {}).length) throw new Error('Friday 任务工具连接失败，请重试此轮');
        }
        if (configured.model !== source.configuration.model) await source.query.setModel(configured.model);
        if (configured.effort !== source.configuration.effort) await source.query.applyFlagSettings({ effortLevel: configured.effort as EffortLevel });
        await source.query.setPermissionMode(task.interactionMode === 'plan' ? 'plan' : configured.permissionMode);
        source.configuration = configured; source.task = { ...task };
      }
      if (request.command === 'compact' && !(await source.query.supportedCommands()).some(command => command.name === 'compact')) throw new Error('这个 Claude Code 版本尚未提供上下文压缩命令');
      let dispatch: { leadingText?: string; commandText: string } | undefined;
      if (!request.command && hasSkillMention(request.userText ?? request.prompt)) {
        const skills = await discoverClaudeSkills(configured.home, task.cwd, configured.env);
        dispatch = planClaudeSkillDispatch(request.userText ?? request.prompt, new Set(skills.filter(skill => skill.enabled && skill.userInvocable !== false).map(skill => skill.name)));
        if (dispatch && request.contextText) dispatch = { ...dispatch, leadingText: [request.contextText, dispatch.leadingText].filter(Boolean).join("\n\n") };
      }
      const slash = request.userText?.match(/^\/([^\s/]+)(?=\s|$)/)?.[1];
      if (!request.command && !dispatch && slash && (await source.query.supportedCommands()).some(command => command.name === slash || command.aliases?.includes(slash))) {
        dispatch = { leadingText: request.contextText, commandText: request.userText! };
      }
      const message = await claudeUserMessage(source.threadId, request.command === 'compact' ? '/compact' : request.prompt, context.id, request.images, dispatch);
      await request.beforeStart?.();
      if (request.signal.aborted || source.closing) throw new Error('任务已中止');
      await request.update({ kind: 'turn', turnId: context.id }); await context.transcript.start(); context.started = true;
      source.inputs.push(message); context.accepting = true; await request.update({ kind: 'ready', canSteer: request.command !== 'compact' });
      return await context.done;
    } catch (error) {
      if (owned?.interruption) await owned.interruption;
      if (owned && !owned.finished) await this.closeSession(source);
      throw request.signal.aborted ? new Error('任务已中止') : errorMessage(error);
    } finally { request.signal.removeEventListener('abort', abort); }
  }

  private registerTools(session: Session, context: Context, message: SDKMessage) {
    if ((message.type === 'assistant' || message.type === 'stream_event') && message.parent_tool_use_id) return false;
    const blocks = message.type === 'assistant' ? message.message.content
      : message.type === 'stream_event' && message.event.type === 'content_block_start' ? [message.event.content_block] : [];
    let changed = false;
    for (const block of blocks) if (block.type === 'tool_use') {
      session.tools.set(block.id, { name: block.name, context });
      session.background.registerTool(block.id, block.name, block.input, { turnId: context.id, runId: context.task.currentRunId, eventId: `claude:${context.id}:${block.id}` }); changed = true;
    }
    if (message.type === 'user' && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
      const results = message.message.content.filter(block => block.type === 'tool_result'); const result = results.length === 1 ? object(message.tool_use_result) : undefined;
      if (result && results.length === 1) {
        const tool = session.tools.get(results[0]!.tool_use_id); const taskId = tool?.name === 'Monitor' ? result.taskId : tool?.name === 'Bash' ? result.backgroundTaskId : undefined;
        if (typeof taskId === 'string') changed = session.background.bindTask(taskId, results[0]!.tool_use_id) || changed;
      }
    }
    return changed;
  }
  private async publish(session: Session, connected = true) {
    const tasks = session.background.values().map(work => {
      const tail = session.tails.get(work.id);
      return { ...work, ...((ended(work) || !work.member || !connected) && tail ? { output: { text: tail.text, truncated: tail.truncated } } : {}) };
    });
    await session.send({ kind: 'nativeBackground', threadId: session.threadId, sessionId: session.token, connected, tasks });
    for (const work of tasks) if (ended(work)) session.publishedTerminal.add(work.id);
    this.wake(session);
  }
  private async files(session: Session) {
    const root = claudeTaskOutputRoot(session.configuration.env, session.task.cwd); if (!root) return;
    for (const [id, tail] of session.files) {
      const work = session.background.values().find(work => work.id === id);
      if (!work || !work.member || ended(work) || work.ambient) { session.files.delete(id); await tail.stop(); }
    }
    await this.publish(session);
    for (const work of session.background.values()) {
      if (session.background.current(work.taskId)?.id !== work.id) continue;
      if (work.ambient || !work.backgrounded || !['command', 'monitor'].includes(work.kind) || session.files.has(work.id)) continue;
      if (!work.member && !ended(work)) continue;
      if (ended(work) && session.finalReads.has(work.id)) continue;
      let first = true;
      const tail = new ClaudeTaskOutputTail({ root, sessionId: session.threadId, taskId: work.taskId, onChunk: async chunk => {
        if (session.background.current(work.taskId)?.id !== work.id) return;
        const output = appendTerminalOutput(first || chunk.reset ? EMPTY_TERMINAL_OUTPUT : session.tails.get(work.id) ?? EMPTY_TERMINAL_OUTPUT, chunk.text);
        session.tails.set(work.id, chunk.truncated ? { ...output, truncated: true } : output);
        await session.send({ kind: 'nativeBackgroundOutput', threadId: session.threadId, sessionId: session.token, workId: work.id,
          delta: chunk.text, ...(first || chunk.reset ? { reset: true } : {}), ...(chunk.truncated ? { truncated: true } : {}) }); first = false;
      } });
      if (ended(work)) { await tail.stop(); session.finalReads.add(work.id); await this.publish(session); }
      else session.files.set(work.id, tail);
    }
  }

  private async read(session: Session) {
    let failure: Error | undefined;
    try {
      // Iterate the public Query object: its return() closes a pending read.
      // The SDK's raw async generator can otherwise wait forever on an idle CLI.
      const messages: AsyncIterable<SDKMessage> = { [Symbol.asyncIterator]: () => session.query! };
      for await (const message of messages) {
        if (session.closing) break;
        if ('session_id' in message && message.session_id && message.session_id !== session.threadId) throw new Error('Claude 返回了不同的会话 ID，已停止执行。');
        if (Reflect.get(message, 'isReplay') === true) continue;
        clearTimeout(session.idle);
        if ('parent_tool_use_id' in message && message.parent_tool_use_id) { await session.subagents.handle(message); this.armIdle(session); continue; }
        await session.subagents.routeToolOutput(message);
        let context = session.current;
        if (context?.interrupted) { await this.handle(session, context, message); continue; }
        if (!context && publicFrame(message)) context = await this.nativeContext(session, message);
        if (context && !context.native && !context.confirmed && claudeGatedFrame(message)) {
          if (claudeEchoes(message).includes(context.id)) {
            if (session.echoMode === 'unknown' || session.echoMode === 'acknowledged') session.echoMode = message.type !== 'result' && context.gatedCount === 0 ? 'early' : 'result_only';
            context.confirmed = true; for (const held of context.held.splice(0)) await this.handle(session, context, held);
          } else {
            context.gatedCount++;
            if (message.type === 'result' && claudeForeignResult(message, context.id, session.echoMode)) {
              if (message.num_turns === 0) continue;
              if (session.echoMode === 'early' && context.held.length) {
                const held = context.held.splice(0); session.current = undefined;
                const wake = await this.nativeContext(session, held[0]!);
                for (const frame of [...held, message]) await this.handle(session, wake, frame);
                if (wake.finished) session.current = context;
                else throw new Error('Claude 在确认新输入前返回了未结束的后台回复，请检查后继续');
              }
              continue;
            }
            if (session.echoMode === 'early' && message.type !== 'result') { context.held.push(message); continue; }
            if (message.type === 'result') { context.confirmed = true; for (const held of context.held.splice(0)) await this.handle(session, context, held); }
          }
        }
        await this.handle(session, context, message); this.armIdle(session);
      }
      if (!session.closing) failure = new Error('Claude 已断开，未返回后续任务状态；会话已保留。');
    } catch (error) { failure = errorMessage(error); }
    finally {
      session.closing = true; clearTimeout(session.idle); session.inputs.close(); session.controller.abort(); session.query?.close();
      // The owned CLI may flush tool files while exiting. Drain the public
      // Query first, then capture file tails and publish interrupted records.
      try { await session.query?.return(undefined); } catch {}
      await session.subagents.close(session.stopRequested).catch(() => {});
      for (const context of session.contexts.values()) {
        await context.outputs.close();
        if (!context.finished) await context.transcript.finish('interrupted').catch(() => {});
      }
      await Promise.all([...session.files.values()].map(tail => tail.stop())); session.files.clear();
      session.background.disconnect(session.stopRequested); await this.publish(session, false).catch(() => {});
      for (const context of session.contexts.values()) if (!context.finished) {
        context.finished = true;
        if (context.native) await session.send({ kind: 'nativeTurnFinish', threadId: session.threadId, sessionId: session.token, key: context.key!, status: 'interrupted', result: context.transcript.result, error: failure?.message ?? '原生连接已关闭' }).catch(() => {});
        context.reject(failure ?? new Error('任务已中止'));
      }
      for (const approval of session.approvals.values()) approval.resolve({ behavior: 'deny', message: '任务已结束', interrupt: true }); session.approvals.clear();
      if (this.sessions.get(session.taskId) === session) this.sessions.delete(session.taskId); this.wake(session);
    }
  }

  private async handle(session: Session, context: Context | undefined, message: SDKMessage) {
    if (context?.finished) context = undefined;
    if (context) {
      await context.activation;
      if (!context.interrupted) await session.subagents.handle(message, { runId: context.task.currentRunId ?? context.id, turnId: context.id });
      await context.outputs.handle(message);
      const tools = !context.interrupted && this.registerTools(session, context, message); const background = session.background.handle(message);
      if (publicFrame(message) && context.resultSeen) { context.resultSeen = false; await context.update({ kind: 'backgroundWaiting', waiting: false }); }
      if (message.type === 'assistant' && !message.parent_tool_use_id && message.message.model !== '<synthetic>' && message.uuid
        || message.type === 'user' && !message.parent_tool_use_id && message.uuid
        || message.type === 'system' && message.subtype === 'compact_boundary' && message.uuid) await context.update({ kind: 'nativeHead', head: message.uuid! });
      for (const id of claudeEchoes(message)) context.pending.delete(id);
      if (background || tools && session.background.values().length) await this.files(session);
      if (context.interrupted) { if (message.type === 'user') await context.transcript.handle(message); return; }
      await context.transcript.handle(message);
      if (message.type === 'result') {
        if (context.cancelled || message.subtype !== 'success' || message.is_error) {
          const error = context.cancelled ? new TaskExecutionCancelled() : new Error(message.subtype === 'success' ? 'Claude 任务执行失败' : message.errors.join('\n') || 'Claude 任务执行失败');
          await this.failContext(session, context, error); return;
        }
        if (context.pending.size) {
          if (!claudeEchoes(message).length) throw new Error('Claude 未确认补充要求。已保留会话，请检查后继续。');
          return;
        }
        context.resultSeen = true; context.result = message.result;
        await context.update({ kind: 'resumeApplied' });
      }
      await this.settle(session, context);
    } else {
      await session.subagents.handle(message);
      if (session.background.handle(message)) await this.files(session);
    }
    this.wake(session);
  }
  private async settle(session: Session, context: Context) {
    if (context.finished || !context.resultSeen || context.pending.size) return;
    if (session.background.holdsCompletion()) { await context.update({ kind: 'backgroundWaiting', waiting: true }); return; }
    const retain = new Set(session.background.active().filter(work => work.origin?.turnId === context.id && work.toolUseId).map(work => work.toolUseId!));
    await context.outputs.close(); await context.transcript.finish('completed', context.result, retain);
    await context.update({ kind: 'ready', canSteer: false }); await context.update({ kind: 'backgroundWaiting', waiting: false });
    if (context.native) await session.send({ kind: 'nativeTurnFinish', threadId: session.threadId, sessionId: session.token, key: context.key!, status: 'completed', result: context.result });
    context.finished = true; context.accepting = false; if (session.current === context) session.current = undefined;
    context.resolve(context.result); await context.finalized; this.armIdle(session);
  }

  private async failContext(session: Session, context: Context, error: Error) {
    const retain = new Set(session.background.active().filter(work => work.origin?.turnId === context.id && work.toolUseId).map(work => work.toolUseId!));
    const status = context.cancelled ? 'interrupted' : 'failed';
    await context.outputs.close(); await context.transcript.finish(status, undefined, retain);
    await context.update({ kind: 'ready', canSteer: false }); await context.update({ kind: 'backgroundWaiting', waiting: false });
    if (context.native) await session.send({ kind: 'nativeTurnFinish', threadId: session.threadId, sessionId: session.token, key: context.key!, status, result: context.transcript.result, ...(!context.cancelled ? { error: error.message } : {}) });
    context.finished = true; context.accepting = false; if (session.current === context) session.current = undefined;
    context.reject(error); await context.finalized; this.armIdle(session);
  }

  private async permission(session: Session, name: string, input: Record<string, unknown>, options: { toolUseID: string; signal: AbortSignal; decisionReason?: string; blockedPath?: string; suggestions?: import('@anthropic-ai/claude-agent-sdk').PermissionUpdate[]; agentID?: string; mcpServer?: { name: string; source: string } }): Promise<PermissionResult> {
    let context = session.current;
    if (!context) context = await this.nativeContext(session, { type: 'system', subtype: 'status', status: null, session_id: session.threadId, uuid: randomUUID() } as SDKMessage);
    await context.activation;
    if (context.held.length) { context.confirmed = true; for (const held of context.held.splice(0)) await this.handle(session, context, held); }
    if (session.closing || context.interrupted) return { behavior: 'deny', message: '任务已结束', interrupt: true };
    if (context.taskMcp && !options.agentID && !session.subagents.ownsTool(options.toolUseID) && options.mcpServer?.name === 'friday_tasks' && options.mcpServer.source === 'dynamic' && taskRuntimeToolDefinitions.some(tool => name === 'mcp__friday_tasks__' + tool.name)) return { behavior: 'allow', updatedInput: input };
    if (name === 'ExitPlanMode') {
      if (typeof input.plan === 'string') {
        if (options.agentID || session.subagents.ownsTool(options.toolUseID)) await session.subagents.propose(options.toolUseID, input.plan, options.agentID);
        else await context.transcript.propose(options.toolUseID, input.plan);
      }
      return { behavior: 'deny', message: 'Friday captured your proposed plan. Stop here and wait for feedback or an explicit implementation request.' };
    }
    if (context.task.interactionMode === 'plan' && ['Bash', 'Monitor', 'Write', 'Edit', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree'].includes(name)) return { behavior: 'deny', message: 'This turn is in Plan mode. Only inspect and propose a plan.' };
    const id = randomUUID(); const raw = name === 'AskUserQuestion' && Array.isArray(input.questions) ? input.questions as Record<string, any>[] : [];
    const questions = raw.map((question, index) => ({ id: `q${index}`, header: String(question.header ?? ''), question: String(question.question ?? ''),
      options: (Array.isArray(question.options) ? question.options : []).map((option: any) => ({ label: String(option.label), description: String(option.description ?? '') })),
      multiSelect: question.multiSelect === true, isOther: question.isOther !== false, isSecret: question.isSecret === true }));
    if (name === 'AskUserQuestion' && !questions.length) return { behavior: 'deny', message: 'Unsupported question format.' };
    const decision = new Promise<PermissionResult>(resolve => { session.approvals.set(id, { input, questions, toolName: name, toolUseID: options.toolUseID, suggestions: options.suggestions, context, resolve }); });
    const abort = () => { session.approvals.get(id)?.resolve({ behavior: 'deny', message: '任务已中止', interrupt: true }); session.approvals.delete(id); };
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      await session.subagents.permission(options.toolUseID, true, options.agentID);
      await context.update({ kind: 'approval', approval: { id, method: questions.length ? 'claude/tool/requestUserInput' : 'claude/tool/requestApproval', title: questions.length ? '需要你的补充' : '需要你的授权',
        detail: [name, options.decisionReason, options.blockedPath, JSON.stringify(input, null, 2)].filter(Boolean).join('\n'), questions, state: 'pending', ...(!questions.length ? { decisions: permissionDecisions } : {}) } });
      if (options.signal.aborted || session.closing) abort(); return await decision;
    } finally { options.signal.removeEventListener('abort', abort); session.approvals.delete(id); await session.subagents.permission(options.toolUseID, false, options.agentID); }
  }
  async answer(id: string, approvalId: string, decision: import('./provider-approvals.js').ApprovalDecision, answers: Record<string, string[]>) {
    const session = this.sessions.get(id); const approval = session?.approvals.get(approvalId); if (!approval) throw new Error('这次授权请求已过期');
    const input = approval.questions.length ? { ...approval.input, answers: Object.fromEntries(approval.questions.map(question => [question.question, (answers[question.id] ?? []).join(', ')])) } : approval.input;
    if (decision === 'cancel') approval.context.cancelled = true;
    approval.resolve(claudePermissionResult({ toolName: approval.toolName, toolUseID: approval.toolUseID, toolInput: input, suggestions: approval.suggestions, decision })); session!.approvals.delete(approvalId);
  }
  async steer(id: string, text: string, images: ExecutionImage[] = []) {
    const session = this.sessions.get(id); const context = session?.current; if (!session || !context?.accepting || !session.query) throw new Error('任务尚未进入可补充要求的阶段。');
    const uuid = randomUUID(); const message = await claudeUserMessage(session.threadId, text, uuid, images);
    context.pending.add(uuid); context.resultSeen = false; await context.update({ kind: 'backgroundWaiting', waiting: false }); session.inputs.push(message);
  }
  async waitNative(id: string, sessionId: string, key: string, signal: AbortSignal) {
    const session = this.sessions.get(id); const context = [...session?.contexts.values() ?? []].find(context => context.native && context.key === key);
    if (!session || session.token !== sessionId || !context) throw new Error('原生后续回复连接已不存在');
    await this.withSignal(context.done, signal);
  }
  async stopNative(id: string, sessionId: string) { const session = this.sessions.get(id); if (session?.token === sessionId) { session.stopRequested = true; await this.closeSession(session); } }
  async interruptNative(id: string, sessionId: string, key: string) {
    const session = this.sessions.get(id); const context = session?.current;
    if (!session || session.token !== sessionId || !context?.native || context.key !== key) return;
    await this.interruptContext(session, context);
  }
  async interruptExecution(task: WorkItem, runId: string) {
    const session = this.sessions.get(task.id);
    if (!session || session.token !== task.executionSessionId || session.threadId !== task.threadId || session.task.currentRunId !== runId) return;
    if (session.current) await this.interruptContext(session, session.current);
    else { if (!this.stopping) session.stopRequested = true; await this.closeSession(session); }
  }
  async settleBackground(task: WorkItem) {
    const session = this.sessions.get(task.id); if (!session) return;
    if (session.token !== task.executionSessionId || session.threadId !== task.threadId) throw new Error('后台工作已切换到另一个原生会话');
    if (session.current?.native && !session.closing) { await this.interruptContext(session, session.current); return; }
    if (session.current && !session.closing) throw new Error('新的回复已开始，请刷新后停止当前回复');
    session.stopRequested = true; await this.closeSession(session);
  }
  async stopBackground(task: WorkItem, work: NativeBackgroundWork) {
    const session = this.sessions.get(task.id); const current = session?.background.current(work.taskId);
    if (!session?.query || session.closing || session.token !== work.transportId || session.threadId !== work.sessionId || current?.id !== work.id || current.nativeRunId !== work.nativeRunId) throw new Error('后台任务的原生身份已改变');
    if (!ended(current)) await session.query.stopTask(work.taskId);
    const deadline = Date.now() + 10_000;
    while (true) {
      const latest = session.background.current(work.taskId);
      if (latest?.id !== work.id || session.closing) throw new Error('后台任务停止结果尚未确认');
      if (ended(latest) && session.publishedTerminal.has(latest.id)) return;
      if (Date.now() >= deadline) throw new Error('后台任务停止结果尚未确认');
      const source = session;
      await new Promise<void>(resolve => { const timer = setTimeout(done, Math.min(500, deadline - Date.now())); const wake = () => done(); source.listeners.add(wake);
        function done() { clearTimeout(timer); source.listeners.delete(wake); resolve(); } });
    }
  }
  private withSignal<T>(promise: Promise<T>, signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(new Error('任务已中止'));
    return new Promise<T>((resolve, reject) => { const abort = () => reject(new Error('任务已中止')); signal.addEventListener('abort', abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)); });
  }
  private interruptContext(session: Session, context: Context): Promise<void> {
    if (context.interruption) return context.interruption;
    if (session.current !== context || context.finished) return Promise.resolve();
    context.interrupted = true; context.accepting = false;
    session.subagents.ignoreFrames();
    if (!this.stopping) session.stopRequested = true;
    context.interruption = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await context.update({ kind: 'ready', canSteer: false });
        if (!this.stopping && context.started && !context.resultSeen && session.query && !session.closing) {
          await Promise.race([session.query.interrupt(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('interrupt timeout')), 10_000); })]);
        }
      } catch { /* Closing the exact owned CLI still settles this Stop. */ }
      finally { clearTimeout(timer); await this.closeSession(session); }
    })();
    return context.interruption;
  }
  private async closeSession(session: Session) {
    if (!session.closing) { session.closing = true; clearTimeout(session.idle); session.inputs.close(); session.controller.abort(); session.query?.close(); }
    await session.reader?.catch(() => {});
    if (!session.reader && this.sessions.get(session.taskId) === session) this.sessions.delete(session.taskId);
  }
  async close() { this.stopping = true; await Promise.all([...this.sessions.values()].filter(session => !session.current || session.current.native).map(session => this.closeSession(session))); }
}
