/*
Adapted from T3 Code 8cd9641f PullRequestSyncReactor.ts / PullRequestService.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { TaskPullRequest } from './types.js';
import type { ChangeRequestDetail } from './task-change-request-data.js';
import type { ChangeRequestStack } from './task-change-request-stack-types.js';
import { azureRepositoryIdentity } from './source-control-provider-identity.js';

export type TaskPullRequestSnapshot = {
  state: TaskPullRequest['state']; title: string; headBranch: string; baseBranch: string;
  isDraft: boolean; updatedAt: string | null; syncedAt: string;
  closedAt: string | null; mergedAt: string | null;
  headSha?: string; author?: { login: string; avatarURL?: string };
  additions?: number; deletions?: number; changedFiles?: number;
  reviewDecision?: string | null; checksState?: string | null; mergeability?: string;
};
export type ChangeRequestSummary = { pullRequest: TaskPullRequest; snapshot: Omit<TaskPullRequestSnapshot, 'syncedAt'>; observedAt: number; stack?: number | null };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const date = (value: unknown): string | null => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? value : null;
const text = (value: unknown, max = 1024): string | undefined => typeof value === 'string' && value.length <= max && value && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
const sha = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f\d]{7,64}$/i.test(value) ? value : undefined;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
function avatar(value: unknown): string | undefined { try { const u = new URL(String(value)); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : undefined; } catch { return; } }

/** Only the public summary fields enter the root document; remote descriptions,
 * comments, credentials and Diff bodies never pass through this conversion. */
