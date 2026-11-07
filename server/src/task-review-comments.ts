import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalWorkspacePath, privateWorkspacePaths, type WorkspacePrivacy } from './workspace-privacy.js';
import { fileReferencePath } from './task-files.js';

export type DiffReview = { sectionID: string; sectionTitle: string; startIndex: number; endIndex: number; rangeLabel: string; selection: { start: number; side: string; end: number; endSide: string } };
function diffReview(value: unknown): DiffReview | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Diff 批注选区无效');
  const input = value as Record<string, unknown>, selection = input.selection as Record<string, unknown> | undefined;
  if (typeof input.sectionID !== 'string' || !input.sectionID || input.sectionID.length > 255 || typeof input.sectionTitle !== 'string' || !input.sectionTitle || input.sectionTitle.length > 512 || typeof input.rangeLabel !== 'string' || !input.rangeLabel || input.rangeLabel.length > 512 ||
      !Number.isSafeInteger(input.startIndex) || Number(input.startIndex) < 0 || !Number.isSafeInteger(input.endIndex) || Number(input.endIndex) < Number(input.startIndex) ||
      !selection || !Number.isSafeInteger(selection.start) || Number(selection.start) < 1 || !Number.isSafeInteger(selection.end) || Number(selection.end) < 1 || !['additions', 'deletions'].includes(String(selection.side)) || !['additions', 'deletions'].includes(String(selection.endSide))) throw new Error('Diff 批注选区无效');
  return { sectionID: input.sectionID, sectionTitle: input.sectionTitle, startIndex: Number(input.startIndex), endIndex: Number(input.endIndex), rangeLabel: input.rangeLabel, selection: { start: Number(selection.start), side: String(selection.side), end: Number(selection.end), endSide: String(selection.endSide) } };
}
const inside = (root: string, target: string) => { const path = relative(root, target); return path === '' || !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep); };

// A Diff quote contains client-selected saved patch bytes, not a filesystem
// read. It remains capturable after the source file or worktree is removed.
export async function reviewDiffPath(value: unknown, cwd: string, privacy: WorkspacePrivacy) {
  const path = fileReferencePath(value, false, true), root = await canonicalWorkspacePath(cwd), target = await canonicalWorkspacePath(resolve(root, path));
  if ([root, target].some(value => value.split(sep).some(part => part.toLowerCase() === '.git'))) throw new Error('不能引用 Git 内部数据');
  const plan = typeof privacy === 'string' ? undefined : privacy.workspace, directory = typeof privacy === 'string' ? privacy : privacy.directory;
  const plannedRoot = plan?.mode === 'worktree' ? resolve(await canonicalWorkspacePath(directory), 'worktrees', basename(plan.root)) : '';
  const retainedPatch = !!plannedRoot && plan?.mode === 'worktree' && plan.state === 'ready' && resolve(plan.root) === plannedRoot && inside(plannedRoot, root) && inside(root, target);
  if (!retainedPatch && ((await privateWorkspacePaths(root, privacy)).includes('') || (await privateWorkspacePaths(target, privacy)).includes(''))) throw new Error('不能引用 Friday 的私有运行数据');
  return path;
}

export function reviewComment(input: Record<string, unknown>) {
  const review = diffReview(input.diffReview);
  if (typeof input.comment !== 'string' || !input.comment.trim() || typeof input.contents !== 'string' || input.comment.includes('\0') || input.contents.includes('\0')) throw new Error('批注内容无效');
  if (!Number.isSafeInteger(input.lineStart) || !Number.isSafeInteger(input.lineEnd) || Number(input.lineStart) < 1 || Number(input.lineEnd) < Number(input.lineStart)) throw new Error('批注行范围无效');
  if (input.comment.length > 16_000 || input.contents.length > 32_000) throw new Error('批注或选区内容过长');
  if (typeof input.workspaceRoot !== 'string' || !review && typeof input.workspaceVersion !== 'string') throw new Error('批注所属工作区无效');
  const path = String(input.path), name = basename(path), extension = name.lastIndexOf('.');
  const fenceLanguage = review ? 'diff' : extension >= 0 && extension < name.length - 1 ? name.slice(extension + 1).toLowerCase() : 'text';
  const start = Number(input.lineStart), end = Number(input.lineEnd), range = start === end ? `L${start}` : `L${start} to L${end}`;
  const match = review?.rangeLabel.match(/^([+-])(\d+)(?: to \1(\d+))?$/);
  const label = match ? `L${match[2]}${match[3] ? ' to L' + match[3] : ''}${match[1] === '-' ? ' (before)' : ''}` : review?.rangeLabel ?? range;
  return { text: JSON.stringify({ ...(review ? { diffReview: review } : {}), fenceLanguage, source: input.contents, text: input.comment.trim() }), label: `${name} ${label}`, lineStart: start, lineEnd: end, diffReview: review };
}
