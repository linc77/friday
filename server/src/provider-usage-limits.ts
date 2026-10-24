import { taskProviderInstance } from './provider-instances.js';
/*
 * Adapted from T3 Code 8cd9641f provider/codexUsageLimits.ts,
 * provider/claudeUsageLimits.ts and provider-core/server/usageLimits.ts.
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Engine } from './engine.js';
import { createHash } from 'node:crypto';
export type ProviderResetCredits = { availableCount: number; nextExpiresAt?: string; nextCreditId?: string };
export type ProviderResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
export type ProviderResetScope = { provider: 'codex' | 'claude'; providerInstanceId?: string; accountKey: string; settingsDigest: string; fingerprint: string; creditId?: string };
export const providerDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function providerFingerprint(provider: string, account: any, fallback: string) {
  const identity = [account?.id ?? account?.accountId ?? account?.chatgptAccountId ?? null, account?.email ?? null, account?.organizationId ?? account?.organizationUuid ?? null];
  return providerDigest([provider, account?.type ?? null, identity.some(Boolean) ? identity : fallback]);
}
export class ProviderResetError extends Error { constructor(message: string, readonly settled = false) { super(message); } }
export type ProviderUsageWindow = { id: string; kind: 'session' | 'weekly' | 'monthly' | 'other'; label: string; usedPercent: number; windowDurationMins: number; resetsAt?: string };
export type ProviderUsageLimits = { checkedAt: string; windows: ProviderUsageWindow[]; available?: boolean; sourceLabel?: string; credentialFingerprint?: string; resetCredits?: ProviderResetCredits; unavailable?: { reason: 'unsupported' | 'probeFailed'; message?: string } };
export type ProviderUsageIdentity = { email?: string; workspaceId?: string; plan?: string };
export function codexSubscriptionLabel(plan: unknown) {
  const labels = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro 20x', prolite: 'Pro 5x', promax: 'Pro Max', team: 'Team', self_serve_business_prolite: 'Business', self_serve_business_usage_based: 'Business', business: 'Business', ent26: 'Enterprise', enterprise_cbp_automation: 'Enterprise', enterprise_cbp_usage_based: 'Enterprise', enterprise: 'Enterprise', edu: 'Edu' };
  return typeof plan === 'string' && Object.hasOwn(labels, plan) ? `ChatGPT ${labels[plan as keyof typeof labels]} Subscription` : undefined;
}
export function providerUsageIdentity(account: any): ProviderUsageIdentity {
  return { ...(typeof account?.email === 'string' ? { email: account.email } : {}), ...(typeof (account?.accountId ?? account?.chatgptAccountId ?? account?.organizationId ?? account?.organizationUuid) === 'string' ? { workspaceId: account.accountId ?? account.chatgptAccountId ?? account.organizationId ?? account.organizationUuid } : {}), ...(typeof (account?.planType ?? account?.subscriptionType ?? account?.plan) === 'string' ? { plan: account.planType ?? account.subscriptionType ?? account.plan } : {}) };
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const percent = (value: number) => Math.max(0, Math.min(100, value));
const iso = (value: unknown) => {
  const millis = finite(value) && value > 0 ? value * 1000 : typeof value === 'string' && value ? Date.parse(value) : NaN;
  return Number.isFinite(millis) && Math.abs(millis) <= 8.64e15 ? new Date(millis).toISOString() : undefined;
};
export const unavailableUsageLimits = (reason: 'unsupported' | 'probeFailed'): ProviderUsageLimits => ({ checkedAt: new Date().toISOString(), windows: [], unavailable: { reason } });
const sorted = (windows: ProviderUsageWindow[]) => windows.sort((a, b) => ({ session: 0, weekly: 1, monthly: 2, other: 3 }[a.kind] - { session: 0, weekly: 1, monthly: 2, other: 3 }[b.kind]) || a.id.localeCompare(b.id));
export function codexUsageLimits(response: unknown): ProviderUsageLimits {
  const data = object(response), snapshot = object(object(data.rateLimitsByLimitId).codex ?? data.rateLimits);
  const windows: ProviderUsageWindow[] = [];
  if (!snapshot.limitId || snapshot.limitId === 'codex') {
    for (const [id, fallback] of [['primary', ['free', 'go'].includes(snapshot.planType) ? 43200 : 300], ['secondary', 10080]] as const) {
      const window = object(snapshot[id]); if (!finite(window.usedPercent)) continue;
      const windowDurationMins = finite(window.windowDurationMins) ? window.windowDurationMins : fallback;
      const kind = windowDurationMins >= 43200 ? 'monthly' : windowDurationMins >= 10080 ? 'weekly' : 'session';
      const resetsAt = iso(window.resetsAt);
      windows.push({ id, kind, label: kind === 'session' ? 'Session' : kind === 'weekly' ? 'Weekly' : 'Monthly', usedPercent: percent(window.usedPercent), windowDurationMins, ...(resetsAt ? { resetsAt } : {}) });
    }
  }
  const summary = object(data.resetCredits);
  const expires = (Array.isArray(summary.credits) ? summary.credits : []).filter((credit: any) => credit?.status === 'available').map((credit: any) => credit.expiresAt).filter((value: unknown): value is number => typeof value === 'number');
  const nextExpiresAt = expires.length ? iso(Math.min(...expires)) : undefined;
  const resetCredits = Number.isSafeInteger(summary.availableCount) ? { availableCount: Math.max(0, summary.availableCount), ...(nextExpiresAt ? { nextExpiresAt } : {}) } : undefined;
  return { checkedAt: new Date().toISOString(), windows: sorted(windows), ...(resetCredits ? { resetCredits } : {}) };
}
export function claudeUsageLimits(response: unknown): ProviderUsageLimits {
  const data = object(response); if (data.rate_limits_available !== true || !data.rate_limits) return unavailableUsageLimits('unsupported');
  const limits = object(data.rate_limits), windows: ProviderUsageWindow[] = [];
  for (const [id, kind, label, windowDurationMins] of [['five_hour', 'session', 'Session', 300], ['seven_day', 'weekly', 'Weekly', 10080]] as const) {
    const window = object(limits[id]); if (!finite(window.utilization)) continue;
    const resetsAt = iso(window.resets_at);
    windows.push({ id, kind, label, usedPercent: percent(window.utilization), windowDurationMins, ...(resetsAt ? { resetsAt } : {}) });
  }
  for (const entry of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
    const window = object(entry); if (typeof window.display_name !== 'string' || !finite(window.utilization)) continue;
    const resetsAt = iso(window.resets_at);
    windows.push({ id: 'seven_day_' + window.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), kind: 'weekly', label: 'Weekly · ' + window.display_name,
      usedPercent: percent(window.utilization), windowDurationMins: 10080, ...(resetsAt ? { resetsAt } : {}) });
  }
  return { checkedAt: new Date().toISOString(), windows: sorted(windows) };
}
export async function composerUsageLimits(engine: Engine, input: { provider: string; providerInstanceId?: string; taskId?: string; reload?: boolean }) {
  if (!['codex', 'claude', 'grok', 'cursor', 'opencode'].includes(input.provider)) throw new Error('此 Provider 未提供原生额度接口');
  const task = input.taskId ? (await engine.snapshot()).tasks.find(task => task.id === input.taskId) : undefined;
  if (input.taskId && (!task || task.agent !== input.provider)) throw new Error('任务执行范围已经改变');
  const id = task ? taskProviderInstance(task) : input.providerInstanceId ?? input.provider;
  if (task && input.providerInstanceId !== undefined && input.providerInstanceId !== id) throw new Error('任务所属 Provider 实例已改变');
  const connection = await engine.providerInstances.get(input.provider as 'codex' | 'claude' | 'grok' | 'cursor' | 'opencode', id, true);
  const value = await connection.usageLimits(input.reload === true, task);
  if (task && !(await engine.snapshot()).tasks.some(value => value.id === task.id && taskProviderInstance(value) === id && value.agent === task.agent && value.codexHome === task.codexHome && value.claudeHome === task.claudeHome)) throw new Error('任务执行范围已经改变');
  await engine.publishProviderUsage(id, value, ('usageIdentity' in connection ? connection.usageIdentity(value.credentialFingerprint) : undefined));
  return value;
}
