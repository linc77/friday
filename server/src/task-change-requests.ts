import { createHash } from 'node:crypto';
import type { SourceControlConnections, PinnedSourceControlConnection } from './source-control-connections.js';
import type { PublishProvider } from './task-repository-publish.js';
import type { TaskPullRequest } from './types.js';
import { azureRepositoryIdentity, forgejoRepositoryIdentity, gitCafeRepositoryIdentity, type AdditionalRepositoryIdentity } from './source-control-provider-identity.js';
import type { ForgejoLogin } from './vendor/t3-forgejo-logins.js';
import { isAdditionalSourceControlProvider } from './source-control-provider.js';
import { sourceControlRateFailure } from './source-control-request-policy.js';
import { summaryFromRaw, taskPullRequestReading, selectBranchPullRequest, type ChangeRequestSummary } from './task-change-request-summary.js';

export type SourceControlRepository = { provider: PublishProvider; host: string; owner: string; name: string; path: string; argument: string; additional?: AdditionalRepositoryIdentity };
export type TaskChangeRequestTarget = SourceControlRepository & { credentialFingerprint: string };
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const segment = (value: string) => /^[\w.-]+$/.test(value) && value !== '.' && value !== '..';

export function sourceControlRepository(remote: string, githubHosts: string[] = [], gitlabHosts: string[] = [], forgejoLogins: ForgejoLogin[] = []): SourceControlRepository | undefined {
  const additional = azureRepositoryIdentity(remote) ?? gitCafeRepositoryIdentity(remote) ?? forgejoRepositoryIdentity(remote, forgejoLogins);
  if (additional) return { provider: additional.provider, host: additional.host, owner: additional.repository.split('/').slice(0, -1).join('/'), name: additional.name, path: additional.path, argument: additional.repository, additional };
  let host: string; let path: string; let ssh = false;
  try {
    const url = new URL(remote); if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return;
    ssh = url.protocol === 'ssh:'; host = ssh ? url.hostname : url.host; path = url.pathname.replace(/^\//, '');
  } catch {
    const match = remote.match(/^(?:[^\s@]+@)?([\w.-]+):(.+)$/); if (!match) return;
    ssh = true; host = match[1]; path = match[2];
  }
  host = host.toLowerCase(); path = path.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (ssh && !githubHosts.includes(host) && !gitlabHosts.includes(host)) {
    const aliases = [...new Set([...githubHosts, ...gitlabHosts])].filter(value => { try { return new URL('https://' + value).hostname === host; } catch { return false; } });
    if (aliases.length === 1) host = aliases[0];
  }
  if (githubHosts.includes(host) && gitlabHosts.includes(host) && !['github.com', 'gitlab.com', 'bitbucket.org'].includes(host)) return;
  const provider: PublishProvider | undefined = host === 'gitlab.com' || gitlabHosts.includes(host) && !githubHosts.includes(host) ? 'gitlab' : host === 'bitbucket.org' ? 'bitbucket' : host === 'github.com' || host.endsWith('.ghe.com') || githubHosts.includes(host) ? 'github' : undefined;
  if (!provider) return;
  const parts = path.split('/'); if (parts.length < 2 || provider !== 'gitlab' && parts.length !== 2 || !parts.every(segment)) return;
  return { provider, host, owner: parts.slice(0, -1).join('/'), name: parts.at(-1)!, path, argument: path };
}

export function sourceControlRepositoryOnHost(remote: string, repository: Pick<SourceControlRepository, 'provider' | 'host' | 'additional'>) {
  const identity = repository.additional;
  const logins: ForgejoLogin[] = identity?.provider === 'forgejo' ? [{ name: identity.login ?? 'selected', url: identity.apiBase.replace(/\/api\/v1\/$/, ''), user: identity.account ?? '', default: 'true', ssh_host: identity.sshHost }] : [];
  return sourceControlRepository(remote, repository.provider === 'github' ? [repository.host] : [], repository.provider === 'gitlab' ? [repository.host] : [], logins);
}

export async function pinTaskChangeRequest(cwd: string, repository: SourceControlRepository, connections: SourceControlConnections, signal?: AbortSignal, expected?: string): Promise<PinnedSourceControlConnection & { fingerprint: string }> {
  const pinned = await connections.pinRepository(cwd, repository, signal);
  let identity = pinned.fingerprint;
  if (!identity) {
    // glab owns its token. Verify its account at each phase without copying a
    // credential into the operation document or relying on the current window.
    const user = await pinned.json('user', { signal });
    if (typeof user.username !== 'string' || !user.username || user.username.length > 256) throw new Error('无法确认 Source Control 账号');
    identity = createHash('sha256').update(repository.provider + '\0' + repository.host + '\0' + user.username + '\0' + String(user.id ?? '')).digest('hex');
  }
  if (expected && identity !== expected) throw new Error('Source Control 账号或凭据已改变，请重新确认操作');
  pinned.setCredentialScope?.(identity);
  return { ...pinned, fingerprint: identity };
}

export function normalizeTaskChangeRequest(repository: SourceControlRepository, raw: unknown): TaskPullRequest {
  if (isAdditionalSourceControlProvider(repository.provider)) throw new Error('此平台需要专用 PR 适配器');
  const value = record(raw); const provider = repository.provider;
  const number = provider === 'github' ? value.number : provider === 'gitlab' ? value.iid : value.id;
  const branch = provider === 'github' ? record(value.head).ref : provider === 'gitlab' ? value.source_branch : record(record(value.source).branch).name;
  const base = provider === 'github' ? record(value.base).ref : provider === 'gitlab' ? value.target_branch : record(record(value.destination).branch).name;
  const rawURL = provider === 'github' ? value.html_url : provider === 'gitlab' ? value.web_url : record(record(value.links).html).href;
  if (!Number.isSafeInteger(number) || number < 1 || typeof value.title !== 'string' || value.title.length > 1024 || typeof branch !== 'string' || !branch || typeof base !== 'string' || !base || typeof rawURL !== 'string') throw new Error('平台返回的 PR／MR 信息无效');
  const suffix = provider === 'github' ? 'pull' : provider === 'gitlab' ? '-/merge_requests' : 'pull-requests';
  const expected = `https://${repository.host}/${repository.path}/${suffix}/${number}`;
  let url: URL; try { url = new URL(rawURL); } catch { throw new Error('平台返回的 PR／MR 地址无效'); }
  if (url.username || url.password || url.protocol !== 'https:' || url.host !== repository.host || url.pathname.replace(/\/$/, '').toLowerCase() !== new URL(expected).pathname.toLowerCase()) throw new Error('平台返回的 PR／MR 地址与仓库不一致');
  const state = provider === 'github' ? value.merged_at || value.merged === true ? 'merged' : value.state === 'closed' ? 'closed' : value.state === 'open' ? 'open' : undefined
    : provider === 'gitlab' ? value.state === 'merged' ? 'merged' : value.state === 'closed' ? 'closed' : value.state === 'opened' ? 'open' : undefined
    : value.state === 'MERGED' ? 'merged' : ['DECLINED', 'SUPERSEDED'].includes(value.state) ? 'closed' : value.state === 'OPEN' ? 'open' : undefined;
  if (!state) throw new Error('平台返回未知的 PR／MR 状态');
  return { number, url: expected, title: value.title, state, base, head: branch, provider, host: repository.host, repository: repository.path };
}

export type ChangeRequestSource = { source: SourceControlRepository; sourceProjectID?: number; targetProjectID?: number; base?: string; includeTerminal?: boolean };
function sameRepository(repository: SourceControlRepository, raw: unknown, expected?: ChangeRequestSource): boolean {
  const value = record(raw);
  const source = repository.provider === 'github' ? record(record(value.head).repo).full_name : repository.provider === 'bitbucket' ? record(record(value.source).repository).full_name : undefined;
  const wanted = expected?.source ?? repository; const cross = wanted.path.toLowerCase() !== repository.path.toLowerCase();
  if (typeof source === 'string' ? source.toLowerCase() !== wanted.path.toLowerCase() : cross && repository.provider !== 'gitlab') return false;
  if (repository.provider === 'gitlab') {
    if (cross) { if (value.source_project_id !== expected?.sourceProjectID || value.target_project_id !== expected?.targetProjectID) return false; }
    else if (value.source_project_id !== undefined && value.target_project_id !== undefined && value.source_project_id !== value.target_project_id) return false;
  }
  return true;
}

function assertPinnedTarget(pinned: PinnedSourceControlConnection, repository: SourceControlRepository) {
  if (pinned.host !== repository.host || pinned.provider !== repository.provider) throw new Error('Source Control 连接与目标平台或主机不一致');
}

export async function findTaskChangeRequest(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, branch: string, signal?: AbortSignal, expected?: ChangeRequestSource): Promise<TaskPullRequest | null> {
  assertPinnedTarget(pinned, repository); if (expected) assertPinnedTarget(pinned, expected.source);
  if (pinned.additional) return pinned.additional.find(branch, expected?.base, expected?.source.additional, signal, expected?.includeTerminal);
  const provider = repository.provider; const options = { signal, maxResponseBytes: 8 * 1024 * 1024 };
  let values: unknown[];
  try {
    if (provider === 'github') values = await pinned.array(`repos/${repository.path}/pulls?` + new URLSearchParams({ state: expected?.includeTerminal ? 'all' : 'open', ...(expected?.includeTerminal ? { sort: 'updated', direction: 'desc' } : {}), head: (expected?.source.owner ?? repository.owner) + ':' + branch, per_page: '100' }), options);
    else if (provider === 'gitlab') values = await pinned.array(`projects/${encodeURIComponent(repository.path)}/merge_requests?` + new URLSearchParams({ state: expected?.includeTerminal ? 'all' : 'opened', ...(expected?.includeTerminal ? { order_by: 'updated_at', sort: 'desc' } : {}), source_branch: branch, per_page: '100' }), options);
    else {
      const query = new URLSearchParams({ pagelen: '100', q: 'source.branch.name = ' + JSON.stringify(branch) });
      for (const state of expected?.includeTerminal ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] : ['OPEN']) query.append('state', state);
      if (expected?.includeTerminal) query.set('sort', '-updated_on');
      const response = await pinned.json(`repositories/${repository.path}/pullrequests?` + query, options);
      if (!Array.isArray(response.values)) throw new Error(); values = response.values;
    }
    const candidates: TaskPullRequest[] = [];
    for (const value of values.slice(0, 100)) {
      if (!sameRepository(repository, value, expected)) continue;
      const parsed = normalizeTaskChangeRequest(repository, value);
      if (parsed.head === branch && (expected?.includeTerminal || parsed.state === 'open') && (!expected?.base || parsed.base === expected.base)) { if (expected?.includeTerminal) candidates.push(taskPullRequestReading(parsed, value)); else return parsed; }
    }
    return selectBranchPullRequest(candidates);
  } catch (error) { if (sourceControlRateFailure(error)) throw error; throw new Error('无法读取当前分支的 PR／MR，请检查平台登录、权限和连接'); }
}

