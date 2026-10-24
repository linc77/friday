import type { TaskTerminalSummary } from './terminal-types.js';
import type { TaskContextReference } from './task-context-types.js';
import type { SourceControlWritingStyle, TextGenerationModelSelection, TextGenerationSettings } from './text-generation-settings.js';
import type { TaskSettlementSettings } from './task-settlement.js';
import type { SourceControlPreferences } from './source-control-preferences.js';
import type { TaskBackgroundCommand } from './task-background-commands.js';
import type { TaskBackgroundStop } from './task-background-stops.js';
import type { NativeBackgroundWork, NativeRuntimeUpdate, NativeTurnReceipt } from './native-runtime-types.js';
import type { RepositoryPublication, RepositoryPublishInput } from './task-repository-publish.js';
import type { TaskChangeRequestTarget } from './task-change-requests.js';
export type TaskStatus = 'queued' | 'running' | 'waiting' | 'needs_project' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type IdeaImage = { id: string; name: string; mediaType: string };
export type Idea = { id: string; text: string; createdAt: string; taskId: string | null; title?: string; updatedAt?: string; images?: IdeaImage[]; lastEditId?: string };
export type Project = { scripts?: import('./project-script-types.js').ProjectScript[]; id: string; name: string; path: string; context: string; icon?: string; color?: string; createdAt?: string; updatedAt?: string; repositoryIdentity?: import('./project-repository-identities.js').ProjectRepositoryIdentity; isScratch?: boolean; managedFolder?: import('./managed-project-folders.js').ManagedProjectFolder; clone?:import('./project-repository-operations.js').ProjectCloneSnapshot };
export type Memory = { id: string; text: string; updatedAt: string };
export type Question = { id: string; header: string; question: string; options: { label: string; description: string; value?: string }[]; multiSelect?: boolean; isOther?: boolean; isSecret?: boolean };
export type Approval = { id: string; method: string; title: string; detail: string; questions: Question[]; state: 'pending' | 'answered' | 'expired'; responseStatus?: 'sending' | 'uncertain' | 'sent'; decisions?: import('./provider-approvals.js').ApprovalDecision[]; options?: import('./codex-mcp-elicitation.js').ApprovalOption[]; appName?: string; decision?: import('./provider-approvals.js').ApprovalDecision; answers?: Record<string, string[]>; subagentId?: string; ownerRunId?: string };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; at?: string; turnId?: string; images?: IdeaImage[]; contexts?: TaskContextReference[]; delivery?: 'sending' | 'sent' | 'uncertain'; interactionMode?: TaskInteractionMode; runId?: string; revertedAt?: string; historyOrder?: number; creationSource?: 'monitor'; notification?: import('./task-change-request-watch-types.js').WatchNotification };
export type ExecutionImage = IdeaImage & { path: string };
export type TaskMode = 'auto' | 'assistant' | 'research' | 'code';
export type TaskInteractionMode = 'default' | 'plan';
export type TaskGitAction = 'commit' | 'push' | 'create_pr' | 'commit_push' | 'commit_push_pr' | 'pull' | 'publish_repository';
export type TaskPullRequest = { number: number; url: string; title: string; state: 'open' | 'closed' | 'merged'; base: string; head: string; provider?: import('./source-control-provider.js').SourceControlProvider; host?: string; repository?: string;
  snapshot?: import('./task-change-request-summary.js').TaskPullRequestSnapshot; linkedAt?: string; linkSource?: 'stack' | 'manual' | 'created' | 'agent' | 'stack-dismissed'; dismissedAt?: string; observedAt?: number;
  watch?: import('./task-change-request-watch-types.js').TaskPullRequestWatch; endedWatch?: import('./task-change-request-watch-types.js').TaskPullRequestWatch };
