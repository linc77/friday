/*
Adapted from T3 Code 8cd9641f apps/server/src/project/ProjectSetupScriptRunner.ts (shell wrapper).
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
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
import type { TerminalEvent } from './terminal-types.js';
import { taskGit } from './git-process.js';
const stamp = () => new Date().toISOString();
type Transaction = Parameters<Parameters<Engine['root']['commit']>[0]>[0];
type Input = { id: string; token: string };
export class TaskProjectScripts {
  readonly definition;
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
          let run = await this.get(id);
          const result = await runtime.memo<{ exitCode: number | null }>('completion', ctx);
          if (result) { await finish(result.exitCode === 0 ? 'completed' : 'failed', result.exitCode); return; }
          if (await runtime.memo<boolean>('command-started', ctx)) {
            const row = this.engine.terminals.store.get(run.terminalOwner, run.terminalId);
            const captured = row?.generation === run.generation ? this.completion(Buffer.from(this.engine.terminals.snapshot(run.terminalOwner, run.terminalId).history, 'base64').toString('utf8'), task.input.token) : undefined;
            if (captured !== undefined) { await runtime.memo('completion', { exitCode: captured }, ctx); await finish(captured === 0 ? 'completed' : 'failed', captured); return; }
            if (!row || row.generation !== run.generation || !this.engine.terminals.isLive(run.terminalOwner, run.terminalId, row.generation)) { await finish('interrupted', null, '脚本执行结果未确认，请核对终端后明确重试；不会自动重放'); return; }
          } else {
            await this.validate(run);
            const row = await this.engine.terminals.lifecycle(run.terminalOwner, { action: 'open', terminalId: run.terminalId, requestId: run.id + '-open' }, run.id);
            if (!row) throw new Error('脚本终端未能打开');
            while (!this.engine.terminals.isLive(run.terminalOwner, run.terminalId, row.generation)) {
              runtime.signal.throwIfAborted(); const current = this.engine.terminals.store.get(run.terminalOwner, run.terminalId);
              if (!current || !['starting', 'running'].includes(current.status)) throw new Error('脚本终端未能启动'); await delay(30, undefined, { signal: runtime.signal });
            }
            await this.patch(run.id, { generation: row.generation, status: 'running' }); run = await this.get(id);
            this.engine.terminals.rename(run.terminalOwner, run.terminalId, run.script.name);
            await this.validate(run);
            await runtime.memo('command-started', true, ctx);
            const command = this.command(run.script.command, row.shell, task.input.token);
            const receipt = await this.engine.terminals.write(run.terminalOwner, run.terminalId, { generation: row.generation, requestId: run.id + '-command', data: Buffer.from(command + '\r').toString('base64') });
            if (receipt.state !== 'sent') throw new Error('脚本输入结果未确认，请核对终端；不会自动重复发送');
            await this.patch(run.id, { startedAt: stamp() });
          }
          const exitCode = await this.observe(run, task.input.token, runtime.signal);
          await runtime.memo('completion', { exitCode }, ctx); await finish(exitCode === 0 ? 'completed' : 'failed', exitCode, exitCode === null ? '终端在脚本结束前关闭，未确认退出结果' : exitCode === 0 ? undefined : '脚本以非零状态退出，输出保留在终端');
          if (exitCode === 0) await this.engine.terminals.closeIdle(run.terminalOwner, run.terminalId, run.generation!).catch(() => {});
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const attempted = await runtime.memo<boolean>('command-started', ctx); await finish(attempted ? 'interrupted' : 'failed', undefined, error instanceof Error ? error.message : '脚本执行失败');
        }
      } },
      abort: async (task, runtime, ctx) => {
        const run = await this.get(task.input.id);
        if (run.generation !== undefined && this.engine.terminals.store.get(run.terminalOwner, run.terminalId)?.generation === run.generation) await this.engine.terminals.lifecycle(run.terminalOwner, { action: 'close', terminalId: run.terminalId, requestId: run.id + '-cancel', force: true });
        await this.patch(run.id, { status: 'cancelled', completedAt: stamp(), error: '脚本已停止；已发生的改动保留，不会自动重放' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'cancelled' } } }), ctx);
      },
    });
  }
  private completion(text: string, token: string): number | undefined {
    const match = text.match(new RegExp('__FRIDAY_SCRIPT_DONE_' + token + ':(-?\\d+)')); return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : undefined;
  }
  private command(command: string, shell: string, token: string) {
    const sentinel = '__FRIDAY_SCRIPT_DONE_' + token + ':'; const body = command.replace(/\r?\n/g, '\r');
    if (shell.split('/').at(-1) === 'fish') return `begin\r${body}\rend; printf '\\n${sentinel}%s\\n' $status`;
    return `( ${body}\r); printf '\\n${sentinel}%s\\n' "$?"`;
  }
  private observe(run: ProjectScriptRun, token: string, signal: AbortSignal): Promise<number | null> {
    return new Promise((resolve, reject) => {
      let buffer = '', stop: (() => void) | undefined, settled = false;
      const cleanup = () => { stop?.(); signal.removeEventListener('abort', abort); };
      const finish = (code: number | null) => { if (!settled) { settled = true; cleanup(); resolve(code); } };
      const abort = () => { if (!settled) { settled = true; cleanup(); reject(signal.reason ?? new Error('脚本已中断')); } };
      signal.addEventListener('abort', abort, { once: true });
      stop = this.engine.terminals.observe(run.terminalOwner, run.terminalId, run.generation, undefined, (event: TerminalEvent) => {
        if (event.generation !== run.generation) { finish(null); return; }
        if (event.type === 'snapshot') buffer = Buffer.from(event.history, 'base64').toString('utf8').slice(-65536); else if (event.type === 'output') buffer = (buffer + Buffer.from(event.data, 'base64').toString('utf8')).slice(-65536);
        const result = this.completion(buffer, token); if (result !== undefined) finish(result);
        else if (event.type === 'closed' || (event.type === 'metadata' || event.type === 'snapshot') && ['closed','exited','error','interrupted'].includes(event.terminal.status)) finish(null);
      });
      if (settled) stop(); if (signal.aborted) abort();
    });
  }
  private patch(id: string, change: Partial<ProjectScriptRun>) { return this.engine.mutate(state => { const run = state.projectScriptRuns?.find(r => r.id === id); if (run) Object.assign(run, change, { updatedAt: stamp() }); }); }
  async get(id: string) { const run = (await this.engine.snapshot()).projectScriptRuns?.find(r => r.id === id); if (!run) throw new Error('项目脚本运行记录不存在'); return run; }
  list(state: Workspace, taskId?: string, projectId?: string) { return (state.projectScriptRuns ?? []).filter(r => taskId ? r.taskId === taskId : projectId ? r.projectId === projectId : true); }
  terminalOwner(state: Workspace, owner: string) {
    const run = state.projectScriptRuns?.find(r => r.terminalOwner === owner && r.terminalOwner.startsWith('script-'));
    return run ? { cwd: run.cwd, projectId: run.projectId, preparationId: run.preparationId, scriptRunId: run.id } : undefined;
  }
  ownsTerminal(state: Workspace, owner: string) { return !!this.terminalOwner(state, owner); }
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
    const id = randomUUID(), terminalOwner = input.taskId ?? 'script-' + id, terminalId = 'script-' + id;
    const durableId = await tx.createTask(this.definition, { id, token: randomUUID().replaceAll('-', '') }, { ownership: { kind: 'conversation' } });
    state.projectScriptRuns ??= []; state.projectScriptRuns.push({ ...input, id, digest, durableId, terminalOwner, terminalId, status: 'queued', createdAt: stamp(), updatedAt: stamp() }); return id;
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
      const sent = run.generation !== undefined && this.engine.terminals.receipt(run.terminalOwner, run.terminalId, run.id + '-command')?.state === 'sent';
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
      const row = this.engine.terminals.store.get(run.terminalOwner, run.terminalId);
      if (row && ['starting','running','closing'].includes(row.status)) {
        await this.engine.terminals.lifecycle(run.terminalOwner, { action: 'close', terminalId: run.terminalId, requestId: run.id + '-delete-close', force: true });
        while (this.engine.terminals.isLive(run.terminalOwner, run.terminalId, row.generation)) await delay(30);
      }
    }
  }
}
