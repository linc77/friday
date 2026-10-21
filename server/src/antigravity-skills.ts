import { stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { ProviderSkill } from './claude-skills.js';
// T3 8cd9641f provider/Drivers/AntigravitySkills.ts (MIT), copyright 2026
// T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export async function antigravitySkills(cwd: string, home: string): Promise<ProviderSkill[]> {
  const roots = [{ directory: join(home, '.gemini/config/skills'), scope: 'user' }, { directory: resolve(cwd, '.gemini/skills'), scope: 'project' }, { directory: join(home, '.gemini/antigravity-cli/skills'), scope: 'user' }, { directory: resolve(cwd, '.agents/skills'), scope: 'project' }, { directory: resolve(cwd, '.agent/skills'), scope: 'project' }], skills = new Map<string, ProviderSkill>(); let remainingBytes = 8000000, remainingEntries = 10000;
  const optional = async <T>(read: () => Promise<T>) => { try { return await read(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('无法完成 Antigravity Skill 目录读取'); } };
  const visit = async (directory: string, scope: string, children: boolean): Promise<void> => {
    if (!(await optional(() => stat(directory)))?.isDirectory()) return;
    const entries = await optional(() => readdir(directory)); if (!entries) return; remainingEntries -= entries.length; if (remainingEntries < 0) throw new Error('Antigravity Skill 目录超过扫描预算');
    const sorted = entries.toSorted(), file = sorted.find(value => value.toLowerCase() === 'skill.md');
    if (file) {
      if (!file.endsWith('.md')) return; const path = join(directory, file), info = await optional(() => stat(path)); if (!info?.isFile()) return; const limit = Math.min(1000000, remainingBytes); if (info.size > limit) throw new Error('Antigravity Skill 文件超过读取预算');
      const chunks: Buffer[] = []; let bytes = 0; for await (const value of createReadStream(path, { end: limit })) { const chunk = Buffer.from(value); bytes += chunk.length; if (bytes > limit) throw new Error('Antigravity Skill 文件超过读取预算'); chunks.push(chunk); } remainingBytes -= bytes;
      const content = Buffer.concat(chunks).toString('utf8'), start = content.indexOf('---'), end = start < 0 ? -1 : content.indexOf('---', start + 3); if (end < 0) return;
      try { const front = parse(content.slice(start + 3, end).trim()) ?? {}; if (!front || typeof front !== 'object' || Array.isArray(front) || front.name != null && typeof front.name !== 'string' || front.description != null && typeof front.description !== 'string') return; const name = front.name || file.slice(0, -3), description = front.description?.trim(); if (!name || name !== name.trim() || skills.has(name)) return; skills.set(name, { name, path, scope, enabled: true, ...(description ? { description } : {}) }); } catch { /* Native malformed YAML is not an invocable skill. */ }
      return;
    }
    if (children) {
      const escaped = (value: string) => encodeURI(value).replace(/[!'()*?#]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
      for (const entry of sorted.sort((a, b) => escaped(a) < escaped(b) ? -1 : escaped(a) > escaped(b) ? 1 : 0)) await visit(join(directory, entry), scope, false);
    }
  };
  for (const root of roots) await visit(root.directory, root.scope, true);
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
