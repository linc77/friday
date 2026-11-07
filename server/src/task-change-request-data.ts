// Platform behavior follows T3 Code's source-control providers at 8cd9641f.
// Remote review data is read on demand; patches and comment bodies never enter
// the workspace overview document.
import type { PinnedSourceControlConnection, JsonOptions } from './source-control-connections.js';
import { normalizeTaskChangeRequest, type SourceControlRepository } from './task-change-requests.js';
import type { TaskPullRequest } from './types.js';
import { parseDiffFilePaths } from './vendor/t3-diff-file-revisions.js';

import { removeAgentCredits } from './vendor/t3-merge-message.js';
import { additionalRepositoryPath } from './source-control-provider-identity.js';
export type ChangeRequestAction = 'merge' | 'ready' | 'draft' | 'close' | 'reopen' | 'update-branch' | 'enable-auto-merge' | 'disable-auto-merge' | 'revert' | 'delete-branch' | 'approve-workflows';
export type ChangeRequestVerdict = 'comment' | 'approve' | 'request-changes';
export type GithubMergeMessage = { commitBody: string; expectedHeadOid: string };
export type ChangeRequestDetail = {
  pullRequest: TaskPullRequest; body: string; author: string; createdAt: string; updatedAt: string;
  mergedAt?: string; closedAt?: string; authorAvatarURL?: string;
  isDraft: boolean; stackRebase?: boolean; headSha: string; baseSha?: string; startSha?: string; nodeId?: string;
  autoMergeEnabled?: boolean; autoMergeMethod?: string; behindBy?: number; updateMethods?: string[];
  workflowApprovalsRequired?: number; workflowApprovalsUnavailable?: boolean;
  branch?: { repositoryID?: string; repository?: string; owner?: string; isCrossRepository?: boolean; exists?: boolean; canDelete: boolean; headSha?: string };
  mergeability: string; mergeQueue?: boolean; additions?: number; deletions?: number; changedFiles?: number;
  checksState?: 'passing' | 'pending' | 'failing';
  reviewDecision?: string | null;
  baseComparison?: 'unknown' | 'up-to-date' | 'behind'; providerVersion?: number;
  capabilities?: { inlineReviews: boolean; commitDiff: boolean; fileContents: boolean; reviewerCandidates: boolean; stacks: boolean; replyToThreads: boolean };
  actions: ChangeRequestAction[]; mergeMethods: string[]; verdicts: ChangeRequestVerdict[]; canComment: boolean;
  reviewers: string[]; labels: string[]; checks: { name: string; state: string; url?: string }[]; checksUnavailable?: boolean;
  management?: { viewer?: string; viewerID?: string; canEdit: boolean; canResolve: boolean; canRequestReviewers: boolean; canSetLabels: boolean; canReact?: boolean; viewedFiles?: 'host' | 'environment' };
};
export type ChangeRequestActivity = { id: string; kind: string; author: string; body: string; createdAt: string; state?: string; path?: string; line?: number; url?: string; sourceID?: string; commentKind?: 'issue-comment' | 'review-comment'; canEdit?: boolean; authorAvatarURL?: string; editedAt?: string; reviewedHeadSha?: string; dismissalMessage?: string };
export type ChangeRequestFile = { path: string; oldPath?: string; status: string; additions: number; deletions: number; patch: string; unavailable: boolean };
export type ChangeRequestPosition = { kind: 'added'; newLine: number } | { kind: 'deleted'; oldLine: number } | { kind: 'context'; oldLine: number; newLine: number; side: 'left' | 'right' };
export type ChangeRequestReviewComment = { path: string; oldPath?: string; position: ChangeRequestPosition; body: string };
export const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
export const list = (value: unknown): any[] => Array.isArray(value) ? value : [];
export const words = (value: unknown, max = 65536): string => typeof value === 'string' ? value.slice(0, max).replace(/[\ud800-\udbff]$/, '') : '';
const count = (value: unknown): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
export const actor = (value: unknown) => { const v = object(value); return words(v.login ?? v.username ?? v.nickname ?? v.display_name ?? v.name, 256); };
export const changeRequestPath = (r: SourceControlRepository, number: number) => r.provider === 'github' ? `repos/${r.path}/pulls/${number}` : r.provider === 'gitlab' ? `projects/${encodeURIComponent(r.path)}/merge_requests/${number}` : `repositories/${r.path}/pullrequests/${number}`;
const repositoryPath = (r: SourceControlRepository) => r.provider === 'github' ? `repos/${r.path}` : r.provider === 'gitlab' ? `projects/${encodeURIComponent(r.path)}` : `repositories/${r.path}`;
export const safeURL = (value: unknown): string | undefined => { try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return; } };
export async function githubGraphql(p: PinnedSourceControlConnection, query: string, variables: Record<string, unknown>, signal?: AbortSignal) {
  if (!p.graphql) throw new Error('GitHub 连接不支持 GraphQL');
  return p.graphql(query, variables, signal);
}

