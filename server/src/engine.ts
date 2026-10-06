import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import { Harness, configure, createRegistry, defineExtension, defineTask, type Conversation, type ConversationId, type ModelRef, type TaskId, type DocumentWatch } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Executor, ExecutionUpdate, Workspace, WorkItem, TaskMode } from './types.js';
import { activeStatuses } from './types.js';
import { CodexExecutor } from './codex.js';
import { fileURLToPath } from 'node:url';
import { WorkspaceDoc } from './state.js';
import { ModelConnection } from './model.js';
import { FridayAssistant } from './assistant.js';

const now = () => new Date().toISOString();
const event = (kind: string, text: string) => ({ id: randomUUID(), kind, text, at: now() });
type Input = { id: string; predecessor: number | null; prompt: string };
type Checkpoint = { phase: 'queued' } | { phase: 'execute' };

export class Engine extends EventEmitter {
  harness!: Harness;
  root!: Conversation;
  watch?: DocumentWatch<Workspace>;
  private lease!: DatabaseSync;
  private closed = false;
  readonly execution;
  readonly response;
  readonly executor: Executor;
  readonly modelConnection: ModelConnection;
  readonly assistant: FridayAssistant;
  private readonly legacyDefault: boolean;
  constructor(readonly directory: string, executor?: Executor, readonly agentOptions?: { models: Models; model: ModelRef }) {
    super();
    this.executor = executor ?? new CodexExecutor();
    this.legacyDefault = executor !== undefined && agentOptions === undefined;
    this.modelConnection = new ModelConnection(directory);
    this.assistant = new FridayAssistant(this);
    this.response = this.createResponse();
    this.execution = defineTask<Input, Checkpoint, { status: string }, {}>({
      name: 'friday.execute', version: 1,
      initial: () => ({ phase: 'queued' }),
      phases: {
        queued: async (task, runtime, ctx) => {
          const predecessor = task.input.predecessor;
          await runtime.commit(() => predecessor === null
            ? { status: 'running', checkpoint: { phase: 'execute' } }
            : { status: 'waiting', checkpoint: { phase: 'execute' }, on: [predecessor as TaskId], policy: 'allSettled' }, ctx);
        },
        execute: async (task, runtime, ctx) => {
          const attempted = await runtime.memo<boolean>('external-started', ctx);
          if (attempted) {
            // An external turn may have executed before its receipt was persisted. Never replay it implicitly.
            await this.patchTask(task.input.id, item => {
              item.status = 'interrupted';
              item.error = '服务曾中断。已保留会话和执行记录；请检查成果，再补充要求或继续任务。';
              item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
              item.events.push(event('recovery', item.error));
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
            return;
          }
          await runtime.memo('external-started', true, ctx);
          await this.patchTask(task.input.id, item => { item.status = 'running'; item.error = null; item.events.push(event('status', '正在连接本地 Codex')); });
          try {
            const work = (await this.snapshot()).tasks.find(t => t.id === task.input.id)!;
            const result = await this.executor.run({ task: work, prompt: task.input.prompt, signal: runtime.signal, update: update => this.updateExecution(work.id, update) });
            const needsProject = !!(await this.snapshot()).tasks.find(t => t.id === work.id)?.workspaceRequest;
            if (needsProject) {
              await this.patchTask(work.id, item => {
                item.status = 'needs_project'; item.result = result; item.artifact = null;
                item.messages?.push({ id: randomUUID(), role: 'assistant', text: result });
                item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
              });
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'needs_project' } } }), ctx);
              return;
            }
            await writeFile(join(this.directory, 'artifacts', `${work.id}.md`), `# ${work.title}\n\n${result}\n`, { mode: 0o600 });
            await this.patchTask(work.id, item => {
              item.status = 'completed'; item.result = result; item.artifact = `${work.id}.md`;
              item.messages?.push({ id: randomUUID(), role: 'assistant', text: result });
              item.events.push(event('status', '成果已保存'));
              item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await this.patchTask(task.input.id, item => {
              item.status = 'failed'; item.error = error instanceof Error ? error.message : '执行失败';
              item.events.push(event('error', item.error));
              item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'failed' } } }), ctx);
          }
        },
      },
      abort: async (task, runtime, ctx) => {
        await this.patchTask(task.input.id, item => {
          item.status = 'cancelled'; item.events.push(event('status', '任务已取消；已经完成的外部操作不会自动撤销。'));
          item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
        });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx);
      },
    });
  }

  readonly createResponse = () => defineTask<Input & { requestId: string }, Checkpoint, { status: string }, {}>({
    name: 'friday.respond', version: 1, initial: () => ({ phase: 'queued' }),
    phases: {
      queued: async (task, runtime, ctx) => {
        await runtime.commit(() => task.input.predecessor === null
          ? { status: 'running', checkpoint: { phase: 'execute' } }
          : { status: 'waiting', checkpoint: { phase: 'execute' }, on: [task.input.predecessor as TaskId], policy: 'allSettled' }, ctx);
      },
      execute: async (task, runtime, ctx) => {
        try {
          if (!this.agentOptions) await this.modelConnection.ready();
          const work = (await this.snapshot()).tasks.find(t => t.id === task.input.id)!;
          await this.patchTask(work.id, item => { item.status = item.approvals.some(a => a.state === 'pending') ? 'waiting' : 'running'; item.error = null; });
          const result = await this.assistant.run(work, task.input.prompt, task.input.requestId, ctx);
          if ((await this.snapshot()).tasks.find(t => t.id === work.id)?.workspaceRequest) {
            await this.patchTask(work.id, item => { item.status = 'needs_project'; item.result = result; item.artifact = null; });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'needs_project' } } }), ctx);
            return;
          }
          await writeFile(join(this.directory, 'artifacts', `${work.id}.md`), `# ${work.title}\n\n${result}\n`, { mode: 0o600 });
          await this.patchTask(work.id, item => { item.status = 'completed'; item.result = result; item.artifact = `${work.id}.md`; item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; }); });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await this.patchTask(task.input.id, item => { item.status = 'failed'; item.error = error instanceof Error ? error.message : 'Friday 执行失败'; item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; }); });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'failed' } } }), ctx);
        }
      },
    },
    abort: async (task, runtime, ctx) => {
      const work = (await this.snapshot()).tasks.find(t => t.id === task.input.id)!;
      await this.assistant.abort(work);
      await this.patchTask(work.id, item => { item.status = 'cancelled'; item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; }); });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx);
    },
  });

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await mkdir(join(this.directory, 'artifacts'), { recursive: true, mode: 0o700 });
    // SQLite releases this exclusive writer lease automatically on process death.
    this.lease = new DatabaseSync(join(this.directory, 'owner.sqlite'));
    try { this.lease.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN IMMEDIATE'); }
    catch { this.lease.close(); throw new Error('已有 Friday 服务正在使用这个数据目录。'); }
    try {
      const registry = createRegistry();
      registry.install(defineExtension({ name: 'friday', tasks: [this.execution, this.response] }));
      registry.install(this.assistant.extension);
      this.harness = await Harness.open(await openNodeSqliteStorage(join(this.directory, 'friday.sqlite')), {
        models: this.agentOptions?.models ?? this.modelConnection.models, registry,
        settings: { toolExecution: 'sequential', retry: { maxRetries: 2 } },
        onReport: () => console.error('[Friday runtime] runtime failure'),
      }, context);
      this.root = await this.harness.root(context);
      await this.root.commit(async tx => { await tx.doc(WorkspaceDoc); }, context);
      await this.mutate(state => {
        for (const task of state.tasks) if (task.agent === 'friday') {
          for (const approval of task.approvals) if (approval.state === 'pending' && approval.method !== 'friday/requestUserInput') approval.state = 'expired';
        }
      });
      this.watch = await this.harness.watchDoc(WorkspaceDoc, context);
      this.watch?.start(async () => { this.emit('change'); });
      this.harness.resume();
      return this;
    } catch (error) { this.lease.close(); throw error; }
  }
  async snapshot(): Promise<Workspace> {
    return structuredClone((await this.harness.snapshot(WorkspaceDoc, context))!);
  }
  async mutate(change: (workspace: Workspace) => void) {
    await this.root.commit(async tx => { const workspace = await tx.doc(WorkspaceDoc); change(workspace); workspace.revision++; }, context);
  }
  async patchTask(id: string, change: (task: WorkItem) => void) {
    await this.mutate(workspace => {
      const item = workspace.tasks.find(t => t.id === id);
      if (!item) throw new Error('任务不存在');
      change(item); item.updatedAt = now();
      // ponytail: bounded per-task logs and one workspace snapshot suit personal use; split documents when lists grow.
      if (item.events.length > 120) item.events.splice(0, item.events.length - 120);
    });
  }
  async createTask(input: { prompt: string; projectId: string | null; mode: TaskMode; requestId: string; ideaId?: string; continueId?: string }) {
    if (['__proto__', 'constructor', 'prototype'].includes(input.requestId)) throw new Error('请求 ID 无效');
    const snapshot = await this.snapshot();
    if (Object.hasOwn(snapshot.requests, input.requestId)) return snapshot.requests[input.requestId];
    const previous = snapshot.tasks.find(t => t.id === input.continueId);
    const native = previous ? previous.agent === 'friday' : !this.legacyDefault;
    if (native && !this.agentOptions) await this.modelConnection.ready();
    const project = snapshot.projects.find(p => p.id === input.projectId);
    if (input.projectId && !project) throw new Error('项目不存在');
    if (input.mode === 'code' && !project) throw new Error('代码任务需要先选择一个项目目录');
    const skill = await readFile(fileURLToPath(new URL(`../../skills/${input.mode === 'auto' ? 'personal-assistant' : input.mode === 'code' ? 'code-validation' : 'project-research'}/SKILL.md`, import.meta.url)), 'utf8');
    const id = await this.root.commit(async tx => {
      const workspace = await tx.doc(WorkspaceDoc);
      if (Object.hasOwn(workspace.requests, input.requestId)) return workspace.requests[input.requestId];
      const sourceIdea = input.ideaId ? workspace.ideas.find(i => i.id === input.ideaId) : undefined;
      if (input.ideaId && !sourceIdea) throw new Error('想法不存在');
      if (sourceIdea?.taskId) return sourceIdea.taskId;
      let work = input.continueId ? workspace.tasks.find(t => t.id === input.continueId) : undefined;
      if (input.continueId && !work) throw new Error('任务不存在');
      if (work && activeStatuses.includes(work.status)) throw new Error('任务正在运行，请使用补充要求');
      if (work && input.projectId && work.projectId !== input.projectId) {
        if (work.status !== 'needs_project') throw new Error('当前对话没有等待选择工作目录');
        work.projectId = project!.id; work.cwd = project!.path;
      }
      if (!work && workspace.tasks.length >= 300) throw new Error('第一版最多保留 300 个任务；当前数据已保留，需要增加归档能力后才能创建更多任务。');
      const predecessor = workspace.queueTail ?? null;
      const stamp = now();
      const task: WorkItem = work ?? {
        id: randomUUID(), title: input.prompt.slice(0, 64), prompt: input.prompt, projectId: input.projectId,
        cwd: project?.path ?? join(this.directory, 'artifacts'), mode: input.mode, agent: native ? 'friday' : 'codex',
        status: 'queued', createdAt: stamp, updatedAt: stamp, durableId: null, threadId: null, turnId: null,
        result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: input.requestId,
        messages: [], workspaceRequest: null,
      };
      if (!task.messages) {
        task.messages = [{ id: randomUUID(), role: 'user', text: task.prompt }];
        if (task.result) task.messages.push({ id: randomUUID(), role: 'assistant', text: task.result });
      } else if (!native && work && task.result && task.messages.at(-1)?.text !== task.result) {
        task.messages.push({ id: randomUUID(), role: 'assistant', text: task.result });
      }
      task.messages.push({ id: randomUUID(), role: 'user', text: input.prompt });
      task.mode = input.mode; task.result = ''; task.artifact = null; task.workspaceRequest = null;
      const effectiveProject = workspace.projects.find(p => p.id === task.projectId);
      const prompt = [
        `Task: ${input.prompt}`,
        task.mode === 'auto'
          ? `Understand the user's intent and respond or act accordingly. ${effectiveProject ? 'The user selected the workspace below. Only modify files when requested; inspect and explain read-only requests without changing files.' : 'No workspace is selected. Answer questions and research normally. If a local workspace is needed, call friday_request_workspace and stop this turn. Never guess a working directory or attempt file changes before selection.'}`
          : `Mode: ${task.mode}. ${task.mode === 'research' ? 'Research and report. Do not modify project files. Cite sources when researching externally.' : 'Implement the requested change, perform relevant verification, and report the files changed.'}`,
        effectiveProject ? `Project: ${effectiveProject.name}\nProject context:\n${effectiveProject.context}` : '',
        workspace.memories.length ? `User-confirmed preferences:\n${workspace.memories.map(m => `- ${m.text}`).join('\n')}` : '',
        `Workflow skill:\n${skill}`,
        sourceIdea ? 'The user explicitly delegated this saved idea now. Act on it instead of saving the same idea again.' : '',
        work ? 'Continue this existing task. Check the current workspace and previous results before repeating any external operation.' : '',
      ].filter(Boolean).join('\n\n');
      if (native && !task.conversationId) {
        const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
        task.conversationId = conversation.id;
        await configure(tx, conversation.id, { model: this.agentOptions?.model ?? this.modelConnection.model, thinkingLevel: 'medium', extensions: [this.assistant.extension] });
      }
      const durableId = native
        ? await tx.createTask(this.response, { id: task.id, predecessor, prompt: input.prompt, requestId: input.requestId }, { ownership: { kind: 'conversation' } })
        : await tx.createTask(this.execution, { id: task.id, predecessor, prompt }, { ownership: { kind: 'conversation' } });
      workspace.queueTail = durableId;
      task.durableId = durableId; task.lastRequestId = input.requestId; task.status = 'queued'; task.error = null; task.turnId = null;
      task.updatedAt = stamp; task.events.push(event('user', input.prompt));
      if (!work) workspace.tasks.push(task);
      workspace.requests[input.requestId] = task.id;
      const idea = workspace.ideas.find(i => i.id === input.ideaId);
      if (idea) idea.taskId = task.id;
      workspace.revision++;
      return task.id;
    }, context);
    this.harness.resume();
    return id;
  }
  async updateExecution(id: string, update: ExecutionUpdate) {
    if (update.kind === 'idea') {
      await this.mutate(s => {
        const task = s.tasks.find(t => t.id === id);
        if (!task || !activeStatuses.includes(task.status)) return;
        if (!s.ideas.some(i => i.id === update.id)) s.ideas.unshift({ id: update.id, text: update.text, createdAt: now(), taskId: null });
      });
      return;
    }
    await this.patchTask(id, item => {
      if (!activeStatuses.includes(item.status)) return;
      if (update.kind === 'session') item.threadId = update.threadId;
      if (update.kind === 'turn') item.turnId = update.turnId;
      if (update.kind === 'output') item.result = update.text;
      if (update.kind === 'workspace' && !item.projectId) item.workspaceRequest = update.reason;
      if (update.kind === 'event') item.events.push(event(update.eventKind, update.text));
      if (update.kind === 'approval') { item.approvals.push(update.approval); item.status = 'waiting'; }
      if (update.kind === 'approvalResolved') {
        const approval = item.approvals.find(a => a.id === update.id);
        if (approval) approval.state = 'answered';
        if (!item.approvals.some(a => a.state === 'pending')) item.status = 'running';
      }
    });
  }
  async cancel(id: string) {
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    if (!task?.durableId) throw new Error('任务不存在');
    if (task.status === 'needs_project') {
      await this.patchTask(id, item => { item.status = 'cancelled'; item.workspaceRequest = null; });
      return;
    }
    if (!activeStatuses.includes(task.status)) return;
    await this.harness.abortTask(task.durableId as TaskId, context);
    await this.harness.waitForTask(task.durableId as TaskId, context);
  }
  async answer(id: string, approvalId: string, decision: 'accept' | 'decline', answers: Record<string, string[]>) {
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    const approval = task?.approvals.find(a => a.id === approvalId && a.state === 'pending');
    if (!approval) throw new Error('授权请求已过期');
    if (approval.method.includes('requestUserInput') && approval.questions.some(q => !answers[q.id]?.some(v => v.trim()))) throw new Error('请回答所有问题');
    if (approval.method.startsWith('friday/')) {
      await this.patchTask(id, item => { const a = item.approvals.find(a => a.id === approvalId)!; a.decision = decision; a.answers = answers; });
    } else await this.executor.answer(id, approvalId, decision, answers);
    await this.updateExecution(id, { kind: 'approvalResolved', id: approvalId });
    await this.patchTask(id, item => { item.events.push(event('decision', approval.method.includes('requestUserInput') ? '已提交补充信息' : decision === 'accept' ? '已允许本次操作' : '已拒绝本次操作')); });
  }
  async steer(id: string, text: string, requestId: string) {
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    if (task?.agent === 'friday') {
      if (task.status === 'queued') throw new Error('会话尚在排队，请开始后补充要求');
      const conversation = await this.harness.conversation(task.conversationId as ConversationId, context);
      if (!conversation) throw new Error('Friday 会话不存在');
      await conversation.submit({ type: 'input', content: text, requestId, whenBusy: 'steer' }, context);
    } else await this.executor.steer(id, text, requestId);
    await this.patchTask(id, item => {
      item.events.push(event('user', text));
      if (item.agent !== 'friday') item.messages?.push({ id: randomUUID(), role: 'user', text });
    });
  }
  async artifact(id: string) {
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    if (!task?.artifact) throw new Error('成果尚未生成');
    return readFile(join(this.directory, 'artifacts', `${task.id}.md`), 'utf8');
  }
  async close() {
    if (this.closed) return; this.closed = true;
    await this.modelConnection.close(); await this.harness.close(context); await this.watch?.stop(); this.lease.close(); this.removeAllListeners();
  }
}
