import { providerOptionSelections } from './provider-models.js';
import { ProviderInstances, providerDrivers, taskProviderInstance } from './provider-instances.js';
import { availableScratchRoot, ensureScratchRoot, isScratchProjectPath, planScratchWorkspace, verifyScratchWorkspace } from './managed-scratch-workspace.js';
import { ManagedProjectFolders, verifyManagedProjectFolder } from './managed-project-folders.js';
import {ProjectRepositoryOperations} from './project-repository-operations.js';
import { TaskProjectScripts } from './task-project-scripts.js';
import { TaskChangeRequestCheckouts } from './task-change-request-checkouts.js';
import { TaskChangeRequestStacks } from './task-change-request-stacks.js';
import { TaskReviewGuides } from './task-review-guides.js';
import { TaskHostBrowsers } from './task-host-browser.js';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskSearch } from './task-search.js';
import { TaskTitles } from './task-titles.js';
import { TaskNativeTurns } from './task-native-turns.js';
import { TaskNativeBackground } from './task-native-background.js';
import { backgroundWorkPending } from './native-runtime-types.js';
import { TaskBackgroundStops } from './task-background-stops.js';
import { TaskArchives } from './task-archive.js';
import { TaskSettles } from './task-settle-lifecycle.js';
import { ProviderCreditResets } from './provider-credit-resets.js';
import { TaskFeedback } from './task-feedback.js';
import { UsageLimitSources } from './usage-limit-sources.js';
import { providerDigest } from './provider-usage-limits.js';
import type { ApprovalDecision } from './provider-approvals.js';
import { TaskSubagents } from './task-subagents.js';
import { TaskSubagentHistory } from './task-subagent-history.js';
import { projectSubagentEvent, visibleSubagentIds } from './task-subagent-types.js';
import { TaskBackgroundCommands, backgroundCommandActivity, hasRunningBackgroundCommands } from './task-background-commands.js';
import { TextGenerationPreferences } from './text-generation-settings.js';
import { taskPullRequests } from './task-pull-requests.js';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai/models';
import { Harness, configure, createRegistry, defineExtension, defineTask, type Conversation, type ConversationId, type ModelRef, type TaskId, type DocumentWatch } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { Executor, ExecutionRequest, ExecutionUpdate, Workspace, WorkItem, TaskMode, TaskWorkspaceSelection, IdeaImage, TaskInteractionMode, TaskExecutionScope } from './types.js';
import { activeFork, runningFork, headForkSourceBusy, headForkSourceIDs, activeGitOperation, activeRewind, activeStatuses, failedWorkspacePreparation, taskExecutionScopeMatches } from './types.js';
import { IdeaImages } from './ideas.js';
import { CodexExecutor } from './codex.js';
import { fileURLToPath } from 'node:url';
import { WorkspaceDoc } from './state.js';
import { ModelConnection } from './model.js';
import { CodexConnection } from './codex-provider.js';
import { ClaudeConnection } from './claude-provider.js';
import { PiConnection } from './pi-provider.js';
import { PiExecutor } from './pi.js';
import { GrokConnection } from './grok-provider.js';
import { GrokExecutor } from './grok.js';
import { CursorConnection } from './cursor-provider.js';
import { CursorExecutor } from './cursor.js';
import { MuseConnection } from './muse-provider.js';
import { MuseExecutor } from './muse.js';
import { OpenCodeConnection } from './opencode-provider.js';
import { OpenCodeExecutor } from './opencode.js';
import { AcpProviderConnection } from './acp-provider.js';
import { AcpNativeExecutor } from './acp-native.js';
import { ClaudeExecutor } from './claude.js';
import { LocalAgentExecutor } from './local-agents.js';
import { FridayAssistant } from './assistant.js';
import { planExistingTaskWorkspace, planWorkspace, prepareWorkspace } from './task-workspace.js';
import { resolveSourceControlPreferences } from './source-control-preferences.js';
import { defineBranchSwitch, assertCheckoutIdle, branchBlocksTask } from './branch-switch.js';
import { applyTaskMetadata, priorTaskMetadata, recordTaskMetadata, taskCanSettle, type TaskMetadataChange } from './task-metadata.js';
import { applyTaskSidebarMove, pinOrderKeyBetween, taskSidebarSection, taskSidebarSettledAt, type TaskSidebarMove } from './task-sidebar-order.js';
import { taskSidebarActivity } from './task-sidebar-activity.js';
import { TaskSettlement } from './task-settlement.js';
import { TaskChangeRequestSync } from './task-change-request-sync.js';
import { TaskChangeRequestLinks } from './task-change-request-links.js';
import { TaskChangeRequestDiscovery } from './task-change-request-discovery.js';
import { TaskChangeRequestWatch } from './task-change-request-watch.js';
import { TaskRuntimeTools } from './task-runtime-tools.js';
import { canSnoozeTask, clearTaskSnooze, reconcileTaskSnooze, taskIsSnoozed, taskSnoozeWakeAt } from './task-snooze.js';
import { TaskQueue, queueRunning, type QueueMessageInput } from './task-queue.js';
import { currentTaskPlan, taskInteractionMode } from './task-plans.js';
import { TaskGitOperations } from './task-git-operations.js';
import { TaskChangeRequestActions } from './task-change-request-actions.js';
import { SourceControlConnections, type SourceControlConnectionOptions } from './source-control-connections.js';
import { SourceControlCredentials } from './source-control-credentials.js';
import { TaskRuns } from './task-runs.js';
import { TaskRewinds } from './task-rewinds.js';
import { TaskTerminals } from './task-terminals.js';
import { TaskContexts } from './task-contexts.js';
import { TaskFileWrites } from './task-file-writes.js';
import { TaskForks } from './task-forks.js';
import { TaskHistory, taskHistoryEpoch } from './task-history.js';
import { TaskPreparations } from './task-preparation.js';
import { TaskConversationHistory } from './task-conversation-history.js';
import { TaskCommandOutputs } from './task-output.js';
import { displayContextText } from './task-context-types.js';

const now = () => new Date().toISOString();
const event = (kind: string, text: string) => ({ id: randomUUID(), kind, text, at: now() });
const finishItems = (task: WorkItem, status: 'interrupted' | 'failed') => {
  for (const item of task.events) if (item.itemId && item.status === 'running') {
    if (task.nativeBackgroundConnected && task.nativeBackgroundWork?.some(work => work.origin?.eventId === item.id && work.member && !work.ambient && !['completed', 'failed', 'stopped'].includes(work.status))) continue;
    if (item.subagentId && task.subagents?.some(agent => agent.id === item.subagentId && agent.sessionId === task.executionSessionId && ['running', 'waiting'].includes(agent.status))) continue;
    item.status = status; item.completedAt = now();
    item.durationMs = Date.parse(item.completedAt) - Date.parse(item.at);
  }
};
const finishQueuedRun = (task: WorkItem, runID: string) => {
  const durableID = task.runs?.find(run => run.id === runID)?.durableId;
  if (durableID == null) return;
  for (const entry of task.queue?.messages ?? []) if (entry.runId === durableID && entry.status === 'running') {
    entry.status = task.status === 'completed' ? 'completed' : 'failed'; entry.error = task.error;
  }
};
export type ExecutionTaskInput = { id: string; predecessor: number | null; prompt: string; userText?: string; contextText?: string; images?: IdeaImage[]; runId?: string; command?: 'compact'; contextBeforeCompaction?: import('./task-context-usage.js').TaskContextUsage | null };
type Input = ExecutionTaskInput;
type Checkpoint = { phase: 'queued' } | { phase: 'execute' };
type ExecutionReceipt = { result: string; needsProject: boolean };

