// T3 Code 8cd9641f: newest 100 GitHub commits, GitLab commit stats,
// paged Bitbucket history, and GitHub dismissal reasons on their original review.
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { actor, changeRequestDiffFiles, changeRequestPath, githubGraphql, list, object, pages, safeURL, words } from './task-change-request-data.js';
import { parseDiffFilePaths } from './vendor/t3-diff-file-revisions.js';

export type ChangeRequestCommit = { oid: string; messageHeadline: string; committedDate: string; additions?: number; deletions?: number; authors: { login: string; name?: string; avatarURL?: string }[] };
export type ChangeRequestCommits = { commits: ChangeRequestCommit[]; commitsTruncated: boolean; dismissals?: Record<string, string>; dismissalsTruncated?: boolean };
const oid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{7,64}$/i.test(value);
const stat = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
function commit(value: any, provider: SourceControlRepository['provider']): ChangeRequestCommit | undefined {
  const entry = object(value), hash = entry.oid ?? entry.id ?? entry.hash;
  const date = words(entry.committedDate ?? entry.committed_date ?? entry.created_at ?? entry.date, 64);
  if (!oid(hash) || !date || !Number.isFinite(Date.parse(date))) return;
  const authors = provider === 'github' ? list(object(entry.authors).nodes).map(v => ({ login: actor(v.user) || words(v.name, 256), name: words(v.name, 256) || undefined, avatarURL: safeURL(v.avatarUrl) })).filter(v => v.login)
    : provider === 'gitlab' ? [{ login: words(entry.author_name ?? entry.author_email, 256), name: words(entry.author_name, 256) || undefined }].filter(v => v.login)
    : [{ login: actor(object(entry.author).user) || words(object(entry.author).raw, 256), name: words(object(object(entry.author).user).display_name, 256) || undefined, avatarURL: safeURL(object(object(object(object(entry.author).user).links).avatar).href) }].filter(v => v.login);
  const stats = provider === 'github' ? entry : object(entry.stats);
  return { oid: hash.toLowerCase(), messageHeadline: words(entry.messageHeadline ?? entry.title ?? entry.message).split(/\r?\n/)[0], committedDate: date,
    ...(stat(stats.additions) !== undefined ? { additions: stat(stats.additions) } : {}), ...(stat(stats.deletions) !== undefined ? { deletions: stat(stats.deletions) } : {}), authors };
}
export async function changeRequestCommits(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal?: AbortSignal): Promise<ChangeRequestCommits> {
  if (p.additional) { const activity = await p.additional.activity(number, signal); return { commits: activity.commits, commitsTruncated: activity.commitsTruncated }; }
  if (p.host !== r.host || p.provider !== r.provider) throw new Error('Source Control 连接与目标不一致');
  if (r.provider === 'github') {
    const commits: ChangeRequestCommit[] = [], dismissals: Record<string, string> = {}; let after: string | undefined, commitsTruncated = false, dismissalsTruncated = false;
    for (let page = 0; page < 10; page++) {
      let result: Record<string, any>;
      try { result = await githubGraphql(p, `query FridayTimelineCommits($owner:String!,$name:String!,$number:Int!,$head:Boolean!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){commits(last:100) @include(if:$head){pageInfo{hasPreviousPage} nodes{commit{oid messageHeadline committedDate additions deletions authors(first:3){nodes{name avatarUrl user{login}}}}}} reviewDismissals:timelineItems(itemTypes:[REVIEW_DISMISSED_EVENT],first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{... on ReviewDismissedEvent{dismissalMessage review{id}}}}}}}`, { owner: r.owner, name: r.name, number, head: page === 0, after }, signal); }
      catch (error) { signal?.throwIfAborted(); if (page === 0) throw error; dismissalsTruncated = true; break; }
      const pr = object(object(result.repository).pullRequest);
      if (page === 0) {
        if (!Array.isArray(object(pr.commits).nodes)) throw new Error('无法读取 PR／MR 提交记录');
        commits.push(...list(object(pr.commits).nodes).map(v => commit(object(v).commit, r.provider)).filter((v): v is ChangeRequestCommit => !!v));
        commitsTruncated = object(object(pr.commits).pageInfo).hasPreviousPage === true;
      }
      const connection = object(pr.reviewDismissals);
      for (const v of list(connection.nodes)) { const id = words(object(v.review).id, 256); if (id) dismissals[id] = words(v.dismissalMessage); }
      if (object(connection.pageInfo).hasNextPage !== true) break;
      const cursor = object(connection.pageInfo).endCursor;
      if (typeof cursor !== 'string' || cursor === after || page === 9) { dismissalsTruncated = true; break; } after = cursor;
    }
    return { commits, commitsTruncated, dismissals, dismissalsTruncated };
  }
  const result = r.provider === 'gitlab' ? { values: await p.array(changeRequestPath(r, number) + '/commits?per_page=100&with_stats=true', { signal, maxResponseBytes: 8 * 1024 * 1024 }), truncated: false }
    : await pages(p, changeRequestPath(r, number) + '/commits', true, signal);
  const seen = new Set<string>(), commits = result.values.map(v => commit(v, r.provider)).filter((v): v is ChangeRequestCommit => !!v).filter(v => !seen.has(v.oid) && !!seen.add(v.oid));
  return { commits: commits.reverse(), commitsTruncated: result.truncated || r.provider === 'gitlab' && result.values.length >= 100 };
}

