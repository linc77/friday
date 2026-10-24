import { readGrokUsage } from './native-provider-usage.js';
import type { ProviderUsageLimits } from './provider-usage-limits.js';
import { selectedProviderOptions, type ProviderModelSelection } from './provider-models.js';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { findExecutable } from './agents.js';
import { defaultCodexSettings, expandHome, saveProviderSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import { ProviderWorkspaceCache, type ProviderWorkspace } from './provider-workspace.js';
import type { WorkItem } from './types.js';
import { AcpProcess, acpRecord, type AcpRecord } from './acp-process.js';
import { acpInitializeRequest, acpInitializeResponse } from './acp-protocol.js';
import { workspaceCommand } from './git-process.js';

// Grok wire behavior follows T3 8cd9641f provider-grok/{acpSupport,status,skills}.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export const defaultGrokSettings: CodexSettings = { ...defaultCodexSettings, enabled: false, displayName: 'Grok', binaryPath: 'grok', permissionMode: 'default' };
export const validGrokEffort = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(value);
export function grokSpawnArgs(mode?: string) {
  return mode === undefined ? ['agent', 'stdio'] : mode === 'auto' ? ['--permission-mode', 'auto', 'agent', 'stdio'] : mode === 'fullAccess' ? ['agent', '--always-approve', 'stdio'] : ['--permission-mode', 'default', 'agent', 'stdio'];
}
export function validateGrokSettings(value: unknown, previous = defaultGrokSettings) {
  const raw = acpRecord(value)?.reasoningEffort, effort = typeof raw === 'string' ? raw.trim() : raw;
  if (effort && !validGrokEffort(effort)) throw new Error('Grok 推理选项格式无效');
  const settings = validateSettings(typeof raw === 'string' ? { ...acpRecord(value), reasoningEffort: effort } : value, previous, 'Grok', effort ? [effort] : []);
  if (settings.shadowHomePath || settings.launchArgs) throw new Error('Grok 的会话和启动参数由 Friday 管理，请通过配置目录和环境变量配置账号');
  if (settings.environment.some(entry => ['GROK_HOME', 'GROK_OAUTH2_REFERRER'].includes(entry.name))) throw new Error('请通过 Grok 配置目录管理账号');
  return settings;
}
export async function loadGrokSettings(directory: string): Promise<CodexSettings> {
  try { return validateGrokSettings(JSON.parse(await readFile(join(directory, 'grok-provider.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultGrokSettings); throw error; }
}
export function grokAccountEnvironment(settings: CodexSettings) {
  const home = resolve(expandHome(settings.homePath || process.env.GROK_HOME || join(homedir(), '.grok')));
  return { home, env: { ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])), GROK_HOME: home } as NodeJS.ProcessEnv };
}
const defaultModel = (): ProviderModel => ({ id: 'grok-build', name: 'Grok Build', description: '', isDefault: false, reasoningEfforts: [], defaultReasoningEffort: '' });
export function grokModelInventory(state: unknown): ProviderModel[] {
  const models = acpRecord(state), seen = new Set<string>(), result: ProviderModel[] = [];
  for (const input of Array.isArray(models?.availableModels) ? models.availableModels : []) {
    const model = acpRecord(input), id = typeof model?.modelId === 'string' ? model.modelId.trim() : '';
    if (!id || seen.has(id)) continue; seen.add(id);
    const meta = acpRecord(model!._meta), options: { value: string; isDefault: boolean }[] = [], known = new Set<string>();
    if (meta?.supportsReasoningEffort !== false) for (const option of Array.isArray(meta?.reasoningEfforts) ? meta.reasoningEfforts : []) {
      const value = typeof option?.value === 'string' && validGrokEffort(option.value.trim()) ? option.value.trim() : typeof option?.id === 'string' && validGrokEffort(option.id.trim()) ? option.id.trim() : '';
      if (value && !known.has(value)) { known.add(value); options.push({ value, isDefault: option.default === true || option.isDefault === true }); }
    }
    const current = typeof meta?.reasoningEffort === 'string' && known.has(meta.reasoningEffort.trim()) ? meta.reasoningEffort.trim() : '';
    const preferred = options.filter(value => value.isDefault);
    result.push({ id, name: typeof model!.name === 'string' && model!.name.trim() ? model!.name.trim() : id, description: typeof model!.description === 'string' ? model!.description : '', isDefault: id === models?.currentModelId?.trim(), reasoningEfforts: options.map(value => value.value), defaultReasoningEffort: preferred.find(value => value.value === current)?.value ?? preferred[0]?.value ?? current });
  }
  return result;
}
export function grokModelsCLI(output: string): { authenticated: boolean | null; models: ProviderModel[] } {
  const authenticated = /you are logged in/i.test(output) ? true : /not authenticated|not logged in/i.test(output) ? false : null;
  const seen = new Set<string>(), models: ProviderModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*[*-]\s+(\S+)(.*)$/); if (!match?.[1] || seen.has(match[1])) continue;
    const id = match[1]; seen.add(id); models.push({ id, name: id.split(/[-_]/).map(value => value.toLowerCase() === 'grok' ? 'Grok' : value).join(' '), description: '', isDefault: /\(default\)/i.test(match[2] ?? ''), reasoningEfforts: [], defaultReasoningEffort: '' });
  }
  return { authenticated, models };
}
export function grokCommands(initialized: AcpRecord): ProviderWorkspace['commands'] {
  const commands = new Map<string, ProviderWorkspace['commands'][number]>([['compact', { name: 'compact', builtin: true, description: 'Summarize the conversation and reduce context usage' }]]);
  const entries = initialized._meta?.availableCommands;
  for (const command of Array.isArray(entries) ? entries : []) {
    const name = typeof command?.name === 'string' ? command.name.trim() : '';
    if (!name || ['always-approve', 'context'].includes(name.toLowerCase())) continue;
    commands.set(name, { name, ...(typeof command.description === 'string' ? { description: command.description } : {}), ...(typeof command.input?.hint === 'string' ? { argumentHint: command.input.hint } : {}) });
  }
  return [...commands.values()];
}
export const grokModelState = (initialized: AcpRecord) => acpRecord(initialized._meta?.modelState);

export class GrokConnection {
  private usageController = new AbortController();
  private usageCache = new ProviderWorkspaceCache<ProviderUsageLimits>(60_000);
  async usageLimits(reload = false, task?: WorkItem) {
    const settings = await loadGrokSettings(this.directory), account = grokAccountEnvironment(settings);
    if (task?.grokHome && task.grokHome !== account.home) throw new Error('请恢复这条 Grok 会话使用的账号目录');
    const result = await this.usageCache.read(JSON.stringify(settings), reload, () => settings.enabled ? readGrokUsage({ ...process.env, ...account.env }, { signal: this.usageController.signal }) : Promise.resolve({ checkedAt: new Date().toISOString(), windows: [], unavailable: { reason: 'unsupported' } }));
    if (this.closed || JSON.stringify(await loadGrokSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Provider 额度所属配置已改变，请重新加载');
    return result;
  }
  onConfigurationChanged?: () => Promise<void>;
  private cache = new ProviderWorkspaceCache<ModelStatus>(60_000);
  private workspaces = new ProviderWorkspaceCache();
  private clients = new Set<AcpProcess>();
  private probes = new Map<Promise<unknown>, AbortController>();
  private saving = false;
  private closed = false;
  constructor(readonly directory: string) {}
  private async configured(settings: CodexSettings) {
    const binary = expandHome(settings.binaryPath), command = isAbsolute(binary) ? binary : findExecutable(binary);
    if (!command) throw new Error('找不到 Grok，请检查可执行文件路径'); await access(command, constants.X_OK);
    const account = grokAccountEnvironment(settings);
    return { command, home: account.home, env: { ...process.env, ...account.env, GROK_OAUTH2_REFERRER: 'friday' } as NodeJS.ProcessEnv, permissionMode: settings.permissionMode };
  }
  private async collect(configured: { command: string; env: NodeJS.ProcessEnv }, args: string[], cwd = this.directory) {
    if (this.closed) throw new Error('Grok 连接已关闭');
    const controller = new AbortController(), pending = workspaceCommand(cwd, configured.command, args, { env: { ...configured.env, GROK_DISABLE_AUTOUPDATER: '1' }, signal: controller.signal, timeout: 4000, limit: 1024 * 1024 });
    this.probes.set(pending, controller); try { return await pending; } finally { this.probes.delete(pending); }
  }
  client(configured: { command: string; env: NodeJS.ProcessEnv; permissionMode?: string }, cwd = this.directory, probe = false) {
    if (this.closed) throw new Error('Grok 连接已关闭');
    const client = new AcpProcess('Grok', configured.command, grokSpawnArgs(probe ? undefined : configured.permissionMode), cwd, { ...configured.env, ...(probe ? { GROK_DISABLE_AUTOUPDATER: '1' } : {}) });
    this.clients.add(client); return client;
  }
  async initialize(client: AcpProcess) {
    return acpInitializeResponse(await client.call('initialize', acpInitializeRequest(), 8000));
  }
  async release(client: AcpProcess) { this.clients.delete(client); await client.close(); }
  async status(owner = false, reload = false): Promise<ModelStatus> {
    const settings = await loadGrokSettings(this.directory), key = JSON.stringify(settings);
    const value = await this.cache.read(key, reload, async () => {
      const result: ModelStatus = { provider: 'grok', displayName: settings.displayName, enabled: settings.enabled, model: settings.model || 'grok-build', installed: false, connected: false, loginPending: false, account: null, models: [defaultModel()], settings: null, checkedAt: new Date().toISOString(), version: null, error: null };
      let client: AcpProcess | undefined;
      try {
        const configured = await this.configured(settings); result.installed = true; if (!settings.enabled) return result;
        client = this.client(configured, this.directory, true);
        const [version, cli, metadata] = await Promise.allSettled([this.collect(configured, ['--version']), this.collect(configured, ['models']), this.initialize(client)]);
        if (version.status !== 'fulfilled' || version.value.code !== 0) throw new Error('Grok 已安装但无法正常运行');
        result.version = version.value.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
        const listing = cli.status === 'fulfilled' && cli.value.code === 0 ? grokModelsCLI(cli.value.stdout + '\n' + cli.value.stderr) : { authenticated: null, models: [] };
        const native = metadata.status === 'fulfilled' ? grokModelInventory(grokModelState(metadata.value)) : [];
        result.models = native.length ? native : listing.models.length ? listing.models : [defaultModel()];
        result.model = settings.model || result.models.find(value => value.isDefault)?.id || result.models[0]!.id;
        const authenticated = !!configured.env.XAI_API_KEY?.trim() || listing.authenticated === true;
        result.connected = authenticated;
        result.account = authenticated ? { type: configured.env.XAI_API_KEY?.trim() ? 'apiKey' : 'grok', email: null, plan: null } : null;
        if (!authenticated) result.error = listing.authenticated === false ? 'Grok 尚未登录，请在主机运行 grok login 或配置 XAI_API_KEY' : '无法确认 Grok 登录状态，请重新检测';
      } catch (error) { result.error = (error as Error).message; }
      finally { if (client) await this.release(client); }
      return result;
    });
    if (JSON.stringify(await loadGrokSettings(this.directory)) !== key) throw new Error('Grok 配置已经改变，请重新加载');
    return { ...value, models: appendCustomModels(value.models, settings.customModels), settings: owner ? { ...settings, environment: settings.environment.map(entry => ({ name: entry.name, value: null, hasValue: true })) } : null };
  }
  async runtime(selection?: ProviderModelSelection) {
    if (this.saving) throw new Error('正在保存 Grok 配置');
    const state = await this.status(), settings = await loadGrokSettings(this.directory);
    if (!state.enabled || !state.connected) throw new Error(state.enabled ? state.error ?? 'Grok 尚未就绪' : '请先在「Providers → Grok」中启用 Grok');
    const model = selection?.model || settings.model || state.model, selected = model === 'grok-build' ? defaultModel() : state.models.find(value => value.id === model);
    const options = selected ? selectedProviderOptions(selected, selection) : undefined;
    const effort = options?.effort || (selection?.model ? '' : settings.reasoningEffort);
    if (!selected || effort && !selected.reasoningEfforts.includes(effort)) throw new Error('Grok 模型或推理选项已不可用，请重新选择');
    return { ...await this.configured(settings), model, effort };
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const settings = await loadGrokSettings(this.directory), configured = await this.runtime();
    if (task?.grokHome && task.grokHome !== configured.home) throw new Error('请恢复这条 Grok 会话使用的配置目录');
    return this.workspaces.read(JSON.stringify([settings, cwd]), reload, async () => {
      const client = this.client(configured, cwd, true);
      try {
        const [initialized, inspection] = await Promise.all([this.initialize(client), this.collect(configured, ['inspect', '--json'], cwd)]);
        let data: AcpRecord | undefined; try { if (inspection.code === 0) data = acpRecord(JSON.parse(inspection.stdout)); } catch { /* Unavailable metadata is not a skill. */ }
        const skills = new Map<string, ProviderWorkspace['skills'][number]>();
        for (const entry of Array.isArray(data?.skills) ? data.skills : []) {
          const name = typeof entry?.name === 'string' ? entry.name.trim() : '', path = typeof entry?.source?.path === 'string' ? entry.source.path.trim() : '';
          if (name && path) skills.set(name, { name, path, enabled: entry.userInvocable !== false, ...(typeof entry.description === 'string' ? { description: entry.description } : {}), ...(typeof entry.source.type === 'string' ? { scope: entry.source.type } : {}) });
        }
        if (JSON.stringify(await loadGrokSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Grok 配置已经改变，请重新加载');
        return { provider: 'grok', cwd, checkedAt: new Date().toISOString(), commands: grokCommands(initialized), skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)) };
      } finally { await this.release(client); }
    });
  }
  async save(value: unknown) {
    if (this.saving) throw new Error('正在保存 Grok 配置'); this.saving = true;
    try { await saveProviderSettings(this.directory, 'grok-provider.json', validateGrokSettings(value, await loadGrokSettings(this.directory))); }
    finally { this.saving = false; }
    await this.onConfigurationChanged?.(); return this.status(true, true);
  }
  async close() { this.usageController.abort(); this.closed = true; for (const controller of this.probes.values()) controller.abort(); await Promise.allSettled([...this.probes.keys(), ...[...this.clients].map(client => this.release(client))]); }
}
