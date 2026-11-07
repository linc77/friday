// Adapted from T3 Code 8cd9641f, usage/cliproxyApi.ts (MIT, T3 Tools Inc.).
// Full license: provider-usage-limits.ts. No provider token leaves the hub.
import { createHash } from 'node:crypto';
import { codexUsageLimits, codexSubscriptionLabel, claudeUsageLimits, unavailableUsageLimits, providerDigest, type ProviderUsageLimits, type ProviderResetOutcome } from './provider-usage-limits.js';
export type UsageSourceConfig = { kind: 'cliproxy'; label?: string; url: string; managementKey: string; enabled: boolean };
export type UsageSourceAccount = { id: string; driver: 'codex' | 'claude'; email?: string; plan?: string; workspaceId?: string; credentialFingerprint: string; usageLimits: ProviderUsageLimits };
export type UsageSourceSnapshot = { id: string; kind: 'cliproxy'; label: string; checkedAt: string; accounts: UsageSourceAccount[]; error?: string };
type AuthFile = { id: string; auth_index: string; provider: string; email?: string; disabled?: boolean; id_token?: { chatgpt_account_id?: string; chatgpt_plan_type?: string } };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);
const stamp = () => new Date().toISOString();
const BASE = 'https://chatgpt.com/backend-api/wham';
export const sourceAccountFingerprint = (account: AuthFile) => providerDigest([account.provider, account.id, account.email ?? null, account.id_token?.chatgpt_account_id ?? null]);
export function creditRedeemRequestId(accountId: string, creditId: string) {
  const namespace = Buffer.from([0x6f,0x1c,0x2a,0x9e,0x2d,0x4b,0x4c,0x1e,0x9a,0x7f,0x3b,0x8d,0x5e,0x0c,0x1a,0x42]);
  const bytes = createHash('sha1').update(namespace).update(`${accountId}:${creditId}`).digest().subarray(0,16);
  bytes[6] = bytes[6]! & 0x0f | 0x50; bytes[8] = bytes[8]! & 0x3f | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export class CliproxyUsage {
  constructor(private fetcher: typeof fetch = fetch) {}
  private async management(config: UsageSourceConfig, path: string, body?: unknown) {
    try {
      const response = await this.fetcher(new URL(`v0/management/${path}`, config.url.endsWith('/') ? config.url : config.url + '/'), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: 'Bearer ' + config.managementKey, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`额度来源返回 HTTP ${response.status}`); }
      const reader = response.body?.getReader(); if (!reader) throw new Error('额度来源响应为空');
      let bytes = 0; const parts: Uint8Array[] = [];
      try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 2_097_152) { await reader.cancel(); throw new Error('额度来源响应过大'); } parts.push(next.value); } }
      finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
      if (error instanceof Error && /^额度来源返回 HTTP \d{3}$/.test(error.message)) throw error;
      const code = object(object(error).cause).code;
      throw new Error(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? `额度来源连接失败（${code}）` : '额度来源请求失败，请检查地址、管理密钥或连接');
    }
  }
  private async authFiles(config: UsageSourceConfig): Promise<AuthFile[]> {
    const response = object(await this.management(config, 'auth-files'));
    if (!Array.isArray(response.files) || response.files.length > 500 || response.files.some((entry: unknown) => {
      const value = object(entry), token = value.id_token;
      return !text(value.id) || !value.id || !text(value.auth_index) || !value.auth_index || !text(value.provider,80) || value.email !== undefined && !text(value.email)
        || value.disabled !== undefined && typeof value.disabled !== 'boolean' || token !== undefined && (!token || typeof token !== 'object' || Array.isArray(token) || ['chatgpt_account_id','chatgpt_plan_type'].some(key => token[key] !== undefined && !text(token[key])));
    })) throw new Error('额度来源未返回有效的账号列表');
    return response.files;
  }
  private async apiCall(config: UsageSourceConfig, account: AuthFile, url: string, data?: unknown) {
    const header = account.provider === 'codex' ? { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop', ...(account.id_token?.chatgpt_account_id ? { 'Chatgpt-Account-Id': account.id_token.chatgpt_account_id } : {}) } : { Authorization: 'Bearer $TOKEN$', 'anthropic-beta': 'oauth-2025-04-20' };
    const response = object(await this.management(config, 'api-call', { auth_index: account.auth_index, method: data === undefined ? 'GET' : 'POST', url, header, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }));
    if (typeof response.status_code !== 'number' || typeof response.body !== 'string') throw new Error('额度来源返回的账号响应无效');
    if (response.status_code < 200 || response.status_code >= 300) throw new Error(`账号拒绝额度请求（HTTP ${Number.isInteger(response.status_code) ? response.status_code : 0}）`);
    try { return object(JSON.parse(response.body)); } catch { throw new Error('额度来源返回的账号数据无效'); }
  }
  async readAccounts(config: UsageSourceConfig): Promise<UsageSourceAccount[]> {
    const accounts = (await this.authFiles(config)).filter(account => !account.disabled && ['codex','claude'].includes(account.provider));
    const result: UsageSourceAccount[] = new Array(accounts.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, accounts.length) }, async () => { while (next < accounts.length) { const index = next++; result[index] = await this.readAccount(config, accounts[index]!); } }));
    return result;
  }
  private async readAccount(config: UsageSourceConfig, account: AuthFile): Promise<UsageSourceAccount> {
    const base = { id: account.id, driver: account.provider as 'codex' | 'claude', ...(account.email ? { email: account.email } : {}), ...(account.id_token?.chatgpt_account_id?.trim() ? { workspaceId: account.id_token.chatgpt_account_id.trim() } : {}), credentialFingerprint: sourceAccountFingerprint(account) };
    try {
      if (account.provider === 'claude') {
        const usage = await this.apiCall(config, account, 'https://api.anthropic.com/api/oauth/usage');
        const model_scoped = (Array.isArray(usage.limits) ? usage.limits : []).flatMap((entry: any) => entry?.kind === 'weekly_scoped' && typeof entry?.scope?.model?.display_name === 'string' && typeof entry.percent === 'number' ? [{ display_name: entry.scope.model.display_name, utilization: entry.percent, resets_at: entry.resets_at ?? null }] : []);
        return { ...base, plan: 'Claude Subscription', usageLimits: claudeUsageLimits({ rate_limits_available: true, rate_limits: { five_hour: usage.five_hour ?? null, seven_day: usage.seven_day ?? null, model_scoped } }) };
      }
      const usage = await this.apiCall(config, account, BASE + '/usage');
      if (usage.rate_limit !== null && (!usage.rate_limit || typeof usage.rate_limit !== 'object' || Array.isArray(usage.rate_limit))) throw new Error('账号额度响应无效');
      const toWindow = (window: any) => window ? { usedPercent: window.used_percent, resetsAt: window.reset_at ?? null, ...(window.limit_window_seconds === undefined ? {} : { windowDurationMins: window.limit_window_seconds / 60 }) } : null;
      const plan = usage.plan_type ?? account.id_token?.chatgpt_plan_type;
      const limits = codexUsageLimits({ rateLimits: { planType: plan, primary: toWindow(usage.rate_limit?.primary_window), secondary: toWindow(usage.rate_limit?.secondary_window) } });
      try {
        const data = await this.apiCall(config, account, BASE + '/rate-limit-reset-credits');
        if (!Array.isArray(data.credits) || data.credits.some((value: any) => !text(value?.id) || !text(value?.status) || !text(value?.reset_type) || !text(value?.expires_at))) throw new Error('重置次数响应无效');
        const credits = data.credits.filter((value: any) => value.reset_type === 'codex_rate_limits' && value.status === 'available' && Date.parse(value.expires_at) > Date.now()).sort((a: any,b: any) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
        limits.resetCredits = { availableCount: credits.length, ...(credits[0] ? { nextCreditId: credits[0].id, nextExpiresAt: new Date(credits[0].expires_at).toISOString() } : {}) };
      } catch { /* Credit reads fail independently from allowance reads. */ }
      return { ...base, ...(codexSubscriptionLabel(plan) ? { plan: codexSubscriptionLabel(plan) } : {}), usageLimits: limits };
    } catch { return { ...base, usageLimits: unavailableUsageLimits('probeFailed') }; }
  }
  async consume(config: UsageSourceConfig, accountId: string, creditId: string, fingerprint: string): Promise<{ outcome: ProviderResetOutcome; warning?: string }> {
    const account = (await this.authFiles(config)).find(value => value.id === accountId);
    if (!account || account.disabled || account.provider !== 'codex' || sourceAccountFingerprint(account) !== fingerprint) throw new Error('额度来源账号已改变，请刷新后重新确认');
    const response = await this.apiCall(config, account, BASE + '/rate-limit-reset-credits/consume', { redeem_request_id: creditRedeemRequestId(account.id_token?.chatgpt_account_id ?? account.id, creditId), credit_id: creditId });
    const outcomes = { reset: 'reset', nothing_to_reset: 'nothingToReset', no_credit: 'noCredit', already_redeemed: 'alreadyRedeemed' } as const;
    if (typeof response.code !== 'string' || !Object.hasOwn(outcomes, response.code)) throw new Error('额度来源返回了未知的重置结果');
    const outcome = outcomes[response.code as keyof typeof outcomes];
    if (outcome === 'reset' || outcome === 'alreadyRedeemed') {
      try { await this.management(config, 'reset-quota', { auth_index: account.auth_index }); }
      catch { return { outcome, warning: '额度已重置，来源的路由冷却暂未清除；冷却到期后会恢复。' }; }
    }
    return { outcome };
  }
}
