import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, createProvider, type Credential, type CredentialStore, type AuthOperationOptions, type Model } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

// The Engine's exclusive data-directory lease covers this store, including token refresh.
export class ModelCredentials implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private file: string) {}
  private async load(): Promise<Record<string, Credential>> {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn); this.chain = result.catch(() => {}); return result;
  }
  async read(id: string, options?: AuthOperationOptions) { options?.signal?.throwIfAborted(); await this.chain; return (await this.load())[id]; }
  async list() { await this.chain; return Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type })); }
  private async save(values: Record<string, Credential>) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(values), { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
    finally { await rm(temporary, { force: true }); }
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted();
      const values = await this.load(); const next = await fn(values[id]);
      if (next !== undefined) { values[id] = next; await this.save(values); }
      return values[id];
    });
  }
  delete(id: string) { return this.enqueue(async () => { const values = await this.load(); delete values[id]; await this.save(values); }); }
}

// Keep provider error bodies private: they can echo request headers or credentials.
function connectionError(status?: number): string {
  if (status === 401 || status === 403) return 'API Key 无效或没有访问权限，请检查后重试。';
  if (status === 402) return '供应商账户余额不足，请充值后重试。';
  if (status === 429) return '供应商请求过于频繁，请稍后重试。';
  if (status === 400 || status === 404 || status === 422) return '供应商不支持当前接口或模型，请检查 Base URL 和模型。';
  if (status && status >= 500) return '供应商服务暂时不可用，请稍后重试。';
  return '无法连接模型供应商，请检查 Base URL、主机网络或代理后重试。';
}

export interface APIModel { id: string; name: string; contextWindow?: number; maxTokens?: number; vision?: boolean }
interface ModelProviderSettings { name: string; baseUrl: string; model: string; models: APIModel[]; apiKey: string }
const customProviderID = 'friday-api';
const defaultBaseUrl = 'https://api.deepseek.com';

