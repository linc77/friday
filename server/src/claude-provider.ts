import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { findExecutable } from './agents.js';
import { defaultCodexSettings, expandHome, parseLaunchArgs, saveProviderSettings, validateSettings, type CodexSettings } from './codex-settings.js';
import { appendCustomModels, type ProviderModel } from './provider-models.js';
import { ProviderWorkspaceCache, providerCommands, type ProviderWorkspace } from './provider-workspace.js';
import { discoverClaudeSkills } from './claude-skills.js';
import type { WorkItem } from './types.js';
import type { ModelStatus } from './codex-provider.js';
import { claudeUsageLimits, providerDigest, providerUsageIdentity, providerFingerprint, ProviderResetError, type ProviderResetScope, type ProviderResetOutcome, type ProviderUsageLimits } from './provider-usage-limits.js';
import { readClaudeResetCredits, consumeClaudeResetCredit } from './claude-reset-credits.js';

export const defaultClaudeSettings: CodexSettings = { ...defaultCodexSettings, displayName: 'Claude', binaryPath: 'claude' };

export function validateClaudeSettings(value: unknown, previous = defaultClaudeSettings): CodexSettings {
  const settings = validateSettings(value, previous, 'Claude');
  if (settings.shadowHomePath) throw new Error('Claude 请通过配置目录管理独立账号。');
  // A health probe must never accept a positional prompt or an execution flag.
  const args = parseLaunchArgs(settings.launchArgs);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [flag, inline] = arg.split('=', 2);
    if (!['--model', '--effort', '--setting-sources'].includes(flag!)) throw new Error('Claude 启动参数支持 --model、--effort 和 --setting-sources。');
    if (inline === undefined && (!args[++i] || args[i]!.startsWith('-'))) throw new Error('Claude 启动参数缺少值。');
  }
  return settings;
}

