import { isolatedTextGeneration } from './native-text-generation.js';
import { MuseConnection } from './muse-provider.js';
import { MuseSessions } from './muse-sessions.js';
import type { NativeSessionIdlePolicy } from './native-session-idle.js';
import type { ExecutionImage, ExecutionRequest, Executor, WorkItem } from './types.js';
import type { ApprovalDecision } from './provider-approvals.js';

// Native control behavior follows T3 8cd9641f provider-muse/adapter and protocol.
// MIT Copyright (c) 2026 T3 Tools Inc.; full license: vendor/t3code/LICENSE.
export { museApprovalChoices, museQuestionAnswers } from './muse-interactions.js';

export class MuseExecutor implements Executor {
  private sessions: MuseSessions;
  constructor(private connection: MuseConnection, idlePolicy?: NativeSessionIdlePolicy) { this.sessions = new MuseSessions(connection, idlePolicy); }
  supportsTaskTools(agent: string) { return agent === 'muse'; }
  deferredStart(agent: string) { return agent === 'muse'; }
  async generateText(request: import('./types.js').TextGenerationRequest) { return this.run(request); }
  async run(request: ExecutionRequest): Promise<string> { return request.purpose ? isolatedTextGeneration(request, prepared => this.sessions.run(prepared)) : this.sessions.run(request); }
  validateAnswer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) { this.sessions.validateAnswer(id, approvalId, decision, answers); }
  answer(id: string, approvalId: string, decision: ApprovalDecision, answers: Record<string, string[]>) { return this.sessions.answer(id, approvalId, decision, answers); }
  steer(id: string, text: string, requestId: string, images?: ExecutionImage[]) { return this.sessions.steer(id, text, requestId, images); }
  hasSession(id: string) { return this.sessions.hasSession(id); }
  waitNativeTurn(id: string, sessionId: string, key: string, signal: AbortSignal) { return this.sessions.waitNativeTurn(id, sessionId, key, signal); }
  interruptNativeTurn(id: string, sessionId: string, key: string) { return this.sessions.interruptNativeTurn(id, sessionId, key); }
  stopNativeSession(id: string, sessionId: string) { return this.sessions.stopNativeSession(id, sessionId); }
  settleNativeBackground(task: WorkItem) { return this.sessions.settleNativeBackground(task); }
  interruptExecution(task: WorkItem, runId: string) { return this.sessions.interruptExecution(task, runId); }
  async close() { await this.sessions.close(); await this.connection.close(); }
}