export async function changeRequestMergeMessage(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, action: string, mergeMethod?: string, signal?: AbortSignal): Promise<GithubMergeMessage | undefined> {
  if (r.provider !== 'github' || !['merge','enable-auto-merge'].includes(action) || (mergeMethod ?? detail.mergeMethods[0]) === 'rebase') return;
  if (p.provider !== r.provider || p.host !== r.host) throw new Error('Source Control 连接与目标不一致');
  if (!detail.actions.includes(action as ChangeRequestAction)) throw new Error('当前状态或账号不支持这项 PR 操作');
  const method = mergeMethod ?? detail.mergeMethods[0]; if (!['merge','squash'].includes(method) || !detail.mergeMethods.includes(method)) throw new Error('仓库不支持这种合并方式');
  const result = await githubGraphql(p, 'query FridayMergeMessage($owner:String!,$name:String!,$number:Int!,$method:PullRequestMergeMethod!){repository(owner:$owner,name:$name){pullRequest(number:$number){isMergeQueueEnabled headRefOid viewerMergeBodyText(mergeType:$method)}}}', { owner: r.owner, name: r.name, number: detail.pullRequest.number, method: method === 'squash' ? 'SQUASH' : 'MERGE' }, signal);
  const message = object(object(result.repository).pullRequest);
  if (typeof message.viewerMergeBodyText !== 'string' || typeof message.isMergeQueueEnabled !== 'boolean') throw new Error('无法读取 GitHub 提议的合并消息，未发送合并');
  if (message.headRefOid !== detail.headSha || message.isMergeQueueEnabled !== (detail.mergeQueue === true)) throw new Error('PR 的代码版本或合并队列状态已改变，请刷新后重新确认');
  if (message.isMergeQueueEnabled) return;
  const body = removeAgentCredits(message.viewerMergeBodyText);
  return body === message.viewerMergeBodyText ? undefined : { commitBody: body, expectedHeadOid: message.headRefOid };
}

