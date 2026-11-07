/*
Adapted from T3 Code 8cd9641f GitManager.preparePullRequestThread and GitHubSourceControlProvider.checkoutPullRequest.
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
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { taskGit } from './git-process.js';
import { changeRequestRemotes } from './task-change-request-creation.js';
import { normalizeTaskChangeRequest, pinTaskChangeRequest, sourceControlRepository, sourceControlRepositoryOnHost, taskRepositoryDefaultBranch, type SourceControlRepository } from './task-change-requests.js';
import type { PinnedSourceControlConnection, SourceControlConnections } from './source-control-connections.js';
import type { ChangeRequestCheckoutPreview } from './task-change-request-checkout-types.js';
import type { TaskWorkspacePlan } from './types.js';
import { containsDirectory } from './branch-switch.js';
import { privateWorkspacePaths } from './workspace-privacy.js';
import { additionalChangeRequestNumber } from './source-control-provider-identity.js';
import {verifyManagedProjectFolder, type ManagedProjectFolder} from './managed-project-folders.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const obj = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const git = async (cwd: string, args: string[], signal?: AbortSignal) => (await taskGit(cwd, args, { signal })).stdout.trim();
const optionalGit = async (cwd: string, args: string[], signal?: AbortSignal) => { const result = await taskGit(cwd, args, { signal, allowFailure: true }); return result.code === 0 ? result.stdout.trim() : undefined; };
const same = (a: SourceControlRepository, b: SourceControlRepository) => a.host === b.host && a.provider === b.provider && a.path.toLowerCase() === b.path.toLowerCase();
export type CheckoutAuthority = { sourcePath: string; sourceRoot: string; common: string; remoteName: string; remoteFingerprint: string; repository: SourceControlRepository; credentialFingerprint: string; projectFolder?:ManagedProjectFolder };
export type CheckoutResolution = ChangeRequestCheckoutPreview & { authority: CheckoutAuthority };
export type CheckoutGitPlan = { root: string; cwd: string; branch: string; reused: boolean; preserve: boolean; originalHead?: string; oldUpstream?: string; mode: 'checkout' | 'worktree' };

// Pasted CLI commands are input syntax only. No shell is involved.
export function checkoutReference(raw: unknown, repository: SourceControlRepository): { repository: SourceControlRepository; number: number } {
  if (repository.additional) return { repository, number: additionalChangeRequestNumber(repository.additional, raw) };
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f\x7f]/.test(raw)) throw new Error('PR／MR 地址或编号无效');
  let text = raw.trim();
  const command = text.match(/^(?:gh pr checkout|glab mr checkout)\s+(\S+)$/);
  if (command) text = command[1];
  if (/^#?\d+$/.test(text)) { const number = Number(text.replace('#', '')); if (Number.isSafeInteger(number) && number > 0) return { repository, number }; }
  let url: URL; try { url = new URL(text); } catch { throw new Error('请输入 PR／MR 地址、编号或 checkout 命令'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.host !== repository.host || url.search || url.hash) throw new Error('PR／MR 地址必须属于当前 Workspace 的平台和主机');
  const suffix = repository.provider === 'github' ? 'pull' : repository.provider === 'gitlab' ? '-/merge_requests' : 'pull-requests';
  const match = url.pathname.match(new RegExp('^/(.+)/' + suffix + '/([1-9][0-9]*)/?$'));
  const target = match && sourceControlRepositoryOnHost('https://' + repository.host + '/' + match[1], repository);
  if (!target || target.provider !== repository.provider || !Number.isSafeInteger(Number(match![2]))) throw new Error('PR／MR 地址与当前平台不一致');
  return { repository: target, number: Number(match![2]) };
}
export async function checkoutIdentity(sourcePath: string, connections: SourceControlConnections, directory: string, signal?: AbortSignal, projectFolder?:ManagedProjectFolder) {
  const cwd = await realpath(sourcePath); if ((await privateWorkspacePaths(cwd, {directory,projectFolder})).includes('')) throw new Error('不能使用 Friday 私有数据目录作为 Workspace');
  const sourceRoot = await realpath(await git(cwd, ['rev-parse', '--show-toplevel'], signal));
  const common = await realpath(await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal));
  if (containsDirectory(await realpath(directory), common)) {
    if(!projectFolder)throw new Error('不能使用 Friday 私有数据中的 Git 仓库');
    await verifyManagedProjectFolder(projectFolder,directory);if(common!==join(projectFolder.root,'.git'))throw new Error('托管项目的 Git 仓库关联已经改变');
  }
  const remotes = await changeRequestRemotes(cwd, connections);
  const remote = remotes.find(v => v.resolved === 'base' && v.repository) ?? remotes.find(v => v.name === 'origin' && v.repository) ?? remotes.find(v => v.repository);
  if (!remote?.repository) throw new Error('当前 Workspace 没有受支持的平台远端');
  return { cwd, sourceRoot, common, remote, remotes };
}
export async function resolveCheckout(sourcePath: string, reference: unknown, connections: SourceControlConnections, directory: string, signal?: AbortSignal, projectFolder?:ManagedProjectFolder): Promise<CheckoutResolution> {
  const identity = await checkoutIdentity(sourcePath, connections, directory, signal, projectFolder);
  let repository = identity.remote.repository!;
  const hint = repository.provider === 'github' && connections.githubRepositoryHint();
  if (hint) {
    const parts = hint.split('/'); const hinted = sourceControlRepository(hint.includes('://') ? hint : 'https://' + (parts.length === 3 ? parts.shift() : repository.host) + '/' + parts.join('/'), [repository.host]);
    if (!hinted || hinted.host !== repository.host || hinted.provider !== repository.provider) throw new Error('GH_REPO 与 Workspace 的主机不一致'); repository = hinted;
  }
  const target = checkoutReference(reference, repository); repository = target.repository;
  const pinned = await pinTaskChangeRequest(identity.cwd, repository, connections, signal);
  const additional = pinned.additional ? await pinned.additional.checkout(target.number, signal) : undefined;
  const path = repository.provider === 'github' ? `repos/${repository.path}/pulls/${target.number}` : repository.provider === 'gitlab' ? `projects/${encodeURIComponent(repository.path)}/merge_requests/${target.number}` : `repositories/${repository.path}/pullrequests/${target.number}`;
  const raw = additional ? {} : await pinned.json(path, { signal }); const pullRequest = additional?.pullRequest ?? normalizeTaskChangeRequest(repository, raw);
  let source: unknown, sha: unknown, owner: unknown;
  if (repository.provider === 'github') { source = obj(obj(raw.head).repo).full_name; sha = obj(raw.head).sha; owner = obj(obj(raw.head).repo).owner ? obj(obj(obj(raw.head).repo).owner).login : obj(obj(raw.head).user).login; }
  else if (repository.provider === 'gitlab') {
    sha = raw.sha ?? obj(raw.diff_refs).head_sha;
    if (Number.isSafeInteger(raw.source_project_id) && Number(raw.source_project_id) > 0) { const project = await pinned.json('projects/' + raw.source_project_id, { signal }); source = project.path_with_namespace; }
  } else { source = obj(obj(raw.source).repository).full_name; sha = obj(obj(raw.source).commit).hash; }
  const headRepository = additional?.source ? sourceControlRepositoryOnHost(additional.source.webURL, { provider: additional.source.provider, host: additional.source.host, additional: additional.source }) ?? null : additional ? null : typeof source === 'string' ? sourceControlRepositoryOnHost('https://' + repository.host + '/' + source, repository) ?? null : null;
  if (additional) sha = additional.headSha;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(sha) || headRepository && headRepository.provider !== repository.provider) throw new Error('平台返回的 PR／MR 源提交或仓库无效');
  await git(identity.cwd, ['check-ref-format', '--branch', pullRequest.head], signal);
  const cross = !headRepository || !same(headRepository, repository);
  const defaultBranch = cross ? await taskRepositoryDefaultBranch(pinned, repository, signal) : undefined;
  if (cross && !defaultBranch) throw new Error('无法确认目标仓库默认分支，不能安全命名 Fork 分支');
  const prefix = typeof owner === 'string' && /^[\w.-]+$/.test(owner) ? owner : headRepository?.owner.split('/').at(-1) ?? 'pr-' + target.number;
  let localBranch = cross && pullRequest.head === defaultBranch ? prefix + '/' + pullRequest.head : pullRequest.head;
  const worktreeBranch = cross ? `linc/pr-${target.number}/${pullRequest.head.replace(/[^A-Za-z0-9._/-]/g, '-').replace(/\.\.|@\{|\/\/|\.lock(?:\/|$)/g, '-').replace(/^[/.-]+|[/.-]+$/g, '') || 'head'}` : pullRequest.head;
  if (repository.provider === 'bitbucket' && cross) localBranch = worktreeBranch;
  if (repository.provider === 'gitcafe' && cross) localBranch = `pr-${target.number}/${pullRequest.head}`;
  for (const branch of [localBranch, worktreeBranch]) await git(identity.cwd, ['check-ref-format', '--branch', branch], signal);
  const local = await checkoutLocalState(identity.cwd, signal);
  const authority: CheckoutAuthority = { sourcePath: identity.cwd, sourceRoot: identity.sourceRoot, common: identity.common, remoteName: identity.remote.name, remoteFingerprint: identity.remote.fingerprint, repository, credentialFingerprint: pinned.fingerprint, ...(projectFolder?{projectFolder}:{}) };
  return { authority, pullRequest, headSha: sha, headRepository, localBranch, worktreeBranch, dirty: local.dirty,
    fingerprint: hash([authority, sha, pullRequest.head, headRepository, localBranch, worktreeBranch]), localFingerprint: local.fingerprint };
}
export async function checkoutLocalState(cwd: string, signal?: AbortSignal) {
  const [dirtyText, head, branch, diff, stagedDiff, branches] = await Promise.all([
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal), git(cwd, ['rev-parse', 'HEAD'], signal),
    optionalGit(cwd, ['symbolic-ref', '-q', 'HEAD'], signal), taskGit(cwd, ['diff', 'HEAD', '--binary'], { signal, hashOutput: true }), taskGit(cwd, ['diff', '--cached', '--binary'], { signal, hashOutput: true }), git(cwd, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads/'], signal),
  ]);
  return { dirty: !!dirtyText, fingerprint: hash([head, branch, dirtyText, diff.digest, stagedDiff.digest, branches]) };
}
export async function verifyCheckoutAuthority(authority: CheckoutAuthority, connections: SourceControlConnections, directory: string, signal?: AbortSignal) {
  const identity = await checkoutIdentity(authority.sourcePath, connections, directory, signal,authority.projectFolder);
  if (identity.sourceRoot !== authority.sourceRoot || identity.common !== authority.common || !identity.remotes.some(v => v.name === authority.remoteName && v.fingerprint === authority.remoteFingerprint)) throw new Error('Workspace 或远端关联已经改变，请重新确认');
  return pinTaskChangeRequest(identity.cwd, authority.repository, connections, signal, authority.credentialFingerprint);
}
export async function checkoutGitPlan(resolution: CheckoutResolution, mode: 'checkout' | 'worktree', directory: string, id: string): Promise<CheckoutGitPlan> {
  const a = resolution.authority, branch = mode === 'checkout' ? resolution.localBranch : resolution.worktreeBranch;
  const records = (await git(a.sourcePath, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0').map(record => {
    const lines = record.split('\0'); return { root: lines.find(v => v.startsWith('worktree '))?.slice(9), branch: lines.find(v => v.startsWith('branch refs/heads/'))?.slice(18) };
  });
  let existing = records.find(v => v.branch === branch);
  if (mode === 'checkout' && existing && await realpath(existing.root!) !== a.sourceRoot) throw new Error('PR／MR 分支已在另一个 Worktree 中使用，请选择 Worktree');
  if (mode === 'worktree' && !existing) existing = records.find(v => v.branch === resolution.pullRequest.head && v.root && v.root !== a.sourceRoot);
  if (mode === 'worktree' && existing?.root && await realpath(existing.root) === a.sourceRoot) throw new Error('PR／MR 分支正在当前目录使用，请选择当前目录或先切换分支');
  const root = mode === 'checkout' ? a.sourceRoot : existing?.root ? await realpath(existing.root) : join(await realpath(directory), 'worktrees', id);
  const actualBranch = mode === 'worktree' && existing?.branch ? existing.branch : branch;
  const originalHead = await optionalGit(a.sourcePath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${actualBranch}^{commit}`]);
  const oldUpstream = await optionalGit(a.sourcePath, ['rev-parse', '--verify', '--end-of-options', `${actualBranch}@{upstream}^{commit}`]);
  const suffix = relative(a.sourceRoot, a.sourcePath);
  return { root, cwd: join(root, suffix), branch: actualBranch, reused: !!existing, preserve: mode === 'worktree' && actualBranch !== branch, ...(originalHead ? { originalHead } : {}), ...(oldUpstream ? { oldUpstream } : {}), mode };
}
export async function inspectCheckout(resolution: CheckoutResolution, plan: CheckoutGitPlan, directory: string, recovered = false): Promise<{ plan: TaskWorkspacePlan; reused: boolean; isOnHead: boolean; moved: boolean }> {
  if (await realpath(plan.root) !== plan.root || !containsDirectory(plan.root, await realpath(plan.cwd)) || !(await stat(plan.cwd)).isDirectory()) throw new Error('PR／MR 执行目录关联已改变');
  const common = await realpath(await git(plan.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const branch = await git(plan.root, ['symbolic-ref', '--short', 'HEAD']); const commit = await git(plan.root, ['rev-parse', 'HEAD']);
  if (common !== resolution.authority.common || branch !== plan.branch) throw new Error('PR／MR 分支或 Worktree 关联已改变');
  if (recovered && commit !== resolution.headSha && !(plan.mode === 'worktree' && (plan.reused || plan.preserve) && commit === plan.originalHead)) throw new Error('准备结果未确认，请核对目录后重新准备；不会自动重复检出');
  const managed = containsDirectory(join(await realpath(directory), 'worktrees'), plan.root);
  return { plan: { mode: managed ? 'worktree' : 'checkout', sourcePath: resolution.authority.sourcePath, root: plan.root, cwd: plan.cwd, branch: 'refs/heads/' + branch, commit, ...(managed ? { targetBranch: branch, reuseBranch: true } : {}), ...(resolution.authority.projectFolder?{projectFolder:resolution.authority.projectFolder}:{}), state: 'ready' }, reused: plan.reused, isOnHead: commit === resolution.headSha, moved: commit !== plan.originalHead };
}
async function checkoutTransport(cwd: string, authority: CheckoutAuthority, repository: SourceControlRepository, signal?: AbortSignal) {
  const policy = { githubHosts: async () => repository.provider === 'github' ? [repository.host] : [], gitlabHosts: async () => repository.provider === 'gitlab' ? [repository.host] : [], repository: async (_:string,remote:string) => sourceControlRepositoryOnHost(remote, repository) };
  const remotes = await changeRequestRemotes(cwd, policy);
  const match = remotes.find(v => v.repository && same(v.repository, repository));
  if (match) return { address: match.name, remote: match.name };
  const configured = (await optionalGit(cwd, ['config', '--get', 'remote.' + authority.remoteName + '.url'], signal))?.split('\n')[0];
  if (configured?.startsWith('ssh://')) {
    const url = new URL(configured); if (url.password) throw new Error('SSH 远端格式无效'); if (repository.provider === 'azure-devops') return {address:repository.additional!.webURL}; url.pathname = '/' + (repository.additional?.repository ?? repository.path) + '.git'; return { address: url.toString() };
  }
  if (configured && /^(?:[^\s@]+@)?[\w.-]+:/.test(configured) && !configured.includes('://') && repository.provider !== 'azure-devops') return { address: configured.slice(0, configured.indexOf(':') + 1) + (repository.additional?.repository ?? repository.path) + '.git' };
  return { address: repository.additional ? repository.additional.webURL + (repository.provider === 'azure-devops' ? '' : '.git') : `https://${repository.host}/${repository.path}.git` };
}
export async function performCheckout(resolution: CheckoutResolution, plan: CheckoutGitPlan, pinned: PinnedSourceControlConnection, id: string, force: boolean, signal?: AbortSignal) {
  const a = resolution.authority, cwd = a.sourcePath, ref = `refs/friday/pr-checkout/${id}/head`;
  if (plan.preserve) return;
  let upstream: string | undefined;
  try {
    const repository = resolution.headRepository;
    const fetch = async (repo: SourceControlRepository, remoteRef: string) => {
      const address = pinned.repositoryGit ? `https://${repo.host}/${repo.path}.git` : (await checkoutTransport(cwd, a, repo, signal)).address;
      const args = ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', address, `+${remoteRef}:${ref}`];
      return pinned.repositoryGit ? pinned.repositoryGit(cwd, repo.path, args, { signal, allowFailure: true }) : taskGit(cwd, args, { signal, allowFailure: true, timeout: 120_000 });
    };
    let fetched = repository ? await fetch(repository, 'refs/heads/' + resolution.pullRequest.head) : undefined;
    if (!fetched || fetched.code !== 0) {
      if (['bitbucket','gitcafe','azure-devops'].includes(a.repository.provider)) throw new Error('无法获取 PR 源分支，此平台没有可用的 PR 备用引用');
      const fallback = a.repository.provider === 'github' || a.repository.provider === 'forgejo' ? `refs/pull/${resolution.pullRequest.number}/head` : `refs/merge-requests/${resolution.pullRequest.number}/head`;
      fetched = await fetch(a.repository, fallback);
      if (fetched.code !== 0) throw new Error('无法获取 PR／MR 源提交，请检查访问权限');
    } else if (repository) {
      const remotes = await changeRequestRemotes(cwd, { githubHosts: async () => repository.provider === 'github' ? [repository.host] : [], gitlabHosts: async () => repository.provider === 'gitlab' ? [repository.host] : [], repository: async (_:string,remote:string) => sourceControlRepositoryOnHost(remote, repository) });
      let remote = remotes.find(v => v.repository && same(v.repository, repository))?.name;
      if (!remote) {
        const prefix = repository.owner.split('/').at(-1)!.replace(/[^\w.-]/g, '-') || 'fork'; remote = prefix;
        for (let suffix = 2; remotes.some(v => v.name === remote); suffix++) remote = prefix + '-' + suffix;
        const transport = await checkoutTransport(cwd, a, repository, signal);
        await git(cwd, ['remote', 'add', remote, transport.address], signal);
      }
      upstream = remote + '/' + resolution.pullRequest.head;
    }
    if (await git(cwd, ['rev-parse', '--verify', ref + '^{commit}'], signal) !== resolution.headSha) throw new Error('PR／MR 源提交已经改变，请刷新后重新确认');
    if (plan.mode === 'checkout') {
      if ((await checkoutLocalState(cwd, signal)).fingerprint !== resolution.localFingerprint) throw new Error('当前目录在准备期间已经改变，请重新确认');
      const dirty = !!await git(cwd, ['status', '--porcelain'], signal);
      if (dirty && !force) throw new Error('当前目录有未提交改动，请选择 Worktree，或明确允许丢弃当前目录改动');
      if (force && dirty) await git(cwd, ['reset', '--hard', 'HEAD'], signal);
      if (!plan.originalHead) await git(cwd, ['branch', '--', plan.branch, resolution.headSha], signal);
      await git(cwd, ['switch', '--no-guess', '--', plan.branch], signal);
      await git(cwd, force ? ['reset', '--hard', resolution.headSha] : ['merge', '--ff-only', resolution.headSha], signal);
    } else if (plan.reused) {
      const clean = !await git(plan.root, ['status', '--porcelain'], signal) && await git(plan.root, ['rev-parse', 'HEAD'], signal) === plan.originalHead;
      if (clean) {
        const fastForward = (await taskGit(plan.root, ['merge-base', '--is-ancestor', 'HEAD', resolution.headSha], { signal, allowFailure: true })).code === 0;
        if (fastForward) await git(plan.root, ['merge', '--ff-only', resolution.headSha], signal);
        else if (plan.oldUpstream && plan.originalHead === plan.oldUpstream) await git(plan.root, ['reset', '--hard', resolution.headSha], signal);
      }
    } else {
      const parent = dirname(plan.root); await mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await lstat(parent)).isSymbolicLink() || await realpath(parent) !== parent) throw new Error('Worktree 父目录关联已改变');
      if (await optionalGit(cwd, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${plan.branch}^{commit}`], signal) !== plan.originalHead) throw new Error('待检出的本地分支已经改变，请重新确认');
      // An unattached local branch can contain work too; retain it if it cannot fast-forward.
      if (plan.originalHead && plan.originalHead !== resolution.headSha) {
        if ((await taskGit(cwd, ['merge-base', '--is-ancestor', plan.originalHead, resolution.headSha], { signal, allowFailure: true })).code !== 0) throw new Error('已有 PR 分支包含本地提交，请先处理后再创建 Worktree');
        await git(cwd, ['branch', '-f', '--', plan.branch, resolution.headSha], signal);
      }
      await git(cwd, ['worktree', 'add', ...(plan.originalHead ? [plan.root, plan.branch] : ['-b', plan.branch, plan.root, resolution.headSha])], signal);
    }
    if (upstream && await git(plan.root, ['rev-parse', 'HEAD'], signal) === resolution.headSha) {
      const remote = upstream.slice(0, upstream.length - resolution.pullRequest.head.length - 1);
      await git(cwd, ['update-ref', 'refs/remotes/' + upstream, resolution.headSha], signal);
      await git(cwd, ['config', 'branch.' + plan.branch + '.remote', remote], signal);
      await git(cwd, ['config', 'branch.' + plan.branch + '.merge', 'refs/heads/' + resolution.pullRequest.head], signal);
    }
  } finally { await taskGit(cwd, ['update-ref', '-d', ref], { allowFailure: true }).catch(() => {}); }
}
export async function cleanupCheckoutRef(resolution: CheckoutResolution, id: string) {
  if (!/^[a-z0-9-]{36}$/i.test(id)) return;
  try {
    if (await realpath(await git(resolution.authority.sourcePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== resolution.authority.common) return;
    await taskGit(resolution.authority.sourcePath, ['update-ref', '-d', `refs/friday/pr-checkout/${id}/head`, resolution.headSha], { allowFailure: true });
  } catch {}
}
