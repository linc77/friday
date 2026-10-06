import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, type Credential, type CredentialStore, type AuthOperationOptions, type AuthPrompt } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';

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

type LoginState = { status: 'idle' | 'waiting' | 'connected' | 'error'; url?: string; error?: string; manual?: boolean };
export class ModelConnection {
  readonly credentials: ModelCredentials;
  readonly models;
  readonly model = { provider: 'openai', modelId: process.env.FRIDAY_MODEL_ID ?? 'gpt-6-sol' };
  private login: LoginState = { status: 'idle' };
  private controller?: AbortController;
  private completion?: Promise<void>;
  private starting?: Promise<Awaited<ReturnType<ModelConnection['status']>>>;
  private manual?: (value: string) => void;
  constructor(private directory: string) {
    this.credentials = new ModelCredentials(join(directory, 'model-auth.json'));
    this.models = createModels({ credentials: this.credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
    const provider = openaiProvider();
    // OAuth only: never silently switch to API-key billing when a login is missing.
    this.models.setProvider({ ...provider, auth: { oauth: provider.auth.oauth } });
  }
  async status(owner = false) {
    const connected = (await this.credentials.read('openai'))?.type === 'oauth';
    return { provider: 'OpenAI OAuth', model: this.model.modelId, connected, ...(owner ? { login: this.login } : {}) };
  }
  async ready() {
    if (!(await this.status()).connected) throw new Error('请先在「连接」中使用 OpenAI OAuth 登录 Friday。');
    if (!this.models.getModel(this.model.provider, this.model.modelId)) throw new Error('Friday 模型不在当前目录中，请检查 FRIDAY_MODEL_ID。');
  }
  startLogin() {
    if (this.starting) return this.starting;
    this.starting = this.beginLogin().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async beginLogin() {
    if (this.controller) return this.status(true);
    const deviceFile = join(this.directory, 'model-device-id');
    let deviceId: string;
    try { deviceId = (await readFile(deviceFile, 'utf8')).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      deviceId = randomUUID(); await writeFile(deviceFile, deviceId, { mode: 0o600, flag: 'wx' });
    }
    const controller = this.controller = new AbortController();
    this.login = { status: 'waiting' };
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); timeout.unref();
    let announced!: () => void;
    const announcement = new Promise<void>(resolve => { announced = resolve; });
    this.completion = this.models.login('openai', 'oauth', {
      signal: controller.signal,
      notify: info => {
        if (info.type === 'auth_url') {
          const url = new URL(info.url); url.searchParams.set('agent_name_hint', 'Friday');
          this.login = { status: 'waiting', url: url.toString() }; announced();
        }
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        if (prompt.type !== 'manual_code') { reject(new Error('不支持的 OAuth 登录步骤')); return; }
        const signal = AbortSignal.any([controller.signal, ...(prompt.signal ? [prompt.signal] : [])]);
        const abort = () => { this.manual = undefined; reject(new Error('登录已取消')); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        this.login.manual = true;
        this.manual = value => { signal.removeEventListener('abort', abort); this.manual = undefined; resolve(value); };
      }),
    }, { getDeviceId: () => deviceId }).then(() => { this.login = { status: 'connected' }; }).catch(() => {
      // Provider error bodies can contain sensitive data. Keep them out of API responses and logs.
      this.login = { status: 'error', error: controller.signal.aborted ? '登录已取消或超时，请重试。' : 'OpenAI 登录未完成，请检查网络及本机 1455 端口后重试。' };
    }).finally(() => { clearTimeout(timeout); this.controller = undefined; this.manual = undefined; announced(); });
    await announcement; return this.status(true);
  }
  completeLogin(value: string) { if (!this.manual) throw new Error('当前没有等待中的登录'); this.manual(value); }
  async logout() { this.controller?.abort(); await this.completion; await this.credentials.delete('openai'); this.login = { status: 'idle' }; }
  async close() { this.controller?.abort(); await this.completion; }
}
