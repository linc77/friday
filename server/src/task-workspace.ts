import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readGitContext } from './git-context.js';
import type { TaskWorkspacePlan, TaskWorkspaceSelection } from './types.js';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return runGit(cwd, args);
}
async function runGit(cwd: string, args: string[], signal?: AbortSignal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], {
    env: { ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal,
  })).stdout.trim();
}

export function workspaceSelection(value: unknown): TaskWorkspaceSelection | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('执行位置无效');
  const { mode, branch } = value as Record<string, unknown>;
  if (mode !== 'checkout' && mode !== 'worktree') throw new Error('执行位置无效');
  if (branch !== undefined && (typeof branch !== 'string' || !branch || branch.length > 1024 || /[\x00-\x20]/.test(branch))) throw new Error('分支无效');
  return { mode, ...(branch === undefined ? {} : { branch: branch as string }) };
}

export async function workspaceOptions(path: string) {
  const context = await readGitContext(path);
  if (context.status !== 'repository') return { git: context, branches: [], hasCommit: false };
  const rows = await git(path, 'for-each-ref', '--sort=refname', '--format=%(refname)%09%(symref)', 'refs/heads/', 'refs/remotes/');
  const branches = rows.split('\n').filter(Boolean).flatMap(row => {
    const [ref, symbolic] = row.split('\t');
    if (symbolic) return [];
    const remote = ref.startsWith('refs/remotes/');
    return [{ ref, name: ref.replace(/^refs\/(heads|remotes)\//, ''), remote }];
  });
  let hasCommit = true;
  try { await git(path, 'rev-parse', '--verify', 'HEAD^{commit}'); } catch { hasCommit = false; }
  return { git: context, branches, hasCommit };
}

// Resolve and persist the exact destination before any checkout/worktree mutation.
export async function planWorkspace(selection: TaskWorkspaceSelection, sourcePath: string, directory: string, id: string): Promise<TaskWorkspacePlan> {
  const options = await workspaceOptions(sourcePath);
  if (options.git.status !== 'repository') {
    if (options.git.status === 'unavailable') throw new Error('无法读取 Workspace 的 Git 信息');
    if (selection.mode !== 'checkout' || selection.branch) throw new Error('非 Git 工作区只能在当前目录执行');
    return { mode: 'checkout', sourcePath, root: sourcePath, cwd: sourcePath, branch: null, commit: null, state: 'ready' };
  }
  const branch = selection.branch ?? (options.git.branch ? `refs/heads/${options.git.branch}` : null);
  if (selection.branch && !options.branches.some(item => item.ref === branch)
      && branch !== `refs/heads/${options.git.branch}`) throw new Error('所选分支已不存在，请刷新后重试');
  if (selection.mode === 'checkout' && branch?.startsWith('refs/remotes/')) throw new Error('远程分支请选择 New Worktree');
  let commit: string | null = null;
  if (options.hasCommit) commit = await git(sourcePath, 'rev-parse', '--verify', '--end-of-options', `${branch ?? 'HEAD'}^{commit}`);
  if (selection.mode === 'worktree' && !commit) throw new Error('仓库需要至少一个提交才能创建 Worktree');
  const root = await realpath(await git(sourcePath, 'rev-parse', '--show-toplevel'));
  const destination = selection.mode === 'worktree' ? resolve(directory, 'worktrees', id) : root;
  return { mode: selection.mode, sourcePath, root: destination, cwd: join(destination, relative(root, await realpath(sourcePath))),
    branch, commit, ...(selection.mode === 'worktree' ? { targetBranch: `linc/task-${id}` } : {}), state: 'pending' };
}

// Called inside the existing Durable execution lane, after its external-started
// memo. An uncertain operation is inspected on explicit continuation, never replayed.
export async function prepareWorkspace(plan: TaskWorkspacePlan, started: () => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (plan.state === 'ready') return;
  const context = await readGitContext(plan.mode === 'worktree' ? plan.root : plan.sourcePath);
  const matches = context.status === 'repository' && (plan.mode === 'worktree'
    ? context.isWorktree && context.branch === plan.targetBranch
    : plan.branch ? `refs/heads/${context.branch}` === plan.branch : context.branch === null && (await git(plan.sourcePath, 'rev-parse', 'HEAD')) === plan.commit);
  if (plan.state === 'preparing') {
    if (!matches) throw new Error('工作区准备曾中断，请检查 Git 状态后重新创建任务；不会自动重复切换或创建 Worktree。');
    if (plan.mode === 'worktree') {
      const common = async (cwd: string) => realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
      if (await common(plan.root) !== await common(plan.sourcePath)) throw new Error('Worktree 与原仓库不匹配');
      if (await git(plan.root, 'rev-parse', 'HEAD') !== plan.commit) throw new Error('Worktree 提交已改变，请检查后重新创建任务');
    }
  } else if (plan.mode === 'worktree') {
    await mkdir(dirname(plan.root), { recursive: true, mode: 0o700 });
    signal?.throwIfAborted();
    await started();
    await runGit(plan.sourcePath, ['worktree', 'add', '-b', plan.targetBranch!, plan.root, plan.commit!], signal);
  } else if (!matches) {
    if ((await git(plan.sourcePath, 'status', '--porcelain')).length) throw new Error('当前工作区有未提交改动，请先处理改动，或选择 New Worktree。');
    signal?.throwIfAborted();
    await started();
    if (plan.branch) await runGit(plan.sourcePath, ['switch', '--no-guess', '--', plan.branch.slice('refs/heads/'.length)], signal);
    else await runGit(plan.sourcePath, ['switch', '--detach', plan.commit!], signal);
  }
  signal?.throwIfAborted();
  if (!(await stat(plan.cwd)).isDirectory()) throw new Error('所选分支中不存在 Workspace 子目录');
}
