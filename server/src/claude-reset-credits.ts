// Adapted from T3 Code 8cd9641f provider/claudeResetCredits.ts (MIT).
// Copyright (c) 2026 T3 Tools Inc. Full license: apps/apple/Sources/FridayKit/Resources/T3code-LICENSE.txt.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderResetError, type ProviderResetCredits, type ProviderResetOutcome } from './provider-usage-limits.js';

const API = 'https://api.anthropic.com';
const grantID = /^[a-z0-9_-]{1,40}$/;
type IO = { platform?: string; fetch?: typeof fetch; read?: (file: string) => Promise<string> };
const json = async (file: string, io: IO): Promise<any> => {
  try { const raw = await (io.read ?? (file => readFile(file, 'utf8')))(file); if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('large'); return JSON.parse(raw); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new ProviderResetError('无法读取 Claude 登录信息，请重新登录后重试。', true); }
};
const token = async (home: string, io: IO) => {
  // T3 does not extract macOS Keychain credentials for this separate API.
  if ((io.platform ?? process.platform) === 'darwin') return;
  const value = (await json(join(home, '.credentials.json'), io)).claudeAiOauth?.accessToken;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};
const headers = (token: string, version: string) => ({ authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': `claude-cli/${version} (external, cli)` });
const future = (value: unknown, now: number) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return Date.parse(value) > now && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0);
};
export function claudeResetCredits(block: any, now = Date.now()): ProviderResetCredits | undefined {
  if (!block || block.eligible !== true || block.grants !== undefined && !Array.isArray(block.grants) || block.next_grant_id != null && typeof block.next_grant_id !== 'string') return;
  const grants = (Array.isArray(block.grants) ? block.grants : []).filter((value: any) => value && typeof value.id === 'string' && grantID.test(value.id) && Number.isInteger(value.resets_left) && value.resets_left >= 0 && (value.paused === undefined || typeof value.paused === 'boolean') && !value.paused && value.usable_now === true && (value.ends_at == null || future(value.ends_at, now)));
  const next = grants.find((value: any) => value.id === block.next_grant_id);
  return { availableCount: next ? grants.reduce((sum: number, value: any) => sum + value.resets_left, 0) : 0, ...(next ? { nextCreditId: next.id } : {}), ...(next?.ends_at ? { nextExpiresAt: new Date(next.ends_at).toISOString() } : {}) };
}
export async function readClaudeResetCredits(home: string, version: string | null | undefined, io: IO = {}): Promise<ProviderResetCredits | undefined> {
  if (!version || !/^[\w.+-]+$/.test(version)) return;
  try {
    const access = await token(home, io); if (!access) return;
    const response = await (io.fetch ?? fetch)(API + '/api/oauth/usage?cedar_ember=1&skip_spend=1', { headers: headers(access, version), signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) return;
    return claudeResetCredits((await response.json()).cedar_ember);
  } catch { return; }
}
export async function consumeClaudeResetCredit(input: { home: string; accountConfigPath: string; version: string; grantId: string; requestId: string }, io: IO = {}): Promise<ProviderResetOutcome> {
  if (!grantID.test(input.grantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) || !/^[\w.+-]+$/.test(input.version)) throw new ProviderResetError('Claude 重置信息无效，请重新读取。', true);
  const access = await token(input.home, io), config = await json(input.accountConfigPath, io), organization = config.oauthAccount?.organizationUuid;
  if (!access || typeof organization !== 'string' || !organization.trim()) throw new ProviderResetError('请重新登录 Claude 后使用一次重置。', true);
  let response: Response;
  try {
    response = await (io.fetch ?? fetch)(API + '/api/organizations/' + encodeURIComponent(organization.trim()) + '/reset_rate_limits', {
      method: 'POST', headers: { ...headers(access, input.version), 'content-type': 'application/json' },
      body: JSON.stringify({ program: 'cedar_ember', grant_id: input.grantId, request_id: input.requestId }), signal: AbortSignal.timeout(25_000), redirect: 'error',
    });
  } catch { throw new ProviderResetError('无法确认 Claude 重置结果，请先检查，再重试。'); }
  if (response.status === 429) throw new ProviderResetError('Claude 重置暂时受到限流，请稍后再试。', true);
  if ([401, 403].includes(response.status)) throw new ProviderResetError('请重新登录 Claude 后使用一次重置。', true);
  let value: any; try { if (!response.ok) throw new Error('status'); value = await response.json(); } catch { throw new ProviderResetError('无法确认 Claude 重置结果，请先检查，再重试。'); }
  if (value.result === 'cooldown') throw new ProviderResetError('Claude 重置正在冷却，请稍后再试。', true);
  const outcomes: Record<string, ProviderResetOutcome> = { reset: 'reset', not_limited: 'nothingToReset', already_used: 'alreadyRedeemed', ineligible: 'noCredit' };
  const outcome = value && typeof value.result === 'string' && Object.hasOwn(outcomes, value.result) ? outcomes[value.result] : undefined; if (!outcome) throw new ProviderResetError('无法确认 Claude 重置结果，请先检查，再重试。');
  return outcome;
}