export async function changeRequestCommitDiff(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, hash: unknown, signal?: AbortSignal) {
  if (p.additional) { if (r.provider !== 'forgejo') throw new Error('当前平台不支持提交 Diff'); const detail = await p.additional.detail(number, signal), diff = await p.additional.diff(number, { head: detail.headSha, base: detail.baseSha, commit: hash }, signal), commit = (await p.additional.activity(number, signal)).commits.find(value => value.oid === hash); if (!commit) throw new Error('所选提交不属于此 PR'); return { commit, headSha: commit.oid, files: diff.files, truncated: diff.truncated }; }
  if (!oid(hash)) throw new Error('提交版本无效');
  const history = await changeRequestCommits(p, r, number, signal), selected = history.commits.find(v => v.oid === hash.toLowerCase());
  if (!selected) throw new Error('该提交不在当前 PR／MR 的可见提交记录中');
  let files, truncated = false;
  if (r.provider === 'github') {
    const values: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const value = await p.json(`repos/${r.path}/commits/${selected.oid}?per_page=100&page=${page}`, { signal, maxResponseBytes: 8 * 1024 * 1024 });
      if (value.sha !== selected.oid || !Array.isArray(value.files)) throw new Error('平台返回的提交版本不一致');
      values.push(...value.files); if (value.files.length < 100) break; if (page === 10) truncated = true;
    }
    files = changeRequestDiffFiles(r.provider, values);
  } else if (r.provider === 'gitlab') {
    const value = await pages(p, `projects/${encodeURIComponent(r.path)}/repository/commits/${selected.oid}/diff`, false, signal);
    files = changeRequestDiffFiles(r.provider, value.values); truncated = value.truncated;
  } else {
    if (!p.text) throw new Error('Bitbucket 连接不支持 Diff');
    const patch = await p.text(`repositories/${r.path}/diff/${selected.oid}`, { signal, maxResponseBytes: 8 * 1024 * 1024 });
    const values = parseDiffFilePaths(patch).map(v => ({ old: { path: v.oldPath }, new: { path: v.newPath }, status: v.oldPath === null ? 'added' : v.newPath === null ? 'removed' : v.oldPath !== v.newPath ? 'renamed' : 'modified' }));
    files = changeRequestDiffFiles(r.provider, values, patch);
  }
  return { commit: selected, headSha: selected.oid, files, truncated };
}
