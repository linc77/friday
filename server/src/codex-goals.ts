// Command parsing and the five-second continuation hold follow T3 Code
// 8cd9641f, CodexAdapterV2.ts. Copyright (c) 2026 T3 Tools Inc., MIT;
// the complete license is included in vendor/t3-claude-skill-dispatch.ts.
export type CodexGoalCommand = { type: 'show' | 'clear' | 'pause' | 'resume' } | { type: 'set'; objective: string };
export type TaskGoal = { objective: string; status: 'active' | 'paused' | 'blocked' | 'usage_limited' | 'budget_limited' | 'complete'; tokensUsed: number; timeUsedSeconds: number; tokenBudget?: number | null };
export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  switch (argument.toLowerCase()) {
    case '': case 'edit': return { type: 'show' };
    case 'clear': return { type: 'clear' };
    case 'pause': return { type: 'pause' };
    case 'resume': return { type: 'resume' };
    default: return { type: 'set', objective: argument };
  }
}
export function codexGoal(value: unknown): TaskGoal | null {
  if (value === null) return null;
  const goal = value as Record<string, unknown> | undefined;
  const statuses = { active: 'active', paused: 'paused', blocked: 'blocked', usageLimited: 'usage_limited', budgetLimited: 'budget_limited', complete: 'complete' } as const;
  if (!goal || typeof goal.objective !== 'string' || !goal.objective.trim() || typeof goal.status !== 'string' || !Object.hasOwn(statuses, goal.status)
      || typeof goal.tokensUsed !== 'number' || !Number.isFinite(goal.tokensUsed) || typeof goal.timeUsedSeconds !== 'number' || !Number.isFinite(goal.timeUsedSeconds)
      || goal.tokenBudget !== undefined && goal.tokenBudget !== null && (typeof goal.tokenBudget !== 'number' || !Number.isFinite(goal.tokenBudget) || goal.tokenBudget <= 0)) throw new Error('Codex 返回了无效的目标状态');
  return { objective: goal.objective.trim(), status: statuses[goal.status as keyof typeof statuses], tokensUsed: Math.max(0, goal.tokensUsed), timeUsedSeconds: Math.max(0, goal.timeUsedSeconds), ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget as number | null } : {}) };
}
export function parseCodexFeedbackCommand(text: string): { reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const reason = match[1]?.trim(); return reason ? { reason } : {};
}