export async function changeRequestDetail(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal, options: { checks?: boolean } = {}): Promise<ChangeRequestDetail> {
  if (p.provider !== r.provider || p.host !== r.host) throw new Error('Source Control 连接与目标不一致');
  if (p.additional) { const detail = await p.additional.detail(number, signal); return { ...detail, capabilities: { inlineReviews: r.provider === 'forgejo', commitDiff: r.provider === 'forgejo', fileContents: r.provider !== 'gitcafe', reviewerCandidates: r.provider === 'forgejo', stacks: r.provider === 'gitcafe', replyToThreads: r.provider === 'gitcafe' } }; }
  const path = changeRequestPath(r, number);
  const raw = await p.json(path, { signal, maxResponseBytes: 1024 * 1024 });
  const pr = normalizeTaskChangeRequest(r, raw);
  const detail: ChangeRequestDetail = { pullRequest: pr, body: words(raw.body ?? raw.description), author: actor(raw.author ?? raw.user),
    createdAt: words(raw.created_at ?? raw.created_on, 64), updatedAt: words(raw.updated_at ?? raw.updated_on, 64),
    isDraft: r.provider === 'github' ? raw.draft === true : r.provider === 'gitlab' ? raw.draft === true || raw.work_in_progress === true || /^(?:Draft|WIP):\s*/i.test(pr.title) : raw.draft === true,
    headSha: words(r.provider === 'github' ? object(raw.head).sha : r.provider === 'gitlab' ? raw.sha ?? object(raw.diff_refs).head_sha : object(object(raw.source).commit).hash, 64),
    mergeability: words(raw.mergeable_state ?? raw.detailed_merge_status ?? raw.merge_status ?? (raw.mergeable === false ? 'conflicting' : 'unknown'), 100),
    actions: [], mergeMethods: [], verdicts: ['comment', 'approve', ...(r.provider === 'gitlab' ? [] : ['request-changes' as const])], canComment: true,
    reviewers: list(raw.requested_reviewers ?? raw.reviewers ?? raw.participants).map(v => actor(object(v).user ?? v)).filter(Boolean),
    labels: list(raw.labels).map(v => typeof v === 'string' ? words(v, 256) : words(object(v).name, 256)), checks: [] };
  detail.authorAvatarURL = safeURL(object(raw.author ?? raw.user).avatar_url ?? object(object(object(raw.author).links).avatar).href);
  const mergedAt = r.provider === 'bitbucket' ? pr.state === 'merged' ? raw.closed_on : undefined : raw.merged_at;
  const closedAt = r.provider === 'bitbucket' ? pr.state === 'closed' ? raw.closed_on : undefined : raw.closed_at;
  if (typeof mergedAt === 'string' && mergedAt) detail.mergedAt = words(mergedAt, 64);
  if (typeof closedAt === 'string' && closedAt) detail.closedAt = words(closedAt, 64);
  if (!/^[0-9a-f]{7,64}$/i.test(detail.headSha)) throw new Error('平台未返回可确认的 PR／MR 版本，请刷新');
  let canWrite = true, canUpdate = true;
  if (r.provider === 'github') {
    const result = await githubGraphql(p, `query FridayChangeRequest($owner:String!,$name:String!,$number:Int!,$headRef:String!){viewer{login} repository(owner:$owner,name:$name){viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){id viewerDidAuthor viewerCanUpdate viewerCanUpdateBranch isMergeQueueEnabled mergeStateStatus headRefOid headRef{id} isCrossRepository headRepositoryOwner{login} headRepository{id nameWithOwner viewerPermission} autoMergeRequest{mergeMethod} baseRef{compare(headRef:$headRef){behindBy}}}}}`, { owner: r.owner, name: r.name, number, headRef: `refs/pull/${number}/head` }, signal);
    const repo = object(result.repository), current = object(repo.pullRequest);
    if (typeof current.id !== 'string') throw new Error('无法读取 GitHub PR 权限');
    detail.nodeId = current.id; detail.mergeQueue = current.isMergeQueueEnabled === true;
    canWrite = repo.viewerPermission === undefined || ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.viewerPermission);
    canUpdate = current.viewerCanUpdate !== false; detail.stackRebase = canWrite;
    const source = object(current.headRepository);
    detail.branch = { repositoryID: words(source.id, 256) || undefined, repository: words(source.nameWithOwner, 512) || undefined, owner: actor(current.headRepositoryOwner) || undefined,
      isCrossRepository: typeof current.isCrossRepository === 'boolean' ? current.isCrossRepository : undefined,
      exists: current.headRef === undefined ? undefined : current.headRef !== null, canDelete: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(source.viewerPermission), headSha: words(current.headRefOid, 64) || undefined };
    if (current.autoMergeRequest !== undefined) detail.autoMergeEnabled = current.autoMergeRequest !== null;
    if (object(current.autoMergeRequest).mergeMethod) detail.autoMergeMethod = words(object(current.autoMergeRequest).mergeMethod, 32).toLowerCase();
    const comparison = object(object(current.baseRef).compare);
    if (Number.isSafeInteger(comparison.behindBy) && comparison.behindBy >= 0) detail.behindBy = comparison.behindBy;
    if (current.viewerCanUpdateBranch === true) detail.updateMethods = ['merge', 'rebase'];
    if (typeof current.mergeStateStatus === 'string') detail.mergeability = words(current.mergeStateStatus, 100).toLowerCase();
    detail.management = { viewer: words(object(result.viewer).login, 256) || undefined, canEdit: canUpdate, canResolve: canWrite || current.viewerDidAuthor === true, canRequestReviewers: canWrite, canSetLabels: canWrite || repo.viewerPermission === 'TRIAGE' };
    if (current.viewerDidAuthor === true) detail.verdicts = ['comment'];
    detail.mergeMethods = [['merge', repo.mergeCommitAllowed], ['squash', repo.squashMergeAllowed], ['rebase', repo.rebaseMergeAllowed]].filter(([, allowed]) => allowed !== false).map(([method]) => String(method));
    detail.baseSha = words(object(raw.base).sha, 64); detail.additions = count(raw.additions); detail.deletions = count(raw.deletions); detail.changedFiles = count(raw.changed_files);
    if (pr.state === 'open' && options.checks !== false) {
      try {
        const [checks, statuses] = await Promise.all([p.json(`repos/${r.path}/commits/${detail.headSha}/check-runs?per_page=100`, { signal }), p.json(`repos/${r.path}/commits/${detail.headSha}/status`, { signal })]);
        detail.checks = [...list(checks.check_runs).map(v => ({ name: words(v.name, 256), state: words(v.conclusion ?? v.status, 80), url: safeURL(v.html_url) })), ...list(statuses.statuses).map(v => ({ name: words(v.context, 256), state: words(v.state, 80), url: safeURL(v.target_url) }))];
      } catch { signal?.throwIfAborted(); detail.checksUnavailable = true; }
    }
  } else if (r.provider === 'gitlab') {
    const [project, user] = await Promise.all([p.json(repositoryPath(r), { signal }), p.json('user', { signal })]);
    canWrite = object(raw.user).can_merge !== false;
    // T3 only gates GitLab's merge actions. Role metadata cannot tell whether
    // the viewer may close/reopen or change draft state on this particular MR.
    canUpdate = true;
    detail.management = { viewer: actor(user) || undefined, viewerID: String(user.id ?? ''), canEdit: canWrite || object(raw.author).id === user.id, canResolve: true, canRequestReviewers: true, canSetLabels: false };
    detail.mergeMethods = [...(project.merge_method === 'merge' || project.merge_method === undefined ? ['merge'] : []), ...(['ff', 'rebase_merge'].includes(String(project.merge_method)) ? ['rebase'] : []), ...(['always', 'default_on', 'default_off'].includes(String(project.squash_option)) ? ['squash'] : [])];
    if (raw.merge_when_pipeline_succeeds != null || raw.auto_merge_enabled != null) detail.autoMergeEnabled = raw.merge_when_pipeline_succeeds === true || raw.auto_merge_enabled === true;
    if (detail.autoMergeEnabled && raw.squash_on_merge === true) detail.autoMergeMethod = 'squash';
    if (canWrite) detail.updateMethods = ['rebase'];
    detail.baseSha = words(object(raw.diff_refs).base_sha, 64); detail.startSha = words(object(raw.diff_refs).start_sha, 64);
    const pipeline = object(raw.head_pipeline); if (pipeline.status) detail.checks = [{ name: 'Pipeline #' + String(pipeline.id ?? ''), state: words(pipeline.status, 80), url: safeURL(pipeline.web_url) }];
    const changed = Number(raw.changes_count); if (Number.isSafeInteger(changed)) detail.changedFiles = changed;
  } else {
    detail.baseSha = words(object(object(raw.destination).commit).hash, 64); detail.mergeMethods = ['merge', 'squash', 'rebase'];
    try {
      const permission = await p.json(`user/workspaces/${encodeURIComponent(r.owner)}/permissions/repositories?` + new URLSearchParams({ q: `repository.full_name="${r.path}"` }), { signal });
      const known = list(permission.values).find(v => object(v.repository).full_name === r.path);
      if (known && typeof known.permission === 'string') canWrite = ['write', 'admin'].includes(known.permission);
    } catch { signal?.throwIfAborted(); /* T3 grants when the host cannot report this permission. */ }
    if (options.checks !== false) {
      try { const statuses = await p.json(`repositories/${r.path}/commit/${detail.headSha}/statuses?pagelen=100`, { signal }); detail.checks = list(statuses.values).map(v => ({ name: words(v.name ?? v.key, 256), state: words(v.state, 80), url: safeURL(v.url) })); }
      catch { signal?.throwIfAborted(); detail.checksUnavailable = true; }
    }
    let viewer: string | undefined;
    try { viewer = actor(await p.json('user', { signal })) || undefined; } catch { signal?.throwIfAborted(); }
    detail.management = { viewer, canEdit: canWrite || !!viewer && viewer.toLowerCase() === detail.author.toLowerCase(), canResolve: true, canRequestReviewers: true, canSetLabels: false };
    // Bitbucket says nothing here about update permission. Like T3, closing
    // remains available to an author without repository write access.
  }
  if (pr.state === 'open') {
    if (canWrite && !detail.isDraft) detail.actions.push('merge');
    if (canUpdate) { detail.actions.push('close'); if (r.provider !== 'bitbucket') detail.actions.push(detail.isDraft ? 'ready' : 'draft'); }
  } else if (pr.state === 'closed' && r.provider !== 'bitbucket' && canUpdate) detail.actions.push('reopen');
  if (r.provider !== 'bitbucket') {
    if (pr.state === 'open') {
      if (detail.updateMethods?.length) detail.actions.push('update-branch');
      if (canWrite) { detail.actions.push('disable-auto-merge'); if (!detail.isDraft) detail.actions.push('enable-auto-merge'); }
      if (r.provider === 'github' && canWrite && detail.branch?.isCrossRepository === true) detail.actions.push('approve-workflows');
    }
    if (r.provider === 'github' && pr.state === 'merged' && canWrite) detail.actions.push('revert');
    if (r.provider === 'github' && pr.state !== 'open' && detail.branch?.canDelete && detail.branch.exists !== false) detail.actions.push('delete-branch');
  }
  if (detail.management) { detail.management.canReact = r.provider !== 'bitbucket'; detail.management.viewedFiles = r.provider === 'github' ? 'host' : 'environment'; }
  return detail;
}

