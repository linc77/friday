import { createHash, randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { taskPullRequests } from './task-pull-requests.js';
import { readTaskGitStatus } from './task-git-status.js';
import { changeRequestFileContents } from './task-change-request-file-contents.js';
import { findTaskChangeRequest, pinTaskChangeRequest, readTaskChangeRequest, readTaskChangeRequestSummary, sourceControlRepository, type SourceControlRepository } from './task-change-requests.js';
import { changeRequestDetail, changeRequestActivity, changeRequestFiles, changeRequestEffects, commentBody, reviewComment, object, type ChangeRequestAction, type ChangeRequestVerdict, type ChangeRequestReviewComment } from './task-change-request-data.js';
import type { TaskPullRequest, Workspace } from './types.js';
import { collaborationActions, collaborationEffects, collaborationInput, changeRequestThreads, changeRequestThreadComments, discussionActivity, isCollaborationAction, reviewerCandidates, labelCandidates, type CollaborationAction, type CollaborationInput } from './task-change-request-collaboration.js';
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { ChangeRequestDetail } from './task-change-request-data.js';
import { changeRequestCommits, changeRequestCommitDiff } from './task-change-request-timeline.js';
import { branchActions, branchActionEffects, branchActionInput, isBranchAction, pendingWorkflowRuns, workflowScope, type BranchActionInput, type WorkflowScope } from './task-change-request-branches.js';
import { TaskChangeRequestReviewState, reviewStateInput, type ReviewStateAction, type ReviewStateInput } from './task-change-request-review-state.js';
import { changeRequestMergeMessage } from './task-change-request-data.js';
import { resolveSourceControlPreferences } from './source-control-preferences.js';
import { changeRequestDiffSlice, diffCursor } from './task-change-request-diff.js';
import { sourceControlRateFailure, withSourceControlInteraction } from './source-control-request-policy.js';
import { changeRequestReadScope } from './source-control-read-cache.js';
import { changeRequestSyncKey, decodeCachedStack, decodeChangeRequestSummary, summaryFromDetail, supersedesSummary, sameChangeRequestMetadata, type ChangeRequestSummary } from './task-change-request-summary.js';
import { readStack } from './task-change-request-stack-data.js';
import { parseChangeRequestLink } from './task-change-request-links.js';

export type ChangeRequestOperation = {
  id: string; durableId: number; url: string; action: ChangeRequestAction | 'comment' | 'review' | CollaborationAction | ReviewStateAction;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
  stackNumber?: number; stackURLs?: string[];
  createdAt: string; updatedAt: string; completedEffects: string[]; error?: string; refreshError?: string; resultURL?: string;
};
type Submission = { requestId: string; url: string; action: ChangeRequestOperation['action']; expectedHeadSha?: string; expectedBaseSha?: string; body?: string; verdict?: ChangeRequestVerdict; comments?: ChangeRequestReviewComment[]; mergeMethod?: string } & Omit<CollaborationInput, 'action'> & Omit<ReviewStateInput, 'action'> & Omit<BranchActionInput, 'action'>;
type Input = { taskId: string; operationId: string; repository: SourceControlRepository; number: number; fingerprint: string; input: Submission; effects: string[]; workflowScope?: WorkflowScope; removeAgentCreditsOnMerge?: boolean };
type ReadMode = 'cache' | 'refresh';
type ReadTarget = { repository: SourceControlRepository; pinned: PinnedSourceControlConnection; number: number };
const stamp = () => new Date().toISOString();
const active = (operation: ChangeRequestOperation) => ['queued', 'running'].includes(operation.status);
const usesHead = (input: Submission) => ['review', 'merge', 'update-branch', 'enable-auto-merge', 'delete-branch', 'approve-workflows'].includes(input.action);
function submission(raw: unknown): Submission {
  const v = object(raw);
  if (typeof v.requestId !== 'string' || !/^[\w-]{1,100}$/.test(v.requestId) || ['__proto__', 'constructor', 'prototype'].includes(v.requestId) || typeof v.url !== 'string' || v.url.length > 4096
    || !['comment', 'review', 'merge', 'ready', 'draft', 'close', 'reopen', 'reaction', 'files_viewed', ...branchActions, ...collaborationActions].includes(v.action) || v.expectedHeadSha !== undefined && (typeof v.expectedHeadSha !== 'string' || !/^[a-f\d]{7,64}$/i.test(v.expectedHeadSha))) throw new Error('PR／MR 操作格式无效');
  if (v.expectedBaseSha !== undefined && (typeof v.expectedBaseSha !== 'string' || !/^[a-f\d]{7,64}$/i.test(v.expectedBaseSha))) throw new Error('审查基准版本无效');
  const input: Submission = { requestId: v.requestId, url: v.url, action: v.action, ...(v.expectedHeadSha !== undefined ? { expectedHeadSha: v.expectedHeadSha } : {}), ...(v.expectedBaseSha !== undefined ? { expectedBaseSha: v.expectedBaseSha } : {}) };
  if (isBranchAction(v.action)) Object.assign(input, branchActionInput(v));
  if (isCollaborationAction(v.action)) Object.assign(input, collaborationInput(v));
  if (v.action === 'reaction' || v.action === 'files_viewed') Object.assign(input, reviewStateInput(v));
  if (v.action === 'comment') input.body = commentBody(v.body);
  if (v.action === 'review') {
    if (!['comment', 'approve', 'request-changes'].includes(v.verdict) || !Array.isArray(v.comments) || v.comments.length > 100) throw new Error('审查提交格式无效');
    input.verdict = v.verdict; input.body = commentBody(v.body ?? '', true); input.comments = v.comments.map(reviewComment);
    if (v.verdict === 'comment' && !input.body.trim() && !input.comments!.length) throw new Error('请填写审查意见或添加行批注');
  }
  if (v.mergeMethod !== undefined) { if (!['merge', 'squash', 'rebase'].includes(v.mergeMethod)) throw new Error('合并方式无效'); input.mergeMethod = v.mergeMethod; }
  return input;
}
const receipt = (state: Workspace, id: string) => state.changeRequestRequests && Object.hasOwn(state.changeRequestRequests, id) ? state.changeRequestRequests[id] : undefined;

export class TaskChangeRequestActions {
  readonly definition;
  readonly reviewState: TaskChangeRequestReviewState;
  private readonly readings = new Map<string, ChangeRequestSummary>();
  private readonly held = new Map<string, { at: number; value: unknown }>();
  private readonly checkStates = new Map<string, string>();
  constructor(private readonly engine: Engine) {
    this.reviewState = new TaskChangeRequestReviewState(engine.directory);
    this.definition = defineTask<Input, { phase: 'run'; index: number }, { status: string }, {}>({
      name: 'friday.change_request_action', version: 1, initial: () => ({ phase: 'run', index: 0 }),
      phases: { run: async (task, runtime, ctx) => {
        const input = task.input, index = task.state.checkpoint.index;
        const work = (await this.engine.snapshot()).tasks.find(v => v.id === input.taskId);
        const operation = work?.changeRequestOperations?.find(v => v.id === input.operationId);
        const finish = async (status: ChangeRequestOperation['status'], error?: string) => {
          await this.patch(input.taskId, input.operationId, { status, ...(error ? { error } : {}) });
          this.engine.changeRequestSync.request(input.taskId, input.input.url);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        if (!work || !operation) { await finish('interrupted', 'PR／MR 操作记录不存在'); return; }
        const key = input.effects[index];
        if (!key) {
          try { const { pinned } = await this.connection(input, runtime.signal); await this.remember(input.taskId, await readTaskChangeRequest(pinned, input.repository, input.number, runtime.signal)); }
          catch { if (runtime.signal.aborted) throw new Error('操作已中断'); await this.patch(input.taskId, input.operationId, { refreshError: '操作已提交，请刷新平台状态' }); }
          await finish('completed'); return;
        }
        const completed = await runtime.memo<true | { resultURL?: string }>(key + '-completed', ctx);
        if (completed) {
          await this.completed(input, key, typeof completed === 'object' ? completed : undefined);
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx); return;
        }
        if (await runtime.memo<boolean>(key + '-started', ctx)) { await finish('interrupted', '外部结果尚未确认，请在平台核对。已发送的内容不会自动重发。'); return; }
        let started = false;
        try {
          const { pinned } = await this.connection(input, runtime.signal);
          const detail = await withSourceControlInteraction(true, () => changeRequestDetail(pinned, input.repository, input.number, runtime.signal, { checks: false }));
          if (input.input.expectedBaseSha && detail.baseSha !== input.input.expectedBaseSha) throw new Error('PR／MR 的 Diff 基准已改变，请刷新后重新审查');
          if (usesHead(input.input) && detail.headSha !== input.input.expectedHeadSha) throw new Error('PR／MR 的代码版本已改变，请刷新后重新审查');
          const effect = (await this.effects(pinned, input.repository, detail, input.input, runtime.signal, { keys: input.effects, scope: input.workflowScope, removeAgentCreditsOnMerge: input.removeAgentCreditsOnMerge })).find(v => v.key === key);
          if (!effect) throw new Error('平台操作步骤已改变，请刷新后重新确认');
          await this.patch(input.taskId, input.operationId, { status: 'running' });
          await this.invalidateReference(input.repository, input.number);
          await runtime.memo(key + '-started', true, ctx); started = true;
          const result = await withSourceControlInteraction(true, () => effect.run(runtime.signal)).finally(() => this.invalidateReference(input.repository, input.number));
          await runtime.memo(key + '-completed', result ?? true, ctx);
          await this.completed(input, key, result ?? undefined);
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await finish(started ? 'interrupted' : 'failed', started ? '外部结果尚未确认，请在平台核对。已发送的内容不会自动重发。' : error instanceof Error ? error.message : 'PR／MR 操作失败');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.patch(task.input.taskId, task.input.operationId, { status: 'interrupted', error: '操作已中断，请在平台核对；不会自动重复发送。' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  private patch(id: string, operationId: string, change: Partial<ChangeRequestOperation>) {
    return this.engine.mutate(state => { const op = state.tasks.find(t => t.id === id)?.changeRequestOperations?.find(o => o.id === operationId); if (op) Object.assign(op, change, { updatedAt: stamp() }); });
  }
  private completed(input: Input, key: string, result?: { resultURL?: string }) {
    return this.engine.mutate(state => { const op = state.tasks.find(t => t.id === input.taskId)?.changeRequestOperations?.find(o => o.id === input.operationId); if (op) { if (!op.completedEffects.includes(key)) op.completedEffects.push(key); if (result?.resultURL) op.resultURL = result.resultURL; op.updatedAt = stamp(); } });
  }
  private connection(input: Input, signal?: AbortSignal) {
    return pinTaskChangeRequest(this.engine.directory, input.repository, this.engine.sourceControl, signal, input.fingerprint).then(pinned => ({ pinned }));
  }
  private async effects(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, detail: ChangeRequestDetail, input: Submission, signal?: AbortSignal, captured?: { keys: string[]; scope?: WorkflowScope; removeAgentCreditsOnMerge?: boolean }) {
    return withSourceControlInteraction(true, () => this.planEffects(pinned, repository, detail, input, signal, captured));
  }
  private async planEffects(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, detail: ChangeRequestDetail, input: Submission, signal?: AbortSignal, captured?: { keys: string[]; scope?: WorkflowScope; removeAgentCreditsOnMerge?: boolean }) {
    if (pinned.additional) {
      if (input.action === 'reaction' || input.action === 'files_viewed') return this.reviewState.effects(pinned, repository, detail, input as ReviewStateInput, signal);
      if (isCollaborationAction(input.action)) return pinned.additional.collaborationEffects(detail, input as CollaborationInput, signal);
      return pinned.additional.effects(detail, input, signal);
    }
    const mergeMessage = captured?.removeAgentCreditsOnMerge === true ? await changeRequestMergeMessage(pinned, repository, detail, input.action, input.mergeMethod, signal) : undefined;
    if (isBranchAction(input.action)) return branchActionEffects(pinned, repository, detail, input as BranchActionInput, signal, captured ? { ...captured, ...(mergeMessage ? { mergeMessage } : {}) } : undefined);
    if (input.action === 'reaction' || input.action === 'files_viewed') return this.reviewState.effects(pinned, repository, detail, input as ReviewStateInput, signal);
    if (isCollaborationAction(input.action)) return collaborationEffects(pinned, repository, detail, input as CollaborationInput, signal);
    return changeRequestEffects(pinned, repository, detail, input as Parameters<typeof changeRequestEffects>[3], mergeMessage);
  }
  async remember(id: string, pr: TaskPullRequest, reading?: ChangeRequestSummary) {
    const key = changeRequestSyncKey(pr), current = this.readings.get(key);
    if (reading) {
      if (!supersedesSummary(current, reading)) return;
      this.readings.delete(key); this.readings.set(key, reading);
      while (this.readings.size > 512) this.readings.delete(this.readings.keys().next().value!);
    }
    let stateChanged = false;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), task = state.tasks.find(t => t.id === id); if (!task) return;
      const previous = taskPullRequests(task).find(v => changeRequestSyncKey(v) === key) ?? (task.branchPullRequest && changeRequestSyncKey(task.branchPullRequest) === key ? task.branchPullRequest : undefined);
      if (!previous) return;
      if (previous?.state === 'merged' && pr.state !== 'merged') return;
      if (reading && previous?.snapshot && !supersedesSummary({ snapshot: previous.snapshot, observedAt: previous.observedAt ?? 0 }, reading)) return;
      const next: TaskPullRequest = { ...pr, linkedAt: previous?.linkedAt ?? stamp(), ...(previous?.linkSource ? { linkSource: previous.linkSource } : {}),
        ...(previous?.watch ? { watch: previous.watch } : {}), ...(previous?.endedWatch ? { endedWatch: previous.endedWatch } : {}),
        ...(reading ? { snapshot: { ...reading.snapshot, syncedAt: previous?.snapshot?.syncedAt ?? stamp() }, observedAt: reading.observedAt } : previous?.snapshot && previous.state === pr.state ? { snapshot: previous.snapshot, observedAt: previous.observedAt } : {}) };
      const comparable = (value: TaskPullRequest) => ({ ...value, observedAt: undefined, snapshot: value.snapshot ? { ...value.snapshot, syncedAt: undefined } : undefined });
      if (previous && sameChangeRequestMetadata(comparable(previous), comparable(next))) return;
      stateChanged = !!previous && previous.state !== next.state;
      if (next.snapshot) next.snapshot.syncedAt = stamp();
      if (task.branchPullRequest && changeRequestSyncKey(task.branchPullRequest) === key && !taskPullRequests(task).some(link => changeRequestSyncKey(link) === key)) { task.branchPullRequest = next; state.revision++; return; }
      const values = task.changeRequests ?? [], index = values.findIndex(v => changeRequestSyncKey(v) === key);
      task.changeRequests = index < 0 ? [...values, next] : values.map((value, at) => at === index ? next : value); state.revision++;
    }, context);
    if (stateChanged) { this.engine.changeRequestSync.request(id, pr.url); this.engine.changeRequestDiscovery.request(id); this.engine.taskSettlement.notify(); }
  }
  async target(id: string, url: unknown, signal?: AbortSignal) {
    if (typeof url !== 'string' || url.length > 4096) throw new Error('PR／MR 地址无效');
    const work = (await this.engine.snapshot()).tasks.find(t => t.id === id);
    if (!work || work.agent === 'friday') throw new Error('本地任务不存在');
    let pr = [...taskPullRequests(work), ...(work.branchPullRequest ? [work.branchPullRequest] : [])].find(v => v.url === url);
    const openedView = this.engine.changeRequestLinks.view(id, url), view = !pr ? openedView : undefined;
    pr ??= view?.pr;
    if (!pr) {
      const requested = parseChangeRequestLink(url);
      if (requested) for (const [parentURL, stack] of Object.entries(work.changeRequestStacks ?? {})) {
        const parent = taskPullRequests(work).find(pr => pr.url === parentURL) ?? (work.branchPullRequest?.url === parentURL ? work.branchPullRequest : undefined), layer = stack?.layers.find(layer => layer.number === requested.number);
        if (parent && layer && changeRequestSyncKey({ ...parent, number: requested.number }) === changeRequestSyncKey(requested)) { pr = { ...requested, title: layer.title ?? requested.title, head: layer.headBranch, base: stack!.base, state: layer.state }; break; }
      }
    }
    if (!pr) {
      // The client's URL cannot choose a credential destination. Only an
      // associated request or this task's current remote/branch may be adopted.
      const git = await readTaskGitStatus(work.cwd, { directory: this.engine.directory, workspace: work.executionWorkspace }, this.engine.sourceControl);
      if (!git.sourceControl || !git.branch) throw new Error('这个任务没有关联该 PR／MR');
      const pinned = await pinTaskChangeRequest(this.engine.directory, git.sourceControl, this.engine.sourceControl, signal);
      const found = await findTaskChangeRequest(pinned, git.sourceControl, git.branch, signal);
      if (!found || found.url !== url) throw new Error('这个任务没有关联该 PR／MR');
      pr = found;
      await this.engine.mutate(state => { const task = state.tasks.find(task => task.id === id); if (task && task.cwd === work.cwd && task.projectId === work.projectId) task.branchPullRequest = found; });
    }
    const parsed = new URL(pr.url);
    const marker = pr.provider === 'forgejo' || pr.provider === 'gitcafe' ? '/pulls/' : pr.provider === 'azure-devops' ? '/pullrequest/' : pr.provider === 'gitlab' || parsed.hostname === 'gitlab.com' ? '/-/merge_requests/' : pr.provider === 'bitbucket' || parsed.hostname === 'bitbucket.org' ? '/pull-requests/' : '/pull/';
    const path = pr.repository ?? parsed.pathname.split(marker)[0].replace(/^\//, '');
    const repository = pr.provider === 'forgejo' || pr.provider === 'gitcafe' || pr.provider === 'azure-devops' ? await this.engine.sourceControl.repository(this.engine.directory, `${parsed.origin}/${path}`) : sourceControlRepository(`https://${parsed.host}/${path}.git`, pr.provider === 'github' || marker === '/pull/' ? [parsed.host] : [], marker === '/-/merge_requests/' ? [parsed.host] : []);
    if (!repository || repository.provider !== (pr.provider ?? repository.provider) || (parsed.protocol !== 'https:' && !(repository.provider === 'forgejo' && parsed.protocol === 'http:')) || parsed.username || parsed.password || parsed.pathname !== `/${path}${marker}${pr.number}` || parsed.search || parsed.hash) throw new Error('关联的 PR／MR 目标无效');
    const pinned = await pinTaskChangeRequest(this.engine.directory, repository, this.engine.sourceControl, signal, view?.fingerprint);
    return { repository, pinned, number: pr.number, url: pr.url };
  }
  async invalidateReference(repository: SourceControlRepository, number: number) {
    this.engine.sourceControl.checks.invalidate(repository.host, repository.path, number);
    await this.engine.sourceControl.reads.invalidate(changeRequestReadScope(repository, number));
    this.engine.sourceControl.checks.invalidate(repository.host, repository.path, number);
  }
  async invalidatePresentation(pr: TaskPullRequest) {
    if (!pr.provider || !pr.host || !pr.repository) return;
    await this.engine.sourceControl.reads.invalidate(changeRequestReadScope({ provider: pr.provider, host: pr.host, path: pr.repository }, pr.number) + ':presentation');
    this.engine.sourceControl.checks.invalidate(pr.host, pr.repository, pr.number);
  }
  private async read<T>(id: string, target: ReadTarget, kind: string, parameters: unknown[], lookup: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, mode?: ReadMode, ttl = 60_000, decode?: (value: unknown) => T | undefined) {
    if (!mode || !target.pinned.fingerprint) return lookup(signal);
    const state = await this.engine.snapshot(), task = state.tasks.find(value => value.id === id); if (!task) throw new Error('本地任务不存在');
    const project = state.projects.find(value => value.id === task.projectId), projectScope = 'project:' + (task.projectId ?? task.cwd);
    const scope = changeRequestReadScope(target.repository, target.number);
    if (mode === 'refresh') await this.invalidateReference(target.repository, target.number);
    const key = JSON.stringify([kind, task.projectId ?? null, project?.path ?? task.cwd, scope, target.pinned.fingerprint, parameters]);
    const merged = taskPullRequests(task).some(pr => pr.number === target.number && pr.state === 'merged' && pr.host === target.repository.host && pr.repository === target.repository.path);
    const scopes = [projectScope, scope, ...(['summary', 'stack'].includes(kind) ? [] : [scope + ':presentation'])];
    const heldKey = key, held = this.held.get(heldKey);
    let value: T;
    try { value = await this.engine.sourceControl.reads.get(key, signal => mode === 'refresh' ? withSourceControlInteraction(true, () => lookup(signal)) : lookup(signal), { signal, scopes, bucket: kind, ...(decode ? { persist: true, decode } : {}),
      ttl: value => kind === 'detail' ? object(object(value).pullRequest).state === 'merged' ? 10 * 60_000 : ttl : kind === 'activity' && merged ? 10 * 60_000 : ttl,
      cacheable: value => object(value).checksUnavailable !== true && object(value).commitsUnavailable !== true && object(value).workflowApprovalsUnavailable !== true }); }
    catch (error) {
      signal?.throwIfAborted();
      const status = error instanceof Error && 'status' in error ? Number(error.status) : 0;
      if (kind !== 'detail' || mode === 'refresh' || !held || Date.now() - held.at > 10 * 60_000 || !(sourceControlRateFailure(error) || status >= 500 || error instanceof TypeError)) throw error;
      return { ...structuredClone(held.value) as T, stale: true, ...(sourceControlRateFailure(error) ? { retryAt: sourceControlRateFailure(error)?.retryAt } : {}) };
    }
    if (kind === 'detail') {
      const previous = held?.value as ChangeRequestDetail | undefined, next = value as ChangeRequestDetail;
      if (previous && !supersedesSummary(summaryFromDetail(previous, held!.at), summaryFromDetail(next))) return structuredClone(previous) as T;
      this.held.delete(heldKey); this.held.set(heldKey, { at: Date.now(), value: structuredClone(value) });
      while (this.held.size > 128) this.held.delete(this.held.keys().next().value!);
    }
    return value;
  }
  async summary(id: string, url: string, signal?: AbortSignal, refresh = false) {
    const t = await this.target(id, url, signal);
    return this.read(id, t, 'summary', [], signal => t.repository.provider === 'github' ? this.engine.sourceControl.summaries.get(t.pinned, t.repository, t.number, signal) : readTaskChangeRequestSummary(t.pinned, t.repository, t.number, signal), signal, refresh ? 'refresh' : 'cache', 60_000, decodeChangeRequestSummary);
  }
  async stack(id: string, url: unknown, signal?: AbortSignal, details = true) {
    const t = await this.target(id, url, signal);
    return this.read(id, t, 'stack', [details], signal => readStack(t.pinned, t.repository, t.number, signal, details), signal, 'cache', 60_000, decodeCachedStack);
  }
  async detail(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) {
    const target = await this.target(id, url, signal);
    const detail = await this.read(id, target, 'detail', [], signal => this.detailAt(id, target, signal), signal, mode);
    return Object.assign({ ...detail }, { reviewGuidesEnabled: (await this.engine.snapshot()).textGenerationSettings?.defaults.reviewGuidesEnabled ?? false });
  }
  private async detailAt(id: string, target: ReadTarget, signal?: AbortSignal) {
    const observedAt = Date.now();
    const detail = await changeRequestDetail(target.pinned, target.repository, target.number, signal);
    await this.remember(id, detail.pullRequest, summaryFromDetail(detail, observedAt));
    this.noteCheckState(target, { ...detail, state: detail.pullRequest.state });
    if (detail.actions.includes('approve-workflows')) {
      try { detail.workflowApprovalsRequired = (await pendingWorkflowRuns(target.pinned, target.repository, detail, signal)).length; }
      catch { signal?.throwIfAborted(); detail.workflowApprovalsUnavailable = true; }
    }
    return detail;
  }
  async activity(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) {
    const t = await this.target(id, url, signal);
    return this.read(id, t, 'activity', [], signal => this.activityAt(t, signal), signal, mode);
  }
  private async activityAt(t: ReadTarget, signal?: AbortSignal) {
    if (t.pinned.additional) return t.pinned.additional.activity(t.number, signal);
    const timeline = changeRequestCommits(t.pinned, t.repository, t.number, signal).catch(() => { signal?.throwIfAborted(); return { commits: [], commitsTruncated: false, commitsUnavailable: true }; });
    const baseRead = changeRequestActivity(t.pinned, t.repository, t.number, signal);
    const [base, threads, commits, reactions] = await Promise.all([
      baseRead, t.repository.provider === 'bitbucket' ? baseRead.then(value => changeRequestThreads(t.pinned, t.repository, t.number, signal, value.bitbucketComments)) : changeRequestThreads(t.pinned, t.repository, t.number, signal), timeline,
      t.repository.provider === 'gitlab' ? this.reviewState.reactions(t.pinned, t.repository, t.number, signal) : undefined,
    ]);
    const activity = discussionActivity(base, threads, reactions);
    const dismissals = 'dismissals' in commits ? commits.dismissals : undefined;
    return { ...activity, ...commits, items: activity.items.map(item => ({ ...item, ...(item.sourceID && dismissals?.[item.sourceID] ? { dismissalMessage: dismissals[item.sourceID] } : {}) })) };
  }
  async checks(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) {
    const t = await this.target(id, url, signal);
    const result = await this.read(id, t, 'checks', [], signal => this.engine.sourceControl.checks.get(t.pinned, t.repository, t.number, async () => {
      const detail = await changeRequestDetail(t.pinned, t.repository, t.number, signal);
      const workflowApprovalsRequired = detail.actions.includes('approve-workflows') ? (await pendingWorkflowRuns(t.pinned, t.repository, detail, signal)).length : 0;
      return { state: detail.pullRequest.state, headSha: detail.headSha, updatedAt: detail.updatedAt, isDraft: detail.isDraft, mergeability: detail.mergeability, checks: detail.checks, checksState: detail.checksState, checksUnavailable: detail.checksUnavailable, workflowApprovalsRequired };
    }, signal), signal, mode, 15_000);
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === id), previous = task && taskPullRequests(task).find(pr => pr.url === url);
    const key = this.checkStateKey(t), priorState = this.checkStates.get(key), nextState = this.checkState(result); this.noteCheckState(t, result);
    if (previous && (priorState !== undefined && priorState !== nextState || previous.state !== result.state || previous.snapshot?.headSha && previous.snapshot.headSha !== result.headSha || previous.snapshot?.updatedAt && result.updatedAt && previous.snapshot.updatedAt !== result.updatedAt
      || previous.snapshot?.isDraft !== undefined && result.isDraft !== undefined && previous.snapshot.isDraft !== result.isDraft)) {
      await this.invalidatePresentation(previous); this.engine.changeRequestSync.request(id, previous.url);
    }
    return result;
  }
  private checkState(value: { state: string; headSha: string; updatedAt?: string; isDraft?: boolean; mergeability?: string }) { return JSON.stringify([value.state, value.headSha, value.updatedAt, value.isDraft, value.mergeability]); }
  private checkStateKey(t: ReadTarget) { return JSON.stringify([t.pinned.fingerprint, changeRequestReadScope(t.repository, t.number)]); }
  private noteCheckState(t: ReadTarget, value: { state: string; headSha: string; updatedAt?: string; isDraft?: boolean; mergeability?: string }) {
    const key = this.checkStateKey(t); this.checkStates.delete(key); this.checkStates.set(key, this.checkState(value));
    while (this.checkStates.size > 512) this.checkStates.delete(this.checkStates.keys().next().value!);
  }
  async fileContents(id: string, url: unknown, input: { path: unknown; head: unknown; side: unknown; commit?: unknown; cursor?: unknown; base?: unknown; slice?: unknown }, signal?: AbortSignal, mode?: ReadMode) {
    const target = await this.target(id, url, signal); return this.read(id, target, 'file-contents', [input], signal => changeRequestFileContents(target.pinned, target.repository, target.number, input, signal), signal, mode);
  }
  async commit(id: string, url: unknown, hash: unknown, signal?: AbortSignal, mode?: ReadMode) {
    if (typeof hash !== 'string' || !/^[a-f\d]{7,64}$/i.test(hash)) throw new Error('提交版本无效');
    const t = await this.target(id, url, signal); return this.read(id, t, 'commit', [hash], signal => changeRequestCommitDiff(t.pinned, t.repository, t.number, hash, signal), signal, mode, 10 * 60_000);
  }
  async threadComments(id: string, url: unknown, thread: unknown, cursor: unknown, signal?: AbortSignal) { const t = await this.target(id, url, signal); return changeRequestThreadComments(t.pinned, t.repository, t.number, thread, cursor, signal); }
  async reviewers(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) { const t = await this.target(id, url, signal); return this.read(id, t, 'reviewers', [], signal => reviewerCandidates(t.pinned, t.repository, t.number, signal), signal, mode); }
  async labels(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) { const t = await this.target(id, url, signal); return this.read(id, t, 'labels', [], signal => labelCandidates(t.pinned, t.repository, t.number, signal), signal, mode); }
  async viewed(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) { const t = await this.target(id, url, signal); return this.read(id, t, 'viewed', [], signal => this.reviewState.viewed(t.pinned, t.repository, t.number, signal), signal, mode, 15_000); }
  async reactions(id: string, url: unknown, signal?: AbortSignal, mode?: ReadMode) { const t = await this.target(id, url, signal); return this.read(id, t, 'reactions', [], signal => this.reviewState.reactions(t.pinned, t.repository, t.number, signal), signal, mode, 15_000); }
  async files(id: string, url: unknown, head: unknown, signal?: AbortSignal, mode?: ReadMode) {
    if (typeof head !== 'string' || !/^[a-f\d]{7,64}$/i.test(head)) throw new Error('PR／MR 版本无效');
    const t = await this.target(id, url, signal); return this.read(id, t, 'files', [head], signal => changeRequestFiles(t.pinned, t.repository, t.number, head, signal), signal, mode);
  }
  async diff(id: string, url: unknown, input: { head: unknown; base?: unknown; cursor?: unknown; commit?: unknown }, signal?: AbortSignal, mode?: ReadMode) {
    const target = await this.target(id, url, signal); return this.read(id, target, 'diff', [input], signal => changeRequestDiffSlice(target.pinned, target.repository, target.number, input, signal), signal, mode);
  }
  async start(id: string, raw: unknown) {
    if (object(raw).stackNumber !== undefined && object(raw).action !== 'delete-branch') throw new Error('请使用堆叠 PR 操作入口');
    const input = submission(raw), digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const checkReceipt = (state: Workspace) => { const saved = receipt(state, input.requestId); if (saved && (saved.taskId !== id || saved.digest !== digest)) throw new Error('PR／MR 请求 ID 已用于不同操作'); return saved; };
    const existing = checkReceipt(await this.engine.snapshot()); if (existing) return existing.operationId;
    const target = await this.target(id, input.url);
    const detail = await withSourceControlInteraction(true, () => changeRequestDetail(target.pinned, target.repository, target.number, undefined, { checks: false }));
    if (input.expectedBaseSha && detail.baseSha !== input.expectedBaseSha) throw new Error('PR／MR 的 Diff 基准已改变，请刷新后重新审查');
    if (usesHead(input) && input.expectedHeadSha && detail.headSha !== input.expectedHeadSha) throw new Error('PR／MR 的代码版本已改变，请刷新后重新审查');
    const effects = (await this.effects(target.pinned, target.repository, detail, input)).map(v => v.key);
    const operationId = randomUUID();
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); if (checkReceipt(state)) return;
      if (state.tasks.some(t => t.changeRequestOperations?.some(v => (v.stackURLs ? v.stackURLs.some(url => url.toLowerCase() === input.url.toLowerCase()) : v.url === input.url) && active(v)))) throw new Error('这个 PR／MR 已有操作正在发送，请等待完成');
      const task = state.tasks.find(t => t.id === id); if (!task) throw new Error('本地任务不存在');
      const durableId = await tx.createTask(this.definition, { taskId: id, operationId, repository: target.repository, number: target.number, fingerprint: target.pinned.fingerprint, ...(target.repository.provider === 'github' && ['merge', 'enable-auto-merge'].includes(input.action) && resolveSourceControlPreferences(state, task.projectId ?? null).effective.removeAgentCreditsOnMerge ? { removeAgentCreditsOnMerge: true } : {}), input: { ...input, expectedHeadSha: input.expectedHeadSha ?? detail.headSha, ...(input.action === 'review' && input.comments?.length && detail.baseSha ? { expectedBaseSha: input.expectedBaseSha ?? detail.baseSha } : {}) }, effects, ...(input.action === 'approve-workflows' ? { workflowScope: workflowScope(detail) } : {}) }, { ownership: { kind: 'conversation' } });
      task.changeRequestOperations = [...(task.changeRequestOperations ?? []).filter(v => active(v)).concat((task.changeRequestOperations ?? []).filter(v => !active(v)).slice(-39)), { id: operationId, durableId, url: input.url, action: input.action, status: 'queued', createdAt: stamp(), updatedAt: stamp(), completedEffects: [] }];
      state.changeRequestRequests ??= {}; state.changeRequestRequests[input.requestId] = { taskId: id, operationId, digest }; state.revision++;
    }, context);
    this.engine.harness.resume();
    return receipt(await this.engine.snapshot(), input.requestId)!.operationId;
  }
  async stopBeforeDelete(id: string) {
    for (const operation of (await this.engine.snapshot()).tasks.find(t => t.id === id)?.changeRequestOperations ?? []) {
      if (!active(operation)) continue;
      await this.engine.harness.abortTask(operation.durableId as TaskId, context);
      await this.engine.harness.waitForTask(operation.durableId as TaskId, context);
    }
  }
  close() { this.reviewState.close(); this.readings.clear(); this.held.clear(); this.checkStates.clear(); }
}
