import { selectedProviderOptions, type ProviderModelSelection, type ProviderOptionDescriptor } from './provider-models.js';
import { readFile, access, mkdir, mkdtemp, writeFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname, isAbsolute, delimiter } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AcpProcess, acpRecord, type AcpRecord } from './acp-process.js';
import { acpInitializeRequest, acpInitializeResponse, acpModelOption, acpEffortOption, acpConfigValues } from './acp-protocol.js';
import { acpNativeAuthenticate, acpNativeSession, acpNativePermission, type AcpNativeConnection, type AcpNativeRuntime, type AcpNativeLease } from './acp-native.js';
import { acpProviderDefaults, acpProviderSettings, loadAcpProviderSettings, acpProviderAccount, acpProviderName, acpProviderPublicSettings, type AcpProviderID, type AcpProviderSettings } from './acp-provider-settings.js';
import { AcpRegistryCatalog, resolveAcpDistribution, parseAcpRegistryPackage } from './acp-registry-catalog.js';
import { ManagedProviderTools, type ManagedToolArchive, type ManagedToolPackage } from './managed-provider-tools.js';
import { resolveAntigravityReleaseAsset } from './antigravity-release.js';
import { prepareAntigravityProfile, antigravityEnvironment, antigravityClientFile } from './antigravity-profile.js';
import { antigravityOutput } from './antigravity-output.js';
import { antigravityPermission, normalizeAntigravityUpdate } from './antigravity-protocol.js';
import { saveProviderSettings, expandHome } from './codex-settings.js';
import { ProviderWorkspaceCache, type ProviderWorkspace } from './provider-workspace.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import { antigravitySkills } from './antigravity-skills.js';
import { homedir } from 'node:os';
import type { WorkItem } from './types.js';
import { AcpAuthFlow, acpAuthMethods } from './acp-auth-flow.js';