// Page counts are bounded and explicitly marked. Never follow a server-provided
// pagination URL with credentials; every next page stays on the pinned host.
export async function pages(p: PinnedSourceControlConnection, path: string, bitbucket: boolean, signal?: AbortSignal) {
  const values: any[] = []; let truncated = false;
  for (let page = 1; page <= 10; page++) {
    const query = path + (path.includes('?') ? '&' : '?') + (bitbucket ? `pagelen=100&page=${page}` : `per_page=100&page=${page}`);
    const options: JsonOptions = { signal, maxResponseBytes: 8 * 1024 * 1024 };
    const raw = bitbucket ? await p.json(query, options) : await p.array(query, options);
    const entries = bitbucket ? list(object(raw).values) : list(raw); values.push(...entries);
    const more = bitbucket ? typeof object(raw).next === 'string' : entries.length === 100;
    if (!more) break; if (page === 10) truncated = true;
  }
  return { values, truncated };
}
export async function changeRequestActivity(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal) {
  if (p.additional) return { ...await p.additional.activity(number, signal), bitbucketComments: undefined };
  const path = changeRequestPath(r, number); let items: ChangeRequestActivity[] = []; let truncated = false;
  let bitbucketComments: { values: any[]; truncated: boolean } | undefined;
  if (r.provider === 'github') {
    const [comments, reviews] = await Promise.all([pages(p, `repos/${r.path}/issues/${number}/comments`, false, signal), pages(p, path + '/reviews', false, signal)]);
    truncated = comments.truncated || reviews.truncated;
    items = [...comments.values.map(v => ({ ...v, kind: 'comment' })), ...reviews.values.map(v => ({ ...v, kind: 'review', created_at: v.submitted_at }))].map(v => ({ id: v.kind + ':' + String(v.id), kind: v.kind, author: actor(v.user), body: words(v.body), createdAt: words(v.created_at, 64), state: typeof v.state === 'string' ? words(v.state, 80) : undefined, url: safeURL(v.html_url), ...(typeof v.node_id === 'string' ? { sourceID: v.node_id } : {}), authorAvatarURL: safeURL(object(v.user).avatar_url), editedAt: words(v.updated_at, 64) || undefined, reviewedHeadSha: words(v.commit_id, 64) || undefined, ...(v.kind === 'comment' ? { commentKind: 'issue-comment' as const } : {}) }));
  } else {
    const result = await pages(p, path + (r.provider === 'gitlab' ? '/notes' : '/comments'), r.provider === 'bitbucket', signal); truncated = result.truncated;
    if (r.provider === 'bitbucket') bitbucketComments = result;
    items = result.values.filter(v => !v.deleted && v.system !== true).map(v => ({ id: String(v.id), kind: v.system ? 'event' : object(v.inline).path || v.position ? 'inline' : 'comment', author: actor(v.author ?? v.user), body: words(v.body ?? object(v.content).raw), createdAt: words(v.created_at ?? v.created_on, 64), path: words(object(v.inline).path ?? object(v.position).new_path, 4096) || undefined, line: object(v.inline).to ?? object(v.inline).from ?? object(v.position).new_line ?? object(v.position).old_line, url: safeURL(v.web_url ?? object(object(v.links).html).href), authorAvatarURL: safeURL(object(v.author ?? v.user).avatar_url ?? object(object(object(v.user).links).avatar).href), editedAt: words(v.updated_at ?? v.updated_on, 64) || undefined, sourceID: String(v.id), commentKind: 'issue-comment' as const }));
  }
  if (r.provider === 'bitbucket') {
    const request = await p.json(path, { signal });
    for (const participant of list(request.participants)) {
      const name = actor(participant.user), state = words(participant.state ?? (participant.approved === true ? 'approved' : ''), 80), at = words(participant.participated_on, 64);
      if (!name || !state || !at) continue;
      items.push({ id: `review:${number}:${name}`, kind: 'review', author: name, body: '', createdAt: at, state, authorAvatarURL: safeURL(object(object(object(participant.user).links).avatar).href) });
    }
  }
  items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { items, truncated, bitbucketComments };
}
export async function changeRequestFiles(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, expectedHead: string, signal?: AbortSignal) {
  if (p.additional) return p.additional.files(number, expectedHead, signal);
  const path = changeRequestPath(r, number);
  const rawHead = await p.json(path, { signal });
  const before = normalizeTaskChangeRequest(r, rawHead);
  const head = words(r.provider === 'github' ? object(rawHead.head).sha : r.provider === 'gitlab' ? rawHead.sha : object(object(rawHead.source).commit).hash, 64);
  const baseSha = words(r.provider === 'github' ? object(rawHead.base).sha : r.provider === 'gitlab' ? object(rawHead.diff_refs).base_sha : object(object(rawHead.destination).commit).hash, 64);
  if (head !== expectedHead) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  const result = await pages(p, path + (r.provider === 'github' ? '/files' : r.provider === 'gitlab' ? '/diffs' : '/diffstat'), r.provider === 'bitbucket', signal);
  let diff: string | undefined;
  if (r.provider === 'bitbucket') {
    if (!p.text) throw new Error('Bitbucket 连接不支持 Diff');
    diff = await p.text(path + '/diff', { signal, maxResponseBytes: 8 * 1024 * 1024 });
  }
  const files = changeRequestDiffFiles(r.provider, result.values, diff);
  // A push racing the diff fetch cannot turn stale positions into a review.
  const after = await p.json(path, { signal });
  const afterHead = words(r.provider === 'github' ? object(after.head).sha : r.provider === 'gitlab' ? after.sha : object(object(after.source).commit).hash, 64);
  const afterBase = words(r.provider === 'github' ? object(after.base).sha : r.provider === 'gitlab' ? object(after.diff_refs).base_sha : object(object(after.destination).commit).hash, 64);
  if (afterHead !== head || afterBase !== baseSha || normalizeTaskChangeRequest(r, after).url !== before.url) throw new Error('PR／MR 的代码版本已改变，请刷新详情');
  return { headSha: head, ...(baseSha ? { baseSha } : {}), files, truncated: result.truncated };
}

