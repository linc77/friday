// Adapted from T3 Code 8cd9641f, shared/usageLimits.ts (MIT, T3 Tools Inc.).
// Full license: provider-usage-limits.ts. Codex slots pool by allowance kind.
import type { Workspace } from './types.js';
import { providerDigest, codexSubscriptionLabel, type ProviderUsageLimits, type ProviderUsageWindow } from './provider-usage-limits.js';
export type UsageRedeemTarget = { provider: string; fingerprint: string } | { sourceId: string; accountId: string; creditId: string; fingerprint: string };
export type LimitAccount = { key: string; driver: string; displayName: string; email?: string; plan?: string; workspaceId?: string; sourceLabel?: string; limits: ProviderUsageLimits; redeem?: UsageRedeemTarget };
export type LimitPoolWindow = { id: string; kind: string; label: string; usedPercent: number; remainingPercent: number; pace: 'ahead' | 'on' | 'under' | null; members: { accountKey: string; window: ProviderUsageWindow }[]; resets: { accountKey: string; at: string; restoresPercent: number }[] };
const order = { session: 0, weekly: 1, monthly: 2 };
const poolKey = (driver: string, window: ProviderUsageWindow) => driver === 'codex' ? window.kind : `${window.kind}:${window.id}`;
const resetMillis = (window: ProviderUsageWindow) => { const value = Date.parse(window.resetsAt ?? ''); return Number.isFinite(value) ? value : null; };
export function collectLimitAccounts(state: Workspace): LimitAccount[] {
  const reports: LimitAccount[] = [];
  for (const [driver, limits] of Object.entries(state.providerUsageSnapshots ?? {})) {
    if (!['codex','claude'].includes(driver)) continue;
    const identity = state.providerUsageIdentities?.[driver], matching = identity?.fingerprint === limits.credentialFingerprint ? identity : undefined;
    reports.push({ key: `native:${driver}`, driver, displayName: driver === 'codex' ? 'Codex' : 'Claude', email: matching?.email, plan: driver === 'codex' ? codexSubscriptionLabel(matching?.plan) ?? matching?.plan : matching?.plan, workspaceId: matching?.workspaceId, limits, ...(limits.credentialFingerprint ? { redeem: { provider: driver, fingerprint: limits.credentialFingerprint } } : {}) });
  }
  for (const source of state.usageLimitSources ?? []) for (const account of source.accounts) {
    reports.push({ key: `source:${source.id}:${account.id}`, driver: account.driver, displayName: account.email || account.id.replace(/\.json$/i,''), email: account.email, plan: account.plan, workspaceId: account.workspaceId, sourceLabel: source.label, limits: account.usageLimits,
      ...(account.usageLimits.resetCredits?.nextCreditId ? { redeem: { sourceId: source.id, accountId: account.id, creditId: account.usageLimits.resetCredits.nextCreditId, fingerprint: account.credentialFingerprint } } : {}) });
  }
  const primaryKey = (report: LimitAccount) => { const email = report.email?.trim().toLowerCase(); return email ? `${report.driver}:${email}` : report.limits.credentialFingerprint ? `${report.driver}:credential:${report.limits.credentialFingerprint}` : null; };
  const workspaces = new Map<string, Set<string>>();
  for (const report of reports) { const key = primaryKey(report); if (key && report.workspaceId) { const known = workspaces.get(key) ?? new Set(); known.add(report.workspaceId); workspaces.set(key, known); } }
  const merged = new Map<string, LimitAccount>(), creditSources = new Map<string, LimitAccount>(), hubRedeems = new Map<string, LimitAccount>();
  for (const report of reports) {
    if (report.limits.unavailable || !report.limits.windows.length) continue;
    const base = primaryKey(report), known = base ? workspaces.get(base) : undefined;
    const key = base === null ? report.key : report.workspaceId ? `${base}:${report.workspaceId}` : !known ? base : known.size === 1 ? `${base}:${[...known][0]}` : report.key;
    const fresherThan = (previous: LimitAccount | undefined) => !previous || Date.parse(report.limits.checkedAt) > Date.parse(previous.limits.checkedAt);
    if (report.redeem && 'sourceId' in report.redeem && fresherThan(hubRedeems.get(key))) hubRedeems.set(key, report);
    if (report.limits.resetCredits && fresherThan(creditSources.get(key))) creditSources.set(key, report);
    const previous = merged.get(key);
    if (!previous) { merged.set(key, { ...report, key }); continue; }
    const winner = fresherThan(previous) ? report : previous, credits = creditSources.get(key);
    merged.set(key, { ...previous, displayName: previous.displayName || report.displayName, plan: previous.plan ?? report.plan, sourceLabel: previous.sourceLabel === undefined || report.sourceLabel === undefined ? undefined : previous.sourceLabel,
      redeem: hubRedeems.get(key)?.redeem ?? (credits ? credits.redeem : winner.redeem ?? previous.redeem ?? report.redeem), limits: { ...winner.limits, ...(credits?.limits.resetCredits ? { resetCredits: credits.limits.resetCredits } : { resetCredits: undefined }) } });
  }
  return [...merged.values()];
}
export function collectLimitPools(accounts: LimitAccount[], now = Date.now()) {
  const byDriver = new Map<string, LimitAccount[]>();
  for (const account of accounts) { const members = byDriver.get(account.driver) ?? []; members.push(account); byDriver.set(account.driver, members); }
  return [...byDriver].map(([driver, members]) => {
    const first = members.flatMap(account => account.limits.windows).sort((a,b) => order[a.kind] - order[b.kind])[0];
    const firstReset = (account: LimitAccount) => { const window = account.limits.windows.find(window => first && poolKey(driver,window) === poolKey(driver,first)); return window ? resetMillis(window) ?? Infinity : Infinity; };
    members.sort((a,b) => firstReset(a) - firstReset(b) || (a.displayName || a.email || a.key).toLowerCase().localeCompare((b.displayName || b.email || b.key).toLowerCase()) || a.key.localeCompare(b.key));
    const groups = new Map<string, { account: LimitAccount; window: ProviderUsageWindow }[]>();
    for (const account of members) for (const window of account.limits.windows) {
      const pooled = poolKey(driver,window), key = groups.get(pooled)?.some(member => member.account === account) ? `${window.kind}:${window.id}` : pooled;
      const entries = groups.get(key) ?? []; entries.push({ account, window }); groups.set(key,entries);
    }
    const windows = [...groups].map(([key, entries]): LimitPoolWindow => {
      const first = entries[0]!.window, usedPercent = entries.reduce((sum,member) => sum + member.window.usedPercent,0) / entries.length;
      const timed = entries.flatMap(member => { const at = resetMillis(member.window), length = member.window.windowDurationMins * 60_000; return at !== null && length > 0 ? [{ used: member.window.usedPercent, elapsed: Math.max(0,Math.min(1,(length - (at - now)) / length)) }] : []; });
      const meanUsed = timed.reduce((sum,value) => sum + value.used,0) / timed.length;
      const meanElapsed = timed.length ? timed.reduce((sum,value) => sum + value.elapsed,0) / timed.length : null;
      const gap = meanElapsed === null ? null : meanUsed - meanElapsed * 100;
      return { id: driver === 'codex' ? key : first.id, kind: first.kind, label: first.label, usedPercent: Math.round(usedPercent), remainingPercent: Math.round(100 - usedPercent), pace: gap === null ? null : gap > 5 ? 'ahead' : gap < -5 ? 'under' : 'on',
        members: entries.map(({account,window}) => ({ accountKey: account.key, window })), resets: entries.flatMap(({account,window}) => resetMillis(window) !== null ? [{ accountKey: account.key, at: window.resetsAt!, restoresPercent: Math.round(window.usedPercent / entries.length) }] : []).sort((a,b) => Date.parse(a.at) - Date.parse(b.at)) };
    }).sort((a,b) => order[a.kind as keyof typeof order] - order[b.kind as keyof typeof order]);
    return { driver, accounts: members, windows };
  });
}
export function usagePoolSnapshot(state: Workspace, owner: boolean) {
  const accounts = collectLimitAccounts(state);
  for (const account of accounts) account.key = providerDigest(account.key);
  if (!owner) for (const account of accounts) { account.email = undefined; account.displayName = account.driver === 'codex' ? 'Codex' : 'Claude'; }
  return { pools: collectLimitPools(accounts), notices: (state.usageLimitSources ?? []).flatMap(source => source.error ? [`${source.label}: ${source.error}`] : source.accounts.length === 0 ? [`${source.label}: 未返回账号`] : []) };
}
