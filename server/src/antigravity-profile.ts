import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, rm, readlink, symlink, realpath, lstat, readFile, stat, chmod } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { workspaceCommand } from './git-process.js';

// Adapted from T3 8cd9641f antigravityAuthSupport / AntigravityClientFiles.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export type AntigravityAuthMethod = 'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform';
export type AntigravityAuthConfig = { authMethod: AntigravityAuthMethod; apiKey: string; gcpProject: string; gcpLocation: string };
export type AntigravityProfile = { geminiHome: string; acpDirectory: string; tokenPath: string; tempDirectory: string; browserCommand: string };
export const antigravityBrowserMarker = '__FRIDAY_ANTIGRAVITY_AUTH_URL__';
export const antigravityBrowserHelper = 'process.stderr.on("error",()=>process.exit(0)).write("' + antigravityBrowserMarker + '"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))';
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const removed = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'AGY_ACP_CCPA_PROJECT', 'AGY_ACP_ENABLE_OAUTH', 'GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'ANTIGRAVITY_HARNESS_PATH', 'BROWSER', 'PYTHONUNBUFFERED', 'ELECTRON_RUN_AS_NODE']);
export function antigravityAuthIssue(auth: AntigravityAuthConfig) {
  if (!['oauth-personal', 'oauth-business', 'gemini-api-key', 'agent-platform'].includes(auth.authMethod)) return 'Antigravity 认证方式无效';
  if (auth.authMethod === 'oauth-business' && !(auth.gcpProject && auth.gcpLocation)) return 'Gemini Enterprise 需要 GCP 项目和区域';
  if (auth.authMethod === 'gemini-api-key' && !auth.apiKey) return '请填写 Gemini API Key';
  if (auth.authMethod === 'agent-platform' && !(auth.apiKey || auth.gcpProject && auth.gcpLocation)) return 'Agent Platform 需要 API Key 或 GCP 项目与区域';
}
export function antigravityEnvironment(profile: AntigravityProfile, auth: AntigravityAuthConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(base).filter(([name]) => !removed.has(name.toUpperCase()))),
    ...(auth.authMethod === 'gemini-api-key' && auth.apiKey ? { GEMINI_API_KEY: auth.apiKey } : auth.authMethod === 'agent-platform' && auth.apiKey ? { GOOGLE_API_KEY: auth.apiKey } : {}),
    GEMINI_HOME: profile.geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1', BROWSER: profile.browserCommand, PYTHONUNBUFFERED: '1', ELECTRON_RUN_AS_NODE: '1',
    ...(process.platform === 'win32' ? { TEMP: profile.tempDirectory, TMP: profile.tempDirectory } : { TMPDIR: profile.tempDirectory }) };
}
export function antigravityProfilePaths(directory: string, instance: string): AntigravityProfile {
  const key = createHash('sha256').update(instance).digest('hex'), geminiHome = join(directory, 'providers', 'antigravity', key), acpDirectory = join(geminiHome, 'antigravity-acp'), tempDirectory = join(directory, 'antigravity-tmp', key.slice(0, 12)), browserCommand = [process.execPath.replaceAll('\\', '/'), '-e', antigravityBrowserHelper, '--', '%s'].map(quote).join(' ');
  if (browserCommand.includes(process.platform === 'win32' ? ';' : ':') || /[\r\n\0]/.test(process.execPath) || process.execPath.includes('%s')) throw new Error('无法保证 Antigravity 登录只返回浏览器地址');
  return { geminiHome, acpDirectory, tempDirectory, browserCommand, tokenPath: join(acpDirectory, 'acp_token.json') };
}
export async function prepareAntigravityProfile(directory: string, instance: string, auth: AntigravityAuthConfig, base: NodeJS.ProcessEnv = process.env) {
  const issue = antigravityAuthIssue(auth); if (issue) throw new Error(issue);
  const profile = antigravityProfilePaths(directory, instance), { geminiHome, acpDirectory, tempDirectory } = profile;
  for (const path of [geminiHome, acpDirectory, tempDirectory]) { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
  const preflight = 'https://example.invalid/friday-antigravity-preflight', response = await workspaceCommand(directory, process.execPath, ['-e', antigravityBrowserHelper, '--', preflight], { timeout: 5000, limit: 32768, env: antigravityEnvironment(profile, auth, base) });
  if (response.stdout || response.stderr !== antigravityBrowserMarker + JSON.stringify(preflight)) throw new Error('Antigravity 浏览器地址回传检查失败');
  const data = { auth: { type: auth.authMethod }, ...((auth.gcpProject || auth.gcpLocation) ? { gcp: { ...(auth.gcpProject ? { project: auth.gcpProject } : {}), ...(auth.gcpLocation ? { location: auth.gcpLocation } : {}) } } : {}) }, target = join(acpDirectory, 'settings.json'), temporary = target + '.' + randomUUID() + '.tmp';
  try { await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, target); } finally { await rm(temporary, { force: true }); }
  const user = base.HOME?.trim() || base.USERPROFILE?.trim() || homedir();
  for (const path of ['config/skills', 'antigravity-cli/skills']) {
    const link = join(geminiHome, path), target = join(user, '.gemini', path);
    try { const current = await readlink(link).catch(() => undefined); if (current && resolve(dirname(link), current) === target) continue; if (current) await rm(link); await mkdir(dirname(link), { recursive: true, mode: 0o700 }); await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* A real existing skill directory stays owned by its user. */ }
  }
  return profile;
}
async function antigravityClientPath(cwd: string, requested: unknown) {
  if (typeof requested !== 'string' || !isAbsolute(requested) || requested.includes('\0')) throw new Error('Antigravity 文件路径无效');
  const root = await realpath(cwd), path = resolve(requested); let canonical: string;
  try { canonical = await realpath(path); }
  catch {
    if (await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Antigravity 文件链接无法解析');
    let parent = dirname(path), tail = path.slice(parent.length + 1);
    for (;;) { try { canonical = join(await realpath(parent), tail); break; } catch { const next = dirname(parent); if (next === parent) throw new Error('Antigravity 文件父目录不可用'); tail = join(parent.slice(next.length + 1), tail); parent = next; } }
  }
  const local = relative(root, canonical); if (local === '..' || local.startsWith('../') || isAbsolute(local)) throw new Error('Antigravity 文件超出任务工作区'); return canonical;
}
export async function antigravityClientFile(cwd: string, method: string, params: Record<string, unknown>) {
  if (!['fs/read_text_file', 'fs/write_text_file'].includes(method)) throw new Error('Antigravity 文件请求方法无效');
  const path = await antigravityClientPath(cwd, params.path), maximum = 8 * 1024 * 1024;
  if (method === 'fs/write_text_file') { if (typeof params.content !== 'string' || Buffer.byteLength(params.content, 'utf8') > maximum) throw new Error('Antigravity 文本文件超过 8 MiB'); await mkdir(dirname(path), { recursive: true }); await writeFile(path, params.content); return {}; }
  const info = await stat(path); if (!info.isFile() || info.size > maximum) throw new Error('Antigravity 只读取 8 MiB 以内的普通文本文件');
  const text = await readFile(path, 'utf8'); if (params.line === undefined && params.limit === undefined) return { content: text };
  const line = params.line ?? 1, limit = params.limit; if (!Number.isSafeInteger(line) || Number(line) < 1 || limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1)) throw new Error('Antigravity 文本行范围无效');
  return { content: text.split('\n').slice(Number(line) - 1, limit === undefined ? undefined : Number(line) - 1 + Number(limit)).join('\n') };
}