export function changeRequestDiffFiles(provider: SourceControlRepository['provider'], values: any[], diff?: string): ChangeRequestFile[] {
  const patches = new Map<string, string>();
  for (const patch of (diff ?? '').replace(/^\uFEFF/, '').split(/(?=^diff --git )/m).filter(v => v.startsWith('diff --git '))) {
    for (const entry of parseDiffFilePaths(patch)) for (const path of [entry.oldPath, entry.newPath]) if (path !== null) patches.set(path, patch);
  }
  return values.map(v => {
    const filePath = words(v.filename ?? v.new_path ?? object(v.new).path ?? object(v.old).path, 4096);
    const sourcePatch = provider === 'bitbucket' ? patches.get(filePath) ?? '' : v.patch ?? v.diff;
    const patch = typeof sourcePatch === 'string' && sourcePatch.length <= 1024 * 1024 ? sourcePatch : '';
    let additions = 0, deletions = 0, inHunk = false;
    for (const line of patch.split('\n')) {
      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (line.startsWith('diff --git ')) { inHunk = false; continue; }
      if (inHunk && line.startsWith('+')) additions++;
      if (inHunk && line.startsWith('-')) deletions++;
    }
    return { path: filePath, oldPath: words(v.previous_filename ?? v.old_path ?? object(v.old).path, 4096) || undefined,
      status: words(v.status ?? (v.new_file ? 'added' : v.deleted_file ? 'removed' : v.renamed_file ? 'renamed' : 'modified'), 80),
      additions: v.additions !== undefined || v.lines_added !== undefined ? count(v.additions ?? v.lines_added) : additions,
      deletions: v.deletions !== undefined || v.lines_removed !== undefined ? count(v.deletions ?? v.lines_removed) : deletions,
      patch, unavailable: !patch || /(?:^Binary files .+ differ$|^GIT binary patch$)/m.test(patch) || v.too_large === true || v.collapsed === true };
  });
}

