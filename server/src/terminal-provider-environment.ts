import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexAccountEnvironment, expandHome, loadCodexSettings } from './codex-settings.js';
import { loadClaudeSettings } from './claude-provider.js';
import { loadPiSettings, piAccountEnvironment } from './pi-provider.js';
import { loadGrokSettings, grokAccountEnvironment } from './grok-provider.js';
import { loadNativeProviderSettings, nativeProviderAccount, nativeProviderEnvironment, type NativeProvider } from './native-provider-config.js';
import { CursorConnection } from './cursor-provider.js';
import { AcpProviderConnection } from './acp-provider.js';
import { loadAcpProviderSettings, type AcpProviderID } from './acp-provider-settings.js';
import { antigravityEnvironment, antigravityProfilePaths } from './antigravity-profile.js';
import { delimiter } from 'node:path';
import type { WorkItem } from './types.js';

/** Match T3 terminal provider overlays without probing a model or requiring a
 * CLI binary. Resolve the account exactly as execution does, keeping the
 * task's recorded account boundary when its provider settings have changed. */
export async function terminalProviderEnvironment(directory: string, task?: Pick<WorkItem, 'agent' | 'codexHome' | 'claudeHome' | 'piHome' | 'grokHome' | 'nativeProviderAccount'>): Promise<NodeJS.ProcessEnv> {
  if (task && ['acp-registry', 'antigravity'].includes(task.agent)) {
    const provider = task.agent as AcpProviderID, connection = new AcpProviderConnection(directory, provider), settings = await loadAcpProviderSettings(directory, provider);
    if (task.nativeProviderAccount && task.nativeProviderAccount !== await connection.accountIdentity(settings)) throw new Error('终端账号配置已改变，请使用当前 ACP 工具重新开始任务');
    const env = { ...process.env, ...Object.fromEntries(settings.environment.map(value => [value.name, value.value])) };
    if (provider === 'antigravity') return antigravityEnvironment(antigravityProfilePaths(directory, 'antigravity'), settings.nativeConfig, env);
    const paths = settings.nativeConfig.source === 'registry' && settings.nativeConfig.registryAgentId ? await connection.tools.preparedDirectories('acp-' + settings.nativeConfig.registryAgentId) : [];
    return { ...env, PATH: [...paths, env.PATH].filter(Boolean).join(delimiter) };
  }
  if (task && ['cursor', 'muse', 'opencode'].includes(task.agent)) {
    const provider = task.agent as NativeProvider, settings = await loadNativeProviderSettings(directory, provider);
    const account = provider === 'cursor' ? await new CursorConnection(directory).accountIdentity(settings) : nativeProviderAccount(provider, settings);
    if (task.nativeProviderAccount && task.nativeProviderAccount !== account) throw new Error('终端账号配置已改变，请恢复这条任务使用的工具配置');
    return nativeProviderEnvironment(provider, settings);
  }
  if (task?.agent === 'grok') {
    const configured = grokAccountEnvironment(await loadGrokSettings(directory));
    if (task.grokHome && task.grokHome !== configured.home) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Grok 目录');
    return configured.env;
  }
  if (task?.agent === 'pi') {
    const configured = piAccountEnvironment(await loadPiSettings(directory));
    if (task.piHome && task.piHome !== configured.home) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Pi 目录');
    return configured.env;
  }
  if (task?.agent === 'codex') {
    const configured = await codexAccountEnvironment(await loadCodexSettings(directory));
    if (task.codexHome && task.codexHome !== configured.home) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Codex 目录');
    return configured.env;
  }
  if (task?.agent === 'claude') {
    const settings = await loadClaudeSettings(directory);
    const home = resolve(expandHome(settings.homePath || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')));
    if (task.claudeHome && task.claudeHome !== home) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Claude 目录');
    return { ...Object.fromEntries(settings.environment.map(entry => [entry.name, entry.value])), CLAUDE_CONFIG_DIR: home };
  }
  return {};
}