export async function createTaskChangeRequest(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, input: { branch: string; base: string; title: string; body: string }, signal?: AbortSignal, expected?: ChangeRequestSource): Promise<TaskPullRequest> {
  assertPinnedTarget(pinned, repository); if (expected) assertPinnedTarget(pinned, expected.source);
  if (pinned.additional) return pinned.additional.create(input, expected?.source.additional, signal);
  let response: Record<string, unknown>;
  try {
    if (repository.provider === 'github') response = await pinned.json(`repos/${repository.path}/pulls`, { method: 'POST', signal, body: { title: input.title, body: input.body, head: expected && expected.source.path.toLowerCase() !== repository.path.toLowerCase() ? expected.source.owner + ':' + input.branch : input.branch, base: input.base, maintainer_can_modify: true } });
    else if (repository.provider === 'gitlab') response = await pinned.json(`projects/${expected?.sourceProjectID ?? encodeURIComponent(repository.path)}/merge_requests`, { method: 'POST', signal, body: { title: input.title, description: input.body, source_branch: input.branch, target_branch: input.base, ...(expected?.targetProjectID ? { target_project_id: expected.targetProjectID } : {}) } });
    else response = await pinned.json(`repositories/${repository.path}/pullrequests`, { method: 'POST', signal, body: { title: input.title, description: input.body, source: { branch: { name: input.branch }, ...(expected ? { repository: { full_name: expected.source.path } } : {}) }, destination: { branch: { name: input.base } } } });
    const created = normalizeTaskChangeRequest(repository, response);
    if (created.head !== input.branch || created.base !== input.base || created.state !== 'open' || !sameRepository(repository, response, expected)) throw new Error();
    return created;
  } catch { throw new Error('PR／MR 创建结果尚未确认。请在平台核对后刷新，不会自动重复创建。'); }
}

