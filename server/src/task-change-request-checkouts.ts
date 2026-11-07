import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { Workspace } from './types.js';
import type { ChangeRequestCheckout } from './task-change-request-checkout-types.js';
import { cleanupCheckoutRef, checkoutGitPlan, inspectCheckout, performCheckout, resolveCheckout, verifyCheckoutAuthority, type CheckoutResolution, type CheckoutGitPlan } from './task-change-request-checkout-git.js';
import { assertCheckoutIdle, branchBlocksTask, containsDirectory, directoriesOverlap } from './branch-switch.js';
import { prepareWorktreeSubmodules } from './task-workspace-git-preparation.js';
import { resolveSourceControlPreferences } from './source-control-preferences.js';
import type { WorktreeSubmodules } from './types.js';

const stamp = () => new Date().toISOString();
export const activeCheckout = (value: ChangeRequestCheckout) => value.status === 'queued' || value.status === 'running';
type Input = { id: string; projectId: string; resolution: CheckoutResolution; plan: CheckoutGitPlan; force: boolean; submoduleMode?: WorktreeSubmodules | null };
const record = (value: unknown): Record<string, any> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PR／MR 检出请求无效'); return value as Record<string, any>; };
export class TaskChangeRequestCheckouts {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'run' }, { status: string }, {}>({
      name: 'friday.change_request_checkout', version: 1, initial: () => ({ phase: 'run' }),
      phases: { run: async (task, runtime, ctx) => {
        const input = task.input;
        const finish = async (status: ChangeRequestCheckout['status'], extra: Partial<ChangeRequestCheckout> = {}) => {
          await cleanupCheckoutRef(input.resolution, input.id);
          await this.patch(input.id, { status, ...extra });
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        };
        const prepared = async (result: Pick<ChangeRequestCheckout, 'plan' | 'reused' | 'isOnHead' | 'moved'>) => {
          let setupRunId = await runtime.memo<string | null>('setup-run', ctx);
          let setupWarning: string | undefined;
          if (input.plan.mode === 'worktree' && result.plan) result.plan = { ...result.plan, scriptWorktree: true };
          if (input.plan.mode === 'worktree' && result.plan && !result.reused) {
            result.plan.submoduleMode ??= input.submoduleMode ?? null;
            await prepareWorktreeSubmodules(result.plan, async patch => {
              Object.assign(result.plan!, patch);
              await runtime.memo('git-result', result, ctx);
              await this.patch(input.id, result);
            }, runtime.signal);
          }
          await this.patch(input.id, result);
          if (input.plan.mode === 'worktree' && result.plan && (!result.reused || result.moved)) {
            try {
              if (setupRunId === undefined) { setupRunId = await engine.projectScripts.setup({ projectId: input.projectId, preparationId: input.id, plan: result.plan, requestId: 'pr-setup-' + input.id }); await runtime.memo('setup-run', setupRunId, ctx); }
              if (setupRunId) { await this.patch(input.id, { setupRunId }); await engine.projectScripts.handoff(setupRunId, runtime.signal); }
            } catch (error) {
              if (runtime.signal.aborted) throw error;
              // GitManager.preparePullRequestThread treats setup errors as
              // warnings. Ordinary task startup retains its blocking rule.
              setupWarning = Buffer.from((error instanceof Error ? error.message : '初始化脚本未完成，请查看终端').slice(0, 1000)).toString('utf8');
            }
          }
          await finish('ready', { ...result, ...(setupRunId ? { setupRunId } : {}), ...(setupWarning ? { setupWarning } : {}) });
        };
        try {
          const saved = await runtime.memo<Pick<ChangeRequestCheckout, 'plan' | 'reused' | 'isOnHead' | 'moved'>>('git-result', ctx);
          if (saved) { await prepared(saved); return; }
          const state = await engine.snapshot(); const project = state.projects.find(v => v.id === input.projectId);
          if (!project || await realpath(project.path) !== input.resolution.authority.sourcePath) throw new Error('Workspace 注册已改变，请重新准备');
          const pinned = await verifyCheckoutAuthority(input.resolution.authority, engine.sourceControl, engine.directory, runtime.signal);
          await this.patch(input.id, { status: 'running' });
          if (await runtime.memo<boolean>('git-started', ctx)) {
            const result = await inspectCheckout(input.resolution, input.plan, engine.directory, true);
            await runtime.memo('git-result', result, ctx); await prepared(result); return;
          }
          if (input.plan.mode === 'checkout' || input.plan.reused && !input.plan.preserve) assertCheckoutIdle(state, input.plan.root);
          await runtime.memo('git-started', true, ctx);
          await performCheckout(input.resolution, input.plan, pinned, input.id, input.force, runtime.signal);
          const result = await inspectCheckout(input.resolution, input.plan, engine.directory);
          await runtime.memo('git-result', result, ctx); await prepared(result);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const started = await runtime.memo<boolean>('git-started', ctx), result = await runtime.memo('git-result', ctx), setupId = await runtime.memo<string | null>('setup-run', ctx);
          const setup = setupId ? (await engine.snapshot()).projectScriptRuns?.find(run => run.id === setupId) : undefined;
          const uncertain = started && !result || setupId && (!setup || !['completed','failed','cancelled'].includes(setup.status));
          await finish(uncertain ? 'interrupted' : 'failed', { error: error instanceof Error ? error.message : 'PR／MR 检出失败' });
        }
      } },
      abort: async (task, runtime, ctx) => {
        for (const run of (await engine.snapshot()).projectScriptRuns ?? []) if (run.preparationId === task.input.id && ['queued','running'].includes(run.status)) await engine.projectScripts.cancel(run.id);
        await cleanupCheckoutRef(task.input.resolution, task.input.id);
        await this.patch(task.input.id, { status: 'interrupted', error: '准备已停止，请核对目录；不会自动重复检出' });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  private patch(id: string, value: Partial<ChangeRequestCheckout>) { return this.engine.mutate(state => { const saved = state.changeRequestCheckouts?.find(v => v.id === id); if (saved) Object.assign(saved, value, { updatedAt: stamp() }); }); }
  private async project(id: string) { const project = (await this.engine.snapshot()).projects.find(v => v.id === id); if (!project) throw new Error('Workspace 不存在'); return project; }
  async resolve(projectId: string, raw: unknown, signal?: AbortSignal) {
    const project = await this.project(projectId); const { authority: _, ...preview } = await resolveCheckout(project.path, record(raw).reference, this.engine.sourceControl, this.engine.directory, signal,project.managedFolder); return preview;
  }
  async start(projectId: string, raw: unknown) {
    const v = record(raw);
    if (typeof v.requestId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(v.requestId) || !['checkout', 'worktree'].includes(v.mode) || typeof v.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.fingerprint) || typeof v.localFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(v.localFingerprint) || v.force !== undefined && typeof v.force !== 'boolean') throw new Error('PR／MR 检出确认无效');
    const intent = { projectId, reference: v.reference, mode: v.mode, fingerprint: v.fingerprint, localFingerprint: v.localFingerprint, force: v.force === true };
    const digest = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    const receipt = (state: Workspace) => { const saved = state.changeRequestCheckouts?.find(p => p.requestId === v.requestId); if (saved && saved.digest !== digest) throw new Error('检出请求 ID 已用于不同操作'); return saved; };
    const prior = receipt(await this.engine.snapshot()); if (prior) return prior.id;
    const project = await this.project(projectId), resolution = await resolveCheckout(project.path, v.reference, this.engine.sourceControl, this.engine.directory,undefined,project.managedFolder);
    if (resolution.fingerprint !== v.fingerprint || v.mode === 'checkout' && resolution.localFingerprint !== v.localFingerprint) throw new Error('PR／MR 或当前目录已经改变，请刷新后重新确认');
    if (v.mode === 'checkout' && resolution.dirty && !v.force) throw new Error('当前目录有未提交改动，请选择 Worktree，或明确确认丢弃改动');
    const id = randomUUID(), plan = await checkoutGitPlan(resolution, v.mode, this.engine.directory, id);
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); if (receipt(state)) return;
      const current = state.projects.find(p => p.id === projectId); if (!current || current.path !== project.path) throw new Error('Workspace 已改变');
      if (branchBlocksTask(state, plan.root) || state.changeRequestCheckouts?.some(p => activeCheckout(p) && (directoriesOverlap(p.root, plan.root) || p.common === resolution.authority.common && p.branch === plan.branch))) throw new Error('此目录或 PR 分支正在准备，请稍后重试');
      if (v.mode === 'checkout' || plan.reused && !plan.preserve) assertCheckoutIdle(state, plan.root);
      if ((state.changeRequestCheckouts?.length ?? 0) >= 1000) throw new Error('PR／MR 准备记录已达上限');
      const submoduleMode = resolveSourceControlPreferences(state, projectId).effective.worktreeSubmodules;
      const durableId = await tx.createTask(this.definition, { id, projectId, resolution, plan, force: v.force === true, submoduleMode }, { ownership: { kind: 'conversation' } });
      state.changeRequestCheckouts ??= []; state.changeRequestCheckouts.push({ id, projectId, requestId: v.requestId, digest, durableId, status: 'queued', mode: v.mode, pullRequest: resolution.pullRequest, headSha: resolution.headSha, common: resolution.authority.common, sourcePath: resolution.authority.sourcePath, root: plan.root, branch: plan.branch, createdAt: stamp(), updatedAt: stamp() }); state.revision++;
    }, context);
    this.engine.harness.resume(); return receipt(await this.engine.snapshot())!.id;
  }
  async get(projectId: string, id: string) { const saved = (await this.engine.snapshot()).changeRequestCheckouts?.find(v => v.id === id && v.projectId === projectId); if (!saved) throw new Error('PR／MR 目录准备记录不存在'); return saved; }
  async cancel(projectId: string, id: string) { const saved = await this.get(projectId, id); if (activeCheckout(saved)) { await this.engine.harness.abortTask(saved.durableId as TaskId, context); await this.engine.harness.waitForTask(saved.durableId as TaskId, context); } }
  async adopt(projectId: string, id: string) {
    const saved = await this.get(projectId, id), project = await this.project(projectId);
    if (saved.status !== 'ready' || !saved.plan || await realpath(project.path) !== saved.sourcePath) throw new Error('PR／MR 目录尚未准备完成或 Workspace 已改变');
    // Edits and new commits on the prepared branch are allowed before Send.
    const { taskGit } = await import('./git-process.js');
    const git = async (cwd: string, args: string[]) => (await taskGit(cwd, args)).stdout.trim();
    if (await realpath(saved.plan.cwd) !== saved.plan.cwd || !containsDirectory(saved.root, saved.plan.cwd) || await realpath(saved.root) !== saved.root || await realpath(await git(saved.root, ['rev-parse', '--show-toplevel'])) !== saved.root || await git(saved.root, ['symbolic-ref', '--short', 'HEAD']) !== saved.branch || await realpath(await git(saved.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== saved.common || await realpath(await git(saved.sourcePath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== saved.common) throw new Error('已准备目录的分支或仓库已经改变，请重新准备');
    return { saved, plan: { ...saved.plan, commit: await git(saved.root, ['rev-parse', 'HEAD']) } };
  }
}
