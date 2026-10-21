// Behavior adapted from T3 Code 8cd9641f's GitHub/GitLab providers.
// Every external write is returned as a separately receipted Pi Durable effect.
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import { knownGitHubWorkflowRuns } from './github-conditional-checks.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { changeRequestPath, githubGraphql, object, list, words, safeURL, type ChangeRequestDetail, type ChangeRequestEffect, type GithubMergeMessage } from './task-change-request-data.js';

export const branchActions = ['update-branch', 'enable-auto-merge', 'disable-auto-merge', 'revert', 'delete-branch', 'approve-workflows'] as const;
export type BranchAction = typeof branchActions[number];
export type BranchActionInput = { action: BranchAction; mergeMethod?: string; updateMethod?: 'merge' | 'rebase'; stackNumber?: number; expectedWorkflowSource?: { branch: string; owner: string } };
export type WorkflowScope = { headSha: string; branch: string; owner: string };
export const isBranchAction = (action: string): action is BranchAction => (branchActions as readonly string[]).includes(action);
export function branchActionInput(v: Record<string, any>): Partial<BranchActionInput> {
  if (v.updateMethod !== undefined && !['merge', 'rebase'].includes(v.updateMethod)) throw new Error('分支更新方式无效');
  if (v.stackNumber !== undefined && (!Number.isSafeInteger(v.stackNumber) || v.stackNumber < 1)) throw new Error('堆叠 PR 编号无效');
  const source = v.expectedWorkflowSource === undefined ? undefined : object(v.expectedWorkflowSource);
  if (source && (typeof source.branch !== 'string' || !source.branch || source.branch.length > 4096 || source.branch.includes('\0') || typeof source.owner !== 'string' || !/^[a-z\d][a-z\d-]{0,99}$/i.test(source.owner))) throw new Error('Fork 工作流来源格式无效');
  return { ...(source ? { expectedWorkflowSource: { branch: source.branch, owner: source.owner } } : {}), ...(v.updateMethod !== undefined ? { updateMethod: v.updateMethod } : {}), ...(v.stackNumber !== undefined ? { stackNumber: v.stackNumber } : {}) };
}
export function workflowScope(detail: ChangeRequestDetail): WorkflowScope {
  if (detail.branch?.isCrossRepository !== true || !detail.branch.owner || !detail.headSha || !detail.pullRequest.head) throw new Error('无法确认 Fork 工作流的来源');
  if (detail.branch.headSha && detail.branch.headSha !== detail.headSha) throw new Error('PR 的代码版本已改变，请刷新');
  return { headSha: detail.headSha, branch: detail.pullRequest.head, owner: detail.branch.owner };
}

// A same-named branch/SHA from another fork must never receive this PR's approval.
// Like T3, refuse ambiguous heads and truncated lists instead of guessing.
export async function pendingWorkflowRuns(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, signal?: AbortSignal): Promise<number[]> {
  if (r.provider !== 'github' || detail.branch?.isCrossRepository !== true) return [];
  const scope = workflowScope(detail);
  const heads = async () => {
    const values: any[] = []; let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await githubGraphql(p, `query FridayWorkflowHeads($owner:String!,$name:String!,$head:String!,$after:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$after,states:[OPEN],headRefName:$head){nodes{number headRefOid isCrossRepository headRepositoryOwner{login}} pageInfo{hasNextPage endCursor}}}}`, { owner: r.owner, name: r.name, head: scope.branch, after }, signal);
      const connection = object(object(result.repository).pullRequests);
      if (!Array.isArray(connection.nodes)) throw new Error('无法确认工作流所属 PR');
      values.push(...connection.nodes);
      const info = object(connection.pageInfo);
      if (values.length > 1000 || info.hasNextPage === true && (page === 9 || typeof info.endCursor !== 'string' || info.endCursor === after)) throw new Error('工作流来源列表不完整，请在平台核对');
      if (info.hasNextPage !== true) break;
      after = info.endCursor;
    }
    const matches = values.filter(v => v.headRefOid === scope.headSha && v.isCrossRepository === true && words(object(v.headRepositoryOwner).login).toLowerCase() === scope.owner.toLowerCase());
    if (matches.length !== 1 || matches[0].number !== detail.pullRequest.number) throw new Error('工作流来源对应多个或不同 PR，请在平台核对');
  };
  const runs = async () => {
    const known = knownGitHubWorkflowRuns();
    if (known?.headSha === scope.headSha) return [...new Set(known.runs.filter(v => v.head_branch === scope.branch && (v.status === 'action_required' || v.conclusion === 'action_required')).map(v => v.id).filter((id): id is number => Number.isSafeInteger(id) && id > 0))];
    const values: any[] = [];
    for (let page = 1; page <= 11; page++) {
      const result = await p.json(`repos/${r.path}/actions/runs?` + new URLSearchParams({ head_sha: scope.headSha, branch: scope.branch, event: 'pull_request', status: 'action_required', per_page: '100', page: String(page) }), { signal, maxResponseBytes: 8 * 1024 * 1024 });
      if (!Array.isArray(result.workflow_runs)) throw new Error('无法读取待批准的工作流');
      values.push(...result.workflow_runs);
      if (values.length > 1000) throw new Error('工作流列表不完整，请在平台核对');
      if (result.workflow_runs.length < 100) break;
    }
    return [...new Set(values.filter(v => v.head_sha === scope.headSha && v.head_branch === scope.branch && v.event === 'pull_request' && (v.status === 'action_required' || v.conclusion === 'action_required')).map(v => v.id).filter((id): id is number => Number.isSafeInteger(id) && id > 0))];
  };
  const [, result] = await Promise.all([heads(), runs()]); return result;
}

