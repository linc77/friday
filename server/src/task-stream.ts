import { createHash } from 'node:crypto';
import { publicProviderState } from './provider-public-state.js';
import type { WorkItem, Workspace } from './types.js';
import { taskSidebarActivity } from './task-sidebar-activity.js';
import { backgroundCommandActivity } from './task-background-commands.js';

export const contentVersion = (task: WorkItem) => createHash('sha256').update(JSON.stringify(task)).digest('hex');

/** The sidebar needs identity, lifecycle and activity metadata, never another
 * thread's prompts, answers, attachments, approvals or queued input bodies. */
export function taskSummary(task: WorkItem, sequence: number): WorkItem {
  if (task.agent === 'friday') return task;
  const { prompt: _, result: _result, events: _events, messages: _messages, approvals: _approvals, feedback: _feedback, goal: _goal,
    runs, queue, gitOperation, gitOperations: _gitOperations, rewindOperation, rewindOperations: _rewindOperations,
    eventArchive: _archive, history, conversationHistory: _conversation, backgroundCommands: _backgroundCommands, nativeBackgroundWork: _nativeBackgroundWork, subagents: _subagents, ...metadata } = task;
  const current = runs?.find(run => run.id === task.currentRunId || run.turnId && run.turnId === task.turnId);
  const activityStartedAt = task.events.findLast(event => event.kind === 'turn' && event.turnId && event.turnId === task.turnId)?.at
    ?? current?.startedAt ?? current?.workspacePreparation?.startedAt ?? task.events.findLast(event => event.kind === 'user')?.at ?? task.messages?.findLast(message => message.role === 'user')?.at ?? task.createdAt;
  return { ...metadata, prompt: '', result: '', events: [], approvals: [],
    activityStartedAt, sidebarActivity: taskSidebarActivity(task), backgroundActivity: backgroundCommandActivity(task),
    contentOmitted: true, contentVersion: contentVersion(task), contentSequence: sequence,
    ...(runs ? { runs: runs.filter(run => run.id === task.currentRunId).map(({ before: _before, after: _after, changes: _changes, ...run }) => run) } : {}),
    ...(queue ? { queue: { ...queue, messages: queue.messages.map(({ contexts: _contexts, ...message }) => ({ ...message, text: '', images: [] })) } } : {}),
    ...(gitOperation ? { gitOperation: { ...gitOperation, files: [], output: [], commitMessage: '', generatedPullRequest: undefined, generation: undefined, generations: undefined } } : {}),
    ...(rewindOperation ? { rewindOperation: { ...rewindOperation, removedRunIds: [], removedExecutionRunIds: [], removeTurns: [], keepTurns: [], checkpoint: undefined, backup: undefined, nativeStart: undefined, nativeResult: undefined,
      editor: { text: '', images: [], interactionMode: rewindOperation.editor.interactionMode } } } : {}),
    ...(task.forkOperation ? { forkOperation: { ...task.forkOperation, expectedTurns: [], nativeResult: undefined, nativePrefix: undefined } } : {}),
    ...(history ? { history: { ...history, recent: [], touches: [], messageTouches: [] } } : {}) };
}
export function taskOverview(state: Workspace, session: string): Workspace {
  const { requests: _, usageSourceResetRequests: _sourceResets, usageSourceResetTail: _sourceTail, taskFeedbackRequests: _feedback, providerCreditResets: _creditResets, providerCreditAccounts: _creditAccounts, taskMetadataRequests: _metadataRequests, queueTail: _queue, assistantQueueTail: _assistantQueue, branchRequests: _branches, gitRequests: _git, changeRequestRequests: _changeRequests,
    changeRequestLinkRequests: _links, changeRequestWatchRequests: _watches,
    rewindRequests: _rewinds, forkRequests: _forks, taskSessionRequests: _sessionRequests, taskTransferRequests: _transferRequests, preparationRequests: _preparations, titleRequests: _titles, sidebarRequests: _sidebar, backgroundCommandRequests: _background, nativeTurnRequests: _nativeTurns, nativeBackgroundRequests: _nativeBackground, backgroundStopRequests: _backgroundStops, subagentStopRequests: _subagentStops, ...visible } = publicProviderState(state);
  return { ...visible, requests: {}, taskStreamSession: session, tasks: state.tasks.map(task => taskSummary(task, state.revision)) };
}
export type TaskSummaryPatch = { sessionId: string; sequence: number; tasks: WorkItem[]; removed: string[]; order?: string[] };
export function overviewChange(previous: Workspace, next: Workspace): { snapshot: true } | { snapshot: false; patch: TaskSummaryPatch | null } {
  // The revision is an ordering cursor, not a reason to resend unrelated root data.
  const root = ({ tasks: _, revision: _revision, taskStreamSerial: _serial, ...state }: Workspace) => JSON.stringify(state);
  if (root(previous) !== root(next)) return { snapshot: true };
  const old = new Map(previous.tasks.map(task => [task.id, task]));
  const digest = (task: WorkItem) => { const { contentSequence: _, ...body } = task; return JSON.stringify(body); };
  const tasks = next.tasks.filter(task => !old.has(task.id) || digest(old.get(task.id)!) !== digest(task));
  const ids = new Set(next.tasks.map(task => task.id)); const removed = previous.tasks.filter(task => !ids.has(task.id)).map(task => task.id);
  const order = next.tasks.map(task => task.id); const reordered = JSON.stringify(order) !== JSON.stringify(previous.tasks.map(task => task.id));
  return { snapshot: false, patch: tasks.length || removed.length || reordered ? { sessionId: next.taskStreamSession!, sequence: next.revision, tasks, removed, ...(reordered ? { order } : {}) } : null };
}
