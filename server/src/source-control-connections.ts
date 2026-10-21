import { parseGitLabAuthStatusHosts } from './vendor/t3-gitlab-auth-status.js';
import { createHash } from 'node:crypto';
import { findExecutable } from './agents.js';
import { workspaceCommand } from './git-process.js';
import { SourceControlCredentials, sourceControlHost } from './source-control-credentials.js';
import type { PublishProvider, PublishProviderStatus } from './task-repository-publish.js';
import { githubMediaResponse, type GitHubMediaRequest } from './github-media-fetch.js';
import { githubMediaFetchUrl } from './vendor/t3-github-media.js';
import { AdditionalSourceControl } from './source-control-additional.js';
import { AdditionalSourceControlTransports, type AdditionalTransportOptions } from './source-control-provider-transports.js';
import { forgejoRepositoryIdentity, gitCafeRepositoryIdentity, type AdditionalRepositoryIdentity } from './source-control-provider-identity.js';
import { sourceControlProviderDefinitions as definitions, isAdditionalSourceControlProvider } from './source-control-provider.js';
import { sourceControlRepository, type SourceControlRepository } from './task-change-requests.js';
import { SourceControlRequestPolicy, sourceControlInteractive, githubRateLimited, responseRetryAt, sourceControlRateFailure } from './source-control-request-policy.js';
import { GitHubChecksRevalidator } from './github-conditional-checks.js';
import { GitHubSummaryBatcher } from './github-summary-batches.js';
import { SourceControlReadCache, SQLiteSourceControlReadStorage } from './source-control-read-cache.js';

