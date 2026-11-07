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
    ['pi', 'Pi', '可选任务执行工具；原生 RPC 会话、模型与权限配置见「Providers → Pi」'],
  ].map(([id, name, description]) => {
    const executable = findExecutable(id);
    return { id, name, description, installed: executable !== null, executable, executableSupported: ['codex', 'claude', 'pi'].includes(id) };
  });
}
