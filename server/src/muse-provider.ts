import { spawnMspConnection, type MspHandshake, type SpawnedMspConnection, type Connection } from '@muse-code/sdk';
import { NativeProviderConnection, nativeProviderCommand, nativeProviderEnvironment, type NativeProviderSettings } from './native-provider-config.js';
import { acpRecord, type AcpRecord } from './acp-process.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import { workspaceCommand } from './git-process.js';
import type { ModelStatus } from './codex-provider.js';
import type { ProviderWorkspace } from './provider-workspace.js';
import type { WorkItem } from './types.js';

// Muse behavior follows T3 8cd9641f provider-muse/{sdk,status,modelCatalog}.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function museModels(input: unknown): ProviderModel[] {
  const value = acpRecord(input); if (value?.providerId !== 'meta' || !Array.isArray(value.models)) throw new Error('Muse 未返回原生模型列表');
  const seen = new Set<string>();
  return value.models.flatMap((model: AcpRecord): ProviderModel[] => {
    const id = typeof model?.modelId === 'string' ? model.modelId.trim() : '';
    if (!id || model.providerId !== 'meta' || seen.has(id)) return []; seen.add(id);
    const variants = (Array.isArray(model.variants) ? model.variants : ['low', 'medium', 'high', 'xhigh', 'max']).filter((value: unknown): value is string => typeof value === 'string' && efforts.includes(value));
    const preferred = Array.isArray(model.variants) ? model.defaultReasoningEffort : 'high', label = typeof model.displayLabel === 'string' ? model.displayLabel.trim() : '';
    return [{ id, name: label && label !== id ? label : id.startsWith('muse-') ? id.replaceAll('-', ' ').replace(/\b[a-z]/g, char => char.toUpperCase()) : id, description: '', isDefault: model.isDefault === true,
      reasoningEfforts: [...new Set<string>(variants)], defaultReasoningEffort: variants.includes(preferred) ? preferred : variants[0] ?? '' }];
  });
}
export const museServeArgs = (readOnly: boolean, mode = 'default') => readOnly ? ['serve', '--disable-shell', '--disable-write', '--no-session-log'] : ['serve', '--trust-workspace', ...(mode === 'auto' ? ['--disable-sandbox'] : [])];

export class MuseProcess {
  readonly handshake: MspHandshake;
  host?: SpawnedMspConnection;
  onNotification?: (method: string, params: AcpRecord) => void;
  onFailure?: (error: Error) => void;
  private closing?: Promise<unknown>;
  constructor(command: string, cwd: string, env: NodeJS.ProcessEnv, readonly readOnly: boolean, mode = 'default') {
    this.handshake = spawnMspConnection({ command, args: museServeArgs(readOnly, mode), cwd, env, shutdownTimeoutMs: 500, connection: { frameLimitBytes: 64 * 1024 * 1024 } });
    this.handshake.onNotification(value => { const params = acpRecord(value.params); if (params) this.onNotification?.(value.method, params); });
    this.handshake.onProtocolError(() => { if (!this.closing) this.onFailure?.(new Error('Muse 原生通信异常，已停止；不会自动重试')); });
    this.handshake.onServerRequest(async value => {
      if (['approval/request', 'userInput/request'].includes(value.method)) return {};
      throw new Error('Friday 不支持此 Muse 请求');
    });
    void this.handshake.exited.then(value => { if (!this.closing) this.onFailure?.(new Error(`Muse 进程已退出（${value.code ?? value.signal}）`)); });
  }
  async initialize() {
    this.host = await this.deadline(this.handshake.initialize({ clientInfo: { name: 'friday', title: 'Friday', version: '1' }, capabilities: { requestedCapabilities: this.readOnly ? [] : ['sessionMcp'] } }), 8000);
    if (this.host.initializeResult.schema?.version !== 1) { await this.close(); throw new Error('Muse 原生协议版本不受支持'); }
    return this.host;
  }
  get connection(): Connection { if (!this.host) throw new Error('Muse 尚未初始化'); return this.host.connection; }
  async call(method: string, params: AcpRecord = {}, command = false, commandId?: string) {
    const pending = command ? this.connection.command(method, params, { maxAttempts: 1, ...(commandId ? { commandId } : {}) }) : this.connection.request(method, params);
    return this.deadline(pending, 30_000);
  }
  private async deadline<T>(pending: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => { void this.close(); reject(new Error('Muse 原生请求超时，已关闭连接；不会自动重试')); }, timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  close(): Promise<unknown> { return this.closing ??= this.handshake.close(); }
}

export class MuseConnection extends NativeProviderConnection {
  constructor(directory: string) { super(directory, 'muse'); }
  async client(settings: NativeProviderSettings, cwd = this.directory, readOnly = false) {
    if (this.closed) throw new Error('Muse 连接已关闭');
    const client = this.own(new MuseProcess(await nativeProviderCommand('muse', settings), cwd, nativeProviderEnvironment('muse', settings), readOnly, settings.permissionMode));
    try { await client.initialize(); return client; } catch (error) { await this.release(client); throw error; }
  }
  protected async probe(settings: NativeProviderSettings): Promise<ModelStatus> {
    const state = this.empty(settings); let client: MuseProcess | undefined;
    try {
      const command = await nativeProviderCommand('muse', settings); state.installed = true; if (!settings.enabled) return state;
      const version = await workspaceCommand(this.directory, command, ['--version'], { env: nativeProviderEnvironment('muse', settings), timeout: 4000, limit: 1024 * 1024 });
      if (version.code !== 0) throw new Error('Muse 已安装但无法正常运行'); state.version = (version.stdout + version.stderr).match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      client = await this.client(settings, this.directory, true); state.models = museModels(await client.call('model/list'));
      // MSP's cached model/list has no authentication signal. Readiness permits
      // an attempt; account:null never claims a successful host login.
      state.connected = state.models.length > 0; state.model = settings.model || state.models.find(value => value.isDefault)?.id || state.models[0]?.id || '';
      if (!state.connected) state.error = 'Muse 尚未返回模型，请在主机运行 muse login 后重新检测';
    } catch (error) { state.error = error instanceof Error ? error.message : '无法检测 Muse'; }
    finally { if (client) await this.release(client); }
    return state;
  }
  async workspace(cwd: string, _reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const runtime = await this.runtime();
    if (task?.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 Muse 会话使用的账号配置');
    return { provider: 'muse', cwd, checkedAt: new Date().toISOString(), commands: [{ name: 'compact', builtin: true, description: 'Summarize the conversation and reduce context usage' }], skills: [] };
  }
}
