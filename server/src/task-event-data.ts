import type { TaskCommandAction, TaskFileChange, TaskPlanStep } from './types.js';

// Stats use the complete public patch even when the stored preview is bounded.
// Count inside hunks only: +++/--- can also be real added/deleted source lines.
export function patchStats(patch: string) {
  let additions = 0; let deletions = 0; let hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('*** ')) hunk = false;
    if (line.startsWith('@@')) { hunk = true; continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

export function codexFileChanges(value: unknown): TaskFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(change => {
    if (!change || typeof change.path !== 'string' || typeof change.diff !== 'string') return [];
    const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type;
    if (!['add', 'update', 'delete'].includes(kind)) return [];
    const moved = kind === 'update' && typeof change.kind?.move_path === 'string' ? change.kind.move_path : undefined;
    // Codex identifies the original path and puts the destination in move_path.
    return [{ path: moved ?? change.path, ...(moved ? { oldPath: change.path } : {}), kind,
      diff: change.diff.slice(0, 256_000), ...patchStats(change.diff), ...(change.diff.length > 256_000 ? { truncated: true } : {}) }];
  });
}

export function taskPlanSteps(value: unknown): TaskPlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(value => value && typeof value.step === 'string' && ['pending', 'inProgress', 'completed'].includes(value.status)
    ? [{ step: value.step, status: value.status }] : []);
}

export function taskCommandActions(value: unknown): TaskCommandAction[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(value => {
    if (!value || !['read', 'listFiles', 'search', 'unknown'].includes(value.type) || typeof value.command !== 'string') return [];
    return [{ type: value.type, command: value.command,
      ...(typeof value.path === 'string' ? { path: value.path } : {}),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.query === 'string' ? { query: value.query } : {}) }];
  });
}
