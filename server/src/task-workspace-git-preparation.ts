// Preparation behavior follows T3 Code 8cd9641f ThreadLaunchService and
// GitVcsDriverCore. Friday persists receipts in its existing Durable lane.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { gitOutputText, taskGit } from './git-process.js';
import type { TaskWorkspacePlan, WorktreeSubmodules } from './types.js';

export type WorkspacePlanUpdate = (patch: Partial<TaskWorkspacePlan>) => Promise<void>;
const stamp = () => new Date().toISOString();
const detail = (error: unknown) => Buffer.from(gitOutputText(error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 200)).toString('utf8');
async function update(plan: TaskWorkspacePlan, patch: Partial<TaskWorkspacePlan>, persist?: WorkspacePlanUpdate) {
  await persist?.(patch); Object.assign(plan, structuredClone(patch));
}

/** Fetch precedes checkout, and its exact resolved commit is saved before the
 * worktree mutation. An unacknowledged fetch requires an explicit retry. */
export async function fetchWorkspaceBase(plan: TaskWorkspacePlan, persist?: WorkspacePlanUpdate, signal?: AbortSignal) {
  if (plan.mode !== 'worktree' || plan.state !== 'pending' || plan.fetch?.status === 'done' || plan.fetch?.status === 'skipped') return;
  signal?.throwIfAborted();
  if (plan.fetch?.status === 'running' || plan.fetch?.status === 'failed') throw new Error('远端获取曾中断或失败，请明确重试工作区准备');
  const remotes = (await taskGit(plan.sourcePath, ['remote'], { signal })).stdout.trim().split('\n');
  const otherRemote = plan.branch?.startsWith('refs/remotes/') && !plan.branch.startsWith('refs/remotes/origin/');
  const branch = plan.branch?.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/(?:origin\/)?/, '');
  if (plan.startFromOrigin !== true || !remotes.includes('origin') || !branch || branch.startsWith('refs/')) {
    await update(plan, { fetch: { status: 'skipped', completedAt: stamp() } }, persist); return;
  }
  await taskGit(plan.sourcePath, ['check-ref-format', 'refs/heads/' + branch], { signal });
  const startedAt = stamp();
  await update(plan, { fetch: { status: 'running', startedAt } }, persist);
  try {
    const fetch = async (args: string[]) => {
      const options = { signal, timeout: 90_000, allowFailure: true };
      let result = await taskGit(plan.sourcePath, ['-c', 'fetch.recurseSubmodules=false', 'fetch', '--quiet', '--no-tags', '--', 'origin', ...args], options);
      if (result.code !== 0 && /cannot lock ref|unable to create .*\.lock|is at [0-9a-f]+ but expected/i.test(result.stderr)) {
        result = await taskGit(plan.sourcePath, ['-c', 'fetch.recurseSubmodules=false', 'fetch', '--quiet', '--no-tags', '--', 'origin', ...args], options);
      }
      return result;
    };
    let result = await fetch([`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const absent = result.code !== 0 && result.stderr.split(/\r?\n/).includes(`fatal: couldn't find remote ref refs/heads/${branch}`);
    if (absent) result = await fetch([]);
    if (result.code !== 0) throw new Error(result.stderr || 'git fetch origin 失败');
    signal?.throwIfAborted();
    const commit = absent || otherRemote ? plan.commit : (await taskGit(plan.sourcePath, ['rev-parse', '--verify', '--end-of-options', `refs/remotes/origin/${branch}^{commit}`], { signal })).stdout.trim();
    await update(plan, { commit, fetch: { status: 'done', startedAt, completedAt: stamp(), ...(absent ? { detail: 'origin 没有同名分支，使用所选基准提交' } : {}) } }, persist);
  } catch (error) {
    if (!signal?.aborted) await update(plan, { fetch: { status: 'failed', startedAt, completedAt: stamp(), detail: detail(error) } }, persist);
    throw error;
  }
}

async function projectFileSubmodules(root: string): Promise<WorktreeSubmodules> {
  const handle = await open(join(root, 't3.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => undefined);
  if (!handle) return 'recursive';
  try {
    const info = await handle.stat(); if (!info.isFile() || info.size > 256 * 1024) return 'recursive';
    const bytes = Buffer.alloc(256 * 1024 + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 256 * 1024) return 'recursive';
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    return value && ['recursive','top-level','none'].includes(value.worktreeSubmodules) ? value.worktreeSubmodules : 'recursive';
  } catch { return 'recursive'; } finally { await handle.close(); }
}

/** A submodule failure is a warning in T3. Never replay an uncertain command
 * after restart; keep the partial checkout and allow the setup script to repair it. */
export async function prepareWorktreeSubmodules(plan: TaskWorkspacePlan, persist?: WorkspacePlanUpdate, signal?: AbortSignal) {
  if (plan.mode !== 'worktree' && !plan.scriptWorktree || plan.submodules && plan.submodules.status !== 'running') return;
  signal?.throwIfAborted();
  if (plan.submodules?.status === 'running') {
    await update(plan, { submodules: { ...plan.submodules, status: 'warning', completedAt: stamp(), detail: '子模块初始化曾中断，保留现有目录；请在终端核对' } }, persist); return;
  }
  const entry = await lstat(join(plan.root, '.gitmodules')).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  const mode = plan.submoduleMode ?? await projectFileSubmodules(plan.root);
  if (!entry || mode === 'none') {
    await update(plan, { submodules: { mode, status: 'skipped', completedAt: stamp(), ...(entry ? { detail: '已按设置跳过子模块初始化' } : {}) } }, persist); return;
  }
  const startedAt = stamp();
  await update(plan, { submodules: { mode, status: 'running', startedAt } }, persist);
  try {
    if (!entry.isFile()) throw new Error('.gitmodules 不是普通文件');
    await taskGit(plan.root, ['submodule', 'update', '--init', ...(mode === 'recursive' ? ['--recursive'] : [])], { signal, timeout: 5 * 60_000 });
    signal?.throwIfAborted();
    await update(plan, { submodules: { mode, status: 'done', startedAt, completedAt: stamp() } }, persist);
  } catch (error) {
    if (signal?.aborted) throw error;
    await update(plan, { submodules: { mode, status: 'warning', startedAt, completedAt: stamp(), detail: detail(error) } }, persist);
  }
}
