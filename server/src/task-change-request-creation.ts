/*
Adapted from T3 Code 8cd9641f GitManager branch-head and repository context resolution.
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
// Source / target / tracking semantics follow T3 Code 8cd9641f's GitManager.
import { createHash } from 'node:crypto';
import { taskGit } from './git-process.js';
import type { TaskGitStatus } from './task-git-status.js';
import type { SourceControlConnections } from './source-control-connections.js';
import { pinTaskChangeRequest, sourceControlRepository, taskRepositoryDefaultBranch, type SourceControlRepository } from './task-change-requests.js';
export type ChangeRequestCreationSelection = { targetRemote?: string; baseBranch?: string; fingerprint?: string };
export type ChangeRequestCreationContext = {
  source: SourceControlRepository; target: SourceControlRepository; sourceRemote: string; targetRemote: string | null;
  sourceRemoteFingerprint: string; targetRemoteFingerprint?: string; sourceBranch: string; baseBranch: string;
  isCrossRepository: boolean; baseWasExplicit: boolean; fingerprint: string; credentialFingerprint: string;
  sourceProjectID?: number; targetProjectID?: number;
  choices: { name: string; repository: string }[];
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const value = async (cwd: string, key: string, all = false) => { const result = await taskGit(cwd, ['config', all ? '--get-all' : '--get', key], { allowFailure: true }); return result.code === 0 ? result.stdout.trim() : undefined; };
export function creationSelection(raw: unknown): ChangeRequestCreationSelection | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PR／MR 目标选择无效');
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some(k => !['targetRemote', 'baseBranch', 'fingerprint'].includes(k))) throw new Error('PR／MR 目标选择无效');
  for (const key of ['targetRemote', 'baseBranch']) if (v[key] !== undefined && (typeof v[key] !== 'string' || !v[key] || (v[key] as string).length > 1024 || /[\x00-\x1f\x7f]/.test(v[key] as string))) throw new Error('PR／MR 目标选择无效');
  if (v.fingerprint !== undefined && (typeof v.fingerprint !== 'string' || !/^[a-f\d]{64}$/.test(v.fingerprint))) throw new Error('PR／MR 目标版本无效');
  return v as ChangeRequestCreationSelection;
}
export async function changeRequestRemotes(cwd: string, connections: Pick<SourceControlConnections, 'githubHosts'> & Partial<Pick<SourceControlConnections, 'gitlabHosts' | 'repository'>>) {
  const names = (await taskGit(cwd, ['remote'])).stdout.trim().split('\n').filter(Boolean);
  const [hosts, labs] = await Promise.all([connections.githubHosts(cwd, undefined, false), connections.gitlabHosts?.(cwd, undefined, false) ?? Promise.resolve([])]);
  return Promise.all(names.map(async name => {
    const [url, push, actual, pushed, resolved] = await Promise.all([
      value(cwd, `remote.${name}.url`, true), value(cwd, `remote.${name}.pushurl`, true),
      taskGit(cwd, ['remote', 'get-url', '--all', name]), taskGit(cwd, ['remote', 'get-url', '--push', '--all', name]), value(cwd, `remote.${name}.gh-resolved`),
    ]);
    let repository = url ? sourceControlRepository(url.split('\n')[0], hosts, labs) : undefined;
    if (!repository && url && connections.repository) repository = await connections.repository(cwd, url.split('\n')[0]);
    if (!repository && url && /^(?:https?|ssh|git):\/\/|^[^\s/@]+@[\w.-]+:/.test(url) && connections.gitlabHosts) repository = sourceControlRepository(url.split('\n')[0], hosts, await connections.gitlabHosts(cwd));
    const pushRepository = push ? connections.repository ? await connections.repository(cwd, push.split('\n')[0]) : sourceControlRepository(push.split('\n')[0], hosts, repository?.provider === 'gitlab' ? [...labs, repository.host] : labs) : repository;
    // A local mirror or Git transport alias may have no platform identity.
    // Keep the configured fetch repository as authority, as before; the exact
    // fetch/push configuration remains part of the confirmation fingerprint.
    return { name, repository, pushRepository: pushRepository ?? repository,
      fingerprint: hash([url, push, actual.stdout, pushed.stdout]), resolved };
  }));
}
export async function resolveCreationContext(cwd: string, review: TaskGitStatus, connections: SourceControlConnections, selection: ChangeRequestCreationSelection = {}, signal?: AbortSignal): Promise<ChangeRequestCreationContext> {
  if (review.status !== 'repository' || !review.branch || !review.remote || !review.sourceControl) throw new Error('创建 PR／MR 需要本地分支和受支持的远端仓库');
  const list = await changeRequestRemotes(cwd, connections), configured = await value(cwd, `branch.${review.branch}.remote`);
  const preferred = await value(cwd, `branch.${review.branch}.pushRemote`) ?? await value(cwd, 'remote.pushDefault') ?? configured;
  const source = list.find(r => r.name === preferred && r.pushRepository) ?? list.find(r => r.name === review.remote && r.pushRepository);
  if (!source?.pushRepository) throw new Error('无法确认要推送的源仓库');
  const sourceRepository = source.pushRepository;
  const choices = list.filter(r => r.repository?.provider === sourceRepository.provider && r.repository.host === sourceRepository.host && (!sourceRepository.additional || r.repository.additional?.apiBase === sourceRepository.additional.apiBase));
  let target = selection.targetRemote ? choices.find(r => r.name === selection.targetRemote) : choices.find(r => r.resolved === 'base') ?? choices.find(r => r.name === 'origin') ?? choices.find(r => r.name === review.remote);
  if (selection.targetRemote && !target) throw new Error('所选目标远端不属于当前平台和主机');
  let targetRepository = target?.repository;
  const hint = sourceRepository.provider === 'github' && !selection.targetRemote ? connections.githubRepositoryHint() : undefined;
  if (hint) {
    const parts = hint.split('/');
    const hinted = sourceControlRepository(hint.includes('://') ? hint : `https://${parts.length === 3 ? parts.shift() : sourceRepository.host}/${parts.join('/')}`, [sourceRepository.host]);
    if (!hinted || hinted.host !== sourceRepository.host || hinted.provider !== sourceRepository.provider) throw new Error('GH_REPO 与源仓库的平台或主机不一致');
    targetRepository = hinted; target = choices.find(r => r.repository?.path.toLowerCase() === hinted.path.toLowerCase());
  }
  if (!targetRepository) throw new Error('无法确认 PR／MR 的目标仓库');
  const pinned = await pinTaskChangeRequest(cwd, targetRepository, connections, signal);
  let branch = review.branch;
  const merge = await value(cwd, `branch.${review.branch}.merge`);
  if (source.name === configured && merge?.startsWith('refs/heads/')) branch = merge.slice('refs/heads/'.length);
  const baseBranch = selection.baseBranch ?? (target?.name === review.remote ? review.defaultBranch : undefined) ?? await taskRepositoryDefaultBranch(pinned, targetRepository, signal);
  if (!baseBranch) throw new Error('平台没有返回目标仓库的默认分支，请选择目标分支');
  for (const ref of [branch, baseBranch]) { await taskGit(cwd, ['check-ref-format', '--branch', ref], { signal }); if (ref.startsWith('+') || ref.includes(':')) throw new Error('PR／MR 分支名称无效'); }
  const isCrossRepository = sourceRepository.path.toLowerCase() !== targetRepository.path.toLowerCase();
  let projectIDs: { sourceProjectID?: number; targetProjectID?: number } = {};
  if (isCrossRepository && sourceRepository.provider === 'gitlab') {
    const [a, b] = await Promise.all([pinned.json(`projects/${encodeURIComponent(sourceRepository.path)}`, { signal }), pinned.json(`projects/${encodeURIComponent(targetRepository.path)}`, { signal })]);
    if (!Number.isSafeInteger(a.id) || Number(a.id) < 1 || !Number.isSafeInteger(b.id) || Number(b.id) < 1) throw new Error('无法确认 GitLab 源项目和目标项目');
    projectIDs = { sourceProjectID: a.id as number, targetProjectID: b.id as number };
  }
  const fingerprint = hash([review.fingerprint, sourceRepository, source.name, source.fingerprint, targetRepository, target?.name, target?.fingerprint, branch, baseBranch, projectIDs, pinned.fingerprint]);
  if (selection.fingerprint && selection.fingerprint !== fingerprint) throw new Error('PR／MR 源或目标已经改变，请刷新后重新确认');
  return { source: sourceRepository, target: targetRepository, sourceRemote: source.name, targetRemote: target?.name ?? null,
    sourceRemoteFingerprint: source.fingerprint, ...(target ? { targetRemoteFingerprint: target.fingerprint } : {}), sourceBranch: branch, baseBranch, isCrossRepository, baseWasExplicit: selection.baseBranch !== undefined, fingerprint, credentialFingerprint: pinned.fingerprint, ...projectIDs,
    choices: choices.map(r => ({ name: r.name, repository: r.repository!.path })) };
}
export async function verifyCreationRemotes(cwd: string, context: ChangeRequestCreationContext, connections: SourceControlConnections) {
  const list = await changeRequestRemotes(cwd, connections);
  if (!list.some(r => r.name === context.sourceRemote && r.fingerprint === context.sourceRemoteFingerprint)
    || context.targetRemote && !list.some(r => r.name === context.targetRemote && r.fingerprint === context.targetRemoteFingerprint)) throw new Error('PR／MR 远端配置已改变，请重新确认源和目标');
}
