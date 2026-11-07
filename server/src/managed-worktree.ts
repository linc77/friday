import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { containsDirectory } from './branch-switch.js';
import { taskGit } from './git-process.js';
import { canonicalWorkspacePath, privateWorkspacePaths } from './workspace-privacy.js';
import { readTaskGitStatus } from './task-git-status.js';
import type { WorkItem } from './types.js';
import { verifyManagedProjectFolder } from './managed-project-folders.js';

export type ManagedWorktree = { root: string; admin: string; common: string; missing: boolean };
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

// Cleanup can remove a checkout while its linked-worktree registration and
// branch still exist. Repair only that exact persisted registration, never a
// guessed Git directory, branch, or a different checkout at the same path.
export async function managedWorktreeLocation(work: WorkItem, directory: string): Promise<ManagedWorktree> {
  const plan = work.executionWorkspace;
  if (plan?.mode !== 'worktree' || plan.state !== 'ready') throw new Error('文件恢复需要托管 Worktree');
  const privateRoot = await realpath(directory); const root = await canonicalWorkspacePath(resolve(plan.root));
  if (root !== resolve(privateRoot, 'worktrees', basename(plan.root)) || await canonicalWorkspacePath(resolve(work.cwd)) !== root) throw new Error('文件恢复需要独占的 Worktree 根目录');
  const parent = dirname(root);
  try { if (!(await lstat(parent)).isDirectory() || await realpath(parent) !== parent) throw new Error('Worktree 父目录关联已经改变'); }
  catch (error) { if (!absent(error)) throw error; }
  const common = await realpath((await taskGit(plan.sourcePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
  if (containsDirectory(privateRoot, common)) {
    if(!plan.projectFolder)throw new Error('Worktree 主仓库不能位于 Friday 内部数据中');
    await verifyManagedProjectFolder(plan.projectFolder,directory);
    if(common!==join(plan.projectFolder.root,'.git'))throw new Error('Worktree 主仓库关联已经改变');
  }
  const admins = join(common, 'worktrees');
  if (await realpath(admins) !== admins) throw new Error('Worktree 管理目录关联已经改变');
  let missing = false;
  try { if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) throw new Error('Worktree 路径已被其他文件或链接替代'); }
  catch (error) { if (!absent(error)) throw error; missing = true; }
  let admin: string | undefined;
  if (!missing) {
    if ((await privateWorkspacePaths(work.cwd, { directory, workspace: plan })).includes('')) throw new Error('Worktree 关联已经改变');
    const gitfile = (await readFile(join(root, '.git'), 'utf8')).trim();
    if (!gitfile.startsWith('gitdir: ')) throw new Error('Worktree Git 关联无效');
    admin = await realpath(resolve(root, gitfile.slice(8)));
  } else {
    for (const entry of await readdir(admins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(admins, entry.name); const pointer = (await readFile(join(path, 'gitdir'), 'utf8')).trim();
      if (await canonicalWorkspacePath(resolve(path, pointer)) !== join(root, '.git')) continue;
      if (admin) throw new Error('Worktree 存在多条不明确的管理记录');
      admin = path;
    }
  }
  if (!admin || dirname(admin) !== admins || !(await lstat(admin)).isDirectory() || await realpath(admin) !== admin) throw new Error('原 Worktree 管理记录已不存在，无法安全恢复');
  if (await realpath(resolve(admin, (await readFile(join(admin, 'commondir'), 'utf8')).trim())) !== common) throw new Error('Worktree 与主仓库不匹配');
  if (await canonicalWorkspacePath((await readFile(join(admin, 'gitdir'), 'utf8')).trim()) !== join(root, '.git')) throw new Error('Worktree 管理记录指向另一个目录');
  const records = (await taskGit(plan.sourcePath, ['worktree', 'list', '--porcelain', '-z'])).stdout.split('\0\0');
  let registered = false;
  for (const record of records) {
    const path = record.split('\0').find(line => line.startsWith('worktree '))?.slice(9);
    if (path && await canonicalWorkspacePath(path) === root) registered = true;
  }
  if (!registered) throw new Error('原 Worktree 已从 Git 登记中移除，请保留文件并重新选择工作区');
  return { root, admin, common, missing };
}

export async function readRestoreReview(work: WorkItem, directory: string) {
  const location = await managedWorktreeLocation(work, directory);
  if (!location.missing) return { ...await readTaskGitStatus(work.cwd, { directory, workspace: work.executionWorkspace }), missing: false };
  const source = work.executionWorkspace!.sourcePath;
  const git = (args: string[]) => taskGit(source, ['--git-dir=' + location.admin, '--work-tree=' + location.root, ...args], { allowFailure: true });
  const head = (await git(['rev-parse', '--verify', 'HEAD'])).stdout.trim() || null;
  const branch = (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim() || null;
  const index = await readFile(join(location.admin, 'index')).catch(error => { if (absent(error)) return Buffer.alloc(0); throw error; });
  const fingerprint = createHash('sha256').update(JSON.stringify({ root: location.root, admin: location.admin, missing: true, head, branch })).update(index).digest('hex');
  return { cwd: location.root, fingerprint, head, branch, files: [], missing: true };
}

export async function recreateManagedWorktree(work: WorkItem, location: ManagedWorktree) {
  if (!location.missing) return;
  await mkdir(dirname(location.root), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(location.root)) !== dirname(location.root) || !(await lstat(dirname(location.root))).isDirectory()) throw new Error('Worktree 父目录关联已经改变');
  await mkdir(location.root, { mode: 0o700 }); // EEXIST is a changed workspace, never an overwrite.
  if (await realpath(location.root) !== location.root) throw new Error('Worktree 路径关联已经改变');
  const file = await open(join(location.root, '.git'), 'wx', 0o600);
  try { await file.writeFile('gitdir: ' + location.admin + '\n'); await file.sync(); }
  finally { await file.close(); }
  const current = await managedWorktreeLocation(work, dirname(dirname(location.root)));
  if (current.admin !== location.admin || current.missing) throw new Error('Worktree 重新关联失败');
}