export async function loadClaudeSettings(directory: string): Promise<CodexSettings> {
  try { return validateClaudeSettings(JSON.parse(await readFile(join(directory, 'claude-provider.json'), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultClaudeSettings); throw error; }
}
async function claudeAccountRuntime(settings: CodexSettings) {
  if (!settings.enabled) throw new Error('请先启用 Claude 后读取账号配额。');
  const binary = expandHome(settings.binaryPath), command = isAbsolute(binary) ? binary : findExecutable(binary);
  if (!command) throw new Error('找不到 Claude，请检查可执行文件路径。');
  await access(command, constants.X_OK);
  const home = resolve(expandHome(settings.homePath || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
  return { command, home, env: { ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])), CLAUDE_CONFIG_DIR: home } as NodeJS.ProcessEnv };
}

export class ClaudeConnection {
  onConfigurationChanged?: () => Promise<void>;
  private workspaceCache = new ProviderWorkspaceCache();
  private usageIdentitySnapshot?: { fingerprint: string; identity: import('./provider-usage-limits.js').ProviderUsageIdentity };
  usageIdentity(fingerprint: string | undefined) { return fingerprint && this.usageIdentitySnapshot?.fingerprint === fingerprint ? this.usageIdentitySnapshot.identity : undefined; }
  private usageCache = new ProviderWorkspaceCache<ProviderUsageLimits>(60_000);
  private cached?: ModelStatus;
  private cachedKey = '';
  private pending?: Promise<ModelStatus>;
  private pendingKey = '';
  private saving = false;
  private resetting = false;
  private creditVersion?: string;
  private children = new Set<ChildProcessWithoutNullStreams>();
  private closeHooks = new Set<() => Promise<void>>();
  onClose(hook: () => Promise<void>) { this.closeHooks.add(hook); return () => this.closeHooks.delete(hook); }
  constructor(private directory: string) {}
  async usageLimits(reload = false, task?: WorkItem): Promise<ProviderUsageLimits> {
    const settings = await loadClaudeSettings(this.directory), configured = await claudeAccountRuntime(settings);
    if (task?.claudeHome && task.claudeHome !== configured.home) throw new Error('请恢复这条会话使用的 Claude 配置目录');
    return this.usageCache.read(JSON.stringify(settings), reload, async () => {
      const response = await this.initialize(configured.command, parseLaunchArgs(settings.launchArgs), configured.env, this.directory, true);
      const version = this.cached?.version ?? (await this.collect(configured.command, ['--version'], configured.env).catch(() => '')).match(/\d+\.\d+\.\d+/)?.[0];
      const credits = await readClaudeResetCredits(configured.home, version);
      if (JSON.stringify(await loadClaudeSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Claude 配置已经改变，请重新加载');
      this.creditVersion = version;
      this.usageIdentitySnapshot = { fingerprint: providerFingerprint('claude', response.account, configured.home), identity: providerUsageIdentity(response.account) };
      return { ...claudeUsageLimits(response.usage), credentialFingerprint: providerFingerprint('claude', response.account, configured.home), ...(credits ? { resetCredits: credits } : {}) };
    });
  }
  async resetScope(): Promise<ProviderResetScope> {
    const limits = await this.usageLimits(), settings = await loadClaudeSettings(this.directory), runtime = await claudeAccountRuntime(settings);
    if (!limits.credentialFingerprint || !limits.resetCredits?.nextCreditId) throw new ProviderResetError('当前 Claude 账号没有可用的重置信息信息。', true);
    return { provider: 'claude', accountKey: providerDigest(['claude', await realpath(runtime.home).catch(() => runtime.home), limits.credentialFingerprint]), settingsDigest: providerDigest(settings), fingerprint: limits.credentialFingerprint, creditId: limits.resetCredits.nextCreditId };
  }
  async consumeResetCredit(scope: ProviderResetScope, requestId: string): Promise<ProviderResetOutcome> {
    if (this.saving || this.resetting) throw new ProviderResetError('Claude 配置或账号操作正在进行，请稍后重试。', true);
    this.resetting = true;
    try {
      const settings = await loadClaudeSettings(this.directory);
      if (providerDigest(settings) !== scope.settingsDigest) throw new ProviderResetError('Claude 账号配置已经改变，请重新确认。', true);
      const limits = await this.usageLimits(true), runtime = await claudeAccountRuntime(settings), version = this.creditVersion;
      if (limits.credentialFingerprint !== scope.fingerprint || !scope.creditId || !version || providerDigest(await loadClaudeSettings(this.directory)) !== scope.settingsDigest) throw new ProviderResetError('Claude 账号已经改变，请重新确认。', true);
      const customHome = settings.homePath || process.env.CLAUDE_CONFIG_DIR;
      const outcome = await consumeClaudeResetCredit({ home: runtime.home, accountConfigPath: customHome ? join(runtime.home, '.claude.json') : join(homedir(), '.claude.json'), version, grantId: scope.creditId, requestId });
      this.usageCache.invalidate(JSON.stringify(settings)); return outcome;
    } catch (error) { if (error instanceof ProviderResetError) throw error; throw new ProviderResetError('无法确认 Claude 重置结果，请检查后重试。'); }
    finally { this.resetting = false; }
  }
  async workspace(cwd: string, reload = false, task?: WorkItem): Promise<ProviderWorkspace> {
    const settings = await loadClaudeSettings(this.directory), configured = await this.runtime();
    if (task?.claudeHome && task.claudeHome !== configured.home) throw new Error('请恢复这条会话使用的 Claude 配置目录');
    return this.workspaceCache.read(JSON.stringify([settings, cwd]), reload, async () => {
      const initialized = await this.initialize(configured.command, parseLaunchArgs(settings.launchArgs), configured.env, cwd);
      const skills = await discoverClaudeSkills(configured.home, cwd, configured.env);
      if (JSON.stringify(await loadClaudeSettings(this.directory)) !== JSON.stringify(settings)) throw new Error('Claude 配置已经改变，请重新加载');
      return { provider: 'claude', cwd, checkedAt: new Date().toISOString(), skills, commands: providerCommands(initialized.commands) };
    });
  }

  private child(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = this.directory) {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'pipe' });
    this.children.add(child);
    child.on('close', () => this.children.delete(child));
    child.stdin.on('error', () => {});
    // Discard stderr: CLI errors can echo private environment configuration.
    child.stderr.resume();
    return child;
  }

  private async collect(command: string, args: string[], env: NodeJS.ProcessEnv, allowAuthExit = false): Promise<string> {
    const child = this.child(command, args, env);
    return new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, 8000);
      child.stdout.on('data', data => { output += data; if (output.length > 1_000_000) child.kill(); });
      child.on('error', () => { clearTimeout(timer); reject(new Error('spawn')); });
      child.on('close', code => { clearTimeout(timer); code === 0 || (allowAuthExit && code === 1) ? resolve(output) : reject(new Error('exit')); });
      child.stdin.end();
    });
  }

  private async initialize(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = this.directory, includeUsage = false): Promise<any> {
    const child = this.child(command, [...args,
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--settings', '{"disableAllHooks":true}', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    ], { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' }, cwd);
    const lines = createInterface({ input: child.stdout });
    try {
      return await new Promise((resolve, reject) => {
        let initialized: any;
        const timer = setTimeout(() => reject(new Error('timeout')), 15000);
        const fail = () => { clearTimeout(timer); reject(new Error('initialize')); };
        child.on('error', fail); child.on('close', fail);
        lines.on('line', line => {
          let message: any; try { message = JSON.parse(line); } catch { return; }
          if (message.type !== 'control_response') return;
          const id = message.response?.request_id;
          if (id === 'friday-provider-probe') {
            if (message.response.subtype !== 'success') { clearTimeout(timer); reject(new Error('initialize')); return; }
            initialized = message.response.response;
            if (!includeUsage) { clearTimeout(timer); resolve(initialized); return; }
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'friday-provider-usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
          } else if (id === 'friday-provider-usage') {
            clearTimeout(timer);
            if (message.response.subtype === 'success') resolve({ ...initialized, usage: message.response.response }); else reject(new Error('usage'));
          }
        });
        // Only an initialization request: no user message, generation, or billable test turn.
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'friday-provider-probe', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } }) + '\n');
      });
    } finally { lines.close(); child.stdin.end(); child.kill(); }
  }

  private async probe(settings: CodexSettings): Promise<ModelStatus> {
    const state: ModelStatus = {
      provider: 'Claude', displayName: settings.displayName, enabled: settings.enabled, model: settings.model,
      connected: false, installed: false, version: null, account: null, models: [],
      checkedAt: new Date().toISOString(), error: null, loginPending: false, settings: null,
    };
    try {
      const binary = expandHome(settings.binaryPath);
      const command = isAbsolute(binary) ? binary : findExecutable(binary);
      if (!command) throw new Error('missing');
      await access(command, constants.X_OK); state.installed = true;
      const env = { ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])),
        CLAUDE_CONFIG_DIR: resolve(expandHome(settings.homePath || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'))) };
      const [version, authText] = await Promise.all([this.collect(command, ['--version'], env), this.collect(command, ['auth', 'status', '--json'], env, true)]);
      state.version = version.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
      const auth = JSON.parse(authText);
      if (!auth.loggedIn) { state.error = 'Claude 尚未登录。请在主机运行 claude auth login，或配置 API 环境变量后重新检测。'; return state; }
      const init = await this.initialize(command, parseLaunchArgs(settings.launchArgs), env);
      const account = init.account ?? {};
      const tokenSource = account.tokenSource ?? auth.authMethod;
      state.account = { type: /api.?key|anthropic_auth_token/i.test(tokenSource ?? '') ? 'apiKey' : 'subscription', email: account.email ?? null, plan: account.subscriptionType ?? null };
      const ids = new Set<string>();
      for (const value of init.models ?? []) {
        if (typeof value.value !== 'string' || ids.has(value.value)) continue;
        ids.add(value.value);
        const efforts = Array.isArray(value.supportedEffortLevels) ? value.supportedEffortLevels.filter((effort: unknown) => typeof effort === 'string') : [];
        const model: ProviderModel = {
          id: value.value, name: value.displayName ?? value.value, description: value.description ?? '',
          isDefault: value.value === 'default', reasoningEfforts: efforts, defaultReasoningEffort: '',
          ...(typeof value.resolvedModel === 'string' ? { resolvedModel: value.resolvedModel } : {}),
        };
        state.models.push(model);
      }
      state.model ||= state.models.find(model => model.isDefault)?.id ?? state.models[0]?.id ?? '';
      state.connected = true;
    } catch { state.error = state.installed ? '无法读取 Claude 认证或模型列表，请检查配置目录、环境变量和启动参数后重新检测。' : '找不到 Claude Code，请检查可执行文件路径。'; }
    return state;
  }

  async status(owner = false, force = false): Promise<ModelStatus> {
    const settings = await loadClaudeSettings(this.directory); const key = JSON.stringify(settings);
    if (this.pending && this.pendingKey !== key) { await this.pending; return this.status(owner, force); }
    if (!this.cached || this.cachedKey !== key || force || Date.now() - Date.parse(this.cached.checkedAt) > 60_000) {
      if (!this.pending) {
        this.pendingKey = key;
        this.pending = this.probe(settings).then(value => { this.cachedKey = key; return this.cached = value; }).finally(() => { this.pending = undefined; });
      }
      await this.pending;
    }
    const probe = this.cached!;
    return { ...probe, connected: settings.enabled && probe.connected,
      account: probe.account ? { ...probe.account, email: owner ? probe.account.email : null } : null,
      models: appendCustomModels(probe.models, settings.customModels),
      settings: owner ? { ...settings, environment: settings.environment.map(entry => ({ name: entry.name, value: null, hasValue: true })) } : null,
    };
  }

  async runtime(selection?: { model?: string; reasoningEffort?: string }) {
    if (this.saving) throw new Error('正在保存 Claude 配置，请稍候。');
    const state = await this.status();
    if (!state.enabled) throw new Error('请先在「Providers → Claude」中启用 Claude。');
    if (!state.connected) throw new Error(state.error ?? '请先在「Providers → Claude」中连接 Claude。');
    const settings = await loadClaudeSettings(this.directory);
    const args = parseLaunchArgs(settings.launchArgs); const flags: Record<string, string> = {};
    for (let i = 0; i < args.length; i++) {
      const [flag, inline] = args[i]!.split('=', 2); flags[flag!] = inline ?? args[++i]!;
    }
    const model = selection?.model || settings.model || flags['--model'] || state.model;
    const selected = state.models.find(value => value.id === model);
    const effort = selection?.reasoningEffort || (selection?.model ? '' : settings.reasoningEffort || flags['--effort']);
    if (!selected) throw new Error('当前 Claude 模型不可用，请重新选择。');
    if (effort && (!selected.reasoningEfforts.includes(effort) || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))) throw new Error('当前 Claude 模型不支持所选推理强度，请重新选择。');
    const binary = expandHome(settings.binaryPath);
    const command = isAbsolute(binary) ? binary : findExecutable(binary);
    if (!command) throw new Error('找不到 Claude Code，请检查可执行文件路径。');
    const home = resolve(expandHome(settings.homePath || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
    const settingSources = (flags['--setting-sources'] ?? 'user,project,local').split(',').filter(Boolean);
    if (settingSources.some(value => !['user', 'project', 'local'].includes(value))) throw new Error('Claude 配置来源支持 user、project、local。');
    return { command, home, env: { ...process.env, ...Object.fromEntries(settings.environment.map(value => [value.name, value.value])), CLAUDE_CONFIG_DIR: home }, model, effort: effort || undefined, permissionMode: settings.permissionMode as Exclude<CodexSettings['permissionMode'], 'fullAccess'>, settingSources: settingSources as ('user' | 'project' | 'local')[] };
  }

  async save(value: unknown) {
    if (this.saving || this.resetting) throw new Error('Claude 配置正在保存，请稍候。');
    this.saving = true; let changed = false;
    try {
      await this.pending;
      const settings = validateClaudeSettings(value, await loadClaudeSettings(this.directory));
      await saveProviderSettings(this.directory, 'claude-provider.json', settings); this.cached = undefined; changed = true;
      return await this.status(true, true);
    } finally { this.saving = false; if (changed) await this.onConfigurationChanged?.(); }
  }
  async close() { await Promise.all([...this.closeHooks].map(hook => hook())); for (const child of this.children) child.kill(); await this.pending?.catch(() => {}); }
}
