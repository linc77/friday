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
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createHash } from 'node:crypto';
import type { Engine } from './engine.js';
import type { TaskPullRequest, WorkItem, Workspace } from './types.js';
import { WorkspaceDoc } from './state.js';
import { taskPullRequests } from './task-pull-requests.js';
import { changeRequestSyncKey } from './task-change-request-summary.js';
import { changeRequestRemotes } from './task-change-request-creation.js';
import { additionalChangeRequestURL } from './source-control-provider-identity.js';
import type { SourceControlRepository } from './task-change-requests.js';
import { pinTaskChangeRequest } from './task-change-requests.js';
import type { WatchActor } from './task-change-request-watch.js';

export type ChangeRequestLinkReceipt = { taskId: string; digest: string; revision: number; url: string; linked: boolean };
export class ChangeRequestLinksConflict extends Error { constructor(readonly revision: number) { super('PR／MR 关联已在其他设备修改，请重新加载后重试。'); } }
const key = (pr: TaskPullRequest) => { try { return changeRequestSyncKey(pr); } catch { return pr.url; } };
export function allTaskChangeRequestLinks(task: WorkItem): TaskPullRequest[] {
  const values: TaskPullRequest[] = [], seen = new Set<string>();
  for (const pr of [...task.changeRequests ?? [], ...(task.changeRequestLinksRevision === undefined ? [task.gitOperation, ...(task.gitOperations ?? []).slice().reverse()].flatMap(operation => operation?.pullRequest ? [operation.pullRequest] : []) : [])]) {
    const identity = key(pr); if (seen.has(identity)) continue; seen.add(identity); values.push(pr);
  }
  return values;
}
export function linkTaskChangeRequest(task: WorkItem, pr: TaskPullRequest, source: NonNullable<TaskPullRequest['linkSource']>, at: string) {
  const links = allTaskChangeRequestLinks(task), existing = links.find(value => key(value) === key(pr));
  if (existing && (!existing.dismissedAt && existing.linkSource !== 'stack-dismissed' || source === 'stack' || source === 'stack-dismissed')) return false;
  const next: TaskPullRequest = existing ? { ...existing, url: pr.url, linkSource: source, dismissedAt: undefined } : { ...pr, linkedAt: pr.linkedAt ?? at, linkSource: source };
  const branch = task.branchPullRequest;
  if (source === 'manual' && branch && !links.some(link => !link.dismissedAt && link.linkSource !== 'stack-dismissed') && !links.some(link => key(link) === key(branch)) && key(branch) !== key(next)) links.push({ ...branch, linkedAt: at, linkSource: 'manual' });
  task.changeRequests = [...links.filter(link => key(link) !== key(next)), next]; task.changeRequestLinksRevision = (task.changeRequestLinksRevision ?? 0) + 1;
  return true;
}
export function unlinkTaskChangeRequest(task: WorkItem, pr: TaskPullRequest, at: string) {
  const links = allTaskChangeRequestLinks(task), existing = links.find(link => key(link) === key(pr));
  if (!existing || existing.dismissedAt || existing.linkSource === 'stack-dismissed') return false;
  const sameRepo = (link: TaskPullRequest) => { try { const a = JSON.parse(key(link)), b = JSON.parse(key(pr)); return a.slice(0, 3).join('\0') === b.slice(0, 3).join('\0'); } catch { return false; } };
  const stacked = existing.linkSource === 'stack' || task.changeRequestStacks?.[existing.url] != null || links.some(link => sameRepo(link) && task.changeRequestStacks?.[link.url]?.layers.some(layer => layer.number === pr.number));
  const { watch, ...rest } = existing;
  task.changeRequests = stacked ? links.map(link => link === existing ? { ...rest, ...(watch ? { endedWatch: watch } : {}), linkSource: 'stack-dismissed', dismissedAt: at } : link) : links.filter(link => link !== existing);
  if (!stacked && task.changeRequestStacks) delete task.changeRequestStacks[existing.url];
  task.changeRequestLinksRevision = (task.changeRequestLinksRevision ?? 0) + 1;
  return true;
}

/** URLs and CLI-shaped references are data. Linking stores only a reference;
 * authentication and host reads belong to the existing background read lane. */
