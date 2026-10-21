import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { privateWorkspacePaths, type WorkspacePrivacy } from './workspace-privacy.js';
import type { TaskRunFile } from './types.js';
export { privateWorkspacePaths } from './workspace-privacy.js';

const exec = promisify(execFile);
const previewBytes = 512 * 1024;
export const workspacePathspecs = (excluded: string[] = []) => ['.', ...excluded.map(path => path === '' ? ':(exclude)**' : `:(exclude,literal)${path}`)];
export type TaskChangeScope = 'all' | 'staged' | 'working';
export type TaskChangedFile = {
  path: string; oldPath?: string; kind: 'add' | 'update' | 'delete' | 'rename' | 'untracked' | 'conflict';
  staged: boolean; unstaged: boolean; additions: number | null; deletions: number | null; binary: boolean; truncated?: boolean;
};
export type TaskChanges = { status: 'repository' | 'not_repository'; scope: TaskChangeScope; files: TaskChangedFile[] };
export type TaskFileDiff = { path: string; oldPath?: string; scope: TaskChangeScope; patch: string; binary: boolean; truncated: boolean };

export function changeScope(value: unknown): TaskChangeScope {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'staged' || value === 'working') return value;
  throw new Error('文件改动范围无效');
}

export function workspaceRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || value.includes('\0') || value.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
    throw new Error('请选择工作区内的相对文件路径');
  }
  return value;
}

function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep));
}

async function git(cwd: string, args: string[], bounded = false) {
  // Never inherit repository/index overrides or execute user-defined diff,
  // textconv, fsmonitor and pager commands while presenting a file preview.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const result = await exec('git', ['--no-pager', '-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', ...args], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      timeout: 10_000, maxBuffer: bounded ? previewBytes : 4 * 1024 * 1024, encoding: 'utf8',
    });
    return { text: result.stdout, truncated: false };
  } catch (error) {
    const value = error as { code?: string; stdout?: string };
    if (bounded && value.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { text: value.stdout ?? '', truncated: true };
    throw error;
  }
}

type Status = { path: string; oldPath?: string; x: string; y: string };
function parseStatus(text: string): Status[] {
  const fields = text.split('\0'); const entries: Status[] = [];
  for (let index = 0; index < fields.length && fields[index]; index++) {
    const field = fields[index]!;
    const value: Status = { path: field.slice(3), x: field[0]!, y: field[1]! };
    if (value.x === 'R' || value.x === 'C' || value.y === 'R' || value.y === 'C') value.oldPath = fields[++index];
    entries.push(value);
  }
  return entries;
}

function parseNames(text: string): { path: string; oldPath?: string; kind: TaskChangedFile['kind'] }[] {
  const fields = text.split('\0'); const values: { path: string; oldPath?: string; kind: TaskChangedFile['kind'] }[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const code = fields[index++]![0]; const first = fields[index++]!;
    const moved = code === 'R' || code === 'C'; const path = moved ? fields[index++]! : first;
    try { workspaceRelativePath(path); if (moved) workspaceRelativePath(first); }
    catch { continue; } // --relative plus a literal subtree pathspec also excludes outside rename sources.
    values.push({ path, ...(moved ? { oldPath: first } : {}), kind: code === 'A' || code === 'C' ? 'add' : code === 'D' ? 'delete' : code === 'R' ? 'rename' : code === 'U' ? 'conflict' : 'update' });
  }
  return values;
}

function parseStats(text: string) {
  const fields = text.split('\0'); const values = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (let index = 0; index < fields.length && fields[index]; index++) {
    const field = fields[index]!; const first = field.indexOf('\t'); const second = field.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const added = field.slice(0, first); const deleted = field.slice(first + 1, second); let path = field.slice(second + 1);
    if (!path) { index++; path = fields[++index]!; }
    const binary = added === '-' || deleted === '-';
    values.set(path, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  return values;
}

export function parseSnapshotChanges(names: string, stats: string): TaskRunFile[] {
  const counts = parseStats(stats);
  return parseNames(names).map(value => ({ ...value, ...(counts.get(value.path) ?? { additions: 0, deletions: 0, binary: false }) }));
}

// Read symlink contents as a link target, never as a file outside the workspace.
// Resolve the parent separately and refuse symlink traversal outside the root.
async function workingFile(cwd: string, path: string) {
  const parent = await realpath(dirname(resolve(cwd, workspaceRelativePath(path))));
  if (!inside(cwd, parent)) throw new Error('文件路径超出工作区');
  const absolute = resolve(parent, path.split('/').at(-1)!);
  const info = await lstat(absolute);
  let data: Buffer;
  if (info.isSymbolicLink()) data = Buffer.from(await readlink(absolute));
  else {
    if (!info.isFile()) throw new Error('这个项目不是普通文件');
    if (info.size > previewBytes) return { text: '', binary: false, truncated: true };
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(previewBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > previewBytes) return { text: '', binary: false, truncated: true };
      data = buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  try {
    if (data.includes(0)) return { text: '', binary: true, truncated: false };
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data), binary: false, truncated: false };
  } catch { return { text: '', binary: true, truncated: false }; }
}

function addedPatch(path: string, text: string) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!text) return '';
  const name = JSON.stringify('b/' + path);
  return `--- /dev/null\n+++ ${name}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(line => '+' + line).join('\n')}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`;
}

