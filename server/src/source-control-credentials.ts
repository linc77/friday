import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

type BitbucketSettings = { accessToken: string; email: string; apiToken: string };
export type GitHubHostChoice = { enabled: boolean; account?: string };
type SavedCredentials = {
  schemaVersion: 1; version: number; githubTokens: Record<string, string>; bitbucket: BitbucketSettings;
  requests: Record<string, string>;
  githubHosts?: Record<string, GitHubHostChoice>;
  gitlabHosts?: Record<string, { enabled: boolean }>;
  gitCafeToken?: string;
};
export type SourceControlCredentialSettings = {
  version: number; githubTokens: { host: string }[];
  bitbucket: { hasAccessToken: boolean; email: string; hasAPIToken: boolean };
  githubHosts: ({ host: string } & GitHubHostChoice)[];
  gitlabHosts: { host: string; enabled: boolean }[];
  gitcafe: { hasToken: boolean };
};
export type SourceControlCredentialPatch = {
  version: number; requestId: string;
  githubToken?: { host: string; token: string };
  githubHost?: { host: string; enabled?: boolean; account?: string | null };
  gitlabHost?: { host: string; enabled: boolean | null };
  bitbucket?: Partial<BitbucketSettings>;
  gitCafeToken?: string;
};
export class SourceControlCredentialConflict extends Error {}
const empty = (): SavedCredentials => ({ schemaVersion: 1, version: 0, githubTokens: {}, githubHosts: {}, gitlabHosts: {}, bitbucket: { accessToken: '', email: '', apiToken: '' }, requests: {} });
const secret = (value: unknown) => typeof value === 'string' && value.length <= 8192 && (value === '' || /^[\x21-\x7e]+$/.test(value));
export function sourceControlHost(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Source Control 主机名无效');
  const host = raw.trim().toLowerCase();
  if (host.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/.test(host) || host.includes('..')) throw new Error('Source Control 主机名无效');
  try { const url = new URL('https://' + host); if (url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error(); return url.host; }
  catch { throw new Error('Source Control 主机名无效'); }
}
export function sourceControlCredentialPatch(raw: unknown): SourceControlCredentialPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Source Control 设置无效');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['version', 'requestId', 'githubToken', 'githubHost', 'gitlabHost', 'bitbucket', 'gitCafeToken'].includes(key)) || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value.requestId) || ['__proto__', 'constructor', 'prototype'].includes(value.requestId)) throw new Error('Source Control 设置版本或请求无效');
  const patch: SourceControlCredentialPatch = { version: Number(value.version), requestId: value.requestId };
  if (value.githubToken !== undefined) {
    const token = value.githubToken as Record<string, unknown>;
    if (!token || typeof token !== 'object' || Array.isArray(token) || Object.keys(token).some(key => !['host', 'token'].includes(key)) || !secret(token.token)) throw new Error('GitHub Token 无效');
    patch.githubToken = { host: sourceControlHost(token.host), token: token.token as string };
  }
  if (value.githubHost !== undefined) {
    const host = value.githubHost as Record<string, unknown>;
    if (!host || typeof host !== 'object' || Array.isArray(host) || Object.keys(host).some(key => !['host', 'enabled', 'account'].includes(key)) || host.enabled !== undefined && typeof host.enabled !== 'boolean' || host.account !== undefined && host.account !== null && (typeof host.account !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/.test(host.account)) || host.enabled === undefined && host.account === undefined) throw new Error('GitHub 账号路由设置无效');
    patch.githubHost = { host: sourceControlHost(host.host), ...(host.enabled !== undefined ? { enabled: host.enabled as boolean } : {}), ...(host.account !== undefined ? { account: host.account as string | null } : {}) };
  }
  if (value.gitlabHost !== undefined) {
    const input = value.gitlabHost as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['host', 'enabled'].includes(k)) || input.enabled !== null && typeof input.enabled !== 'boolean') throw new Error('GitLab 主机设置无效');
    const host = sourceControlHost(input.host);
    if (host === 'github.com' || host === 'bitbucket.org' || host.endsWith('.ghe.com')) throw new Error('此主机已属于其他仓库平台');
    patch.gitlabHost = { host, enabled: input.enabled as boolean | null };
  }
  if (value.bitbucket !== undefined) {
    const settings = value.bitbucket as Record<string, unknown>;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['accessToken', 'email', 'apiToken'].includes(key))) throw new Error('Bitbucket 设置无效');
    patch.bitbucket = {};
    for (const key of ['accessToken', 'email', 'apiToken'] as const) if (settings[key] !== undefined) {
      const field = settings[key];
      if (!secret(field) || key === 'email' && field !== '' && (String(field).length > 320 || !/^[^\s@]+@[^\s@]+$/.test(String(field)))) throw new Error('Bitbucket 凭据无效');
      patch.bitbucket[key] = field as string;
    }
  }
  if (value.gitCafeToken !== undefined) { if (!secret(value.gitCafeToken)) throw new Error('GitCafe Token 无效'); patch.gitCafeToken = value.gitCafeToken as string; }
  if (!patch.githubToken && !patch.githubHost && !patch.gitlabHost && !patch.bitbucket && patch.gitCafeToken === undefined) throw new Error('没有需要保存的 Source Control 设置');
  return patch;
}

