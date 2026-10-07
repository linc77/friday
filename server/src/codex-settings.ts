import { access, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findExecutable } from './agents.js';

export type CodexSettings = {
  enabled: boolean; displayName: string; binaryPath: string; homePath: string; shadowHomePath: string;
  launchArgs: string; model: string; reasoningEffort: string; environment: { name: string; value: string }[];
  customModels: { id: string; name: string }[];
};
export const defaultCodexSettings: CodexSettings = {
  enabled: true, displayName: 'Codex', binaryPath: 'codex', homePath: '', shadowHomePath: '',
  launchArgs: '', model: '', reasoningEffort: '', environment: [], customModels: [],
};
export const expandHome = (value: string) => value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

// Parse argv without a shell: no expansion, command substitution, or script execution.
export function parseLaunchArgs(value: string): string[] {
  const args: string[] = []; let word = ''; let quote = ''; let escaped = false; let started = false;
  for (const char of value) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === '\\' && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (char === quote) quote = ''; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { args.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error('启动参数的引号或转义未闭合。');
  if (started) args.push(word);
  if (args.some(a => a === '--listen' || a.startsWith('--listen='))) throw new Error('连接方式由 Friday 管理，请勿设置 --listen。');
  return args;
}

function field(input: unknown, name: string, max = 4096): string {
  if (typeof input !== 'string' || input.length > max || input.includes('\0')) throw new Error(`${name}格式无效。`);
  return input.trim();
}
export function validateSettings(input: unknown, previous: CodexSettings, provider = 'Codex'): CodexSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型配置格式无效。');
  const value = input as Record<string, unknown>;
  if (typeof value.enabled !== 'boolean') throw new Error('启用状态无效。');
  const result: CodexSettings = {
    enabled: value.enabled, displayName: field(value.displayName, '显示名称', 80) || provider,
    binaryPath: field(value.binaryPath, '可执行文件') || provider.toLowerCase(), homePath: field(value.homePath, '配置目录'),
    shadowHomePath: field(value.shadowHomePath, '独立账号目录'), launchArgs: field(value.launchArgs, '启动参数', 8000),
    model: field(value.model, '模型', 160), reasoningEffort: field(value.reasoningEffort, '推理强度', 30), environment: [], customModels: [],
  };
  for (const path of [result.homePath, result.shadowHomePath]) if (path && !isAbsolute(expandHome(path))) throw new Error('配置目录必须使用绝对路径或 ~/ 开头的路径。');
  if (result.reasoningEffort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(result.reasoningEffort)) throw new Error('推理强度无效。');
  parseLaunchArgs(result.launchArgs);
  if (!Array.isArray(value.environment) || value.environment.length > 40) throw new Error('环境变量最多可配置 40 个。');
  const names = new Set<string>();
  for (const entry of value.environment) {
    if (!entry || typeof entry !== 'object') throw new Error('环境变量格式无效。');
    const name = field(entry.name, '环境变量名称', 100);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error('环境变量名称无效或重复。');
    if (['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_THREAD_ID', 'HOME', 'PATH'].includes(name)) throw new Error('请通过运行配置设置工具路径，不要覆盖主机运行目录。');
    names.add(name);
    const saved = previous.environment.find(e => e.name === name);
    const content = entry.value === null ? saved?.value : entry.value;
    if (typeof content !== 'string' || content.length > 16384 || content.includes('\0')) throw new Error('请输入环境变量的值。');
    result.environment.push({ name, value: content });
  }
  const customModels = value.customModels ?? previous.customModels;
  if (!Array.isArray(customModels) || customModels.length > 40) throw new Error('自定义模型最多可配置 40 个。');
  const ids = new Set<string>();
  for (const entry of customModels) {
    if (!entry || typeof entry !== 'object') throw new Error('自定义模型格式无效。');
    const id = field(entry.id, '模型 ID', 160);
    if (!id || /\s/.test(id) || ids.has(id)) throw new Error('模型 ID 无效或重复。');
    ids.add(id);
    result.customModels.push({ id, name: field(entry.name, '模型名称', 160) || id });
  }
  return result;
}

export async function loadCodexSettings(directory: string): Promise<CodexSettings> {
  try { return validateSettings(JSON.parse(await readFile(join(directory, 'codex-provider.json'), 'utf8')), defaultCodexSettings); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultCodexSettings); throw error; }
}
export async function saveCodexSettings(directory: string, settings: CodexSettings) {
  return saveProviderSettings(directory, 'codex-provider.json', settings);
}
export async function saveProviderSettings(directory: string, filename: string, settings: CodexSettings) {
  const file = join(directory, filename); const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(settings), { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

// Account overlays share state, never credentials. Existing files are left intact.
async function shadowHome(shared: string, shadow: string) {
  if (resolve(shared) === resolve(shadow)) throw new Error('独立账号目录必须与 CODEX_HOME 不同。');
  await mkdir(shadow, { recursive: true, mode: 0o700 });
  const privateEntries = new Set(['auth.json', 'models_cache.json', 'log', 'memories', 'tmp']);
  const entries = await readdir(shared);
  const plans: { name: string; target: string; link: string }[] = [];
  for (const name of ['auth.json', 'models_cache.json']) {
    const info = await lstat(join(shadow, name)).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`独立账号目录中的 ${name} 必须独立保存，不能是符号链接。`);
  }
  for (const name of entries.filter(n => !privateEntries.has(n))) {
    const link = join(shadow, name); const target = join(shared, name);
    const info = await lstat(link).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (info && (!info.isSymbolicLink() || resolve(dirname(link), await readlink(link)) !== target)) throw new Error(`独立账号目录中的 ${name} 已存在，Friday 不会覆盖它。`);
    if (!info) plans.push({ name, target, link });
  }
  for (const plan of plans) await symlink(plan.target, plan.link);
}

export async function codexRuntime(settings: CodexSettings) {
  const binary = expandHome(settings.binaryPath);
  const command = isAbsolute(binary) ? binary : findExecutable(binary);
  if (!command) throw new Error('找不到 Codex，请检查可执行文件路径。');
  await access(command, constants.X_OK);
  const shared = resolve(expandHome(settings.homePath || process.env.CODEX_HOME || join(homedir(), '.codex')));
  const home = settings.shadowHomePath ? resolve(expandHome(settings.shadowHomePath)) : shared;
  if (settings.shadowHomePath) await shadowHome(shared, home);
  const env: NodeJS.ProcessEnv = { ...Object.fromEntries(settings.environment.map(e => [e.name, e.value])), CODEX_HOME: home };
  return { command, args: parseLaunchArgs(settings.launchArgs), env, home };
}
