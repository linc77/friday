import { creationSelection, resolveCreationContext, verifyCreationRemotes, type ChangeRequestCreationSelection, type ChangeRequestCreationContext } from './task-change-request-creation.js';
import { createHash, randomUUID } from 'node:crypto';
import { linkTaskChangeRequest } from './task-change-request-links.js';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { activeGitOperation, activeStatuses, type TaskGitAction, type TaskGitOperation, type WorkItem } from './types.js';
import { branchBlocksTask, directoriesOverlap } from './branch-switch.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';
import { queueRunning } from './task-queue.js';
import { taskGit } from './git-process.js';
import { readTaskGitStatus, type TaskGitStatus } from './task-git-status.js';
import { readTaskDiff, workspaceRelativePath } from './task-changes.js';
import { privateWorkspacePaths } from './workspace-privacy.js';
import { readChangeRequestTemplate, resolveSourceControlPolicy, sourceControlWritingPrompt } from './source-control-writing.js';
import { createPublishedRepository, repositoryPublishInput, validatePublishAccount, type RepositoryPublishInput } from './task-repository-publish.js';
import { pinTaskChangeRequest, findTaskChangeRequest, createTaskChangeRequest, readTaskChangeRequest, type TaskChangeRequestTarget } from './task-change-requests.js';

type GitInput = { id: string; operationId: string };
type GitCheckpoint = { phase: 'queued' } | { phase: 'run'; index: number };
type StepResult = Partial<Pick<TaskGitOperation, 'commitMessage' | 'featureBranch' | 'head' | 'branch' | 'commitSHA' | 'pullRequest' | 'generatedPullRequest' | 'repositoryPublication' | 'remote' | 'remoteFingerprint' | 'changeRequestBaseCommit'>>;
export type StartTaskGitOperation = {
  requestId: string; action: TaskGitAction; fingerprint: string; filePaths?: string[]; commitMessage?: string;
  featureBranch?: boolean; branchName?: string; confirmedDefaultBranch?: boolean;
  repositoryPublish?: RepositoryPublishInput;
  creation?: ChangeRequestCreationSelection;
};
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stamp = () => new Date().toISOString();
const publishAction = (action: TaskGitAction) => ['push', 'create_pr', 'commit_push', 'commit_push_pr'].includes(action);
const commitAction = (action: TaskGitAction) => ['commit', 'commit_push', 'commit_push_pr'].includes(action);
const pullRequestAction = (action: TaskGitAction) => ['create_pr', 'commit_push_pr'].includes(action);
function selectedPaths(review: TaskGitStatus, selected?: string[]) {
  const files = selected ?? review.files.map(file => file.path);
  if (new Set(files).size !== files.length || files.some(path => !review.files.some(file => file.path === workspaceRelativePath(path)))) throw new Error('选择的文件已经改变，请刷新改动后重试');
  if (selected && !files.length) throw new Error('请至少选择一个文件');
  return files;
}
function parsedText(value: string): Record<string, unknown> {
  const text = value.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '');
  try { const data = JSON.parse(text); if (data && typeof data === 'object' && !Array.isArray(data)) return data; } catch {}
  throw new Error('模型没有返回可用的 Git 说明，请填写说明后重试');
}
function branchSuggestion(value: string) {
  const clean = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return 'linc/' + (clean || 'update') + '-' + randomUUID().slice(0, 6);
}

