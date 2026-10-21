// Review collaboration follows T3 Code 8cd9641f's provider contracts. Resource
// identifiers are checked against the pinned request before any external write.
import type { PinnedSourceControlConnection, JsonOptions } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { actor, changeRequestPath, commentBody, githubGraphql, list, object, pages, safeURL, words, type ChangeRequestActivity, type ChangeRequestDetail, type ChangeRequestEffect } from './task-change-request-data.js';
import { githubReactionFields, githubReactions, type ReviewReaction } from './task-change-request-review-state.js';

export const collaborationActions = ['reply', 'resolve', 'edit_comment', 'edit_request', 'reviewers', 'labels'] as const;
export type CollaborationAction = typeof collaborationActions[number];
export type CollaborationInput = { action: CollaborationAction; body?: string; title?: string; threadId?: string; commentId?: string; commentKind?: 'issue-comment' | 'review-comment'; resolved?: boolean; reviewers?: { id: string; kind: 'user' | 'team' }[]; requested?: boolean; labels?: string[]; applied?: boolean };
export type ChangeRequestThreadComment = { id: string; author: string; body: string; createdAt: string; editedAt?: string; url?: string; canEdit?: boolean; commentKind: 'review-comment'; reactions?: ReviewReaction[] };
export type ChangeRequestThread = { id: string; path: string; line?: number; side: 'left' | 'right'; isResolved: boolean; isOutdated: boolean; canResolve?: boolean; comments: ChangeRequestThreadComment[]; commentCount: number; nextCursor?: string };
export type ReviewerCandidate = { id: string; kind: 'user' | 'team'; login: string; name?: string; isRequested: boolean };
export type LabelCandidate = { name: string; color?: string; description?: string; isApplied: boolean };
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw new Error('平台资源 ID 无效');
  return value.trim();
};
export const isCollaborationAction = (action: string): action is CollaborationAction => (collaborationActions as readonly string[]).includes(action);
export function collaborationInput(value: unknown): CollaborationInput {
  const v = object(value); if (!isCollaborationAction(v.action)) throw new Error('平台协作操作无效');
  const input: CollaborationInput = { action: v.action };
  if (v.action === 'reply' || v.action === 'edit_comment') input.body = commentBody(v.body);
  if (v.action === 'reply' || v.action === 'resolve') input.threadId = identifier(v.threadId);
  if (v.action === 'resolve') { if (typeof v.resolved !== 'boolean') throw new Error('线程解决状态无效'); input.resolved = v.resolved; }
  if (v.action === 'edit_comment') {
    input.commentId = identifier(v.commentId);
    if (!['issue-comment', 'review-comment'].includes(v.commentKind)) throw new Error('评论类型无效'); input.commentKind = v.commentKind;
  }
  if (v.action === 'edit_request') {
    if (v.title !== undefined) { input.title = commentBody(v.title).trim(); if (input.title.length > 1024 || /[\r\n]/.test(input.title)) throw new Error('PR／MR 标题无效'); }
    if (v.body !== undefined) input.body = commentBody(v.body, true);
    if (input.title === undefined && input.body === undefined) throw new Error('没有要修改的 PR／MR 内容');
  }
  if (v.action === 'reviewers') {
    if (typeof v.requested !== 'boolean' || !Array.isArray(v.reviewers) || !v.reviewers.length || v.reviewers.length > 100) throw new Error('审查者选择无效');
    input.requested = v.requested; input.reviewers = v.reviewers.map((raw: unknown) => { const person = object(raw); if (!['user', 'team'].includes(person.kind)) throw new Error('审查者类型无效'); return { id: identifier(person.id), kind: person.kind }; });
    if (new Set(input.reviewers!.map(v => v.kind + ':' + v.id)).size !== input.reviewers!.length) throw new Error('审查者选择重复');
  }
  if (v.action === 'labels') {
    if (typeof v.applied !== 'boolean' || !Array.isArray(v.labels) || !v.labels.length || v.labels.length > 100) throw new Error('标签选择无效');
    input.applied = v.applied; input.labels = v.labels.map((v: unknown) => { const name = identifier(v); if (name.length > 100) throw new Error('标签名称过长'); return name; });
    if (new Set(input.labels).size !== input.labels.length) throw new Error('标签选择重复');
  }
  return input;
}

