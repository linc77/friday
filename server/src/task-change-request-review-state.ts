import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { actor, changeRequestPath, githubGraphql, list, object, type ChangeRequestDetail, type ChangeRequestEffect } from './task-change-request-data.js';
import { SourceControlReviewStore } from './source-control-review-store.js';
import { parseDiffFileRevisions } from './vendor/t3-diff-file-revisions.js';

export const reactionContents = ['thumbs-up', 'thumbs-down', 'laugh', 'hooray', 'confused', 'heart', 'rocket', 'eyes'] as const;
export type ReviewReactionContent = typeof reactionContents[number];
export type ReviewReaction = { content: ReviewReactionContent; count: number; actors: string[]; viewerHasReacted: boolean };
export type ReviewStateAction = 'reaction' | 'files_viewed';
export type ReviewStateInput = { action: ReviewStateAction; subjectId?: string; content?: ReviewReactionContent; reacted?: boolean; files?: { path: string; viewed: boolean }[] };
const githubContents = { 'thumbs-up': 'THUMBS_UP', 'thumbs-down': 'THUMBS_DOWN', laugh: 'LAUGH', hooray: 'HOORAY', confused: 'CONFUSED', heart: 'HEART', rocket: 'ROCKET', eyes: 'EYES' } as const;
const gitlabContents = { 'thumbs-up': 'thumbsup', 'thumbs-down': 'thumbsdown', laugh: 'laughing', hooray: 'tada', confused: 'confused', heart: 'heart', rocket: 'rocket', eyes: 'eyes' } as const;
export const githubReactionFields = 'reactionGroups{content viewerHasReacted reactors(first:10){totalCount nodes{... on User{login} ... on Bot{login} ... on Organization{login} ... on Mannequin{login}}}}';
const wellFormed = (value: string) => Buffer.from(value).toString('utf8') === value;
export function reviewStateInput(raw: unknown): ReviewStateInput {
  const v = object(raw);
  if (v.action === 'reaction') {
    if (!reactionContents.includes(v.content) || typeof v.reacted !== 'boolean' || v.subjectId !== undefined && (typeof v.subjectId !== 'string' || !v.subjectId || v.subjectId.length > 1024 || !wellFormed(v.subjectId) || /[\u0000-\u001f]/.test(v.subjectId))) throw new Error('表情反应设置无效');
    return { action: 'reaction', content: v.content, reacted: v.reacted, ...(v.subjectId !== undefined ? { subjectId: v.subjectId } : {}) };
  }
  if (v.action !== 'files_viewed' || !Array.isArray(v.files) || v.files.length > 500) throw new Error('文件已读设置无效');
  return { action: 'files_viewed', files: v.files.map((raw: unknown) => {
    const file = object(raw);
    if (typeof file.path !== 'string' || !file.path || file.path.length > 4096 || file.path.includes('\0') || !wellFormed(file.path) || file.path.startsWith('/') || file.path.split('/').includes('..') || typeof file.viewed !== 'boolean') throw new Error('文件已读路径无效');
    return { path: file.path, viewed: file.viewed }; // Legal filename whitespace is significant.
  }) };
}
export function githubReactions(groups: unknown, viewer?: string): ReviewReaction[] {
  return reactionContents.flatMap(content => {
    const group = list(groups).find(v => v.content === githubContents[content]); if (!group) return [];
    const reactors = object(group.reactors), count = reactors.totalCount;
    if (!Number.isSafeInteger(count) || count < 1) return [];
    const reacted = group.viewerHasReacted === true;
    const actors = [...new Set<string>(list(reactors.nodes).map(actor).filter(v => v && (!reacted || v.toLowerCase() !== viewer?.toLowerCase())))].slice(0, Math.max(0, count - (reacted ? 1 : 0)));
    return [{ content, count, actors, viewerHasReacted: reacted }];
  });
}
function gitlabReactions(awards: unknown, viewer?: string): ReviewReaction[] {
  return reactionContents.flatMap(content => {
    const matches = list(awards).filter(v => v.name === gitlabContents[content]); if (!matches.length) return [];
    const reacted = matches.some(v => actor(v.user).toLowerCase() === viewer?.toLowerCase());
    return [{ content, count: matches.length, actors: [...new Set<string>(matches.map(v => actor(v.user)).filter(v => v && (!reacted || v.toLowerCase() !== viewer?.toLowerCase())))], viewerHasReacted: reacted }];
  });
}
async function viewerOf(p: PinnedSourceControlConnection, signal?: AbortSignal) {
  if (p.additional && p.viewer) return p.viewer;
  const viewer = actor(await p.json('user', { signal })); if (!viewer) throw new Error('无法确认当前审查账号'); return viewer;
}
async function fileRevisions(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, paths: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  if (p.additional) return p.additional.fileRevisions(number, paths, signal);
  if (!paths.length) return new Map();
  if (r.provider === 'bitbucket') {
    if (!p.text) throw new Error('无法读取文件版本');
    return new Map(parseDiffFileRevisions(await p.text(changeRequestPath(r, number) + '/diff', { signal, maxResponseBytes: 8 * 1024 * 1024 })));
  }
  const detail = await p.json(changeRequestPath(r, number), { signal }), head = detail.sha ?? object(detail.diff_refs).head_sha;
  if (typeof head !== 'string' || !/^[a-f\d]{7,64}$/i.test(head)) throw new Error('无法确认文件版本');
  const revisions = new Map<string, string>();
  for (let at = 0; at < paths.length; at += 100) {
    const batch = paths.slice(at, at + 100);
    const raw = await p.json('graphql', { method: 'POST', jsonBody: true, signal, maxResponseBytes: 8 * 1024 * 1024, body: { query: 'query FridayReviewBlobs($fullPath:ID!,$ref:String!,$paths:[String!]!){project(fullPath:$fullPath){repository{blobs(paths:$paths,ref:$ref){nodes{path oid}}}}}', variables: { fullPath: r.path, ref: head, paths: batch } } });
    if (raw.errors) throw new Error('无法读取文件版本');
    const repository = object(object(object(raw.data).project).repository); if (!repository.blobs) continue;
    for (const v of list(object(repository.blobs).nodes)) if (typeof v.path === 'string' && typeof v.oid === 'string') revisions.set(v.path, v.oid);
    for (const path of batch) if (!revisions.has(path)) revisions.set(path, '');
  }
  return revisions;
}