export class TaskGitOperations {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<GitInput, GitCheckpoint, { status: string }, {}>({
      name: 'friday.git_operation', version: 1, initial: () => ({ phase: 'queued' }),
      phases: {
        queued: async (_task, runtime, ctx) => {
          await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: 0 } }), ctx);
        },
        run: async (task, runtime, ctx) => {
          const work = (await this.engine.snapshot()).tasks.find(work => work.id === task.input.id);
          const operation = work?.gitOperation;
          const finish = async (status: TaskGitOperation['status'], error?: string) => {
            if (operation?.id === task.input.operationId) await this.cleanupBase(operation);
            if (work && operation?.id === task.input.operationId) await this.patch(work.id, operation.id, { status, ...(error ? { error } : {}) });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
          };
          if (!work || !operation || operation.id !== task.input.operationId) { await finish('interrupted', 'Git 操作记录已改变'); return; }
          const index = task.state.checkpoint.index;
          const step = operation.steps[index];
          if (!step) { await finish('completed'); return; }
          const key = `step-${index}`;
          const completed = await runtime.memo<StepResult>(key + '-completed', ctx);
          if (completed !== undefined) {
            await this.patch(work.id, operation.id, completed);
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx); return;
          }
          if (await runtime.memo<boolean>(key + '-started', ctx)) {
            await finish('interrupted', '这一步的外部结果尚未确认。请核对 Git 状态后选择下一步，不会自动重复提交或发布。'); return;
          }
          try {
            await this.assertAvailable(work, operation);
            await this.patch(work.id, operation.id, { status: 'running', phase: step, phaseStartedAt: stamp(), error: null });
            await runtime.memo(key + '-started', true, ctx);
            const result = await this.step(work, operation, step, runtime.signal);
            await runtime.memo(key + '-completed', result, ctx);
            await this.patch(work.id, operation.id, result);
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'run', index: index + 1 } }), ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await finish('failed', error instanceof Error ? error.message : 'Git 操作失败');
          }
        },
      },
      abort: async (task, runtime, ctx) => {
        const operation = (await this.engine.snapshot()).tasks.find(t => t.id === task.input.id)?.gitOperation;
        if (operation?.id === task.input.operationId) await this.cleanupBase(operation);
        await this.patch(task.input.id, task.input.operationId, { status: 'interrupted', error: 'Git 操作已中断，请核对当前状态后继续。' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }

  async creationContext(id: string, raw?: unknown) {
    const work = (await this.engine.snapshot()).tasks.find(t => t.id === id);
    if (!work || work.agent === 'friday') throw new Error('本地任务不存在');
    const privacy = {directory:this.engine.directory,workspace:work.executionWorkspace};
    if ((await privateWorkspacePaths(work.cwd,privacy)).includes('')) throw new Error('Friday 数据目录不能作为 Git 发布工作区');
    const review = await readTaskGitStatus(work.cwd,privacy,this.engine.sourceControl);
    return resolveCreationContext(work.cwd,review,this.engine.sourceControl,creationSelection(raw));
  }
  private async cleanupBase(operation: TaskGitOperation) {
    if (!operation.changeRequestCreation) return;
    try { if (await realpath(operation.cwd) === operation.cwd && (await taskGit(operation.cwd,['rev-parse','--show-toplevel'])).stdout.trim() === operation.root) await taskGit(operation.cwd,['update-ref','-d',`refs/friday/create-pr/${operation.id}/base`]); } catch {}
  }

  private async patch(id: string, operationId: string, change: Partial<TaskGitOperation>) {
    await this.engine.mutate(state => {
      const work = state.tasks.find(work => work.id === id);
      if (work?.gitOperation?.id === operationId) {
        Object.assign(work.gitOperation, change, { updatedAt: stamp() });
        if (change.pullRequest) linkTaskChangeRequest(work, change.pullRequest, 'created', stamp());
      }
    });
  }

  private assertIdle(state: Awaited<ReturnType<Engine['snapshot']>>, root: string) {
    if (state.tasks.some(task => directoriesOverlap(root, task.cwd) && (activeStatuses.includes(task.status) || queueRunning(task) || hasRunningBackgroundCommands(task) || activeGitOperation(task.gitOperation)))) throw new Error('当前仓库有执行、队列或 Git 操作正在进行，请等待完成');
    if (branchBlocksTask(state, root)) throw new Error('工作区正在准备或切换分支，请稍后重试');
  }

  async start(id: string, input: StartTaskGitOperation) {
    if (!['commit', 'push', 'create_pr', 'commit_push', 'commit_push_pr', 'pull', 'publish_repository'].includes(input.action)) throw new Error('Git 操作类型无效');
    if (!input.requestId || input.requestId.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(input.requestId)) throw new Error('Git 请求 ID 无效');
    input.creation = creationSelection(input.creation);
    const digest = createHash('sha256').update(JSON.stringify([id,input.action,input.fingerprint,input.filePaths,input.commitMessage,input.featureBranch??false,input.branchName,input.confirmedDefaultBranch??false,input.repositoryPublish,input.creation])).digest('hex');
    const state = await this.engine.snapshot();
    const receipt = state.gitRequests && Object.hasOwn(state.gitRequests, input.requestId) ? state.gitRequests[input.requestId] : undefined;
    if (receipt) { if (receipt.taskId !== id || receipt.digest && receipt.digest !== digest) throw new Error('Git 请求 ID 已用于不同操作'); return receipt.operationId; }
    const work = state.tasks.find(task => task.id === id);
    if (!work || work.agent === 'friday') throw new Error('本地任务不存在');
    const privacy = { directory: this.engine.directory, workspace: work.executionWorkspace };
    if ((await privateWorkspacePaths(work.cwd, privacy)).includes('')) throw new Error('Friday 数据目录不能作为 Git 发布工作区');
    const review = await readTaskGitStatus(work.cwd, privacy, this.engine.sourceControl);
    if (review.status !== 'repository' || !review.root) throw new Error('这个工作区不是 Git 仓库');
    if (review.fingerprint !== input.fingerprint) throw new Error('工作区已经改变，请刷新改动后再确认');
    this.assertIdle(state, review.root);
    const files = selectedPaths(review, input.filePaths);
    if (commitAction(input.action) && input.action === 'commit' && !files.length) throw new Error('没有可提交的改动');
    if (review.files.some(file => file.kind === 'conflict')) throw new Error('请先解决合并冲突再执行 Git 操作');
    const repositoryPublish = input.action === 'publish_repository' ? repositoryPublishInput(input.repositoryPublish) : undefined;
    if (repositoryPublish) {
      if (!review.branch || review.remote || review.upstream) throw new Error('只有尚未配置远端的本地分支才能发布新仓库');
      if (input.featureBranch || input.filePaths || input.commitMessage) throw new Error('发布新仓库不会提交文件或创建分支，请先单独提交');
      await this.assertPublicationPrivacy(work, review);
      await validatePublishAccount(review.cwd, repositoryPublish, undefined, this.engine.sourceControl);
    }
    if (publishAction(input.action) && (!review.branch || !review.remote)) throw new Error('发布前需要一个本地分支和远端仓库');
    if (publishAction(input.action) && !commitAction(input.action) && review.behind > 0) throw new Error('本地分支落后或已分叉，请先拉取并处理后再发布');
    if (publishAction(input.action) && !input.featureBranch && (review.isDefaultBranch || !review.defaultBranch) && !input.confirmedDefaultBranch) throw new Error('请先确认在当前默认分支上发布，或选择新建分支');
    let changeRequestTarget: TaskChangeRequestTarget | undefined;
    let creation: ChangeRequestCreationContext | undefined;
    if (pullRequestAction(input.action)) {
      if (!review.canCreatePR) throw new Error('创建 PR／MR 需要可用的平台认证');
      creation = await resolveCreationContext(review.cwd, review, this.engine.sourceControl, input.creation);
      if (creation.sourceBranch === creation.baseBranch && !input.featureBranch && !creation.isCrossRepository) throw new Error('请先新建功能分支，再创建 PR／MR');
      const pinned = await pinTaskChangeRequest(review.cwd, creation.target, this.engine.sourceControl, undefined, creation.credentialFingerprint);
      await findTaskChangeRequest(pinned, creation.target, creation.sourceBranch, undefined, { source: creation.source, sourceProjectID: creation.sourceProjectID, targetProjectID: creation.targetProjectID, ...(creation.baseWasExplicit ? {base:creation.baseBranch} : {}) });
      changeRequestTarget = { ...creation.target, credentialFingerprint: pinned.fingerprint };
    } else if (input.creation) throw new Error('此 Git 操作不能指定 PR／MR 目标');
    if (input.action === 'pull') {
      if (!review.upstream) throw new Error('当前分支没有上游分支');
      if ((await readTaskGitStatus(review.root, privacy)).files.length) throw new Error('请先提交或保存当前仓库的全部改动，再拉取更新');
      if (review.ahead > 0 && review.behind > 0) throw new Error('分支已经分叉，请在终端中处理合并或变基');
    }
    let featureBranch: string | undefined;
    if (input.featureBranch) {
      if (input.action === 'pull') throw new Error('拉取更新不能同时新建分支');
      featureBranch = input.branchName?.trim() || branchSuggestion(input.commitMessage || 'update');
      await taskGit(work.cwd, ['check-ref-format', '--branch', featureBranch]);
      const exists = await taskGit(work.cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/' + featureBranch], { allowFailure: true });
      if (exists.code === 0) throw new Error('这个分支已经存在，请换一个名称');
    }
    const steps = [
      ...(commitAction(input.action) && files.length && !input.commitMessage?.trim() ? ['generate_commit'] : []),
      ...(featureBranch ? ['branch'] : []),
      ...(commitAction(input.action) && files.length ? ['commit'] : []),
      ...(pullRequestAction(input.action) ? ['prepare_pr'] : []),
      ...(publishAction(input.action) ? ['push'] : []),
      ...(pullRequestAction(input.action) ? ['generate_pr', 'pr'] : []),
      ...(input.action === 'pull' ? ['pull'] : []),
      ...(repositoryPublish ? ['create_repository', 'add_remote', 'publish_push'] : []),
    ];
    const generation = steps.some(step => step.startsWith('generate_'))
      ? await this.engine.textGeneration.sourceControl(await this.engine.snapshot(), work.projectId) : undefined;
    const operationId = randomUUID();
    await this.engine.root.commit(async tx => {
      const current = await tx.doc(WorkspaceDoc);
      const existing = current.gitRequests && Object.hasOwn(current.gitRequests, input.requestId) ? current.gitRequests[input.requestId] : undefined;
      if (existing) { if (existing.taskId !== id || existing.digest && existing.digest !== digest) throw new Error('Git 请求 ID 已用于不同操作'); return; }
      this.assertIdle(current, review.root!);
      const task = current.tasks.find(task => task.id === id);
      if (!task || task.cwd !== work.cwd) throw new Error('任务工作区已改变');
      const durableId = await tx.createTask(this.definition, { id, operationId }, { ownership: { kind: 'conversation' } });
      if (task.gitOperation) { task.gitOperations ??= []; task.gitOperations.push(snapshot(task.gitOperation)); if (task.gitOperations.length > 40) task.gitOperations.shift(); }
      task.gitOperation = { id: operationId, durableId, action: input.action, status: 'queued', cwd: review.cwd, root: review.root!,
        ...(generation ? { generationModelSelection: generation.modelSelection, generationWritingStyle: generation.writingStyle } : {}),
        createdAt: stamp(), updatedAt: stamp(), phase: 'queued', steps, branch: review.branch, head: review.head,
        contentFingerprint: review.contentFingerprint, files, ...(input.commitMessage?.trim() ? { commitMessage: input.commitMessage.trim() } : {}),
        ...(repositoryPublish ? { repositoryPublish } : {}),
        ...(changeRequestTarget ? { changeRequestTarget, changeRequestProvider: changeRequestTarget.provider } : {}),
        ...(creation ? {changeRequestCreation: creation} : {}),
        ...(featureBranch ? { featureBranch } : {}), ...(creation ? {remote:creation.sourceRemote,baseBranch:creation.baseBranch} : {...(review.remote ? {remote:review.remote} : {}),...(review.defaultBranch ? {baseBranch:review.defaultBranch} : {})}), ...(review.remoteFingerprint ? { remoteFingerprint: review.remoteFingerprint } : {}) };
      current.gitRequests ??= {}; current.gitRequests[input.requestId] = { taskId: id, operationId, digest }; current.revision++;
    }, context);
    this.engine.harness.resume();
    const saved = (await this.engine.snapshot()).gitRequests?.[input.requestId];
    return saved!.operationId;
  }

  private async assertAvailable(work: WorkItem, operation: TaskGitOperation) {
    const state = await this.engine.snapshot();
    if (state.tasks.some(task => directoriesOverlap(operation.root, task.cwd) && hasRunningBackgroundCommands(task))) throw new Error('当前仓库仍有后台命令正在运行');
    if (await realpath(work.cwd) !== operation.cwd) throw new Error('任务工作区已经改变');
    if (state.tasks.some(task => task.id !== work.id && directoriesOverlap(operation.root, task.cwd) && (activeStatuses.includes(task.status) || queueRunning(task) || activeGitOperation(task.gitOperation)))) throw new Error('当前仓库出现了其他正在执行的任务');
    const privacy = { directory: this.engine.directory, workspace: work.executionWorkspace };
    if ((await privateWorkspacePaths(operation.cwd, privacy)).includes('')) throw new Error('Friday 数据目录不能作为 Git 发布工作区');
    const review = await readTaskGitStatus(operation.cwd, privacy, this.engine.sourceControl);
    if (review.root !== operation.root || review.head !== operation.head || review.branch !== operation.branch) throw new Error('Git 分支或提交已经改变，请检查当前状态后重试');
    if (review.remoteFingerprint !== operation.remoteFingerprint) throw new Error('远端仓库配置已经改变，请重新确认发布位置');
    if (operation.changeRequestCreation) await verifyCreationRemotes(operation.cwd, operation.changeRequestCreation, this.engine.sourceControl);
    if (operation.repositoryPublish) {
      if (review.remote !== (operation.remote ?? null) || review.contentFingerprint !== operation.contentFingerprint) throw new Error('发布期间仓库配置或文件已经改变，请核对后再继续');
      await this.assertPublicationPrivacy(work, review);
    }
    return review;
  }

  private async assertPublicationPrivacy(work: WorkItem, review: TaskGitStatus) {
    const excluded = await privateWorkspacePaths(review.root!, { directory: this.engine.directory, workspace: work.executionWorkspace });
    if (excluded.includes('')) throw new Error('Friday 数据目录不能作为 Git 发布工作区');
    if (review.head && excluded.length) {
      const tracked = await taskGit(review.root!, ['log', '-1', '--format=%H', 'HEAD', '--', ...excluded.map(path => ':(literal)' + path)]);
      if (tracked.stdout.trim()) throw new Error('提交历史包含 Friday 私有数据目录，已停止发布，请先清理历史');
    }
  }

  private progress(id: string, operationId: string) {
    let pending: string[] = []; let timer: NodeJS.Timeout | undefined; let writes = Promise.resolve();
    const flush = () => {
      clearTimeout(timer); timer = undefined;
      if (!pending.length) return writes;
      const lines = pending; pending = [];
      writes = writes.then(() => this.engine.mutate(state => {
        const operation = state.tasks.find(task => task.id === id)?.gitOperation;
        if (operation?.id === operationId) { operation.output = [...(operation.output ?? []), ...lines].slice(-60); operation.updatedAt = stamp(); }
      }));
      void writes.catch(() => {}); return writes;
    };
    return { onLine: (line: string) => { pending.push(line); pending = pending.slice(-60); if (!timer) timer = setTimeout(() => { void flush(); }, 150); }, drain: flush };
  }

  private async generationSettings(work: WorkItem, operation: TaskGitOperation) {
    if (!operation.generationModelSelection || !operation.generationWritingStyle) {
      const settings = await this.engine.textGeneration.sourceControl(await this.engine.snapshot(), work.projectId);
      operation.generationModelSelection ??= settings.modelSelection;
      operation.generationWritingStyle ??= settings.writingStyle;
      await this.patch(work.id, operation.id, { generationModelSelection: operation.generationModelSelection, generationWritingStyle: operation.generationWritingStyle });
    }
    return { model: operation.generationModelSelection, style: operation.generationWritingStyle };
  }

  private async generate(work: WorkItem, operation: TaskGitOperation, phase: string, prompt: string, signal: AbortSignal) {
    const id = 'git-' + operation.id + '-' + phase;
    const { model: selected } = await this.generationSettings(work, operation);
    const task: WorkItem = { ...work, ...selected, modelOptions: selected.modelOptions ?? [], providerInstanceId: selected.providerInstanceId ?? selected.agent, nativeProviderAccount: undefined, codexHome: undefined, claudeHome: undefined, piHome: undefined, grokHome: undefined, id, threadId: null, turnId: null, mode: 'research', interactionMode: 'default',
      prompt, result: '', events: [], approvals: [], messages: [], lastRequestId: id, queue: undefined, gitOperation: undefined, gitOperations: undefined };
    const deadline = AbortSignal.timeout(180_000);
    try { return await this.engine.executor.run({ task, prompt, purpose: 'git_text', signal: AbortSignal.any([signal, deadline]), update: async update => {
      if (update.kind === 'session') await this.engine.mutate(state => {
        const current = state.tasks.find(task => task.id === work.id)?.gitOperation;
        if (current?.id !== operation.id) return;
        current.generation = { threadId: update.threadId, turnId: null, ...(update.codexHome ? { codexHome: update.codexHome } : {}), ...(update.claudeHome ? { claudeHome: update.claudeHome } : {}) };
        current.generations ??= {}; current.generations[phase] = snapshot(current.generation);
      });
      if (update.kind === 'turn') await this.engine.mutate(state => {
        const current = state.tasks.find(task => task.id === work.id)?.gitOperation;
        if (current?.id === operation.id && current.generation) { current.generation.turnId = update.turnId; if (current.generations?.[phase]) current.generations[phase].turnId = update.turnId; }
      });
      if (update.kind === 'approval') throw new Error('生成 Git 说明不允许执行需要授权的工具');
    } }); } catch (error) { if (deadline.aborted && !signal.aborted) throw new Error('生成 Git 说明超时，请手动填写后重试'); throw error; }
  }

  private async step(work: WorkItem, operation: TaskGitOperation, step: string, signal: AbortSignal): Promise<StepResult> {
    const review = await this.assertAvailable(work, operation);
    const progress = this.progress(work.id, operation.id);
    const git = (args: string[], input?: string) => taskGit(operation.cwd, args, { signal, timeout: 120_000, hooks: true, onLine: progress.onLine, ...(input !== undefined ? { input } : {}) });
    try {
      if (step === 'create_repository') {
        if (!operation.repositoryPublish || review.remote) throw new Error('仓库发布设置已经改变');
        return { repositoryPublication: await createPublishedRepository(operation.cwd, operation.repositoryPublish, signal, this.engine.sourceControl) };
      }
      if (step === 'add_remote') {
        const publication = operation.repositoryPublication;
        if (!publication || review.remote) throw new Error('仓库已创建，请核对当前远端后再继续');
        try { await git(['remote', 'add', '--', publication.remoteName, publication.remoteURL]); }
        catch { throw new Error('仓库已创建，但未能添加远端。请打开仓库核对后手动添加远端，不要重新发布。'); }
        const added = await readTaskGitStatus(operation.cwd, { directory: this.engine.directory, workspace: work.executionWorkspace });
        return { remote: publication.remoteName, remoteFingerprint: added.remoteFingerprint, repositoryPublication: { ...publication, status: 'remote_added' } };
      }
      if (step === 'publish_push') {
        const publication = operation.repositoryPublication;
        if (!publication || !operation.branch) throw new Error('仓库发布记录不完整');
        if (!operation.head) return {}; // Empty repositories still finish with a usable remote.
        try { await git(['push', '--porcelain', '--set-upstream', '--', publication.remoteName, 'HEAD:refs/heads/' + operation.branch]); }
        catch { throw new Error('仓库已创建并添加远端，但首次推送未完成。请检查 SSH／HTTPS 凭据和连接后使用“推送”继续，不要重新发布。'); }
        return { repositoryPublication: { ...publication, status: 'pushed' } };
      }
      if (step === 'generate_commit') {
        let patch = '';
        for (const path of operation.files) { if (patch.length >= 50_000) break; const value = await readTaskDiff(operation.cwd, path, 'all', { directory: this.engine.directory, workspace: work.executionWorkspace }); patch += `\nFile: ${path}\n${value.patch.slice(0, 50_000 - patch.length)}\n`; }
        const settings = await this.generationSettings(work, operation);
        const policy = await resolveSourceControlPolicy(operation.cwd, settings.style, settings.model.agent, { directory: this.engine.directory, workspace: work.executionWorkspace }, signal);
        const result = parsedText(await this.generate(work, operation, step,
          sourceControlWritingPrompt('commit', { branch: operation.branch, files: operation.files, patch }, policy), signal));
        if (typeof result.subject !== 'string' || !result.subject.trim() || result.subject.length > 200 || /[\r\n\0]/.test(result.subject) || result.body !== undefined && typeof result.body !== 'string') throw new Error('生成的提交说明无效，请手动填写');
        const body = String(result.body ?? '').trim();
        if (body.length > 9800 || body.includes('\0')) throw new Error('生成的提交说明过长');
        return { commitMessage: result.subject.trim() + (body ? '\n\n' + body : '') };
      }
      if (step === 'branch') {
        if (review.contentFingerprint !== operation.contentFingerprint) throw new Error('改动内容已经改变，请重新检查后再提交');
        await git(['switch', '-c', operation.featureBranch!]);
        return { branch: operation.featureBranch! };
      }
      if (step === 'commit') {
        if (review.contentFingerprint !== operation.contentFingerprint) throw new Error('改动内容已经改变，请刷新文件选择后再提交');
        if (!operation.commitMessage?.trim()) throw new Error('提交说明为空');
        const selected = selectedPaths(review, operation.files);
        const paths = [...new Set(selected.flatMap(path => { const file = review.files.find(file => file.path === path)!; return file.oldPath ? [file.oldPath, path] : [path]; }))];
        const indexed = new Set((await taskGit(operation.cwd, ['ls-files', '--cached', '-z', '--', '.'])).stdout.split('\0').filter(Boolean));
        const stage: string[] = [];
        for (const path of paths) {
          if (indexed.has(path)) stage.push(path);
          else { try { await lstat(join(operation.cwd, path)); stage.push(path); } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; } }
        }
        if (stage.length) await git(['--literal-pathspecs', 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], stage.join('\0') + '\0');
        const directory = join(this.engine.directory, 'git-operations'); await mkdir(directory, { recursive: true, mode: 0o700 });
        const file = join(directory, operation.id + '.message'); await writeFile(file, operation.commitMessage, { mode: 0o600 });
        try { await git(['--literal-pathspecs', 'commit', '--only', '--file', file, '--pathspec-from-file=-', '--pathspec-file-nul'], paths.join('\0') + '\0'); }
        finally { await rm(file, { force: true }); }
        const head = (await taskGit(operation.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
        return { head, commitSHA: head };
      }
      if (step === 'prepare_pr') {
        const target = operation.changeRequestTarget, creation = operation.changeRequestCreation;
        if (!target || !creation || !operation.baseBranch) throw new Error('PR／MR 目标记录不完整');
        await pinTaskChangeRequest(operation.cwd, target, this.engine.sourceControl, signal, target.credentialFingerprint);
        const ref = `refs/friday/create-pr/${operation.id}/base`;
        if (creation.targetRemote) await taskGit(operation.cwd, ['fetch','--quiet','--no-tags','--recurse-submodules=no','--',creation.targetRemote,`+refs/heads/${operation.baseBranch}:${ref}`], {signal,timeout:120_000});
        else {
          const pinned = await pinTaskChangeRequest(operation.cwd, target, this.engine.sourceControl, signal, target.credentialFingerprint);
          if (!pinned.repositoryGit) throw new Error('当前连接无法获取 PR 目标基线');
          await pinned.repositoryGit(operation.cwd,target.path,['fetch','--quiet','--no-tags',`https://${target.host}/${target.path}.git`,`+refs/heads/${operation.baseBranch}:${ref}`],{signal});
        }
        const commit = (await taskGit(operation.cwd,['rev-parse','--verify',ref+'^{commit}'],{signal})).stdout.trim();
        if (!/^[a-f\d]{40,64}$/.test(commit)) throw new Error('PR／MR 目标基线无效');
        return {changeRequestBaseCommit:commit};
      }
      if (step === 'push') {
        if (!operation.remote || !operation.branch) throw new Error('没有可推送的本地分支或远端');
        if (review.behind > 0) throw new Error('当前分支落后或已分叉，请先处理远端改动');
        if (operation.changeRequestTarget) await pinTaskChangeRequest(operation.cwd, operation.changeRequestTarget, this.engine.sourceControl, signal, operation.changeRequestTarget.credentialFingerprint);
        const sourceBranch = operation.featureBranch ? operation.branch : operation.changeRequestCreation?.sourceBranch ?? operation.branch;
        if (operation.changeRequestCreation || !review.upstream || review.ahead > 0) await git(['push', '--porcelain', '--set-upstream', '--', operation.remote, 'HEAD:refs/heads/' + sourceBranch]);
        return {};
      }
      if (step === 'generate_pr' || step === 'pr') {
        const target = operation.changeRequestTarget;
        if (!target || !review.sourceControl || !operation.changeRequestCreation && (target.provider !== review.sourceControl.provider || target.host !== review.sourceControl.host || target.path !== review.sourceControl.path)) throw new Error('PR／MR 目标需要重新确认');
        if (!operation.branch || !operation.baseBranch || operation.branch === operation.baseBranch && !operation.changeRequestCreation?.isCrossRepository) throw new Error('请从功能分支创建 PR／MR');
        const pinned = await pinTaskChangeRequest(operation.cwd, target, this.engine.sourceControl, signal, target.credentialFingerprint);
        const creation = operation.changeRequestCreation, sourceBranch = operation.featureBranch ? operation.branch : creation?.sourceBranch ?? operation.branch;
        const source = creation ? {source:creation.source,sourceProjectID:creation.sourceProjectID,targetProjectID:creation.targetProjectID,...(creation.baseWasExplicit?{base:creation.baseBranch}:{})} : undefined;
        const existing = await findTaskChangeRequest(pinned, target, sourceBranch, signal, source);
        if (existing) return { pullRequest: existing };
        if (operation.pullRequest) return { pullRequest: await readTaskChangeRequest(pinned, target, operation.pullRequest.number, signal) };
        if (step === 'generate_pr') {
          const base = operation.changeRequestBaseCommit ?? `refs/remotes/${operation.remote}/${operation.baseBranch}`;
          const privacy = { directory: this.engine.directory, workspace: work.executionWorkspace };
          const paths = ['--', '.', ...(await privateWorkspacePaths(operation.cwd, privacy)).map(path => ':(literal,exclude)' + path)];
          const [log, diff, patch] = await Promise.all([
            taskGit(operation.cwd, ['log', '--format=%s%n%b', `${base}..HEAD`], { signal, limit: 20_000, truncateStdout: true }),
            taskGit(operation.cwd, ['diff', '--no-ext-diff', '--no-textconv', '--stat', `${base}...HEAD`, ...paths], { signal, limit: 20_000, truncateStdout: true }),
            taskGit(operation.cwd, ['diff', '--no-ext-diff', '--no-textconv', `${base}...HEAD`, ...paths], { signal, limit: 40_000, truncateStdout: true }),
          ]);
          const settings = await this.generationSettings(work, operation);
          const policy = await resolveSourceControlPolicy(operation.cwd, settings.style, settings.model.agent, privacy, signal);
          const template = settings.style.followChangeRequestTemplates && target.provider === 'github' ? await readChangeRequestTemplate(operation.cwd, base, privacy, signal) : undefined;
          const text = (result: typeof log) => result.stdout + (result.stdoutTruncated ? '\n[truncated]' : '');
          const result = parsedText(await this.generate(work, operation, step,
            sourceControlWritingPrompt('pr', { branch: sourceBranch, base: operation.baseBranch, log: text(log), diff: text(diff), patch: text(patch), provider: target.provider }, policy, template, target.provider === 'gitlab' ? 'merge request' : 'pull request'), signal));
          if (typeof result.title !== 'string' || !result.title.trim() || result.title.length > 200 || /[\r\n\0]/.test(result.title) || typeof result.body !== 'string' || result.body.length > 60_000 || result.body.includes('\0')) throw new Error('生成的 PR／MR 说明无效');
          return { generatedPullRequest: { title: result.title.trim(), body: result.body } };
        }
        if (!operation.generatedPullRequest) throw new Error('PR／MR 说明尚未生成');
        const created = await createTaskChangeRequest(pinned, target, { branch: sourceBranch, base: operation.baseBranch, title: operation.generatedPullRequest.title, body: operation.generatedPullRequest.body }, signal, source);
        return { pullRequest: created };
      }
      if (step === 'pull') {
        if ((await readTaskGitStatus(operation.root, { directory: this.engine.directory, workspace: work.executionWorkspace })).files.length) throw new Error('仓库出现了未提交改动，已停止拉取');
        await git(['pull', '--ff-only', '--no-rebase', '--no-autostash']);
        return { head: (await taskGit(operation.cwd, ['rev-parse', 'HEAD'])).stdout.trim() };
      }
      throw new Error('不支持的 Git 步骤');
    } finally { await progress.drain(); }
  }
}
