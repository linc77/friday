import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentInfo } from './types.js';

export function findExecutable(command: string): string | null {
  const paths = [...new Set((process.env.PATH ?? '').split(delimiter).concat('/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')))];
  for (const directory of paths.filter(Boolean)) {
    const path = join(directory, command);
    try { accessSync(path, constants.X_OK); return path; } catch { /* Try the next PATH entry. */ }
  }
  return null;
}
export function discoverAgents(): AgentInfo[] {
  return [
    ['codex', 'Codex', '可选任务执行工具；账号、模型与运行配置见「Providers → Codex」'],
    ['claude', 'Claude Code', '可选任务执行工具；账号、模型与运行配置见「Providers → Claude」'],
    ['hermes', 'Hermes', '已发现时显示安装状态；执行接入尚未完成'],
    ['pi', 'Pi Coding Agent', '已发现时显示安装状态；独立 CLI 接入尚未完成'],
  ].map(([id, name, description]) => {
    const executable = findExecutable(id);
    return { id, name, description, installed: executable !== null, executable, executableSupported: id === 'codex' || id === 'claude' };
  });
}
