import { readCursorUsage, releaseCursorUsage } from './native-provider-usage.js';
import type { ProviderUsageLimits } from './provider-usage-limits.js';
import { ProviderWorkspaceCache } from './provider-workspace.js';
import { selectedProviderOptions, type ProviderModelSelection, type ProviderOptionDescriptor } from './provider-models.js';
import { createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SDKModel } from '@cursor/sdk';
import { NativeProviderConnection, loadNativeProviderSettings, nativeProviderEnvironment, nativeProviderAccount, type NativeProviderSettings } from './native-provider-config.js';
import { AcpProcess, type AcpRecord } from './acp-process.js';
import type { ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import type { WorkItem } from './types.js';
import type { ProviderWorkspace } from './provider-workspace.js';
import { cursorSkills } from './cursor-skills.js';

export type CursorModel = ProviderModel & { nativeEffortId?: string };
const cursorOptionID = (id: string) => id === 'context' ? 'contextWindow' : id === 'fast' ? 'fastMode' : id;
const cursorParameterID = (id: string) => id === 'contextWindow' ? 'context' : id === 'fastMode' ? 'fast' : id;
export function cursorOptionDescriptors(model: SDKModel): ProviderOptionDescriptor[] {
  const result: ProviderOptionDescriptor[] = [], seen = new Set<string>();
  for (const parameter of model.parameters ?? []) {
    const id = cursorOptionID(parameter.id.trim()), choices = [...new Map(parameter.values.filter(value => value.value.trim()).map(value => [value.value, { id: value.value, label: value.displayName || value.value }])).values()];
    if (!id || seen.has(id) || !choices.length) continue; seen.add(id);
    const current = model.variants?.find(variant => variant.isDefault)?.params.find(value => value.id === parameter.id)?.value;
    if (choices.length === 2 && choices.every(value => ['true', 'false'].includes(value.id))) result.push({ id, label: parameter.displayName || id, type: 'boolean', ...(['true', 'false'].includes(current ?? '') ? { currentValue: current === 'true' } : {}) });
    else result.push({ id, label: parameter.displayName || id, type: 'select', options: choices.map(value => ({ ...value, ...(value.id === current ? { isDefault: true } : {}) })), ...(current ? { currentValue: current } : {}) });
  }
  return result;
}
export function cursorModels(value: unknown): CursorModel[] {
  if (!Array.isArray(value)) throw new Error('Cursor SDK 未返回模型列表');
  const seen = new Set<string>();
  return value.flatMap((model: SDKModel): CursorModel[] => {
    const id = typeof model?.id === 'string' ? model.id.trim() : '', name = typeof model?.displayName === 'string' ? model.displayName.trim() : '';
    if (!id || !name || seen.has(id)) return []; seen.add(id);
    const effort = model.parameters?.find(parameter => ['effort', 'reasoning'].includes(parameter.id.trim()));
    const values = [...new Set(effort?.values.map(value => value.value.trim()).filter(Boolean) ?? [])];
    const preferred = model.variants?.find(variant => variant.isDefault)?.params.find(value => value.id === effort?.id)?.value;
    return [{ id, name, optionDescriptors: cursorOptionDescriptors(model), description: model.description ?? '', isDefault: id === 'default', reasoningEfforts: values, defaultReasoningEffort: preferred && values.includes(preferred) ? preferred : '', ...(effort ? { nativeEffortId: effort.id } : {}) }];
  });
}
export class CursorConnection extends NativeProviderConnection {
  private usageController = new AbortController();
  private usageCache = new ProviderWorkspaceCache<ProviderUsageLimits>(60_000);
  async usageLimits(reload = false, task?: import('./types.js').WorkItem) {
    const settings = await loadNativeProviderSettings(this.directory, 'cursor');
    if (task?.nativeProviderAccount && task.nativeProviderAccount !== await this.accountIdentity(settings)) throw new Error('请恢复这条 Cursor 会话使用的账号');
    const result = await this.usageCache.read(JSON.stringify(settings), reload, () => settings.enabled ? readCursorUsage(nativeProviderEnvironment('cursor', settings), settings.cursorUsageKeychainEnabled === true, this, { signal: this.usageController.signal }) : Promise.resolve({ checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: 'unsupported' } }));
    if (this.closed || JSON.stringify(await loadNativeProviderSettings(this.directory, 'cursor')) !== JSON.stringify(settings)) throw new Error('Provider 额度所属配置已改变，请重新加载');
    return result;
  }
  private credentialSignature = '';
  private loginProcess?: AcpProcess;
  private loginUrl?: string;
  private loginTimer?: NodeJS.Timeout;
  readonly credentialsPath: string;
  constructor(directory: string, private options: { sdkModule?: string } = {}) { super(directory, 'cursor'); this.credentialsPath = join(directory, 'cursor', 'auth.json'); }
  private async credential(settings: NativeProviderSettings) {
    const env = nativeProviderEnvironment('cursor', settings); let value: AcpRecord | undefined;
    try { value = JSON.parse(await readFile(this.credentialsPath, 'utf8')); } catch { /* Missing or invalid stored login is unauthenticated. */ }
    const key = env.CURSOR_API_KEY?.trim() || (value?.version === 1 && typeof value.apiKey === 'string' && (!value.apiKeyExpiresAtMs || value.apiKeyExpiresAtMs > Date.now()) ? value.apiKey : '');
    const backend = env.CURSOR_BACKEND_URL || (!env.CURSOR_API_KEY && typeof value?.backendUrl === 'string' ? value.backendUrl : '');
    return { fingerprint: key ? createHash('sha256').update(JSON.stringify([key, backend])).digest('hex') : '', hasKey: !!key };
  }
  async status(owner = false, reload = false): Promise<ModelStatus> {
    const signature = (await this.credential(await loadNativeProviderSettings(this.directory, 'cursor'))).fingerprint;
    const changed = signature !== this.credentialSignature; this.credentialSignature = signature;
    const state = await super.status(owner, reload || changed); return { ...state, loginPending: !!this.loginProcess };
  }
  async client(settings: NativeProviderSettings, cwd = this.directory) {
    if (this.closed) throw new Error('Cursor 连接已关闭');
    await mkdir(join(this.directory, 'cursor'), { recursive: true, mode: 0o700 });
    const source = import.meta.url.endsWith('.ts'), path = fileURLToPath(new URL(source ? './cursor-worker.ts' : './cursor-worker.js', import.meta.url));
    return this.own(new AcpProcess('Cursor', process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), path, `--credentials=${this.credentialsPath}`, ...(this.options.sdkModule ? [`--sdk-module=${this.options.sdkModule}`] : [])], cwd, nativeProviderEnvironment('cursor', settings)));
  }
  protected async probe(settings: NativeProviderSettings): Promise<ModelStatus> {
    const state = this.empty(settings); state.installed = true; state.version = '1.0.35'; if (!settings.enabled) return state;
    let client: AcpProcess | undefined;
    try {
      if (!(await this.credential(settings)).hasKey) throw new Error('请连接 Cursor 账号或配置 CURSOR_API_KEY');
      client = await this.client(settings); const result = await client.call('cursor/probe', {}, 12_000); state.models = cursorModels(result.models);
      state.connected = state.models.length > 0; state.model = settings.model || state.models.find(value => value.isDefault)?.id || state.models[0]?.id || '';
      state.account = { type: 'cursor', email: typeof result.user?.userEmail === 'string' ? result.user.userEmail : null, plan: null };
      if (!state.connected) state.error = 'Cursor 当前账号没有返回模型';
    } catch (error) { state.error = error instanceof Error ? error.message : 'Cursor SDK 检测失败'; }
    finally { if (client) await this.release(client); }
    return state;
  }
  async runtime(selection?: ProviderModelSelection) {
    const value = await super.runtime(selection), auth = await this.credential(value.settings), state = await this.status();
    const nativeModel = state.models.find(model => model.id === value.model) as CursorModel | undefined;
    if (!nativeModel) throw new Error('Cursor 模型已经改变，请重新选择');
    return { ...value, account: createHash('sha256').update(JSON.stringify([nativeProviderAccount('cursor', value.settings), auth.fingerprint])).digest('hex'), fingerprint: auth.fingerprint,
      nativeModel: { id: value.model === 'auto' ? 'default' : value.model, ...((Object.keys(value.modelOptions).length || value.effort && nativeModel.nativeEffortId) ? { params: [...Object.entries(value.modelOptions).filter(([id]) => id !== 'reasoningEffort').map(([id, value]) => ({ id: cursorParameterID(id), value: String(value) })), ...(value.effort && nativeModel.nativeEffortId && !Object.hasOwn(value.modelOptions, nativeModel.nativeEffortId) ? [{ id: nativeModel.nativeEffortId, value: value.effort }] : [])] } : {}) } };
  }
  async accountIdentity(settings: NativeProviderSettings) { return createHash('sha256').update(JSON.stringify([nativeProviderAccount('cursor', settings), (await this.credential(settings)).fingerprint])).digest('hex'); }
  async save(value: unknown) {
    if (this.loginProcess) { const previous = this.loginProcess; this.loginProcess = undefined; this.loginUrl = undefined; clearTimeout(this.loginTimer); await this.release(previous); }
    const state = await super.save(value); if (!state.enabled || state.settings?.cursorUsageKeychainEnabled !== true) releaseCursorUsage(this); return state;
  }
  stateRoot(cwd: string) { return join(this.directory, 'cursor', 'sessions', createHash('sha256').update(cwd).digest('hex').slice(0, 24)); }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const runtime = await this.runtime(); if (task?.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 Cursor 会话使用的账号');
    return this.catalogs.read(JSON.stringify([runtime.account, cwd]), reload, async () => ({ provider: 'cursor', cwd, checkedAt: new Date().toISOString(), commands: [{ name: 'compact', builtin: true, description: 'Compress this conversation' }], skills: await cursorSkills(cwd, runtime.env) }));
  }
  async login() {
    if (this.loginProcess && this.loginUrl) return { url: this.loginUrl };
    const settings = await loadNativeProviderSettings(this.directory, 'cursor');
    if (!settings.enabled || nativeProviderEnvironment('cursor', settings).CURSOR_API_KEY) throw new Error('请先启用 Cursor；配置 API Key 时使用密钥连接');
    const client = await this.client(settings); this.loginProcess = client;
    const end = async () => { if (this.loginProcess !== client) return; this.loginProcess = undefined; this.loginUrl = undefined; clearTimeout(this.loginTimer); await this.release(client); await this.onConfigurationChanged?.(); };
    client.onNotification = method => { if (method === 'cursor/login-complete') void end(); };
    client.onExit = () => { void end(); };
    try { const result = await client.call('cursor/login', {}, 12_000); if (typeof result.url !== 'string' || !/^https?:\/\//.test(result.url)) throw new Error('Cursor 未返回登录地址'); this.loginUrl = result.url; this.loginTimer = setTimeout(() => { void end(); }, 300_000); return { url: result.url }; }
    catch (error) { await end(); throw error; }
  }
  async close() { this.usageController.abort(); releaseCursorUsage(this); clearTimeout(this.loginTimer); await super.close(); }
}