export function parseChangeRequestLink(raw: unknown): TaskPullRequest | undefined {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) return;
  let u: URL; try { u = new URL(raw.trim()); } catch { return; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return;
  const match = /^\/(.+)\/(pull|pulls|pull-requests|pullrequest|-\/merge_requests)\/([1-9]\d*)(?:\/|$)/i.exec(u.pathname);
  if (!match || !Number.isSafeInteger(Number(match[3]))) return;
  const provider = match[2] === 'pull' ? 'github' : match[2] === '-/merge_requests' ? 'gitlab' : match[2] === 'pull-requests' ? 'bitbucket' : match[2] === 'pullrequest' ? 'azure-devops' : ['git.cafe', 'staging.git.cafe'].includes(u.hostname.toLowerCase()) ? 'gitcafe' : 'forgejo';
  if (provider !== 'forgejo' && u.protocol !== 'https:' || provider === 'bitbucket' && u.hostname !== 'bitbucket.org' || provider === 'azure-devops' && u.hostname !== 'dev.azure.com' && !u.hostname.endsWith('.visualstudio.com')) return;
  if (['github', 'bitbucket', 'gitcafe'].includes(provider) && match[1]!.split('/').length !== 2) return;
  const number = Number(match[3]); u.pathname = `/${match[1]}/${match[2]}/${number}`; u.search = ''; u.hash = '';
  return { number, url: u.href, provider, host: u.host.toLowerCase(), repository: match[1], state: 'open', title: '#' + number, head: '', base: '' };
}
const repositoryURL = (r: SourceControlRepository, number: number) => r.additional ? additionalChangeRequestURL(r.additional, number) : `https://${r.host}/${r.path}/${r.provider === 'github' ? 'pull' : r.provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/${number}`;

