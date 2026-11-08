import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { Workspace, TaskWorkspacePlan } from './types.js';
import { activeProjectScript, type ProjectScriptRun, type ProjectScript } from './project-script-types.js';
import { resolveProjectScripts } from './project-script-settings.js';
import { privateWorkspacePaths } from './workspace-privacy.js';
import { containsDirectory } from './branch-switch.js';
import { ProjectScriptProcesses } from './project-script-processes.js';
import { taskGit } from './git-process.js';
const stamp = () => new Date().toISOString();
type Transaction = Parameters<Parameters<Engine['root']['commit']>[0]>[0];
type Input = { id: string };
export class TaskProjectScripts {
  readonly definition;
  readonly processes = new ProjectScriptProcesses();
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'run' }, { status: string }, {}>({
      name: 'friday.project_script', version: 1, initial: () => ({ phase: 'run' }),
      phases: { run: async (task, runtime, ctx) => {
        const id = task.input.id;
        const finish = async (status: ProjectScriptRun['status'], exitCode?: number | null, error?: string) => {
          await this.patch(id, { status, completedAt: stamp(), ...(exitCode !== undefined ? { exitCode } : {}), ...(error ? { error } : {}) });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        try {
          const run = await this.get(id);
          const result = await runtime.memo<{ exitCode: number | null }>('completion', ctx);
          if (result) { await finish(result.exitCode === 0 ? 'completed' : 'failed', result.exitCode); return; }
          if (await runtime.memo<boolean>('command-started', ctx)) {
            const output = this.processes.output(id);
            if (output?.completed) { await finish(output.exitCode === 0 ? 'completed' : 'failed', output.exitCode); return; }
            if (!this.processes.isLive(id)) { await finish('interrupted', null, '脚本执行结果未确认，请检查日志后明确重试；不会自动重放'); return; }
          } else {
            await this.validate(run);
            const state = await this.engine.snapshot();
            const env = {
              ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:FRIDAY_|CODEX_|ELECTRON_)/.test(key) && !['PORT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].includes(key))),
              ...this.runtimeEnvironment(state, id), PWD: run.cwd,
            };
            // Persist the intent before spawning: a crash in this window requires an explicit retry.
            await runtime.memo('command-started', true, ctx);
            runtime.signal.throwIfAborted();
            await this.processes.start(id, run.script.command, run.cwd, env);
            await this.patch(id, { status: 'running', startedAt: stamp() });
          }
          const exitCode = await this.processes.wait(id, runtime.signal);
          await runtime.memo('completion', { exitCode }, ctx);
          await finish(exitCode === 0 ? 'completed' : 'failed', exitCode, exitCode === 0 ? undefined : '脚本未成功完成，请查看日志');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await this.processes.stop(id);
          const attempted = await runtime.memo<boolean>('command-started', ctx); await finish(attempted ? 'interrupted' : 'failed', undefined, error instanceof Error ? error.message : '脚本执行失败');
        }
      } },
      abort: async (task, runtime, ctx) => {
        const run = await this.get(task.input.id);
        await this.processes.stop(run.id);
        await this.patch(run.id, { status: 'cancelled', completedAt: stamp(), error: '脚本已停止；已发生的改动保留，不会自动重放' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx);
      },
    });
  }
  private patch(id: string, change: Partial<ProjectScriptRun>) { return this.engine.mutate(state => { const run = state.projectScriptRuns?.find(r => r.id === id); if (run) Object.assign(run, change, { updatedAt: stamp() }); }); }
  async get(id: string) { const run = (await this.engine.snapshot()).projectScriptRuns?.find(r => r.id === id); if (!run) throw new Error('项目脚本运行记录不存在'); return run; }
  list(state: Workspace, taskId?: string, projectId?: string) { return (state.projectScriptRuns ?? []).filter(r => taskId ? r.taskId === taskId : projectId ? r.projectId === projectId : true); }
  runtimeEnvironment(state: Workspace, id: string) {
    const run = state.projectScriptRuns?.find(r => r.id === id), project = state.projects.find(p => p.id === run?.projectId);
    if (!run || !project) throw new Error('脚本所属 Workspace 已改变');
    return { FRIDAY_PROJECT_ROOT: project.path, T3CODE_PROJECT_ROOT: project.path, ...(run.workspace?.mode === 'worktree' || run.workspace?.scriptWorktree ? { FRIDAY_WORKTREE_PATH: run.workspace.root, T3CODE_WORKTREE_PATH: run.workspace.root } : {}), COLORTERM: '', NO_COLOR: '1', FORCE_COLOR: '0' };
  }
  private async validate(run: ProjectScriptRun) {
    const state = await this.engine.snapshot(), project = state.projects.find(p => p.id === run.projectId); if (!project) throw new Error('脚本所属 Workspace 不存在');
    if (await realpath(run.cwd) !== run.cwd || !(await stat(run.cwd)).isDirectory() || (await privateWorkspacePaths(run.cwd, { directory: this.engine.directory, workspace: run.workspace })).includes('')) throw new Error('脚本执行目录已改变或不可读取');
    if (run.workspace && !containsDirectory(run.workspace.root, run.cwd)) throw new Error('脚本目录不属于准备的 Worktree');
    if (run.workspace && await realpath(project.path) !== await realpath(run.workspace.sourcePath)) throw new Error('脚本所属 Workspace 目录已改变');
    if (run.workspace?.mode === 'worktree' || run.workspace?.scriptWorktree) {
      const common = async (path: string) => realpath((await taskGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim());
      if (await common(run.cwd) !== await common(project.path)) throw new Error('脚本 Worktree 与原仓库不匹配');
    } else if (!run.workspace && await realpath(project.path) !== run.cwd) throw new Error('脚本执行目录已改变');
  }
  async enqueue(tx: Transaction, state: Workspace, input: { projectId: string; taskId?: string; preparationId?: string; cwd: string; workspace?: TaskWorkspacePlan; requestId: string; trigger: ProjectScriptRun['trigger']; script: ProjectScript }) {
    const owner = input.taskId ? state.tasks.find(task => task.id === input.taskId) : undefined;
    if (owner && (owner.archivedAt || owner.archiveCleanup?.status === 'pending')) throw new Error('任务已归档，不再启动项目脚本');
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const saved = state.projectScriptRuns?.find(r => r.requestId === input.requestId);
    if (saved) { if (saved.digest !== digest) throw new Error('脚本请求 ID 已用于不同内容'); return saved.id; }
    const id = randomUUID();
    const durableId = await tx.createTask(this.definition, { id }, { ownership: { kind: 'conversation' } });
    state.projectScriptRuns ??= []; state.projectScriptRuns.push({ ...input, id, digest, durableId, status: 'queued', createdAt: stamp(), updatedAt: stamp() }); return id;
  }
  async startTask(taskId: string, scriptId: unknown, requestId: unknown) {
    if (typeof scriptId !== 'string' || typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('脚本运行请求无效');
    let id!: string;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), task = state.tasks.find(t => t.id === taskId && t.agent !== 'friday'), project = state.projects.find(p => p.id === task?.projectId);
      if (!task || !project || task.executionWorkspace && task.executionWorkspace.state !== 'ready') throw new Error('请先准备本地任务工作区');
      if (task.archivedAt || task.archiveCleanup?.status === 'pending') throw new Error('请先恢复并完成归档清理，再运行项目脚本');
      const prior = state.projectScriptRuns?.find(r => r.requestId === requestId);
      if (prior) { if (prior.taskId !== taskId || prior.script.id !== scriptId) throw new Error('脚本请求已用于其他操作'); id = prior.id; return; }
      const script = resolveProjectScripts(state, project).scripts.find(s => s.id === scriptId); if (!script) throw new Error('项目脚本不存在');
      id = await this.enqueue(tx, state, { taskId, projectId: project.id, cwd: await realpath(task.cwd), ...(task.executionWorkspace ? { workspace: task.executionWorkspace } : {}), script, trigger: 'manual', requestId }); state.revision++;
    }, context); this.engine.harness.resume(); return id;
  }
  async setup(input: { projectId: string; taskId?: string; preparationId?: string; plan: TaskWorkspacePlan; requestId: string }) {
    let id: string | null = null;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc), project = state.projects.find(p => p.id === input.projectId); if (!project) throw new Error('Workspace 不存在');
      const prior = state.projectScriptRuns?.find(r => r.requestId === input.requestId); if (prior) { if (prior.trigger !== 'setup' || prior.projectId !== input.projectId || prior.taskId !== input.taskId || prior.preparationId !== input.preparationId || prior.cwd !== input.plan.cwd) throw new Error('初始化脚本请求已用于其他操作'); id = prior.id; return; }
      const script = resolveProjectScripts(state, project).scripts.find(s => s.runOnWorktreeCreate); if (!script) return;
      id = await this.enqueue(tx, state, { projectId: project.id, ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.preparationId ? { preparationId: input.preparationId } : {}), cwd: input.plan.cwd, workspace: input.plan, script, trigger: 'setup', requestId: input.requestId }); state.revision++;
    }, context); if (id) this.engine.harness.resume(); return id as string | null;
  }
  async handoff(id: string, signal?: AbortSignal) {
    for (;;) {
      signal?.throwIfAborted(); const run = await this.get(id);
      const sent = run.startedAt !== undefined;
      if (run.script.async !== false && sent) return run;
      if (!activeProjectScript(run)) {
        if (run.status === 'completed' && run.exitCode === 0) return run;
        throw new Error(run.error ?? (run.status === 'cancelled' ? '初始化脚本已停止' : '初始化脚本未成功完成，请检查输出后重试准备'));
      }
      await delay(30, undefined, { signal });
    }
  }
  async captureSettles(tx: Transaction, state: Workspace) {
    state.projectScriptSettles ??= {};
    for (const task of state.tasks) {
      if (!task.settledAt || task.agent === 'friday' || task.subagentOrigin || task.settledAt === state.projectScriptSettles[task.id] || task.settleCleanup && task.settleCleanup.status !== 'completed') continue;
      state.projectScriptSettles[task.id] = task.settledAt;
      if (task.archivedAt || task.archiveCleanup?.status === 'pending') continue;
      const plan = task.executionWorkspace, project = state.projects.find(p => p.id === task.projectId);
      if (!project || !plan || plan.state !== 'ready' || plan.mode !== 'worktree' && !plan.scriptWorktree) continue;
      const script = resolveProjectScripts(state, project).scripts.find(s => s.runOnSettle); if (!script) continue;
      await this.enqueue(tx, state, { taskId: task.id, projectId: project.id, cwd: task.cwd, workspace: plan, script, trigger: 'settle', requestId: 'settle-' + createHash('sha256').update(task.id + ':' + task.settledAt).digest('hex') });
    }
  }
  async cancel(id: string) { const run = await this.get(id); if (activeProjectScript(run)) { await this.engine.harness.abortTask(run.durableId as TaskId, context); await this.engine.harness.waitForTask(run.durableId as TaskId, context); } }
  async stopTask(id: string, setupOnly = false) {
    for (const run of this.list(await this.engine.snapshot(), id).filter(r => !setupOnly || r.trigger === 'setup')) {
      if (activeProjectScript(run)) await this.cancel(run.id);
      await this.processes.stop(run.id);
    }
  }
}