export function summaryFromRaw(pullRequest: TaskPullRequest, value: unknown, observedAt = Date.now()): ChangeRequestSummary {
  const raw = object(value), provider = pullRequest.provider;
  const user = object(raw.author ?? raw.user ?? raw.createdBy);
  const login = text(user.login ?? user.username ?? user.display_name ?? user.displayName ?? user.name, 256);
  const avatarURL = avatar(user.avatar_url ?? user.avatarUrl ?? user.imageUrl ?? object(object(user.links).avatar).href);
  const updatedAt = date(raw.updated_at ?? raw.updatedAt ?? raw.updated_on ?? raw.closedDate ?? raw.creationDate);
  const terminalAt = date(raw.closed_on ?? raw.closedDate);
  const closedAt = date(raw.closed_at ?? raw.closedAt) ?? (pullRequest.state === 'closed' ? terminalAt : null);
  const mergedAt = date(raw.merged_at ?? raw.mergedAt) ?? (pullRequest.state === 'merged' ? terminalAt : null);
  const headSha = sha(object(raw.head).sha ?? raw.sha ?? raw.headOid ?? object(object(raw.source).commit).hash ?? object(raw.lastMergeSourceCommit).commitId);
  const additions = count(raw.additions), deletions = count(raw.deletions), changedFiles = count(raw.changed_files ?? raw.changedFiles ?? raw.changedFilesCount);
  const mergeability = text(raw.mergeable_state ?? raw.detailed_merge_status ?? raw.merge_status ?? raw.mergeability, 100);
  return { pullRequest, observedAt, snapshot: { state: pullRequest.state, title: pullRequest.title, headBranch: pullRequest.head, baseBranch: pullRequest.base,
    isDraft: raw.draft === true || raw.isDraft === true || raw.work_in_progress === true || (provider === 'gitlab' || provider === 'forgejo') && /^(?:Draft|WIP):\s*/i.test(pullRequest.title), updatedAt, closedAt, mergedAt,
    ...(headSha ? { headSha } : {}), ...(login ? { author: { login, ...(avatarURL ? { avatarURL } : {}) } } : {}),
    ...(additions !== undefined ? { additions } : {}), ...(deletions !== undefined ? { deletions } : {}), ...(changedFiles !== undefined ? { changedFiles } : {}), ...(mergeability ? { mergeability } : {}) } };
}
export function summaryFromDetail(detail: ChangeRequestDetail, observedAt = Date.now()): ChangeRequestSummary {
  const value = summaryFromRaw(detail.pullRequest, { ...detail, draft: detail.isDraft, headOid: detail.headSha, author: { login: detail.author, avatarUrl: detail.authorAvatarURL } }, observedAt);
  if (detail.reviewDecision !== undefined) value.snapshot.reviewDecision = detail.reviewDecision;
  value.snapshot.mergeability = ['dirty', 'conflicting'].includes(detail.mergeability) ? 'conflicting' : ['mergeable', 'clean', 'blocked', 'behind', 'unstable', 'has_hooks', 'draft'].includes(detail.mergeability) ? 'mergeable' : 'unknown';
  if (detail.checksState !== undefined) value.snapshot.checksState = detail.checksState;
  return value;
}
export function supersedesSummary(current: Pick<ChangeRequestSummary, 'snapshot' | 'observedAt'> | undefined, next: Pick<ChangeRequestSummary, 'snapshot' | 'observedAt'>) {
  if (!current) return true;
  if (current.snapshot.state === 'merged' && next.snapshot.state !== 'merged') return false;
  if (next.snapshot.updatedAt !== current.snapshot.updatedAt) return (next.snapshot.updatedAt ?? '') > (current.snapshot.updatedAt ?? '');
  return next.observedAt >= current.observedAt;
}
export function changeRequestSyncKey(pr: TaskPullRequest): string {
  const u = new URL(pr.url);
  const azure = pr.provider === 'azure-devops' ? azureRepositoryIdentity(pr.url.replace(/\/pullrequest\/\d+\/?$/i, '')) : undefined;
  const repository = azure?.canonicalKey ?? pr.repository ?? u.pathname.replace(/\/(?:pull|pulls|pull-requests|pullrequest|(?:-\/)?merge_requests)\/\d+\/?$/, '').replace(/^\//, '');
  return JSON.stringify([pr.provider ?? (u.hostname === 'gitlab.com' ? 'gitlab' : u.hostname === 'bitbucket.org' ? 'bitbucket' : 'github'), (azure?.host ?? pr.host ?? u.host).toLowerCase(), repository.toLowerCase(), pr.number]);
}
export function siblingChangeRequest(pr: TaskPullRequest, layer: ChangeRequestStack['layers'][number], base: string): TaskPullRequest | undefined {
  const u = new URL(pr.url), path = u.pathname.replace(/\d+\/?$/, String(layer.number));
  if (path === u.pathname && layer.number !== pr.number) return;
  u.pathname = path;
  const { watch, endedWatch, ...reference } = pr;
  return { ...reference, number: layer.number, url: u.href, title: layer.title || `#${layer.number}`, head: layer.headBranch, base, state: layer.state, snapshot: undefined, linkedAt: new Date().toISOString(), linkSource: 'stack' };
}

/** Persistent cache decoding constructs a new allowlisted value rather than
 * trusting JSON objects from a previous service or schema version. */
export function decodeChangeRequestSummary(value: unknown): ChangeRequestSummary | undefined {
  const v = object(value), p = object(v.pullRequest), s = object(v.snapshot);
  if (!Number.isSafeInteger(p.number) || p.number < 1 || !text(p.url, 4096) || !text(p.title) || !text(p.head) || !text(p.base) || !['open', 'closed', 'merged'].includes(p.state)
    || !['github', 'gitlab', 'bitbucket', 'forgejo', 'gitcafe', 'azure-devops'].includes(p.provider) || !text(p.host) || !text(p.repository, 4096) || !Number.isFinite(v.observedAt)
    || s.state !== p.state || s.title !== p.title || s.headBranch !== p.head || s.baseBranch !== p.base || typeof s.isDraft !== 'boolean'
    || s.updatedAt !== null && date(s.updatedAt) === null || s.closedAt !== null && date(s.closedAt) === null || s.mergedAt !== null && date(s.mergedAt) === null) return;
  let u: URL; try { u = new URL(p.url); } catch { return; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) return;
  const pullRequest: TaskPullRequest = { number: p.number, url: p.url, title: p.title, state: p.state, base: p.base, head: p.head, provider: p.provider, host: p.host, repository: p.repository };
  const result: ChangeRequestSummary = { pullRequest, observedAt: v.observedAt, snapshot: { state: s.state, title: s.title, headBranch: s.headBranch, baseBranch: s.baseBranch, isDraft: s.isDraft, updatedAt: s.updatedAt, closedAt: s.closedAt, mergedAt: s.mergedAt } };
  if (sha(s.headSha)) result.snapshot.headSha = s.headSha;
  if (text(object(s.author).login, 256)) result.snapshot.author = { login: s.author.login, ...(avatar(s.author.avatarURL) ? { avatarURL: avatar(s.author.avatarURL) } : {}) };
  for (const key of ['additions', 'deletions', 'changedFiles'] as const) if (count(s[key]) !== undefined) result.snapshot[key] = s[key];
  for (const key of ['reviewDecision', 'checksState', 'mergeability'] as const) if (text(s[key], 100)) result.snapshot[key] = s[key];
  if (v.stack === null || Number.isSafeInteger(v.stack) && v.stack > 0) result.stack = v.stack;
  return result;
}
export function decodeCachedStack(value: unknown): ChangeRequestStack | null | undefined {
  if (value === null) return null;
  const v = object(value);
  if (!text(v.id) || !Number.isSafeInteger(v.number) || v.number < 1 || !text(v.url, 4096) || !text(v.base) || !Array.isArray(v.layers) || v.layers.length > 1000) return;
  const layers: ChangeRequestStack['layers'] = [];
  for (const raw of v.layers) {
    const l = object(raw); if (!Number.isSafeInteger(l.number) || l.number < 1 || !text(l.headBranch) || !['open', 'closed', 'merged'].includes(l.state) || l.headSha !== undefined && !sha(l.headSha)) return;
    layers.push({ number: l.number, headBranch: l.headBranch, state: l.state, ...(text(l.title) ? { title: l.title } : {}), ...(typeof l.isDraft === 'boolean' ? { isDraft: l.isDraft } : {}), ...(sha(l.headSha) ? { headSha: l.headSha } : {}) });
  }
  if (new Set(layers.map(l => l.number)).size !== layers.length) return;
  return { id: v.id, number: v.number, url: v.url, base: v.base, layers };
}

export function sameChangeRequestMetadata(left: unknown, right: unknown): boolean {
  const encode = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
  return encode(left) === encode(right);
}

export function taskPullRequestReading<T extends TaskPullRequest>(pullRequest: T, raw: unknown, observedAt = Date.now()): T {
  return { ...pullRequest, snapshot: { ...summaryFromRaw(pullRequest, raw, observedAt).snapshot, syncedAt: new Date(observedAt).toISOString() }, observedAt };
}

/** Open work wins over a terminal PR whose comments changed more recently. */
export function selectBranchPullRequest<T extends TaskPullRequest>(values: T[]): T | null {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => {
    if ((a.value.state === 'open') !== (b.value.state === 'open')) return a.value.state === 'open' ? -1 : 1;
    const left = a.value.snapshot?.updatedAt ?? '', right = b.value.snapshot?.updatedAt ?? '';
    return left === right ? a.index - b.index : right.localeCompare(left);
  });
  return ordered[0]?.value ?? null;
}
