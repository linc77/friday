// Wire fields, account-source precedence and endpoint guards follow T3 Code
// 8cd9641f packages/provider-{cursor,grok,opencode}/src/server/usageLimits.ts.
// MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
import { readFile } from 'node:fs/promises';
import { execFile, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { providerDigest, type ProviderUsageLimits, type ProviderUsageWindow } from './provider-usage-limits.js';

type UsageOptions = { fetch?: typeof fetch; readKeychain?: () => Promise<string | undefined>; platform?: NodeJS.Platform; signal?: AbortSignal; grokSystemConfigPaths?: string[] };
const object = (value: unknown): Record<string, any> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const percent = (value: number) => Math.max(0, Math.min(100, value));
const checked = () => new Date().toISOString();
const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const unavailable = (reason: 'unsupported' | 'probeFailed', message?: string): ProviderUsageLimits => ({ checkedAt: checked(), windows: [], unavailable: { reason, ...(message ? { message } : {}) } });
async function file(path: string) {
  try { const value = await readFile(path, 'utf8'); if (value.length > 1024 * 1024) throw new Error('Credential file exceeds its read budget'); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '{}'; throw error; }
}
async function json(url: string, token: string, method: 'GET' | 'POST', options: UsageOptions, headers: Record<string, string> = {}) {
  const response = await (options.fetch ?? fetch)(url, { method, headers: { Authorization: 'Bearer ' + token, ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}), redirect: 'error', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  if (response.status === 403 && url === 'https://opencode.ai/zen/go/v1/usage') return undefined;
  if (!response.ok) throw new Error('Usage endpoint refused the read');
  const body = await response.text(); if (body.length > 1024 * 1024) throw new Error('Usage response exceeds its read budget');
  return JSON.parse(body) as unknown;
}

export function cursorUsageResponse(input: unknown, checkedAt = checked()): ProviderUsageLimits {
  if (!object(input)) throw new Error('Invalid Cursor usage response');
  const body = object(input), usage = object(body?.planUsage), end = Number(body?.billingCycleEnd), resetsAt = end > 0 && Number.isFinite(end) && Math.abs(end) <= 8.64e15 ? new Date(end).toISOString() : undefined;
  const windows: ProviderUsageWindow[] = [];
  for (const [id, label] of [['totalPercentUsed', 'Overall'], ['autoPercentUsed', 'Cursor Models'], ['apiPercentUsed', 'Other Models']]) {
    const value = usage?.[id]; if (finite(value)) windows.push({ id, label, kind: 'monthly', usedPercent: percent(value), windowDurationMins: 0, ...(resetsAt ? { resetsAt } : {}) });
  }
  return windows.length ? { checkedAt, windows } : { ...unavailable('unsupported'), checkedAt };
}
export function grokUsageResponse(input: unknown, checkedAt = checked()): ProviderUsageLimits {
  if (!object(input)) throw new Error('Invalid Grok usage response');
  const config = object(object(input)?.config), used = config?.creditUsagePercent;
  if (used !== undefined && !finite(used)) throw new Error('Invalid Grok percentage');
  if (used === undefined) return { checkedAt, windows: [], available: true };
  const period = object(config?.currentPeriod), type = typeof period?.type === 'string' ? period.type.replace(/^USAGE_PERIOD_TYPE_/, '') : '', kind = type === 'WEEKLY' ? 'weekly' : type === 'MONTHLY' ? 'monthly' : 'other', resetsAt = iso(period?.end);
  return { checkedAt, windows: [{ id: 'subscription', kind, label: kind === 'weekly' ? 'Weekly' : kind === 'monthly' ? 'Monthly' : 'Subscription', usedPercent: percent(used), windowDurationMins: kind === 'weekly' ? 7 * 24 * 60 : 0, ...(resetsAt ? { resetsAt } : {}) }] };
}
export function openCodeUsageResponse(input: unknown, checkedAt = checked()): ProviderUsageLimits {
  const usage = object(object(input)?.usage), windows: ProviderUsageWindow[] = [];
  for (const [key, kind, label, duration] of [['rolling', 'session', 'Go · Session', 300], ['weekly', 'weekly', 'Go · Weekly', 10080], ['monthly', 'monthly', 'Go · Monthly', 0]] as const) {
    const value = object(usage?.[key]), resetsAt = iso(value?.resetsAt);
    if (!finite(value?.percent) || !resetsAt) throw new Error('Invalid OpenCode Go usage window');
    windows.push({ id: 'go_' + key, kind, label, usedPercent: percent(value.percent), windowDurationMins: duration, resetsAt });
  }
  return { checkedAt, windows };
}

/** One native Keychain request may remain on the host's screen after the HTTP
 * wait ends. Other instances join it; closing the last owner closes its child. */
class CursorKeychainRead {
  private owners = new Set<object>();
  private pending?: Promise<string | undefined>;
  private cached?: { token: string; until: number };
  private child?: ChildProcess;
  async read(owner: object) {
    this.owners.add(owner);
    if (this.cached && this.cached.until > Date.now()) return this.cached.token;
    if (!this.pending) {
      const pending = new Promise<string | undefined>((resolve, reject) => {
        this.child = execFile('/usr/bin/security', ['find-generic-password', '-s', 'cursor-access-token', '-a', 'cursor-user', '-w'], { maxBuffer: 128 * 1024 }, (error, stdout) => {
          if (error) reject(new Error('Cursor Keychain read did not complete'));
          else { const token = stdout.trim() || undefined; this.cached = token ? { token, until: Date.now() + 300_000 } : undefined; resolve(token); }
        });
      }).finally(() => { if (this.pending === pending) { this.pending = undefined; this.child = undefined; } });
      this.pending = pending; void pending.catch(() => {});
    }
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([this.pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cursor Keychain read is awaiting host consent')), 10_000); })]); }
    finally { clearTimeout(timer); }
  }
  release(owner: object) { this.owners.delete(owner); if (!this.owners.size) { this.cached = undefined; this.child?.kill('SIGTERM'); } }
}
const keychain = new CursorKeychainRead();
export const releaseCursorUsage = (owner: object) => keychain.release(owner);
export async function readCursorUsage(environment: NodeJS.ProcessEnv, allowKeychain: boolean, owner: object, options: UsageOptions = {}): Promise<ProviderUsageLimits> {
  try {
    options.signal?.throwIfAborted();
    const endpoint = (environment.CURSOR_API_ENDPOINT?.trim() || 'https://api2.cursor.sh').replace(/\/$/, ''), url = new URL(endpoint);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return unavailable('unsupported');
    let token = environment.CURSOR_AUTH_TOKEN?.trim();
    if (!token && environment.CURSOR_API_KEY?.trim()) return unavailable('unsupported');
    if (!token && environment.AGENT_CLI_CREDENTIAL_STORE === 'memory') return unavailable('unsupported');
    const platform = options.platform ?? process.platform;
    if (!token && platform === 'darwin' && environment.AGENT_CLI_CREDENTIAL_STORE !== 'file') {
      if (!allowKeychain || endpoint !== 'https://api2.cursor.sh') return unavailable('unsupported', '请在主机启用 Cursor CLI 账号额度，或配置 CURSOR_AUTH_TOKEN');
      token = await (options.readKeychain ? options.readKeychain() : keychain.read(owner));
    } else if (!token) {
      const home = (platform === 'win32' ? environment.USERPROFILE : environment.HOME) || homedir();
      const directory = platform === 'win32' ? join(environment.APPDATA || join(home, 'AppData', 'Roaming'), 'Cursor') : platform === 'darwin' ? join(home, '.cursor') : join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'cursor');
      token = object(JSON.parse(await file(join(directory, 'auth.json'))))?.accessToken?.trim();
    }
    if (!token) return unavailable('unsupported');
    const body = await json(endpoint + '/aiserver.v1.DashboardService/GetCurrentPeriodUsage', token, 'POST', options, { 'connect-protocol-version': '1', 'x-cursor-client-type': 'cli' });
    return { ...cursorUsageResponse(body), sourceLabel: 'Cursor CLI', credentialFingerprint: providerDigest(['cursor-cli', token]) };
  } catch { return unavailable('probeFailed', 'Cursor 账号额度暂时无法读取'); }
}

export async function readGrokUsage(environment: NodeJS.ProcessEnv, options: UsageOptions = {}): Promise<ProviderUsageLimits> {
  try {
    options.signal?.throwIfAborted();
    if (environment.XAI_API_KEY?.trim() || ['GROK_OIDC_ISSUER', 'GROK_OIDC_CLIENT_ID', 'GROK_OAUTH2_ISSUER', 'GROK_OAUTH2_CLIENT_ID', 'GROK_OAUTH2_PRINCIPAL_TYPE', 'GROK_OAUTH2_PRINCIPAL_ID', 'GROK_AUTH_PROVIDER_COMMAND', 'GROK_LOCAL_AUTH', 'GROK_CLI_CHAT_PROXY_BASE_URL', 'GROK_MODELS_BASE_URL', 'GROK_CONFIG', 'GROK_CONFIG_PATH'].some(key => environment[key]?.trim())) return unavailable('unsupported');
    const home = environment.GROK_HOME?.trim() || join(environment.HOME || environment.USERPROFILE || homedir(), '.grok');
    for (const path of [join(home, 'config.toml'), join(home, 'managed_config.toml'), join(home, 'requirements.toml'), ...(options.grokSystemConfigPaths ?? ['/etc/grok/managed_config.toml', '/etc/grok/requirements.toml'])]) {
      if (/^\s*(?:\[\[?\s*)?["']?(?:auth|grok_com_config|endpoints)["']?\s*[.\]=]/m.test(await file(path))) return unavailable('unsupported');
    }
    const credentials = object(JSON.parse(environment.GROK_AUTH?.trim() || await file(join(home, 'auth.json')))), credential = object(credentials?.['https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828'] ?? credentials?.['https://accounts.x.ai/sign-in']);
    const token = typeof credential?.key === 'string' && credential.auth_mode !== 'api_key' ? credential.key.trim() : undefined;
    if (!token) return unavailable('unsupported');
    const body = await json('https://cli-chat-proxy.grok.com/v1/billing?format=credits', token, 'GET', options);
    return { ...grokUsageResponse(body), credentialFingerprint: providerDigest(['grok', token]) };
  } catch { return unavailable('probeFailed', 'Grok 账号额度暂时无法读取'); }
}
export async function readOpenCodeUsage(enabled: boolean, serverUrl: string, environment: NodeJS.ProcessEnv, options: UsageOptions = {}): Promise<ProviderUsageLimits> {
  if (!enabled || serverUrl.trim()) return unavailable('unsupported');
  try {
    options.signal?.throwIfAborted();
    const data = environment.XDG_DATA_HOME || join(environment.HOME || environment.USERPROFILE || homedir(), '.local', 'share'), auth = object(JSON.parse(environment.OPENCODE_AUTH_CONTENT || await file(join(data, 'opencode', 'auth.json')))), stored = object(auth?.['opencode-go']);
    const token = (stored?.type === 'api' && typeof stored.key === 'string' ? stored.key : environment.OPENCODE_API_KEY)?.trim();
    if (!token) return unavailable('unsupported');
    const body = await json('https://opencode.ai/zen/go/v1/usage', token, 'GET', options);
    return body === undefined ? unavailable('unsupported') : { ...openCodeUsageResponse(body), credentialFingerprint: providerDigest(['opencode-go', token]) };
  } catch { return unavailable('probeFailed', 'OpenCode Go 额度暂时无法读取'); }
}