export type TaskGitOperation = {
  generationModelSelection?: TextGenerationModelSelection;
  generationWritingStyle?: SourceControlWritingStyle;
  id: string; durableId: number; action: TaskGitAction; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  cwd: string; root: string; createdAt: string; updatedAt: string; phase: string; steps: string[];
  phaseStartedAt?: string;
  branch: string | null; head: string | null; contentFingerprint: string;
  files: string[]; commitMessage?: string; featureBranch?: string; remote?: string; baseBranch?: string;
  remoteFingerprint?: string;
  repositoryPublish?: RepositoryPublishInput;
  repositoryPublication?: RepositoryPublication;
  changeRequestTarget?: TaskChangeRequestTarget;
  changeRequestCreation?: import('./task-change-request-creation.js').ChangeRequestCreationContext;
  changeRequestBaseCommit?: string;
  changeRequestProvider?: import('./source-control-provider.js').SourceControlProvider;
  commitSHA?: string; pullRequest?: TaskPullRequest; error?: string | null; output?: string[];
  generation?: { threadId: string | null; turnId: string | null; codexHome?: string; claudeHome?: string };
  generations?: Record<string, { threadId: string | null; turnId: string | null; codexHome?: string; claudeHome?: string }>;
  generatedPullRequest?: { title: string; body: string };
};
export const activeGitOperation = (operation?: TaskGitOperation) => operation?.status === 'queued' || operation?.status === 'running';
export type WorktreeSubmodules = 'recursive' | 'top-level' | 'none';
export type TaskWorkspaceGitStage = {
  status: 'running' | 'done' | 'skipped' | 'warning' | 'failed';
  startedAt?: string; completedAt?: string; detail?: string;
};
export type TaskWorkspaceSelection = { mode: 'checkout' | 'worktree'; branch?: string; preparationId?: string; startFromOrigin?: boolean; reuseTaskId?: string };
export type TaskWorkspacePlan = {
  mode: 'checkout' | 'worktree'; sourcePath: string; root: string; cwd: string;
  branch: string | null; commit: string | null; targetBranch?: string;
  state: 'pending' | 'preparing' | 'ready';
  reuseBranch?: boolean; scriptWorktree?: boolean;
  startFromOrigin?: boolean; submoduleMode?: WorktreeSubmodules | null;
  fetch?: TaskWorkspaceGitStage;
  checkout?: TaskWorkspaceGitStage;
  submodules?: TaskWorkspaceGitStage & { mode?: WorktreeSubmodules };
  scratch?: import('./managed-scratch-workspace.js').ScratchAllocation;
  projectFolder?: import('./managed-project-folders.js').ManagedProjectFolder;
};
export type TaskBranchChange = {
  requestId: string; branch: string; root: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  error?: string;
};
export type TaskGitContext =
  | { status: 'repository'; branch: string | null; head: string | null; isWorktree: boolean }
  | { status: 'not_repository' | 'unavailable' };
export type TaskFileChange = {
  path: string; oldPath?: string; kind: 'add' | 'update' | 'delete';
  diff: string; additions: number; deletions: number; truncated?: boolean;
};
export type TaskPlanStep = { step: string; status: 'pending' | 'inProgress' | 'completed' };
export type TaskCommandAction = { type: 'read' | 'listFiles' | 'search' | 'unknown'; command: string; path?: string; name?: string; query?: string };
export type TaskCheckpoint =
  | { status: 'ready'; repository: string; key: string; cwd: string; root: string; prefix: string; tree: string; commit: string; ref: string; head: string | null; at: string; excluded: string[] }
  | { status: 'not_repository' | 'unavailable'; cwd: string; at: string; error?: string };
