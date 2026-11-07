import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { taskGit, type GitProcessOptions } from './git-process.js';
import { parseSnapshotChanges, workspaceRelativePath, workspacePathspecs, type TaskFileDiff } from './task-changes.js';
import { canonicalWorkspacePath, privateWorkspacePaths } from './workspace-privacy.js';
import type { TaskCheckpoint, TaskRunFile, WorkItem } from './types.js';
import { managedWorktreeLocation, recreateManagedWorktree } from './managed-worktree.js';

type Ready = Extract<TaskCheckpoint, { status: 'ready' }>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const oid = (text: string) => { const value = text.trim(); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error('Git 没有返回有效的检查点'); return value; };
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
const alternate = (path: string) => path.includes(delimiter) || /["\\\n\r]/.test(path) ? JSON.stringify(path) : path;

// Source snapshots live in a private bare object store. Captures use their own
// index and never add a commit/ref or alter the user's index in the source repo.
export class TaskCheckpoints {
  constructor(private readonly directory: string) {}
  private store(repository: string) {
    if (!/^[a-f0-9]{64}$/.test(repository)) throw new Error('检查点仓库无效');
    return join(this.directory, 'checkpoints', repository);
  }
  private git(store: string, args: string[], options: GitProcessOptions = {}) {
    return taskGit(store, ['--git-dir=' + store, ...args], { timeout: 60_000, limit: 16 * 1024 * 1024, ...options });
  }
  private async checked(value: Ready) {
    const store = this.store(value.repository);
    if (!/^[a-f0-9]{64}$/.test(value.key) || value.ref !== 'refs/friday/' + value.key) throw new Error('检查点引用无效');
    const saved = JSON.parse(await readFile(join(store, 'records', value.key + '.json'), 'utf8')) as Ready;
    if (JSON.stringify(saved) !== JSON.stringify(value)) throw new Error('检查点记录已经改变');
    const actual = oid((await this.git(store, ['rev-parse', '--verify', value.ref])).stdout);
    if (actual !== value.commit || oid((await this.git(store, ['rev-parse', value.commit + '^{tree}'])).stdout) !== value.tree) throw new Error('检查点内容已经改变');
    return store;
  }

  async saved(workID: string, runID: string, phase: 'before' | 'after', boundary: TaskCheckpoint): Promise<Ready | null> {
    if (boundary.status !== 'ready') return null;
    const key = hash(workID + '\0' + runID + '\0' + phase);
    const file = join(this.store(boundary.repository), 'records', key + '.json');
    if (!(await exists(file))) return null;
    const value = JSON.parse(await readFile(file, 'utf8')) as Ready;
    if (value.key !== key || value.repository !== boundary.repository || value.cwd !== boundary.cwd || value.root !== boundary.root) throw new Error('已有检查点不属于这轮执行');
    await this.checked(value); return value;
  }

  async restore(work: WorkItem, checkpoint: TaskCheckpoint, signal?: AbortSignal) {
    if (checkpoint.status !== 'ready' || checkpoint.prefix) throw new Error('这个检查点不能恢复整个 Worktree');
    const location = await managedWorktreeLocation(work, this.directory); const cwd = location.root;
    const plan = work.executionWorkspace;
    if (plan?.mode !== 'worktree' || plan.state !== 'ready' || checkpoint.cwd !== cwd || checkpoint.root !== cwd) throw new Error('文件恢复需要独占的 Worktree 根目录');
    const excluded = location.missing ? [] : await privateWorkspacePaths(work.cwd, { directory: this.directory, workspace: plan });
    if (excluded.includes('')) throw new Error('Worktree 关联已经改变，不能恢复文件');
    const store = await this.checked(checkpoint); const temporary = await mkdtemp(join(store, 'restore-'));
    const specs = workspacePathspecs(excluded);
    const git = (args: string[], options: GitProcessOptions = {}) => taskGit(cwd, args, { signal, timeout: 60_000, limit: 16 * 1024 * 1024, ...options });
    try {
      await recreateManagedWorktree(work, location);
      const pack = join(temporary, 'tree.pack');
      // Import source trees only, never Friday's private checkpoint commit,
      // transcript metadata or refs into the user's repository.
      await this.git(store, ['pack-objects', '--stdout', '--revs'], { input: checkpoint.tree + '\n', stdoutPath: pack, signal });
      await git(['index-pack', '--stdin', '--fix-thin'], { inputPath: pack });
      const tracked = (await git(['ls-files', '--cached', '--with-tree=' + checkpoint.tree, '-z', '--', ...specs])).stdout;
      if (tracked) await git(['restore', '--source=' + checkpoint.tree, '--worktree', '--staged', '--', ...specs]);
      await mkdir(cwd, { recursive: true });
      await git(['clean', '-fd', '--', ...specs]);
      await mkdir(cwd, { recursive: true });
      if ((await git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true })).code === 0) await git(['reset', '--quiet', '--', ...specs]);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async capture(work: WorkItem, runID: string, phase: 'before' | 'after', signal?: AbortSignal): Promise<TaskCheckpoint> {
    const at = new Date().toISOString();
    if (work.projectId === null) return { status: 'not_repository', cwd: work.cwd, at };
    let temporary: string | undefined;
    try {
      signal?.throwIfAborted();
      const cwd = await canonicalWorkspacePath(resolve(work.cwd));
      const previousBoundary = work.runs?.find(run => run.id === runID)?.before;
      const missingScope = !(await exists(cwd));
      const gitCwd = missingScope && phase === 'after' && previousBoundary?.status === 'ready' && previousBoundary.cwd === cwd ? previousBoundary.root : cwd;
      const excluded = await privateWorkspacePaths(work.cwd, { directory: this.directory, workspace: work.executionWorkspace });
      if (excluded.includes('')) return { status: 'unavailable', cwd, at, error: 'Friday 内部数据目录不保存项目检查点' };
      const top = await taskGit(gitCwd, ['rev-parse', '--show-toplevel'], { signal, allowFailure: true });
      if (top.code !== 0) {
        if (/not a git repository/.test(top.stderr)) return { status: 'not_repository', cwd, at };
        throw new Error(top.stderr || '无法读取 Git 仓库');
      }
      const root = await realpath(top.stdout.trim());
      if (missingScope && previousBoundary?.status === 'ready' && root !== previousBoundary.root) throw new Error('执行前后的仓库不同');
      const common = await realpath((await taskGit(gitCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { signal })).stdout.trim());
      const format = (await taskGit(gitCwd, ['rev-parse', '--show-object-format'], { signal })).stdout.trim();
      if (format !== 'sha1' && format !== 'sha256') throw new Error('不支持这个 Git 对象格式');
      const prefix = relative(root, cwd).split(sep).join('/');
      const repository = hash(common + '\0' + format + '\0' + prefix);
      const key = hash(work.id + '\0' + runID + '\0' + phase);
      const store = this.store(repository); const records = join(store, 'records');
      await mkdir(records, { recursive: true, mode: 0o700 });
      const record = join(records, key + '.json');
      if (await exists(record)) {
        const saved = JSON.parse(await readFile(record, 'utf8')) as Ready;
        if (saved.cwd !== cwd || saved.repository !== repository || saved.key !== key) throw new Error('已有检查点不属于这个工作区');
        await this.checked(saved); return saved;
      }
      if (!(await exists(join(store, 'HEAD')))) await taskGit(store, ['init', '--bare', '-q', '--object-format=' + format, store], { signal });
      temporary = await mkdtemp(join(store, 'capture-'));
      const index = join(temporary, 'index');
      const env = { GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: join(store, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate(join(common, 'objects')), GIT_NO_REPLACE_OBJECTS: '1' };
      const git = (args: string[], options: GitProcessOptions = {}) => taskGit(root, ['-c', 'core.splitIndex=false', '-c', 'sparse.expectFilesOutsideOfPatterns=false', ...args], { env, signal, timeout: 60_000, limit: 16 * 1024 * 1024, ...options });
      const headResult = await git(['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
      const head = headResult.code === 0 ? oid(headResult.stdout) : null;
      const sparse = (await git(['config', '--bool', 'core.sparseCheckout'], { allowFailure: true })).stdout.trim() === 'true';
      if (head) {
        try {
          const sourceIndex = (await taskGit(gitCwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], { signal })).stdout.trim();
          const indexTime = Math.floor(((await lstat(sourceIndex)).mtimeMs - 1) / 1000);
          await copyFile(sourceIndex, index); await git(['read-tree', '--reset', 'HEAD']);
          await utimes(index, indexTime, indexTime);
        } catch {
          if (sparse && (await git(['config', '--bool', 'core.sparseCheckoutCone'], { allowFailure: true })).stdout.trim() !== 'true') throw new Error('无法安全重建 non-cone Sparse Checkout 的检查点');
          await rm(index, { force: true });
          await git([...(sparse ? ['-c', 'index.sparse=true'] : []), 'read-tree', '--reset', 'HEAD']);
        }
      } else await git(['read-tree', '--empty']);
      // Clear manual stat-cache flags without turning sparse absent files into
      // false deletions. The real index and its split-index files stay untouched.
      const flagged = (await git(['ls-files', '-v', '-z'])).stdout.split('\0').filter(Boolean);
      const assumed = flagged.filter(value => /^[a-z]/.test(value)).map(value => value.slice(2));
      if (assumed.length) await git(['update-index', '--no-assume-unchanged', '-z', '--stdin'], { input: assumed.join('\0') + '\0' });
      const skipped = flagged.filter(value => value[0]?.toUpperCase() === 'S' && !value.endsWith('/')).map(value => value.slice(2));
      let clearSkipped = skipped;
      if (sparse && skipped.length) {
        const selected = (await git(['sparse-checkout', 'check-rules', '-z'], { input: skipped.join('\0') + '\0' })).stdout.split('\0').filter(Boolean);
        const present = (await Promise.all(skipped.map(async path => await exists(join(root, path)) ? path : null))).filter((value): value is string => value !== null);
        clearSkipped = [...new Set([...selected, ...present])];
      }
      if (clearSkipped.length) await git(['update-index', '--no-skip-worktree', '-z', '--stdin'], { input: clearSkipped.join('\0') + '\0' });
      const scope = prefix ? ':(literal)' + prefix : '.';
      const excludePaths = excluded.map(path => prefix ? prefix + '/' + path : path);
      const specs = [scope, ...workspacePathspecs(excludePaths).slice(1)];
      const stage = async () => {
        if (missingScope && !(await git(['ls-files', '-z', '--', ...specs])).stdout) return;
        await git(['add', ...(sparse ? ['--sparse'] : []), '-A', '--', ...specs]);
      };
      try { await stage(); }
      catch (original) {
        const candidates = (await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...specs])).stdout.split('\0').filter(path => path.endsWith('/'));
        let found = false;
        for (const candidate of candidates.slice(0, 100)) {
          const path = join(root, candidate);
          if (await exists(join(path, '.git')) && (await taskGit(path, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true, signal })).code !== 0) {
            specs.push(':(exclude,literal)' + candidate.replace(/\/$/, '')); found = true;
          }
        }
        if (!found) throw original;
        await stage();
      }
      // Newly staged ignored files are tracked source, even though read-tree
      // reset the temporary index back to HEAD before capturing worktree bytes.
      const tracked = (await taskGit(root, ['ls-files', '--cached', '-z', '--', ...specs], { signal, limit: 16 * 1024 * 1024 })).stdout.split('\0').filter(Boolean);
      for (let offset = 0; offset < tracked.length; offset += 64) {
        const present = (await Promise.all(tracked.slice(offset, offset + 64).map(async path => await exists(join(root, path)) ? path : null))).filter((value): value is string => value !== null);
        if (present.length) await git(['--literal-pathspecs', 'add', ...(sparse ? ['--sparse'] : []), '-f', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: present.join('\0') + '\0' });
      }
      if (excludePaths.length) {
        const privateFiles = (await git(['ls-files', '-z', '--', ...excludePaths.map(path => ':(literal)' + path)])).stdout;
        if (privateFiles) await git(['update-index', '--force-remove', '-z', '--stdin'], { input: privateFiles });
      }
      let tree: string;
      if (prefix) {
        const files = (await git(['ls-files', '-z', '--', scope])).stdout;
        tree = files ? oid((await git(['write-tree', '--prefix=' + prefix + '/'])).stdout) : oid((await git(['mktree'], { input: '' })).stdout);
      } else tree = oid((await git(['write-tree'])).stdout);
      // Materialize the full reachable tree in private storage. Source Git GC
      // and later branch changes cannot invalidate an old turn's Diff.
      const pack = join(temporary, 'snapshot.pack');
      const previous = await this.git(store, ['rev-parse', '--verify', 'refs/friday/latest'], { allowFailure: true, signal });
      await git(['pack-objects', '--stdout', '--revs'], { input: tree + '\n' + (previous.code === 0 ? '^' + oid(previous.stdout) + '\n' : ''), stdoutPath: pack });
      await this.git(store, ['index-pack', '--stdin', '--fix-thin'], { inputPath: pack, signal });
      const commit = oid((await this.git(store, ['-c', 'user.name=Friday', '-c', 'user.email=friday@localhost', '-c', 'commit.gpgsign=false', 'commit-tree', tree], { input: 'Friday workspace checkpoint\n', signal })).stdout);
      const ref = 'refs/friday/' + key;
      await this.git(store, ['update-ref', ref, commit], { signal });
      const value: Ready = { status: 'ready', repository, key, cwd, root, prefix, tree, commit, ref, head, at, excluded };
      const file = join(temporary, 'record.json'); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); await rename(file, record);
      await this.git(store, ['update-ref', 'refs/friday/latest', commit], { signal });
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      return { status: 'unavailable', cwd: work.cwd, at, error: error instanceof Error ? error.message : '无法保存检查点' };
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }

  private async authored(before: Ready, after: Ready, store: string) {
    if (!before.head || !after.head || before.head === after.head) return null;
    const env = { GIT_OBJECT_DIRECTORY: join(store, 'objects'), GIT_ALTERNATE_OBJECT_DIRECTORIES: alternate((await taskGit(before.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim() + '/objects'), GIT_NO_REPLACE_OBJECTS: '1' };
    const git = (args: string[]) => taskGit(before.root, args, { env, limit: 16 * 1024 * 1024 });
    const scopedHead = async (head: string) => {
      if (!before.prefix) return head + '^{tree}';
      const result = await taskGit(before.root, ['rev-parse', '--verify', head + ':' + before.prefix], { env, allowFailure: true });
      return result.code === 0 ? oid(result.stdout) : oid((await this.git(store, ['mktree'], { input: '' })).stdout);
    };
    const [start, end] = await Promise.all([scopedHead(before.head), scopedHead(after.head)]);
    const dirty = await Promise.all([[start, before.tree], [end, after.tree]].map(async pair => (await git(['diff', ...pair, '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'])).stdout.split('\0').filter(Boolean)));
    const commits = await Promise.all([
      [after.head + '..' + before.head], ['--since=@' + Math.floor(Date.parse(before.at) / 1000), before.head + '..' + after.head],
    ].map(async range => (await git(['log', '--format=', '--diff-merges=remerge', ...range, '--name-only', '-z', '--no-renames', '--no-ext-diff', '--', before.prefix ? ':(literal)' + before.prefix : '.'])).stdout.split('\0').filter(Boolean).flatMap(path => before.prefix ? path.startsWith(before.prefix + '/') ? [path.slice(before.prefix.length + 1)] : [] : [path])));
    return new Set([...dirty.flat(), ...commits.flat()]);
  }

  async changes(before: TaskCheckpoint, after: TaskCheckpoint): Promise<TaskRunFile[]> {
    if (before.status !== 'ready' || after.status !== 'ready') throw new Error('这轮执行没有完整的文件检查点');
    if (before.repository !== after.repository || before.cwd !== after.cwd) throw new Error('执行前后的工作区不同');
    const store = await this.checked(before); await this.checked(after);
    const common = ['--no-ext-diff', '--no-textconv', '--find-renames', before.tree, after.tree];
    const [names, stats, authored] = await Promise.all([
      this.git(store, ['diff', '--name-status', '-z', ...common]), this.git(store, ['diff', '--numstat', '-z', ...common]), this.authored(before, after, store),
    ]);
    return parseSnapshotChanges(names.stdout, stats.stdout).filter(file => !authored || authored.has(file.path) || !!file.oldPath && authored.has(file.oldPath));
  }

  async diff(before: TaskCheckpoint, after: TaskCheckpoint, files: TaskRunFile[], path: string): Promise<TaskFileDiff> {
    workspaceRelativePath(path);
    if (before.status !== 'ready' || after.status !== 'ready' || before.repository !== after.repository || before.cwd !== after.cwd) throw new Error('这轮执行没有完整的文件检查点');
    const file = files.find(file => file.path === path); if (!file) throw new Error('这个文件不在这轮执行的净改动中');
    const store = await this.checked(before); await this.checked(after);
    const output = join(store, 'diff-' + randomUUID());
    try {
      await this.git(store, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/', before.tree, after.tree, '--', ...(file.oldPath ? [file.oldPath] : []), path], { stdoutPath: output });
      const handle = await open(output, 'r');
      try {
        const size = (await handle.stat()).size; const bytes = Buffer.alloc(Math.min(size, 512 * 1024));
        await handle.read(bytes, 0, bytes.length, 0);
        return { path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), scope: 'all', patch: bytes.toString('utf8'), binary: file.binary, truncated: size > bytes.length };
      } finally { await handle.close(); }
    } finally { await rm(output, { force: true }); }
  }
}