export async function branchActionEffects(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, input: BranchActionInput, signal?: AbortSignal, captured?: { keys: string[]; scope?: WorkflowScope; mergeMessage?: GithubMergeMessage }): Promise<ChangeRequestEffect[]> {
  const action = input.action, number = detail.pullRequest.number;
  if (input.stackNumber !== undefined) throw new Error('堆叠 PR 操作尚未接入，不能按单个 PR 执行');
  // A source ref disappearing between planning and execution is a successful deletion.
  const deletingGone = action === 'delete-branch' && r.provider === 'github' && detail.pullRequest.state !== 'open' && detail.branch?.canDelete;
  if (!detail.actions.includes(action) && !deletingGone) throw new Error('当前状态或账号不支持这项 PR／MR 操作');
  if (['update-branch', 'enable-auto-merge'].includes(action) && detail.branch?.headSha && detail.branch.headSha !== detail.headSha) throw new Error('PR 的代码版本已改变，请刷新');
  const method = input.mergeMethod ?? detail.mergeMethods[0];
  if (action === 'enable-auto-merge' && !detail.mergeMethods.includes(method)) throw new Error('仓库不支持这种合并方式');
  const updateMethod = input.updateMethod ?? detail.updateMethods?.[0];
  if (action === 'update-branch' && (!updateMethod || !detail.updateMethods?.includes(updateMethod))) throw new Error('平台或当前账号不支持这种分支更新方式');
  if (action === 'approve-workflows') {
    const scope = workflowScope(detail), expected = captured?.scope;
    if (input.expectedWorkflowSource && (scope.branch !== input.expectedWorkflowSource.branch || scope.owner.toLowerCase() !== input.expectedWorkflowSource.owner.toLowerCase())) throw new Error('Fork 工作流来源已改变，请刷新后重新批准');
    if (expected && (scope.headSha !== expected.headSha || scope.branch !== expected.branch || scope.owner.toLowerCase() !== expected.owner.toLowerCase())) throw new Error('Fork 工作流来源已改变，请刷新后重新批准');
    const pending = await pendingWorkflowRuns(p, r, detail, signal);
    const keys = captured?.keys ?? pending.map(id => `approve-workflow-${id}`);
    return keys.map(key => {
      const id = Number(key.replace(/^approve-workflow-/, ''));
      if (!/^approve-workflow-[1-9]\d*$/.test(key) || !Number.isSafeInteger(id)) throw new Error('工作流执行记录无效');
      return { key, run: async writeSignal => { if (pending.includes(id)) await p.json(`repos/${r.path}/actions/runs/${id}/approve`, { method: 'POST', signal: writeSignal, allowEmpty: true }); } };
    });
  }
  if (r.provider === 'gitlab') {
    if (!['update-branch', 'enable-auto-merge', 'disable-auto-merge'].includes(action)) throw new Error('GitLab 不支持这项操作');
    return [{ key: action, run: async writeSignal => {
      if (action === 'disable-auto-merge') {
        if (detail.autoMergeEnabled === false) return;
        await p.json(changeRequestPath(r, number) + '/cancel_merge_when_pipeline_succeeds', { method: 'POST', signal: writeSignal, allowEmpty: true });
      } else {
        if (action === 'enable-auto-merge' && detail.autoMergeEnabled === true) return;
        if (!p.gitLabBranchAction) throw new Error('GitLab 连接不支持这项操作');
        await p.gitLabBranchAction(r.path, number, action as 'update-branch' | 'enable-auto-merge', action === 'update-branch' ? updateMethod! : method, writeSignal);
      }
    } }];
  }
  if (r.provider !== 'github' || !detail.nodeId) throw new Error('平台不支持这项操作');
  if (action === 'delete-branch') {
    const target = await githubGraphql(p, `query FridayBranchToDelete($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state headRefName baseRefName headRefOid headRepository{id viewerPermission}}}}`, { owner: r.owner, name: r.name, number }, signal);
    const branch = object(object(target.repository).pullRequest), source = object(branch.headRepository);
    if (!['MERGED', 'CLOSED'].includes(branch.state)) throw new Error('只能删除已合并或关闭 PR 的源分支');
    if (!source.id || !branch.headRefName || !branch.headRefOid) throw new Error('源分支不可用');
    if (!['ADMIN', 'MAINTAIN', 'WRITE'].includes(source.viewerPermission)) throw new Error('当前账号不能删除源分支');
    if (branch.headRefName === branch.baseRefName) throw new Error('不能删除目标分支');
    if (branch.headRefOid !== detail.headSha) throw new Error('PR 的代码版本已改变，请刷新');
    const ref = `refs/heads/${branch.headRefName}`;
    const value = await githubGraphql(p, `query FridaySourceBranch($repositoryId:ID!,$ref:String!){node(id:$repositoryId){__typename ... on Repository{defaultBranchRef{name} ref(qualifiedName:$ref){target{oid}}}}}`, { repositoryId: source.id, ref }, signal);
    const repository = object(value.node);
    if (repository.__typename !== 'Repository') throw new Error('源仓库不可用');
    if (repository.ref !== null) {
      if (!object(repository.defaultBranchRef).name || object(repository.defaultBranchRef).name === branch.headRefName) throw new Error('不能删除源仓库的默认分支');
      if (object(object(repository.ref).target).oid !== branch.headRefOid) throw new Error('源分支已有新提交，不能删除');
    }
    return [{ key: action, run: async writeSignal => {
      if (repository.ref === null) return;
      await githubGraphql(p, `mutation FridayDeleteBranch($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}`, { input: { repositoryId: source.id, refUpdates: [{ name: ref, beforeOid: branch.headRefOid, afterOid: '0'.repeat(40) }] } }, writeSignal);
    } }];
  }
  return [{ key: action, run: async writeSignal => {
    const variables = { pullRequestId: detail.nodeId };
    if (action === 'update-branch') {
      if (detail.behindBy === 0) return;
      await githubGraphql(p, `mutation FridayUpdateBranch($input:UpdatePullRequestBranchInput!){updatePullRequestBranch(input:$input){clientMutationId}}`, { input: { ...variables, expectedHeadOid: detail.headSha, updateMethod: updateMethod!.toUpperCase() } }, writeSignal);
    } else if (action === 'disable-auto-merge') {
      if (detail.autoMergeEnabled === false) return;
      await githubGraphql(p, `mutation FridayDisableAutoMerge($input:DisablePullRequestAutoMergeInput!){disablePullRequestAutoMerge(input:$input){clientMutationId}}`, { input: variables }, writeSignal);
    } else if (action === 'enable-auto-merge') {
      if (detail.autoMergeEnabled === true) return;
      const auto = detail.mergeQueue === true || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(detail.mergeability.toUpperCase());
      await githubGraphql(p, auto ? `mutation FridayEnableAutoMerge($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){clientMutationId}}` : `mutation FridayImmediateAutoMerge($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{id}}}`, { input: { ...variables, mergeMethod: method.toUpperCase(), ...(!auto ? { expectedHeadOid: detail.headSha } : {}), ...(!detail.mergeQueue && method !== 'rebase' && captured?.mergeMessage ? captured.mergeMessage : {}) } }, writeSignal);
    } else if (action === 'revert') {
      const value = await githubGraphql(p, `mutation FridayRevert($input:RevertPullRequestInput!){revertPullRequest(input:$input){revertPullRequest{url}}}`, { input: variables }, writeSignal);
      const resultURL = safeURL(object(object(value.revertPullRequest).revertPullRequest).url);
      if (resultURL) { const url = new URL(resultURL); if (url.host === r.host && url.pathname.startsWith(`/${r.path}/pull/`) && /^\d+$/.test(url.pathname.slice(`/${r.path}/pull/`.length)) && !url.search && !url.hash) return { resultURL }; }
    }
  } }];
}