export class Engine extends EventEmitter {
  private scratchRootValue?: Promise<string | null>;
  getScratchWorkspaceRoot() { return this.scratchRootValue ??= availableScratchRoot(this.directory); }
  async ensureScratchProject(): Promise<import('./types.js').Project> {
    const root = await this.getScratchWorkspaceRoot();
    if (!root) throw new Error('此主机无法提供无项目任务，请检查数据目录及 Git 状态');
    await ensureScratchRoot(root);
    return this.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const existing = state.projects.find(project => isScratchProjectPath(project.path, root));
      if (existing) return { ...existing, isScratch: true };
      const stamp = now();
      const project = { id: randomUUID(), name: 'No project', path: root, context: '', icon: 'ellipsis.message', color: 'gray', createdAt: stamp, updatedAt: stamp };
      state.projects.push(project); state.revision++; return { ...project, isScratch: true };
    }, context);
  }
  readonly streamSession = randomUUID();
  readonly taskSearch: TaskSearch;
  readonly taskTitles: TaskTitles;
  readonly textGeneration: TextGenerationPreferences;
  readonly taskSettlement: TaskSettlement;
  readonly nativeTurns: TaskNativeTurns;
  readonly nativeBackground: TaskNativeBackground;
  readonly backgroundCommands: TaskBackgroundCommands;
  readonly backgroundStops: TaskBackgroundStops;
  readonly archives: TaskArchives;
  readonly settles: TaskSettles;
  readonly providerCreditResets: ProviderCreditResets;
  readonly taskFeedback: TaskFeedback;
  readonly usageLimitSources: UsageLimitSources;
  readonly subagents: TaskSubagents;
  readonly subagentHistory: TaskSubagentHistory;
  harness!: Harness;
  root!: Conversation;
  watch?: DocumentWatch<Workspace>;
  private lease!: DatabaseSync;
  private closed = false;
  readonly execution;
  readonly response;
  readonly branchSwitch;
  readonly taskQueue: TaskQueue;
  readonly gitOperations: TaskGitOperations;
  readonly reviewGuides: TaskReviewGuides;
  readonly changeRequests: TaskChangeRequestActions;
  readonly changeRequestCheckouts: TaskChangeRequestCheckouts;
  readonly changeRequestStacks: TaskChangeRequestStacks;
  readonly sourceControl: SourceControlConnections;
  readonly changeRequestSync: TaskChangeRequestSync;
  readonly changeRequestLinks: TaskChangeRequestLinks;
  readonly changeRequestDiscovery: TaskChangeRequestDiscovery;
  readonly changeRequestWatch: TaskChangeRequestWatch;
  readonly runtimeTools: TaskRuntimeTools;
  readonly taskRuns: TaskRuns;
  readonly taskRewinds: TaskRewinds;
  readonly terminals: TaskTerminals;
  readonly hostBrowsers: TaskHostBrowsers;
  readonly contexts: TaskContexts;
  readonly fileWrites: TaskFileWrites;
  readonly managedProjects: ManagedProjectFolders;
  readonly projectRepositories:ProjectRepositoryOperations;
  readonly taskForks: TaskForks;
  readonly taskHistory: TaskHistory;
  readonly projectScripts: TaskProjectScripts;
  readonly taskPreparations: TaskPreparations;
  readonly conversationHistory: TaskConversationHistory;
  readonly commandOutputs: TaskCommandOutputs;
  readonly executor: Executor;
  readonly modelConnection: ModelConnection;
  readonly assistant: FridayAssistant;
  readonly providerInstances: ProviderInstances;
  readonly codexConnection: CodexConnection;
  readonly claudeConnection: ClaudeConnection;
  readonly piConnection: PiConnection;
  readonly grokConnection: GrokConnection;
  readonly cursorConnection: CursorConnection;
  readonly museConnection: MuseConnection;
  readonly opencodeConnection: OpenCodeConnection;
  readonly acpRegistryConnection: AcpProviderConnection;
  readonly antigravityConnection: AcpProviderConnection;
  private readonly customExecutor: boolean;
  constructor(readonly directory: string, executor?: Executor, readonly agentOptions?: { models: Models; model: ModelRef }, sourceControlOptions?: SourceControlConnectionOptions, providerOptions?: { cursor?: { sdkModule?: string }; acpRegistry?: ConstructorParameters<typeof AcpProviderConnection>[2]; antigravity?: ConstructorParameters<typeof AcpProviderConnection>[2] }) {
    super();
    this.sourceControl = new SourceControlConnections(new SourceControlCredentials(directory), sourceControlOptions);
    this.changeRequestSync = new TaskChangeRequestSync(this, sourceControlOptions?.changeRequestSyncIntervalMs);
    this.changeRequestLinks = new TaskChangeRequestLinks(this);
    this.changeRequestDiscovery = new TaskChangeRequestDiscovery(this, sourceControlOptions?.changeRequestSyncIntervalMs);
    this.changeRequestWatch = new TaskChangeRequestWatch(this, sourceControlOptions?.changeRequestWatchIntervalMs ?? (sourceControlOptions?.changeRequestSyncIntervalMs === 0 ? 0 : 120_000));
    this.runtimeTools = new TaskRuntimeTools(this);
    this.fileWrites = new TaskFileWrites(this);
    this.managedProjects = new ManagedProjectFolders(this);
    this.projectRepositories = new ProjectRepositoryOperations(this,sourceControlOptions?.execute);
    this.taskSearch = new TaskSearch(directory);
    this.customExecutor = executor !== undefined;
    this.modelConnection = new ModelConnection(directory);
    this.providerInstances = new ProviderInstances(directory, (driver, path) => {
      switch (driver) {
        case 'codex': { const connection = new CodexConnection(path); return { connection, executor: new CodexExecutor(undefined, connection, () => this.snapshot()) }; }
        case 'claude': { const connection = new ClaudeConnection(path); return { connection, executor: new ClaudeExecutor(connection) }; }
        case 'pi': { const connection = new PiConnection(path); return { connection, executor: new PiExecutor(connection) }; }
        case 'grok': { const connection = new GrokConnection(path); return { connection, executor: new GrokExecutor(connection) }; }
        case 'cursor': { const connection = new CursorConnection(path, providerOptions?.cursor); return { connection, executor: new CursorExecutor(connection) }; }
        case 'muse': { const connection = new MuseConnection(path); return { connection, executor: new MuseExecutor(connection) }; }
        case 'opencode': { const connection = new OpenCodeConnection(path); return { connection, executor: new OpenCodeExecutor(connection) }; }
        case 'acp-registry': case 'antigravity': { const connection = new AcpProviderConnection(path, driver, { ...(driver === 'acp-registry' ? providerOptions?.acpRegistry : providerOptions?.antigravity), credentialDirectory: directory }); return { connection, executor: new AcpNativeExecutor(connection) }; }
      }
    }, async (id, driver) => { await this.providerConfigurationChanged(id); if (id !== driver) await this.providerConfigurationChanged(driver); },
    async (id, activeOnly = false) => { const state = await this.snapshot(); return state.tasks.some(task => taskProviderInstance(task) === id && (!activeOnly || activeStatuses.includes(task.status) || backgroundWorkPending(task) || task.backgroundStop?.status === 'pending' || activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || runningFork(task.forkOperation))) || Object.values(state.titleRequests ?? {}).some(request => request.status === 'pending' && (request.modelSelection?.providerInstanceId ?? request.modelSelection?.agent) === id) || state.tasks.some(task => activeGitOperation(task.gitOperation) && (task.gitOperation?.generationModelSelection?.providerInstanceId ?? task.gitOperation?.generationModelSelection?.agent) === id || task.changeRequestGuideRuns?.some(run => ['queued', 'running'].includes(run.status) && (run.modelSelection.providerInstanceId ?? run.modelSelection.agent) === id)) || Object.values(state.providerCreditResets ?? {}).some(receipt => ['queued', 'running', 'uncertain'].includes(receipt.status) && (receipt.scope.providerInstanceId ?? receipt.scope.provider) === id); });
    this.codexConnection = this.providerInstances.default('codex');
    this.claudeConnection = this.providerInstances.default('claude');
    this.piConnection = this.providerInstances.default('pi');
    this.grokConnection = this.providerInstances.default('grok');
    this.cursorConnection = this.providerInstances.default('cursor');
    this.museConnection = this.providerInstances.default('muse');
    this.opencodeConnection = this.providerInstances.default('opencode');
    this.acpRegistryConnection = this.providerInstances.default('acp-registry');
    this.antigravityConnection = this.providerInstances.default('antigravity');
    this.executor = executor ?? new LocalAgentExecutor(this.providerInstances.defaultExecutors(), { resolve: task => this.providerInstances.executor(task), close: () => this.providerInstances.close() });
    this.assistant = new FridayAssistant(this);
    this.response = this.createResponse();
    this.branchSwitch = defineBranchSwitch(this);
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
          const runID = task.input.runId ?? String(task.id);
          await this.taskRuns.ensure(task.input.id, task.id, runID);
          // The cancellation claim and before-start claim share the Durable root
          // transaction. Recovery honors a saved claim before any external turn.
          const cancellationOwner = (await this.snapshot()).tasks.find(item => item.id === task.input.id);
          if (cancellationOwner?.durableId === task.id && cancellationOwner.currentRunId === runID && (cancellationOwner.archivedAt || cancellationOwner.runs?.find(run => run.id === runID)?.workspacePreparation?.cancelRequestedAt)) {
            await this.taskQueue.pause(task.input.id, { runId: runID });
            await this.projectScripts.stopTask(task.input.id, true);
            await this.taskRuns.finish(task.input.id, runID, 'cancelled');
            await this.patchTask(task.input.id, item => {
              item.status = 'cancelled'; item.canSteer = false; item.error = null; finishQueuedRun(item, runID);
              const preparation = item.runs!.find(run => run.id === runID)!.workspacePreparation;
              if (preparation) { preparation.status = 'cancelled'; preparation.completedAt = now(); }
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx); return;
          }
          const attempted = await runtime.memo<boolean>('external-started', ctx);
          let receipt = await runtime.memo<ExecutionReceipt>('external-result', ctx);
          const recovering = attempted && receipt !== undefined;
          const current = (await this.snapshot()).tasks.find(item => item.id === task.input.id);
          if (!current || current.durableId !== task.id) {
            const status = current?.runs?.find(run => run.id === runID)?.status ?? 'interrupted';
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx); return;
          }
          if (attempted && !receipt) {
            // An external turn may have executed before its receipt was persisted. Never replay it implicitly.
            await this.taskRuns.finish(task.input.id, runID, 'interrupted', 'uncertain');
            await this.patchTask(task.input.id, item => {
              item.status = 'interrupted';
              item.canSteer = false;
              finishItems(item, 'interrupted');
              item.error = '服务曾中断。已保留会话和执行记录；请检查成果，再补充要求或继续任务。';
              finishQueuedRun(item, runID);
              item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
              item.events.push(event('recovery', item.error));
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
            return;
          }
          if (!receipt) await this.patchTask(task.input.id, item => { item.status = 'running'; item.error = null; item.events.push(event('status', item.agent === 'acp-registry' ? '正在连接原生 ACP 工具' : item.agent === 'antigravity' ? '正在连接 Antigravity' : item.agent === 'cursor' ? '正在连接 Cursor SDK' : item.agent === 'muse' ? '正在连接本地 Muse' : item.agent === 'opencode' ? '正在连接 OpenCode' : item.agent === 'grok' ? '正在连接本地 Grok' : item.agent === 'pi' ? '正在连接本地 Pi' : item.agent === 'claude' ? '正在连接本地 Claude' : '正在连接本地 Codex')); });
          let preparingWorkspace = false;
          let finalize!: () => void;
          const finalized = new Promise<void>(resolve => { finalize = resolve; });
          try {
            let work = (await this.snapshot()).tasks.find(t => t.id === task.input.id)!;
            if (!receipt && work.executionWorkspace && work.executionWorkspace.state !== 'ready') {
              preparingWorkspace = true;
              await this.patchTask(work.id, item => {
                const run = item.runs!.find(run => run.id === runID)!;
                run.workspacePreparation ??= { status: 'preparing', attempt: 1, startedAt: now() };
                run.workspacePreparation.status = 'preparing';
              });
              const plan = work.executionWorkspace;
              await prepareWorkspace(plan, async () => {
                if (plan.mode === 'checkout' && !plan.scratch && (await this.snapshot()).tasks.some(other => {
                  const path = relative(plan.root, other.cwd);
                  return other.id !== work.id && ['running', 'waiting'].includes(other.status)
                    && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
                })) throw new Error('当前工作区有正在执行的任务，请等待完成或选择 New Worktree。');
                await this.patchTask(work.id, item => { item.executionWorkspace!.state = 'preparing'; });
              }, runtime.signal, async patch => {
                runtime.signal.throwIfAborted();
                await this.patchTask(work.id, item => {
                  if (item.currentRunId !== runID || item.runs!.find(run => run.id === runID)!.workspacePreparation?.cancelRequestedAt) throw new Error('工作区准备范围已改变或已停止');
                  Object.assign(item.executionWorkspace!, patch);
                });
              });
              await this.patchTask(work.id, item => {
                item.executionWorkspace!.state = 'ready'; item.cwd = item.executionWorkspace!.cwd;
                const preparation = item.runs!.find(run => run.id === runID)!.workspacePreparation!;
                preparation.status = 'ready'; preparation.completedAt = now(); preparation.checkoutCompletedAt = preparation.completedAt; delete preparation.error;
              });
              preparingWorkspace = false;
              work = (await this.snapshot()).tasks.find(t => t.id === task.input.id)!;
            }
            if (!receipt && work.executionWorkspace?.state === 'ready' && work.runs?.find(run => run.id === runID)?.workspacePreparation?.status === 'preparing') {
              await this.patchTask(work.id, item => {
                const preparation = item.runs!.find(run => run.id === runID)!.workspacePreparation!;
                preparation.status = 'ready'; preparation.completedAt = now(); preparation.checkoutCompletedAt = preparation.completedAt; delete preparation.error;
              });
            }
            if (!receipt && work.executionWorkspace?.scratch) await verifyScratchWorkspace(work.executionWorkspace);
            if (!receipt && work.executionWorkspace?.projectFolder) await verifyManagedProjectFolder(work.executionWorkspace.projectFolder,this.directory);
            if (!receipt && work.executionWorkspace?.mode === 'worktree' && work.projectId && work.runs?.find(run => run.id === runID)?.workspacePreparation && !await runtime.memo<boolean>('setup-handoff', ctx)) {
              preparingWorkspace = true;
              const attempt = work.runs!.find(run => run.id === runID)!.workspacePreparation!.attempt;
              let runId = await runtime.memo<string | null>('setup-run', ctx);
              if (runId === undefined) { runId = await this.projectScripts.setup({ projectId: work.projectId, taskId: work.id, plan: work.executionWorkspace, requestId: 'setup-' + work.id + '-' + runID + (attempt > 1 ? '-attempt-' + attempt : '') }); await runtime.memo('setup-run', runId, ctx); }
              await this.patchTask(work.id, item => {
                const preparation = item.runs!.find(run => run.id === runID)!.workspacePreparation!;
                preparation.setupRunId = runId!; preparation.setupResolvedAt ??= now();
              });
              if (runId) await this.projectScripts.handoff(runId, runtime.signal);
              await runtime.memo('setup-handoff', true, ctx);
              preparingWorkspace = false;
            }
            if (!receipt) {
              const executionImages = await new IdeaImages(this.directory).resolve(task.input.images);
              runtime.signal.throwIfAborted();
              let starting: Promise<void> | undefined;
              const beforeStart = () => starting ??= (async () => {
                runtime.signal.throwIfAborted(); await this.taskRuns.before(work.id, runID, runtime.signal);
                await runtime.memo('external-started', true, ctx); runtime.signal.throwIfAborted();
              })();
              if (!this.executor.deferredStart?.(work.agent)) await beforeStart();
              const tools = !task.input.command && work.projectId && !work.subagentOrigin && this.executor.supportsTaskTools?.(work.agent) ? await this.runtimeTools.bind(work, runID, runtime.signal) : undefined;
              const createNativeTaskMcp: ExecutionRequest['createNativeTaskMcp'] = tools ? async (sessionId, currentRun, signal) => {
                const current = (await this.snapshot()).tasks.find(task => task.id === work.id);
                if (!current || current.executionSessionId !== sessionId && (current.currentRunId !== runID || current.turnId != null) || current.agent !== work.agent || taskProviderInstance(current) !== taskProviderInstance(work) || current.cwd !== work.cwd || current.projectId !== work.projectId) throw new Error('原生任务工具的会话范围已改变');
                return (await this.runtimeTools.bind(current, runID, signal, { sessionId, currentRun })).connection;
              } : undefined;
              let result: string;
              try { result = await this.executor.run({ task: work, prompt: task.input.prompt, ...(task.input.userText !== undefined ? { userText: task.input.userText } : {}), ...(task.input.contextText !== undefined ? { contextText: task.input.contextText } : {}), ...(task.input.command ? { command: task.input.command, contextBeforeCompaction: task.input.contextBeforeCompaction } : {}), images: executionImages, signal: runtime.signal, update: update => this.updateExecution(work.id, update, runID), beforeStart, finalized, nativeTurnFinalized: async (sessionId, key) => { const receipt = Object.values((await this.snapshot()).nativeTurnRequests ?? {}).find(receipt => receipt.taskId === work.id && receipt.sessionId === sessionId && receipt.key === key); if (receipt) await this.harness.waitForTask(receipt.durableId as TaskId, context); }, ...(tools ? { taskMcp: tools.connection, createNativeTaskMcp } : {}) }); }
              finally { tools?.release(); }
              receipt = { result, needsProject: !!(await this.snapshot()).tasks.find(t => t.id === work.id)?.workspaceRequest };
              await runtime.memo('external-result', receipt, ctx);
            }
            const { result, needsProject } = receipt;
            await this.taskRuns.finish(work.id, runID, needsProject ? 'needs_project' : 'completed', recovering ? 'completed' : undefined);
            if (task.input.command === 'compact') {
              await this.patchTask(work.id, item => {
                item.status = 'completed'; item.canSteer = false; item.error = null;
                if (!item.events.some(event => event.kind === 'compaction' && event.runId === runID)) item.events.push({ ...event('compaction', '上下文压缩完成'), id: 'compact-' + runID, runId: runID });
                finishQueuedRun(item, runID);
              });
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx); return;
            }
            if (needsProject) {
              await this.patchTask(work.id, item => {
                item.status = 'needs_project'; item.result = result; item.artifact = null; item.canSteer = false;
                finishQueuedRun(item, runID);
                if (!item.messages?.some(message => message.role === 'assistant' && message.runId === runID)) item.messages?.push({ id: randomUUID(), role: 'assistant', text: result, at: now(), runId: runID, ...(item.turnId ? { turnId: item.turnId } : {}) });
                item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
              });
              await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'needs_project' } } }), ctx);
              return;
            }
            await writeFile(join(this.directory, 'artifacts', `${work.id}.md`), `# ${work.title}\n\n${result}\n`, { mode: 0o600 });
            await this.patchTask(work.id, item => {
              item.status = 'completed'; item.result = result; item.artifact = `${work.id}.md`;
              finishQueuedRun(item, runID);
              item.canSteer = false;
              item.unread = true;
              if (!item.messages?.some(message => message.role === 'assistant' && message.runId === runID)) item.messages?.push({ id: randomUUID(), role: 'assistant', text: result, at: now(), runId: runID, ...(item.turnId ? { turnId: item.turnId } : {}) });
              item.events.push(event('status', '成果已保存'));
              item.approvals.forEach(a => { if (a.state === 'pending' && !(a.subagentId && item.subagents?.some(child => child.id === a.subagentId && child.sessionId === item.executionSessionId && ['running', 'waiting'].includes(child.status)))) a.state = 'expired'; });
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            const cancelled = error instanceof Error && error.name === 'TaskExecutionCancelled' || !!(await this.snapshot()).tasks.find(item => item.id === task.input.id)?.runs?.find(run => run.id === runID)?.workspacePreparation?.cancelRequestedAt;
            await this.taskRuns.finish(task.input.id, runID, cancelled ? 'cancelled' : 'failed');
            await this.patchTask(task.input.id, item => {
              item.status = cancelled ? 'cancelled' : 'failed'; item.error = cancelled ? null : error instanceof Error ? error.message : '执行失败';
              finishQueuedRun(item, runID);
              const preparation = item.runs!.find(run => run.id === runID)!.workspacePreparation;
              if (preparation && (preparingWorkspace || cancelled)) {
                preparation.status = cancelled ? 'cancelled' : 'failed'; if (item.error) preparation.error = item.error; preparation.completedAt = now();
              }
              item.canSteer = false;
              item.unread = true;
              finishItems(item, 'failed');
              item.events.push(event(cancelled ? 'status' : 'error', item.error ?? '工作区准备已停止'));
              item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
            });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: cancelled ? 'cancelled' : 'failed' } } }), ctx);
          } finally { finalize(); }
        },
      },
      abort: async (task, runtime, ctx) => {
        const runID = task.input.runId ?? String(task.id);
        const work = (await this.snapshot()).tasks.find(work => work.id === task.input.id);
        if (!await runtime.memo<boolean>('external-started', ctx)) await this.projectScripts.stopTask(task.input.id, true);
        if (work) await this.executor.interruptExecution?.(work, runID);
        await this.taskRuns.finish(task.input.id, runID, 'cancelled');
        await this.patchTask(task.input.id, item => {
          item.status = 'cancelled'; item.canSteer = false; item.events.push(event('status', '任务已取消；已经完成的外部操作不会自动撤销。'));
          finishQueuedRun(item, runID);
          const preparation = item.runs?.find(run => run.id === runID)?.workspacePreparation;
          if (preparation && !item.runs?.find(run => run.id === runID)?.startedAt && !item.runs?.find(run => run.id === runID)?.before) { preparation.status = 'cancelled'; preparation.completedAt = now(); }
          finishItems(item, 'interrupted');
          item.approvals.forEach(a => { if (a.state === 'pending') a.state = 'expired'; });
        });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx);
      },
    });
    this.taskQueue = new TaskQueue(this);
    this.textGeneration = new TextGenerationPreferences(this);
    this.taskSettlement = new TaskSettlement(this);
    this.nativeTurns = new TaskNativeTurns(this);
    this.nativeBackground = new TaskNativeBackground(this);
    this.backgroundCommands = new TaskBackgroundCommands(this);
    this.backgroundStops = new TaskBackgroundStops(this);
    this.archives = new TaskArchives(this);
    this.settles = new TaskSettles(this);
    this.providerCreditResets = new ProviderCreditResets(this);
    this.taskFeedback = new TaskFeedback(this);
    this.usageLimitSources = new UsageLimitSources(this);
    this.subagents = new TaskSubagents(this);
    this.subagentHistory = new TaskSubagentHistory(this);
    this.taskTitles = new TaskTitles(this);
    this.gitOperations = new TaskGitOperations(this);
    this.changeRequests = new TaskChangeRequestActions(this);
    this.changeRequestCheckouts = new TaskChangeRequestCheckouts(this);
    this.changeRequestStacks = new TaskChangeRequestStacks(this);
    this.reviewGuides = new TaskReviewGuides(this);
    this.taskRuns = new TaskRuns(this);
    this.taskRewinds = new TaskRewinds(this);
    this.terminals = new TaskTerminals(this);
    this.hostBrowsers = new TaskHostBrowsers(this.directory);
    this.contexts = new TaskContexts(this);
    this.taskForks = new TaskForks(this);
    this.taskHistory = new TaskHistory(this);
    this.projectScripts = new TaskProjectScripts(this);
    this.taskPreparations = new TaskPreparations(this);
    this.conversationHistory = new TaskConversationHistory(this);
    this.commandOutputs = new TaskCommandOutputs(this);
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
      registry.install(defineExtension({ name: 'friday', tasks: [this.projectRepositories.definition, this.execution, this.response, this.branchSwitch, this.taskQueue.definition, this.projectScripts.definition, this.taskTitles.definition, this.gitOperations.definition, this.changeRequests.definition, this.changeRequestStacks.definition, this.changeRequestCheckouts.definition, this.reviewGuides.definition, this.taskRewinds.definition, this.terminals.definition, this.taskForks.definition, this.backgroundCommands.definition, this.nativeTurns.definition, this.nativeBackground.definition, this.backgroundStops.definition, this.subagents.definition, this.archives.definition, this.settles.definition, this.providerCreditResets.definition, this.taskFeedback.definition, this.usageLimitSources.definition] }));
      registry.install(this.assistant.extension);
      this.harness = await Harness.open(await openNodeSqliteStorage(join(this.directory, 'friday.sqlite')), {
        models: this.agentOptions?.models ?? this.modelConnection.models, registry,
        settings: { toolExecution: 'sequential', retry: { maxRetries: 2 } },
        onReport: () => console.error('[Friday runtime] runtime failure'),
      }, context);
      this.root = await this.harness.root(context);
      await this.root.commit(async tx => { const state = await tx.doc(WorkspaceDoc); state.projectScriptSettles ??= {}; for (const task of state.tasks) if (task.settledAt && (!task.settleCleanup || task.settleCleanup.status === 'completed')) state.projectScriptSettles[task.id] ??= task.settledAt; }, context);
      await this.terminals.open();
      await this.contexts.open();
      await this.taskHistory.recoverIndexes();
      await this.taskPreparations.recoverMetadata();
      await this.taskTitles.recover();
      await this.backgroundCommands.recover();
      await this.nativeBackground.recover();
      await this.subagents.recover();
      await this.mutate(state => {
        for (const receipt of Object.values(state.approvalResponses ?? {})) if (receipt.status === 'sending') receipt.status = 'uncertain';
        for (const task of state.tasks) for (const approval of task.approvals) if (approval.responseStatus === 'sending') approval.responseStatus = 'uncertain';
        if (state.assistantQueueTail === undefined) {
          // Upgrade the former shared queue without making a child depend on its parent.
          const latest = (agent: string) => state.tasks.filter(t => t.agent === agent && t.durableId !== null).reduce<number | null>((id, t) => Math.max(id ?? 0, t.durableId!), null);
          state.assistantQueueTail = latest('friday'); state.queueTail = latest('codex');
        }
        for (const task of state.tasks) {
          if (task.agent !== 'friday' && (task.canSteer !== undefined || activeStatuses.includes(task.status))) task.canSteer = false;
          for (const message of task.messages ?? []) if (message.delivery === 'sending') { message.delivery = 'uncertain'; this.taskHistory.messageChanged(task, message.id); }
        }
        for (const task of state.tasks) for (const message of task.queue?.messages ?? []) {
          if (message.status === 'steering') {
            const receipt = task.messages?.find(item => item.id === message.dispatchId)?.delivery;
            message.status = receipt === 'sent' ? 'completed' : receipt ? 'uncertain' : 'queued';
            message.error = message.status === 'uncertain' ? '服务曾中断，补充要求的发送结果待确认。' : null;
          }
        }
        for (const task of state.tasks) if (task.agent === 'friday') {
          for (const approval of task.approvals) if (approval.state === 'pending' && approval.method !== 'friday/requestUserInput') approval.state = 'expired';
        }
      });
      await this.taskQueue.recover();
      this.watch = await this.harness.watchDoc(WorkspaceDoc, context);
      this.watch?.start(async () => { this.emit('change'); this.changeRequestSync.notify(); this.changeRequestWatch.reconcile(); });
      this.sourceControl.reads.start();
      this.harness.resume();
      await this.taskSettlement.start();
      this.usageLimitSources.start();
      this.changeRequestSync.start();
      this.changeRequestDiscovery.start();
      this.changeRequestWatch.start();
      return this;
    } catch (error) { await this.runtimeTools.close(); await this.changeRequestWatch.close(); await this.changeRequestSync.close(); await this.changeRequestDiscovery.close(); this.changeRequestLinks.close(); await this.sourceControl.close(); await this.terminals.close().catch(() => {}); this.contexts.close(); await this.harness?.close(context).catch(() => {}); this.lease.close(); throw error; }
  }
  async snapshot(): Promise<Workspace> {
    const state: Workspace = structuredClone((await this.harness.snapshot(WorkspaceDoc, context))!);
    const scratchRoot = await this.getScratchWorkspaceRoot();
    state.projects = state.projects.map(project => { const { isScratch: _, ...saved } = project; return isScratchProjectPath(project.path, scratchRoot) ? { ...saved, isScratch: true } : saved; });
    const visibleChildren = visibleSubagentIds(state.tasks);
    state.tasks = state.tasks.filter(task => !task.subagentOrigin || visibleChildren.has(task.id));
    const tasksById = new Map(state.tasks.map(task => [task.id, task]));
    for (const task of state.tasks) if (!task.subagentOrigin && task.subagents) task.subagents = task.subagents.filter(agent => visibleChildren.has(agent.childTaskId));
    const snapshotAt = Date.now();
    const headForkSources = headForkSourceIDs(state.tasks);
    for (const task of state.tasks) {
      task.nativeHeadForkPending = headForkSources.has(task.id);
      for (const agent of task.subagents ?? []) {
        const work = task.nativeBackgroundWork?.find(work => work.taskId === agent.nativeId && work.transportId === agent.sessionId && work.nativeRunId === agent.nativeRunId);
        agent.canStop = agent.provider === 'codex'
          ? Boolean(typeof this.executor.stopSubagent === 'function' && (agent.nativeRunId && (['running', 'waiting'].includes(agent.status) || agent.status === 'unknown' && !this.executor.hasSession?.(task.id)) || agent.backgroundCommands || agent.unknownCommands) && task.executionSessionId === agent.sessionId && agent.stop?.status !== 'pending' && task.backgroundStop?.status !== 'pending')
          : Boolean(work && ['running', 'waiting'].includes(agent.status) && task.nativeBackgroundConnected && task.executionSessionId === agent.sessionId && work.stop?.status !== 'pending' && task.backgroundStop?.status !== 'pending');
        if (work?.stop) agent.stop = work.stop;
      }
      const pending = task.approvals.find(approval => approval.subagentId && approval.state === 'pending');
      if (pending) task.pendingSubagentRequest = pending.method.includes('requestUserInput') ? 'user_input' : 'approval';
      const terminals = this.terminals.summaries(task.id); if (terminals.length) task.terminals = terminals;
      if (task.subagentOrigin) task.subagents = tasksById.get(task.subagentOrigin.rootTaskId)?.subagents?.filter(agent => agent.parentSubagentId === task.subagentOrigin!.subagentId);
      if (task.agent !== 'friday') { task.history = this.taskHistory.info(task); task.pullRequests = taskPullRequests(task); task.titleGenerationSupported = !task.subagentOrigin && this.taskTitles.supported; task.sidebarSettledAt = taskSidebarSettledAt(task); task.sidebarActivity = taskSidebarActivity(task); task.settlementManaged = true;
        task.snoozed = taskIsSnoozed(task, snapshotAt); task.snoozeWakeAt = taskSnoozeWakeAt(task, snapshotAt); task.canSnooze = canSnoozeTask(task); task.canSettle = taskCanSettle(task);
        task.backgroundActivity = backgroundCommandActivity(task);
      }
    }
    let projectScriptTerminalsBusy = false; try { projectScriptTerminalsBusy = this.terminals.store.list().some(t => t.taskId.startsWith('script-') && (t.hasRunningSubprocess || ['starting','closing'].includes(t.status))); } catch {}
    return { ...state, projectScriptTerminalsBusy, sourceControlPreferencesVersion: state.sourceControlPreferences?.version ?? 0, textGenerationSettingsVersion: state.textGenerationSettings?.version ?? 0, taskSidebarOrderingSupported: true, taskSidebarProjectScopesSupported: true, taskScratchWorkspaceSupported: true, projectRepositoryOperationsSupported: true, namedProjectCreationSupported: true, newProjectsRoot: await this.managedProjects.root(), ...(scratchRoot ? { scratchWorkspaceRoot: scratchRoot } : {}), taskExistingWorkspaceSupported: true, taskComposerCommandsSupported: true, taskArchiveLifecycleSupported: true, providerResetCreditsSupported: true, usageLimitSourcesSupported: true, taskSidebarWorkingSupported: true, taskAutoSettlementSupported: true, taskBackgroundCommandsSupported: typeof this.executor.stopBackgroundCommand === 'function', taskNativeBackgroundSupported: typeof this.executor.stopNativeBackground === 'function', taskBackgroundSettlementSupported: typeof this.executor.stopBackgroundCommand === 'function' || typeof this.executor.settleNativeBackground === 'function', taskSettlementSettingsVersion: state.taskSettlementSettings?.version ?? 0 };
  }
  async taskSearchVisibility() {
    const state = await this.harness.snapshot(WorkspaceDoc, context);
    const projects = new Set(state?.projects.map(project => project.id));
    const visibleChildren = visibleSubagentIds(state?.tasks ?? []);
    return new Map((state?.tasks ?? []).filter(task => (!task.subagentOrigin || visibleChildren.has(task.id)) && task.agent !== 'friday' && !task.archivedAt && (!task.projectId || projects.has(task.projectId)))
      .map(task => [task.id, taskHistoryEpoch(task)]));
  }
  async mutate(change: (workspace: Workspace) => void) {
    await this.root.commit(async tx => { const workspace = await tx.doc(WorkspaceDoc); change(workspace); await this.projectScripts.captureSettles(tx, workspace); workspace.revision++; }, context);
  }
  async patchTask(id: string, change: (task: WorkItem) => void, historyUpdatedIDs: string[] = []) {
    let terminal = false;
    let terminalRunID: string | undefined;
    let runFinished = false;
    await this.root.commit(async tx => {
      const workspace = await tx.doc(WorkspaceDoc);
      const item = workspace.tasks.find(t => t.id === id);
      if (!item) throw new Error('任务不存在');
      change(item); item.updatedAt = now();
      if (!activeStatuses.includes(item.status)) item.backgroundWaiting = false;
      const woke = reconcileTaskSnooze(item, Date.parse(item.updatedAt));
      terminal = !activeStatuses.includes(item.status) || woke;
      terminalRunID = item.currentRunId;
      runFinished = !activeStatuses.includes(item.status);
      await this.taskHistory.persist(tx, item, historyUpdatedIDs);
      workspace.revision++;
    }, context);
    if (terminal) this.taskSettlement.notify();
    if (runFinished) { await this.changeRequestSync.completed(id, terminalRunID); this.changeRequestDiscovery.request(id); }
  }
  async updateTaskMetadata(id: string, change: TaskMetadataChange) {
    if (change.archived === true) { const applied = await this.archives.start(id, change); this.taskSettlement.notify(); return applied; }
    if (change.settled === true) return this.settles.start(id, change);
    let applied = false;
    await this.mutate(workspace => {
      if (priorTaskMetadata(workspace, id, change)) return;
      const task = workspace.tasks.find(task => task.id === id);
      if (!task) throw new Error('任务不存在');
      // Metadata changes do not reset elapsed time or reorder recent activity.
      const wasPinned = !!task.pinnedAt;
      applyTaskMetadata(task, change, now());
      if (change.pinned && !wasPinned && task.pinnedAt && change.pinOrderKey === undefined) {
        const first = workspace.tasks.flatMap(other => other.id !== id && other.pinnedAt && other.pinOrderKey != null ? [other.pinOrderKey] : []).sort()[0] ?? null;
        task.pinOrderKey = pinOrderKeyBetween(null, first);
      }
      recordTaskMetadata(workspace, id, change); applied = true;
    });
    if (applied && change.title !== undefined) await this.taskTitles.cancelSuperseded(id);
    this.taskSettlement.notify();
    return applied;
  }
  async providerConfigurationChanged(provider: string) {
    if (!this.root || this.closed) return;
    await this.mutate(state => {
      state.providerConfigurationVersions ??= {}; state.providerConfigurationVersions[provider] = (state.providerConfigurationVersions[provider] ?? 0) + 1;
      if (state.providerUsageSnapshots) delete state.providerUsageSnapshots[provider];
      if (state.providerUsageIdentities) delete state.providerUsageIdentities[provider];
    });
  }
  async publishProviderUsage(provider: string, value: import('./provider-usage-limits.js').ProviderUsageLimits, identity?: import('./provider-usage-limits.js').ProviderUsageIdentity) {
    await this.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const previous = state.providerUsageSnapshots?.[provider];
      if (previous && (Date.parse(previous.checkedAt) > Date.parse(value.checkedAt) || JSON.stringify(previous) === JSON.stringify(value))) return;
      if (previous?.credentialFingerprint && value.credentialFingerprint && previous.credentialFingerprint !== value.credentialFingerprint) {
        state.providerConfigurationVersions ??= {}; state.providerConfigurationVersions[provider] = (state.providerConfigurationVersions[provider] ?? 0) + 1;
      }
      state.providerUsageSnapshots ??= {}; state.providerUsageSnapshots[provider] = value;
      if (identity && value.credentialFingerprint) { state.providerUsageIdentities ??= {}; state.providerUsageIdentities[provider] = { ...identity, fingerprint: value.credentialFingerprint }; }
      state.revision++;
    }, context);
  }
  async moveTaskInSidebar(id: string, move: TaskSidebarMove) {
    let applied = false, cleanup: number | undefined;
    await this.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), prior = state.sidebarRequests?.[move.requestId];
      applyTaskSidebarMove(state, id, move, now());
      const task = state.tasks.find(task => task.id === id)!;
      if (prior) { if (task?.settleCleanup?.status === 'pending' && task.settleCleanup.durableId === prior.cleanupId) cleanup = prior.cleanupId; return; }
      if (move.section === 'settled' && move.source !== 'settled') {
        cleanup = await this.settles.prepare(tx, state, task, { settled: true }, task.settledAt!, true);
        if (cleanup !== undefined) state.sidebarRequests![move.requestId]!.cleanupId = cleanup;
      }
      await this.projectScripts.captureSettles(tx, state); state.revision++; applied = true;
    }, context);
    if (cleanup !== undefined) { this.harness.resume(); await this.harness.waitForTask(cleanup as TaskId, context); }
    this.taskSettlement.notify();
    return applied;
  }
  async deleteTask(id: string) {
    const task = (await this.snapshot()).tasks.find(task => task.id === id);
    if (!task || task.agent === 'friday') throw new Error('本地任务不存在');
    if (task.subagentOrigin) throw new Error('原生子 Agent 由父任务管理，请返回父任务操作');
    if (task.archiveCleanup?.status === 'pending') await this.harness.waitForTask(task.archiveCleanup.durableId as TaskId, context);
    if (task.settleCleanup?.status === 'pending') await this.harness.waitForTask(task.settleCleanup.durableId as TaskId, context);
    await this.backgroundStops.wait(id);
    await this.taskQueue.stop(id);
    if (['muse', 'pi', 'grok', 'opencode', 'acp-registry', 'antigravity'].includes(task.agent)) await this.backgroundStops.cancelSettled(task);
    await this.subagents.stopBeforeDelete(id);
    if (hasRunningBackgroundCommands(task)) { await this.backgroundCommands.stopBeforeDelete(id); await this.nativeBackground.stopBeforeDelete(id); }
    await this.taskTitles.stop(id);
    await this.changeRequests.stopBeforeDelete(id);
    await this.reviewGuides.stopBeforeDelete(id);
    if (activeGitOperation(task.gitOperation)) {
      await this.harness.abortTask(task.gitOperation!.durableId as TaskId, context);
      await this.harness.waitForTask(task.gitOperation!.durableId as TaskId, context);
    }
    if (task.rewindOperation && ['queued', 'running'].includes(task.rewindOperation.status)) {
      await this.harness.abortTask(task.rewindOperation.durableId as TaskId, context);
      await this.harness.waitForTask(task.rewindOperation.durableId as TaskId, context);
    }
    if (runningFork(task.forkOperation)) {
      await this.harness.abortTask(task.forkOperation!.durableId as TaskId, context);
      await this.harness.waitForTask(task.forkOperation!.durableId as TaskId, context);
    }
    if (activeStatuses.includes((await this.snapshot()).tasks.find(task => task.id === id)!.status)) await this.cancel(id);
    await this.executor.stopNativeSession?.(id, task.executionSessionId ?? '');
    await this.projectScripts.stopTask(id);
    for (const owner of new Set(this.projectScripts.list(await this.snapshot(), id).map(run => run.terminalOwner).filter(owner => owner !== id))) await this.terminals.deleteTask(owner);
    await this.terminals.deleteTask(id);
    const removedChildren: string[] = [];
    await this.mutate(workspace => {
      const current = workspace.tasks.find(task => task.id === id);
      if (!current) return;
      if (Object.values(workspace.titleRequests ?? {}).some(request => request.taskId === id && request.status === 'pending')) throw new Error('任务标题仍在生成，请稍后重试删除');
      if (activeStatuses.includes(current.status) || queueRunning(current) || hasRunningBackgroundCommands(current) || activeGitOperation(current.gitOperation) || current.changeRequestOperations?.some(op => ['queued', 'running'].includes(op.status)) || runningFork(current.forkOperation) || ['queued', 'running'].includes(current.rewindOperation?.status ?? '') || ['queued', 'running'].includes(current.branchChange?.status ?? '')) throw new Error('任务仍在执行，请稍后重试');
      for (const task of workspace.tasks) if (task.subagentOrigin?.rootTaskId === id) removedChildren.push(task.id);
      workspace.tasks = workspace.tasks.filter(task => task.id !== id && task.subagentOrigin?.rootTaskId !== id);
      for (const idea of workspace.ideas) if (idea.taskId === id) idea.taskId = null;
      // Keep request receipts as tombstones: retrying an old submission must
      // never recreate a deleted task or repeat its external side effects.
    });
    await this.hostBrowsers.deleteTask(id);
    for (const child of removedChildren) await this.hostBrowsers.deleteTask(child);
    this.commandOutputs.remove(id);
    for (const child of removedChildren) this.commandOutputs.remove(child);
    await rm(join(this.directory, 'artifacts', `${id}.md`), { force: true });
  }
  async switchTaskBranch(id: string, branch: string, requestId: string) {
    if (['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('请求 ID 无效');
    const snapshot = await this.snapshot();
    const receipt = snapshot.branchRequests && Object.hasOwn(snapshot.branchRequests, requestId) ? snapshot.branchRequests[requestId] : undefined;
    if (receipt) {
      if (receipt.taskId !== id || receipt.branch !== branch) throw new Error('请求 ID 已被其他分支操作使用');
      return id;
    }
    const work = snapshot.tasks.find(task => task.id === id);
    if (!work || work.agent === 'friday') throw new Error('本地任务不存在');
    if (work.executionWorkspace && work.executionWorkspace.state !== 'ready') throw new Error('请先完成任务工作区准备');
    if (work.executionWorkspace?.projectFolder) await verifyManagedProjectFolder(work.executionWorkspace.projectFolder,this.directory);
    const plan = { ...await planWorkspace({ mode: 'checkout', branch }, work.cwd, this.directory, id), ...(work.executionWorkspace?.projectFolder ? {projectFolder:work.executionWorkspace.projectFolder} : {}) };
    await this.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      if (state.branchRequests && Object.hasOwn(state.branchRequests, requestId)) {
        if (state.branchRequests[requestId].taskId !== id || state.branchRequests[requestId].branch !== branch) throw new Error('请求 ID 已被其他分支操作使用');
        return;
      }
      const task = state.tasks.find(task => task.id === id)!;
      assertCheckoutIdle(state, plan.root);
      if (branchBlocksTask(state, task.cwd)) throw new Error('当前工作区正在切换分支，请稍后重试');
      const durableId = await tx.createTask(this.branchSwitch, { id, requestId, plan, predecessor: null }, { ownership: { kind: 'conversation' } });
      task.branchChange = { requestId, branch, root: plan.root, status: 'queued' };
      state.branchRequests ??= {};
      state.branchRequests[requestId] = { taskId: id, branch };
      state.queueTail = durableId; state.revision++;
    }, context);
    this.harness.resume();
    return id;
  }

  async followUpPlan(id: string, eventID: string, input: { text: string; requestId: string; newThread: boolean; images?: IdeaImage[]; contextIds?: string[]; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[] }) {
    const state = await this.snapshot();
    if (Object.hasOwn(state.requests, input.requestId)) {
      const receipt = state.requests[input.requestId]; const target = state.tasks.find(value => value.id === receipt);
      if (receipt === id || target?.planOrigin?.taskId === id && target.planOrigin.eventId === eventID) return receipt;
      throw new Error('原请求已经处理或这个请求 ID 已被使用，请查看已有任务');
    }
    const source = state.tasks.find(value => value.id === id);
    if (!source || source.agent === 'friday') throw new Error('本地任务不存在');
    const event = currentTaskPlan({ ...source, events: await this.taskHistory.events(source) }, eventID);
    const refine = !!input.text.trim() || !!input.images?.length;
    if (refine && input.newThread) throw new Error('请在原任务中细化方案，再选择新任务实施');
    const prompt = refine ? input.text : `PLEASE IMPLEMENT THIS PLAN:\n${event.text.trim()}`;
    const title = event.text.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
    return this.createTask({ prompt, images: input.images, contextIds: input.contextIds, requestId: input.requestId, continueId: input.newThread ? undefined : id,
      agent: source.agent as 'codex' | 'claude', projectId: source.projectId, mode: refine ? source.mode : 'code',
      model: input.model ?? source.model, reasoningEffort: input.reasoningEffort ?? source.reasoningEffort, modelOptions: input.modelOptions ?? source.modelOptions,
      interactionMode: refine ? 'plan' : 'default',
      planSource: { taskId: id, eventId: eventID, text: event.text, cwd: source.cwd },
      ...(input.newThread ? { title: title ? `Implement ${title}` : 'Implement plan' } : {}) });
  }

  async createTask(input: { command?: 'compact'; commandThreadId?: string; commandMessage?: QueueMessageInput & { requestId: string }; prompt: string; projectId: string | null; mode: TaskMode; requestId: string; ideaId?: string; continueId?: string; providerInstanceId?: string; agent?: 'friday' | 'codex' | 'claude' | 'pi' | 'grok' | 'cursor' | 'muse' | 'opencode' | 'acp-registry' | 'antigravity'; parentId?: string; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[]; interactionMode?: TaskInteractionMode; workspace?: TaskWorkspaceSelection; images?: IdeaImage[]; contextIds?: string[]; queueMessageId?: string; queueDispatcherId?: number; title?: string; planSource?: { taskId: string; eventId: string; text: string; cwd: string } }) {
    if (['__proto__', 'constructor', 'prototype'].includes(input.requestId)) throw new Error('请求 ID 无效');
    const snapshot = await this.snapshot();
    if (Object.hasOwn(snapshot.requests, input.requestId)) return snapshot.requests[input.requestId];
    const previous = snapshot.tasks.find(t => t.id === input.continueId);
    if (previous?.subagentOrigin) throw new Error('原生子 Agent 不接收新的用户输入，请返回父任务');
    const planSource = input.planSource ? snapshot.tasks.find(t => t.id === input.planSource!.taskId) : undefined;
    const interactionMode = taskInteractionMode(input.interactionMode) ?? previous?.interactionMode ?? 'default';
    const agent = previous?.agent ?? input.agent ?? 'friday';
    const native = agent === 'friday';
    const modelOptions = providerOptionSelections(input.modelOptions ?? (input.model !== undefined && input.model !== previous?.model ? [] : previous?.modelOptions)) ?? [];
    const providerInstanceId = previous ? taskProviderInstance(previous) : input.providerInstanceId ?? (planSource ? taskProviderInstance(planSource) : agent);
    if (previous && input.providerInstanceId !== undefined && input.providerInstanceId !== providerInstanceId) throw new Error('不能切换会话所属 Provider 实例，请新建任务');
    if (native && input.providerInstanceId !== undefined) throw new Error('Friday 主会话不使用任务 Provider 实例');
    if (!native) await this.providerInstances.get(agent as import('./provider-instances.js').ProviderDriver, providerInstanceId, true);
    if (native && interactionMode === 'plan') throw new Error('计划模式用于本地 Agent 任务');
    if (agent === 'pi' && interactionMode === 'plan') throw new Error('Pi 未提供原生计划模式，请使用默认模式');
    if (agent === 'muse' && interactionMode === 'plan') throw new Error('Muse 未提供原生计划模式，请使用默认模式');
    if (agent === 'grok' && interactionMode === 'plan') throw new Error('Grok 未提供原生交互模式切换，请使用默认模式');
    const images = await new IdeaImages(this.directory).validate(input.images);
    const commandMessage = input.commandMessage ? { ...input.commandMessage, images: await new IdeaImages(this.directory).validate(input.commandMessage.images) } : undefined;
    if (commandMessage && input.command !== 'compact') throw new Error('压缩后消息需要原生压缩命令');
    if (native && images.length) throw new Error('请从我的任务中把图片发送给 Codex 或 Claude。');
    if (native && input.contextIds?.length) throw new Error('上下文引用用于本地 Agent 任务');
    if (previous && input.agent && input.agent !== previous.agent) throw new Error('不能切换会话所属 Agent，请新建任务');
    if (native && !this.agentOptions) await this.modelConnection.ready();
    if (!native && !this.customExecutor) {
      const connection = await this.providerInstances.get(agent as import('./provider-instances.js').ProviderDriver, providerInstanceId, true);
      if (!connection) throw new Error('此 Agent 尚未接入任务执行');
      if (connection instanceof AcpProviderConnection) await connection.runtime({ model: input.model ?? previous?.model, reasoningEffort: input.reasoningEffort ?? previous?.reasoningEffort, modelOptions, interactionMode });
      else await connection.runtime({ model: input.model ?? previous?.model, reasoningEffort: input.reasoningEffort ?? previous?.reasoningEffort, modelOptions });
    }
    if (!native && input.mode === 'assistant') throw new Error('主对话由 Friday 处理，请从任务入口调用本地 Agent');
    const project = snapshot.projects.find(p => p.id === input.projectId);
    if(project?.clone&&project.clone.phase!=='done')throw new Error(project.clone.phase==='running'?'仓库正在克隆，请完成后再开始任务':'仓库尚未克隆完成，请先重试克隆');
    // Removing a Workspace registration retains its existing execution directory
    // and Agent session. Only that same conversation can use the retained link.
    const retained = previous ?? planSource;
    const retainedWorkspace = retained !== undefined && retained.projectId !== null && retained.projectId === input.projectId;
    if (input.projectId && !project && !retainedWorkspace) throw new Error('项目不存在');
    if (input.mode === 'code' && !project && !retainedWorkspace) throw new Error('代码任务需要先选择一个项目目录');
    if (input.workspace && (native || input.continueId || !project)) throw new Error('执行位置只能用于已选择 Workspace 的新本地任务');
    const taskId = randomUUID();
    const scratchProject = !native && isScratchProjectPath(project?.path ?? '', await this.getScratchWorkspaceRoot());
    if (scratchProject && input.workspace && (input.workspace.mode !== 'checkout' || input.workspace.branch || input.workspace.preparationId || input.workspace.startFromOrigin !== undefined) && !input.workspace.reuseTaskId) throw new Error('无项目任务使用独立临时目录，请清除 Git 执行位置选择');
    const prepared = input.workspace?.preparationId ? await this.changeRequestCheckouts.adopt(project!.id, input.workspace.preparationId) : undefined;
    if (prepared && prepared.saved.mode !== input.workspace!.mode) throw new Error('PR／MR 执行位置已改变');
    const reuseSource = input.workspace?.reuseTaskId ? snapshot.tasks.find(task => task.id === input.workspace!.reuseTaskId) : undefined;
    if (input.workspace?.reuseTaskId && (!reuseSource || reuseSource.projectId !== project!.id || prepared || input.planSource)) throw new Error('原任务不属于所选 Workspace');
    if (scratchProject && reuseSource?.executionWorkspace?.scratch) await verifyScratchWorkspace(reuseSource.executionWorkspace);
    if (project?.managedFolder) await verifyManagedProjectFolder(project.managedFolder,this.directory);
    const executionWorkspace = prepared?.plan ?? (reuseSource ? { ...await planExistingTaskWorkspace(input.workspace!, scratchProject ? reuseSource.cwd : project!.path, reuseSource), ...(scratchProject && reuseSource.executionWorkspace?.scratch ? { scratch: structuredClone(reuseSource.executionWorkspace.scratch) } : {}) }
      : scratchProject && !previous && !input.planSource ? planScratchWorkspace(project!.path, taskId, input.prompt)
      : input.workspace || project?.managedFolder ? await planWorkspace(input.workspace ?? {mode:'checkout'}, project!.path, this.directory, taskId) : undefined);
    if (executionWorkspace && project?.managedFolder) executionWorkspace.projectFolder = structuredClone(project.managedFolder);
    if (!prepared && !reuseSource && executionWorkspace?.mode === 'worktree') {
      const preferences = resolveSourceControlPreferences(snapshot, project!.id).effective;
      executionWorkspace.startFromOrigin = input.workspace!.startFromOrigin ?? preferences.newWorktreesStartFromOrigin;
      executionWorkspace.submoduleMode = preferences.worktreeSubmodules;
    }
    const skill = await readFile(fileURLToPath(new URL(`../../skills/${interactionMode === 'plan' ? 'project-research' : input.mode === 'auto' ? 'personal-assistant' : input.mode === 'code' ? 'code-validation' : 'project-research'}/SKILL.md`, import.meta.url)), 'utf8');
    const id = await this.root.commit(async tx => {
      const workspace = await tx.doc(WorkspaceDoc);
      if (Object.hasOwn(workspace.requests, input.requestId)) return workspace.requests[input.requestId];
      if (reuseSource) {
        const current = workspace.tasks.find(task => task.id === reuseSource.id);
        if (!current || current.cwd !== reuseSource.cwd || current.projectId !== project!.id || current.subagentOrigin || current.agent === 'friday'
          || workspace.projects.find(item => item.id === project!.id)?.path !== project!.path) throw new Error('原任务工作区已经改变，请重新选择');
      }
      const sourceIdea = input.ideaId ? workspace.ideas.find(i => i.id === input.ideaId) : undefined;
      if (input.ideaId && !sourceIdea) throw new Error('想法不存在');
      if (sourceIdea?.taskId) return sourceIdea.taskId;
      let work = input.continueId ? workspace.tasks.find(t => t.id === input.continueId) : undefined;
      const savedOrigin = input.planSource ? workspace.tasks.find(t => t.id === input.planSource!.taskId) : undefined;
      const origin = savedOrigin ? { ...savedOrigin, events: await this.taskHistory.events(savedOrigin, tx) } : undefined;
      if (input.planSource && (!origin || origin.cwd !== input.planSource.cwd || currentTaskPlan(origin, input.planSource.eventId).text !== input.planSource.text)) throw new Error('方案或工作区已经改变，请重新查看');
      if (input.projectId && !workspace.projects.some(p => p.id === input.projectId)
          && (!work || work.projectId !== input.projectId) && (!origin || origin.projectId !== input.projectId)) throw new Error('项目不存在');
      if (prepared && !workspace.changeRequestCheckouts?.some(p => p.id === prepared.saved.id && p.status === 'ready' && p.projectId === project!.id) || prepared && workspace.projects.find(p => p.id === project!.id)?.path !== project!.path) throw new Error('PR／MR 准备目录已改变');
      if (work && headForkSourceBusy(workspace.tasks, work.id)) throw new Error('正在分叉当前原生会话头，请等待分叉完成');
      if (!(executionWorkspace?.scratch && executionWorkspace.state !== 'ready') && branchBlocksTask(workspace, executionWorkspace?.cwd ?? work?.cwd ?? origin?.cwd ?? project?.path ?? join(this.directory, 'artifacts'))) throw new Error('当前工作区正在切换分支，请完成后再发送任务');
      if (input.continueId && !work) throw new Error('任务不存在');
      if (work?.backgroundStop?.status === 'pending') throw new Error('正在停止后台工作，请等待完成后继续');
      if (work?.archiveCleanup?.status === 'pending') throw new Error('正在清理归档会话，请等待完成后继续');
      if (work?.settleCleanup?.status === 'pending') throw new Error('正在清理结束跟进的会话，请等待完成后继续');
      if (input.command && (!work || native || work.subagentOrigin || !work.threadId || work.threadId !== input.commandThreadId || work.archivedAt || work.queue?.messages.some(message => ['queued', 'dispatching', 'running'].includes(message.status)))) throw new Error('请在原生会话空闲且排队消息处理完毕后压缩上下文');
      if (work && activeStatuses.includes(work.status)) throw new Error('任务正在运行，请使用补充要求');
      if (work && failedWorkspacePreparation(work) && work.executionWorkspace?.state !== 'ready') throw new Error('请先重试工作区准备；补充要求可以保存在排队消息中');
      if (work && activeRewind(work.rewindOperation)) throw new Error('请先处理这条会话的回退结果再发送新要求');
      if (work && (activeFork(work.forkOperation) || headForkSourceBusy(workspace.tasks, work.id))) throw new Error('请先处理这条会话的分叉结果再发送新要求');
      if (work?.claudeResumeSessionAt && work.claudeResumePendingRun) throw new Error('Claude 回退续接结果待核对，请从当前可见历史建立新会话后继续');
      const queueEntry = input.queueMessageId ? work?.queue?.messages.find(message => message.id === input.queueMessageId) : undefined;
      if (queueEntry?.creationSource === 'monitor' && (work?.archivedAt || work?.settledAt || work?.settledOverride === 'settled' || work?.subagentOrigin)) throw new Error('任务已结束，自动跟进不会重新启动任务');
      if (input.queueMessageId && (!queueEntry || queueEntry.status !== 'dispatching' || work?.queue?.paused || work?.queue?.dispatcherId !== input.queueDispatcherId)) throw new Error('排队消息已暂停或改变，请刷新后重试');
      if (work?.queue?.dispatcherId != null && !input.queueMessageId) throw new Error('此任务还有排队消息，请把新要求加入队列');
      if (work && input.projectId && work.projectId !== input.projectId) {
        if (work.status !== 'needs_project') throw new Error('当前对话没有等待选择工作目录');
        work.projectId = project!.id; work.cwd = project!.path;
      }
      const parent = input.parentId ? workspace.tasks.find(t => t.id === input.parentId && t.agent === 'friday') : undefined;
      if (input.parentId && !parent) throw new Error('Friday 主会话不存在');
      // Local threads run independently. Only turns in the same conversation
      // wait for their predecessor; Friday retains its own conversation lane.
      const predecessor = native ? workspace.assistantQueueTail ?? null : work?.durableId ?? null;
      if (executionWorkspace?.mode === 'checkout' && !executionWorkspace.scratch && executionWorkspace.state !== 'ready') assertCheckoutIdle(workspace, executionWorkspace.root);
      const stamp = now();
      if (work && taskSidebarSection(work, stamp) === 'settled') { work.activeOrderKey = null; work.unsettledAt = stamp; }
      const references = native ? [] : await this.contexts.references(input.prompt, input.contextIds, { task: work, project, inheritedTask: origin ?? reuseSource, preparationId: prepared?.saved.id });
      const task: WorkItem = work ?? {
        id: taskId, title: input.title?.slice(0, 200).replace(/[\uD800-\uDBFF]$/, '') ?? (displayContextText(input.prompt).trim().slice(0, 64).replace(/[\uD800-\uDBFF]$/, '') || '图片任务'), prompt: input.prompt, projectId: input.projectId,
        cwd: executionWorkspace?.cwd ?? origin?.cwd ?? project?.path ?? join(this.directory, 'artifacts'), mode: input.mode, agent, ...(!native ? { providerInstanceId } : {}),
        status: 'queued', createdAt: stamp, updatedAt: stamp, durableId: null, threadId: null, turnId: null,
        result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: input.requestId,
        messages: [], workspaceRequest: null,
        ...(!native ? { eventArchive: { count: 0, version: 0, coverage: 'complete' as const, recent: [] } } : {}),
        ...(executionWorkspace ? { executionWorkspace } : {}),
        ...(prepared ? { changeRequests: [prepared.saved.pullRequest] } : {}),
        ...(!executionWorkspace && origin?.executionWorkspace ? { executionWorkspace: JSON.parse(JSON.stringify(origin.executionWorkspace)) } : {}),
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      };
      if (prepared) for (const script of workspace.projectScriptRuns ?? []) if (script.preparationId === prepared.saved.id && !script.taskId) script.taskId = task.id;
      if (!task.messages) {
        task.messages = [{ id: randomUUID(), role: 'user', text: task.prompt }];
        if (task.result) task.messages.push({ id: randomUUID(), role: 'assistant', text: task.result });
      } else if (!native && work && task.result && task.messages.filter(message => !message.revertedAt).at(-1)?.text !== task.result) {
        task.messages.push({ id: randomUUID(), role: 'assistant', text: task.result });
      }
      if (!input.command) task.messages.push({ id: queueEntry?.id ?? randomUUID(), role: 'user', text: input.prompt, at: stamp, ...(images.length ? { images } : {}), ...(references.length ? { contexts: references } : {}), ...(!native ? { interactionMode } : {}), ...(queueEntry?.creationSource ? { creationSource: queueEntry.creationSource, ...(queueEntry.notification ? { notification: queueEntry.notification } : {}) } : {}) });
      if (!native) {
        if (input.model !== undefined) { if (task.model !== input.model) task.contextUsage = null; task.model = input.model; }
        if (input.reasoningEffort !== undefined) task.reasoningEffort = input.reasoningEffort;
        if (JSON.stringify(task.modelOptions?.find(option => option.id === 'contextWindow')?.value) !== JSON.stringify(modelOptions.find(option => option.id === 'contextWindow')?.value)) task.contextUsage = null;
        task.modelOptions = modelOptions;
      }
      task.mode = input.mode; if (!input.command) { task.result = ''; task.artifact = null; }
      const contextBeforeCompaction = input.command ? JSON.parse(JSON.stringify(task.contextUsage ?? null)) as import('./task-context-usage.js').TaskContextUsage | null : undefined;
      if (input.command) task.contextUsage = null;
      task.workspaceRequest = null; task.turnId = null;
      if (!native) task.interactionMode = interactionMode;
      if (input.planSource) task.planOrigin = { taskId: input.planSource.taskId, eventId: input.planSource.eventId };
      task.canSteer = false;
      task.archivedAt = null; task.settledAt = null; clearTaskSnooze(task); task.settledOverride = null;
      // Starting previously queued input is not a new read receipt from a user.
      if (!queueEntry) { task.unread = false; task.readAt = stamp; }
      const effectiveProject = workspace.projects.find(p => p.id === task.projectId);
      const hasWorkspace = effectiveProject !== undefined || ((work !== undefined || origin !== undefined) && task.projectId !== null);
      const promptParts = [
        !native && !task.threadId && task.messages.filter(message => !message.revertedAt).length > 1 ? `Previous conversation (context only; do not replay past actions):\n${task.messages.filter(message => !message.revertedAt).slice(0, -1).map(m => `${m.role}: ${this.contexts.project(m.text, m.contexts, m.images)}`).join('\n\n')}` : '',
        `Task: ${this.contexts.project(input.prompt, references, images) || '请查看附带图片。'}`,
        interactionMode === 'plan' ? 'Interaction mode: Plan. Inspect and ask clarifying questions as needed. Propose an actionable plan, then stop and wait for feedback or an explicit implementation request. Do not modify project files or start implementation during this turn.' : task.mode === 'auto'
          ? `Understand the user's intent and respond or act accordingly. ${hasWorkspace ? 'The user selected the workspace below. Only modify files when requested; inspect and explain read-only requests without changing files.' : 'No workspace is selected. Answer questions and research normally. If a local workspace is needed, call friday_request_workspace and stop this turn. Never guess a working directory or attempt file changes before selection.'}`
          : `Mode: ${task.mode}. ${task.mode === 'research' ? 'Research and report. Do not modify project files. Cite sources when researching externally.' : 'Implement the requested change, perform relevant verification, and report the files changed.'}`,
        effectiveProject ? `Project: ${effectiveProject.name}\nProject context:\n${effectiveProject.context}` : '',
        !effectiveProject && hasWorkspace ? `Workspace directory: ${task.cwd}` : '',
        workspace.memories.length ? `User-confirmed preferences:\n${workspace.memories.map(m => `- ${m.text}`).join('\n')}` : '',
        `Workflow skill:\n${skill}`,
        sourceIdea ? 'The user explicitly delegated this saved idea now. Act on it instead of saving the same idea again.' : '',
        work ? 'Continue this existing task. Check the current workspace and previous results before repeating any external operation.' : '',
      ];
      const prompt = promptParts.filter(Boolean).join('\n\n');
      const contextText = promptParts.filter((value, index) => index !== 1 && value).join('\n\n');
      if (native) {
        if (!task.conversationId) {
          const conversation = await tx.createConversation({ ownership: { kind: 'ownerless' } });
          task.conversationId = conversation.id;
        }
        // Keep history, but use Friday's current provider on every new user turn.
        await configure(tx, task.conversationId as ConversationId, { model: this.agentOptions?.model ?? this.modelConnection.model, thinkingLevel: this.agentOptions ? 'medium' : 'high', extensions: [this.assistant.extension] });
      }
      const durableId = native
        ? await tx.createTask(this.response, { id: task.id, predecessor, prompt: input.prompt, requestId: input.requestId }, { ownership: { kind: 'conversation' } })
        : await tx.createTask(this.execution, { id: task.id, predecessor, prompt, userText: this.contexts.project(input.prompt, references, images), contextText, ...(input.command ? { command: input.command, contextBeforeCompaction } : {}), ...(images.length ? { images } : {}) }, { ownership: { kind: 'conversation' } });
      if (!native) {
        const runID = String(durableId); const message = input.command ? undefined : task.messages.at(-1); if (message) message.runId = runID;
        task.currentRunId = runID; task.runs ??= [];
        task.runs.push({ id: runID, durableId, messageId: message?.id ?? '', ...(input.command ? { command: input.command } : {}), requestId: input.requestId, cwd: task.cwd, at: stamp,
          status: 'queued', mode: task.mode, interactionMode, modelOptions: task.modelOptions, ...(task.model ? { model: task.model } : {}), ...(task.reasoningEffort ? { reasoningEffort: task.reasoningEffort } : {}) });
      }
      if (native) workspace.assistantQueueTail = durableId;
      else workspace.queueTail = durableId;
      task.durableId = durableId; task.lastRequestId = input.requestId; task.status = 'queued'; task.error = null; task.turnId = null; task.backgroundWaiting = false;
      if (commandMessage) await this.taskQueue.enqueueAfterCompaction(tx, workspace, task, commandMessage);
      if (queueEntry) { queueEntry.status = 'running'; queueEntry.runId = durableId; queueEntry.error = null; }
      task.updatedAt = stamp; if (!input.command) task.events.push({ ...event('user', input.prompt), ...(!native ? { runId: String(durableId) } : {}) });
      if (!work) workspace.tasks.push(task);
      if (!native && !work && input.title === undefined && project && this.taskTitles.supported) {
        await this.taskTitles.schedule(tx, workspace, task.id, 'title:' + input.requestId, 'initial', task.messages.at(-1)!.id);
      }
      workspace.requests[input.requestId] = task.id;
      const idea = workspace.ideas.find(i => i.id === input.ideaId);
      if (idea) idea.taskId = task.id;
      workspace.revision++;
      return task.id;
    }, context);
    this.harness.resume();
    return id;
  }
  async updateExecution(id: string, update: ExecutionUpdate, runID?: string) {
    if (update.kind === 'goal') { await this.patchTask(id, item => { if (!runID || item.currentRunId === runID) item.goal = update.goal; }); return; }
    if (update.kind === 'subagent') { await this.subagents.update(id, update); return; }
    if (update.kind === 'subagentBackground') { await this.subagents.updateBackground(id, update); return; }
    if (update.kind === 'nativeBackground' || update.kind === 'nativeBackgroundOutput' || update.kind === 'nativeBackgroundItem') { await this.nativeBackground.update(id, update); return; }
    if (update.kind === 'nativeTurnStart' || update.kind === 'nativeTurnUpdate' || update.kind === 'nativeTurnFinish') { await this.nativeTurns.update(id, update); return; }
    if (update.kind === 'backgroundCommand' || update.kind === 'backgroundCommandOutput') { await this.backgroundCommands.update(id, update, runID); return; }
    if (update.kind === 'commandOutput') {
      this.commandOutputs.append(id, update.eventId, update.delta, runID, update);
      return;
    }
    if (update.kind === 'note') {
      const task = (await this.snapshot()).tasks.find(t => t.id === id);
      if (!task || !activeStatuses.includes(task.status) || runID && task.currentRunId !== runID) return;
      if (!/^note-[a-zA-Z0-9-]{1,100}$/.test(update.id)) throw new Error('笔记 ID 无效');
      const file = join(this.directory, 'artifacts', `${update.id}.md`); const content = `# ${update.title}\n\n${update.content}\n`;
      try { await writeFile(file, content, { mode: 0o600, flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw error; }
      await this.patchTask(id, item => { item.events.push({ ...event('note', `笔记已保存：${file}`), ...(runID ? { runId: runID } : {}) }); });
      return;
    }
    if (update.kind === 'idea' || update.kind === 'memory') {
      await this.mutate(s => {
        const task = s.tasks.find(t => t.id === id);
        if (!task || !activeStatuses.includes(task.status) || runID && task.currentRunId !== runID) return;
        if (update.kind === 'idea' && !s.ideas.some(i => i.id === update.id)) s.ideas.unshift({ id: update.id, text: update.text, createdAt: now(), taskId: null });
        if (update.kind === 'memory' && !s.memories.some(m => m.id === update.id)) {
          if (s.memories.length >= 100) throw new Error('记忆已满，请先整理现有记忆');
          s.memories.push({ id: update.id, text: update.text, updatedAt: now() });
        }
      });
      return;
    }
    let accepted = false;
    let acceptedRunID: string | undefined;
    await this.patchTask(id, item => {
      if (!activeStatuses.includes(item.status) || runID && item.currentRunId !== runID) return;
      accepted = true;
      acceptedRunID = runID ?? item.currentRunId;
      const run = item.runs?.find(run => run.id === (runID ?? item.currentRunId));
      if (update.kind === 'contextUsage') { item.contextUsage = update.usage; if (run) run.contextUsage = update.usage; }
      if (update.kind === 'session' && run) { run.threadId = update.threadId; if (update.model) run.model = update.model; if (update.reasoningEffort !== undefined) run.reasoningEffort = update.reasoningEffort; if (update.modelOptions !== undefined) run.modelOptions = update.modelOptions; }
      if (update.kind === 'session' && update.nativeHeadForkSupported !== undefined) item.nativeHeadForkSupported = update.nativeHeadForkSupported;
      if (update.kind === 'turn' && run) { run.turnId = update.turnId; if (item.agent === 'codex') { run.nativeTurnIds ??= []; if (!run.nativeTurnIds.includes(update.turnId)) run.nativeTurnIds.push(update.turnId); } }
      if (update.kind === 'nativeHead') { item.nativeHead = update.head; if (run) { run.nativeHead = update.head; if (update.turnIds) run.nativeTurnIds = update.turnIds; } delete item.claudeResumeSessionAt; delete item.claudeResumePendingRun; }
      if (update.kind === 'resumeApplied') { delete item.claudeResumeSessionAt; delete item.claudeResumePendingRun; }
      if (update.kind === 'session') { item.threadId = update.threadId; if (update.codexHome) item.codexHome = update.codexHome; if (update.claudeHome) item.claudeHome = update.claudeHome; if (update.piHome) item.piHome = update.piHome; if (update.grokHome) item.grokHome = update.grokHome; if (update.nativeProviderAccount) item.nativeProviderAccount = update.nativeProviderAccount; if (update.model) item.model = update.model; if (update.reasoningEffort !== undefined) item.reasoningEffort = update.reasoningEffort; if (update.modelOptions !== undefined) item.modelOptions = update.modelOptions; if (update.executionSessionId) item.executionSessionId = update.executionSessionId; }
      if (update.kind === 'turn') {
        item.turnId = update.turnId;
        if (item.agent === 'codex') item.canSteer = run?.command !== 'compact';
        const user = run ? item.messages?.find(m => m.id === run.messageId) : item.messages?.findLast(m => m.role === 'user');
        if (user && !user.turnId) { user.turnId = update.turnId; this.taskHistory.messageChanged(item, user.id); }
      }
      if (update.kind === 'ready') item.canSteer = update.canSteer;
      if (update.kind === 'output' && run?.command !== 'compact') item.result = update.text;
      if (update.kind === 'backgroundWaiting') { item.backgroundWaiting = update.waiting; if (!item.approvals.some(approval => approval.state === 'pending')) item.status = update.waiting ? 'waiting' : 'running'; }
      if (update.kind === 'workspace' && !item.projectId) item.workspaceRequest = update.reason;
      if (update.kind === 'event') item.events.push({ ...event(update.eventKind, update.text), ...(run ? { runId: run.id } : {}) });
      if (update.kind === 'item') {
        const index = item.events.findIndex(e => e.id === update.item.id);
        const projected = projectSubagentEvent(update.item, item.subagents);
        if (index < 0) item.events.push({ ...projected, ...(run ? { runId: run.id } : {}) });
        else item.events[index] = { ...projected, at: item.events[index].at, ...(item.events[index].historyOrder !== undefined ? { historyOrder: item.events[index].historyOrder } : {}), ...(run ? { runId: run.id } : {}) };
      }
      if (update.kind === 'approval') { item.approvals.push(update.approval); item.status = 'waiting'; }
      if (update.kind === 'approvalResolved') {
        const approval = item.approvals.find(a => a.id === update.id);
        if (approval) approval.state = update.expired ? 'expired' : 'answered';
        if (!item.approvals.some(a => a.state === 'pending')) item.status = item.backgroundWaiting ? 'waiting' : 'running';
      }
    }, update.kind === 'item' ? [update.item.id] : []);
    if (accepted) {
      if (update.kind === 'item' && update.item.kind === 'command') this.changeRequestSync.command(id, acceptedRunID, update.item.text);
      if (update.kind === 'session' && update.executionSessionId) this.commandOutputs.session(id, update.executionSessionId);
      this.commandOutputs.own(id, acceptedRunID);
      if (update.kind === 'item') this.commandOutputs.track(id, update.item, acceptedRunID);
    }
  }
  async cancel(id: string, scope?: TaskExecutionScope) {
    if ((await this.snapshot()).tasks.find(task => task.id === id)?.subagentOrigin) throw new Error('原生子 Agent 由父任务管理，请返回父任务操作');
    await this.taskQueue.pause(id, scope);
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    if (!task?.durableId) throw new Error('任务不存在');
    if (!taskExecutionScopeMatches(task, scope)) throw new Error('停止请求所属的回复已经改变，请刷新后重试');
    if (task.status === 'needs_project') {
      await this.patchTask(id, item => { item.status = 'cancelled'; item.workspaceRequest = null; });
      return;
    }
    if (activeStatuses.includes(task.status)) {
      await this.harness.abortTask(task.durableId as TaskId, context);
      await this.harness.waitForTask(task.durableId as TaskId, context);
    }
    await this.backgroundStops.cancelSettled(task);
  }
  async answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>, requestId = 'approval-' + providerDigest([id, approvalId]).slice(0,32)) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || ['constructor','prototype','__proto__'].includes(requestId)) throw new Error('授权回应请求 ID 无效');
    const digest = providerDigest([id, approvalId, decision, Object.entries(answers).sort(([a],[b]) => a.localeCompare(b))]);
    let replay = false;
    await this.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); state.approvalResponses ??= {};
      const prior = state.approvalResponses[requestId];
      if (prior) { if (prior.digest !== digest) throw new Error('授权回应请求 ID 已用于其他决定'); if (prior.status !== 'sent') throw new Error('回应结果尚未确认，请核对或停止执行，不会自动重复授权'); replay = true; return; }
      const task = state.tasks.find(task => task.id === id), approval = task?.approvals.find(value => value.id === approvalId);
      const childWaiting = approval?.subagentId && task?.subagents?.some(child => child.id === approval.subagentId && ['running','waiting'].includes(child.status));
      const nativeWaiting = Object.values(state.nativeTurnRequests ?? {}).some(receipt => receipt.taskId === id && receipt.status === 'running' && receipt.approvalIds?.includes(approvalId));
      if (!task || !approval || approval.state !== 'pending' || approval.responseStatus === 'sending' || approval.responseStatus === 'uncertain' || task.currentRunId && task.lastStoppedRunId === task.currentRunId || task.backgroundStop?.status === 'pending' && task.backgroundStop.sessionId === task.executionSessionId || task.archivedAt || task.settledAt || task.settledOverride === 'settled' || task.archiveCleanup?.status === 'pending' || task.settleCleanup?.status === 'pending' || !activeStatuses.includes(task.status) && !childWaiting && !nativeWaiting) throw new Error('授权请求已过期');
      const supported = approval.options?.map(option => option.decision) ?? approval.decisions ?? ['accept','decline'];
      if (!supported.includes(decision)) throw new Error('此授权请求不支持这个决定');
      if (decision === 'accept' && approval.questions.some(question => !answers[question.id]?.some(value => value.trim()))) throw new Error('请回答所有问题');
      if (!approval.method.startsWith('friday/')) this.executor.validateAnswer?.(id, approvalId, decision, answers);
      state.approvalResponses[requestId] = { taskId: id, approvalId, digest, decision, status: 'sending', createdAt: now() };
      approval.responseStatus = 'sending'; state.revision++;
    }, context);
    if (replay) return;
    const state = await this.snapshot(); const task = state.tasks.find(t => t.id === id);
    const native = Object.values(state.nativeTurnRequests ?? {}).find(receipt => receipt.taskId === id && receipt.status === 'running' && receipt.approvalIds?.includes(approvalId));
    const approval = task?.approvals.find(a => a.id === approvalId && a.state === 'pending' && a.responseStatus === 'sending');
    try {
      if (!approval) throw new Error('授权请求已过期');
      if (approval.method.startsWith('friday/')) {
        await this.patchTask(id, item => { const a = item.approvals.find(a => a.id === approvalId)!; a.decision = decision; a.answers = answers; });
      } else await this.executor.answer(id, approvalId, decision, answers);
      if (native) await this.nativeTurns.update(id, { kind: 'nativeTurnUpdate', ...(native.provider ? { provider: native.provider } : {}), ...(native.providerInstanceId ? { providerInstanceId: native.providerInstanceId } : {}), key: native.key, threadId: native.threadId, sessionId: native.sessionId, value: { kind: 'approvalResolved', id: approvalId } });
      else await this.updateExecution(id, { kind: 'approvalResolved', id: approvalId });
      await this.mutate(state => {
        state.approvalResponses![requestId]!.status = 'sent';
        const item = state.tasks.find(task => task.id === id); if (!item) return;
        const a = item.approvals.find(value => value.id === approvalId); if (a) { a.responseStatus = 'sent'; a.decision = decision; if (a.state === 'pending') a.state = 'answered'; }
        const runId = approval.ownerRunId ?? native?.runId ?? task?.currentRunId;
        item.events.push({ ...event('decision', approval.questions.length ? '已提交补充信息' : decision === 'acceptForSession' ? '已允许本会话的同类操作' : decision === 'acceptAlways' ? '已允许并保留授权' : decision === 'accept' ? '已允许本次操作' : decision === 'cancel' ? '已取消本次操作' : '已拒绝本次操作'), ...(runId ? { runId } : {}) });
      });
    } catch (error) {
      await this.mutate(state => { const receipt = state.approvalResponses?.[requestId]; if (receipt) receipt.status = 'uncertain'; const approval = state.tasks.find(task => task.id === id)?.approvals.find(value => value.id === approvalId); if (approval?.state === 'pending' && approval.responseStatus === 'sending') approval.responseStatus = 'uncertain'; });
      throw error;
    }
  }
  async steer(id: string, text: string, requestId: string, attached: IdeaImage[] = [], contextIds?: string[]) {
    if (['__proto__', 'constructor', 'prototype'].includes(requestId)) throw new Error('请求 ID 无效');
    const snapshot = await this.snapshot();
    const task = snapshot.tasks.find(t => t.id === id);
    if (!task) throw new Error('任务不存在');
    if (task.subagentOrigin) throw new Error('原生子 Agent 不接收新的用户输入，请返回父任务');
    if (Object.hasOwn(snapshot.requests, requestId)) {
      if (snapshot.requests[requestId] !== id) throw new Error('请求 ID 已被其他任务使用');
      if (task.messages?.find(m => m.id === requestId)?.delivery === 'sent') return;
      throw new Error('补充要求的发送结果尚未确认，请检查对话后再发送新的要求。');
    }
    if (task.agent !== 'friday' && task.canSteer === false) throw new Error('Agent 尚未准备好接收补充要求，请加入队列');
    const images = await new IdeaImages(this.directory).validate(attached);
    if (task.agent === 'friday') {
      if (contextIds?.length) throw new Error('上下文引用用于本地 Agent 任务');
      if (images.length) throw new Error('请从我的任务中把图片发送给 Codex 或 Claude。');
      if (task.status === 'queued') throw new Error('会话尚在排队，请开始后补充要求');
      const conversation = await this.harness.conversation(task.conversationId as ConversationId, context);
      if (!conversation) throw new Error('Friday 会话不存在');
      await conversation.submit({ type: 'input', content: text, requestId, whenBusy: 'steer' }, context);
      await this.patchTask(id, item => { item.events.push(event('user', text)); });
      return;
    }
    const resolved = await new IdeaImages(this.directory).resolve(images);
    const references = await this.contexts.references(text, contextIds, { task, project: snapshot.projects.find(project => project.id === task.projectId) });
    // Reserve and persist the input before the external side effect. A lost receipt
    // or service crash must never cause an uncertain live message to be replayed.
    await this.mutate(state => {
      if (Object.hasOwn(state.requests, requestId)) throw new Error('补充要求正在发送，请检查对话后再重试。');
      const item = state.tasks.find(t => t.id === id)!;
      if (!['running', 'waiting'].includes(item.status)) throw new Error('任务尚未开始或已结束，请重新发送。');
      state.requests[requestId] = id;
      item.messages ??= [{ id: randomUUID(), role: 'user', text: item.prompt, at: item.createdAt }];
      item.messages.push({ id: requestId, role: 'user', text, at: now(), delivery: 'sending', ...(images.length ? { images } : {}), ...(references.length ? { contexts: references } : {}), ...(item.turnId ? { turnId: item.turnId } : {}), ...(item.currentRunId ? { runId: item.currentRunId } : {}) });
      item.events.push({ ...event('user', text), ...(item.currentRunId ? { runId: item.currentRunId } : {}) }); item.updatedAt = now();
    });
    try {
      await this.executor.steer(id, this.contexts.project(text, references, images) || '请查看附带图片。', requestId, resolved);
      await this.patchTask(id, item => { item.messages!.find(m => m.id === requestId)!.delivery = 'sent'; this.taskHistory.messageChanged(item, requestId); });
    } catch (error) {
      await this.patchTask(id, item => { item.messages!.find(m => m.id === requestId)!.delivery = 'uncertain'; this.taskHistory.messageChanged(item, requestId); });
      throw new Error(`补充要求的发送结果尚未确认，请检查对话后再发送新的要求。${error instanceof Error ? error.message : ''}`);
    }
  }
  async artifact(id: string) {
    const task = (await this.snapshot()).tasks.find(t => t.id === id);
    if (!task?.artifact) throw new Error('成果尚未生成');
    return readFile(join(this.directory, 'artifacts', task.artifact), 'utf8');
  }
  async close() {
    await this.usageLimitSources.close();
    if (this.closed) return; this.closed = true;
    this.emit('closing');
    await this.hostBrowsers.close();
    await this.fileWrites.close();
    await this.managedProjects.close();
    await this.subagentHistory.close();
    await this.runtimeTools.close();
    await this.changeRequestWatch.close();
    await this.changeRequestSync.close();
    await this.changeRequestDiscovery.close();
    this.changeRequestLinks.close();
    await this.taskSettlement.close();
    this.taskTitles.beginShutdown();
    this.terminals.beginShutdown();
    await this.taskQueue.hold();
    await this.taskSearch.close();
    await this.executor.close?.();
    if (this.customExecutor) await this.providerInstances.close();
    await this.modelConnection.close(); await this.sourceControl.close(); await this.harness.close(context); this.changeRequests.close(); this.reviewGuides.close(); await this.terminals.close(); this.contexts.close(); await this.watch?.stop(); this.lease.close(); this.removeAllListeners();
  }
}
