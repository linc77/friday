import { selectedProviderOptions, type ProviderModelSelection } from './provider-models.js';
import { createHash } from 'node:crypto';
import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { defaultCodexSettings, expandHome, validateSettings, saveProviderSettings, type CodexSettings } from './codex-settings.js';
import { ProviderWorkspaceCache, type ProviderWorkspace } from './provider-workspace.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import type { WorkItem } from './types.js';
import { findExecutable } from './agents.js';

export type NativeProvider = 'cursor' | 'muse' | 'opencode';
export const nativeProviderName = (provider: NativeProvider) => ({ cursor: 'Cursor', muse: 'Muse Code', opencode: 'OpenCode' })[provider];
export type NativeProviderSettings = CodexSettings & { serverUrl?: string; serverPassword?: string };
export const nativeProviderDefaults = (provider: NativeProvider): NativeProviderSettings => ({ ...defaultCodexSettings, enabled: false, displayName: nativeProviderName(provider), binaryPath: provider === 'cursor' ? '' : provider, permissionMode: 'default' });
export function nativeProviderSettings(provider: NativeProvider, value: unknown, previous = nativeProviderDefaults(provider)): NativeProviderSettings {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined, effort = typeof input?.reasoningEffort === 'string' ? input.reasoningEffort.trim() : undefined;
  if (effort && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(effort)) throw new Error('原生推理选项格式无效');
  const result = validateSettings(input && effort !== undefined ? { ...input, reasoningEffort: effort } : value, previous, nativeProviderName(provider), provider === 'muse' ? undefined : effort ? [effort] : []);
  if (result.homePath || result.shadowHomePath || result.launchArgs) throw new Error('此工具的账号与启动方式由原生 SDK 管理，请使用环境变量配置');
  if (provider !== 'opencode') return result;
  const raw = value as Record<string, unknown>, serverUrl = raw.serverUrl ?? previous.serverUrl ?? '', serverPassword = raw.serverPassword === null ? previous.serverPassword ?? '' : raw.serverPassword ?? previous.serverPassword ?? '';
  if (typeof serverUrl !== 'string' || serverUrl.length > 2048 || typeof serverPassword !== 'string' || serverPassword.length > 16384 || serverPassword.includes('\0')) throw new Error('OpenCode 服务配置无效');
  if (serverUrl.trim()) {
    const url = new URL(serverUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('OpenCode 服务地址需要使用不含账号或查询参数的 HTTP(S) 地址');
  }
  return { ...result, serverUrl: serverUrl.trim().replace(/\/+$/, ''), serverPassword };
}
export async function loadNativeProviderSettings(directory: string, provider: NativeProvider): Promise<NativeProviderSettings> {
  try { return nativeProviderSettings(provider, JSON.parse(await readFile(join(directory, `${provider}-provider.json`), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return nativeProviderDefaults(provider); throw error; }
}
export function nativeProviderEnvironment(provider: NativeProvider, settings: NativeProviderSettings): NodeJS.ProcessEnv {
  const env = { ...process.env, ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])) };
  if (provider === 'muse') { for (const key of Object.keys(env)) if (key.toUpperCase() === 'META_API_KEY') delete env[key]; env.MUSE_NO_AUTO_UPDATE = '1'; }
  return env;
}
export function nativeProviderAccount(provider: NativeProvider, settings: NativeProviderSettings) {
  return createHash('sha256').update(JSON.stringify([provider, settings.binaryPath, settings.environment.toSorted((a, b) => a.name.localeCompare(b.name)), settings.serverUrl, settings.serverPassword])).digest('hex');
}
export async function nativeProviderCommand(provider: NativeProvider, settings: NativeProviderSettings) {
  const value = expandHome(settings.binaryPath), command = isAbsolute(value) ? value : findExecutable(value);
  if (!command) throw new Error(`找不到 ${nativeProviderName(provider)}，请检查工具安装和可执行文件路径`);
  await access(command, constants.X_OK); return command;
}

/** Cached native metadata and private settings; Durable still owns execution. */
export abstract class NativeProviderConnection {
  onConfigurationChanged?: () => Promise<void>;
  protected closed = false;
  protected resources = new Set<{ close(): Promise<unknown> }>();
  protected metadata = new ProviderWorkspaceCache<ModelStatus>(60_000);
  protected catalogs = new ProviderWorkspaceCache<ProviderWorkspace>();
  private saving = false;
  constructor(readonly directory: string, readonly provider: NativeProvider) {}
  protected empty(settings: NativeProviderSettings): ModelStatus {
    return { provider: this.provider, displayName: settings.displayName, enabled: settings.enabled, model: settings.model, installed: false, connected: false, loginPending: false, account: null, models: [], settings: null, checkedAt: new Date().toISOString(), version: null, error: null };
  }
  protected abstract probe(settings: NativeProviderSettings): Promise<ModelStatus>;
  abstract workspace(cwd: string, reload?: boolean, task?: WorkItem): Promise<ProviderWorkspace>;
  async status(owner = false, reload = false): Promise<ModelStatus> {
    const settings = await loadNativeProviderSettings(this.directory, this.provider), key = JSON.stringify(settings);
    const value = await this.metadata.read(key, reload, () => this.probe(settings));
    if (JSON.stringify(await loadNativeProviderSettings(this.directory, this.provider)) !== key) throw new Error('工具配置已改变，请重新加载');
    const { serverPassword, ...visible } = settings;
    return { ...value, models: appendCustomModels(value.models, settings.customModels), settings: owner ? { ...visible, ...(serverPassword !== undefined ? { serverPassword: null, serverPasswordConfigured: !!serverPassword } : {}), environment: settings.environment.map(entry => ({ name: entry.name, value: null, hasValue: true })) } : null };
  }
  async runtime(selection?: ProviderModelSelection) {
    if (this.closed || this.saving) throw new Error('工具连接正在关闭或保存配置');
    const state = await this.status(), settings = await loadNativeProviderSettings(this.directory, this.provider);
    if (!state.enabled || !state.connected) throw new Error(state.error ?? `请在 Providers 中启用并连接 ${nativeProviderName(this.provider)}`);
    const model = selection?.model || settings.model || state.model || state.models.find(model => model.isDefault)?.id || state.models[0]?.id;
    const selected: ProviderModel | undefined = state.models.find(value => value.id === model), options = selected ? selectedProviderOptions(selected, selection) : undefined;
    const effort = options?.effort || (selection?.model ? '' : settings.reasoningEffort);
    if (!model || !selected || effort && !selected.reasoningEfforts.includes(effort)) throw new Error('工具模型或推理选项已经改变，请重新选择');
    return { settings, model, effort, modelOptions: options?.values ?? {}, env: nativeProviderEnvironment(this.provider, settings), account: nativeProviderAccount(this.provider, settings) };
  }
  async save(value: unknown) {
    if (this.saving) throw new Error('正在保存工具配置'); this.saving = true;
    try { await saveProviderSettings(this.directory, `${this.provider}-provider.json`, nativeProviderSettings(this.provider, value, await loadNativeProviderSettings(this.directory, this.provider))); }
    finally { this.saving = false; }
    await this.onConfigurationChanged?.(); return this.status(true, true);
  }
  protected own<T extends { close(): Promise<unknown> }>(value: T): T { if (this.closed) { void value.close(); throw new Error('工具连接已经关闭'); } this.resources.add(value); return value; }
  async release(value: { close(): Promise<unknown> }) { this.resources.delete(value); await value.close(); }
  async close() { this.closed = true; await Promise.allSettled([...this.resources].map(value => this.release(value))); }
}
