/* Managed scratch folders follow T3 Code 8cd9641f project/ManagedProjectFolders.
 * MIT, Copyright (c) 2026 T3 Tools Inc.; complete license: task-sidebar-order.ts.
 * Provisioning is called only from Friday's existing Pi Durable preparation lane. */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TaskWorkspacePlan } from './types.js';
const exec = promisify(execFile);
export type ScratchAllocation = {
  taskId: string; parent: string; date: string; words: string; attempt: number; suffix?: string;
  phase: 'planned' | 'claiming' | 'claimed'; identity?: { device: string; inode: string };
};
export const scratchFolderWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0,5).join('-').slice(0,48).replace(/-+$/,'');
export function scratchFolderName(allocation: ScratchAllocation): string {
  const id = allocation.taskId.toLowerCase().replace(/[^a-z0-9]/g,'');
  return [allocation.date,allocation.words,allocation.attempt === 1 ? id.slice(-8) : id].filter(Boolean).join('-')+(allocation.suffix?'-'+allocation.suffix:'');
}
export async function availableScratchRoot(directory: string): Promise<string | null> {
  const base = await realpath(directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
  try {
    const result = await exec('git',['-c','core.hooksPath=/dev/null','-C',base,'rev-parse','--is-inside-work-tree'],{env:{...env,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},timeout:1500,maxBuffer:64*1024});
    if (result.stdout.trim() === 'true') return null;
    return join(base,'scratch');
  } catch(error) {
    const value = error as { code?: string; stderr?: string };
    return value.code === 'ENOENT' || value.stderr?.startsWith('fatal: not a git repository') ? join(base,'scratch') : null;
  }
}
export async function ensureScratchRoot(root: string) {
  if (await realpath(dirname(root)) !== dirname(root)) throw new Error('临时工作区的主机目录已改变');
  await mkdir(root,{recursive:true,mode:0o700});
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error('临时工作区目录不能指向其他位置');
}
export function planScratchWorkspace(root: string, taskId: string, text: string, stamp = new Date().toISOString()): TaskWorkspacePlan {
  const scratch: ScratchAllocation = {taskId,parent:root,date:stamp.slice(0,10),words:scratchFolderWords(text),attempt:1,phase:'planned'};
  const cwd = join(root,scratchFolderName(scratch));
  return { mode:'checkout',sourcePath:root,root:cwd,cwd,branch:null,commit:null,state:'pending',scratch };
}
async function ownedIdentity(plan: TaskWorkspacePlan) {
  if (!plan.scratch || plan.cwd !== plan.root || dirname(plan.root) !== plan.scratch.parent || basename(plan.root) !== scratchFolderName(plan.scratch)) throw new Error('临时工作区的目录范围已改变');
  if (await realpath(plan.scratch.parent) !== plan.scratch.parent) throw new Error('临时工作区目录不能指向其他位置');
  const info = await lstat(plan.cwd,{bigint:true});
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(plan.cwd) !== plan.cwd) throw new Error('临时任务目录不能指向其他位置');
  return {device:String(info.dev),inode:String(info.ino)};
}
export async function verifyScratchWorkspace(plan: TaskWorkspacePlan) {
  if (!plan.scratch) return;
  const identity = await ownedIdentity(plan);
  if (plan.scratch.phase !== 'claimed' || !plan.scratch.identity || identity.device !== plan.scratch.identity.device || identity.inode !== plan.scratch.identity.inode) throw new Error('临时任务目录的归属已改变，请恢复原目录或创建新任务');
}
function nextCandidate(plan: TaskWorkspacePlan) {
  const current = plan.scratch!, attempt = current.attempt+1;
  const scratch: ScratchAllocation = {taskId:current.taskId,parent:current.parent,date:current.date,words:current.words,attempt,phase:'planned',...(attempt>2?{suffix:randomUUID().slice(0,8)}:{})};
  const cwd = join(current.parent,scratchFolderName(scratch));
  return {root:cwd,cwd,scratch};
}
export async function prepareScratchWorkspace(plan: TaskWorkspacePlan, started:()=>Promise<void>, signal?:AbortSignal, progress?:(patch:Partial<TaskWorkspacePlan>)=>Promise<void>) {
  if (!plan.scratch) throw new Error('临时工作区分配记录不存在');
  signal?.throwIfAborted();
  if (plan.scratch.phase === 'claimed') { await verifyScratchWorkspace(plan); return; }
  // A saved create intent with no recorded inode is ambiguous, even if the
  // directory is empty. Recovery does not overwrite, delete or silently adopt it.
  if (plan.scratch.phase === 'claiming') throw new Error('临时目录的创建结果待核对，请重试工作区准备；不会自动重复分配');
  await ensureScratchRoot(plan.scratch.parent);
  await started();
  const save = async (patch:Partial<TaskWorkspacePlan>) => { signal?.throwIfAborted(); await progress?.(patch); Object.assign(plan,patch); };
  while (true) {
    signal?.throwIfAborted();
    await save({scratch:{...plan.scratch!,phase:'claiming'}});
    signal?.throwIfAborted();
    try { await mkdir(plan.cwd,{mode:0o700}); }
    catch(error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await save({scratch:{...plan.scratch!,phase:'planned'}}); throw error; }
      await save(nextCandidate(plan)); continue;
    }
    const identity = await ownedIdentity(plan);
    await save({scratch:{...plan.scratch!,phase:'claimed',identity}});
    signal?.throwIfAborted(); return;
  }
}
export async function retryScratchWorkspace(saved: TaskWorkspacePlan): Promise<TaskWorkspacePlan> {
  const plan = structuredClone(saved);
  if (plan.scratch?.phase === 'claimed') { await verifyScratchWorkspace(plan); plan.state = 'ready'; return plan; }
  if (!plan.scratch) throw new Error('临时工作区分配记录不存在');
  // Explicit retry permits another allocation; unknown old directories remain
  // untouched. The replacement candidate is persisted before its mkdir.
  if (plan.scratch.phase === 'claiming') Object.assign(plan,nextCandidate(plan));
  plan.state = 'pending'; return plan;
}
export function isScratchProjectPath(path: string, root: string | null | undefined): boolean { return !!root && resolve(path) === root; }
