// Adapted from T3 8cd9641f provider-cursor/server/skills.ts (MIT).
// Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import type { ProviderSkill } from './claude-skills.js';
const truth = (value: unknown) => typeof value === 'boolean' ? value : /^(true|yes|on|1)$/i.test(String(value)) ? true : /^(false|no|off|0)$/i.test(String(value)) ? false : undefined;
export async function cursorSkills(cwd: string, environment: NodeJS.ProcessEnv): Promise<ProviderSkill[]> {
  const roots = [cwd, environment.HOME?.trim() || environment.USERPROFILE?.trim() || homedir()].flatMap((base, index) => ['.cursor', '.agents', '.codex', '.claude'].map(name => ({ path: join(base, name, 'skills'), scope: index === 0 ? 'project' : 'user' }))), found = new Map<string, ProviderSkill>(), scanned = new Set<string>();
  let entries = 10000, bytes = 8000000, incomplete = false;
  const optional = async <T>(read: () => Promise<T>) => { try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') incomplete = true; return undefined; } };
  for (const root of roots) {
    const canonical = await optional(() => realpath(root.path)); if (!canonical || scanned.has(canonical)) continue; scanned.add(canonical); const visited = new Set<string>();
    const visit = async (path: string, depth: number): Promise<void> => {
      const resolved = await optional(() => realpath(path)); if (!resolved || visited.has(resolved)) return; visited.add(resolved);
      const file = join(path, 'SKILL.md'), info = await optional(() => stat(file));
      if (info?.isFile() && info.size <= 1000000 && info.size <= bytes) {
        const text = await optional(() => readFile(file, 'utf8')); bytes -= info.size;
        if (text !== undefined) {
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text); let front: Record<string, any> | undefined = {};
          try { if (match) { const value = parse(match[1]!); front = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } } catch { front = undefined; }
          const surfaces = Array.isArray(front?.metadata?.surfaces) ? front.metadata.surfaces : typeof front?.metadata?.surfaces === 'string' ? front.metadata.surfaces.split(',') : [], name = basename(path).trim();
          if (front && (!surfaces.length || surfaces.some((value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'cli')) && name && !found.has(name)) found.set(name, { name, path: file, enabled: true, scope: root.scope,
            ...(typeof front.description === 'string' ? { description: front.description.trim() } : {}), ...(typeof front.name === 'string' && front.name.trim() !== name ? { displayName: front.name.trim() } : {}), ...(truth(front['disable-model-invocation']) === true ? { userInvocationOnly: true } : {}), ...(truth(front['user-invocable']) === false ? { userInvocable: false } : {}) });
        }
      } else if (info?.isFile()) incomplete = true;
      if (resolved !== canonical && !resolved.startsWith(canonical + sep) || depth >= 10) return;
      const children = await optional(() => readdir(path, { withFileTypes: true }));
      for (const child of (children ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
        if (--entries < 0) throw new Error('Cursor Skill 扫描超过目录预算，请缩小 Skill 目录');
        if (child.name === 'node_modules') continue;
        const next = join(path, child.name); if (child.isDirectory() || child.isSymbolicLink() && (await optional(() => stat(next)))?.isDirectory()) await visit(next, depth + 1);
      }
    };
    await visit(root.path, 0);
  }
  if (incomplete) throw new Error('Cursor Skill 扫描未完成，请检查目录权限或文件大小');
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const rewriteCursorSkills = (text: string, names: ReadonlySet<string>) => text.replace(/(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu, (match, prefix: string, name: string) => names.has(name) ? `${prefix}/${name}` : match);