const githubThreadCommentFields = `id body createdAt lastEditedAt url viewerCanUpdate author{login} ${githubReactionFields}`;
function threadComment(raw: unknown, provider: SourceControlRepository['provider'], viewer?: string): ChangeRequestThreadComment {
  const v = object(raw), createdAt = words(v.createdAt ?? v.created_at ?? v.created_on, 64), updatedAt = words(v.updated_at ?? v.updated_on, 64);
  const editedAt = words(v.lastEditedAt, 64) || (updatedAt && Date.parse(updatedAt) !== Date.parse(createdAt) ? updatedAt : undefined);
  return { id: String(v.id), author: actor(v.author ?? v.user), body: words(v.body ?? object(v.content).raw), createdAt, editedAt, url: safeURL(v.url ?? v.web_url ?? object(object(v.links).html).href), commentKind: 'review-comment', canEdit: v.deleted ? false : typeof v.viewerCanUpdate === 'boolean' ? v.viewerCanUpdate : same(viewer, actor(v.author ?? v.user)), ...(provider === 'github' ? { reactions: githubReactions(v.reactionGroups, viewer) } : {}) };
}
function githubThread(raw: unknown, viewer?: string): ChangeRequestThread {
  const v = object(raw), comments = object(v.comments);
  return { id: String(v.id), path: words(v.path, 4096), line: Number.isSafeInteger(v.line) && v.line > 0 ? v.line : undefined, side: v.diffSide === 'LEFT' ? 'left' : 'right', isResolved: v.isResolved === true, isOutdated: v.isOutdated === true, comments: list(comments.nodes).filter(Boolean).map(v => threadComment(v, 'github', viewer)), commentCount: Number.isSafeInteger(comments.totalCount) ? comments.totalCount : list(comments.nodes).length, ...(object(comments.pageInfo).hasNextPage && typeof object(comments.pageInfo).endCursor === 'string' ? { nextCursor: object(comments.pageInfo).endCursor } : {}) };
}
export async function changeRequestThreads(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal, bitbucketComments?: { values: any[]; truncated: boolean }) {
  if (p.additional) { const activity = await p.additional.activity(number, signal); return { threads: activity.threads, truncated: activity.truncated, reactions: activity.reactions, bySubject: activity.bySubject, viewer: undefined }; }
  const path = changeRequestPath(r, number); let viewer: string | undefined; const threads: ChangeRequestThread[] = []; let truncated = false;
  let reactions: ReviewReaction[] = []; const bySubject = new Map<string, ReviewReaction[]>();
  if (r.provider === 'github') {
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
      const raw = await githubGraphql(p, `query FridayReviewThreads($owner:String!,$name:String!,$number:Int!,$after:String){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){${githubReactionFields} comments(first:100){nodes{id ${githubReactionFields}}} reviews(first:100){nodes{id ${githubReactionFields}}} reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{id path line diffSide isResolved isOutdated comments(first:10){totalCount pageInfo{hasNextPage endCursor} nodes{${githubThreadCommentFields}}}}}}}}`, { owner: r.owner, name: r.name, number, after }, signal);
      const pr = object(object(raw.repository).pullRequest); if (!pr.reviewThreads) throw new Error('无法读取 GitHub 审查线程');
      viewer = words(object(raw.viewer).login, 256) || undefined;
      reactions = githubReactions(pr.reactionGroups, viewer);
      for (const v of [...list(object(pr.comments).nodes), ...list(object(pr.reviews).nodes)]) if (typeof v.id === 'string') bySubject.set(v.id, githubReactions(v.reactionGroups, viewer));
      const connection = object(pr.reviewThreads); threads.push(...list(connection.nodes).filter(Boolean).map(v => githubThread(v, viewer)));
      if (!object(connection.pageInfo).hasNextPage) break;
      const cursor = object(connection.pageInfo).endCursor; if (typeof cursor !== 'string' || cursor === after) throw new Error('GitHub 审查线程分页无效'); after = cursor; if (page === 9) truncated = true;
    }
  } else {
    try { viewer = actor(await p.json('user', { signal })) || undefined; } catch { signal?.throwIfAborted(); }
    const result = r.provider === 'bitbucket' && bitbucketComments ? bitbucketComments : await pages(p, path + (r.provider === 'gitlab' ? '/discussions' : '/comments'), r.provider === 'bitbucket', signal); truncated = result.truncated;
    if (r.provider === 'gitlab') {
      for (const entry of result.values) {
        const notes = list(entry.notes), root = object(notes[0]), position = object(root.position);
        if (position.position_type !== 'text') continue;
        const side = position.new_line == null ? 'left' : 'right', line = side === 'left' ? position.old_line : position.new_line;
        threads.push({ id: String(entry.id), path: words(side === 'left' ? position.old_path : position.new_path, 4096), line: Number.isSafeInteger(line) && line > 0 ? line : undefined, side, isResolved: root.resolved === true, isOutdated: false, canResolve: root.resolvable !== false, comments: notes.map(v => threadComment(v, 'gitlab', viewer)), commentCount: notes.length });
      }
    } else {
      const byID = new Map<string, any>(result.values.map(v => [String(v.id), v])), groups = new Map<string, any[]>();
      for (const comment of result.values) {
        let root = comment; const seen = new Set<string>();
        while (object(root.parent).id != null && byID.has(String(root.parent.id)) && !seen.has(String(root.id))) { seen.add(String(root.id)); root = byID.get(String(root.parent.id)); }
        if (!object(root.inline).path) continue;
        const id = String(root.id); groups.set(id, [...groups.get(id) ?? [], comment]);
      }
      for (const [id, entries] of groups) {
        const root = byID.get(id), inline = object(root.inline), side = inline.to == null ? 'left' : 'right', line = side === 'left' ? inline.from : inline.to;
        threads.push({ id, path: words(inline.path, 4096), line: Number.isSafeInteger(line) && line > 0 ? line : undefined, side, isResolved: root.resolution != null, isOutdated: inline.outdated === true, comments: entries.sort((a, b) => String(a.created_on).localeCompare(String(b.created_on))).map(v => threadComment(v, 'bitbucket', viewer)), commentCount: entries.length });
      }
    }
  }
  return { threads, viewer, truncated, reactions, bySubject: Object.fromEntries(bySubject) };
}
export function discussionActivity(base: { items: ChangeRequestActivity[]; truncated: boolean }, discussion: Awaited<ReturnType<typeof changeRequestThreads>>, reactionState?: { reactions: ReviewReaction[]; bySubject: Record<string, ReviewReaction[]>; truncated: boolean }) {
  const nested = new Set(discussion.threads.flatMap(t => t.comments.map(c => c.id)));
  const state = reactionState ?? discussion;
  return { items: base.items.filter(v => !nested.has(v.sourceID ?? '')).map(v => ({ ...v, ...(v.sourceID ? { canEdit: v.commentKind ? same(discussion.viewer, v.author) : false, reactions: state.bySubject[v.sourceID] ?? [] } : {}) })), threads: discussion.threads.map(thread => ({ ...thread, comments: thread.comments.map(comment => ({ ...comment, reactions: state.bySubject[comment.id] ?? comment.reactions ?? [] })) })), reactions: state.reactions, truncated: base.truncated || discussion.truncated || reactionState?.truncated === true, reviewThreadsTruncated: discussion.truncated, commentsTruncated: base.truncated };
}
export async function changeRequestThreadComments(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, threadId: unknown, cursor: unknown, signal?: AbortSignal) {
  if (r.provider !== 'github') throw new Error('此平台不支持单独读取下一页线程评论');
  const id = identifier(threadId), after = identifier(cursor);
  const raw = await githubGraphql(p, `query FridayThreadComments($owner:String!,$name:String!,$number:Int!,$id:ID!,$after:String!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){id}} node(id:$id){... on PullRequestReviewThread{id pullRequest{id} comments(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{${githubThreadCommentFields}}}}}}`, { owner: r.owner, name: r.name, number, id, after }, signal);
  const node = object(raw.node), pr = object(object(raw.repository).pullRequest);
  if (!pr.id || node.id !== id || object(node.pullRequest).id !== pr.id) throw new Error('该审查线程不属于当前 PR');
  const connection = object(node.comments); return { comments: list(connection.nodes).filter(Boolean).map(v => threadComment(v, 'github', words(object(raw.viewer).login, 256))), nextCursor: object(connection.pageInfo).hasNextPage ? identifier(object(connection.pageInfo).endCursor) : null };
}