export function reviewComment(value: unknown): ChangeRequestReviewComment {
  const v = object(value), position = object(v.position);
  const validPath = (path: unknown) => { try { additionalRepositoryPath(path); return true; } catch { return false; } };
  const line = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2147483647;
  if (!validPath(v.path) || v.oldPath !== undefined && !validPath(v.oldPath) || !['added', 'deleted', 'context'].includes(position.kind)
      || position.kind !== 'deleted' && !line(position.newLine) || position.kind !== 'added' && !line(position.oldLine) || position.kind === 'context' && !['left', 'right'].includes(position.side)) throw new Error('审查批注位置无效');
  return { path: v.path, ...(v.oldPath ? { oldPath: v.oldPath } : {}), position: position.kind === 'added' ? { kind: 'added', newLine: position.newLine } : position.kind === 'deleted' ? { kind: 'deleted', oldLine: position.oldLine } : { kind: 'context', oldLine: position.oldLine, newLine: position.newLine, side: position.side }, body: commentBody(v.body) };
}
export function commentBody(value: unknown, empty = false): string {
  if (typeof value !== 'string' || value.length > 65536 || Buffer.from(value, 'utf8').toString('utf8') !== value || value.includes('\0') || !empty && !value.trim()) throw new Error('评论内容无效');
  return value; // Markdown whitespace is significant; T3 does not trim it.
}

