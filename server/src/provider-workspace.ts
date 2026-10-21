import { realpath } from 'node:fs/promises';
import type { Engine } from './engine.js';
import type { ProviderSkill } from './claude-skills.js';
export type ProviderCommand = { name: string; description?: string; argumentHint?: string; builtin?: boolean };
export type ProviderWorkspace = { provider: string; cwd: string; checkedAt: string; skills: ProviderSkill[]; commands: ProviderCommand[]; supportsPlan?: boolean };

export class ProviderWorkspaceCache<T extends { checkedAt: string } = ProviderWorkspace> {
  private values = new Map<string, T>();
  private pending = new Map<string, { promise: Promise<T>; reload: boolean }>();
  constructor(private ttlMs = 5 * 60_000) {}
  private epochs = new Map<string, number>();
  invalidate(key: string) { this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1); this.values.delete(key); this.pending.delete(key); }
  async read(key: string, reload: boolean, load: () => Promise<T>): Promise<T> {
    const current = this.values.get(key);
    // T3 contracts/server.ts workspace snapshot TTL.
    if (!reload && current && Date.now() - Date.parse(current.checkedAt) < this.ttlMs) return current;
    const pending = this.pending.get(key);
    if (pending) {
      if (!reload || pending.reload) return pending.promise;
      // A user refresh arriving during an ordinary scan must still perform
      // one forced native scan after that read drains.
      await pending.promise.catch(() => {}); return this.read(key, true, load);
    }
    const epoch = this.epochs.get(key) ?? 0;
    const request = load().then(value => {
      if ((this.epochs.get(key) ?? 0) === epoch) this.values.set(key, value);
      // This cache contains metadata only and is process-local. Settings and
      // directory identities remain in the key, never in the public response.
      if (this.values.size > 64) this.values.delete(this.values.keys().next().value!);
      return value;
    }).finally(() => { if (this.pending.get(key)?.promise === request) this.pending.delete(key); });
    this.pending.set(key, { promise: request, reload }); return request;
  }
}
export const providerCommands = (value: unknown): ProviderCommand[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(value => value && typeof value.name === 'string' && value.name.trim() ? [{ name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(typeof value.argumentHint === 'string' ? { argumentHint: value.argumentHint } : {}),
    ...(typeof value.builtin === 'boolean' ? { builtin: value.builtin } : {}) }] : []);
};

export async function composerWorkspace(engine: Engine, input: { provider: string; taskId?: string; projectId?: string; preparationId?: string; reuseTaskId?: string; reload?: boolean }) {
  if (!['codex', 'claude', 'pi', 'grok', 'cursor', 'muse', 'opencode', 'acp-registry', 'antigravity'].includes(input.provider)) throw new Error('请选择已接入的任务执行器');
  const state = await engine.snapshot(), task = input.taskId ? state.tasks.find(task => task.id === input.taskId) : undefined;
  const project = state.projects.find(project => project.id === (task?.projectId ?? input.projectId));
  if (input.taskId && (!task || task.agent !== input.provider || input.projectId && task.projectId !== input.projectId)) throw new Error('任务执行范围已经改变');
  if (!task && !project) throw new Error('请选择已注册的 Workspace');
  if (input.preparationId && input.reuseTaskId || task && (input.preparationId || input.reuseTaskId)) throw new Error('执行范围无效');
  let cwd = task?.cwd ?? project!.path;
  const reused = input.reuseTaskId ? state.tasks.find(task => task.id === input.reuseTaskId && task.projectId === project?.id && !task.subagentOrigin && task.agent !== 'friday') : undefined;
  if (input.reuseTaskId && !reused) throw new Error('原任务工作区不可用');
  if (reused) cwd = reused.cwd;
  if (input.preparationId) cwd = (await engine.changeRequestCheckouts.adopt(project!.id, input.preparationId)).plan.cwd;
  cwd = await realpath(cwd);
  const value = input.provider === 'acp-registry' ? await engine.acpRegistryConnection.workspace(cwd, input.reload === true, task) : input.provider === 'antigravity' ? await engine.antigravityConnection.workspace(cwd, input.reload === true, task) : input.provider === 'cursor' ? await engine.cursorConnection.workspace(cwd, input.reload === true, task) : input.provider === 'muse' ? await engine.museConnection.workspace(cwd, input.reload === true, task) : input.provider === 'opencode' ? await engine.opencodeConnection.workspace(cwd, input.reload === true, task) : input.provider === 'codex' ? await engine.codexConnection.workspace(cwd, input.reload === true, task)
    : input.provider === 'pi' ? await engine.piConnection.workspace(cwd, input.reload === true, task) : input.provider === 'grok' ? await engine.grokConnection.workspace(cwd, input.reload === true, task) : await engine.claudeConnection.workspace(cwd, input.reload === true, task);
  const latest = await engine.snapshot();
  if (task && !latest.tasks.some(value => value.id === task.id && value.cwd === task.cwd && value.agent === task.agent)
    || !task && !latest.projects.some(value => value.id === project!.id && value.path === project!.path)
    || reused && !latest.tasks.some(value => value.id === reused.id && value.cwd === reused.cwd && value.projectId === project!.id)) throw new Error('执行范围已经改变，请重新加载');
  return value;
}