export class TaskChangeRequestLinks {
  private readonly views = new Map<string, { pr: TaskPullRequest; fingerprint: string; expires: number }>();
  constructor(private readonly engine: Engine) {}
  view(id: string, url: string) {
    const key = id + '\0' + url, value = this.views.get(key);
    if (value && value.expires > Date.now()) { value.expires = Date.now() + 30 * 60_000; return value; }
    this.views.delete(key); return undefined;
  }
  async open(id: string, raw: unknown, signal?: AbortSignal, expectedFingerprint?: string) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'reference')) throw new Error('PR／MR 查看请求无效');
    const pr = await this.reference(id, (raw as Record<string, unknown>).reference, signal), u = new URL(pr.url);
    const repository = await this.engine.sourceControl.repository(this.engine.directory, u.origin + '/' + pr.repository, signal);
    if (!repository || repository.provider !== pr.provider) throw new Error('请先配置此平台主机，再查看 PR／MR');
    const pinned = await pinTaskChangeRequest(this.engine.directory, repository, this.engine.sourceControl, signal, expectedFingerprint);
    const key = id + '\0' + pr.url; this.views.delete(key); this.views.set(key, { pr, fingerprint: pinned.fingerprint, expires: Date.now() + 30 * 60_000 });
    while (this.views.size > 128) this.views.delete(this.views.keys().next().value!);
    return { url: pr.url };
  }
  close() { this.views.clear(); }
  async targetReference(id: string, input: { url?: string; repository?: string; number?: number; host?: string }, signal?: AbortSignal) {
    if (input.url) return this.reference(id, input.url, signal);
    if (!input.repository || !Number.isSafeInteger(input.number) || input.number! <= 0 || /[\x00-\x20\x7f?#@]/.test(input.repository) || input.repository.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('请提供 PR／MR 地址，或仓库路径与编号');
    const current = input.host ? undefined : await this.reference(id, '#' + input.number, signal);
    const authority = input.host ?? new URL(current!.url).host;
    if (/[\x00-\x20\x7f/?#@]/.test(authority)) throw new Error('平台主机无效');
    const origin = current ? new URL(current.url).origin : 'https://' + authority;
    const repository = await this.engine.sourceControl.repository(this.engine.directory, origin + '/' + input.repository, signal);
    if (!repository) throw new Error('请提供完整地址或先配置此平台主机');
    return this.reference(id, repositoryURL(repository, input.number!), signal);
  }
  async list(id: string) { const task = await this.task(id); return { revision: task.changeRequestLinksRevision ?? 0, links: taskPullRequests(task), branch: task.branchPullRequest ?? null }; }
  private async task(id: string, writable = false) { const task = (await this.engine.snapshot()).tasks.find(task => task.id === id); if (!task || task.agent === 'friday' || writable && task.subagentOrigin) throw new Error('本地任务不存在或由父任务管理'); return task; }
  async reference(id: string, raw: unknown, signal?: AbortSignal) {
    const task = await this.task(id);
    if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('PR／MR 地址或编号无效');
    let value = raw.trim();
    value = /^(?:gh pr checkout|glab mr checkout|fj pr checkout|tea pr checkout|cafe pr checkout)\s+(\S+)$/.exec(value)?.[1] ?? /^az repos pr checkout --id\s+(\d+)$/.exec(value)?.[1] ?? value;
    const full = parseChangeRequestLink(value); if (full) return full;
    if (!/^#?[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value.replace('#', '')))) throw new Error('请输入 PR／MR 地址、编号或 checkout 命令');
    const state = await this.engine.snapshot(), project = state.projects.find(project => project.id === task.projectId);
    if (!project) throw new Error('请粘贴完整地址，以关联其他仓库的 PR／MR');
    const remotes = await changeRequestRemotes(project.path, this.engine.sourceControl); signal?.throwIfAborted();
    const repository = remotes.find(remote => remote.resolved === 'base' && remote.repository)?.repository ?? remotes.find(remote => remote.name === 'origin' && remote.repository)?.repository ?? remotes.find(remote => remote.repository)?.repository;
    if (!repository) throw new Error('此 Workspace 没有可识别的平台远端，请粘贴完整地址');
    const number = Number(value.replace('#', '')), pr = parseChangeRequestLink(repositoryURL(repository, number)); if (!pr) throw new Error('无法确认 PR／MR 地址'); return pr;
  }
  async change(id: string, raw: unknown, linked: boolean, signal?: AbortSignal, actor?: WatchActor) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PR／MR 关联请求无效');
    const v = raw as Record<string, unknown>;
    if (Object.keys(v).some(field => !['requestId', 'reference', 'expectedRevision'].includes(field)) || typeof v.requestId !== 'string' || !/^[\w-]{1,128}$/.test(v.requestId) || ['__proto__', 'constructor', 'prototype'].includes(v.requestId)
      || !Number.isSafeInteger(v.expectedRevision) || Number(v.expectedRevision) < 0 || typeof v.reference !== 'string' || v.reference.length > 4096) throw new Error('PR／MR 关联请求无效');
    await this.task(id, true);
    const intent = [id, linked, v.reference, v.expectedRevision];
    const digest = createHash('sha256').update(JSON.stringify(actor ? [...intent, actor] : intent)).digest('hex');
    const receipt = (state: Workspace) => { const found = state.changeRequestLinkRequests?.[v.requestId as string]; if (found && found.digest !== digest) throw new Error('关联请求 ID 已用于不同操作'); return found; };
    const previous = receipt(await this.engine.snapshot()); if (previous) return { url: previous.url, linked: previous.linked, revision: previous.revision };
    const task = await this.task(id), scope = task.projectId && (await this.engine.snapshot()).projects.find(p => p.id === task.projectId), pr = await this.reference(id, v.reference, signal);
    signal?.throwIfAborted();
    return this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), saved = receipt(state); if (saved) return { url: saved.url, linked: saved.linked, revision: saved.revision };
      const work = state.tasks.find(task => task.id === id); if (!work || work.subagentOrigin || work.projectId !== task.projectId || scope && state.projects.find(p => p.id === scope.id)?.path !== scope.path) throw new Error('任务或 Workspace 已改变，请重新加载');
      if (actor && (work.currentRunId !== actor.runId || work.lastStoppedRunId === actor.runId || work.cwd !== actor.cwd || work.projectId !== actor.projectId || !['queued','running','waiting'].includes(work.status))) throw new Error('Agent 轮次已结束或任务范围已改变');
      if ((work.changeRequestLinksRevision ?? 0) !== v.expectedRevision) throw new ChangeRequestLinksConflict(work.changeRequestLinksRevision ?? 0);
      const at = new Date().toISOString();
      const changed = linked ? linkTaskChangeRequest(work, pr, actor ? 'agent' : 'manual', at) : unlinkTaskChangeRequest(work, pr, at);
      if (changed) work.updatedAt = at;
      const result = { url: pr.url, linked, revision: work.changeRequestLinksRevision ?? 0 };
      state.changeRequestLinkRequests ??= {}; state.changeRequestLinkRequests[v.requestId as string] = { taskId: id, digest, ...result }; state.revision++;
      return result;
    }, context).then(result => { if (linked) this.engine.changeRequestSync.request(id, result.url); this.engine.taskSettlement.notify(); return result; });
  }
}
