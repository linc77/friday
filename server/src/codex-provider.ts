import { CodexRpc } from './codex-rpc.js';
import { codexRuntime, loadCodexSettings, saveCodexSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';

export type CodexModel = ProviderModel;
type Probe = { connected: boolean; installed: boolean; version: string | null; account: { type: string; email: string | null; plan: string | null } | null; models: CodexModel[]; checkedAt: string; error: string | null };
export type ModelStatus = Omit<Probe, 'connected'> & {
  provider: string; displayName: string; enabled: boolean; model: string; connected: boolean; loginPending: boolean;
  settings: (Omit<CodexSettings, 'environment'> & { environment: { name: string; value: null; hasValue: boolean }[] }) | null;
};

export class CodexConnection {
  private cached?: Probe;
  private cachedKey = '';
  private pending?: Promise<Probe>;
  private pendingKey = '';
  private saving = false;
  private clients = new Set<CodexRpc>();
  private loginClient?: CodexRpc;
  private loginTimer?: NodeJS.Timeout;
  constructor(private directory: string) {}

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
    return { ...await codexRuntime(settings), model: model || undefined, effort: effort || selected?.defaultReasoningEffort || undefined };
  }
  async save(value: unknown) {
    if (this.saving || this.loginClient) throw new Error('Codex 配置或登录正在处理中，请稍候。');
    this.saving = true;
    try {
      await this.pending;
      const settings = validateSettings(value, await loadCodexSettings(this.directory));
      await saveCodexSettings(this.directory, settings); this.cached = undefined;
      return await this.status(true, true);
    } finally { this.saving = false; }
  }
  async login() {
    if (this.saving || this.loginClient) throw new Error('Codex 配置或登录正在处理中，请稍候。');
    const { rpc } = await this.client(await loadCodexSettings(this.directory));
    this.loginClient = rpc;
    const end = () => { if (this.loginClient === rpc) this.loginClient = undefined; this.cached = undefined; this.release(rpc); clearTimeout(this.loginTimer); };
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
