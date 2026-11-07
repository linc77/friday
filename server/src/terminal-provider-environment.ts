import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { codexAccountEnvironment, expandHome, loadCodexSettings } from './codex-settings.js';
import { loadClaudeSettings } from './claude-provider.js';
import { loadPiSettings, piAccountEnvironment, piSessionAccount } from './pi-provider.js';
import type { WorkItem } from './types.js';

/** Match T3 terminal provider overlays without probing a model or requiring a
 * CLI binary. Resolve the account exactly as execution does, keeping the
 * task's recorded account boundary when its provider settings have changed. */
export async function terminalProviderEnvironment(directory: string, task?: Pick<WorkItem, 'agent' | 'codexHome' | 'claudeHome' | 'piHome' | 'nativeProviderAccount'>): Promise<NodeJS.ProcessEnv> {
  if (task?.agent === 'pi') {
    const settings = await loadPiSettings(directory), configured = piAccountEnvironment(settings);
    if (task.piHome && task.piHome !== configured.home) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Pi 目录');
    if (task.nativeProviderAccount && task.nativeProviderAccount !== piSessionAccount(settings)) throw new Error('终端账号配置已改变，请恢复这条任务使用的 Pi 配置');
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
