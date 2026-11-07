import type { Engine } from './engine.js';
import type { Workspace, WorktreeSubmodules } from './types.js';
import type { Hono } from 'hono';

export type SourceControlPreferenceScope = { removeAgentCreditsOnMerge?: boolean; newWorktreesStartFromOrigin?: boolean; worktreeSubmodules?: WorktreeSubmodules | null };
export type SourceControlPreferences = { version: number; defaults: SourceControlPreferenceScope; projects: Record<string, SourceControlPreferenceScope> };
export class SourceControlPreferencesConflict extends Error { constructor(readonly version: number) { super('仓库设置已在其他设备修改，请重新加载'); } }
const builtIn = { removeAgentCreditsOnMerge: false, newWorktreesStartFromOrigin: true, worktreeSubmodules: null } as const;
const keys = Object.keys(builtIn) as (keyof SourceControlPreferenceScope)[];
const defaults = (): SourceControlPreferences => ({ version: 0, defaults: { ...builtIn }, projects: {} });
export function resolveSourceControlPreferences(state: Workspace, projectId: string | null) {
  const stored = state.sourceControlPreferences ?? defaults(), host = { ...builtIn, ...stored.defaults };
  const overrides = projectId && Object.hasOwn(stored.projects, projectId) ? stored.projects[projectId] : {};
  const sources = Object.fromEntries(keys.map(key => [key, Object.hasOwn(overrides, key) ? 'workspace' : state.sourceControlPreferences && Object.hasOwn(stored.defaults, key) ? 'host' : 'default']));
  return { version: stored.version, projectId, defaults: host, overrides, effective: { ...host, ...overrides }, sources, source: Object.hasOwn(overrides, 'removeAgentCreditsOnMerge') ? 'workspace' : state.sourceControlPreferences ? 'host' : 'default' };
}
const record = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('合并设置格式无效'); return v as Record<string, unknown>; };
export async function saveSourceControlPreferences(engine: Engine, raw: unknown) {
  const v = record(raw), changes = v.changes === undefined ? {} : record(v.changes), reset = v.reset ?? [];
  if (Object.keys(v).some(k => !['projectId','expectedVersion','changes','reset'].includes(k)) || v.projectId !== null && (typeof v.projectId !== 'string' || !v.projectId || v.projectId.length > 100 || ['__proto__','constructor','prototype'].includes(v.projectId))) throw new Error('合并设置范围无效');
  if (!Number.isSafeInteger(v.expectedVersion) || Number(v.expectedVersion) < 0) throw new Error('合并设置版本无效');
  if (Object.entries(changes).some(([key,value]) => !keys.includes(key as keyof SourceControlPreferenceScope) || (key === 'worktreeSubmodules' ? value !== null && (typeof value !== 'string' || !['recursive','top-level','none'].includes(value)) : typeof value !== 'boolean')) || !Array.isArray(reset) || reset.some(k => !keys.includes(k) || Object.hasOwn(changes, k)) || new Set(reset).size !== reset.length || !Object.keys(changes).length && !reset.length) throw new Error('仓库设置字段无效');
  await engine.mutate(state => {
    if (v.projectId !== null && !state.projects.some(p => p.id === v.projectId)) throw new Error('Workspace 不存在');
    if ((state.sourceControlPreferences?.version ?? 0) !== v.expectedVersion) throw new SourceControlPreferencesConflict(state.sourceControlPreferences?.version ?? 0);
    state.sourceControlPreferences ??= defaults(); const stored = state.sourceControlPreferences;
    if (typeof v.projectId === 'string') {
      stored.projects[v.projectId] ??= {};
      for (const key of reset as (keyof SourceControlPreferenceScope)[]) delete stored.projects[v.projectId][key];
      Object.assign(stored.projects[v.projectId], changes);
      if (!Object.keys(stored.projects[v.projectId]).length) delete stored.projects[v.projectId];
    } else { Object.assign(stored.defaults, Object.fromEntries((reset as (keyof SourceControlPreferenceScope)[]).map(key => [key, builtIn[key]])), changes); }
    stored.version++;
  });
  return resolveSourceControlPreferences(await engine.snapshot(), v.projectId as string | null);
}
export function installSourceControlPreferencesAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine) {
  app.get('/api/source-control/preferences', async c => {
    const state = await engine.snapshot(), projectId = c.req.query('projectId') ?? null;
    if (projectId !== null && !state.projects.some(p => p.id === projectId)) throw new Error('Workspace 不存在');
    return c.json(resolveSourceControlPreferences(state, projectId));
  });
  app.patch('/api/source-control/preferences', async c => { try { return c.json(await saveSourceControlPreferences(engine, await c.req.json())); } catch (error) { if (error instanceof SourceControlPreferencesConflict) return c.json({ error: error.message, version: error.version }, 409); throw error; } });
}