function redacted(value: SavedCredentials): SourceControlCredentialSettings {
  return { version: value.version, gitcafe: { hasToken: !!value.gitCafeToken }, githubTokens: Object.keys(value.githubTokens).sort().map(host => ({ host })),
    githubHosts: Object.entries(value.githubHosts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([host, choice]) => ({ host, ...choice })),
    gitlabHosts: Object.entries(value.gitlabHosts ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([host, choice]) => ({ host, ...choice })),
    bitbucket: { hasAccessToken: !!value.bitbucket.accessToken, email: value.bitbucket.email, hasAPIToken: !!value.bitbucket.apiToken } };
}

// Engine's exclusive directory lease owns this file. It is deliberately outside
// the Durable document: snapshots, task history and events never contain secrets.
export class SourceControlCredentials {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly directory: string) { this.file = join(directory, 'source-control-credentials.json'); }
  private async load(): Promise<SavedCredentials> {
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty(); throw new Error('无法读取 Source Control 私有设置'); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error();
      await handle.chmod(0o600);
      const value = JSON.parse(await handle.readFile('utf8')) as SavedCredentials;
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.version) || value.version < 0 || !value.githubTokens || typeof value.githubTokens !== 'object' || Array.isArray(value.githubTokens) || !value.bitbucket || typeof value.bitbucket !== 'object' || Array.isArray(value.bitbucket) || !value.requests || typeof value.requests !== 'object' || Array.isArray(value.requests)) throw new Error();
      if (['accessToken', 'email', 'apiToken'].some(key => typeof value.bitbucket[key as keyof BitbucketSettings] !== 'string')) throw new Error();
      if (value.gitCafeToken !== undefined && !secret(value.gitCafeToken)) throw new Error();
      value.githubHosts ??= {}; value.gitlabHosts ??= {};
      if (typeof value.gitlabHosts !== 'object' || Array.isArray(value.gitlabHosts) || Object.keys(value.gitlabHosts).length > 32 || Object.entries(value.gitlabHosts).some(([host, choice]) => sourceControlHost(host) !== host || ['github.com', 'bitbucket.org'].includes(host) || host.endsWith('.ghe.com') || !choice || typeof choice.enabled !== 'boolean')) throw new Error();
      if (typeof value.githubHosts !== 'object' || Array.isArray(value.githubHosts) || Object.keys(value.githubHosts).length > 32 || Object.entries(value.githubHosts).some(([host, choice]) => sourceControlHost(host) !== host || !choice || typeof choice.enabled !== 'boolean' || choice.account !== undefined && (typeof choice.account !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,99}$/.test(choice.account)))) throw new Error();
      if (Object.keys(value.githubTokens).length > 32 || Object.entries(value.githubTokens).some(([host, token]) => sourceControlHost(host) !== host || !token || !secret(token)) || Object.values(value.bitbucket).some(field => !secret(field))) throw new Error();
      return value;
    } catch { throw new Error('Source Control 私有设置无法读取，请检查主机数据目录'); }
    finally { await handle.close(); }
  }
  async settings(): Promise<SourceControlCredentialSettings> { await this.chain; return redacted(await this.load()); }
  async githubToken(host: string): Promise<string | undefined> { await this.chain; const saved = await this.load(); return Object.hasOwn(saved.githubTokens, host) ? saved.githubTokens[host] : undefined; }
  async bitbucket(): Promise<BitbucketSettings> { await this.chain; return (await this.load()).bitbucket; }
  async gitCafeToken(): Promise<string | undefined> { await this.chain; return (await this.load()).gitCafeToken || undefined; }
  async githubChoice(host: string): Promise<GitHubHostChoice | undefined> { await this.chain; const saved = await this.load(); return Object.hasOwn(saved.githubHosts!, host) ? saved.githubHosts![host] : undefined; }
  async gitlabChoice(host: string): Promise<{ enabled: boolean } | undefined> { await this.chain; const saved = await this.load(); return Object.hasOwn(saved.gitlabHosts!, host) ? saved.gitlabHosts![host] : undefined; }
  update(raw: unknown): Promise<SourceControlCredentialSettings> {
    const patch = sourceControlCredentialPatch(raw);
    const run = this.chain.then(async () => {
      if (this.closed) throw new Error('Source Control 设置正在关闭');
      const saved = await this.load(); const digest = createHash('sha256').update(JSON.stringify(patch)).digest('hex');
      if (Object.hasOwn(saved.requests, patch.requestId)) {
        if (saved.requests[patch.requestId] !== digest) throw new SourceControlCredentialConflict('Source Control 请求已使用，请重新载入设置');
        return redacted(saved);
      }
      if (saved.version !== patch.version) throw new SourceControlCredentialConflict('Source Control 设置已被其他设备修改，请重新载入');
      const githubHost = patch.githubToken?.host ?? patch.githubHost?.host;
      if (githubHost && (githubHost === 'gitlab.com' || Object.hasOwn(saved.gitlabHosts!, githubHost))) throw new Error('此主机已属于 GitLab，请先移除冲突的主机设置');
      if (patch.gitlabHost?.enabled !== null && patch.gitlabHost && (Object.hasOwn(saved.githubTokens, patch.gitlabHost.host) || Object.hasOwn(saved.githubHosts!, patch.gitlabHost.host) || githubHost === patch.gitlabHost.host)) throw new Error('此主机已属于 GitHub，请先移除冲突的主机设置');
      if (patch.gitlabHost) {
        const { host, enabled } = patch.gitlabHost;
        if (enabled === null) delete saved.gitlabHosts![host]; else saved.gitlabHosts![host] = { enabled };
        if (Object.keys(saved.gitlabHosts!).length > 32) throw new Error('最多保存 32 个 GitLab 主机');
      }
      if (patch.githubToken) {
        if (patch.githubToken.token) saved.githubTokens[patch.githubToken.host] = patch.githubToken.token;
        else delete saved.githubTokens[patch.githubToken.host];
        if (Object.keys(saved.githubTokens).length > 32) throw new Error('最多保存 32 个 GitHub 主机');
      }
      if (patch.bitbucket) Object.assign(saved.bitbucket, patch.bitbucket);
      if (patch.gitCafeToken !== undefined) saved.gitCafeToken = patch.gitCafeToken;
      if (patch.githubHost) {
        const { host, enabled, account } = patch.githubHost;
        const choice = saved.githubHosts![host] ?? { enabled: true };
        if (enabled !== undefined) choice.enabled = enabled;
        if (account === null) delete choice.account; else if (account !== undefined) choice.account = account;
        saved.githubHosts![host] = choice;
        if (Object.keys(saved.githubHosts!).length > 32) throw new Error('最多保存 32 个 GitHub 主机');
      }
      saved.version++; saved.requests[patch.requestId] = digest;
      const requests = Object.keys(saved.requests); for (const id of requests.slice(0, Math.max(0, requests.length - 64))) delete saved.requests[id];
      const temporary = this.file + '.' + randomUUID() + '.tmp';
      try { await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.file); }
      catch { throw new Error('无法保存 Source Control 私有设置，请检查主机数据目录'); }
      finally { await rm(temporary, { force: true }); }
      return redacted(saved);
    });
    this.chain = run.catch(() => {}); return run;
  }
  async close() { this.closed = true; await this.chain; }
}
