import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, type Credential, type CredentialStore, type AuthOperationOptions } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';

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
  if (status === 401 || status === 403) return 'DeepSeek API Key 无效或没有访问权限，请检查后重试。';
  if (status === 402) return 'DeepSeek 账户余额不足，请充值后重试。';
  if (status === 429) return 'DeepSeek 请求过于频繁，请稍后重试。';
  if (status === 400 || status === 404 || status === 422) return 'DeepSeek 不支持当前模型或请求，请检查 FRIDAY_MODEL_ID。';
  if (status && status >= 500) return 'DeepSeek 服务暂时不可用，请稍后重试。';
  return '无法完成 DeepSeek 测试请求，请检查主机网络或代理后重试。';
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
  private pending?: Promise<Awaited<ReturnType<ModelConnection['status']>>>;
  constructor(directory: string) {
    this.credentials = new ModelCredentials(join(directory, 'model-auth.json'));
    // Use only the key explicitly saved for Friday; never borrow another app's credentials.
    this.models = createModels({ credentials: this.credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    this.models.setProvider(provider());
  }
  async status(_owner = false) {
    const credential = await this.credentials.read('deepseek');
    return { provider: 'DeepSeek API', model: this.model.modelId, connected: credential?.type === 'api_key' && !!credential.key };
  }
  async ready() {
    if (this.pending) throw new Error('正在验证 DeepSeek API Key，请稍候再发送消息。');
    if (!(await this.status()).connected) throw new Error('请先在「连接」中配置 DeepSeek API Key。');
    if (!this.models.getModel(this.model.provider, this.model.modelId)) throw new Error('DeepSeek 模型不在当前目录中，请检查 FRIDAY_MODEL_ID。');
  }
  async saveKey(value: string) {
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
            const response = await fetch(input, init); responseStatus = response.status; return response;
          },
        });
        if (result.stopReason === 'error' || result.stopReason === 'aborted' || !result.content.some(part => part.type === 'text' && part.text.trim())) throw new Error('Probe failed');
        signal.throwIfAborted();
      } catch { throw new Error(connectionError(responseStatus)); }
      try { await this.credentials.modify('deepseek', async () => ({ type: 'api_key', key })); }
      catch { throw new Error('Friday 无法保存 API Key，请检查主机数据目录的权限和可用空间。'); }
      return this.status();
    };
    this.pending = operation();
    try { return await this.pending; }
    finally { this.pending = undefined; this.controller = undefined; }
  }
  async clearKey() {
    if (this.pending) throw new Error('正在验证 DeepSeek API Key，请稍候。');
    await this.credentials.delete('deepseek');
  }
  async close() { this.controller?.abort(); await this.pending?.catch(() => {}); }
}
