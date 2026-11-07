import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { privateWorkspacePaths } from './workspace-privacy.js';
import { appleScriptShortcutKey, normalizeScriptShortcut } from './project-script-shortcuts.js';
import type { Engine } from './engine.js';
import type { Project, Workspace } from './types.js';
import type { ProjectScript, ProjectScriptSettings } from './project-script-types.js';
const icons = ['play', 'test', 'lint', 'configure', 'build', 'debug'];
const record = (value: unknown) => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目脚本设置无效'); return value as Record<string, unknown>; };
export function projectScripts(value: unknown): ProjectScript[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('每个项目最多配置 50 个脚本');
  const ids = new Set<string>();
  return value.map(raw => {
    const v = record(raw);
    if (Object.keys(v).some(k => !['id','name','command','icon','runOnWorktreeCreate','runOnSettle','async','previewUrl','autoOpenPreview'].includes(k))) throw new Error('项目脚本字段无效');
    if (typeof v.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.id) || ids.has(v.id)) throw new Error('脚本 ID 无效或重复'); ids.add(v.id);
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200 || /[\x00-\x1f]/.test(v.name)) throw new Error('脚本名称无效');
    if (typeof v.command !== 'string' || !v.command.trim() || v.command.length > 32000 || Buffer.byteLength(v.command) > 48000 || v.command.includes('\0')) throw new Error('脚本命令无效');
    if (!icons.includes(String(v.icon)) || typeof v.runOnWorktreeCreate !== 'boolean' || ['runOnSettle','async','autoOpenPreview'].some(k => v[k] !== undefined && typeof v[k] !== 'boolean')) throw new Error('脚本运行设置无效');
    if (v.previewUrl !== undefined) { try { const url = new URL(String(v.previewUrl)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || String(v.previewUrl).length > 4096) throw new Error(); } catch { throw new Error('脚本预览地址无效'); } }
    return { id: v.id, name: v.name.trim(), command: v.command, icon: v.icon,
      runOnWorktreeCreate: v.runOnWorktreeCreate, ...Object.fromEntries(['runOnSettle','async','previewUrl','autoOpenPreview'].filter(k => v[k] !== undefined).map(k => [k, v[k]])) } as ProjectScript;
  });
}
export const defaultProjectScriptSettings = (): ProjectScriptSettings => ({ version: 0, defaults: [], projects: {}, requests: {} });
export function resolveProjectScripts(state: Workspace, project: Project): { scripts: ProjectScript[]; source: 'default' | 'project'; version: number } {
  const settings = state.projectScriptSettings ?? defaultProjectScriptSettings();
  const override = Object.hasOwn(settings.projects, project.id) ? settings.projects[project.id] : undefined;
  return { scripts: override === null ? settings.defaults : override ?? (project.scripts?.length ? project.scripts : settings.defaults), source: override === null || override === undefined && !project.scripts?.length ? 'default' : 'project', version: settings.version };
}
export async function projectScriptSettings(engine: Engine, projectId?: string) {
  const state = await engine.snapshot(), settings = state.projectScriptSettings ?? defaultProjectScriptSettings();
  const project = projectId ? state.projects.find(p => p.id === projectId) : undefined; if (projectId && !project) throw new Error('Workspace 不存在');
  const resolved = project ? { projectId, ...resolveProjectScripts(state, project) } : { version: settings.version, scripts: settings.defaults, source: 'default' };
  return { defaults: settings.defaults, ...resolved, keybindings: Object.fromEntries(resolved.scripts.flatMap(script => settings.keybindings?.[script.id] ? [[script.id, settings.keybindings[script.id]]] : [])) };
}
export async function updateProjectScriptSettings(engine: Engine, raw: unknown) {
  const v = record(raw);
  if (Object.keys(v).some(k => !['projectId','version','requestId','scripts','keybindings'].includes(k))) throw new Error('项目脚本设置字段无效');
  if (typeof v.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.requestId) || !Number.isSafeInteger(v.version) || Number(v.version) < 0 || v.projectId !== null && typeof v.projectId !== 'string') throw new Error('项目脚本设置版本无效');
  if (['__proto__','constructor','prototype'].includes(v.requestId)) throw new Error('脚本设置请求 ID 无效');
  if (v.projectId && ['__proto__','constructor','prototype'].includes(String(v.projectId))) throw new Error('Workspace 无效');
  const scripts = v.scripts === null && v.projectId !== null ? null : projectScripts(v.scripts);
  const bindings = v.keybindings === undefined ? undefined : Object.fromEntries(Object.entries(record(v.keybindings)).sort(([a],[b]) => a.localeCompare(b)).map(([id, key]) => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ['__proto__','constructor','prototype'].includes(id)) throw new Error('脚本快捷键目标无效');
    return [id, key === null || key === '' ? null : normalizeScriptShortcut(key)];
  }));
  if (bindings && Object.keys(bindings).length > 100) throw new Error('脚本快捷键修改过多');
  const digest = createHash('sha256').update(JSON.stringify([v.projectId, scripts, ...(bindings ? [bindings] : [])])).digest('hex');
  await engine.mutate(state => {
    state.projectScriptSettings ??= defaultProjectScriptSettings();
    const settings = state.projectScriptSettings;
    if (Object.hasOwn(settings.requests, String(v.requestId))) { if (settings.requests[String(v.requestId)] !== digest) throw new Error('脚本设置请求已用于不同内容'); return; }
    if (settings.version !== v.version) throw new Error('脚本设置已在其他设备修改，请重新载入');
    if (v.projectId !== null && !state.projects.some(p => p.id === v.projectId)) throw new Error('Workspace 不存在');
    const project = state.projects.find(p => p.id === v.projectId);
    const previous = project ? resolveProjectScripts(state, project).scripts : settings.defaults;
    const allowed = new Set([...previous, ...(scripts ?? settings.defaults)].map(s => s.id));
    if (bindings && Object.keys(bindings).some(id => !allowed.has(id))) throw new Error('快捷键不属于此设置范围中的脚本');
    if (v.projectId === null) settings.defaults = scripts!; else settings.projects[String(v.projectId)] = scripts;
    if (bindings) {
      settings.keybindings ??= {};
      for (const [id, value] of Object.entries(bindings)) { if (value === null) delete settings.keybindings[id]; else settings.keybindings[id] = value; }
    }
    const variants = [settings.defaults, ...state.projects.map(p => resolveProjectScripts(state, p).scripts)];
    const retained = new Set(variants.flatMap(scripts => scripts.map(s => s.id)));
    for (const id of Object.keys(settings.keybindings ?? {})) if (!retained.has(id)) delete settings.keybindings![id];
    for (const variant of variants) {
      const claimed = new Set<string>();
      for (const script of variant) { const key = settings.keybindings?.[script.id]; if (!key) continue; const normalized = appleScriptShortcutKey(key); if (claimed.has(normalized)) throw new Error('同一 Workspace 中的脚本快捷键重复'); claimed.add(normalized); }
    }
    settings.version++; settings.requests[String(v.requestId)] = digest;
  });
  return projectScriptSettings(engine, typeof v.projectId === 'string' ? v.projectId : undefined);
}

