import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readGitContext } from './git-context.js';
import { prepareScratchWorkspace, retryScratchWorkspace } from './managed-scratch-workspace.js';
import type { TaskWorkspacePlan, TaskWorkspaceSelection, WorkItem } from './types.js';
import { fetchWorkspaceBase, prepareWorktreeSubmodules, type WorkspacePlanUpdate } from './task-workspace-git-preparation.js';

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
  const { mode, branch, preparationId, startFromOrigin, reuseTaskId } = value as Record<string, unknown>;
  if (mode !== 'checkout' && mode !== 'worktree') throw new Error('执行位置无效');
  if (branch !== undefined && (typeof branch !== 'string' || !branch || branch.length > 1024 || /[\x00-\x20]/.test(branch))) throw new Error('分支无效');
  if (preparationId !== undefined && (typeof preparationId !== 'string' || !/^[a-z0-9-]{36}$/i.test(preparationId) || branch !== undefined)) throw new Error('PR／MR 准备目录选择无效');
  if (startFromOrigin !== undefined && (typeof startFromOrigin !== 'boolean' || mode !== 'worktree' || preparationId !== undefined)) throw new Error('远端基准选择无效');
  if (reuseTaskId !== undefined && (typeof reuseTaskId !== 'string' || !/^[a-z0-9_-]{1,200}$/i.test(reuseTaskId) || !branch || preparationId !== undefined || startFromOrigin !== undefined)) throw new Error('已有任务工作区选择无效');
  return { mode, ...(branch === undefined ? {} : { branch: branch as string }), ...(preparationId === undefined ? {} : { preparationId: preparationId as string }), ...(startFromOrigin === undefined ? {} : { startFromOrigin: startFromOrigin as boolean }), ...(reuseTaskId === undefined ? {} : { reuseTaskId: reuseTaskId as string }) };
}