export type TaskRunFile = { path: string; oldPath?: string; kind: string; additions: number | null; deletions: number | null; binary: boolean };
export type TaskWorkspacePreparation = {
  status: 'preparing' | 'ready' | 'failed' | 'cancelled'; attempt: number; startedAt: string; completedAt?: string; error?: string;
  checkoutCompletedAt?: string; setupRunId?: string | null; setupResolvedAt?: string; cancelRequestedAt?: string;
};
export type TaskRun = {
  nativeTurnIds?: string[];
  command?: 'compact';
  contextUsage?: import('./task-context-usage.js').TaskContextUsage | null;
  id: string; durableId: number | null; messageId: string; requestId: string; cwd: string; at: string;
  startedAt?: string;
  executionOrder?: number; executionMessagePosition?: number; executionExcludedAt?: string;
  status: TaskStatus; completedAt?: string; threadId?: string; turnId?: string; nativeHead?: string;
  mode: TaskMode; interactionMode: TaskInteractionMode; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[];
  before?: TaskCheckpoint; after?: TaskCheckpoint; changes?: TaskRunFile[]; diffError?: string; revertedAt?: string;
  inheritedFrom?: { taskId: string; runId: string };
  workspacePreparation?: TaskWorkspacePreparation;
};
export const failedWorkspacePreparation = (task: WorkItem, runID = task.currentRunId) => task.runs?.find(run =>
  run.id === runID && !run.revertedAt && !run.inheritedFrom && !run.before && !run.turnId && run.status === 'failed' && run.workspacePreparation?.status === 'failed');
