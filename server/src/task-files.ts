import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { privateWorkspacePaths, type WorkspacePrivacy } from './workspace-privacy.js';
import { contextFileScore, taskFileCatalog } from './task-file-catalog.js';
import { taskFileLanguage, taskFileMimeType, taskFilePreviewKind } from './task-file-preview.js';
import { taskGit } from './git-process.js';
import { verifyScratchWorkspace } from './managed-scratch-workspace.js';
import { verifyManagedProjectFolder } from './managed-project-folders.js';

export type TaskFileEntry = { path: string; name: string; kind: 'file' | 'directory'; ignored?: boolean };
const maxText = 64_000;
const inside = (root: string, path: string) => { const value = relative(root, path); return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep); };
export const fileReferencePath = (value: unknown, allowRoot = false, allowHost = false) => {
  if (allowRoot && (value === '' || value === '.')) return '';
  if (allowRoot && allowHost && value === '/') return '/';
  const host = typeof value === 'string' && allowHost && value.startsWith('/');
  if (typeof value !== 'string' || !value || value.length > 2048 || isAbsolute(value) && !host || value.includes('\0') || (host ? value.slice(1) : value).split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error(allowHost ? '文件或目录路径无效' : '请选择工作区内的文件或目录');
  return value;
};

export class TaskFiles {
  private boundary?: Promise<{ root: string; excluded: string[] }>;
  constructor(readonly cwd: string, private readonly privacy: WorkspacePrivacy, private readonly allowHost = false) {}
  private reference(value: unknown, allowRoot = false) { return fileReferencePath(value, allowRoot, this.allowHost); }
  private async allowed(root: string, target: string, logical: string, host: boolean, excluded: string[]) {
    if (root.split(sep).some(part => part.toLowerCase() === '.git') || target.split(sep).some(part => part.toLowerCase() === '.git')) throw new Error('不能引用 Git 内部数据');
    if (!host && !inside(root, target)) throw new Error('文件不能指向工作区之外');
    if (excluded.includes('')) throw new Error('不能引用 Friday 的私有运行数据');
    if (host) {
      if ((await privateWorkspacePaths(target, this.privacy)).includes('') || (await privateWorkspacePaths(logical, this.privacy)).includes('')) throw new Error('不能引用 Friday 的私有运行数据');
    } else if (excluded.some(value => value === '' || inside(resolve(root, value), target) || inside(resolve(root, value), logical))) throw new Error('不能引用 Friday 的私有运行数据');
  }
  private async checked(path: string) {
    const workspace = typeof this.privacy === 'string' ? undefined : this.privacy.workspace;
    const folder = typeof this.privacy === 'string' ? undefined : this.privacy.projectFolder ?? workspace?.projectFolder;
    if(folder)await verifyManagedProjectFolder(folder,typeof this.privacy==='string'?this.privacy:this.privacy.directory);
    if (workspace?.scratch) {
      if (workspace.state !== 'ready') throw new Error('请先完成临时工作区准备再访问文件');
      if (this.cwd !== workspace.cwd) throw new Error('临时任务目录已改变，请重新打开文件');
      await verifyScratchWorkspace(workspace);
    }
    this.boundary ??= realpath(this.cwd).then(async root => ({ root, excluded: await privateWorkspacePaths(root, this.privacy) }));
    const { root, excluded } = await this.boundary; const target = await realpath(resolve(root, path));
    await this.allowed(root, target, resolve(root, path), this.allowHost && isAbsolute(path), excluded);
    return { root, target };
  }
  async workspaceVersion() {
    const { root } = await this.checked(''), info = await stat(root, { bigint: true });
    if (!info.isDirectory()) throw new Error('工作区路径无效');
    return createHash('sha256').update([root, String(info.dev), String(info.ino)].join('\0')).digest('hex');
  }
  async externalTarget(value: unknown) {
    const path = this.reference(value, true), { target } = await this.checked(path), info = await stat(target);
    if (!info.isFile() && !info.isDirectory()) throw new Error('请选择普通文件或目录');
    return { path, target, kind: info.isDirectory() ? 'directory' : 'file', workspaceVersion: await this.workspaceVersion() };
  }
  async writeTarget(value: unknown) {
    const path = this.reference(value), { root } = await this.checked(''), host = this.allowHost && isAbsolute(path), anchor = host ? parse(path).root : root, parts = (host ? path.slice(anchor.length) : path).split('/'); let target: string | undefined;
    for (let depth = parts.length; depth >= 0; depth--) {
      const candidate = resolve(anchor, ...parts.slice(0, depth));
      try { target = resolve(await realpath(candidate), ...parts.slice(depth)); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const exists = await lstat(candidate).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; });
        if (exists) throw new Error('文件路径包含失效的符号链接');
      }
    }
    if (!target) throw new Error('文件路径无效');
    const { excluded } = await this.boundary!;
    await this.allowed(root, target, resolve(root, path), host, excluded);
    return { root, target, path, workspaceVersion: await this.workspaceVersion() };
  }
  async writeContents(value: unknown, contents: string, expected: { target: string; workspaceVersion: string }) {
    const prepared = await this.writeTarget(value);
    if (prepared.target !== expected.target || prepared.workspaceVersion !== expected.workspaceVersion) throw new Error('文件所属工作区或路径已改变，请重新读取');
    await mkdir(dirname(prepared.target), { recursive: true });
    const before = await this.writeTarget(value);
    if (before.target !== expected.target || before.workspaceVersion !== expected.workspaceVersion) throw new Error('文件所属工作区或路径已改变，请重新读取');
    const handle = await open(prepared.target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o666);
    try {
      const info = await handle.stat(), current = await lstat(prepared.target), check = await this.writeTarget(value);
      if (!info.isFile() || current.dev !== info.dev || current.ino !== info.ino || check.target !== expected.target || check.workspaceVersion !== expected.workspaceVersion || await realpath(prepared.target) !== prepared.target) throw new Error('文件路径已改变，请重新读取');
      await handle.truncate(0); await handle.writeFile(contents, 'utf8'); await handle.sync();
      const after = await lstat(prepared.target);
      if (after.dev !== info.dev || after.ino !== info.ino || await this.workspaceVersion() !== expected.workspaceVersion) throw new Error('保存期间文件路径发生变化，请重新核对');
    } finally { await handle.close(); }
    return this.preview(prepared.path);
  }
  async open(value: unknown) {
    const path = this.reference(value), { root, target } = await this.checked(path), before = await lstat(target);
    if (!before.isFile()) throw new Error('请选择普通文件');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(), current = await lstat(target);
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || current.dev !== info.dev || current.ino !== info.ino || before.dev !== info.dev || before.ino !== info.ino || await realpath(target) !== target || await realpath(this.cwd) !== root) throw new Error('文件路径已改变，请重新选择');
      return { handle, info, path, target, name: path.split('/').at(-1)!, mimeType: taskFileMimeType(path) };
    } catch (error) { await handle.close(); throw error; }
  }
  async document(value: unknown) {
    const path = this.reference(value, true), { root, target } = await this.checked(path), info = await lstat(target);
    if (!info.isDirectory()) return this.preview(path);
    const current = await lstat(target), workspaceVersion = await this.workspaceVersion();
    if (!current.isDirectory() || current.dev !== info.dev || current.ino !== info.ino || await realpath(target) !== target || await realpath(this.cwd) !== root) throw new Error('文件路径已改变，请重新选择');
    return { path, kind: 'directory', language: 'text', mimeType: 'inode/directory', sizeBytes: info.size, version: createHash('sha256').update([info.dev, info.ino, info.mtimeMs, info.ctimeMs].join(':')).digest('hex'), truncated: false, workspaceVersion, writeSupported: false };
  }
  async preview(value: unknown) {
    const file = await this.open(value);
    try {
      let kind = taskFilePreviewKind(file.path); const textual = ['text', 'markdown', 'html', 'table'].includes(kind);
      const bytes = Buffer.alloc(textual ? Math.min(file.info.size, 1024 * 1024) : 0); let length = 0;
      while (length < bytes.length) { const result = await file.handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead; }
      const raw = bytes.subarray(0, length); let contents: string | undefined;
      if (textual) {
        try { if (raw.includes(0)) throw new Error('binary'); contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: file.info.size > length }); }
        catch { kind = 'unsupported'; }
      }
      const after = await file.handle.stat();
      if (after.size !== file.info.size || after.mtimeMs !== file.info.mtimeMs || after.ctimeMs !== file.info.ctimeMs) throw new Error('读取期间文件已改变，请重新加载');
      const version = createHash('sha256').update(raw).update([file.info.dev, file.info.ino, file.info.size, file.info.mtimeMs, file.info.ctimeMs].join(':')).digest('hex');
      return { path: file.path, kind, language: taskFileLanguage(file.path), mimeType: file.mimeType, sizeBytes: file.info.size, version, workspaceVersion: await this.workspaceVersion(), writeSupported: true, truncated: textual && length < file.info.size, ...(contents === undefined ? {} : { contents }) };
    } finally { await file.handle.close(); }
  }
  async list(value: unknown = '') {
    const path = this.reference(value, true); const { target } = await this.checked(path);
    const entries = (await readdir(target, { withFileTypes: true })).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)); const result: TaskFileEntry[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const child = path ? (path === '/' ? '/' : path + '/') + entry.name : entry.name;
      try {
        this.reference(child); const { target: resolved } = await this.checked(child); const info = await lstat(resolved);
        if (!info.isDirectory() && !info.isFile()) continue;
        result.push({ path: child, name: entry.name, kind: info.isDirectory() ? 'directory' : 'file' });
      } catch { continue; }
    }
    // T3 lists all immediate children; host search cannot recover a truncated
    // folder because it deliberately never indexes the host tree recursively.
    for (let offset = 0; offset < result.length; offset += 1000) {
      const batch = result.slice(offset, offset + 1000);
      const ignored = await taskGit(target, ['check-ignore', '-z', '--stdin'], { input: batch.map(entry => entry.name).join('\0') + '\0', allowFailure: true, timeout: 10000, limit: 16 * 1024 * 1024 }).catch(() => undefined);
      if (!ignored || ![0, 1].includes(ignored.code)) break;
      const paths = new Set(ignored.stdout.split('\0')); for (const entry of batch) if (paths.has(entry.name)) entry.ignored = true;
    }
    return { path, entries: result, truncated: false };
  }
  async search(query: string) {
    if (query.length > 300 || /[\x00-\x1f\x7f]/.test(query)) throw new Error('文件搜索条件无效');
    const { root } = await this.checked(''); const { excluded } = await this.boundary!; const catalog = await taskFileCatalog(root, excluded);
    const candidates = catalog.entries.flatMap(entry => { const score = contextFileScore(entry.path, query); return score === undefined ? [] : [{ entry, score }]; }).sort((a, b) => a.score - b.score || Number(b.entry.kind === 'directory') - Number(a.entry.kind === 'directory') || a.entry.path.localeCompare(b.entry.path));
    const entries: TaskFileEntry[] = [];
    for (const { entry } of candidates) {
      try { const { target } = await this.checked(entry.path); const info = await lstat(target); if (info.isFile() || info.isDirectory()) entries.push({ ...entry, kind: info.isDirectory() ? 'directory' : 'file' }); } catch { continue; }
      if (entries.length === 100) break;
    }
    return { entries, truncated: catalog.truncated || candidates.length > entries.length };
  }
  async read(value: unknown, lineStart?: unknown, lineEnd?: unknown) {
    const path = this.reference(value); const { target, root } = await this.checked(path);
    if ((lineStart !== undefined || lineEnd !== undefined) && (!Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd) || Number(lineStart) < 1 || Number(lineEnd) < Number(lineStart) || Number(lineEnd) - Number(lineStart) > 5000)) throw new Error('代码引用行范围无效');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(); if (!info.isFile()) throw new Error('请选择普通文本文件');
      if (await realpath(target) !== target || await realpath(this.cwd) !== root) throw new Error('文件路径已改变，请重新选择');
      const current = await lstat(target); if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('文件已改变，请重新选择');
      const bytes = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024)); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0); const raw = bytes.subarray(0, bytesRead);
      if (raw.includes(0)) throw new Error('二进制文件不能用作文本引用');
      let contents: string; try { contents = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: info.size > raw.length }); } catch { throw new Error('这个文件不是 UTF-8 文本，无法创建文本引用'); }
      const lines = contents.replace(/\r\n/g, '\n').split('\n'); const start = lineStart === undefined ? 1 : Number(lineStart); const requestedEnd = lineEnd === undefined ? lines.length : Number(lineEnd);
      if (start > lines.length || lineEnd !== undefined && requestedEnd > lines.length) throw new Error('引用行超出已读取文件，请重新选择');
      const selected = lines.slice(start - 1, requestedEnd).join('\n'); const text = selected.slice(0, maxText).replace(/[\uD800-\uDBFF]$/, '');
      const after = await handle.stat(); if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('读取期间文件已改变，请重新选择');
      const version = createHash('sha256').update(raw).update(String(info.size)).digest('hex');
      return { path, text, lineStart: start, lineEnd: start + text.split('\n').length - 1, byteLength: Buffer.byteLength(text), truncated: selected.length > maxText || info.size > raw.length, sizeBytes: info.size, version };
    } finally { await handle.close(); }
  }
}