export type SourceControlConnectionOptions = { environment?: NodeJS.ProcessEnv; request?: typeof fetch; command?: typeof findExecutable; execute?: typeof workspaceCommand; additional?: AdditionalTransportOptions; policy?: SourceControlRequestPolicy; changeRequestSyncIntervalMs?: number; changeRequestWatchIntervalMs?: number };
export type JsonOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; signal?: AbortSignal; maxResponseBytes?: number; allowEmpty?: boolean; jsonBody?: boolean; responseType?: 'text' | 'bytes' | 'response'; accept?: 'application/vnd.github.diff'; timeoutMs?: number; ifNoneMatch?: string; allowReserve?: boolean };
export type SourceControlConditionalResponse = { status: number; headers: Headers; body: string };
import { SourceControlHTTPError, SourceControlResponseTooLarge } from './source-control-http-errors.js';
export { SourceControlHTTPError, SourceControlResponseTooLarge } from './source-control-http-errors.js';
export type RepositoryGit = (cwd: string, repository: string, args: string[], options?: { signal?: AbortSignal; allowFailure?: boolean }) => ReturnType<typeof workspaceCommand>;
export type PinnedSourceControlConnection = { provider: PublishProvider; fingerprint?: string; source: 'settings' | 'environment' | 'gh' | 'cli'; host: string; additional?: AdditionalSourceControl; viewer?: string; setCredentialScope?(fingerprint: string): void; repositoryGit?: RepositoryGit; json(path: string, options?: JsonOptions): Promise<Record<string, unknown>>; array(path: string, options?: JsonOptions): Promise<unknown[]>; text?(path: string, options?: JsonOptions): Promise<string>; bytes?(path: string, options?: JsonOptions): Promise<Uint8Array>; conditional?(path: string, options?: JsonOptions): Promise<SourceControlConditionalResponse>; graphql?(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>; graphqlRaw?(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>>; gitLabBranchAction?(repository: string, number: number, action: 'update-branch' | 'enable-auto-merge', method: string, signal?: AbortSignal): Promise<void>; mergeGitLab?(repository: string, number: number, method: string, signal?: AbortSignal): Promise<void> };
export type GitHubDiscoveredAccount = { host: string; account: string; active: boolean; authenticated: boolean; environmentVariable?: string };
export type GitLabDiscoveredAccount = { host: string; account: string; authenticated: boolean; cliHost?: string };
const headerSafe = (value: string | undefined): value is string => !!value && value.length <= 8192 && /^[\x21-\x7e]+$/.test(value);
const accountText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const fingerprint = (host: string, credential: string) => createHash('sha256').update('friday.source-control\0' + host + '\0' + credential).digest('hex');
export function githubEnvironmentToken(host: string, environment: NodeJS.ProcessEnv): string | undefined {
  const names = host === 'github.com' || host.endsWith('.ghe.com') ? ['GH_TOKEN', 'GITHUB_TOKEN'] : environment.GH_HOST?.trim().toLowerCase() === host ? ['GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] : [];
  return names.map(name => environment[name]?.trim()).find(headerSafe);
}

// Tokens stay server-local. A pinned connection uses the same credential for
// the account check and mutation, even while another device changes settings.
export class SourceControlConnections {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly request: typeof fetch;
  private readonly command: typeof findExecutable;
  private readonly execute: typeof workspaceCommand;
  private readonly ghTokens = new Map<string, { token?: string; expires: number }>();
  private ghAccounts: GitHubDiscoveredAccount[] = [];
  private accountsExpire = 0;
  private accountFlight?: Promise<GitHubDiscoveredAccount[]>;
  private githubAccountHint?: string;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  readonly additionalTransports: AdditionalSourceControlTransports;
  readonly policy: SourceControlRequestPolicy;
  readonly checks: GitHubChecksRevalidator;
  readonly summaries: GitHubSummaryBatcher;
  readonly reads: SourceControlReadCache;
  constructor(readonly credentials?: SourceControlCredentials, options: SourceControlConnectionOptions = {}) {
    this.environment = options.environment ?? process.env; this.request = options.request ?? fetch;
    this.command = options.command ?? findExecutable; this.execute = options.execute ?? workspaceCommand;
    this.policy = options.policy ?? new SourceControlRequestPolicy();
    this.checks = new GitHubChecksRevalidator(this.policy.now);
    this.summaries = new GitHubSummaryBatcher();
    this.reads = new SourceControlReadCache(credentials ? new SQLiteSourceControlReadStorage(credentials.directory) : undefined, this.policy.now);
    this.additionalTransports = new AdditionalSourceControlTransports({ ...options, gitCafeToken: () => this.credentials?.gitCafeToken() ?? Promise.resolve(undefined), ...options.additional, policy: this.policy });
  }
  private tracked<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Source Control 连接已关闭'));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) return Promise.reject(new Error('Source Control 请求超时设置无效'));
    const controller = new AbortController(); this.controllers.add(controller);
    const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const promise = Promise.resolve().then(() => run(combined)); this.pending.add(promise);
    void promise.finally(() => { this.controllers.delete(controller); this.pending.delete(promise); }).catch(() => {});
    return promise;
  }
  private http(base: string, authorization: string, path: string, options: JsonOptions, github = false, identity?: { host: string; scope: string }) {
    if (!path || path.startsWith('/') || path.includes('://') || path.split('/').includes('..')) return Promise.reject(new Error('Source Control 请求路径无效'));
    if (options.accept && (!github || options.accept !== 'application/vnd.github.diff' || options.responseType !== 'text' || options.method && options.method !== 'GET')) return Promise.reject(new Error('Source Control Diff 请求无效'));
    if (options.ifNoneMatch !== undefined && (!github || options.method && options.method !== 'GET' || options.ifNoneMatch.length > 8192 || /[\x00-\x1f\x7f]/.test(options.ifNoneMatch))) return Promise.reject(new Error('Source Control 条件请求无效'));
    return this.tracked(options.signal, async signal => {
      const init: RequestInit = { method: options.method ?? 'GET', redirect: 'manual', signal,
        headers: { Authorization: authorization, ...(options.accept ? { Accept: options.accept } : options.responseType === 'text' || options.responseType === 'bytes' ? {} : { Accept: github ? 'application/vnd.github+json' : 'application/json' }), 'Content-Type': 'application/json', 'User-Agent': 'Friday', ...(github ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}), ...(options.ifNoneMatch !== undefined ? { 'If-None-Match': options.ifNoneMatch } : {}) },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}) };
      let address = base + path, response: Response;
      for (let hop = 0; ; hop++) {
        response = await this.request(address, init);
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location || init.method !== 'GET' || hop >= 3) break;
        await response.body?.cancel();
        const next = new URL(location, address), origin = new URL(base);
        if (next.origin !== origin.origin || next.username || next.password || !next.pathname.startsWith(origin.pathname)) throw new Error('Source Control 重定向目标不受信任');
        address = next.href;
      }
      if (identity) this.policy.observeGithub(identity.host, identity.scope, response.headers);
      if (response.status === 304 && github && options.responseType === 'response') { await response.body?.cancel(); return { status: 304, headers: new Headers(response.headers), body: '' }; }
      if (github && response.status === 403 && githubRateLimited(403, response.headers)) { await response.body?.cancel(); throw new SourceControlHTTPError(403, 'Source Control 请求过于频繁，请稍后重试', { rateLimited: true, retryAt: responseRetryAt(response.headers, this.policy.now()) }); }
      if (!response.ok && !(github && response.status === 403)) { await response.body?.cancel(); throw new SourceControlHTTPError(response.status, response.status === 401 || response.status === 403 ? 'Source Control 认证或权限不足' : response.status === 429 ? 'Source Control 请求过于频繁，请稍后重试' : 'Source Control 平台未能完成请求', { rateLimited: response.status === 429, retryAt: responseRetryAt(response.headers, this.policy.now()) }); }
      if (response.status === 204 && options.allowEmpty) { await response.body?.cancel(); return {}; }
      const reader = response.body?.getReader(); if (!reader) { if (!response.ok) throw new SourceControlHTTPError(response.status, 'Source Control 认证或权限不足'); throw new Error('Source Control 返回空结果'); }
      const chunks: Uint8Array[] = []; let bytes = 0; const limit = Math.min(options.maxResponseBytes ?? 256 * 1024, github && response.status === 403 ? 64 * 1024 : 8 * 1024 * 1024);
      try {
        while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > limit) { await reader.cancel(); throw new SourceControlResponseTooLarge(); } chunks.push(chunk.value); }
      } finally { reader.releaseLock(); }
      const buffer = Buffer.concat(chunks);
      if (!response.ok) { const limited = githubRateLimited(response.status, response.headers, buffer.toString('utf8')); throw new SourceControlHTTPError(response.status, limited ? 'Source Control 请求过于频繁，请稍后重试' : 'Source Control 认证或权限不足', { rateLimited: limited, retryAt: limited ? responseRetryAt(response.headers, this.policy.now()) : undefined }); }
      if (options.responseType === 'bytes') return buffer;
      let decoded: string; try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { throw new Error('Source Control 返回结果无效'); }
      if (options.responseType === 'response') return { status: response.status, headers: new Headers(response.headers), body: decoded };
      let value: unknown; try { value = options.responseType === 'text' ? decoded : JSON.parse(decoded); } catch { throw new Error('Source Control 返回结果无效'); }
      if (github && path === 'graphql' && githubRateLimited(response.status, response.headers, '', (value as Record<string, unknown>)?.errors)) throw new SourceControlHTTPError(429, 'Source Control 请求过于频繁，请稍后重试', { rateLimited: true, retryAt: responseRetryAt(response.headers, this.policy.now()) });
      if (options.responseType === 'text') return value;
      if (!value || typeof value !== 'object') throw new Error('Source Control 返回结果无效');
      return value;
    }, options.timeoutMs);
  }
  private bound(provider: PublishProvider, host: string, source: PinnedSourceControlConnection['source'], send: (path: string, options: JsonOptions) => Promise<unknown>, credential?: string): PinnedSourceControlConnection {
    let scope = credential ? fingerprint(host, credential) : '';
    const read = (path: string, options: JsonOptions) => this.policy.request({ provider, host, scope }, { signal: options.signal, resource: path === 'graphql' ? 'graphql' : 'core', interactive: options.allowReserve ?? (sourceControlInteractive() || path === 'user' || options.method !== undefined && options.method !== 'GET' && path !== 'graphql') }, signal => send(path, { ...options, signal }));
    const bound: PinnedSourceControlConnection = { provider, host, source, ...(scope ? { fingerprint: scope } : {}), setCredentialScope: value => { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('凭据范围无效'); scope = value; bound.fingerprint = value; },
      json: async (path, options = {}) => { const value = await read(path, options); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Source Control 返回结果无效'); return value as Record<string, unknown>; },
      bytes: async (path, options = {}) => { const value = await read(path, { ...options, responseType: 'bytes' }); if (!(value instanceof Uint8Array)) throw new Error('Source Control 返回文件无效'); return value; },
      text: async (path, options = {}) => { const value = await read(path, { ...options, responseType: 'text' }); if (typeof value !== 'string') throw new Error('Source Control 返回文本无效'); return value; },
      array: async (path, options = {}) => { const value = await read(path, options); if (!Array.isArray(value)) throw new Error('Source Control 返回列表无效'); return value; },
      ...(provider === 'github' ? { conditional: async (path: string, options: JsonOptions = {}) => await read(path, { ...options, responseType: 'response' }) as SourceControlConditionalResponse } : {}) };
    return bound;
  }
  private async fromGh(cwd: string, host: string, account?: string, parentSignal?: AbortSignal): Promise<string> {
    const key = host + '\0' + (account ?? ''); const cached = this.ghTokens.get(key);
    if (cached && cached.expires > Date.now()) { if (cached.token) return cached.token; throw new Error('没有可用的 GitHub 登录凭据'); }
    const command = this.command('gh'); if (!command) throw new Error('请安装并登录 gh，或配置 GitHub Token');
    const read = (user?: string) => this.tracked(parentSignal, signal => this.execute(cwd, command, ['auth', 'token', '--hostname', host, ...(user ? ['--user', user] : [])], { signal, timeout: 10_000, limit: 16_384, allowFailure: true, env: { GH_HOST: host, GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' } }));
    try {
      let result = await read(account);
      if (result.code !== 0 && account) result = await read(); // A stale selected login follows gh's active account.
      const token = result.stdout.trim();
      if (result.code !== 0 || !headerSafe(token)) throw new Error();
      this.ghTokens.set(key, { token, expires: Date.now() + 300_000 });
      if (this.ghTokens.size > 32) this.ghTokens.delete(this.ghTokens.keys().next().value!);
      return token;
    } catch { if (!parentSignal?.aborted) this.ghTokens.set(key, { expires: Date.now() + 10_000 }); if (this.ghTokens.size > 32) this.ghTokens.delete(this.ghTokens.keys().next().value!); throw new Error('无法取得 GitHub 登录凭据，请检查主机 gh 登录后重新扫描'); }
  }
  async githubAccounts(cwd: string, refresh = false, signal?: AbortSignal): Promise<GitHubDiscoveredAccount[]> {
    signal?.throwIfAborted();
    if (!refresh && this.accountsExpire > Date.now()) return this.ghAccounts;
    if (this.accountFlight) return this.accountFlight;
    const flight = this.readGitHubAccounts(cwd, signal); this.accountFlight = flight;
    try { return await flight; } finally { if (this.accountFlight === flight) this.accountFlight = undefined; }
  }
  private async readGitHubAccounts(cwd: string, signal?: AbortSignal): Promise<GitHubDiscoveredAccount[]> {
    const command = this.command('gh'); if (!command) { this.accountsExpire = Date.now() + 30_000; this.githubAccountHint = '安装 gh 后可选择登录账号；已保存的 Token 仍可使用'; return []; }
    let unsupported = false;
    try {
      const result = await this.tracked(signal, signal => this.execute(cwd, command, ['auth', 'status', '--json', 'hosts'], { signal, timeout: 10_000, limit: 256 * 1024, allowFailure: true, env: { GH_TOKEN: '', GITHUB_TOKEN: '', GH_ENTERPRISE_TOKEN: '', GITHUB_ENTERPRISE_TOKEN: '', GH_DEBUG: '', GH_PROMPT_DISABLED: '1' } }));
      unsupported = result.code !== 0 && (result.stdout + result.stderr).includes('unknown flag: --json');
      const raw = JSON.parse(result.stdout) as { hosts?: Record<string, unknown> }; const accounts: GitHubDiscoveredAccount[] = [];
      if (!raw.hosts || typeof raw.hosts !== 'object' || Array.isArray(raw.hosts)) throw new Error();
      for (const entries of Object.values(raw.hosts)) if (Array.isArray(entries)) for (const value of entries) {
        if (!value || typeof value !== 'object' || typeof value.host !== 'string' || typeof value.login !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/.test(value.login) || typeof value.active !== 'boolean') continue;
        let host: string; try { host = sourceControlHost(value.host); } catch { continue; }
        accounts.push({ host, account: value.login, active: value.active, authenticated: value.state === 'success', ...(/^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/.test(value.tokenSource ?? '') ? { environmentVariable: value.tokenSource } : {}) });
        if (accounts.length >= 128) break;
      }
      this.ghAccounts = accounts.slice(0, 128);
      this.githubAccountHint = undefined;
    } catch { this.ghAccounts = []; this.githubAccountHint = unsupported ? '请升级 gh 至 2.81.0 或更新版本，再重新扫描账号' : '无法读取 gh 账号列表，请检查主机登录后重新扫描'; }
    this.accountsExpire = Date.now() + 30_000; return this.ghAccounts;
  }
  private glabAccounts: GitLabDiscoveredAccount[] = [];
  private glabExpires = 0;
  private glabFlight?: Promise<GitLabDiscoveredAccount[]>;
  async gitlabAccounts(cwd: string, refresh = false, signal?: AbortSignal) {
    if (!refresh && this.glabExpires > Date.now()) return this.glabAccounts;
    if (this.glabFlight) return this.glabFlight;
    const flight = this.readGitLabAccounts(cwd, signal); this.glabFlight = flight;
    try { return await flight; } finally { if (this.glabFlight === flight) this.glabFlight = undefined; }
  }
  private gitlabEnvironment(host: string) {
    const configured = (this.environment.GITLAB_HOST || this.environment.GITLAB_URI || this.environment.GL_HOST)?.trim() || 'gitlab.com';
    let match = false; try { match = sourceControlHost(configured) === host; } catch {}
    return { GITLAB_HOST: host, GITLAB_URI: '', GL_HOST: '', GITLAB_API_HOST: host, GITLAB_REPO: '', GITLAB_GROUP: '', GITLAB_HEAD_REPO: '', GITLAB_CI: '', CI_JOB_TOKEN: '', GITLAB_TOKEN: match ? this.environment.GITLAB_TOKEN ?? '' : '', GITLAB_ACCESS_TOKEN: match ? this.environment.GITLAB_ACCESS_TOKEN ?? '' : '', OAUTH_TOKEN: match ? this.environment.OAUTH_TOKEN ?? '' : '', GLAB_NO_PROMPT: '1', GH_DEBUG: '', DEBUG: '', GLAB_DEBUG_HTTP: '' };
  }
  private async readGitLabAccounts(cwd: string, signal?: AbortSignal) {
    const command = this.command('glab'); const accounts: GitLabDiscoveredAccount[] = [];
    if (command) try {
      const scan = (args: string[]) => this.tracked(signal, signal => this.execute(cwd, command, args, { signal, timeout: 10_000, limit: 256 * 1024, allowFailure: true, env: { ...this.gitlabEnvironment('gitlab.com'), GITLAB_HOST: '', GITLAB_API_HOST: '', GITLAB_TOKEN: '', GITLAB_ACCESS_TOKEN: '', OAUTH_TOKEN: '' } }));
      let result = await scan(['auth', 'status', '--all']);
      if (result.code !== 0 && /unknown flag.*all|flag provided but not defined.*all/i.test(result.stdout + result.stderr)) result = await scan(['auth', 'status']);
      const output = (result.stdout + '\n' + result.stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      const originalHosts = new Map(output.split(/\r?\n/).filter(v => v === v.trim()).flatMap(v => { try { return [[sourceControlHost(v), v]] as const; } catch { return []; } }));
      for (const row of parseGitLabAuthStatusHosts(output)) {
        let host: string; try { host = sourceControlHost(row.host); } catch { continue; }
        if (!row.account || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(row.account) || ['github.com', 'bitbucket.org'].includes(host) || host.endsWith('.ghe.com')) continue;
        if (!accounts.some(a => a.host === host)) accounts.push({ host, account: row.account, authenticated: true, ...(originalHosts.get(host) !== host ? { cliHost: originalHosts.get(host) } : {}) });
        if (accounts.length >= 32) break;
      }
    } catch {}
    this.glabAccounts = accounts; this.glabExpires = Date.now() + 30_000; return accounts;
  }
  async gitlabHosts(cwd: string, signal?: AbortSignal, scan = true): Promise<string[]> {
    const settings = await this.credentials?.settings();
    const accounts = scan ? await this.gitlabAccounts(cwd, false, signal) : this.glabAccounts;
    let configured: string[] = []; try { if (this.environment.GITLAB_HOST || this.environment.GITLAB_URI || this.environment.GL_HOST) configured = [sourceControlHost(this.environment.GITLAB_HOST || this.environment.GITLAB_URI || this.environment.GL_HOST)]; } catch {}
    return [...new Set(['gitlab.com', ...(settings?.gitlabHosts.map(v => v.host) ?? []), ...accounts.map(v => v.host), ...configured])].filter(host => !['github.com', 'bitbucket.org'].includes(host) && !host.endsWith('.ghe.com'));
  }
  async githubHosts(cwd: string, signal?: AbortSignal, scan = true): Promise<string[]> {
    const settings = await this.credentials?.settings();
    const accounts = scan ? await this.githubAccounts(cwd, false, signal) : this.ghAccounts;
    return [...new Set(['github.com', ...(settings?.githubTokens.map(value => value.host) ?? []), ...(settings?.githubHosts.map(value => value.host) ?? []), ...accounts.map(value => value.host)])];
  }
  githubRepositoryHint() { return this.environment.GH_REPO?.trim() || undefined; }
  async revision() { return (await this.credentials?.settings())?.version ?? 0; }
  async invalidate() { this.ghTokens.clear(); this.accountsExpire = 0; this.glabExpires = 0; this.additionalTransports.invalidate(); this.checks.clear(); await this.reads.invalidate('global'); }
  async repository(cwd: string, remote: string, signal?: AbortSignal): Promise<SourceControlRepository | undefined> {
    const direct = sourceControlRepository(remote); if (direct) return direct;
    const [github, gitlab, forgejo] = await Promise.all([this.githubHosts(cwd, signal), this.gitlabHosts(cwd, signal), this.additionalTransports.forgejoAccounts(cwd, remote, signal).catch(error => { signal?.throwIfAborted(); return []; })]);
    return sourceControlRepository(remote, github, gitlab, forgejo);
  }
  async pinRepository(cwd: string, repository: SourceControlRepository, signal?: AbortSignal): Promise<PinnedSourceControlConnection> {
    if (!isAdditionalSourceControlProvider(repository.provider)) return this.pin(cwd, repository.provider, repository.host, signal);
    if (this.closed) throw new Error('Source Control 连接已关闭'); signal?.throwIfAborted();
    const held = repository.additional;
    if (!held || held.provider !== repository.provider || held.host !== repository.host || held.path !== repository.path) throw new Error('仓库平台身份无效');
    const current = repository.provider === 'forgejo' ? forgejoRepositoryIdentity(held.webURL, await this.additionalTransports.forgejoAccounts(cwd, held.webURL, signal)) : sourceControlRepository(held.webURL)?.additional;
    if (!current || current.canonicalKey !== held.canonicalKey || current.apiBase !== held.apiBase) throw new Error('仓库平台身份已改变，请重新扫描');
    return this.pinAdditional(cwd, current, signal);
  }
  private async pinAdditional(cwd: string, identity: AdditionalRepositoryIdentity, signal?: AbortSignal): Promise<PinnedSourceControlConnection> {
    const http = identity.provider === 'forgejo' ? await this.additionalTransports.forgejo(cwd, identity, signal) : identity.provider === 'gitcafe' ? await this.additionalTransports.gitcafe(cwd, identity, signal) : undefined;
    const azure = identity.provider === 'azure-devops' ? await this.additionalTransports.azureAccount(cwd, signal) : undefined;
    if (azure) identity = { ...identity, account: azure.account };
    const fingerprint = http?.fingerprint ?? azure!.fingerprint;
    const reject = async (): Promise<never> => { throw new Error('此平台必须通过专用 PR 适配器访问'); };
    return { provider: identity.provider, host: identity.host, source: http?.source ?? 'cli', fingerprint, viewer: azure?.account ?? fingerprint,
      additional: new AdditionalSourceControl(cwd, identity, this.additionalTransports, http), json: reject, array: reject };
  }
  private async additionalProviders(cwd: string, signal?: AbortSignal): Promise<PublishProviderStatus[]> {
    const forgejo = this.additionalTransports.forgejoAccounts(cwd, undefined, signal).catch(() => []);
    const azure = this.additionalTransports.azureAccount(cwd, signal).then(value => ({ provider: 'azure-devops' as const, ...definitions['azure-devops'], status: 'ready' as const, account: value.account, credentialFingerprint: value.fingerprint, credentialSource: 'cli' as const })).catch(() => ({ provider: 'azure-devops' as const, ...definitions['azure-devops'], status: this.command('az') ? 'unauthenticated' as const : 'missing' as const, hint: '请在服务主机安装 Azure CLI 与 Azure DevOps 扩展并登录' }));
    const cafe = (async (): Promise<PublishProviderStatus> => {
      try {
        const identity = gitCafeRepositoryIdentity('https://git.cafe/friday/probe')!, pinned = await this.additionalTransports.gitcafe(cwd, identity, signal);
        const auth = await pinned.command?.(['auth', 'status', '--json'], { signal }).catch(error => { signal?.throwIfAborted(); return undefined; });
        const account = (auth?.data as Record<string, unknown> | undefined)?.username;
        return { provider: 'gitcafe', ...definitions.gitcafe, status: accountText(account) ? 'ready' : 'configured', ...(accountText(account) ? { account } : {}), credentialSource: pinned.source, credentialFingerprint: pinned.fingerprint };
      } catch { return { provider: 'gitcafe', ...definitions.gitcafe, status: this.command('cafe') ? 'unauthenticated' : 'missing', hint: '配置 GitCafe Token，或在服务主机登录 cafe' }; }
    })();
    const logins = await forgejo;
    const hosts = [...new Map(logins.map(login => [login.url.replace(/\/+$/, ''), login])).values()];
    const fj = await Promise.all(hosts.map(async (login): Promise<PublishProviderStatus> => {
      const identity = forgejoRepositoryIdentity(login.url.replace(/\/+$/, '') + '/friday/probe', logins, new URL(login.url).host);
      const base = { provider: 'forgejo' as const, ...definitions.forgejo, host: new URL(login.url).host, baseURL: login.url.replace(/\/+$/, '') };
      if (!identity) return { ...base, status: 'unauthenticated', hint: '请检查 Forgejo 默认账号或服务路径配置' };
      try { const pinned = await this.additionalTransports.forgejo(cwd, identity, signal), user = await pinned.json('user', { signal }); if (!accountText(user.login)) throw new Error(); return { ...base, status: 'ready', account: user.login, credentialFingerprint: pinned.fingerprint, credentialSource: pinned.source }; }
      catch { return { ...base, status: 'unauthenticated', hint: '请检查 fj / tea 登录状态' }; }
    }));
    return [...(fj.length ? fj : [{ provider: 'forgejo' as const, ...definitions.forgejo, status: this.command('fj') || this.command('tea') ? 'unauthenticated' as const : 'missing' as const, hint: '请在服务主机安装并登录 fj 或 tea' }]), await cafe, await azure];
  }
  private repositoryTransport(host: string, authorization: string): RepositoryGit {
    return async (directory, repository, args, options = {}) => {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').some(part => ['.', '..'].includes(part))) throw new Error('堆叠 PR 仓库无效');
        const remote = `https://${host}/${repository}.git`;
        const config: [string, string][] = [
          ['http.extraheader', ''], [`http.${remote}.extraheader`, 'AUTHORIZATION: ' + authorization],
          ['credential.helper', ''], ['http.followRedirects', 'false'], ['user.name', 'Friday'], ['user.email', 'noreply@friday.local'],
          ['core.hooksPath', '/dev/null'], ['commit.gpgSign', 'false'], ['core.fsmonitor', 'false'], ['submodule.recurse', 'false'],
        ];
        const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(config.length), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_LFS_SKIP_SMUDGE: '1' };
        config.forEach(([key, value], index) => { env['GIT_CONFIG_KEY_' + index] = key; env['GIT_CONFIG_VALUE_' + index] = value; });
        try { return await this.execute(directory, 'git', ['--no-pager', ...args], { ...options, env, timeout: 120_000, limit: 1024 * 1024 }); }
        catch { throw new Error(options.signal?.aborted ? '堆叠 PR 操作已中断' : '堆叠 PR Git 操作未完成，请刷新平台后核对'); }
    };
  }
  private async githubAccess(cwd: string, host: string, signal?: AbortSignal) {
      if (this.closed) throw new Error('Source Control 连接已关闭'); signal?.throwIfAborted();
      const choice = await this.credentials?.githubChoice(host);
      if (choice?.enabled === false) throw new Error('此 GitHub 主机已在 Source Control 设置中停用');
      const saved = await this.credentials?.githubToken(host);
      const environmentToken = githubEnvironmentToken(host, this.environment);
      const token = saved || environmentToken || await this.fromGh(cwd, host, choice?.account, signal);
      return { token, source: saved ? 'settings' as const : environmentToken ? 'environment' as const : 'gh' as const };
  }
  async githubMediaIdentity(cwd: string, signal?: AbortSignal) {
    try { const access = await this.githubAccess(cwd, 'github.com', signal); return { fingerprint: fingerprint('github.com', access.token) }; }
    catch { signal?.throwIfAborted(); if (this.closed) throw new Error('Source Control 连接已关闭'); return { fingerprint: 'public' }; }
  }
  async githubMedia(cwd: string, url: string, expectedFingerprint: string, expires: number, request: GitHubMediaRequest) {
    if (this.closed || githubMediaFetchUrl(url) !== url) throw new Error('GitHub 媒体来源无效'); request.signal?.throwIfAborted();
    let token: string | null = null;
    try { token = (await this.githubAccess(cwd, 'github.com', request.signal)).token; } catch { request.signal?.throwIfAborted(); if (this.closed) throw new Error('Source Control 连接已关闭'); }
    if ((token ? fingerprint('github.com', token) : 'public') !== expectedFingerprint) throw new Error('GitHub 媒体账号已改变，请刷新预览');
    if (this.closed) throw new Error('Source Control 连接已关闭');
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, ...(request.signal ? [request.signal] : [])]);
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; }); this.controllers.add(controller); this.pending.add(pending);
    const timeout = setTimeout(() => controller.abort(new Error('GitHub 媒体连接超时')), 30_000);
    const finished = () => { clearTimeout(timeout); this.controllers.delete(controller); this.pending.delete(pending); release(); };
    return githubMediaResponse(url, token, { ...request, signal }, { fetch: this.request, expires, headersReady: () => clearTimeout(timeout), finished });
  }
  async pin(cwd: string, provider: PublishProvider, host: string = definitions[provider].host, signal?: AbortSignal): Promise<PinnedSourceControlConnection> {
    if (this.closed) throw new Error('Source Control 连接已关闭'); signal?.throwIfAborted();
    if (isAdditionalSourceControlProvider(provider)) throw new Error('此平台需要明确的仓库和服务路径');
    if (provider === 'github') {
      host = sourceControlHost(host);
      const { token, source } = await this.githubAccess(cwd, host, signal);
      const scope = fingerprint(host, token);
      const base = host === 'github.com' ? 'https://api.github.com/' : host.endsWith('.ghe.com') ? `https://api.${host}/` : `https://${host}/api/v3/`;
      const pinned = this.bound(provider, host, source, (path, options) => this.http(base, 'Bearer ' + token, path, options, true, { host, scope }), token);
      const graphqlBase = host === 'github.com' || host.endsWith('.ghe.com') ? base : `https://${host}/api/`;
      pinned.graphqlRaw = async (query, variables, signal) => {
        const value = await this.policy.request({ provider, host, scope }, { resource: 'graphql', signal, interactive: sourceControlInteractive() || /^\s*mutation\b/.test(query) }, signal => this.http(graphqlBase, 'Bearer ' + token, 'graphql', { method: 'POST', body: { query, variables }, signal, maxResponseBytes: 8 * 1024 * 1024 }, true, { host, scope })) as Record<string, unknown>;
        return value;
      };
      pinned.graphql = async (query, variables, signal) => {
        const value = await pinned.graphqlRaw!(query, variables, signal);
        if (value.errors || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new Error('GitHub GraphQL 请求未完成，请检查权限和连接');
        return value.data as Record<string, unknown>;
      };
      pinned.repositoryGit = this.repositoryTransport(host, 'basic ' + Buffer.from('x-access-token:' + token).toString('base64'));
      return pinned;
    }
    if (provider === 'bitbucket') {
      const saved = await this.credentials?.bitbucket();
      let authorization: string | undefined;
      if (headerSafe(saved?.accessToken)) authorization = 'Bearer ' + saved.accessToken;
      else if (headerSafe(saved?.email) && headerSafe(saved?.apiToken)) authorization = 'Basic ' + Buffer.from(saved.email + ':' + saved.apiToken).toString('base64');
      else if (headerSafe(this.environment.FRIDAY_BITBUCKET_ACCESS_TOKEN)) authorization = 'Bearer ' + this.environment.FRIDAY_BITBUCKET_ACCESS_TOKEN;
      else if (headerSafe(this.environment.FRIDAY_BITBUCKET_EMAIL) && headerSafe(this.environment.FRIDAY_BITBUCKET_API_TOKEN)) authorization = 'Basic ' + Buffer.from(this.environment.FRIDAY_BITBUCKET_EMAIL + ':' + this.environment.FRIDAY_BITBUCKET_API_TOKEN).toString('base64');
      if (!authorization) throw new Error('请在 Source Control 设置中配置 Bitbucket 凭据');
      const pinned = this.bound(provider, 'bitbucket.org', saved?.accessToken || saved?.apiToken ? 'settings' : 'environment', (path, options) => this.http('https://api.bitbucket.org/2.0/', authorization, path, options), authorization);
      pinned.repositoryGit = this.repositoryTransport('bitbucket.org', authorization); return pinned;
    }
    host = sourceControlHost(host);
    const choice = await this.credentials?.gitlabChoice(host);
    if (choice?.enabled === false) throw new Error('此 GitLab 主机已在 Source Control 设置中停用');
    if (host !== 'gitlab.com' && !(await this.gitlabHosts(cwd, signal)).includes(host)) throw new Error('请先在 Source Control 中添加或通过 glab 登录此 GitLab 主机');
    const cliHost = this.glabAccounts.find(v => v.host === host)?.cliHost ?? host;
    const gitlabEnv = { ...this.gitlabEnvironment(host), GITLAB_HOST: cliHost };
    const definition = definitions[provider]; const command = this.command(definition.command);
    if (!command) throw new Error(`请安装并登录 ${definition.command}`);
    const credential = [gitlabEnv.GITLAB_TOKEN, gitlabEnv.GITLAB_ACCESS_TOKEN, gitlabEnv.OAUTH_TOKEN].find(headerSafe);
    const pinned = this.bound(provider, host, 'cli', (path, options) => this.tracked(options.signal, async signal => {
      if (options.accept) throw new Error('Source Control Diff 请求无效');
      if (!path || path.startsWith('/') || path.includes('://') || path.split('/').includes('..') || /[\x00-\x1f]/.test(path)) throw new Error('GitLab 请求路径无效');
      const args = ['api', '--hostname', cliHost, ...(options.method && options.method !== 'GET' ? ['--method', options.method] : []), path];
      if (options.jsonBody && options.body) args.push('--input', '-');
      else if (options.body) {
        for (const [key, value] of Object.entries(options.body)) args.push('--raw-field', key + '=' + String(value));
      }
      let result;
      try { result = await this.execute(cwd, command, args, { signal, allowFailure: true, ...(options.jsonBody && options.body ? { input: JSON.stringify(options.body) } : {}), timeout: options.timeoutMs ?? 30_000, limit: Math.min(options.maxResponseBytes ?? 256 * 1024, 8 * 1024 * 1024), env: gitlabEnv }); }
      catch { throw new Error('Source Control CLI 请求未完成，请检查登录和连接'); }
      if (result.code !== 0) { const status = /\bHTTP\s+([1-5][0-9]{2})\b/i.exec(result.stderr); if (status) throw new SourceControlHTTPError(Number(status[1]), 'Source Control CLI 请求未完成'); throw new Error('Source Control CLI 请求未完成，请检查登录和连接'); }
      if (options.responseType === 'text') return result.stdout;
      if (options.allowEmpty && !result.stdout.trim()) return {};
      let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new Error('Source Control 返回结果无效'); }
      if (!value || typeof value !== 'object') throw new Error('Source Control 返回结果无效');
      return value;
    }, options.timeoutMs), credential);
    const runMergeAction = async (repository: string, number: number, action: 'merge' | 'update-branch' | 'enable-auto-merge', method: string, parentSignal?: AbortSignal) => {
      if (!/^[\w.-]+(?:\/[\w.-]+)+$/.test(repository) || !Number.isSafeInteger(number) || number < 1 || !['merge', 'squash', 'rebase'].includes(method) || !['merge', 'update-branch', 'enable-auto-merge'].includes(action)) throw new Error('GitLab 操作目标无效');
      const args = action === 'update-branch' ? ['mr', 'rebase', String(number), '--repo', `https://${cliHost}/${repository}`]
        : ['mr', 'merge', String(number), '--repo', `https://${cliHost}/${repository}`, action === 'enable-auto-merge' ? '--auto-merge=true' : '--auto-merge=false', '--yes', ...(method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : [])];
      await this.policy.request({ provider, host, scope: pinned.fingerprint ?? '' }, { signal: parentSignal, interactive: true }, signal => this.tracked(signal, async signal => {
        try { const result = await this.execute(cwd, command, args, { signal, timeout: 30_000, limit: 256 * 1024, env: gitlabEnv, allowFailure: true }); if (result.code !== 0) { const status = /\bHTTP\s+([1-5][0-9]{2})\b/i.exec(result.stderr)?.[1]; if (status) throw new SourceControlHTTPError(Number(status), 'GitLab 操作结果尚未确认，请在平台核对'); throw new Error(); } }
        catch (error) { if (error instanceof SourceControlHTTPError) throw error; throw new Error('GitLab 操作结果尚未确认，请在平台核对'); }
      }));
    };
    pinned.mergeGitLab = (repository, number, method, signal) => runMergeAction(repository, number, 'merge', method, signal);
    pinned.gitLabBranchAction = runMergeAction;
    return pinned;
  }
  async probe(cwd: string, provider: PublishProvider, host: string = definitions[provider].host): Promise<PublishProviderStatus> {
    if (isAdditionalSourceControlProvider(provider)) { const values = await this.additionalProviders(cwd); return values.find(value => value.provider === provider && (!host || value.host === host)) ?? { provider, ...definitions[provider], host, status: 'unauthenticated' }; }
    const definition = { ...definitions[provider], host }; let pinned: PinnedSourceControlConnection;
    try { pinned = await this.pin(cwd, provider, host); }
    catch (error) {
      const disabled = error instanceof Error && error.message.includes('已在 Source Control');
      return { provider, ...definition, status: !disabled && provider !== 'bitbucket' && !this.command(definition.command) ? 'missing' : 'unauthenticated', hint: disabled ? error.message : provider === 'bitbucket' ? '请在 Source Control 设置中配置 Bitbucket 凭据' : provider === 'github' ? '请在服务主机安装并登录 gh，或配置 GitHub Token' : '请在服务主机安装并登录 glab' };
    }
    try {
      const user = await pinned.json('user');
      const account = provider === 'github' ? user.login : provider === 'gitlab' ? user.username : user.username ?? user.display_name ?? user.account_id ?? user.uuid;
      if (!accountText(account)) throw new Error('Invalid account');
      return { provider, ...definition, status: 'ready', account, credentialSource: pinned.source, ...(pinned.fingerprint ? { credentialFingerprint: pinned.fingerprint } : {}) };
    } catch (error) {
      if (sourceControlRateFailure(error) && pinned.fingerprint) return { provider, ...definition, status: 'configured', credentialSource: pinned.source, credentialFingerprint: pinned.fingerprint, hint: '平台请求受到限流，凭据已保留，请稍后刷新' };
      // Workspace-scoped Bitbucket tokens may create repos without /user scope.
      if (provider === 'bitbucket' && pinned.fingerprint) return { provider, ...definition, status: 'configured', account: 'Bitbucket', credentialFingerprint: pinned.fingerprint, hint: 'Bitbucket 凭据已配置，尚未确认账号；工作区 Token 可能没有用户读取权限' };
      return { provider, ...definition, status: 'unauthenticated', hint: '无法确认平台登录状态，请检查凭据、权限和主机连接后刷新' };
    }
  }
  async discover(cwd: string): Promise<PublishProviderStatus[]> { const [old, added] = await Promise.all([Promise.all((['github', 'gitlab', 'bitbucket'] as const).map(provider => this.probe(cwd, provider))), this.additionalProviders(cwd)]); return [...old, ...added]; }
  async discovery(cwd: string) {
    await this.invalidate();
    const settings = await this.credentials?.settings();
    const [githubAccounts, gitlabAccounts] = await Promise.all([this.githubAccounts(cwd, true), this.gitlabAccounts(cwd, true)]);
    const hosts = [...new Set([...(settings?.githubTokens.map(value => value.host) ?? []), ...(settings?.githubHosts.map(value => value.host) ?? []), ...githubAccounts.map(value => value.host)])].filter(host => host !== 'github.com');
    const labHosts = (await this.gitlabHosts(cwd, undefined, false)).filter(host => host !== 'gitlab.com');
    const [providers, githubHosts, gitlabHosts] = await Promise.all([this.discover(cwd), Promise.all(hosts.map(host => this.probe(cwd, 'github', host))), Promise.all(labHosts.map(host => this.probe(cwd, 'gitlab', host)))]);
    return { providers, githubHosts, githubAccounts, gitlabHosts, gitlabAccounts, ...(this.githubAccountHint ? { githubAccountHint: this.githubAccountHint } : {}) };
  }
  async close() { this.closed = true; for (const controller of this.controllers) controller.abort(); await Promise.allSettled([...this.pending, this.additionalTransports.close(), this.policy.close(), this.checks.close(), this.summaries.close(), this.reads.close()]); await this.credentials?.close(); }
}
