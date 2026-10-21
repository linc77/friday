import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import type { Engine } from './engine.js';
import type { TaskBranchChange, TaskWorkspacePlan, Workspace } from './types.js';
import { runningFork, activeGitOperation, activeRewind, activeStatuses } from './types.js';
import { hasRunningBackgroundCommands } from './task-background-commands.js';
import { prepareWorkspace } from './task-workspace.js';
import { queueRunning } from './task-queue.js';

export const switchingBranch = (change?: TaskBranchChange) => change?.status === 'queued' || change?.status === 'running';
function canonicalDirectory(path: string) {
  let current = resolve(path); const suffix: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...suffix.reverse()); }
    catch {
      const parent = dirname(current); if (parent === current) return resolve(path);
      suffix.push(basename(current)); current = parent;
    }
  }
}
export function containsDirectory(root: string, cwd: string) {
  const path = relative(canonicalDirectory(root), canonicalDirectory(cwd));
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path);
}
export const directoriesOverlap = (left: string, right: string) => containsDirectory(left, right) || containsDirectory(right, left);
export function branchBlocksTask(state: Workspace, cwd: string,ignoreProjectOperation?:string) {
  return state.projectRepositoryOperations?.some(operation=>operation.id!==ignoreProjectOperation&&['queued','running'].includes(operation.status)&&directoriesOverlap(operation.cwd,cwd))===true || state.changeRequestCheckouts?.some(p => ['queued', 'running'].includes(p.status) && directoriesOverlap(p.root, cwd)) === true || state.tasks.some(task => (switchingBranch(task.branchChange) && containsDirectory(task.branchChange!.root, cwd))
    || (runningFork(task.forkOperation) && directoriesOverlap(task.cwd, cwd))
    || (activeGitOperation(task.gitOperation) && directoriesOverlap(task.gitOperation!.root, cwd))
    || (activeRewind(task.rewindOperation) && directoriesOverlap(task.rewindOperation!.cwd, cwd))
    || (activeStatuses.includes(task.status) && task.executionWorkspace?.mode === 'checkout' && task.executionWorkspace.state !== 'ready' && containsDirectory(task.executionWorkspace.root, cwd)));
}
export function assertCheckoutIdle(state: Workspace, root: string) {
  if (state.tasks.some(task => directoriesOverlap(root, task.cwd) && (activeStatuses.includes(task.status) || queueRunning(task) || task.settleCleanup?.status === 'pending' || hasRunningBackgroundCommands(task) || activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || runningFork(task.forkOperation)))) {
    throw new Error('当前工作区有正在执行或排队的任务，请等待完成后切换分支。');
  }
}

// A branch change is its own Durable task, never an agent turn. Persist intent
// before Git and conservatively interrupt after a crash with an unknown result.
export function defineBranchSwitch(engine: Engine) {
  return defineTask<{ id: string; requestId: string; plan: TaskWorkspacePlan; predecessor: number | null },
    { phase: 'queued' | 'execute' }, { status: string }, {}>({
    name: 'friday.switch_branch', version: 1, initial: () => ({ phase: 'queued' }),
    phases: {
      queued: async (task, runtime, ctx) => {
        await runtime.commit(() => task.input.predecessor === null
          ? { status: 'running', checkpoint: { phase: 'execute' } }
          : { status: 'waiting', checkpoint: { phase: 'execute' }, on: [task.input.predecessor as TaskId], policy: 'allSettled' }, ctx);
      },
      execute: async (task, runtime, ctx) => {
        const finish = async (status: TaskBranchChange['status'], error?: string) => {
          await engine.patchTask(task.input.id, item => {
            if (item.branchChange?.requestId === task.input.requestId) item.branchChange = { ...item.branchChange, status, ...(error ? { error } : {}) };
          });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        if (await runtime.memo<boolean>('git-completed', ctx)) {
          await finish('completed'); return;
        }
        if (await runtime.memo<boolean>('git-started', ctx)) {
          await finish('interrupted', '分支切换曾中断，请核对当前分支；不会自动重复切换。');
          return;
        }
        try {
          const state = await engine.snapshot();
          const work = state.tasks.find(item => item.id === task.input.id);
          if (!work || await realpath(work.cwd) !== task.input.plan.cwd) throw new Error('任务执行目录已改变，请刷新后重试');
          assertCheckoutIdle(state, task.input.plan.root);
          await engine.patchTask(work.id, item => { item.branchChange!.status = 'running'; });
          await prepareWorkspace(task.input.plan, async () => { await runtime.memo('git-started', true, ctx); }, runtime.signal);
          await runtime.memo('git-completed', true, ctx);
          await finish('completed');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await finish('failed', error instanceof Error ? error.message : '切换分支失败');
        }
      },
    },
    abort: async (task, runtime, ctx) => {
      await engine.patchTask(task.input.id, item => {
        if (item.branchChange?.requestId === task.input.requestId) {
          item.branchChange.status = 'interrupted'; item.branchChange.error = '分支切换已中断，请核对当前分支。';
        }
      });
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
    },
  });
}
