import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { CliproxyUsage, type UsageSourceConfig, type UsageSourceSnapshot } from './cliproxy-usage.js';
import { providerDigest, type ProviderResetOutcome } from './provider-usage-limits.js';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
type Settings = { version: number; sources: Record<string, UsageSourceConfig> };
export type UsageSourceReset = { requestId: string; sourceId: string; accountId: string; creditId: string; fingerprint: string; settingsDigest: string; digest: string; durableId: number; status: 'queued' | 'running' | 'completed' | 'uncertain' | 'failed'; createdAt: string; outcome?: ProviderResetOutcome; warning?: string; error?: string };
type ResetInput = Pick<UsageSourceReset, 'requestId' | 'sourceId' | 'accountId' | 'creditId' | 'fingerprint'> & { confirmed: boolean };
const live = (value: UsageSourceReset) => value.status === 'queued' || value.status === 'running';
const stamp = () => new Date().toISOString();
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) && !['constructor','__proto__','prototype'].includes(value);
export class UsageLimitSources {
  readonly definition;
  private gate: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private lifetime = new AbortController();
  private api: CliproxyUsage;
  constructor(private readonly engine: Engine, fetcher: typeof fetch = fetch) {
    this.api = new CliproxyUsage((input, init) => fetcher(input, { ...init, signal: AbortSignal.any([this.lifetime.signal, ...(init?.signal ? [init.signal] : [])]) }));
    this.definition = defineTask<{ requestId: string; predecessor: number | null }, { phase: 'wait' | 'consume' }, { status: string }, {}>({
      name: 'friday.usage_source_reset', version: 1, initial: () => ({ phase: 'wait' }), phases: {
        wait: async (task, runtime, ctx) => { await runtime.commit(() => task.input.predecessor === null ? { status: 'running', checkpoint: { phase: 'consume' } } : { status: 'waiting', checkpoint: { phase: 'consume' }, on: [task.input.predecessor as TaskId], policy: 'allSettled' }, ctx); },
        consume: async (task, runtime, ctx) => {
          const requestId = task.input.requestId, result = await runtime.memo<{ outcome: ProviderResetOutcome; warning?: string }>('result', ctx);
          if (result) await this.finish(requestId, { status: 'completed', ...result });
          else if (await runtime.memo<boolean>('started', ctx)) await this.finish(requestId, { status: 'uncertain', error: '重置曾中断；不会自动再次消费。刷新后重试同一次重置可避免重复消费。' });
          else {
            try {
              await this.lock(async () => {
                const settings = await this.settings(), receipt = (await engine.snapshot()).usageSourceResetRequests?.[requestId], config = receipt ? settings.sources[receipt.sourceId] : undefined;
                if (!receipt || !config?.enabled || !config.managementKey || providerDigest(config) !== receipt.settingsDigest) throw new Error('额度来源已改变，请重新确认');
                runtime.signal.throwIfAborted(); await this.finish(requestId, { status: 'running' });
                await runtime.memo('started', true, ctx); runtime.signal.throwIfAborted();
                const result = await this.api.consume(config, receipt.accountId, receipt.creditId, receipt.fingerprint);
                await runtime.memo('result', result, ctx); await this.finish(requestId, { status: 'completed', ...result });
                await this.refreshUnlocked(settings);
              });
            } catch (error) {
              if (runtime.signal.aborted) throw error;
              await this.finish(requestId, { status: await runtime.memo<boolean>('started', ctx) ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : '额度重置失败' });
            }
          }
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
        },
      }, abort: async (task, runtime, ctx) => {
        const result = await runtime.memo<{ outcome: ProviderResetOutcome; warning?: string }>('result', ctx);
        await this.finish(task.input.requestId, result ? { status: 'completed', ...result } : { status: 'uncertain', error: '重置已中断，结果尚未确认。不会自动再次消费。' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx);
      },
    });
  }
  private lock<T>(operation: () => Promise<T>): Promise<T> { const result = this.gate.then(operation); this.gate = result.catch(() => {}); return result; }
  private async settings(): Promise<Settings> {
    try { const data = JSON.parse(await readFile(join(this.engine.directory, 'usage-limit-sources.json'), 'utf8')); if (!Number.isSafeInteger(data.version) || data.version < 0 || !data.sources || typeof data.sources !== 'object' || Array.isArray(data.sources)) throw new Error(); return data; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 0, sources: {} }; throw new Error('额度来源配置无法读取'); }
  }
  async configuration() {
    const settings = await this.settings();
    return { version: settings.version, sources: Object.entries(settings.sources).map(([id, source]) => ({ id, kind: source.kind, label: source.label, url: source.url, enabled: source.enabled, hasManagementKey: !!source.managementKey })) };
  }
  async save(input: unknown) {
    return this.lock(async () => {
      if (this.stopped) throw new Error('服务正在停止');
      const value = input as Record<string, any>;
      if (!value || typeof value !== 'object' || Array.isArray(value) || !id(value.id) || !Number.isSafeInteger(value.version) || Object.keys(value).some(key => !['id','version','remove','source'].includes(key))) throw new Error('额度来源设置无效');
      const settings = await this.settings(); if (settings.version !== value.version) throw new Error('额度来源已在其他窗口更新，请重新加载');
      if (value.remove === true) delete settings.sources[value.id];
      else {
        const source = value.source;
        if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some(key => !['kind','url','label','enabled','managementKey'].includes(key)) || source.kind !== 'cliproxy' || typeof source.enabled !== 'boolean' || typeof source.url !== 'string' || source.url.length > 2048 || source.label !== undefined && (typeof source.label !== 'string' || source.label.length > 100) || source.managementKey !== undefined && (typeof source.managementKey !== 'string' || source.managementKey.length > 4096 || /[\0\r\n]/.test(source.managementKey))) throw new Error('额度来源设置无效');
        let url: URL; try { url = new URL(source.url.trim()); } catch { throw new Error('额度来源地址无效'); }
        if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('额度来源地址只支持不含账号或查询参数的 HTTP / HTTPS URL');
        settings.sources[value.id] = { kind: 'cliproxy', url: url.toString(), ...(source.label?.trim() ? { label: source.label.trim() } : {}), enabled: source.enabled, managementKey: source.managementKey === undefined ? settings.sources[value.id]?.managementKey ?? '' : source.managementKey.trim() };
        if (Object.keys(settings.sources).length > 20) throw new Error('最多添加 20 个额度来源');
      }
      settings.version++;
      const path = join(this.engine.directory, 'usage-limit-sources.json'), temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
      await this.refreshUnlocked(settings); return this.configuration();
    });
  }
  start() { this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 60_000); this.timer.unref(); void this.refresh().catch(() => {}); }
  refresh() { return this.lock(async () => { if (this.stopped) return; await this.refreshUnlocked(await this.settings()); }); }
  private async refreshUnlocked(settings: Settings) {
    const entries = Object.entries(settings.sources).filter(([, config]) => config.enabled), snapshots: UsageSourceSnapshot[] = new Array(entries.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => { while (next < entries.length) {
      const index = next++, [id, config] = entries[index]!;
      const base = { id, kind: config.kind, label: config.label || new URL(config.url).host || id, checkedAt: stamp() };
      try { snapshots[index] = config.managementKey ? { ...base, accounts: await this.api.readAccounts(config) } : { ...base, accounts: [], error: '未配置管理密钥' }; }
      catch (error) { snapshots[index] = { ...base, accounts: [], error: error instanceof Error ? error.message : '额度来源读取失败' }; }
    } }));
    if (!this.stopped) await this.engine.root.commit(async tx => { const state = await tx.doc(WorkspaceDoc); if (JSON.stringify(state.usageLimitSources ?? []) !== JSON.stringify(snapshots)) { state.usageLimitSources = snapshots; state.revision++; } }, context);
  }
  async consume(input: ResetInput) {
    if (!input || !id(input.requestId) || !id(input.sourceId) || typeof input.accountId !== 'string' || !input.accountId || input.accountId.length > 512 || typeof input.creditId !== 'string' || !input.creditId || input.creditId.length > 512 || !/^[a-f0-9]{64}$/.test(input.fingerprint) || input.confirmed !== true) throw new Error('请确认使用当前账号的一次重置');
    const digest = providerDigest({ sourceId: input.sourceId, accountId: input.accountId, creditId: input.creditId, fingerprint: input.fingerprint });
    let receipt!: UsageSourceReset;
    await this.lock(async () => {
      const settings = await this.settings();
      await this.engine.root.commit(async tx => {
        const state = await tx.doc(WorkspaceDoc); state.usageSourceResetRequests ??= {};
        const old = state.usageSourceResetRequests[input.requestId]; if (old) { if (old.digest !== digest) throw new Error('重置请求 ID 已用于其他账号'); receipt = JSON.parse(JSON.stringify(old)); return; }
        const source = state.usageLimitSources?.find(value => value.id === input.sourceId), account = source?.accounts.find(value => value.id === input.accountId), config = settings.sources[input.sourceId];
        if (!config?.enabled || !config.managementKey || account?.driver !== 'codex' || account.credentialFingerprint !== input.fingerprint || account.usageLimits.resetCredits?.nextCreditId !== input.creditId || account.usageLimits.resetCredits.availableCount < 1) throw new Error('账号或重置次数已改变，请刷新后重新确认');
        const predecessor = state.usageSourceResetTail && Object.values(state.usageSourceResetRequests).some(value => value.durableId === state.usageSourceResetTail && live(value)) ? state.usageSourceResetTail : null;
        const durableId = await tx.createTask(this.definition, { requestId: input.requestId, predecessor }, { ownership: { kind: 'conversation' } });
        receipt = { requestId: input.requestId, sourceId: input.sourceId, accountId: input.accountId, creditId: input.creditId, fingerprint: input.fingerprint, settingsDigest: providerDigest(config), digest, durableId, status: 'queued', createdAt: stamp() };
        state.usageSourceResetRequests[input.requestId] = receipt; state.usageSourceResetTail = durableId; state.revision++;
      }, context);
    });
    if (live(receipt)) { this.engine.harness.resume(); await this.engine.harness.waitForTask(receipt.durableId as TaskId, context); }
    const latest = (await this.engine.snapshot()).usageSourceResetRequests?.[input.requestId] ?? receipt;
    const { requestId, status, outcome, warning, error } = latest; return { requestId, status, outcome, warning, error };
  }
  private async finish(id: string, change: Partial<UsageSourceReset>) { await this.engine.mutate(state => { const receipt = state.usageSourceResetRequests?.[id]; if (receipt && live(receipt)) Object.assign(receipt, change); }); }
  async close() { this.stopped = true; clearInterval(this.timer); this.lifetime.abort(); await this.gate; }
}