async function inspect(cwd: string, scope: TaskChangeScope, privateDirectory?: WorkspacePrivacy): Promise<{ cwd: string; value: TaskChanges; unborn: boolean }> {
  const requested = cwd;
  cwd = await realpath(cwd);
  try { await git(cwd, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    if ((error as { stderr?: string }).stderr?.startsWith('fatal: not a git repository')) return { cwd, value: { status: 'not_repository', scope, files: [] }, unborn: false };
    throw error;
  }
  let unborn = false;
  try { await git(cwd, ['rev-parse', '--verify', 'HEAD']); }
  catch (error) { if ((error as { code?: number }).code === 128) unborn = true; else throw error; }
  const compare = scope === 'staged' || (scope === 'all' && unborn) ? ['--cached'] : scope === 'all' ? ['HEAD'] : [];
  const excluded = await privateWorkspacePaths(requested, privateDirectory);
  if (excluded.includes('')) return { cwd, value: { status: 'repository', scope, files: [] }, unborn };
  const pathspecs = workspacePathspecs(excluded);
  const common = ['--no-ext-diff', '--no-textconv', '--relative', '--find-renames', ...compare];
  const [names, stats, status] = await Promise.all([
    git(cwd, ['diff', '--name-status', '-z', ...common, '--', ...pathspecs]),
    git(cwd, ['diff', '--numstat', '-z', ...common, '--', ...pathspecs]),
    git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs]),
  ]);
  // Status paths are repository-relative even when invoked in a subdirectory.
  const prefix = (await git(cwd, ['rev-parse', '--show-prefix'])).text.replace(/\n$/, '');
  const statuses = parseStatus(status.text).flatMap(value => {
    const path = value.path.startsWith(prefix) ? value.path.slice(prefix.length) : null;
    if (!path) return [];
    try { workspaceRelativePath(path); } catch { return []; }
    const oldPath = value.oldPath?.startsWith(prefix) ? value.oldPath.slice(prefix.length) : undefined;
    return [{ ...value, path, oldPath }];
  });
  const byPath = new Map(statuses.flatMap(value => [[value.path, value] as const, ...(value.oldPath ? [[value.oldPath, value] as const] : [])]));
  const counts = parseStats(stats.text);
  const files: TaskChangedFile[] = parseNames(names.text).map(value => {
    const status = byPath.get(value.path);
    return { ...value, staged: !!status && status.x !== ' ' && status.x !== '?', unstaged: !!status && status.y !== ' ',
      ...(counts.get(value.path) ?? { additions: 0, deletions: 0, binary: false }) };
  });
  // Before the first commit, HEAD has no tree. The all-files view compares
  // staged additions against their actual working contents, including deletes.
  const added: { path: string; kind: TaskChangedFile['kind'] }[] = scope === 'all' && unborn ? files.map(value => ({ path: value.path, kind: 'add' })) : [];
  if (scope === 'all' && unborn) files.length = 0;
  if (scope !== 'staged') added.push(...statuses.filter(value => value.x === '?').map(value => ({ path: value.path, kind: 'untracked' as const })));
  for (const entry of added) {
    let value: Awaited<ReturnType<typeof workingFile>>;
    try { value = await workingFile(cwd, entry.path); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') continue; throw error; }
    const status = byPath.get(entry.path);
    files.push({ path: entry.path, kind: entry.kind, staged: !!status && status.x !== '?', unstaged: status?.y !== ' ', binary: value.binary,
      truncated: value.truncated, additions: value.binary || value.truncated ? null : value.text ? value.text.split('\n').length - (value.text.endsWith('\n') ? 1 : 0) : 0, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { cwd, value: { status: 'repository', scope, files }, unborn };
}

export async function readTaskChanges(cwd: string, scope: TaskChangeScope = 'all', privateDirectory?: WorkspacePrivacy): Promise<TaskChanges> {
  return (await inspect(cwd, scope, privateDirectory)).value;
}

export async function readTaskDiff(cwd: string, path: string, scope: TaskChangeScope = 'all', privateDirectory?: WorkspacePrivacy): Promise<TaskFileDiff> {
  workspaceRelativePath(path);
  const current = await inspect(cwd, scope, privateDirectory);
  const file = current.value.files.find(value => value.path === path);
  if (!file) throw new Error('这个文件已不在当前改动中，请刷新列表');
  const base = { path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), scope, binary: file.binary, truncated: false };
  if (file.kind === 'untracked' || (current.unborn && scope === 'all')) {
    const value = await workingFile(current.cwd, path);
    return { ...base, patch: value.binary || value.truncated ? '' : addedPatch(path, value.text), binary: value.binary, truncated: value.truncated };
  }
  const compare = scope === 'staged' ? ['--cached'] : scope === 'all' ? ['HEAD'] : [];
  const result = await git(current.cwd, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', ...compare, '--', ...(file.oldPath ? [file.oldPath] : []), path], true);
  return { ...base, patch: result.text, truncated: result.truncated };
}
