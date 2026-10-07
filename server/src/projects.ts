import type { Project } from './types.js';

const icons = ['folder', 'terminal', 'curlybraces', 'app', 'globe', 'book.closed', 'lightbulb', 'paintbrush', 'hammer', 'star', 'heart', 'briefcase'];
const colors = ['gray', 'blue', 'teal', 'green', 'yellow', 'orange', 'pink', 'purple'];

// Optional appearance fields keep saved workspaces and older clients compatible.
// Omitted context must survive a name/appearance-only edit from the sidebar.
export function projectChanges(input: unknown): Pick<Project, 'name'> & Partial<Pick<Project, 'context' | 'icon' | 'color'>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workspace 设置无效');
  const body = input as Record<string, unknown>;
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) throw new Error('Workspace 名称不能为空，且长度不能超过 120');
  const changes: ReturnType<typeof projectChanges> = { name: body.name.trim() };
  if (body.context !== undefined) {
    if (typeof body.context !== 'string') throw new Error('Workspace 背景无效');
    changes.context = body.context.slice(0, 20_000);
  }
  for (const [key, allowed] of [['icon', icons], ['color', colors]] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'string' || !allowed.includes(body[key])) throw new Error(key === 'icon' ? 'Workspace 图标无效' : 'Workspace 颜色无效');
    changes[key] = body[key];
  }
  return changes;
}