type ResolvedAcp = { command: string; args: string[]; env: NodeJS.ProcessEnv; close(): Promise<void> };
async function executable(value: string, environment: NodeJS.ProcessEnv) {
  const command = expandHome(value);
  for (const path of isAbsolute(command) ? [command] : (environment.PATH ?? process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => join(path, command))) { try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch {} }
  throw new Error('未找到 ACP 可执行文件，请安装工具或检查路径');
}
export function acpModelOptions(session: AcpRecord): ProviderOptionDescriptor[] {
  const model = acpModelOption(session), effort = acpEffortOption(session);
  return (Array.isArray(session.configOptions) ? session.configOptions : []).flatMap((option: AcpRecord): ProviderOptionDescriptor[] => {
    const id = option.configId ?? option.id;
    if (option === model || option === effort || ['mode', 'collaboration_mode'].includes(option.category) || typeof id !== 'string' || !id || id.length > 128) return [];
    const flatten = (values: AcpRecord[]): AcpRecord[] => values.flatMap(value => Array.isArray(value.options) ? flatten(value.options) : [value]);
    const values = flatten(Array.isArray(option.options) ? option.options : []), choices = [...new Map(values.filter(value => typeof value.value === 'string' && value.value).map(value => [value.value, { id: value.value, label: value.name || value.label || value.value, ...(typeof value.description === 'string' ? { description: value.description } : {}), ...(value.value === option.currentValue ? { isDefault: true } : {}) }])).values()];
    return choices.length ? [{ id, label: option.name || id, type: 'select', options: choices, ...(typeof option.currentValue === 'string' ? { currentValue: option.currentValue } : {}) }] : [];
  });
}
export function acpNativeModels(session: AcpRecord): ProviderModel[] {
  const option = acpModelOption(session), effort = acpEffortOption(session), efforts = effort ? acpConfigValues(effort) : [], preferred = effort?.currentValue, current = option?.currentValue ?? session.models?.currentModelId, options: AcpRecord[] = option ? (option.options ?? []).flatMap((value: AcpRecord) => Array.isArray(value.options) ? value.options : [value]).map((value: AcpRecord) => ({ id: value.value, name: value.name, description: value.description })) : (session.models?.availableModels ?? []).map((value: AcpRecord) => ({ id: value.modelId, name: value.name, description: value.description }));
  const seen = new Set<string>(), values: ProviderModel[] = [];
  for (const value of options) { if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 160 || seen.has(value.id)) continue; seen.add(value.id); values.push({ id: value.id, name: typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 160) : value.id, description: typeof value.description === 'string' ? value.description.slice(0, 1024) : '', isDefault: value.id === current, optionDescriptors: acpModelOptions(session), reasoningEfforts: [...new Set(efforts)], defaultReasoningEffort: efforts.includes(preferred) ? preferred : '' }); }
  return values.length ? values : [{ id: 'native-default', name: '工具默认', description: '', isDefault: true, optionDescriptors: acpModelOptions(session), reasoningEfforts: [], defaultReasoningEffort: '' }];
}
const planAvailable = (session: AcpRecord) => session.modes?.availableModes?.some((value: AcpRecord) => ['plan', 'architect'].includes(value.id)) || session.configOptions?.some((option: AcpRecord) => ['mode', 'collaboration_mode'].includes(option.category) && acpConfigValues(option).some(value => ['plan', 'architect'].includes(value)));
export class AcpProviderConnection implements AcpNativeConnection {
  private static credentialOwners = new Map<string, AcpProviderConnection>();
  private credentialDirectory: string;
  private authKey?: string;
  onConfigurationChanged?: () => Promise<void>;
  readonly registry: AcpRegistryCatalog;
  readonly tools: ManagedProviderTools;
  private leases = new Set<AcpNativeLease>();
  private catalog = new ProviderWorkspaceCache<ModelStatus>(60000);
  private workspaces = new ProviderWorkspaceCache<ProviderWorkspace>();
  private discovered = new Map<string, ProviderWorkspace>();
  private planModes = new Map<string, string>();
  private normalModes = new Map<string, string>();
  private metadataKeys = new Set<string>();
  private closed = false;
  private saving = false;
  private lastStatus?: ModelStatus;
  private loginError?: string;
  private authStarts = 0;
  private get authStarting() { return this.authStarts > 0; }
  private registryLogin?: AcpAuthFlow;
  private get authPending() { return this.authStarting || !!this.loggingIn || this.registryLogin?.pending === true; }
  private discoveryHome?: string;
  private loggingIn?: { lease: AcpNativeLease; done: Promise<void>; url?: string };
  constructor(readonly directory: string, readonly provider: AcpProviderID, options: { registry?: AcpRegistryCatalog; tools?: ManagedProviderTools; discoveryHome?: string; credentialDirectory?: string } = {}) {
    this.registry = options.registry ?? new AcpRegistryCatalog(directory); this.tools = options.tools ?? new ManagedProviderTools(directory);
    this.discoveryHome = options.discoveryHome; this.credentialDirectory = options.credentialDirectory ?? directory;
    const previous = this.tools.onChange;
    this.tools.onChange = state => { previous?.(state); if (this.closed || !['complete', 'cancelled', 'failed'].includes(state.phase)) return; for (const key of this.metadataKeys) this.catalog.invalidate(key); this.lastStatus = undefined; void Promise.resolve(this.onConfigurationChanged?.()).catch(() => {}); };
  }
  private authPath() { return join(this.directory, 'providers', this.provider, 'auth-binding.json'); }
  private credentialPath(settings: AcpProviderSettings) {
    const agent = settings.nativeConfig.source === 'registry' ? settings.nativeConfig.registryAgentId : settings.binaryPath;
    return join(this.credentialDirectory, 'providers', 'shared-auth', createHash('sha256').update(JSON.stringify([this.provider, agent])).digest('hex') + '.json');
  }
  async credentialKey() { return this.credentialPath(await loadAcpProviderSettings(this.directory, this.provider)); }
  private claimAuth(settings: AcpProviderSettings) {
    const key = this.credentialPath(settings), owner = AcpProviderConnection.credentialOwners.get(key);
    if (owner && owner !== this) throw new Error('同一原生工具的另一个实例正在认证，请等待结束');
    AcpProviderConnection.credentialOwners.set(key, this); this.authKey = key;
  }
  private releaseAuth() { if (this.authKey && AcpProviderConnection.credentialOwners.get(this.authKey) === this) AcpProviderConnection.credentialOwners.delete(this.authKey); this.authKey = undefined; }
  async accountIdentity(settings: AcpProviderSettings) {
    let revision = '';
    const readRevision = async (path: string) => { try { const value = acpRecord(JSON.parse(await readFile(path, 'utf8'))); return typeof value?.revision === 'string' ? value.revision : ''; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; } };
    revision = await readRevision(this.authPath());
    const shared = await readRevision(this.credentialPath(settings));
    if (shared) revision += ':' + shared;
    return createHash('sha256').update(JSON.stringify([acpProviderAccount(this.provider, settings), revision])).digest('hex');
  }
  private async bindAuth() {
    const settings = await loadAcpProviderSettings(this.directory, this.provider);
    for (const path of [this.authPath(), this.credentialPath(settings)]) {
      const temporary = path + '.' + randomUUID() + '.tmp'; await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try { await writeFile(temporary, JSON.stringify({ revision: randomUUID() }), { mode: 0o600, flag: 'wx' }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
    }
  }
  async installation(settings = loadAcpProviderSettings(this.directory, this.provider)): Promise<ManagedToolArchive | ManagedToolPackage> {
    const value = await settings;
    if (this.provider === 'antigravity') { const release = resolveAntigravityReleaseAsset(process.platform, process.arch); if (!release) throw new Error('当前主机没有 Antigravity 托管发行版'); return { tool: 'antigravity-acp', version: release.version, url: release.url, sha256: release.sha256, archiveBytes: release.archiveBytes, files: [release.executable, release.harness] }; }
    const agent = await this.registry.agent(value.nativeConfig.registryAgentId), distribution = resolveAcpDistribution(agent, value.nativeConfig.distribution); if (!distribution) throw new Error('当前主机没有兼容的 ACP 工具分发');
    if (distribution.binary) return { tool: 'acp-' + agent.id, version: agent.version, url: distribution.binary.archive, sha256: distribution.binary.sha256, files: [{ name: distribution.binary.cmd }] };
    const name = parseAcpRegistryPackage(distribution.package!, distribution.kind as 'npx' | 'uvx').name.split('/').at(-1)!;
    return { tool: 'acp-' + agent.id, version: agent.version, kind: distribution.kind as 'npx' | 'uvx', package: distribution.package!, candidates: [...new Set([agent.id, name, name.replace(/-acp$/, '')])] };
  }
  async prepare() { const input = await this.installation(); return 'url' in input ? this.tools.prepareArchive(input) : this.tools.preparePackage(input); }
  async startInstall() { if (this.saving || this.authPending) throw new Error('请等待配置或登录完成后准备工具'); const input = await this.installation(); const running = 'url' in input ? this.tools.prepareArchive(input) : this.tools.preparePackage(input); void running.catch(() => {}); return this.tools.state(input.tool); }
  async installState() { const settings = await loadAcpProviderSettings(this.directory, this.provider); return this.tools.state(this.provider === 'antigravity' ? 'antigravity-acp' : 'acp-' + settings.nativeConfig.registryAgentId); }
  async cancelInstall(operationId: string) { const state = await this.installState(); await this.tools.cancel(state.tool, operationId); return this.installState(); }
  loginState() { return this.provider === 'acp-registry' && this.registryLogin ? this.registryLogin.state() : { pending: this.authStarting || !!this.loggingIn, ...(this.loggingIn?.url ? { url: this.loggingIn.url } : {}) }; }
  async resolve(settings: AcpProviderSettings, cwd: string): Promise<ResolvedAcp> {
    const configured = Object.fromEntries(settings.environment.map(value => [value.name, value.value])), env = { ...process.env, ...configured }, config = settings.nativeConfig;
    if (this.provider === 'acp-registry') {
      if (config.source === 'local') return { command: await executable(settings.binaryPath, env), args: config.commandArgs, env, close: async () => {} };
      if (!config.registryAgentId) throw new Error('请选择 ACP Registry 工具');
      const agent = await this.registry.agent(config.registryAgentId), distribution = resolveAcpDistribution(agent, config.distribution); if (!distribution) throw new Error('此 ACP 工具没有兼容的分发');
      if (config.commandOverride) return { command: await executable(config.commandOverride, env), args: distribution.args, env: { ...process.env, ...distribution.env, ...configured }, close: async () => {} };
      const input = await this.installation(Promise.resolve(settings)), installed = 'url' in input ? await this.tools.installedArchive(input) : await this.tools.installedPackage(input); if (!installed) throw new Error('请先准备此 ACP Registry 工具');
      const lease = await this.tools.acquire(installed); return { command: installed.command, args: distribution.args, env: { ...process.env, ...distribution.env, ...configured, PATH: [...installed.pathDirectories, configured.PATH ?? distribution.env.PATH ?? env.PATH].filter(Boolean).join(delimiter) }, close: lease.close };
    }
    let command: string, release: { close(): Promise<void> } | undefined;
    try { command = await executable(settings.binaryPath, env); }
    catch (error) { if (settings.binaryPath !== acpProviderDefaults(this.provider).binaryPath) throw error; const input = await this.installation(Promise.resolve(settings)) as ManagedToolArchive, installed = await this.tools.installedArchive(input); if (!installed) throw new Error('请先安装 Antigravity ACP 工具'); release = await this.tools.acquire(installed); command = installed.command; }
    try {
      const harness = await executable(config.harnessPath || join(dirname(command), process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'), env), profile = await prepareAntigravityProfile(this.directory, 'antigravity', config, env);
      const tempDirectory = await mkdtemp(join(profile.tempDirectory, 'run-'));
      return { command, args: process.platform === 'linux' ? ['--uid='] : [], env: { ...antigravityEnvironment({ ...profile, tempDirectory }, config, env), ANTIGRAVITY_HARNESS_PATH: harness }, close: async () => { await release?.close(); await rm(tempDirectory, { recursive: true, force: true }); } };
    } catch (error) { await release?.close(); throw error; }
  }
  async client(runtime: AcpNativeRuntime, cwd: string, options?: { authentication?: boolean; onRequest?: AcpProcess['onRequest'] }): Promise<AcpNativeLease> {
    if (this.closed || this.saving) throw new Error('ACP 工具正在关闭或保存配置');
    const settings = await loadAcpProviderSettings(this.directory, this.provider), resolved = await this.resolve(settings, cwd);
    if (await this.accountIdentity(settings) !== runtime.account) { await resolved.close(); throw new Error('ACP 工具账号配置已改变'); }
    const filters = this.provider === 'antigravity' ? antigravityOutput(url => { lease.authorizationURL = url; if (this.loggingIn?.lease === lease) this.loggingIn.url = url; }) : undefined;
    const client = new AcpProcess(runtime.name, resolved.command, resolved.args, cwd, resolved.env, filters ? { stdoutTransform: filters.stdout, onStderr: filters.stderr } : {});
    if (options?.onRequest) client.onRequest = options.onRequest;
    let closed = false; const lease: AcpNativeLease = { client, initialized: {}, close: async () => { if (closed) return; closed = true; await client.close(); await resolved.close(); this.leases.delete(lease); } }; this.leases.add(lease);
    try { const input = acpInitializeRequest(); if (options?.authentication) { input.capabilities = { auth: { terminal: {} }, elicitation: { url: {} } }; Object.assign(input.clientCapabilities, { auth: { terminal: true }, elicitation: { url: {} } }); } if (this.provider === 'antigravity') input.clientCapabilities.fs = { readTextFile: runtime.clientFiles === true, writeTextFile: runtime.clientFiles === true }; lease.initialized = acpInitializeResponse(await client.call('initialize', input, 15000)); return lease; } catch (error) { await lease.close(); throw error; }
  }
  private baseRuntime(settings: AcpProviderSettings, account: string): AcpNativeRuntime { return { provider: this.provider, name: acpProviderName(this.provider), model: settings.model || 'native-default', defaultModel: 'native-default', effort: settings.reasoningEffort, account, command: settings.binaryPath, args: [], env: {}, ...(this.provider === 'antigravity' ? { authMethod: settings.nativeConfig.authMethod, authenticateEagerly: true, resumeMethod: 'resume', clientFiles: true } : {}), autoApprove: settings.permissionMode === 'auto' }; }
  private redact(error: unknown, settings: AcpProviderSettings) { let text = error instanceof Error ? error.message : 'ACP 工具检测失败'; for (const secret of [settings.nativeConfig.apiKey, ...settings.environment.map(value => value.value)].filter(Boolean)) text = text.replaceAll(secret, '[redacted]'); return text.slice(0, 2000); }
  private async inspect(settings: AcpProviderSettings, account: string, cwd: string): Promise<ModelStatus> {
      const value: ModelStatus = { provider: this.provider, displayName: settings.displayName, enabled: settings.enabled, model: settings.model, installed: false, connected: false, loginPending: false, account: null, models: [], settings: null, checkedAt: new Date().toISOString(), version: null, error: null, supportsPlan: false }; if (!settings.enabled) return value;
      let lease: AcpNativeLease | undefined;
      try {
        const runtime = { ...this.baseRuntime(settings, account), clientFiles: false }; lease = await this.client(runtime, cwd); value.installed = true; value.version = lease.initialized.agentInfo?.version ?? null;
        // Probes never initiate an interactive sign-in. Native authentication
        // belongs to an explicit owner action or an already configured key.
        if (this.provider === 'antigravity' && settings.nativeConfig.authMethod.startsWith('oauth-')) { const profile = join(this.directory, 'providers', 'antigravity', createHash('sha256').update('antigravity').digest('hex'), 'antigravity-acp', 'acp_token.json'); try { await access(profile); } catch { throw new Error('请先在主机登录 Antigravity'); } }
        if (runtime.authenticateEagerly && runtime.authMethod) await acpNativeAuthenticate(lease.client, lease.initialized, runtime.authMethod);
        let commands: AcpRecord[] = [];
        lease.client.onNotification = (method, params) => { const value = acpRecord(params); if (method === 'session/update' && value?.update?.sessionUpdate === 'available_commands_update' && Array.isArray(value.update.availableCommands)) commands = value.update.availableCommands; };
        lease.client.onRequest = async context => { if (context.method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } }; throw new Error('Read-only ACP metadata probe'); };
        const session = await acpNativeSession(lease.client, lease.initialized, { cwd, resumeMethod: runtime.resumeMethod, mcpServers: [] });
        await new Promise(resolve => setTimeout(resolve, 500)); value.models = acpNativeModels(session); value.supportsPlan = !!planAvailable(session); value.connected = true; value.model = settings.model || value.models.find(value => value.isDefault)?.id || value.models[0]?.id || 'native-default';
        const plan = session.modes?.availableModes?.find((value: AcpRecord) => ['plan', 'architect'].includes(value.id))?.id ?? session.configOptions?.filter((option: AcpRecord) => ['mode', 'collaboration_mode'].includes(option.category)).flatMap(acpConfigValues).find((value: string) => ['plan', 'architect'].includes(value)); if (plan) this.planModes.set(account, plan);
        const normal = session.modes?.currentModeId ?? session.configOptions?.find((option: AcpRecord) => ['mode', 'collaboration_mode'].includes(option.category))?.currentValue; if (typeof normal === 'string' && !['plan', 'architect'].includes(normal)) this.normalModes.set(account, normal);
        const accepted = new Set<string>(), nativeCommands = [], nativeSkills = [];
        for (const command of commands) {
          const name = typeof command.name === 'string' ? command.name : ''; if (!name || name !== name.trim() || name.length > 128 || /[\x00-\x1f]/.test(name) || accepted.has(name.toLowerCase())) continue; accepted.add(name.toLowerCase());
          const description = typeof command.description === 'string' ? command.description.trim().slice(0, 1024) : '';
          if (this.provider === 'acp-registry' && name.startsWith('$')) { const skill = name.slice(1); if (!skill || skill !== skill.trim()) continue; nativeSkills.push({ name: skill, path: 'acp://skill/' + encodeURIComponent(skill), scope: 'agent', enabled: true, description }); }
          else nativeCommands.push({ name, description, ...(typeof command.input?.hint === 'string' ? { argumentHint: command.input.hint.slice(0, 1024) } : {}) });
          if (nativeCommands.length + nativeSkills.length >= 128) break;
        }
        if (this.provider === 'antigravity') {
          const env = { ...process.env, ...Object.fromEntries(settings.environment.map(value => [value.name, value.value])) }; nativeSkills.push(...await antigravitySkills(cwd, this.discoveryHome ?? (env.HOME?.trim() || env.USERPROFILE?.trim() || homedir())));
        }
        this.discovered.set(JSON.stringify([account, cwd]), { provider: this.provider, cwd, supportsPlan: value.supportsPlan, checkedAt: new Date().toISOString(), skills: nativeSkills, commands: nativeCommands });
      } catch (error) { value.error = this.redact(error, settings); } finally { await lease?.close(); }
      return value;
  }
  async status(owner = false, reload = false): Promise<ModelStatus> {
    const settings = await loadAcpProviderSettings(this.directory, this.provider), account = await this.accountIdentity(settings), key = JSON.stringify([settings, account]);
    this.metadataKeys.add(key);
    if (this.authPending) return { ...(this.lastStatus ?? { provider: this.provider, displayName: settings.displayName, enabled: settings.enabled, model: settings.model, installed: true, connected: false, account: null, models: [], checkedAt: new Date().toISOString(), version: null, error: null }), loginPending: true, settings: owner ? acpProviderPublicSettings(settings) : null };
    const result = await this.catalog.read(key, reload, () => this.inspect(settings, account, this.directory));
    if (JSON.stringify(await loadAcpProviderSettings(this.directory, this.provider)) !== JSON.stringify(settings) || account !== await this.accountIdentity(settings)) throw new Error('ACP 工具配置已改变，请重新加载');
    this.lastStatus = result;
    return { ...result, error: this.loginError ?? result.error, loginPending: !!this.loggingIn, models: appendCustomModels(result.models, settings.customModels), settings: owner ? acpProviderPublicSettings(settings) : null };
  }
  async runtime(selection?: ProviderModelSelection & { interactionMode?: string }) {
    if (this.closed || this.saving || this.authPending) throw new Error('请等待原生 ACP 工具的配置或登录操作结束');
    const state = await this.status(), settings = await loadAcpProviderSettings(this.directory, this.provider); const peer = AcpProviderConnection.credentialOwners.get(this.credentialPath(settings)); if (peer && peer !== this) throw new Error('同一原生工具的另一个实例正在认证'); if (!state.enabled || !state.connected) throw new Error(state.error || '请先启用并连接原生 ACP 工具');
    const model = selection?.model || settings.model || state.model, selected = state.models.find(value => value.id === model), options = selected ? selectedProviderOptions(selected, selection) : undefined, effort = options?.effort || (selection?.model ? '' : settings.reasoningEffort); if (!selected || effort && !selected.reasoningEfforts.includes(effort)) throw new Error('ACP 模型或原生推理选项已改变，请重新选择');
    if (selection?.interactionMode === 'plan' && !state.supportsPlan) throw new Error('此 ACP 工具未声明原生计划模式');
    const account = await this.accountIdentity(settings), compact = this.discovered.get(JSON.stringify([account, this.directory]))?.commands.find(value => ['compact', 'compress'].includes(value.name));
    return { ...this.baseRuntime(settings, account), model, effort, modelOptions: options?.values ?? {}, ...(compact ? { compactCommand: compact.name } : {}), ...(selection?.interactionMode === 'plan' ? { nativeMode: this.planModes.get(account) ?? 'plan' } : this.provider === 'antigravity' ? { nativeMode: settings.permissionMode === 'auto' ? 'yolo' : settings.permissionMode === 'acceptEdits' ? 'auto_edit' : 'default' } : { restoreBuildMode: true, defaultMode: this.normalModes.get(account) }) };
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const runtime = await this.runtime(); if (task?.nativeProviderAccount && task.nativeProviderAccount !== runtime.account) throw new Error('请恢复这条 ACP 会话使用的工具与账号');
    const key = JSON.stringify([runtime.account, cwd]);
    return this.workspaces.read(key, reload, async () => {
      const settings = await loadAcpProviderSettings(this.directory, this.provider), state = await this.inspect(settings, runtime.account, cwd);
      if (!state.connected) throw new Error(state.error ?? 'ACP 工作区目录读取失败');
      return this.discovered.get(key) ?? { provider: this.provider, cwd, checkedAt: new Date().toISOString(), commands: [], skills: [] };
    });
  }

  async save(value: unknown) { if (this.saving || this.authPending) throw new Error('请等待 ACP 工具配置、安装或登录操作结束'); this.saving = true; try { if (['downloading', 'extracting', 'verifying'].includes((await this.installState()).phase)) throw new Error('请等待工具安装结束'); await saveProviderSettings(this.directory, this.provider + '-provider.json', acpProviderSettings(this.provider, value, await loadAcpProviderSettings(this.directory, this.provider))); this.loginError = undefined; this.registryLogin = undefined; } finally { this.saving = false; } await this.onConfigurationChanged?.(); return this.status(true, true); }
  async authenticationMethods() {
    if (this.authPending || this.saving) throw new Error('请先完成当前认证或配置操作');
    this.authStarts++;
    let lease: AcpNativeLease | undefined;
    try {
      const settings = await loadAcpProviderSettings(this.directory, this.provider);
      if (!settings.enabled) throw new Error('请先启用此 ACP 工具');
      lease = await this.client(this.baseRuntime(settings, await this.accountIdentity(settings)), this.directory, { authentication: true });
      return { methods: acpAuthMethods(lease.initialized.authMethods), defaultMethodId: settings.nativeConfig.authMethodId };
    } finally { try { await lease?.close(); } finally { this.authStarts--; } }
  }
  private async loginRegistry(methodId?: string) {
    if (this.registryLogin?.pending) return this.registryLogin.state();
    if (this.authStarting) return this.loginState();
    if (this.saving) throw new Error('请等待配置保存结束');
    this.authStarts++;
    try {
      const settings = await loadAcpProviderSettings(this.directory, this.provider);
      if (!settings.enabled) throw new Error('请先启用此 ACP 工具');
      this.claimAuth(settings);
      const runtime = this.baseRuntime(settings, await this.accountIdentity(settings)); this.loginError = undefined;
      const flow = new AcpAuthFlow({
        cwd: this.directory,
        open: handler => this.client(runtime, this.directory, { authentication: true, onRequest: handler }),
        resolve: () => this.resolve(settings, this.directory),
        settled: async () => { await this.bindAuth(); },
        changed: async () => { if (!flow.pending) this.releaseAuth(); if (!this.closed) { this.loginError = flow.state().error; await this.onConfigurationChanged?.(); } },
        redact: error => this.redact(error, settings),
      }, methodId || settings.nativeConfig.authMethodId || undefined);
      this.registryLogin = flow;
      return await flow.ready();
    } finally { this.authStarts--; if (!this.registryLogin?.pending) this.releaseAuth(); }
  }
  respondLogin(input: unknown) { if (!this.registryLogin) throw new Error('当前没有待回答的认证流程'); return this.registryLogin.respond(input); }
  subscribeLogin(flowId: string, listener: () => void) { if (!this.registryLogin || this.registryLogin.id !== flowId) throw new Error('认证流程已改变，请刷新后重试'); return this.registryLogin.subscribe(listener); }
  async login(methodId?: string) {
    if (this.provider === 'acp-registry') return this.loginRegistry(methodId);
    if (this.loggingIn) return { pending: true, ...(this.loggingIn.url ? { url: this.loggingIn.url } : {}) };
    if (this.authStarting) return { pending: true }; if (this.saving) throw new Error('请等待配置保存结束'); this.authStarts++;
    try {
    const settings = await loadAcpProviderSettings(this.directory, this.provider); if (!settings.enabled) throw new Error('请先启用此 ACP 工具'); this.loginError = undefined;
    const runtime = this.baseRuntime(settings, await this.accountIdentity(settings)), lease = await this.client(runtime, this.directory), methods: AcpRecord[] = lease.initialized.authMethods ?? [];
    const selected = this.provider === 'antigravity' ? settings.nativeConfig.authMethod : (settings.nativeConfig.authMethodId ? methods.find(value => value.id === settings.nativeConfig.authMethodId && (value.type === undefined || value.type === 'agent'))?.id : methods.find(value => value.type === undefined || value.type === 'agent')?.id);
    if (!selected) { await lease.close(); throw new Error('此 ACP 工具没有可用的 Agent 管理认证方式，请在主机工具中登录'); }
    const done = lease.client.call(lease.initialized.protocolGeneration === 2 ? 'auth/login' : 'authenticate', { methodId: selected }, 300000).then(async () => {
      if (JSON.stringify(await loadAcpProviderSettings(this.directory, this.provider)) !== JSON.stringify(settings) || this.closed) return;
      await this.bindAuth();
    }).catch(error => { if (!this.closed) this.loginError = this.redact(error, settings); }).finally(async () => { await lease.close(); if (this.loggingIn?.lease === lease) this.loggingIn = undefined; if (!this.closed) await this.onConfigurationChanged?.(); });
    this.loggingIn = { lease, done, ...(lease.authorizationURL ? { url: lease.authorizationURL } : {}) };
    const deadline = Date.now() + 1000; while (this.loggingIn?.lease === lease && !this.loggingIn.url && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    return { pending: !!this.loggingIn, ...(this.loggingIn?.url ? { url: this.loggingIn.url } : {}) };
    } finally { this.authStarts--; }
  }
  async cancelLogin(flowId?: string) {
    if (this.provider === 'acp-registry') { if (!this.registryLogin?.pending) throw new Error('当前没有可取消的 ACP 登录流程'); return this.registryLogin.cancel(flowId); }
    const live = this.loggingIn; if (!live) throw new Error('当前没有可取消的 ACP 登录流程'); this.authStarts++;
    try { await live.lease.close(); await live.done; await this.bindAuth(); this.loginError = undefined; await this.onConfigurationChanged?.(); return { pending: false }; }
    finally { this.authStarts--; }
  }
  async logout() {
    if (this.provider !== 'acp-registry' || this.authPending || this.saving) throw new Error('请先完成当前认证或配置操作');
    this.authStarts++;
    let lease: AcpNativeLease | undefined, dispatched = false;
    try {
      const settings = await loadAcpProviderSettings(this.directory, this.provider);
      this.claimAuth(settings);
      lease = await this.client(this.baseRuntime(settings, await this.accountIdentity(settings)), this.directory);
      dispatched = true;
      await lease.client.call(lease.initialized.protocolGeneration === 2 ? 'auth/logout' : 'logout', {}, 60000);
      this.loginError = undefined; this.registryLogin = undefined;
    } finally {
      try { await lease?.close(); if (dispatched) await this.bindAuth(); }
      finally { this.authStarts--; this.releaseAuth(); if (!this.closed) await this.onConfigurationChanged?.(); }
    }
    return { pending: false, phase: 'logged-out' };
  }
  permission(params: AcpRecord) { return this.provider === 'antigravity' ? antigravityPermission(params) : acpNativePermission(params); }
  normalize(change: AcpRecord) { return this.provider === 'antigravity' ? normalizeAntigravityUpdate(change) : change; }
  clientFile(_runtime: AcpNativeRuntime, cwd: string, method: string, params: AcpRecord) { return antigravityClientFile(cwd, method, params); }
  async close() { this.closed = true; if (this.registryLogin?.pending) await this.registryLogin.cancel(); await Promise.allSettled([...this.leases].map(value => value.close())); await this.tools.close(); this.releaseAuth(); }
}