export async function reviewerCandidates(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal) {
  if (p.additional) return p.additional.reviewers(number, signal);
  const candidates = new Map<string, ReviewerCandidate>(); let truncated = false;
  if (r.provider === 'github') {
    const raw = await githubGraphql(p, 'query FridayReviewerCandidates($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){assignableUsers(first:100){pageInfo{hasNextPage} nodes{login name}} pullRequest(number:$number){author{login} reviewRequests(first:100){nodes{requestedReviewer{... on User{login name} ... on Bot{login} ... on Team{slug combinedSlug teamName:name}}}}}}}', { owner: r.owner, name: r.name, number }, signal);
    const repo = object(raw.repository); if (!repo.pullRequest) throw new Error('无法读取审查者候选');
    const author = actor(object(repo.pullRequest).author);
    for (const v of list(object(object(repo.pullRequest).reviewRequests).nodes)) {
      const reviewer = object(v.requestedReviewer), team = typeof reviewer.slug === 'string', id = words(team ? reviewer.slug : reviewer.login, 256); if (!id) continue;
      const entry: ReviewerCandidate = { id, kind: team ? 'team' : 'user', login: words(team ? reviewer.combinedSlug ?? reviewer.slug : id, 256), name: words(team ? reviewer.teamName : reviewer.name, 256) || undefined, isRequested: true }; candidates.set(entry.kind + ':' + id, entry);
    }
    for (const v of list(object(repo.assignableUsers).nodes)) { const id = words(v.login, 256); if (!id || same(id, author) || candidates.has('user:' + id)) continue; candidates.set('user:' + id, { id, kind: 'user', login: id, name: words(v.name, 256) || undefined, isRequested: false }); }
    truncated = object(object(repo.assignableUsers).pageInfo).hasNextPage === true;
  } else {
    const raw = await p.json(changeRequestPath(r, number), { signal });
    const members = r.provider === 'gitlab' ? await p.array(`projects/${encodeURIComponent(r.path)}/users?per_page=100`, { signal }) : list((await p.json(`workspaces/${encodeURIComponent(r.owner)}/members?pagelen=100`, { signal })).values);
    const requested = new Set(list(raw.reviewers).map(v => String(r.provider === 'gitlab' ? v.id : v.uuid)));
    for (const item of members) {
      const v = object(r.provider === 'bitbucket' ? item.user : item), id = String(r.provider === 'gitlab' ? v.id ?? '' : v.uuid ?? ''), login = actor(v);
      if (!id || !login || same(login, actor(raw.author))) continue; candidates.set(id, { id, kind: 'user', login, name: words(v.name ?? v.display_name, 256) || undefined, isRequested: requested.has(id) });
    }
    // Keep currently requested people removable even if outside the first page.
    for (const v of list(raw.reviewers)) { const id = String(r.provider === 'gitlab' ? v.id ?? '' : v.uuid ?? ''); if (id && !candidates.has(id)) candidates.set(id, { id, kind: 'user', login: actor(v), isRequested: true }); }
    truncated = members.length >= 100;
  }
  return { candidates: [...candidates.values()], truncated };
}
export async function labelCandidates(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal) {
  if (p.additional) return p.additional.labels(number, signal);
  if (r.provider !== 'github') throw new Error('此平台未提供标签管理');
  const raw = await githubGraphql(p, 'query FridayLabelCandidates($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){labels(first:100,orderBy:{field:NAME,direction:ASC}){pageInfo{hasNextPage} nodes{name color description}} pullRequest(number:$number){labels(first:100){nodes{name color description}}}}}', { owner: r.owner, name: r.name, number }, signal);
  const repo = object(raw.repository); if (!repo.pullRequest) throw new Error('无法读取标签候选');
  const applied = list(object(object(repo.pullRequest).labels).nodes), selected = new Set(applied.map(v => v.name)), candidates = new Map<string, LabelCandidate>();
  for (const v of [...list(object(repo.labels).nodes), ...applied]) { if (typeof v.name !== 'string') continue; candidates.set(v.name, { name: words(v.name, 100), color: typeof v.color === 'string' && /^[a-f\d]{6}$/i.test(v.color) ? v.color : undefined, description: words(v.description, 1024) || undefined, isApplied: selected.has(v.name) }); }
  return { candidates: [...candidates.values()], truncated: object(object(repo.labels).pageInfo).hasNextPage === true };
}