export type NativeForkResult = { threadId: string; turnIds: Record<string, string>; headIds: Record<string, string>; codexHome?: string; claudeHome?: string };
export type NativeForkRequest = {
  task: WorkItem; run: Pick<TaskRun, 'threadId' | 'turnId' | 'nativeHead'> & { status?: TaskStatus }; expectedTurns: string[]; title: string; candidateId?: string; inspectOnly: boolean; signal: AbortSignal;
  prefixMode?: 'observed'; nativePrefix?: string[]; verifiedPrefix?: (turnIds: string[]) => Promise<void>;
  started: () => Promise<void>; candidate: (threadId: string) => Promise<void>;
};
export type TaskForkOperation = {
  id: string; durableId: number; requestId: string; sourceTaskId: string; sourceRunId: string; sourceThreadId: string | null;
  sourceTurnId?: string; sourceHead?: string; expectedTurns: string[];
  prefixMode?: 'observed'; nativePrefix?: string[];
  sourceStatus?: TaskStatus;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  createdAt: string; updatedAt: string; startedAt?: string; candidateId?: string; nativeResult?: NativeForkResult; error?: string;
  projectedAt?: string; projectedStrategy?: 'native' | 'visible_history';
  strategy?: 'native' | 'visible_history'; attempt: number;
};
export const activeFork = (operation?: TaskForkOperation) => !!operation && operation.status !== 'completed';
export const runningFork = (operation?: TaskForkOperation) => operation?.status === 'queued' || operation?.status === 'running';
export type NativeRewindStart = { threadId: string; turns: string[]; keep: string[] };
export type NativeRewindResult = { state: 'applied' | 'unchanged'; threadId: string | null; turns?: string[]; turnIds?: Record<string, string>; headIds?: Record<string, string>; resumeSessionAt?: string };
export type NativeRewindRequest = {
  task: WorkItem; targetTurnId: string | null; removeTurns: string[]; keepTurns?: string[]; original?: NativeRewindStart;
  inspectOnly?: boolean; signal: AbortSignal;
  started: (original: NativeRewindStart) => Promise<void>;
  candidate: (threadId: string) => Promise<void>;
};
export type TaskRewindEditor = { text: string; images: IdeaImage[]; contexts?: TaskContextReference[]; interactionMode: TaskInteractionMode; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[] };
export type TaskRewindOperation = {
  id: string; durableId: number; requestId: string; messageId: string; runId: string; removedRunIds: string[]; removedExecutionRunIds?: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'needs_review';
  phase: 'native' | 'files' | 'completed'; restoreFiles: boolean; cwd: string; fingerprint: string;
  fingerprintVersion?: 2; // Omitted records use the original v1 history fingerprint.
  createdAt: string; updatedAt: string; error?: string; projectedAt?: string; filesStartedAt?: string; filesCompletedAt?: string;
  sourceThreadId: string | null; sourceTurnId: string | null; targetTurnId: string | null; removeTurns: string[]; keepTurns: string[];
  nativeStart?: NativeRewindStart; nativeCandidate?: string; nativeResult?: NativeRewindResult;
  checkpoint?: TaskCheckpoint; backup?: TaskCheckpoint; fileFingerprint?: string;
  editor: TaskRewindEditor; attempt: number; resolution?: 'retry_files' | 'keep_files' | 'inspect' | 'new_session';
};
export const activeRewind = (operation?: TaskRewindOperation) => !!operation && !['completed', 'failed'].includes(operation.status);
export type TaskEvent = {
  id: string; kind: string; text: string; at: string;
  itemId?: string; turnId?: string; nativeTurnId?: string; phase?: 'commentary' | 'final_answer';
  status?: 'running' | 'completed' | 'failed' | 'declined' | 'interrupted';
  detail?: string; completedAt?: string; durationMs?: number; exitCode?: number;
  detailOmitted?: boolean; // Compact transport only; persisted records retain their public output.
  detailTruncated?: boolean; // A provider/live preview or bounded on-demand response omitted content.
  background?: boolean; processId?: string;
  subagentId?: string;
  changes?: TaskFileChange[]; plan?: TaskPlanStep[]; commandActions?: TaskCommandAction[];
  runId?: string; revertedAt?: string;
  historyDigest?: string;
  historyOrder?: number;
};
export type TaskHistoryArchive = {
  count: number; version: number; coverage: 'complete' | 'legacy'; nextOrder?: number;
  firstTimelineAt?: string | null; hasNotifications?: boolean;
  recent: { id: string; position: number; digest: string }[];
  runPages?: Record<string, { first: number; last: number }>;
  touchVersion?: number; touches?: { id: string; digest: string }[];
  messageVersion?: number; messageTouches?: string[];
};
export type TaskHistoryInfo = TaskHistoryArchive & { epoch: string; nextCursor: string | null };
export type TaskHistoryPage = { taskId: string; epoch: string; version: number; count: number; from: number; to: number; events: TaskEvent[]; nextCursor: string | null; coverage: TaskHistoryArchive['coverage'] };
export type TaskConversationHistory = { epoch: string; sequence: number; from: number; to: number; count: number; nextCursor: string | null; hasEarlier: boolean; touchVersion: number; touches: { id: string; digest: string }[]; messageVersion: number; messageTouches: string[];
  kind?: 'items'; visibleMessageIds?: string[]; payloadBudgetExceeded?: boolean };
export type TaskConversationPage = TaskConversationHistory & { taskId: string; messages: ChatMessage[]; events: TaskEvent[]; beforeCursor?: string };
export type TaskEventPage = { taskId: string; epoch: string; sequence: number; events: TaskEvent[]; messages: ChatMessage[]; missing: string[] };
export type QueuedTaskMessage = {
  id: string; dispatchId: string; text: string; images: IdeaImage[]; createdAt: string;
  status: 'queued' | 'dispatching' | 'steering' | 'running' | 'completed' | 'cancelled' | 'uncertain' | 'failed';
  model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[]; runId?: number; error?: string | null;
  interactionMode?: TaskInteractionMode;
  contexts?: TaskContextReference[];
  creationSource?: 'monitor'; notification?: import('./task-change-request-watch-types.js').WatchNotification;
};
export type TaskMessageQueue = { dispatcherId: number | null; paused: boolean; messages: QueuedTaskMessage[]; error?: string | null; heldByRunId?: string; heldOnRestart?: boolean };
export type TaskSidebarActivity = { working: boolean; latestUserAuthoredMessageAt: string | null; latestRunRequestedAt: string | null; latestRunCompletedAt: string | null };
export type TaskExecutionScope = { runId?: string; sessionId?: string };
export const taskExecutionScopeMatches = (task: WorkItem, scope?: TaskExecutionScope) => !scope
  || (scope.runId === undefined || task.currentRunId === scope.runId) && (scope.sessionId === undefined || task.executionSessionId === scope.sessionId);