export async function readTaskChangeRequest(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, number: number, signal?: AbortSignal): Promise<TaskPullRequest> {
  assertPinnedTarget(pinned, repository);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR／MR 编号无效');
  if (pinned.additional) return pinned.additional.summary(number, signal);
  const path = repository.provider === 'github' ? `repos/${repository.path}/pulls/${number}` : repository.provider === 'gitlab' ? `projects/${encodeURIComponent(repository.path)}/merge_requests/${number}` : `repositories/${repository.path}/pullrequests/${number}`;
  try { return normalizeTaskChangeRequest(repository, await pinned.json(path, { signal })); }
  catch (error) { if (sourceControlRateFailure(error)) throw error; throw new Error('无法确认已有 PR／MR 的状态，不会重复创建'); }
}

export async function readTaskChangeRequestSummary(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, number: number, signal?: AbortSignal): Promise<ChangeRequestSummary> {
  assertPinnedTarget(pinned, repository);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR／MR 编号无效');
  if (pinned.additional) return pinned.additional.summaryReading(number, signal);
  const path = repository.provider === 'github' ? `repos/${repository.path}/pulls/${number}` : repository.provider === 'gitlab' ? `projects/${encodeURIComponent(repository.path)}/merge_requests/${number}` : `repositories/${repository.path}/pullrequests/${number}`;
  const observedAt = Date.now(), raw = await pinned.json(path, { signal });
  return summaryFromRaw(normalizeTaskChangeRequest(repository, raw), raw, observedAt);
}

export async function taskRepositoryDefaultBranch(pinned: PinnedSourceControlConnection, repository: SourceControlRepository, signal?: AbortSignal): Promise<string | undefined> {
  assertPinnedTarget(pinned, repository);
  if (pinned.additional) return pinned.additional.defaultBranch(signal);
  const value = await pinned.json(repository.provider === 'github' ? `repos/${repository.path}` : repository.provider === 'gitlab' ? `projects/${encodeURIComponent(repository.path)}` : `repositories/${repository.path}`, { signal });
  const branch = repository.provider === 'bitbucket' ? record(value.mainbranch).name : value.default_branch;
  return typeof branch === 'string' && branch.length <= 1024 && branch && !/[\u0000-\u001f\u007f]/.test(branch) ? branch : undefined;
}
