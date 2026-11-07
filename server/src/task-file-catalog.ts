import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { TaskFileEntry } from './task-files.js';

const exec = promisify(execFile);
type Catalog = { entries: TaskFileEntry[]; truncated: boolean };
const cache = new Map<string, { expires: number; promise: Promise<Catalog> }>();
const skip = new Set(['.git', 'node_modules', '.build', 'dist', '.next']);
const hidden = (path: string, excluded: string[]) => excluded.some(prefix => prefix === '' || path === prefix || path.startsWith(prefix + '/'));
const valid = (path: string) => path && !path.startsWith('/') && !path.includes('\0') && !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git');
async function names(command: string, args: string[], cwd: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try { return { text: (await exec(command, args, { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } })).stdout, truncated: false }; }
  catch (error) { const value = error as { code?: string; stdout?: string }; if (value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && value.stdout) return { text: value.stdout.slice(0, value.stdout.lastIndexOf('\0') + 1), truncated: true }; throw error; }
}
async function scan(cwd: string, excluded: string[]): Promise<Catalog> {
  const entries = new Map<string, TaskFileEntry>(); let truncated = false;
  const add = (path: string, kind: 'file' | 'directory' = 'file') => {
    if (!valid(path) || hidden(path, excluded)) return;
    const components = path.split('/');
    for (let length = 1; length < components.length; length++) {
      const directory = components.slice(0, length).join('/'); entries.set(directory, { path: directory, name: components[length - 1], kind: 'directory' });
    }
    entries.set(path, { path, name: components.at(-1)!, kind });
  };
  try {
    const flags = ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'];
    const files = await names('/usr/bin/git', [...flags, '--', '.'], cwd); truncated ||= files.truncated;
    for (const path of files.text.split('\0')) add(path);
    const directories = await names('/usr/bin/git', [...flags.slice(0, -3), '--others', '--exclude-standard', '--directory', '--', '.'], cwd).catch(() => undefined);
    if (directories) for (const path of directories.text.split('\0')) if (path.endsWith('/')) add(path.slice(0, -1), 'directory');
  } catch {
    try {
      const files = await names('rg', ['--files', '--hidden', '--null', '-g', '!.git', '-g', '!node_modules', '-g', '!.build', '-g', '!dist', '.'], cwd); truncated ||= files.truncated;
      for (const path of files.text.split('\0')) add(path.replace(/^\.\//, ''));
    } catch {
      const folders = ['']; let visited = 0;
      while (folders.length && visited < 100_000) {
        const folder = folders.shift()!; const children = await readdir(join(cwd, folder), { withFileTypes: true }).catch(() => []);
        for (const child of children) {
          visited++; const path = folder ? folder + '/' + child.name : child.name;
          if (skip.has(child.name) || hidden(path, excluded)) continue;
          if (child.isDirectory()) { add(path, 'directory'); folders.push(path); } else if (child.isFile() || child.isSymbolicLink()) add(path);
          if (visited >= 100_000) break;
        }
      }
      truncated ||= folders.length > 0;
    }
  }
  // Empty root directories also remain available in a new/non-Git workspace.
  for (const child of await readdir(cwd, { withFileTypes: true })) if (child.isDirectory() && !skip.has(child.name)) add(child.name, 'directory');
  return { entries: [...entries.values()], truncated };
}
export async function taskFileCatalog(cwd: string, excluded: string[]) {
  const key = cwd + '\0' + excluded.join('\0'); const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.promise;
  const promise = scan(cwd, excluded); cache.delete(key); cache.set(key, { expires: Date.now() + 3000, promise });
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
  try { return await promise; } catch (error) { if (cache.get(key)?.promise === promise) cache.delete(key); throw error; }
}
export function contextFileScore(path: string, query: string): number | undefined {
  const lower = path.toLocaleLowerCase(); const name = basename(lower); const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return path.split('/').length * 100;
  let score = 0;
  for (const token of tokens) {
    const direct = lower.indexOf(token); if (direct >= 0) { score += name === token ? 0 : name.startsWith(token) ? 1 : name.includes(token) ? 3 : 8; continue; }
    let position = 0; let previous = -1; let gap = 0;
    for (const char of token) { const found = lower.indexOf(char, position); if (found < 0) return undefined; if (previous >= 0) gap += found - previous - 1; previous = found; position = found + char.length; }
    score += 20 + gap;
  }
  return score + path.split('/').length / 100;
}