// t3.json is data. Discovery never installs or executes its commands.
export async function importableProjectScripts(engine: Engine, projectId: string) {
  const project = (await engine.snapshot()).projects.find(p => p.id === projectId); if (!project) throw new Error('Workspace 不存在');
  const root = await realpath(project.path); if ((await privateWorkspacePaths(root, {directory:engine.directory,projectFolder:project.managedFolder})).includes('')) throw new Error('Workspace 目录不可读取');
  const handle = await open(join(root, 't3.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => { if (error.code === 'ENOENT') throw new Error('Workspace 中没有 t3.json'); throw new Error('t3.json 不是可读取的普通文件'); });
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 256 * 1024) throw new Error('t3.json 不是普通文件或超过 256 KiB');
    const bytes = Buffer.alloc(256 * 1024 + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); if (bytesRead > 256 * 1024) throw new Error('t3.json 超过 256 KiB');
    let value: Record<string, unknown>; try { value = record(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))); } catch { throw new Error('t3.json 内容无效'); }
    if (!Array.isArray(value.scripts)) throw new Error('t3.json 没有 scripts 列表');
    return { scripts: projectScripts(value.scripts.map((raw, index) => {
      const v = record(raw); return { ...v, id: 'import-' + createHash('sha256').update(JSON.stringify([index, v.name, v.command])).digest('hex').slice(0, 24), icon: v.icon ?? 'play', runOnWorktreeCreate: v.runOnWorktreeCreate ?? false };
    })) };
  } finally { await handle.close(); }
}
