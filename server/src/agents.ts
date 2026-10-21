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
    ['cursor', 'Cursor', '原生 SDK 任务执行工具；账号与模型配置见「Providers → Cursor」'],
    ['opencode', 'OpenCode', '原生 1.x／2.x 任务执行工具；配置见「Providers → OpenCode」'],
    ['muse', 'Muse Code', '原生 MSP 任务执行工具；配置见「Providers → Muse Code」'],
    ['antigravity', 'Antigravity', '原生 ACP 工具、Google 账号与模型配置见「Providers → Antigravity」'],
    ['acp-registry', 'ACP Registry', '官方 ACP Registry 或本地 ACP 命令，原生配置见「Providers → ACP Registry」'],
    ['hermes', 'Hermes', '已发现时显示安装状态；执行接入尚未完成'],
    ['pi', 'Pi', '可选任务执行工具；原生 RPC 会话、模型与权限配置见「Providers → Pi」'],
    ['grok', 'Grok', '可选任务执行工具；原生 ACP 会话、模型与权限配置见「Providers → Grok」'],
  ].map(([id, name, description]) => {
    const executable = findExecutable(id);
    return { id, name, description, installed: id === 'cursor' || executable !== null, executable, executableSupported: ['codex', 'claude', 'pi', 'grok', 'cursor', 'muse', 'opencode', 'acp-registry', 'antigravity'].includes(id) };
  });
}