// T3's new-thread-on-branch opens an independent session in the captured
// existing checkout. Resolve a service-owned task rather than trusting a path
// supplied by a client; this path performs no checkout, fetch or setup script.
export async function planExistingTaskWorkspace(selection: TaskWorkspaceSelection, sourcePath: string, task: WorkItem): Promise<TaskWorkspacePlan> {
  if (!selection.reuseTaskId || selection.reuseTaskId !== task.id || task.agent === 'friday' || task.subagentOrigin) throw new Error('原任务工作区不可用');
  const cwd = await realpath(task.cwd), options = await workspaceOptions(cwd);
  if (options.git.status !== 'repository' || !options.git.branch || !options.hasCommit) throw new Error('原任务分支不可用，请刷新后重试');
  const branch = `refs/heads/${options.git.branch}`;
  if (selection.branch !== branch || selection.mode !== (options.git.isWorktree ? 'worktree' : 'checkout')) throw new Error('原任务分支或工作区已经改变，请重新选择');
  const common = async (path: string) => realpath(await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  if (await common(sourcePath) !== await common(cwd)) throw new Error('原任务与 Workspace 仓库不匹配');
  const root = await realpath(await git(cwd, 'rev-parse', '--show-toplevel'));
  const records = (await git(sourcePath, 'worktree', 'list', '--porcelain', '-z')).split('\0\0');
  if (!records.some(record => record.split('\0').includes('worktree ' + root))) throw new Error('原任务工作区已不在仓库登记中');
  const commit = await git(cwd, 'rev-parse', '--verify', 'HEAD^{commit}');
  return { mode: selection.mode, sourcePath, root, cwd, branch, commit, state: 'ready', reuseBranch: true };
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
  if (selection.reuseTaskId) throw new Error('已有任务工作区必须由服务核对');
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
  const destination = selection.mode === 'worktree' ? resolve(await realpath(directory), 'worktrees', id) : root;
  return { mode: selection.mode, sourcePath, root: destination, cwd: join(destination, relative(root, await realpath(sourcePath))),
    branch, commit, ...(selection.mode === 'worktree' ? { targetBranch: `linc/task-${id}`, startFromOrigin: selection.startFromOrigin ?? true, submoduleMode: null } : {}),
    state: selection.mode === 'checkout' && (branch ? branch === `refs/heads/${options.git.branch}` : options.git.branch == null) ? 'ready' : 'pending' };
}

// Called inside the existing Durable execution lane. Persist preparing before
// mutation; inspect that state on recovery instead of blindly repeating it.
export async function prepareWorkspace(plan: TaskWorkspacePlan, started: () => Promise<void>, signal?: AbortSignal, progress?: WorkspacePlanUpdate) {
  signal?.throwIfAborted();
  if (plan.projectFolder) { const {verifyManagedProjectFolder}=await import('./managed-project-folders.js');await verifyManagedProjectFolder(plan.projectFolder); }
  if (plan.scratch) return prepareScratchWorkspace(plan, started, signal, progress);
  if (plan.state === 'ready') return;
  await fetchWorkspaceBase(plan, progress, signal);
  const context = await readGitContext(plan.mode === 'worktree' ? plan.root : plan.sourcePath);
  const matches = context.status === 'repository' && (plan.mode === 'worktree'
    ? context.isWorktree && context.branch === plan.targetBranch
    : plan.branch ? `refs/heads/${context.branch}` === plan.branch : context.branch === null && (await git(plan.sourcePath, 'rev-parse', 'HEAD')) === plan.commit);
  const checkoutStarted = async () => {
    await started();
    const checkout = { status: 'running' as const, startedAt: new Date().toISOString() };
    await progress?.({ checkout }); plan.checkout = checkout;
  };
  if (plan.state === 'preparing') {
    if (!matches) throw new Error('工作区准备曾中断，请核对 Git 状态后重试；不会自动重复切换或创建 Worktree。');
  } else if (plan.mode === 'worktree') {
    await mkdir(dirname(plan.root), { recursive: true, mode: 0o700 });
    const parent = dirname(plan.root);
    if (await realpath(parent) !== join(await realpath(dirname(parent)), basename(parent))) throw new Error('Worktree 父目录关联已经改变，请核对后重试');
    signal?.throwIfAborted();
    await checkoutStarted();
    if (plan.reuseBranch && await git(plan.sourcePath, 'rev-parse', '--verify', '--end-of-options', `refs/heads/${plan.targetBranch}^{commit}`) !== plan.commit) throw new Error('待重用的 Worktree 分支已经改变，请核对后重试');
    await runGit(plan.sourcePath, ['worktree', 'add', ...(plan.reuseBranch ? [plan.root, plan.targetBranch!] : ['-b', plan.targetBranch!, plan.root, plan.commit!])], signal);
  } else if (!matches) {
    if ((await git(plan.sourcePath, 'status', '--porcelain')).length) throw new Error('当前工作区有未提交改动，请先处理改动，或选择 New Worktree。');
    signal?.throwIfAborted();
    await checkoutStarted();
    if (plan.branch) await runGit(plan.sourcePath, ['switch', '--no-guess', '--', plan.branch.slice('refs/heads/'.length)], signal);
    else await runGit(plan.sourcePath, ['switch', '--detach', plan.commit!], signal);
  }
  signal?.throwIfAborted();
  await verifyPreparedWorkspace(plan);
  const checkout = { ...plan.checkout, status: 'done' as const, completedAt: plan.checkout?.completedAt ?? new Date().toISOString() };
  await progress?.({ checkout }); plan.checkout = checkout;
  if (plan.mode === 'worktree') await prepareWorktreeSubmodules(plan, progress, signal);
}

async function verifyPreparedWorkspace(plan: TaskWorkspacePlan) {
  if (plan.mode === 'worktree') {
    const prepared = await readGitContext(plan.root);
    if (prepared.status !== 'repository' || !prepared.isWorktree || prepared.branch !== plan.targetBranch) throw new Error('Worktree 分支关联已经改变，请核对后重试');
    const common = async (cwd: string) => realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    if (await common(plan.root) !== await common(plan.sourcePath)) throw new Error('Worktree 与原仓库不匹配');
    if (await git(plan.root, 'rev-parse', 'HEAD') !== plan.commit) throw new Error('Worktree 提交已改变，请核对后重试');
  }
  if (!(await stat(plan.cwd)).isDirectory()) throw new Error('所选分支中不存在 Workspace 子目录');
}

// Only an explicit retry may authorize another Git attempt. Recovery of that
// attempt still sees `preparing` and performs the read-only check above.
export async function retryWorkspacePlan(saved: TaskWorkspacePlan): Promise<TaskWorkspacePlan> {
  if (saved.scratch) return retryScratchWorkspace(saved);
  const plan = structuredClone(saved);
  if (plan.mode === 'checkout') {
    if ((await readGitContext(plan.sourcePath)).status !== 'repository') throw new Error('无法读取原工作区，请恢复目录后重试');
    if (plan.state !== 'ready') plan.state = 'pending';
    return plan;
  }
  // Resolve legitimate ancestor aliases (for example macOS /var) while still
  // rejecting a replaced worktrees directory or target within the data root.
  const parent = dirname(plan.root);
  const canonicalParent = join(await realpath(dirname(parent)), basename(parent));
  try { if (await realpath(parent) !== canonicalParent) throw new Error('Worktree 父目录关联已经改变，请核对后重试'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const suffix = relative(resolve(plan.root), resolve(plan.cwd));
  plan.root = join(canonicalParent, basename(plan.root)); plan.cwd = join(plan.root, suffix);
  const common = async (cwd: string) => realpath(await git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const originalCommon = await common(plan.sourcePath);
  const records = (await git(plan.sourcePath, 'worktree', 'list', '--porcelain', '-z')).split('\0\0');
  const registered = records.some(record => record.split('\0').includes('worktree ' + resolve(plan.root)));
  let exists = false;
  try {
    const entry = await lstat(plan.root); exists = true;
    if (!entry.isDirectory() || await realpath(plan.root) !== resolve(plan.root)) throw new Error('Worktree 路径已被其他文件或链接替代，请核对后重试');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (registered) {
    if (!exists) throw new Error('已有 Worktree 登记但目录缺失，请恢复目录或移除失效登记后重试');
    if (await common(plan.root) !== originalCommon) throw new Error('Worktree 与原仓库不匹配');
    if (plan.state !== 'ready') {
      plan.state = 'preparing';
      await verifyPreparedWorkspace(plan);
    } else if (!(await stat(plan.cwd)).isDirectory()) throw new Error('所选分支中不存在 Workspace 子目录');
    return plan;
  }
  if (plan.state === 'ready') throw new Error('原 Worktree 登记已经改变，请核对后重试');
  if (exists && (await readdir(plan.root)).length) throw new Error('Worktree 目标目录已有文件，请核对或移开文件后重试');
  const ref = `refs/heads/${plan.targetBranch}`;
  const refs = (await git(plan.sourcePath, 'for-each-ref', '--format=%(refname)%09%(objectname)', ref)).split('\n');
  const commit = refs.find(line => line.startsWith(ref + '\t'))?.slice(ref.length + 1);
  if (commit && commit !== plan.commit) throw new Error('待重用的 Worktree 分支已经改变，请核对后重试');
  if (records.some(record => record.split('\0').includes('branch ' + ref))) throw new Error('Worktree 分支正在另一个目录使用，请先处理后重试');
  plan.state = 'pending'; plan.reuseBranch = !!commit;
  if (plan.fetch?.status === 'running' || plan.fetch?.status === 'failed') delete plan.fetch;
  return plan;
}
