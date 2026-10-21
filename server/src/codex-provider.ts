import { CodexRpc } from './codex-rpc.js';
import { realpath } from 'node:fs/promises';
import { ProviderWorkspaceCache, type ProviderWorkspace } from './provider-workspace.js';
import type { WorkItem } from './types.js';
import { codexRuntime, loadCodexSettings, saveCodexSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import { codexUsageLimits, providerDigest, providerUsageIdentity, providerFingerprint, ProviderResetError, type ProviderResetScope, type ProviderResetOutcome, type ProviderUsageLimits } from './provider-usage-limits.js';

export type CodexModel = ProviderModel;
type Probe = { connected: boolean; installed: boolean; version: string | null; account: { type: string; email: string | null; plan: string | null } | null; models: CodexModel[]; checkedAt: string; error: string | null };
export type ModelStatus = Omit<Probe, 'connected'> & {
  provider: string; displayName: string; enabled: boolean; model: string; connected: boolean; loginPending: boolean;
  supportsPlan?: boolean;
  settings: (Omit<CodexSettings, 'environment'> & { environment: { name: string; value: null; hasValue: boolean }[]; serverUrl?: string; serverPassword?: null; serverPasswordConfigured?: boolean; nativeConfig?: import('./acp-provider-settings.js').AcpProviderPublicConfig }) | null;
};

export class CodexConnection {
  onConfigurationChanged?: () => Promise<void>;
  private workspaceCache = new ProviderWorkspaceCache();
  private usageIdentitySnapshot?: { fingerprint: string; identity: import('./provider-usage-limits.js').ProviderUsageIdentity };
  usageIdentity(fingerprint: string | undefined) { return fingerprint && this.usageIdentitySnapshot?.fingerprint === fingerprint ? this.usageIdentitySnapshot.identity : undefined; }
  private usageCache = new ProviderWorkspaceCache<ProviderUsageLimits>(60_000);
  private cached?: Probe;
  private cachedKey = '';
  private pending?: Promise<Probe>;
  private pendingKey = '';
  private saving = false;
  private resetting = false;
  private clients = new Set<CodexRpc>();
  private loginClient?: CodexRpc;
  private loginTimer?: NodeJS.Timeout;
  constructor(private directory: string) {}
  async usageLimits(reload = false, task?: WorkItem): Promise<ProviderUsageLimits> {
    const settings = await loadCodexSettings(this.directory), configured = await codexRuntime(settings);
    if (!settings.enabled) throw new Error('请先启用 Codex 后读取账号配额。');
    if (task?.codexHome && task.codexHome !== configured.home) throw new Error('请恢复这条会话使用的 Codex 账号目录');
    return this.usageCache.read(JSON.stringify(settings), reload, async () => {
      const { rpc } = await this.client(settings);
      try {
        const [account, response] = await Promise.all([rpc.call('account/read', { refreshToken: false }, 8000), rpc.call('account/rateLimits/read', null, 8000)]);
        const result = { ...codexUsageLimits(response), credentialFingerprint: providerFingerprint('codex', account.account, configured.home) };
        if (JSON.stringify(await loadCodexSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Codex 配置已经改变，请重新加载');
        this.usageIdentitySnapshot = { fingerprint: result.credentialFingerprint, identity: providerUsageIdentity(account.account) };
        return result;
      } catch { throw new Error('无法读取 Codex 账号配额，请稍后重试'); }
      finally { this.release(rpc); }
    });
  }
  async resetScope(): Promise<ProviderResetScope> {
    const limits = await this.usageLimits(), settings = await loadCodexSettings(this.directory), runtime = await codexRuntime(settings);
    if (!limits.credentialFingerprint || !limits.resetCredits) throw new ProviderResetError('当前 Codex 账号没有可用的重置信息信息。', true);
    return { provider: 'codex', accountKey: providerDigest(['codex', await realpath(runtime.home).catch(() => runtime.home), limits.credentialFingerprint]), settingsDigest: providerDigest(settings), fingerprint: limits.credentialFingerprint };
  }
  async consumeResetCredit(scope: ProviderResetScope, idempotencyKey: string): Promise<ProviderResetOutcome> {
    if (this.saving || this.resetting) throw new ProviderResetError('Codex 配置或账号操作正在进行，请稍后重试。', true);
    this.resetting = true; let rpc: CodexRpc | undefined;
    try {
      const settings = await loadCodexSettings(this.directory), runtime = await codexRuntime(settings);
      if (!settings.enabled || providerDigest(settings) !== scope.settingsDigest) throw new ProviderResetError('Codex 账号配置已经改变，请重新确认。', true);
      rpc = (await this.client(settings)).rpc;
      const account = await rpc.call('account/read', { refreshToken: false }, 8000);
      if (providerFingerprint('codex', account.account, runtime.home) !== scope.fingerprint || providerDigest(await loadCodexSettings(this.directory)) !== scope.settingsDigest) throw new ProviderResetError('Codex 账号已经改变，请重新确认。', true);
      const response = await rpc.call('account/rateLimitResetCredit/consume', { idempotencyKey }, 20_000);
      if (!['reset', 'nothingToReset', 'noCredit', 'alreadyRedeemed'].includes(response?.outcome)) throw new ProviderResetError('无法确认重置结果，请先检查，再重试。');
      this.usageCache.invalidate(JSON.stringify(settings)); return response.outcome;
    } catch (error) { if (error instanceof ProviderResetError) throw error; throw new ProviderResetError('无法确认 Codex 重置结果，请检查后重试。'); }
    finally { if (rpc) this.release(rpc); this.resetting = false; }
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const settings = await loadCodexSettings(this.directory), configured = await this.runtime();
    if (task?.codexHome && task.codexHome !== configured.home) throw new Error('请恢复这条会话使用的 Codex 账号目录');
    const key = JSON.stringify([settings, cwd]);
    return this.workspaceCache.read(key, reload, async () => {
      const { rpc } = await this.client(settings);
      try {
        const response = await rpc.call('skills/list', { cwds: [cwd], forceReload: reload });
        const entry = response?.data?.find((value: { cwd: string }) => value.cwd === cwd);
        if (!entry || !Array.isArray(entry.skills)) throw new Error('Codex 未返回这个 Workspace 的 Skill 列表');
        const skills = entry.skills.flatMap((value: any) => value && typeof value.name === 'string' && typeof value.path === 'string' && typeof value.enabled === 'boolean'
          ? [{ name: value.name, path: value.path, enabled: value.enabled, ...(typeof value.description === 'string' ? { description: value.description } : {}),
            ...(typeof value.shortDescription === 'string' ? { shortDescription: value.shortDescription } : {}), ...(typeof value.interface?.displayName === 'string' ? { displayName: value.interface.displayName } : {}), ...(typeof value.scope === 'string' ? { scope: value.scope } : {}) }] : []);
        if (JSON.stringify(await loadCodexSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Codex 配置已经改变，请重新加载');
        return { provider: 'codex', cwd, checkedAt: new Date().toISOString(), skills, commands: [{ name: 'compact', description: 'Summarize the conversation and reduce context usage', builtin: true },
          { name: 'goal', description: 'Set, inspect, pause, resume, or clear a persistent goal', builtin: true }, { name: 'feedback', description: 'Send feedback and thread logs to OpenAI', builtin: true }] };
      } finally { this.release(rpc); }
    });
  }

  private async client(settings: CodexSettings) {
    const runtime = await codexRuntime(settings);
    const rpc = new CodexRpc(runtime.command, this.directory, runtime);
    this.clients.add(rpc);
    try {
      const initialized = await rpc.call('initialize', { clientInfo: { name: 'friday', title: 'Friday', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized' });
      return { rpc, initialized };
    } catch (error) { this.release(rpc); throw error; }
  }
  private release(rpc: CodexRpc) { this.clients.delete(rpc); rpc.close(); }
  private async probe(settings: CodexSettings): Promise<Probe> {
    const base: Probe = { connected: false, installed: false, version: null, account: null, models: [], checkedAt: new Date().toISOString(), error: null };
    let rpc: CodexRpc | undefined;
    try {
      const client = await this.client(settings); rpc = client.rpc; base.installed = true;
      base.version = client.initialized.userAgent?.match(/\/([\d.]+)/)?.[1] ?? null;
      const info = await rpc.call('account/read', { refreshToken: false });
      base.account = info.account ? { type: info.account.type, email: info.account.email ?? null, plan: info.account.planType ?? null } : null;
      base.connected = !!info.account || info.requiresOpenaiAuth === false;
      if (!base.connected) { base.error = 'Codex 尚未登录，请连接账号或在主机终端运行 codex login。'; return base; }
      let cursor: string | null = null; const seen = new Set<string>();
      do {
        const page = await rpc.call('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        for (const value of page.data ?? []) if (!value.hidden && !base.models.some(m => m.id === value.model)) base.models.push({
          id: value.model, name: value.displayName ?? value.model, description: value.description ?? '', isDefault: value.isDefault === true,
          reasoningEfforts: (value.supportedReasoningEfforts ?? []).map((e: any) => e.reasoningEffort), defaultReasoningEffort: value.defaultReasoningEffort ?? '',
        });
        cursor = page.nextCursor ?? null;
        if (cursor && seen.has(cursor)) throw new Error('Repeated model cursor');
        if (cursor) seen.add(cursor);
      } while (cursor && seen.size < 20);
      return base;
    } catch {
      base.connected = false;
      base.error = '无法读取 Codex 服务，请检查可执行文件、配置目录和启动参数后重新检测。';
      return base;
    } finally { if (rpc) this.release(rpc); }
  }
  async status(owner = false, force = false): Promise<ModelStatus> {
    const settings = await loadCodexSettings(this.directory);
    const key = JSON.stringify(settings);
    if (this.pending && this.pendingKey !== key) { await this.pending; return this.status(owner, force); }
    if (!this.cached || this.cachedKey !== key || force || Date.now() - Date.parse(this.cached.checkedAt) > 60_000) {
      if (!this.pending) {
        this.pendingKey = key;
        this.pending = this.probe(settings).then(value => { this.cachedKey = key; return this.cached = value; }).finally(() => { this.pending = undefined; });
      }
      await this.pending;
    }
    const probe = this.cached!;
    const model = settings.model || probe.models.find(m => m.isDefault)?.id || probe.models[0]?.id || '';
    return {
      provider: 'Codex', displayName: settings.displayName, enabled: settings.enabled, model,
      connected: settings.enabled && probe.connected, installed: probe.installed, version: probe.version,
      account: probe.account ? { ...probe.account, email: owner ? probe.account.email : null } : null,
      models: appendCustomModels(probe.models, settings.customModels), checkedAt: probe.checkedAt, error: probe.error, loginPending: !!this.loginClient,
      settings: owner ? { ...settings, environment: settings.environment.map(e => ({ name: e.name, value: null, hasValue: true })) } : null,
    };
  }
  async ready() {
    if (this.saving) throw new Error('正在保存 Codex 配置，请稍候。');
    const state = await this.status();
    if (!state.enabled) throw new Error('请先在「Providers → Codex」中启用 Codex。');
    if (!state.connected) throw new Error(state.error ?? '请先在「Providers → Codex」中连接 Codex。');
  }
  async runtime(selection?: { model?: string; reasoningEffort?: string }) {
    await this.ready();
    const settings = await loadCodexSettings(this.directory); const state = await this.status();
    const model = selection?.model || state.model;
    const effort = selection?.reasoningEffort || (selection?.model ? '' : settings.reasoningEffort);
    const selected = state.models.find(m => m.id === model);
    if (model && !selected) throw new Error('当前 Codex 模型不可用，请重新选择。');
    if (effort && selected && !selected.reasoningEfforts.includes(effort)) throw new Error('当前模型不支持所选推理强度，请在 Providers 的 Codex 页面中重新选择。');
    return { ...await codexRuntime(settings), model: model || undefined, effort: effort || selected?.defaultReasoningEffort || undefined, permissionMode: settings.permissionMode };
  }
  async feedbackRuntime(task: { codexHome?: string }) {
    const settings = await loadCodexSettings(this.directory);
    if (!settings.enabled || this.saving) throw new Error('Codex 当前不可用');
    const runtime = await codexRuntime(settings);
    if (task.codexHome && runtime.home !== task.codexHome) throw new Error('请恢复这条会话使用的 Codex 账号后提交反馈');
    return runtime;
  }
  async save(value: unknown) {
    if (this.saving || this.resetting || this.loginClient) throw new Error('Codex 配置或登录正在处理中，请稍候。');
    this.saving = true; let changed = false;
    try {
      await this.pending;
      const settings = validateSettings(value, await loadCodexSettings(this.directory));
      await saveCodexSettings(this.directory, settings); this.cached = undefined; changed = true;
      return await this.status(true, true);
    } finally { this.saving = false; if (changed) await this.onConfigurationChanged?.(); }
  }
  async login() {
    if (this.saving || this.resetting || this.loginClient) throw new Error('Codex 配置或登录正在处理中，请稍候。');
    const { rpc } = await this.client(await loadCodexSettings(this.directory));
    this.loginClient = rpc;
    const end = () => { if (this.loginClient === rpc) this.loginClient = undefined; this.cached = undefined; this.release(rpc); clearTimeout(this.loginTimer); void this.onConfigurationChanged?.().catch(() => {}); };
    this.loginTimer = setTimeout(end, 5 * 60_000);
    rpc.onExit = end;
    rpc.onMessage = message => { if (message.method === 'account/login/completed') end(); };
    try {
      const result = await rpc.call('account/login/start', { type: 'chatgpt' });
      const url = new URL(result.authUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com') throw new Error('Invalid login URL');
      return { url: url.toString() };
    } catch { end(); throw new Error('无法启动 Codex 登录，请检查主机网络后重试。'); }
  }
  async close() { clearTimeout(this.loginTimer); for (const rpc of this.clients) this.release(rpc); this.loginClient = undefined; await this.pending?.catch(() => {}); }
}
