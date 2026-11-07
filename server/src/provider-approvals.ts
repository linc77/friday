// Approval choices and Claude session updates follow T3 Code 8cd9641f,
// CodexAdapterV2 / ClaudeAdapterV2. MIT, Copyright (c) 2026 T3 Tools Inc.;
// complete license in provider-usage-limits.ts.
import type { PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
export const permissionDecisions: ApprovalDecision[] = ['cancel', 'decline', 'acceptForSession', 'accept'];
export const isApprovalDecision = (value: unknown): value is ApprovalDecision => typeof value === 'string' && [...permissionDecisions, 'acceptAlways'].includes(value as ApprovalDecision);
export type CodexApprovalKind = 'command' | 'file-change';
export const codexApprovalKind = (method: string): CodexApprovalKind | undefined => ['item/commandExecution/requestApproval','execCommandApproval'].includes(method) ? 'command' : ['item/fileChange/requestApproval','applyPatchApproval'].includes(method) ? 'file-change' : undefined;
export const codexPermissionResponse = (permissions: unknown, decision: ApprovalDecision) => decision === 'accept' || decision === 'acceptForSession' ? { permissions, scope: decision === 'acceptForSession' ? 'session' : 'turn' } : { permissions: {}, scope: 'turn' };
export const codexLegacyDecision = (decision: ApprovalDecision) => decision === 'accept' ? 'approved' : decision === 'acceptForSession' || decision === 'acceptAlways' ? 'approved_for_session' : decision === 'cancel' ? 'abort' : { denied: { rejection: 'User declined the request.' } };
export type CodexApprovalScope = { allows: (kind: CodexApprovalKind) => boolean; grant: (kind: CodexApprovalKind) => void };
export class CodexSessionApprovals {
  private sessions = new Map<string, { generation: string; kinds: Set<CodexApprovalKind> }>();
  capture(taskId: string, threadId: string, generation: string): CodexApprovalScope {
    const key = taskId + '\0' + threadId;
    let current = this.sessions.get(key);
    if (!current || current.generation !== generation) { current = { generation, kinds: new Set() }; this.sessions.set(key,current); }
    const captured = current;
    return { allows: kind => this.sessions.get(key) === captured && captured.kinds.has(kind), grant: kind => { if (this.sessions.get(key) === captured) captured.kinds.add(kind); } };
  }
  clearTask(taskId: string) { for (const key of this.sessions.keys()) if (key.startsWith(taskId + '\0')) this.sessions.delete(key); }
  clear() { this.sessions.clear(); }
}
export function claudePermissionResult(input: { toolName: string; toolUseID: string; toolInput: Record<string, unknown>; suggestions?: PermissionUpdate[]; decision: ApprovalDecision }): PermissionResult {
  if (input.decision === 'accept' || input.decision === 'acceptForSession') {
    return { behavior: 'allow', updatedInput: input.toolInput, toolUseID: input.toolUseID, decisionClassification: input.decision === 'acceptForSession' ? 'user_permanent' : 'user_temporary',
      ...(input.decision === 'acceptForSession' ? { updatedPermissions: input.suggestions?.length ? input.suggestions.map(suggestion => ({ ...suggestion, destination: 'session' as const })) : [{ type: 'addRules' as const, rules: [{ toolName: input.toolName }], behavior: 'allow' as const, destination: 'session' as const }] } : {}) };
  }
  return { behavior: 'deny', message: input.decision === 'cancel' ? 'User cancelled tool execution.' : 'User declined tool execution.', toolUseID: input.toolUseID, decisionClassification: 'user_reject', ...(input.decision === 'cancel' ? { interrupt: true } : {}) };
}
export class TaskExecutionCancelled extends Error { constructor() { super('用户取消了本次执行'); this.name = 'TaskExecutionCancelled'; } }
export type ApprovalResponseReceipt = { taskId: string; approvalId: string; digest: string; decision: ApprovalDecision; status: 'sending' | 'sent' | 'uncertain'; createdAt: string };