export type WorkItem = {
  feedback?: import('./task-feedback.js').TaskFeedbackReceipt[];
  goal?: import('./codex-goals.js').TaskGoal | null;
  archiveCleanup?: import('./task-archive.js').TaskArchiveCleanup;
  settleCleanup?: import('./task-settle-lifecycle.js').TaskSettleCleanup;
  canSettle?: boolean;
  contextUsage?: import('./task-context-usage.js').TaskContextUsage | null;
  nativeHistory?: { status: 'loading' | 'ready' | 'failed'; updatedAt: string; epoch?: string };
  subagents?: import('./task-subagent-types.js').TaskSubagent[];
  subagentOrigin?: import('./task-subagent-types.js').TaskSubagentOrigin;
  pendingSubagentRequest?: 'approval' | 'user_input';
  id: string; title: string; prompt: string; projectId: string | null; cwd: string;
  titleRegeneration?: { requestId: string; startedAt: string } | null;
  titleGenerationSupported?: boolean; // Read-only provider capability.
  providerInstanceId?: string;
  agent: string; mode: TaskMode; status: TaskStatus; createdAt: string; updatedAt: string;
  durableId: number | null; threadId: string | null; turnId: string | null;
  result: string; error: string | null; events: TaskEvent[]; approvals: Approval[];
  executionSessionId?: string;
  nativeProviderAccount?: string;
  lastStoppedRunId?: string;
  backgroundCommands?: TaskBackgroundCommand[];
  backgroundStop?: TaskBackgroundStop;
  nativeBackgroundWork?: NativeBackgroundWork[];
  nativeBackgroundConnected?: boolean;
  backgroundWaiting?: boolean;
  backgroundActivity?: { commands: number; unknownCommands: number; monitors?: number; subagents?: number; backgroundTasks?: number; unknownTasks?: number; waiting?: boolean; canStop?: boolean };
  conversationId?: number; messages?: ChatMessage[];
  codexHome?: string;
  claudeHome?: string;
  piHome?: string;
  grokHome?: string;
  parentId?: string; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[];
  artifact: string | null; lastRequestId: string;
  workspaceRequest?: string | null;
  pinnedAt?: string | null; archivedAt?: string | null; settledAt?: string | null; unsettledAt?: string | null;
  pinOrderKey?: string | null; activeOrderKey?: string | null;
  sidebarSettledAt?: string; // Read-only sort metadata for compact sidebar snapshots.
  sidebarActivity?: TaskSidebarActivity; // Read-only Working and inbox metadata, with no approval or message bodies.
  settlementManaged?: boolean; // Read-only: lifecycle comes from the resident service.
  settledOverride?: 'settled' | 'active' | null;
  lastSnoozeWakeAt?: string | null;
  snoozedUntil?: string | null; snoozedAt?: string | null;
  snoozeWakeAt?: string | null; seenSnoozeWakeAt?: string | null;
  snoozed?: boolean; // Read-only, evaluated on the resident host clock.
  canSnooze?: boolean; // Read-only; compact summaries omit approval bodies.
  autoSettle?: boolean;
  unread?: boolean; readAt?: string | null;
  git?: TaskGitContext; // Read-only API metadata; not persisted by the engine.
  executionWorkspace?: TaskWorkspacePlan;
  branchChange?: TaskBranchChange;
  queue?: TaskMessageQueue;
  canSteer?: boolean;
  interactionMode?: TaskInteractionMode;
  planOrigin?: { taskId: string; eventId: string };
  gitOperation?: TaskGitOperation;
  gitOperations?: TaskGitOperation[];
  changeRequests?: TaskPullRequest[];
  branchPullRequest?: TaskPullRequest | null;
  changeRequestLinksRevision?: number;
  changeRequestStacks?: Record<string, import('./task-change-request-stack-types.js').SavedChangeRequestStack | null>;
  changeRequestOperations?: import('./task-change-request-actions.js').ChangeRequestOperation[];
  changeRequestGuideRuns?: import('./task-review-guide-types.js').ReviewGuideRun[];
  runs?: TaskRun[]; currentRunId?: string;
  nativeHead?: string; claudeResumeSessionAt?: string; claudeResumePendingRun?: string;
  rewindOperation?: TaskRewindOperation; rewindOperations?: TaskRewindOperation[];
  forkOrigin?: { taskId: string; runId: string; title: string; rootTaskId: string };
  forkOperation?: TaskForkOperation;
  eventArchive?: TaskHistoryArchive;
  history?: TaskHistoryInfo; // Read-only transport metadata; bodies remain in Durable document pages.
  conversationHistory?: TaskConversationHistory; // Opt-in whole-turn transport window.
  contentOmitted?: boolean; contentVersion?: string; contentSequence?: number; // Explicit overview transport, never persisted.
  activityStartedAt?: string;
  pullRequests?: TaskPullRequest[]; // Public read-only metadata across Git operations.
  terminals?: TaskTerminalSummary[]; // Read-only live metadata, separate private storage.
};
export type Workspace = {
  approvalResponses?: Record<string, import('./provider-approvals.js').ApprovalResponseReceipt>;
  usageLimitSourcesSupported?: boolean;
  providerUsageIdentities?: Record<string, import('./provider-usage-limits.js').ProviderUsageIdentity & { fingerprint: string }>;
  usageLimitSources?: import('./cliproxy-usage.js').UsageSourceSnapshot[];
  usageSourceResetRequests?: Record<string, import('./usage-limit-sources.js').UsageSourceReset>;
  usageSourceResetTail?: number;
  taskFeedbackRequests?: Record<string, import('./task-feedback.js').TaskFeedbackReceipt>;
  providerCreditResets?: Record<string, import('./provider-credit-resets.js').ProviderCreditReset>;
  providerCreditAccounts?: Record<string, import('./provider-credit-resets.js').ProviderCreditAccount>;
  providerUsageSnapshots?: Record<string, import('./provider-usage-limits.js').ProviderUsageLimits>;
  providerResetCreditsSupported?: boolean;
  providerConfigurationVersions?: Record<string, number>;
  changeRequestLinkRequests?: Record<string, import('./task-change-request-links.js').ChangeRequestLinkReceipt>;
  changeRequestWatchRequests?: Record<string, import('./task-change-request-watch.js').WatchReceipt>;
  projectScriptSettings?: import('./project-script-types.js').ProjectScriptSettings;
  projectScriptRuns?: import('./project-script-types.js').ProjectScriptRun[];
  projectScriptSettles?: Record<string, string>;
  projectScriptTerminalsBusy?: boolean;
  changeRequestCheckouts?: import('./task-change-request-checkout-types.js').ChangeRequestCheckout[];
  reviewGuideRequests?: Record<string,{taskId:string;runId:string;digest:string}>;
  textGenerationSettings?: TextGenerationSettings;
  textGenerationSettingsVersion?: number; // Read-only transport metadata.
  taskSidebarOrderingSupported?: boolean; // Read-only capability.
  taskSidebarProjectScopesSupported?: boolean; // Grouped project ordering scope.
  taskScratchWorkspaceSupported?: boolean;
  scratchWorkspaceRoot?: string;
  namedProjectCreationSupported?: boolean;
  newProjectsRoot?: string;
  projectRepositoryOperationsSupported?:boolean;
  projectRepositoryOperations?:import('./project-repository-operations.js').ProjectRepositoryOperation[];
  taskExistingWorkspaceSupported?: boolean;
  taskComposerCommandsSupported?: boolean;
  taskArchiveLifecycleSupported?: boolean;
  taskMetadataRequests?: Record<string, import('./task-metadata.js').TaskMetadataReceipt>;
  taskSidebarWorkingSupported?: boolean; // Read-only capability for time-ordered moves and activity metadata.
  taskAutoSettlementSupported?: boolean; // Read-only capability.
  taskBackgroundCommandsSupported?: boolean; // Read-only native command-control capability.
  taskNativeBackgroundSupported?: boolean;
  taskBackgroundSettlementSupported?: boolean;
  taskSettlementSettingsVersion?: number; // Read-only preference version.
  taskSettlementSettings?: TaskSettlementSettings;
  sourceControlPreferences?: SourceControlPreferences;
  sourceControlPreferencesVersion?: number;
  taskStreamSession?: string; // Read-only capability and connection generation.
  taskStreamSerial?: number;
  revision: number; ideas: Idea[]; projects: Project[]; memories: Memory[];
  tasks: WorkItem[]; requests: Record<string, string>; queueTail?: number | null; assistantQueueTail?: number | null;
  branchRequests?: Record<string, { taskId: string; branch: string }>;
  gitRequests?: Record<string, { taskId: string; operationId: string; digest?: string }>;
  changeRequestRequests?: Record<string, { taskId: string; operationId: string; digest: string }>;
  rewindRequests?: Record<string, { taskId: string; operationId: string }>;
  forkRequests?: Record<string, { taskId: string; sourceTaskId: string; sourceRunId: string; operationId: string; action?: string; intent?: string }>;
  preparationRequests?: Record<string, { taskId: string; runId: string; durableId: number }>;
  backgroundCommandRequests?: Record<string, { taskId: string; eventId: string; sessionId: string; durableId: number }>;
  nativeTurnRequests?: Record<string, NativeTurnReceipt>;
  nativeBackgroundRequests?: Record<string, { taskId: string; workId: string; sessionId: string; durableId: number }>;
  backgroundStopRequests?: Record<string, { taskId: string; sessionId: string; runId: string | null; durableId: number }>;
  subagentStopRequests?: Record<string, { rootId: string; agentId: string; sessionId: string; childTurnId: string; durableId: number }>;
  sidebarRequests?: Record<string, { taskId: string; digest: string; cleanupId?: number }>;
  titleRequests?: Record<string, { taskId: string; durableId: number; kind: 'initial' | 'regenerate'; status: 'pending' | 'completed' | 'failed' | 'interrupted' | 'superseded';
    modelSelection?: TextGenerationModelSelection;
    sessions?: Record<string, { threadId: string; turnId?: string; codexHome?: string; claudeHome?: string }> }>;
};
export type AgentInfo = { id: string; name: string; installed: boolean; executable: string | null; executableSupported: boolean; description: string };
export type ExecutionUpdate = NativeRuntimeUpdate | import('./task-subagent-types.js').SubagentRuntimeUpdate | import('./task-subagent-types.js').SubagentBackgroundUpdate
  | { kind: 'goal'; goal: import('./codex-goals.js').TaskGoal | null }
  | { kind: 'contextUsage'; usage: import('./task-context-usage.js').TaskContextUsage | null }
  | { kind: 'session'; threadId: string; codexHome?: string; claudeHome?: string; piHome?: string; grokHome?: string; nativeProviderAccount?: string; model?: string; reasoningEffort?: string; modelOptions?: import('./provider-models.js').ProviderOptionSelection[]; executionSessionId?: string }
  | { kind: 'turn'; turnId: string }
  | { kind: 'nativeHead'; head: string; turnIds?: string[] }
  | { kind: 'resumeApplied' }
  | { kind: 'ready'; canSteer: boolean }
  | { kind: 'backgroundWaiting'; waiting: boolean }
  | { kind: 'output'; text: string }
  | { kind: 'event'; eventKind: string; text: string }
  | { kind: 'item'; item: TaskEvent }
  | { kind: 'commandOutput'; eventId: string; delta: string; reset?: boolean; truncated?: boolean }
  | { kind: 'backgroundCommand'; sessionId: string; threadId: string; item: TaskEvent; disconnected?: boolean }
  | { kind: 'backgroundCommandOutput'; sessionId: string; threadId: string; eventId: string; delta: string }
  | { kind: 'approval'; approval: Approval }
  | { kind: 'approvalResolved'; id: string }
  | { kind: 'workspace'; reason: string }
  | { kind: 'idea'; id: string; text: string }
  | { kind: 'memory'; id: string; text: string }
  | { kind: 'note'; id: string; title: string; content: string };
