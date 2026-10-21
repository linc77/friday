import { resolveCreationContext } from './task-change-request-creation.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { taskGit } from './git-process.js';
import { privateWorkspacePaths, readTaskChanges, workspacePathspecs, type TaskChangedFile } from './task-changes.js';
import type { TaskPullRequest, TaskWorkspacePlan } from './types.js';
import type { WorkspacePrivacy } from './workspace-privacy.js';
import { findExecutable } from './agents.js';
import { SourceControlConnections } from './source-control-connections.js';
import { sourceControlRepository, pinTaskChangeRequest, findTaskChangeRequest, taskRepositoryDefaultBranch, type SourceControlRepository } from './task-change-requests.js';

export type GitHubRepository = { host: string; owner: string; name: string; argument: string };
export type TaskGitStatus = {
  status: 'repository' | 'not_repository'; root?: string; cwd: string; branch: string | null; head: string | null;
  defaultBranch: string | null; isDefaultBranch: boolean; remote: string | null; upstream: string | null;
  ahead: number; behind: number; aheadOfDefault: number; files: TaskChangedFile[];
  fingerprint: string; contentFingerprint: string; github?: GitHubRepository; pullRequest?: TaskPullRequest | null; remoteError?: string; canCreatePR?: boolean;
  remoteFingerprint?: string; remoteDisplay?: string; trackingFingerprint?: string;
  sourceControl?: SourceControlRepository;
};
export function githubRepository(value: string): GitHubRepository | undefined {
  let host = ''; let path = '';
  try {
    const url = new URL(value); host = url.hostname; path = url.pathname.replace(/^\//, '');
  } catch {
    const match = value.match(/^(?:[^\s@]+@)?([^\s/:]+):(.+)$/); if (!match) return;
    host = match[1]; path = match[2];
  }
  // Other source-control hosts retain Git operations. Do not guess a provider
  // or send credentials to an inferred enterprise endpoint.
  if (host.toLowerCase() !== 'github.com') return;
  const parts = path.replace(/\.git\/?$/, '').replace(/\/$/, '').split('/');
  if (parts.length !== 2 || parts.some(part => !/^[\w.-]+$/.test(part) || part === '.' || part === '..')) return;
  return { host, owner: parts[0], name: parts[1], argument: parts.join('/') };
}
const read = async (cwd: string, args: string[]) => (await taskGit(cwd, args)).stdout.replace(/\n$/, '');
async function optional(cwd: string, args: string[]) { const result = await taskGit(cwd, args, { allowFailure: true }); return result.code === 0 ? result.stdout.trim() : null; }

async function contentsFingerprint(cwd: string, head: string | null, excluded: string[]) {
  const hash = createHash('sha256');
  if (excluded.includes('')) return hash.digest('hex');
  const pathspecs = workspacePathspecs(excluded);
  for (const compare of [head ? ['HEAD'] : [], ['--cached']]) {
    const value = await taskGit(cwd, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', ...compare, '--', ...pathspecs], { hashOutput: true });
    hash.update(value.digest);
  }
  const untracked = (await taskGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs])).stdout.split('\0').filter(Boolean).sort();
  for (const path of untracked) {
    const absolute = resolve(cwd, path); const parent = await realpath(dirname(absolute)); const inside = relative(cwd, parent);
    if (isAbsolute(inside) || inside === '..' || inside.startsWith('..' + sep)) throw new Error('文件路径超出工作区');
    const info = await lstat(absolute); hash.update(path + '\0');
    if (info.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (info.isFile()) for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    else throw new Error('暂不支持提交这个特殊文件');
    hash.update('\0' + (info.mode & 0o111));
  }
  return hash.digest('hex');
}

export async function taskPullRequest(cwd: string, repository: GitHubRepository, branch: string, signal?: AbortSignal, connections = new SourceControlConnections()): Promise<TaskPullRequest | null> {
  const target: SourceControlRepository = { ...repository, path: repository.argument, provider: 'github' };
  return findTaskChangeRequest(await pinTaskChangeRequest(cwd, target, connections, signal), target, branch, signal);
}

export async function readTaskGitStatus(directory: string, privateDirectory?: WorkspacePrivacy, connections?: SourceControlConnections): Promise<TaskGitStatus> {
  const cwd = await realpath(directory);
  const changes = await readTaskChanges(directory, 'all', privateDirectory);
  const empty: TaskGitStatus = { status: 'not_repository', cwd, branch: null, head: null, defaultBranch: null, isDefaultBranch: false, remote: null, upstream: null, ahead: 0, behind: 0, aheadOfDefault: 0, files: [], fingerprint: '', contentFingerprint: '' };
  if (changes.status !== 'repository') return empty;
  const root = await realpath(await read(cwd, ['rev-parse', '--show-toplevel']));
  const [branch, head, remotes] = await Promise.all([optional(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']), optional(cwd, ['rev-parse', '--verify', 'HEAD']), read(cwd, ['remote'])]);
  const remoteNames = remotes.split('\n').filter(Boolean); const remote = remoteNames.includes('origin') ? 'origin' : remoteNames[0] ?? null;
  const upstream = branch ? await optional(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) : null;
  let defaultBranch: string | null = null;
  if (remote) {
    const symbolic = await optional(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (symbolic?.startsWith(remote + '/')) defaultBranch = symbolic.slice(remote.length + 1);
    if (!defaultBranch) for (const name of ['main', 'master']) {
      if (await optional(cwd, ['rev-parse', '--verify', `refs/remotes/${remote}/${name}`])) { defaultBranch = name; break; }
    }
  }
  if (!defaultBranch && !remote) defaultBranch = (await optional(cwd, ['config', '--get', 'init.defaultBranch'])) || (branch === 'main' || branch === 'master' ? branch : null);
  let ahead = 0; let behind = 0; let aheadOfDefault = 0;
  if (head && upstream) {
    const counts = (await read(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).trim().split(/\s+/).map(Number);
    [ahead, behind] = counts;
  } else if (head) ahead = Number(await read(cwd, ['rev-list', '--count', 'HEAD']));
  if (head && remote && defaultBranch && branch !== defaultBranch) aheadOfDefault = Number(await read(cwd, ['rev-list', '--count', `refs/remotes/${remote}/${defaultBranch}..HEAD`]));
  const contentFingerprint = await contentsFingerprint(cwd, head, await privateWorkspacePaths(directory, privateDirectory));
  const remoteURL = remote ? await optional(cwd, ['remote', 'get-url', remote]) : null;
  const pushURL = remote ? await optional(cwd, ['remote', 'get-url', '--push', remote]) : null;
  const configuredURL = remote ? await optional(cwd, ['config', '--get-all', `remote.${remote}.url`]) : null;
  const configuredPush = remote ? await optional(cwd, ['config', '--get-all', `remote.${remote}.pushurl`]) : null;
  const remoteFingerprint = remoteURL ? createHash('sha256').update(JSON.stringify([remoteURL, pushURL, configuredURL, configuredPush])).digest('hex') : undefined;
  const tracking = await taskGit(cwd,['config','--get-regexp','^(branch\\..*\\.(remote|merge|push[Rr]emote)|remote\\..*\\.(url|pushurl|gh-resolved)|remote\\.push[Dd]efault)$'],{allowFailure:true});
  const trackingFingerprint = createHash('sha256').update(tracking.stdout).digest('hex');
  const fingerprint = createHash('sha256').update(JSON.stringify({ head, branch, contentFingerprint, remote, remoteFingerprint, trackingFingerprint })).digest('hex');
  const sourceURL = configuredURL?.split('\n')[0] ?? remoteURL;
  let sourceControl = sourceURL ? sourceControlRepository(sourceURL) : undefined;
  if (!sourceControl && sourceURL && connections) sourceControl = await connections.repository(cwd, sourceURL);
  if (!sourceControl && sourceURL && connections && /^(?:https?|ssh|git):\/\/|^[^\s/@]+@[\w.-]+:/.test(sourceURL)) {
    let [githubHosts, gitlabHosts] = await Promise.all([connections.githubHosts(cwd, undefined, false), connections.gitlabHosts(cwd, undefined, false)]);
    sourceControl = sourceControlRepository(sourceURL, githubHosts, gitlabHosts);
    if (!sourceControl) {
      [githubHosts, gitlabHosts] = await Promise.all([connections.githubHosts(cwd), connections.gitlabHosts(cwd)]);
      sourceControl = sourceControlRepository(sourceURL, githubHosts, gitlabHosts);
    }
  }
  let canCreatePR = sourceControl ? sourceControl.provider === 'github' ? !!findExecutable('gh') : sourceControl.provider === 'gitlab' ? !!findExecutable('glab') : false : undefined;
  let capabilityError: string | undefined;
  if (sourceControl && connections) { try { await connections.pinRepository(cwd, sourceControl); canCreatePR = true; } catch (error) { canCreatePR = false; capabilityError = error instanceof Error ? error.message : 'Source Control 认证不可用'; } }
  let remoteDisplay = pushURL ?? remoteURL ?? undefined;
  if (remoteDisplay) {
    try { const url = new URL(remoteDisplay); remoteDisplay = url.protocol + '//' + url.host + url.pathname; }
    catch { remoteDisplay = remoteDisplay.replace(/^[^@/\s]+@/, ''); }
  }
  return { ...empty, status: 'repository', cwd, root, branch, head, remote, upstream, defaultBranch, isDefaultBranch: branch !== null && branch === defaultBranch,
    ahead, behind, aheadOfDefault, files: changes.files, contentFingerprint, fingerprint, trackingFingerprint,
    ...(remoteURL ? { remoteFingerprint, remoteDisplay } : {}),
    ...(sourceControl ? { sourceControl, canCreatePR, ...(sourceControl.provider === 'github' ? { github: { host: sourceControl.host, owner: sourceControl.owner, name: sourceControl.name, argument: sourceControl.path } } : {}) } : {}),
    ...(capabilityError ? { remoteError: capabilityError } : {}) };
}

export class TaskGitStatuses {
  constructor(private readonly privateDirectory?: string, private readonly connections?: SourceControlConnections) {}
  private controllers = new Set<AbortController>();
  private remotes = new Map<string, { expires: number; result?: { pullRequest?: TaskPullRequest | null; remoteError?: string; defaultBranch?: string; canCreatePR?: boolean }; value: Promise<void> }>();
  async read(cwd: string, refresh = false, workspace?: TaskWorkspacePlan): Promise<TaskGitStatus> {
    const privacy = this.privateDirectory ? { directory: this.privateDirectory, workspace } : undefined;
    const local = await readTaskGitStatus(cwd, privacy, this.connections);
    if (!local.remote || !local.branch) return local;
    const credentialRevision = await this.connections?.revision() ?? 0;
    const key = local.cwd + '\0' + local.branch + '\0' + local.remoteFingerprint + '\0' + local.trackingFingerprint + '\0' + credentialRevision;
    let cached = this.remotes.get(key);
    if (!cached || refresh || cached.expires < Date.now()) {
      const entry: { expires: number; result?: { pullRequest?: TaskPullRequest | null; remoteError?: string; defaultBranch?: string; canCreatePR?: boolean }; value: Promise<void> } = { expires: Infinity, value: Promise.resolve() };
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15_000);
      this.controllers.add(controller);
      entry.value = (async () => {
        await taskGit(local.cwd, ['fetch', '--prune', '--no-tags', '--recurse-submodules=no', '--', local.remote!], { timeout: 10_000, signal: controller.signal });
        const remoteHead = await taskGit(local.cwd, ['ls-remote', '--symref', '--', local.remote!, 'HEAD'], { timeout: 8_000, signal: controller.signal });
        let defaultBranch = remoteHead.stdout.match(/^ref: refs\/heads\/(.+)\tHEAD$/m)?.[1];
        let pullRequest: TaskPullRequest | null | undefined;
        if (local.sourceControl && this.connections) {
          const creation = await resolveCreationContext(local.cwd,local,this.connections,{},controller.signal);
          const pinned = await pinTaskChangeRequest(local.cwd, creation.target, this.connections, controller.signal);
          [pullRequest, defaultBranch] = await Promise.all([findTaskChangeRequest(pinned, creation.target, creation.sourceBranch, controller.signal,{source:creation.source,sourceProjectID:creation.sourceProjectID,targetProjectID:creation.targetProjectID}), defaultBranch ? Promise.resolve(defaultBranch) : taskRepositoryDefaultBranch(pinned, local.sourceControl, controller.signal)]);
        }
        if (defaultBranch) {
          await taskGit(local.cwd, ['check-ref-format', '--branch', defaultBranch]);
          const target = `refs/remotes/${local.remote}/${defaultBranch}`;
          const present = await optional(local.cwd, ['rev-parse', '--verify', target]);
          if (!present) await taskGit(local.cwd, ['fetch', '--no-tags', '--recurse-submodules=no', '--', local.remote!, `refs/heads/${defaultBranch}:${target}`], { signal: controller.signal, timeout: 8_000 });
          await taskGit(local.cwd, ['symbolic-ref', `refs/remotes/${local.remote}/HEAD`, target]);
        }
        entry.result = { ...(defaultBranch ? { defaultBranch } : {}), ...(pullRequest !== undefined ? { pullRequest, canCreatePR: true } : {}) };
      })().catch(error => { entry.result = { remoteError: (error as Error).message, ...(local.sourceControl ? { canCreatePR: false } : {}) }; })
        .finally(() => { clearTimeout(timeout); this.controllers.delete(controller); entry.expires = Date.now() + 30_000; });
      cached = entry;
      this.remotes.set(key, cached);
      if (this.remotes.size > 100) this.remotes.delete(this.remotes.keys().next().value!);
    }
    if (refresh) await cached.value;
    const remote = cached.result ?? {};
    const fresh = await readTaskGitStatus(cwd, privacy, this.connections);
    if (fresh.branch !== local.branch || fresh.remoteFingerprint !== local.remoteFingerprint || fresh.trackingFingerprint !== local.trackingFingerprint || (await this.connections?.revision() ?? 0) !== credentialRevision) return fresh;
    const defaultBranch = remote.defaultBranch ?? fresh.defaultBranch;
    let aheadOfDefault = fresh.aheadOfDefault;
    if (defaultBranch && fresh.head && fresh.remote && fresh.branch !== defaultBranch) {
      const count = await optional(cwd, ['rev-list', '--count', `refs/remotes/${fresh.remote}/${defaultBranch}..HEAD`]);
      if (count !== null) aheadOfDefault = Number(count);
    }
    return { ...fresh, ...remote, defaultBranch, isDefaultBranch: fresh.branch === defaultBranch, aheadOfDefault };
  }
  close() { for (const controller of this.controllers) controller.abort(); this.controllers.clear(); }
}
