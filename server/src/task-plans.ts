import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { TaskEvent, TaskInteractionMode, WorkItem } from './types.js';
import { workspaceRelativePath } from './task-changes.js';

export function taskInteractionMode(value: unknown): TaskInteractionMode | undefined {
  if (value === undefined || value === 'default' || value === 'plan') return value;
  throw new Error('任务交互模式无效');
}
export const isTaskProposal = (event: TaskEvent) => event.kind === 'proposal' || (event.kind === 'plan' && event.itemId && event.itemId !== 'plan' && !event.plan);
export function currentTaskPlan(task: WorkItem, eventID: string) {
  const event = task.events.findLast(value => !value.revertedAt && isTaskProposal(value) && value.turnId === task.turnId);
  if (!event || event.id !== eventID || event.status !== 'completed' || !event.text.trim() || task.status !== 'completed') throw new Error('方案已经改变或当前任务尚未结束，请查看最新方案');
  if (task.queue?.dispatcherId != null || task.queue?.messages.some(value => ['queued', 'dispatching', 'steering'].includes(value.status))) throw new Error('请先处理这个任务的排队消息');
  return event;
}

// A create-only, content-idempotent write. Retrying a lost response can confirm
// the exact saved plan, but never overwrites another file or a partial write.
export async function saveTaskPlan(task: Pick<WorkItem, 'cwd' | 'events'>, eventID: unknown, path: unknown) {
  const event = task.events.find(value => value.id === eventID && !value.revertedAt);
  if (!event || !isTaskProposal(event) || event.status !== 'completed' || !event.text.trim()) {
    throw new Error('这个方案尚未完成或已不在任务记录中');
  }
  const relativePath = workspaceRelativePath(path);
  const components = relativePath.split('/');
  let directory = await realpath(task.cwd);
  for (const component of components.slice(0, -1)) {
    directory = join(directory, component);
    try { await mkdir(directory); } catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('保存路径不能经过符号链接或文件');
  }
  const target = join(directory, components.at(-1)!);
  const contents = event.text.replace(/^\s*<proposed_plan>\s*|\s*<\/proposed_plan>\s*$/g, '').trim() + '\n';
  const bytes = Buffer.from(contents);
  const temporary = join(directory, '.friday-plan-' + randomUUID());
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // A same-directory hard link publishes the complete file atomically and
    // fails if another save already owns the target. No partial target exists.
    try { await link(temporary, target); }
    catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      const conflict = () => new Error('这个路径已经存在其他内容，请使用新的文件名');
      const current = await lstat(target);
      if (current.isSymbolicLink() || !current.isFile() || current.size !== bytes.length) throw conflict();
      const existing = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size !== bytes.length || !(await existing.readFile()).equals(bytes)) throw conflict();
      } finally { await existing.close(); }
      return { relativePath, created: false };
    }
    return { relativePath, created: true };
  } finally { await unlink(temporary); }
}
