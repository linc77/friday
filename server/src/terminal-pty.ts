import { createRequire } from 'node:module';
import { access, chmod, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IPty } from 'node-pty';

const require = createRequire(import.meta.url); const exec = promisify(execFile);
let loaded: typeof import('node-pty') | undefined;
export async function terminalShell(requested?: string) {
  const candidates = [...new Set([...(requested ? [requested] : [process.env.SHELL, userInfo().shell]), '/bin/zsh', '/bin/bash', '/bin/sh'].filter((path): path is string => !!path))];
  for (const path of candidates) {
    if (!isAbsolute(path)) { if (requested) throw new Error('请选择 Shell 的绝对路径'); continue; }
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch {}
    if (requested) throw new Error('所选 Shell 不存在或不可执行');
  }
  throw new Error('找不到可用的 Shell');
}
export async function terminalPty() {
  if (!loaded) {
    const directory = dirname(require.resolve('node-pty/package.json'));
    for (const path of [join(directory, 'prebuilds', process.platform + '-' + process.arch, 'spawn-helper'), join(directory, 'build/Release/spawn-helper')]) {
      try { const mode = (await stat(path)).mode; if (!(mode & 0o111)) await chmod(path, mode | 0o111); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    loaded = require('node-pty');
  }
  return loaded!;
}
export const terminalEnvironment = (shell: string, cwd: string, id: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FRIDAY_|CODEX_|ELECTRON_)/.test(key) && !['PORT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].includes(key))),
  SHELL: shell, PWD: cwd, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Friday', TERM_PROGRAM_VERSION: '0.1.0', FRIDAY_TERMINAL_SESSION: id,
});
type Process = { pid: number; parent: number; group: number; command: string };
export async function terminalProcesses() {
  const output = (await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,comm='], { timeout: 3000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  return output.split('\n').flatMap(line => { const value = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/); return value ? [{ pid: Number(value[1]), parent: Number(value[2]), group: Number(value[3]), command: value[4] }] : []; });
}
export function terminalDescendants(rows: Process[], root: number) {
  const ids = new Set([root]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
  return rows.filter(row => ids.has(row.pid));
}
export async function stopTerminal(pty: IPty, exited: Promise<void>) {
  const rows = await terminalProcesses().catch(() => []);
  const owned = terminalDescendants(rows, pty.pid); const serviceGroup = rows.find(row => row.pid === process.pid)?.group;
  const signal = (value: NodeJS.Signals) => {
    for (const group of new Set(owned.map(row => row.group).filter(group => group > 1 && group !== serviceGroup))) { try { process.kill(-group, value); } catch {} }
    try { pty.kill(value); } catch {}
  };
  signal('SIGHUP');
  let timer: NodeJS.Timeout | undefined; let ended = false; void exited.then(() => { ended = true; });
  try {
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (timer) clearTimeout(timer);
    // Re-check surviving descendants before escalation, so stale PIDs or
    // unrelated process groups from an earlier shell cannot be signalled.
    const live = await terminalProcesses().catch(() => []);
    const retained = owned.filter(row => live.some(current => current.pid === row.pid && current.group === row.group && current.command === row.command));
    const descendants = retained.some(row => row.pid === pty.pid) ? terminalDescendants(live, pty.pid) : [];
    if (!ended) { try { pty.kill('SIGKILL'); } catch {} }
    for (const group of new Set(retained.map(row => row.group).filter(group => group > 1 && group !== serviceGroup))) { try { process.kill(-group, 'SIGKILL'); } catch {} }
    for (const row of [...retained, ...descendants]) {
      try { process.kill(row.pid, 'SIGKILL'); } catch {}
    }
    await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); })]);
    return ended;
  } finally { if (timer) clearTimeout(timer); }
}