export class TaskChangeRequestReviewState {
  private readonly store: SourceControlReviewStore;
  constructor(directory: string) { this.store = new SourceControlReviewStore(directory); }
  close() { this.store.close(); }
  async viewed(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal) {
    if (r.provider === 'github') {
      const files: { path: string; state: 'viewed' | 'unviewed' | 'dismissed' }[] = []; let after: string | null = null; let truncated = false;
      for (let page = 0; page < 5; page++) {
        const raw = await githubGraphql(p, 'query FridayFilesViewed($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){files(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{path viewerViewedState}}}}}', { owner: r.owner, name: r.name, number, after }, signal);
        const pr = object(object(raw.repository).pullRequest); if (!pr.files) throw new Error('无法读取平台文件已读状态');
        const connection = object(pr.files);
        for (const v of list(connection.nodes)) if (typeof v.path === 'string' && ['VIEWED', 'UNVIEWED', 'DISMISSED'].includes(v.viewerViewedState)) files.push({ path: v.path, state: v.viewerViewedState.toLowerCase() });
        if (!object(connection.pageInfo).hasNextPage) break;
        const next = object(connection.pageInfo).endCursor; if (typeof next !== 'string' || next === after) throw new Error('平台文件已读分页无效'); after = next; if (page === 4) truncated = true;
      }
      return { storage: 'host' as const, files, truncated };
    }
    const viewer = await viewerOf(p, signal), held = this.store.list({ repository: r, number, viewer });
    let revisions = new Map<string, string>();
    try { revisions = await fileRevisions(p, r, number, held.files.map(v => v.path), signal); } catch { signal?.throwIfAborted(); }
    return { storage: 'environment' as const, files: held.files.map(mark => ({ path: mark.path, state: mark.revision !== null && revisions.has(mark.path) && revisions.get(mark.path) !== mark.revision ? 'dismissed' as const : 'viewed' as const })), truncated: held.truncated };
  }
  async reactions(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal): Promise<{ supported: boolean; reactions: ReviewReaction[]; bySubject: Record<string, ReviewReaction[]>; truncated: boolean }> {
    if (p.additional) { if (r.provider === 'azure-devops') return { supported: false, reactions: [], bySubject: {}, truncated: false }; const activity = await p.additional.activity(number, signal); return { supported: true, reactions: activity.reactions, bySubject: activity.bySubject, truncated: activity.truncated }; }
    if (r.provider === 'bitbucket') return { supported: false, reactions: [], bySubject: {}, truncated: false };
    if (r.provider === 'github') {
      const raw = await githubGraphql(p, `query FridayRequestReactions($owner:String!,$name:String!,$number:Int!){viewer{login} repository(owner:$owner,name:$name){pullRequest(number:$number){${githubReactionFields}}}}`, { owner: r.owner, name: r.name, number }, signal);
      const pr = object(object(raw.repository).pullRequest); if (!Object.keys(pr).length) throw new Error('无法读取表情反应');
      return { supported: true, reactions: githubReactions(pr.reactionGroups, actor(raw.viewer)), bySubject: {}, truncated: false };
    }
    let after: string | null = null, reactions: ReviewReaction[] = [], truncated = false; const bySubject = new Map<string, ReviewReaction[]>();
    for (let page = 0; page < 10; page++) {
      const raw = await p.json('graphql', { method: 'POST', jsonBody: true, signal, maxResponseBytes: 8 * 1024 * 1024, body: { query: 'query FridayAwards($fullPath:ID!,$iid:String!,$cursor:String){currentUser{username} project(fullPath:$fullPath){mergeRequest(iid:$iid){awardEmoji{nodes{name user{username}}} notes(first:100,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id awardEmoji{nodes{name user{username}}}}}}}}', variables: { fullPath: r.path, iid: String(number), cursor: after } } });
      if (raw.errors) throw new Error('无法读取表情反应');
      const data = object(raw.data), mr = object(object(data.project).mergeRequest), viewer = actor(data.currentUser);
      if (!mr.awardEmoji || !mr.notes) throw new Error('无法读取表情反应');
      reactions = gitlabReactions(object(mr.awardEmoji).nodes, viewer);
      const notes = object(mr.notes);
      for (const v of list(notes.nodes)) { const id = String(v.id).split('/').at(-1)!; if (/^[1-9]\d*$/.test(id)) bySubject.set(id, gitlabReactions(object(v.awardEmoji).nodes, viewer)); }
      if (!object(notes.pageInfo).hasNextPage) break;
      const next = object(notes.pageInfo).endCursor; if (typeof next !== 'string' || next === after) throw new Error('表情反应分页无效'); after = next; if (page === 9) truncated = true;
    }
    return { supported: true, reactions, bySubject: Object.fromEntries(bySubject), truncated };
  }
  async effects(p: PinnedSourceControlConnection, r: SourceControlRepository, detail: ChangeRequestDetail, input: ReviewStateInput, signal?: AbortSignal): Promise<ChangeRequestEffect[]> {
    if (p.additional && input.action === 'reaction') return p.additional.reactionEffects(detail.pullRequest.number, input, signal);
    const path = changeRequestPath(r, detail.pullRequest.number);
    if (input.action === 'files_viewed') {
      const files = input.files!; if (!files.length) return [];
      if (r.provider === 'github') {
        const variables: Record<string, unknown> = { request: detail.nodeId }, declarations = ['$request:ID!'];
        const fields = files.map((file, index) => { declarations.push(`$path${index}:String!`); variables['path' + index] = file.path; return `f${index}:${file.viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'}(input:{pullRequestId:$request,path:$path${index}}){pullRequest{id}}`; });
        return [{ key: 'viewed-files', run: async signal => { await githubGraphql(p, `mutation FridayViewedFiles(${declarations.join(',')}){${fields.join(' ')}}`, variables, signal); } }];
      }
      const viewer = await viewerOf(p, signal);
      return [{ key: 'viewed-files', run: async signal => {
        let revisions = new Map<string, string>(); try { revisions = await fileRevisions(p, r, detail.pullRequest.number, files.filter(v => v.viewed).map(v => v.path), signal); } catch { signal.throwIfAborted(); }
        signal.throwIfAborted(); this.store.set({ repository: r, number: detail.pullRequest.number, viewer }, files.map(file => ({ ...file, revision: revisions.get(file.path) ?? null })));
      } }];
    }
    if (r.provider === 'bitbucket') throw new Error('Bitbucket 不支持表情反应');
    if (r.provider === 'github') {
      let subject = detail.nodeId!;
      if (input.subjectId && input.subjectId !== detail.nodeId) {
        const raw = await githubGraphql(p, 'query FridayReactionSubject($id:ID!){node(id:$id){id __typename ... on IssueComment{pullRequest{id}} ... on PullRequestReviewComment{commentRequest:pullRequest{id}} ... on PullRequestReview{reviewRequest:pullRequest{id}}}}', { id: input.subjectId }, signal), node = object(raw.node);
        if (node.id !== input.subjectId || !['IssueComment', 'PullRequestReviewComment', 'PullRequestReview'].includes(node.__typename) || object(node.pullRequest ?? node.commentRequest ?? node.reviewRequest).id !== detail.nodeId) throw new Error('该表情反应目标不属于当前 PR'); subject = input.subjectId;
      }
      return [{ key: 'reaction', run: async signal => { await githubGraphql(p, `mutation FridayReaction($id:ID!,$content:ReactionContent!){${input.reacted ? 'addReaction' : 'removeReaction'}(input:{subjectId:$id,content:$content}){reaction{content}}}`, { id: subject, content: githubContents[input.content!] }, signal); } }];
    }
    let subject = path;
    if (input.subjectId) {
      if (!/^[1-9]\d*$/.test(input.subjectId)) throw new Error('表情反应目标无效');
      subject += '/notes/' + input.subjectId;
      if (String((await p.json(subject, { signal })).id) !== input.subjectId) throw new Error('该表情反应目标不属于当前 MR');
    }
    subject += '/award_emoji'; const name = gitlabContents[input.content!];
    if (input.reacted) return [{ key: 'reaction', run: async signal => { await p.json(subject + '?' + new URLSearchParams({ name }), { method: 'POST', signal, allowEmpty: true }); } }];
    const viewer = await viewerOf(p, signal), awards = await p.array(subject, { signal });
    const own = awards.find(raw => { const v = object(raw); return v.name === name && actor(v.user).toLowerCase() === viewer.toLowerCase(); });
    if (own && (!Number.isSafeInteger(object(own).id) || object(own).id < 1)) throw new Error('表情反应回执无效');
    return [{ key: 'reaction', run: async signal => { if (own) await p.json(subject + '/' + object(own).id, { method: 'DELETE', signal, allowEmpty: true }); } }];
  }
}