export type TaskMcpConnection = { url: string; headers: Record<string, string> };
export type ExecutionRequest = { task: WorkItem; prompt: string; userText?: string; contextText?: string; command?: 'compact'; contextBeforeCompaction?: import('./task-context-usage.js').TaskContextUsage | null; images?: ExecutionImage[]; purpose?: 'git_text' | 'task_title' | 'review_guide'; signal: AbortSignal; update: (update: ExecutionUpdate) => Promise<void>; beforeStart?: () => Promise<void>; finalized?: Promise<void>; taskMcp?: TaskMcpConnection; createNativeTaskMcp?: (sessionId: string, currentRun: () => Promise<string | undefined>, signal: AbortSignal) => Promise<TaskMcpConnection> };
export type TextGenerationRequest = ExecutionRequest & { purpose: 'task_title' };
export interface Executor {
  uploadFeedback?(task: WorkItem, reason: string | undefined, signal: AbortSignal): Promise<string>;
  supportsTaskTools?(agent: string): boolean;
  readSubagentHistory?(task: WorkItem, parentThreadId: string, signal: AbortSignal): Promise<import('./codex-history.js').CodexHistorySnapshot>;
  syncSubagentHistory?(task: WorkItem, snapshot: import('./codex-history.js').CodexHistorySnapshot, apply: (connected: boolean) => Promise<import('./codex-history.js').SubagentHistoryProjection | undefined>): Promise<void>;
  deferredStart?(agent: string): boolean;
  run(request: ExecutionRequest): Promise<string>;
  generateText?(request: TextGenerationRequest): Promise<string>;
  answer(taskId: string, approvalId: string, decision: import('./provider-approvals.js').ApprovalDecision, answers: Record<string, string[]>): Promise<void>;
  steer(taskId: string, text: string, requestId: string, images?: ExecutionImage[]): Promise<void>;
  rewind?(request: NativeRewindRequest): Promise<NativeRewindResult>;
  fork?(request: NativeForkRequest): Promise<NativeForkResult>;
  stopBackgroundCommand?(task: WorkItem, command: TaskBackgroundCommand): Promise<void>;
  close?(): Promise<void>;
  hasSession?(taskId: string): boolean;
  waitNativeTurn?(taskId: string, sessionId: string, key: string, signal: AbortSignal): Promise<void>;
  stopNativeSession?(taskId: string, sessionId: string): Promise<void>;
  interruptNativeTurn?(taskId: string, sessionId: string, key: string): Promise<void>;
  interruptExecution?(task: WorkItem, runId: string): Promise<void>;
  settleNativeBackground?(task: WorkItem): Promise<void>;
  stopNativeBackground?(task: WorkItem, work: NativeBackgroundWork): Promise<void>;
  stopSubagent?(task: WorkItem, agent: import('./task-subagent-types.js').TaskSubagent, signal: AbortSignal): Promise<void>;
}
export const activeStatuses: TaskStatus[] = ['queued', 'running', 'waiting'];