async function githubSubject(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, id: string, thread: boolean, signal?: AbortSignal) {
  const fields = thread ? '... on PullRequestReviewThread{pullRequest{id} isResolved}' : '... on IssueComment{pullRequest{id} viewerCanUpdate} ... on PullRequestReviewComment{reviewPullRequest:pullRequest{id} viewerCanUpdate}';
  const raw = await githubGraphql(p, `query FridayReviewSubject($id:ID!){node(id:$id){id __typename ${fields}}}`, { id }, signal), node = object(raw.node);
  if (node.id !== id || object(node.pullRequest ?? node.reviewPullRequest).id !== detail.nodeId || !(thread ? ['PullRequestReviewThread'] : ['IssueComment', 'PullRequestReviewComment']).includes(node.__typename)) throw new Error('该评论或审查线程不属于当前 PR');
  return node;
}
export async function collaborationEffects(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, input: CollaborationInput, signal?: AbortSignal): Promise<ChangeRequestEffect[]> {
  if (p.additional) return p.additional.collaborationEffects(detail, input, signal);
  const path = changeRequestPath(r, detail.pullRequest.number), effects: ChangeRequestEffect[] = [], permission = detail.management;
  const send = (key: string, target: string, body?: Record<string, unknown>, method: JsonOptions['method'] = 'POST') => effects.push({ key, run: async signal => { await p.json(target, { signal, method, body, allowEmpty: true, jsonBody: true }); } });
  const graphql = (key: string, query: string, variables: Record<string, unknown>) => effects.push({ key, run: async signal => { await githubGraphql(p, query, variables, signal); } });
  if (input.action === 'edit_request') {
    if (permission?.canEdit === false) throw new Error('当前账号不能编辑此 PR／MR');
    const body = { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.body !== undefined ? r.provider === 'github' ? { body: input.body } : { description: input.body } : {}) };
    send('edit-request', path, body, r.provider === 'github' ? 'PATCH' : 'PUT'); return effects;
  }
  if (input.action === 'reviewers') {
    if (permission?.canRequestReviewers === false) throw new Error('当前账号不能请求审查');
    if (r.provider === 'github') send('reviewers', path + '/requested_reviewers', { reviewers: input.reviewers!.filter(v => v.kind === 'user').map(v => v.id), team_reviewers: input.reviewers!.filter(v => v.kind === 'team').map(v => v.id) }, input.requested ? 'POST' : 'DELETE');
    else {
      const current = await p.json(path, { signal });
      const reviewers = new Set(list(current.reviewers).map(v => String(r.provider === 'gitlab' ? v.id : v.uuid)));
      for (const person of input.reviewers!) { if (person.kind !== 'user' || r.provider === 'gitlab' && !/^[1-9]\d*$/.test(person.id) || r.provider === 'bitbucket' && !/^\{[a-f\d-]{36}\}$/i.test(person.id)) throw new Error('审查者与平台不匹配'); if (input.requested) reviewers.add(person.id); else reviewers.delete(person.id); }
      send('reviewers', path, r.provider === 'gitlab' ? { reviewer_ids: [...reviewers].map(Number) } : { reviewers: [...reviewers].map(uuid => ({ uuid })) }, 'PUT');
    }
    return effects;
  }
  if (input.action === 'labels') {
    if (r.provider !== 'github' || permission?.canSetLabels === false) throw new Error('平台或当前账号不支持标签管理');
    if (input.applied) send('labels', `repos/${r.path}/issues/${detail.pullRequest.number}/labels`, { labels: input.labels });
    else for (const [index, name] of input.labels!.entries()) send('label-' + index, `repos/${r.path}/issues/${detail.pullRequest.number}/labels/${encodeURIComponent(name)}`, undefined, 'DELETE');
    return effects;
  }
  if (r.provider === 'github') {
    const thread = input.action !== 'edit_comment', id = (thread ? input.threadId : input.commentId)!;
    const subject = await githubSubject(p, r, detail, id, thread, signal);
    if (input.action === 'edit_comment') {
      if (subject.viewerCanUpdate === false || (input.commentKind === 'issue-comment' ? subject.__typename !== 'IssueComment' : subject.__typename !== 'PullRequestReviewComment')) throw new Error('当前账号不能编辑此评论');
      const issue = input.commentKind === 'issue-comment';
      graphql('edit-comment', `mutation FridayEditComment($id:ID!,$body:String!){${issue ? 'updateIssueComment(input:{id:$id,body:$body}){issueComment{id}}' : 'updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){pullRequestReviewComment{id}}'}}`, { id, body: input.body });
    } else if (input.action === 'reply') {
      if (!detail.canComment) throw new Error('当前账号不能回复审查线程');
      graphql('reply', 'mutation FridayReply($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}', { id, body: input.body });
    } else {
      if (permission?.canResolve === false) throw new Error('当前账号不能解决审查线程');
      graphql('resolve', `mutation FridayResolve($id:ID!){${input.resolved ? 'resolveReviewThread' : 'unresolveReviewThread'}(input:{threadId:$id}){thread{isResolved}}}`, { id });
    }
  } else if (input.action === 'edit_comment') {
    const id = input.commentId!; if (!/^[1-9]\d*$/.test(id)) throw new Error('评论 ID 无效');
    const target = path + (r.provider === 'gitlab' ? '/notes/' : '/comments/') + id, current = await p.json(target, { signal });
    if (String(current.id) !== id || current.system || current.deleted || !same(permission?.viewer, actor(current.author ?? current.user))) throw new Error('当前账号不能编辑此评论');
    send('edit-comment', target, r.provider === 'gitlab' ? { body: input.body } : { content: { raw: input.body } }, 'PUT');
  } else {
    const id = input.threadId!; if (r.provider === 'gitlab' ? !/^[a-f\d]{1,64}$/i.test(id) : !/^[1-9]\d*$/.test(id)) throw new Error('审查线程 ID 无效');
    const target = path + (r.provider === 'gitlab' ? '/discussions/' : '/comments/') + encodeURIComponent(id), current = await p.json(target, { signal });
    if (String(current.id) !== id) throw new Error('该审查线程不属于当前 PR／MR');
    if (input.action === 'reply') {
      if (!detail.canComment) throw new Error('当前账号不能回复审查线程');
      send('reply', r.provider === 'gitlab' ? target + '/notes' : path + '/comments', r.provider === 'gitlab' ? { body: input.body } : { content: { raw: input.body }, parent: { id: Number(id) } });
    } else {
      const canResolve = r.provider === 'gitlab' ? list(current.notes).some(v => v.resolvable === true) : !!object(current.inline).path;
      if (permission?.canResolve === false || !canResolve) throw new Error('此审查线程不能标记为已解决');
      if (r.provider === 'gitlab') send('resolve', target, { resolved: input.resolved }, 'PUT');
      else send('resolve', target + '/resolve', undefined, input.resolved ? 'POST' : 'DELETE');
    }
  }
  return effects;
}
