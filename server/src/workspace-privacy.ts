import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { taskGit } from './git-process.js';
import type { TaskWorkspacePlan } from './types.js';
import { verifyScratchWorkspace } from './managed-scratch-workspace.js';
import { verifyManagedProjectFolder, type ManagedProjectFolder } from './managed-project-folders.js';

export type WorkspacePrivacy = string | { directory: string; workspace?: TaskWorkspacePlan; projectFolder?: ManagedProjectFolder };
export async function canonicalWorkspacePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '') || dirname(path) === path) throw error;
    return resolve(await canonicalWorkspacePath(dirname(path)), basename(path));
  }
}
const inside = (root: string, path: string) => {
  const value = relative(root, path);
  return value === '' || !isAbsolute(value) && value !== '..' && !value.startsWith('..' + sep);
};

// A persisted plan is necessary but insufficient: the directory may have been
// replaced since execution. Only a real, linked worktree of the original repo
// can expose source files beneath Friday's otherwise private data directory.
async function managedWorktree(cwd: string, directory: string, plan?: TaskWorkspacePlan) {
  if (plan?.mode !== 'worktree' || plan.state !== 'ready') return false;
  try {
    const root = await realpath(plan.root);
    const expected = resolve(directory, 'worktrees', basename(plan.root));
    if (root !== expected || !inside(root, cwd) || !inside(root, await canonicalWorkspacePath(plan.cwd))) return false;
    if (!(await lstat(resolve(directory, 'worktrees'))).isDirectory() || !(await lstat(plan.root)).isDirectory()) return false;
    if (!(await lstat(resolve(root, '.git'))).isFile()) return false;
    const gitPath = async (path: string, flag: string) => realpath((await taskGit(path, ['rev-parse', '--path-format=absolute', flag])).stdout.trim());
    const [top, common, sourceCommon, admin] = await Promise.all([
      gitPath(root, '--show-toplevel'), gitPath(root, '--git-common-dir'), gitPath(plan.sourcePath, '--git-common-dir'), gitPath(root, '--absolute-git-dir'),
    ]);
    if (inside(directory,common)) {
      if(!plan.projectFolder)return false;
      await verifyManagedProjectFolder(plan.projectFolder,directory);
      if(common!==resolve(plan.projectFolder.root,'.git'))return false;
    }
    if (top !== root || common !== sourceCommon || !inside(resolve(common, 'worktrees'), admin)) return false;
    return await realpath((await readFile(resolve(admin, 'gitdir'), 'utf8')).trim()) === resolve(root, '.git');
  } catch { return false; }
}

async function managedScratch(cwd: string, directory: string, plan?: TaskWorkspacePlan) {
  if (!plan?.scratch || plan.state !== 'ready' || plan.scratch.parent !== resolve(directory, 'scratch') || !inside(plan.root, cwd)) return false;
  try { await verifyScratchWorkspace(plan); return true; } catch { return false; }
}
async function managedProject(cwd: string, directory: string, folder?: ManagedProjectFolder) {
  if(!folder || !inside(folder.root,cwd))return false;
  try { await verifyManagedProjectFolder(folder,directory);return true; } catch { return false; }
}

export async function privateWorkspacePaths(cwd: string, privacy?: WorkspacePrivacy): Promise<string[]> {
  if (!privacy) return [];
  const directory = typeof privacy === 'string' ? privacy : privacy.directory;
  const raw = resolve(directory);
  const canonical = await realpath(directory).catch(() => raw);
  const lexical = resolve(await realpath(dirname(raw)).catch(() => dirname(raw)), basename(raw));
  const protectedPaths = [...new Set([canonical, lexical, raw])];
  const requested = resolve(cwd);
  cwd = await canonicalWorkspacePath(requested);
  if (protectedPaths.some(path => inside(path, cwd) || inside(path, requested))) {
    return typeof privacy !== 'string' && (await managedProject(cwd,canonical,privacy.projectFolder??privacy.workspace?.projectFolder) || await managedScratch(cwd, canonical, privacy.workspace) || await managedWorktree(cwd, canonical, privacy.workspace)) ? [] : [''];
  }
  return [...new Set(protectedPaths.filter(path => inside(cwd, path)).map(path => relative(cwd, path).split(sep).join('/')))];
}
