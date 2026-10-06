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

// Do not return raw provider errors: token endpoints can echo credentials or callback details.
export function loginError(error: unknown, exchanging: boolean, aborted: boolean): string {
  if (aborted) return '登录已取消或超时，请重试。';
  const message = error instanceof Error ? error.message : '';
  const codes: string[] = []; let cause: unknown = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === 'object'; depth++) {
    const item = cause as { code?: unknown; cause?: unknown };
    if (typeof item.code === 'string') codes.push(item.code);
    cause = item.cause;
  }
  const stage = exchanging ? '浏览器已返回，但 Friday 交换登录凭据失败。' : 'Friday 登录未完成。';
  if (codes.some(c => c === 'ENOTFOUND' || c === 'EAI_AGAIN')) return stage + '服务无法解析 OpenAI 地址，请检查主机网络或代理后重新登录。';
  if (codes.some(c => ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(c))) return stage + '服务无法连接 OpenAI，请检查主机网络或代理后重新登录。';
  if (codes.includes('EADDRINUSE') || message.startsWith('Port 1455 is in use')) return '本机登录回调端口 1455 正被其他登录占用，请结束那次登录后重试。';
  const response = message.match(/^OpenAI OAuth token request failed \((\d{3})\):\s*([\s\S]*)$/);
  if (response) {
    let code = '';
    try {
      const body = JSON.parse(response[2]); const value = typeof body.error === 'string' ? body.error : body.error?.code;
      if (['invalid_grant', 'invalid_client', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope', 'invalid_resource', 'access_denied', 'temporarily_unavailable', 'server_error'].includes(value)) code = value;
    } catch { /* Non-JSON response bodies stay private. */ }
    return stage + `OpenAI 拒绝了凭据交换（HTTP ${response[1]}${code ? `，${code}` : ''}），请重新发起登录。`;
  }
  if (message.includes('chatgpt.tokens.use.direct')) return 'OpenAI 未授予模型调用权限，请重新登录并完成授权。';
  if (codes.includes('EACCES') || codes.includes('ENOSPC')) return 'Friday 无法保存登录凭据，请检查主机数据目录的权限和可用空间。';
  return stage + '请重新登录；如果浏览器显示成功，请以 Friday 的连接状态为准。';
}
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
    const registrationFile = join(this.directory, 'openai-registration.json');
    let clientId: string | undefined;
    try { clientId = JSON.parse(await readFile(registrationFile, 'utf8')).clientId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!clientId) {
      const credential = await this.credentials.read('openai');
      if (credential?.type === 'oauth' && typeof credential.clientId === 'string') clientId = credential.clientId;
    }
    const deviceFile = join(this.directory, 'model-device-id');
    let deviceId: string;
    try { deviceId = (await readFile(deviceFile, 'utf8')).trim(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      deviceId = randomUUID(); await writeFile(deviceFile, deviceId, { mode: 0o600, flag: 'wx' });
    }
    const controller = this.controller = new AbortController();
    let exchanging = false;
    this.login = { status: 'waiting' };
    const timeout = setTimeout(() => controller.abort(), 5 * 60_000); timeout.unref();
    let announced!: () => void;
    const announcement = new Promise<void>(resolve => { announced = resolve; });
    this.completion = this.models.login('openai', 'oauth', {
      signal: controller.signal,
      notify: info => {
        if (info.type === 'progress') { exchanging = true; this.login.manual = false; }
        if (info.type === 'auth_url') {
          const url = new URL(info.url);
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
    }, { getDeviceId: () => deviceId, openai: { clientId, agentName: 'Friday', onClientId: async issuedId => {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(issuedId) || issuedId === 'dynamic_agent_client') throw new Error('OpenAI 返回的客户端注册无效');
      const temporary = `${registrationFile}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify({ clientId: issuedId }), { mode: 0o600, flag: 'wx' }); await rename(temporary, registrationFile); }
      finally { await rm(temporary, { force: true }); }
    } } }).then(() => { this.login = { status: 'connected' }; }).catch(error => {
      // Provider error bodies can contain sensitive data. Keep them out of API responses and logs.
      this.login = { status: 'error', error: loginError(error, exchanging, controller.signal.aborted) };
    }).finally(() => { clearTimeout(timeout); this.controller = undefined; this.manual = undefined; announced(); });
    await announcement; return this.status(true);
  }
  completeLogin(value: string) { if (!this.manual) throw new Error('当前没有等待中的登录'); this.manual(value); }
  async logout() { this.controller?.abort(); await this.completion; await this.credentials.delete('openai'); await rm(join(this.directory, 'openai-registration.json'), { force: true }); this.login = { status: 'idle' }; }
  async close() { this.controller?.abort(); await this.completion; }
}
