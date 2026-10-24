import { selectedProviderOptions, type ProviderModelSelection } from './provider-models.js';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findExecutable } from './agents.js';
import { defaultCodexSettings, expandHome, parseLaunchArgs, saveProviderSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import type { ModelStatus } from './codex-provider.js';
import { ProviderWorkspaceCache, type ProviderWorkspace } from './provider-workspace.js';
import type { WorkItem } from './types.js';
import { PiRpc, piRecord } from './pi-rpc.js';
import { PI_FRIDAY_MCP_EXTENSION_SOURCE, PI_FRIDAY_MCP_EXTENSION_FILENAME } from './pi-extension.js';

export const piThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const defaultPiSettings: CodexSettings = { ...defaultCodexSettings, enabled: false, displayName: 'Pi', binaryPath: 'pi', permissionMode: 'default' };
const valueArgs = new Set(['--api-key', '--append-system-prompt', '--exclude-tools', '-xt', '--extension', '-e', '--model', '--models', '--name', '-n', '--prompt-template', '--provider', '--session-dir', '--skill', '--system-prompt', '--theme', '--thinking', '--tools', '-t', '--tui-mode', '--use-theme']);
const booleanArgs = new Set(['--approve', '-a', '--no-approve', '-na', '--no-builtin-tools', '-nbt', '--no-context-files', '-nc', '--no-extensions', '-ne', '--no-prompt-templates', '-np', '--no-skills', '-ns', '--no-themes', '--no-tools', '-nt', '--offline', '--verbose']);
const reservedArgs = new Set(['--help', '-h', '--list-models', '--mode', '--no-session', '--print', '-p', '--resume', '-r', '--session', '--session-id', '--fork', '--version', '-v']);
export function piLaunchArgs(value: string): string[] {
  const args = parseLaunchArgs(value).flatMap(arg => {
    const equals = arg.indexOf('='); return equals > 0 && valueArgs.has(arg.slice(0, equals)) ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg];
  });
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!, flag = arg.split('=')[0]!;
    if (reservedArgs.has(flag) || ['-p', '-r', '-h', '-v'].some(short => arg.startsWith(short) && arg !== short && !arg.startsWith('--'))) throw new Error(`Pi ${flag} 参数由 Friday 管理`);
    if (arg === '--' || arg.startsWith('@') || !arg.startsWith('-')) throw new Error('Pi 启动参数不能包含待执行的提示词');
    if (valueArgs.has(arg)) { if (!args[++i] || args[i]!.startsWith('-')) throw new Error(`Pi ${arg} 参数缺少值`); }
    else if (!booleanArgs.has(arg) && arg.startsWith('--') && !arg.includes('=') && args[i + 1] && !args[i + 1]!.startsWith('-') && !args[i + 1]!.startsWith('@')) i++;
    else if (!booleanArgs.has(arg) && !arg.startsWith('--')) throw new Error(`不支持 Pi 启动参数 ${arg}`);
  }
  return args;
}
export function validatePiSettings(value: unknown, previous = defaultPiSettings) {
  const settings = validateSettings(value, previous, 'Pi', piThinkingLevels);
  if (settings.shadowHomePath) throw new Error('Pi 请通过配置目录管理账号');
  if (settings.permissionMode === 'plan') throw new Error('Pi 不支持规划权限模式');
  if (settings.environment.some(entry => ['PI_CODING_AGENT_DIR', 'FRIDAY_MCP_URL', 'FRIDAY_MCP_BEARER_TOKEN', 'FRIDAY_PI_RUNTIME_MODE', 'FRIDAY_PI_MCP_EXTENSION_PATH'].includes(entry.name))) throw new Error('请通过 Pi 配置目录和 Friday 任务设置管理运行环境');
  piLaunchArgs(settings.launchArgs); return settings;
}
export async function loadPiSettings(directory: string): Promise<CodexSettings> {
  try { return validatePiSettings(JSON.parse(await readFile(join(directory, 'pi-provider.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultPiSettings); throw error; }
}
export function piAccountEnvironment(settings: CodexSettings) {
  const home = resolve(expandHome(settings.homePath || process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')));
  return { home, env: { ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])), PI_CODING_AGENT_DIR: home } as NodeJS.ProcessEnv };
}
export function piModelInventory(data: unknown, state: unknown): ProviderModel[] {
  if (!Array.isArray(piRecord(data)?.models)) throw new Error('Pi 未返回有效模型列表');
  const active = piRecord(piRecord(state)?.model), seen = new Set<string>();
  const models: ProviderModel[] = [{ id: 'default', name: 'Pi default', description: '', isDefault: true, reasoningEfforts: [], defaultReasoningEffort: '' }];
  for (const input of piRecord(data)!.models) {
    const model = piRecord(input);
    if (typeof model?.provider !== 'string' || !model.provider.trim() || typeof model.id !== 'string' || !model.id.trim()) throw new Error('Pi 模型缺少原生身份');
    const id = `${model.provider}/${model.id}`; if (seen.has(id)) continue; seen.add(id);
    const map = piRecord(model.thinkingLevelMap);
    const reasoningEfforts = model.reasoning === true ? piThinkingLevels.filter(level => map?.[level] !== null && (!['xhigh', 'max'].includes(level) || map?.[level] !== undefined)) : [];
    const current = active?.provider === model.provider && active?.id === model.id ? piRecord(state)?.thinkingLevel : undefined;
    const index = piThinkingLevels.indexOf(current);
    const defaultReasoningEffort = reasoningEfforts.includes(current) ? current : index < 0 ? '' : piThinkingLevels.slice(index + 1).find(level => reasoningEfforts.includes(level)) ?? [...piThinkingLevels.slice(0, index)].reverse().find(level => reasoningEfforts.includes(level)) ?? '';
    models.push({ id, name: typeof model.name === 'string' ? model.name : id, description: model.provider, isDefault: false, reasoningEfforts, defaultReasoningEffort });
  }
  return models;
}

export class PiConnection {
  onConfigurationChanged?: () => Promise<void>;
  private cache = new ProviderWorkspaceCache<ModelStatus>(60_000);
  private workspaces = new ProviderWorkspaceCache();
  private clients = new Set<PiRpc>();
  private saving = false;
  constructor(readonly directory: string) {}
  private async configured(settings: CodexSettings) {
    const binary = expandHome(settings.binaryPath), command = isAbsolute(binary) ? binary : findExecutable(binary);
    if (!command) throw new Error('找不到 Pi，请检查可执行文件路径');
    await access(command, constants.X_OK);
    const account = piAccountEnvironment(settings);
    return { command, home: account.home, env: { ...process.env, ...account.env }, args: piLaunchArgs(settings.launchArgs) };
  }
  async status(owner = false, reload = false): Promise<ModelStatus> {
    const settings = await loadPiSettings(this.directory), key = JSON.stringify(settings);
    const value = await this.cache.read(key, reload, async () => {
      const result: ModelStatus = { provider: 'pi', displayName: settings.displayName, enabled: settings.enabled, model: settings.model || 'default', installed: false, connected: false, loginPending: false, account: null, models: [], settings: null, checkedAt: new Date().toISOString(), version: null, error: null };
      let rpc: PiRpc | undefined;
      try {
        const configured = await this.configured(settings); result.installed = true;
        if (!settings.enabled) return result;
        result.version = await new Promise<string | null>(resolve => execFile(configured.command, ['--version'], { env: configured.env, timeout: 4000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? null : stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null)));
        const version = result.version?.split('.').map(Number);
        if (!version || version[0] === 0 && (version[1]! < 80 || version[1] === 80 && version[2]! < 5)) throw new Error('Pi 需要 0.80.5 或更新版本以确认原生回合已经结束');
        rpc = this.client(configured, undefined, true);
        rpc.onEvent = event => { if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) void rpc!.send({ type: 'extension_ui_response', id: event.id, cancelled: true }).catch(() => {}); };
        const state = await rpc.request({ type: 'get_state' }, 15_000);
        result.models = piModelInventory(await rpc.request({ type: 'get_available_models' }, 15_000), state);
        result.connected = settings.enabled && result.models.length > 1;
        if (result.models.length === 1) result.error = 'Pi 没有可用的已认证模型，请在主机运行 pi /login 或配置模型凭据';
      } catch (error) { result.error = (error as Error).message; }
      finally { if (rpc) await this.release(rpc); }
      return result;
    });
    if (JSON.stringify(await loadPiSettings(this.directory)) !== key) throw new Error('Pi 配置已经改变，请重新加载');
    return { ...value, models: appendCustomModels(value.models, settings.customModels), settings: owner ? { ...settings, environment: settings.environment.map(entry => ({ name: entry.name, value: null, hasValue: true })) } : null };
  }
  async runtime(selection?: ProviderModelSelection) {
    if (this.saving) throw new Error('正在保存 Pi 配置');
    const state = await this.status(), settings = await loadPiSettings(this.directory);
    if (!state.enabled || !state.connected) throw new Error(state.enabled ? state.error ?? 'Pi 尚未就绪' : '请先在「Providers → Pi」中启用 Pi');
    const model = selection?.model || settings.model || 'default', selected = state.models.find(value => value.id === model);
    const options = selected ? selectedProviderOptions(selected, selection) : undefined;
    const effort = options?.effort || (selection?.model ? '' : settings.reasoningEffort);
    if (!selected || effort && !selected.reasoningEfforts.includes(effort)) throw new Error('Pi 模型或推理强度已不可用，请重新选择');
    return { ...await this.configured(settings), model, effort, permissionMode: settings.permissionMode };
  }
  client(configured: { command: string; args: string[]; env: NodeJS.ProcessEnv }, cwd?: string, ephemeral = false, extension?: string, environment?: NodeJS.ProcessEnv) {
    const rpc = new PiRpc(configured.command, ['--mode', 'rpc', ...(ephemeral ? ['--no-session'] : []), ...configured.args, ...(extension ? ['--extension', extension] : [])], cwd, { ...configured.env, ...environment });
    this.clients.add(rpc); return rpc;
  }
  async release(rpc: PiRpc) { this.clients.delete(rpc); await rpc.close(); }
  async extension() {
    const directory = join(this.directory, 'pi-runtime'); await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, PI_FRIDAY_MCP_EXTENSION_FILENAME), temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, PI_FRIDAY_MCP_EXTENSION_SOURCE, { mode: 0o600, flag: 'wx' }); await rename(temporary, target); }
    finally { await rm(temporary, { force: true }); }
    return target;
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const settings = await loadPiSettings(this.directory), configured = await this.runtime();
    if (task?.piHome && task.piHome !== configured.home) throw new Error('请恢复这条 Pi 会话使用的配置目录');
    return this.workspaces.read(JSON.stringify([settings, cwd]), reload, async () => {
      const rpc = this.client(configured, cwd, true);
      rpc.onEvent = event => { if (event.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(event.method)) void rpc.send({ type: 'extension_ui_response', id: event.id, cancelled: true }).catch(() => {}); };
      try {
        const data = await rpc.request({ type: 'get_commands' }, 15_000);
        const commands = [{ name: 'compact', description: 'Summarize the conversation and reduce context usage', builtin: true }], skills: ProviderWorkspace['skills'] = [];
        for (const input of Array.isArray(data?.commands) ? data.commands : []) {
          if (typeof input?.name !== 'string' || !input.name) continue;
          if (input.source === 'skill') skills.push({ name: input.name.replace(/^skill:/, ''), path: input.sourceInfo?.path ?? input.path ?? `pi:skill:${input.name}`, enabled: true, description: input.description, scope: input.sourceInfo?.scope ?? input.location });
          else if (input.name !== 'compact') commands.push({ name: input.name, description: input.description, builtin: false });
        }
        if (JSON.stringify(await loadPiSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Pi 配置已经改变，请重新加载');
        return { provider: 'pi', cwd, checkedAt: new Date().toISOString(), commands, skills };
      } finally { await this.release(rpc); }
    });
  }
  async save(value: unknown) {
    if (this.saving) throw new Error('正在保存 Pi 配置'); this.saving = true;
    try { const settings = validatePiSettings(value, await loadPiSettings(this.directory)); await saveProviderSettings(this.directory, 'pi-provider.json', settings); }
    finally { this.saving = false; }
    await this.onConfigurationChanged?.(); return this.status(true, true);
  }
  async close() { await Promise.all([...this.clients].map(rpc => this.release(rpc))); }
}