export type ChangeRequestEffectResult = { resultURL?: string };
export type ChangeRequestEffect = { key: string; run: (signal: AbortSignal) => Promise<void | ChangeRequestEffectResult> };
export function changeRequestEffects(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, input: { action: ChangeRequestAction | 'comment' | 'review'; body?: string; verdict?: ChangeRequestVerdict; comments?: ChangeRequestReviewComment[]; mergeMethod?: string }, mergeMessage?: GithubMergeMessage): ChangeRequestEffect[] {
  const path = changeRequestPath(r, detail.pullRequest.number), effects: ChangeRequestEffect[] = [];
  const send = (key: string, target: string, body?: Record<string, unknown>, method: JsonOptions['method'] = 'POST') => effects.push({ key, run: async signal => { await p.json(target, { method, body, signal, allowEmpty: true, jsonBody: true }); } });
  if (input.action === 'comment') {
    if (!detail.canComment) throw new Error('当前账号不能发表评论');
    send('comment', r.provider === 'github' ? `repos/${r.path}/issues/${detail.pullRequest.number}/comments` : path + (r.provider === 'gitlab' ? '/notes' : '/comments'), r.provider === 'bitbucket' ? { content: { raw: input.body } } : { body: input.body }); return effects;
  }
  if (input.action === 'review') {
    if (!input.verdict || !detail.verdicts.includes(input.verdict)) throw new Error('平台或当前账号不支持这项审查结论');
    if (r.provider === 'github') {
      const comments = (input.comments ?? []).map(c => ({ path: c.path, body: c.body, line: c.position.kind === 'deleted' ? c.position.oldLine : c.position.kind === 'context' && c.position.side === 'left' ? c.position.oldLine : c.position.newLine, side: c.position.kind === 'deleted' || c.position.kind === 'context' && c.position.side === 'left' ? 'LEFT' : 'RIGHT' }));
      send('review', path + '/reviews', { commit_id: detail.headSha, event: input.verdict === 'approve' ? 'APPROVE' : input.verdict === 'request-changes' ? 'REQUEST_CHANGES' : 'COMMENT', body: input.body ?? '', comments }); return effects;
    }
    for (const [index, c] of (input.comments ?? []).entries()) {
      const position = c.position;
      if (r.provider === 'gitlab') {
        if (!detail.baseSha || !detail.startSha) throw new Error('GitLab 未返回可确认的 Diff 版本');
        send('inline-' + index, path + '/discussions', { body: c.body, position: { base_sha: detail.baseSha, head_sha: detail.headSha, start_sha: detail.startSha, position_type: 'text', old_path: c.oldPath ?? c.path, new_path: c.path, ...(position.kind === 'added' ? { new_line: position.newLine } : position.kind === 'deleted' ? { old_line: position.oldLine } : { old_line: position.oldLine, new_line: position.newLine }) } });
      } else send('inline-' + index, path + '/comments', { content: { raw: c.body }, inline: { path: c.path, ...(position.kind === 'deleted' || position.kind === 'context' && position.side === 'left' ? { from: position.oldLine } : { to: position.newLine }) } });
    }
    if (input.body?.trim()) send('summary', path + (r.provider === 'gitlab' ? '/notes' : '/comments'), r.provider === 'gitlab' ? { body: input.body } : { content: { raw: input.body } });
    if (input.verdict !== 'comment') send('verdict', path + (input.verdict === 'approve' ? '/approve' : '/request-changes'));
    return effects;
  }
  if (!detail.actions.includes(input.action)) throw new Error('当前状态或账号不支持这项 PR／MR 操作');
  if (input.action === 'merge') {
    const method = input.mergeMethod ?? detail.mergeMethods[0]; if (!detail.mergeMethods.includes(method)) throw new Error('仓库不支持这种合并方式');
    if (r.provider === 'github') {
      effects.push({ key: 'merge', run: async signal => { await githubGraphql(p, detail.mergeQueue ? 'mutation FridayMerge($input:EnablePullRequestAutoMergeInput!){enablePullRequestAutoMerge(input:$input){pullRequest{id}}}' : 'mutation FridayMerge($input:MergePullRequestInput!){mergePullRequest(input:$input){pullRequest{id}}}', { input: { pullRequestId: detail.nodeId, mergeMethod: method.toUpperCase(), ...(!detail.mergeQueue ? { expectedHeadOid: detail.headSha } : {}), ...(!detail.mergeQueue && method !== 'rebase' && mergeMessage ? mergeMessage : {}) } }, signal); } });
    } else if (r.provider === 'gitlab') {
      if (!p.mergeGitLab) throw new Error('GitLab 连接不支持合并');
      effects.push({ key: 'merge', run: signal => p.mergeGitLab!(r.path, detail.pullRequest.number, method, signal) });
    } else send('merge', path + '/merge', { merge_strategy: method === 'squash' ? 'squash' : method === 'rebase' ? 'rebase_fast_forward' : 'merge_commit' });
  } else if (r.provider === 'github') {
    if (input.action === 'close' || input.action === 'reopen') send(input.action, path, { state: input.action === 'close' ? 'closed' : 'open' }, 'PATCH');
    else effects.push({ key: input.action, run: async signal => { const ready = input.action === 'ready'; await githubGraphql(p, `mutation FridayDraft($input:${ready ? 'MarkPullRequestReadyForReviewInput' : 'ConvertPullRequestToDraftInput'}!){${ready ? 'markPullRequestReadyForReview' : 'convertPullRequestToDraft'}(input:$input){pullRequest{id}}}`, { input: { pullRequestId: detail.nodeId } }, signal); } });
  } else if (r.provider === 'gitlab') {
    const body = input.action === 'close' || input.action === 'reopen' ? { state_event: input.action } : { title: input.action === 'draft' ? 'Draft: ' + detail.pullRequest.title : detail.pullRequest.title.replace(/^(?:Draft|WIP):\s*/i, '') };
    send(input.action, path, body, 'PUT');
  } else send('close', path + '/decline');
  return effects;
}