function field(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`请输入有效的${name}。`);
  return value.trim();
}
function baseURL(value: unknown): string {
  let url: URL;
  try { url = new URL(field(value, ' Base URL', 2048)); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 只能包含 HTTP 或 HTTPS 地址和路径，不能包含账号、查询参数或片段。');
  return url.toString().replace(/\/+$/, '');
}
function apiKey(value: unknown): string {
  const key = field(value, ' API Key', 4096);
  if (/[^\x21-\x7e]/.test(key)) throw new Error('请输入有效的 API Key。');
  return key;
}
function runtimeProvider(settings: ModelProviderSettings) {
  const known = provider().getModels();
  const models: Model<'openai-completions'>[] = settings.models.map(item => {
    const deepseek = known.find(model => model.id === item.id);
    return {
      ...(deepseek ?? { reasoning: false, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }),
      id: item.id, name: item.name, provider: customProviderID, api: 'openai-completions', baseUrl: settings.baseUrl,
      ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
      ...(item.maxTokens ? { maxTokens: item.maxTokens } : {}),
      ...(item.vision ? { input: ['text', 'image'] as ('text' | 'image')[] } : {}),
      compat: { ...deepseek?.compat, supportsStrictMode: false, supportsStore: false, supportsDeveloperRole: false, supportsUsageInStreaming: false,
        maxTokensField: new URL(settings.baseUrl).hostname === 'api.openai.com' ? 'max_completion_tokens' : 'max_tokens' },
    };
  });
  return createProvider({ id: customProviderID, name: settings.name, baseUrl: settings.baseUrl, models, api: openAICompletionsApi(),
    auth: { apiKey: { name: 'Friday API Key', resolve: async () => settings.apiKey ? { auth: { apiKey: settings.apiKey } } : undefined } },
  });
}

function provider() {
  const value = deepseekProvider();
  // DeepSeek strict tool schemas require the separate /beta endpoint. Use normal tool calls.
  return { ...value, getModels: () => value.getModels().map(model => ({ ...model, compat: { ...model.compat, supportsStrictMode: false } })) };
}

export class ModelConnection {
  readonly credentials: ModelCredentials;
  readonly models;
  readonly model = { provider: 'deepseek', modelId: process.env.FRIDAY_MODEL_ID ?? 'deepseek-flash' };
  private controller?: AbortController;
  private pending?: Promise<unknown>;
  private settings?: ModelProviderSettings;
  private loading?: Promise<void>;
  private readonly settingsFile: string;
  constructor(directory: string, private readonly request: typeof fetch = fetch) {
    this.credentials = new ModelCredentials(join(directory, 'model-auth.json'));
    this.settingsFile = join(directory, 'model-provider.json');
    // Use only the key explicitly saved for Friday; never borrow another app's credentials.
    this.models = createModels({ credentials: this.credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    this.models.setProvider(provider());
  }
  open(): Promise<void> {
    return this.loading ??= (async () => {
      let contents: string;
      try { contents = await readFile(this.settingsFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      try { this.apply(JSON.parse(contents) as ModelProviderSettings); }
      catch { throw new Error('Friday 无法读取已保存的模型连接，请检查主机上的 model-provider.json。'); }
    })();
  }
  private apply(settings: ModelProviderSettings) {
    this.models.setProvider(runtimeProvider(settings));
    this.settings = settings;
    Object.assign(this.model, { provider: customProviderID, modelId: settings.model });
  }
  async status(owner = false) {
    await this.open();
    const credential = this.settings ? undefined : await this.credentials.read('deepseek');
    return { provider: this.settings?.name ?? 'DeepSeek API', model: this.model.modelId,
      connected: this.settings ? !!this.settings.apiKey : credential?.type === 'api_key' && !!credential.key,
      ...(owner ? { baseUrl: this.settings?.baseUrl ?? defaultBaseUrl, models: this.settings?.models ?? provider().getModels().map(m => ({ id: m.id, name: m.name })) } : {}),
    };
  }
  async ready() {
    if (this.pending) throw new Error('正在验证模型连接，请稍候再发送消息。');
    if (!(await this.status()).connected) throw new Error('请先在「Providers → Friday」中配置模型供应商和 API Key（默认 DeepSeek）。');
    if (!this.models.getModel(this.model.provider, this.model.modelId)) throw new Error('当前模型不可用，请在 Providers 中重新选择。');
  }
  private async operation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pending) throw new Error('正在连接模型供应商，请稍候。');
    const controller = this.controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
    this.pending = run(signal);
    try { return await this.pending as T; }
    finally { this.pending = undefined; this.controller = undefined; }
  }
  private async draft(input: unknown) {
    await this.open();
    if (!input || typeof input !== 'object') throw new Error('请输入供应商配置。');
    const value = input as Record<string, unknown>;
    const baseUrl = baseURL(value.baseUrl);
    let key = typeof value.apiKey === 'string' ? value.apiKey.trim() : '';
    if (!key && baseUrl === (this.settings?.baseUrl ?? defaultBaseUrl)) {
      const legacy = this.settings ? undefined : await this.credentials.read('deepseek');
      key = this.settings ? this.settings.apiKey : legacy?.type === 'api_key' ? legacy.key ?? '' : '';
    }
    return { name: field(value.name, '供应商名称', 100), baseUrl, apiKey: apiKey(key) };
  }
  private async fetchModels(settings: Awaited<ReturnType<ModelConnection['draft']>>, signal: AbortSignal): Promise<APIModel[]> {
    const found = new Map<string, APIModel>();
    let after = '';
    for (let page = 0; page < 100; page++) {
      const url = new URL(`${settings.baseUrl}/models`);
      if (after) url.searchParams.set('after', after);
      let status: number | undefined;
      let body: any;
      try {
        const response = await this.request(url, { headers: { Authorization: `Bearer ${settings.apiKey}`, Accept: 'application/json' }, signal, redirect: 'error' });
        status = response.status;
        if (!response.ok) throw new Error();
        body = await response.json();
      } catch { throw new Error(connectionError(status)); }
      if (!Array.isArray(body?.data)) throw new Error('供应商未返回兼容的模型列表，请检查 Base URL（通常以 /v1 结尾）。');
      for (const value of body.data) {
        if (!value || typeof value.id !== 'string' || !value.id.trim() || value.id.length > 512 || /[\x00-\x20\x7f]/.test(value.id)) continue;
        const limit = (number: unknown) => Number.isSafeInteger(number) && Number(number) > 0 ? Number(number) : undefined;
        found.set(value.id, { id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name.slice(0, 200) : value.id,
          contextWindow: limit(value.context_window ?? value.context_length), maxTokens: limit(value.max_output_tokens ?? value.top_provider?.max_completion_tokens),
          vision: Array.isArray(value.input_modalities) && value.input_modalities.includes('image') });
      }
      if (found.size > 20000) throw new Error('供应商返回的模型数量过多。');
      if (!body.has_more) {
        if (!found.size) throw new Error('供应商没有返回可用模型，请检查账号权限。');
        return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
      }
      const cursor = body.last_id ?? body.data.at(-1)?.id;
      if (typeof cursor !== 'string' || !cursor || cursor === after) break;
      after = cursor;
    }
    throw new Error('模型列表分页未完成，请重试。');
  }
  async discover(input: unknown) {
    return this.operation(async signal => {
      const settings = await this.draft(input);
      return { baseUrl: settings.baseUrl, models: await this.fetchModels(settings, signal) };
    });
  }
  private async persist(settings: ModelProviderSettings) {
    const temporary = `${this.settingsFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.settingsFile);
    } catch { throw new Error('Friday 无法保存模型连接，请检查主机数据目录的权限和可用空间。'); }
    finally { await rm(temporary, { force: true }); }
    this.apply(settings);
  }
  async save(input: unknown) {
    return this.operation(async signal => {
      const draft = await this.draft(input);
      const model = field((input as Record<string, unknown>).model, '模型', 512);
      const settings = { ...draft, model, models: await this.fetchModels(draft, signal) };
      if (!settings.models.some(item => item.id === model)) throw new Error('所选模型已不可用，请重新获取模型列表。');
      const probe = createModels();
      probe.setProvider(runtimeProvider(settings));
      let status: number | undefined;
      try {
        const result = await probe.completeSimple(probe.getModel(customProviderID, model)!, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, {
          maxTokens: 32, maxRetries: 0, signal, fetch: async (url, init) => {
            const response = await this.request(url, { ...init, redirect: 'error' }); status = response.status; return response;
          },
        });
        // Reasoning models can spend a short probe's entire budget on thinking.
        const answered = result.content.some(part => (part.type === 'text' && part.text.trim()) || (part.type === 'thinking' && part.thinking.trim()) || part.type === 'toolCall');
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || (!answered && result.stopReason !== 'length')) throw new Error();
        signal.throwIfAborted();
      } catch { throw new Error(connectionError(status)); }
      await this.persist(settings);
      return this.status(true);
    });
  }
  async saveKey(value: string) {
    await this.open();
    if (this.settings) return this.save({ ...this.settings, apiKey: value });
    const key = value.trim();
    if (!key || key.length > 512 || /[^\x21-\x7e]/.test(key)) throw new Error('请输入有效的 DeepSeek API Key。');
    if (this.pending) throw new Error('正在验证 DeepSeek API Key，请稍候。');
    const model = this.models.getModel(this.model.provider, this.model.modelId);
    if (!model) throw new Error('DeepSeek 模型不在当前目录中，请检查 FRIDAY_MODEL_ID。');
    const controller = this.controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    const operation = async () => {
      const probe = createModels();
      probe.setProvider({ ...provider(), auth: { apiKey: { name: 'DeepSeek API Key', resolve: async () => ({ auth: { apiKey: key } }) } } });
      let responseStatus: number | undefined;
      try {
        const result = await probe.completeSimple(model, { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] }, {
          maxTokens: 16, maxRetries: 0, signal, fetch: async (input, init) => {
            const response = await this.request(input, { ...init, redirect: 'error' }); responseStatus = response.status; return response;
          },
        });
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || !result.content.some(part => part.type === 'text' && part.text.trim())) throw new Error('Probe failed');
        signal.throwIfAborted();
      } catch { throw new Error(connectionError(responseStatus)); }
      try { await this.credentials.modify('deepseek', async () => ({ type: 'api_key', key })); }
      catch { throw new Error('Friday 无法保存 API Key，请检查主机数据目录的权限和可用空间。'); }
      return this.status(true);
    };
    this.pending = operation();
    try { return await this.pending; }
    finally { this.pending = undefined; this.controller = undefined; }
  }
  async clearKey() {
    return this.operation(async () => {
      await this.open();
      if (this.settings) { await this.persist({ ...this.settings, apiKey: '' }); return; }
      await this.credentials.delete('deepseek');
    });
  }
  async close() { this.controller?.abort(); await this.pending?.catch(() => {}); }
}
