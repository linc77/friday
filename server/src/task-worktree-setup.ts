// Presentation semantics follow T3 Code 8cd9641f WorktreeSetupTracker and
// client-runtime/worktreeSetup. Execution remains in Friday's existing Durable tasks.
import type { WorkItem, Workspace } from './types.js';
import type { ProjectScriptRun } from './project-script-types.js';
import { projectScriptProgress } from './project-script-progress.js';
export type WorktreeSetupStage = {
  id: 'fetch' | 'checkout' | 'submodules' | 'setup-script' | 'agent'; status: 'pending' | 'running' | 'done' | 'skipped' | 'warning' | 'failed';
  startedAt: string | null; endedAt: string | null; percent: number | null; detail: string | null; tail: string[];
};
export type WorktreeSetupSnapshot = {
  threadId: string; runId: string; attempt: number; phase: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: string; endedAt: string | null; branch: string | null; baseRef: string | null; worktreePath: string | null;
  setupScript: { runId: string; name: string; command: string; terminalId: string } | null;
  stages: WorktreeSetupStage[]; error: string | null; sequence: number;
};
const clamp = (text: string, length: number) => Buffer.from(text.length <= length ? text : text.slice(0, length - 1) + '…', 'utf8').toString('utf8');
const active = (script: ProjectScriptRun | undefined) => script && ['queued','running'].includes(script.status);
/** Output is an authenticated projection of the captured terminal generation.
 * No terminal transcript or output tail is added to the Durable root projection. */
export function worktreeSetupSnapshot(state: Workspace, task: WorkItem, readTail?: (run: ProjectScriptRun) => { text: string; sequence: number; shell?: string } | undefined): WorktreeSetupSnapshot | null {
  if (task.agent === 'friday') return null;
  const candidates = (task.runs ?? []).filter(run => run.workspacePreparation && !run.revertedAt && !run.inheritedFrom && !run.executionExcludedAt);
  const scriptFor = (run: typeof candidates[number]) => {
    const preparation = run.workspacePreparation!;
    return state.projectScriptRuns?.find(script => script.taskId === task.id && script.trigger === 'setup' &&
      (preparation.setupRunId !== undefined ? script.id === preparation.setupRunId : script.requestId === 'setup-' + task.id + '-' + run.id + (preparation.attempt > 1 ? '-attempt-' + preparation.attempt : '')));
  };
  const run = candidates.findLast(run => active(scriptFor(run))) ?? candidates.at(-1);
  const plan = task.executionWorkspace;
  if (!run || !plan) return null;
  const preparation = run.workspacePreparation!, script = scriptFor(run), output = script ? readTail?.(script) : undefined;
  const checkoutEnd = plan.checkout?.completedAt ?? preparation.checkoutCompletedAt ?? (preparation.status === 'ready' ? preparation.completedAt : undefined);
  const agentStarted = run.startedAt ?? (run.before ? run.at : undefined);
  const cancelled = !!preparation.cancelRequestedAt || preparation.status === 'cancelled' || run.status === 'cancelled' && !agentStarted;
  const failed = preparation.status === 'failed' || run.status === 'failed' && !agentStarted || script && !active(script) && script.status !== 'completed' && script.script.async === false && !agentStarted;
  const phase = cancelled ? 'cancelled' : failed ? 'failed' : active(script) || !agentStarted ? 'running' : 'done';
  // T3 keeps an async setup visible after agent handoff. A successful completed
  // setup disappears after the turn starts; failures remain until a follow-up.
  if (phase !== 'running' && task.currentRunId !== run.id) return null;
  if (phase === 'done' && agentStarted && plan.submodules?.status !== 'warning' && !['failed','interrupted','cancelled'].includes(script?.status ?? '')) return null;
  const checkoutStatus = checkoutEnd ? 'done' : cancelled ? 'skipped' : plan.fetch && !['done','skipped'].includes(plan.fetch.status) ? 'pending' : preparation.status === 'failed' ? 'failed' : 'running';
  const scriptStatus = script ? script.status === 'queued' ? 'pending' : script.status === 'running' ? 'running' : script.status === 'completed' ? 'done' : script.status === 'cancelled' && cancelled ? 'skipped' : 'failed'
    : preparation.setupResolvedAt || plan.mode !== 'worktree' || cancelled ? 'skipped' : 'pending';
  const agentStatus = agentStarted ? 'done' : cancelled ? 'skipped' : failed && checkoutEnd && (!script || script.status === 'completed') ? 'failed' : checkoutEnd && (!script || script.script.async !== false || script.status === 'completed') && (preparation.setupResolvedAt || plan.mode !== 'worktree') ? 'running' : 'pending';
  const stage = (id: WorktreeSetupStage['id'], status: WorktreeSetupStage['status'], start?: string, end?: string, detail?: string, tail: string[] = []): WorktreeSetupStage => ({ id, status, startedAt: start ?? null, endedAt: end ?? null, percent: null, detail: detail ? clamp(detail, 200) : null, tail });
  return {
    threadId: task.id, runId: run.id, attempt: preparation.attempt, phase, startedAt: preparation.startedAt,
    endedAt: phase === 'running' ? null : [preparation.completedAt, script?.completedAt, agentStarted].filter((value): value is string => !!value).sort().at(-1) ?? task.updatedAt,
    branch: plan.targetBranch ?? plan.branch?.replace(/^refs\/heads\//, '') ?? null,
    baseRef: plan.branch?.replace(/^refs\/heads\//, '') ?? plan.commit ?? null, worktreePath: checkoutEnd ? plan.root : null,
    setupScript: script ? { runId: script.id, name: script.script.name, command: script.script.command, terminalId: script.terminalId } : null,
    stages: [...(plan.mode === 'worktree' && plan.startFromOrigin !== undefined ? [stage('fetch', plan.fetch?.status === 'running' && cancelled ? 'skipped' : plan.fetch?.status ?? (cancelled ? 'skipped' : 'pending'), plan.fetch?.startedAt, plan.fetch?.completedAt, plan.fetch?.detail)] : []),
      stage('checkout', checkoutStatus, plan.checkout?.startedAt ?? preparation.startedAt, checkoutEnd),
      ...(plan.submodules ? [stage('submodules', plan.submodules.status === 'running' && cancelled ? 'skipped' : plan.submodules.status, plan.submodules.startedAt, plan.submodules.completedAt, plan.submodules.detail)] : []),
      stage('setup-script', scriptStatus, script?.startedAt ?? script?.createdAt, script?.completedAt,
        script?.exitCode !== undefined ? `exit ${script.exitCode ?? 'unknown'}` : script?.error, output ? projectScriptProgress(output.text.slice(0, Math.max(output.text.lastIndexOf('\n'), output.text.lastIndexOf('\r')) + 1), script?.script.command, output.shell).split('\n').filter(Boolean).slice(-4).map(line => clamp(line, 400)) : []),
      stage('agent', agentStatus, agentStarted ?? (checkoutEnd && preparation.setupResolvedAt ? preparation.setupResolvedAt : undefined), agentStarted)],
    error: failed ? clamp(preparation.error ?? script?.error ?? task.error ?? '工作区准备失败', 1000) : null,
    sequence: state.revision + (output?.sequence ?? 0),
  };
}
