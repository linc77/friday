import { createHash } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { parseCodexFeedbackCommand } from './codex-goals.js';
export type TaskFeedbackReceipt = { requestId: string; taskId: string; threadId: string; digest: string; durableId: number; command: string; reason?: string; status: 'queued' | 'uploading' | 'sent' | 'uncertain' | 'failed'; createdAt: string; completedAt?: string; feedbackId?: string; error?: string };
type Input = { requestId: string };
const pending = (value: TaskFeedbackReceipt) => value.status === 'queued' || value.status === 'uploading';
export class TaskFeedback {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'upload' }, { status: string }, {}>({
      name: 'friday.task_feedback', version: 1, initial: () => ({ phase: 'upload' }),
      phases: { upload: async (task, runtime, ctx) => {
        const id = task.input.requestId;
        const feedbackId = await runtime.memo<string>('result', ctx);
        if (feedbackId) await this.finish(id, { status: 'sent', feedbackId });
        else if (await runtime.memo<boolean>('started', ctx)) await this.finish(id, { status: 'uncertain', error: '提交曾中断，反馈可能已经送达。不会自动重复上传。' });
        else {
          try {
            const state = await engine.snapshot(), receipt = state.taskFeedbackRequests?.[id], work = state.tasks.find(value => value.id === receipt?.taskId);
            if (!receipt || !work || work.threadId !== receipt.threadId || work.agent !== 'codex' || work.archivedAt || !engine.executor.uploadFeedback) throw new Error('会话已改变，无法提交这条反馈');
            await this.finish(id, { status: 'uploading' });
            runtime.signal.throwIfAborted(); await runtime.memo('started', true, ctx); runtime.signal.throwIfAborted();
            const result = await engine.executor.uploadFeedback(work, receipt.reason, runtime.signal);
            await runtime.memo('result', result, ctx); await this.finish(id, { status: 'sent', feedbackId: result });
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            await this.finish(id, { status: await runtime.memo<boolean>('started', ctx) ? 'uncertain' : 'failed', error: error instanceof Error ? error.message : '反馈提交失败' });
          }
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
      } },
      abort: async (task, runtime, ctx) => { const feedbackId = await runtime.memo<string>('result', ctx); await this.finish(task.input.requestId, feedbackId ? { status: 'sent', feedbackId } : { status: 'uncertain', error: '提交中断，反馈结果尚未确认。不会自动重复上传。' }); await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx); },
    });
  }
  async start(taskId: string, input: { threadId: string; command: string; requestId: string }) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.requestId) || ['constructor','prototype','__proto__'].includes(input.requestId)) throw new Error('反馈请求 ID 无效');
    const parsed = parseCodexFeedbackCommand(input.command); if (!parsed || input.command.length > 12_000) throw new Error('反馈命令无效');
    const digest = createHash('sha256').update(JSON.stringify({ taskId, threadId: input.threadId, ...parsed })).digest('hex');
    let receipt!: TaskFeedbackReceipt;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); state.taskFeedbackRequests ??= {};
      const previous = state.taskFeedbackRequests[input.requestId];
      if (previous) { if (previous.digest !== digest) throw new Error('反馈请求 ID 已用于其他提交'); receipt = JSON.parse(JSON.stringify(previous)); return; }
      const work = state.tasks.find(value => value.id === taskId);
      if (!work || work.agent !== 'codex' || work.subagentOrigin || !work.threadId || work.threadId !== input.threadId || work.archivedAt) throw new Error('请先开始一条 Codex 会话后提交反馈');
      if (Object.values(state.taskFeedbackRequests).some(value => value.taskId === taskId && pending(value))) throw new Error('这条会话正在提交反馈');
      const durableId = await tx.createTask(this.definition, { requestId: input.requestId }, { ownership: { kind: 'conversation' } });
      receipt = { ...input, ...parsed, taskId, digest, durableId, createdAt: new Date().toISOString(), status: 'queued' };
      state.taskFeedbackRequests[input.requestId] = receipt; work.feedback = [...(work.feedback ?? []).slice(-19), receipt];
      work.messages ??= []; work.messages.push({ id: `feedback-user-${input.requestId}`, role: 'user', text: input.command, at: receipt.createdAt });
      await this.engine.taskHistory.persist(tx, work); state.revision++;
    }, context);
    if (pending(receipt)) { this.engine.harness.resume(); await this.engine.harness.waitForTask(receipt.durableId as TaskId, context); }
    return (await this.engine.snapshot()).taskFeedbackRequests?.[input.requestId] ?? receipt;
  }
  private async finish(id: string, change: Partial<TaskFeedbackReceipt>) {
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc);
      const receipt = state.taskFeedbackRequests?.[id]; if (!receipt || !pending(receipt)) return;
      Object.assign(receipt, change, change.status === 'uploading' ? {} : { completedAt: new Date().toISOString() });
      const work = state.tasks.find(value => value.id === receipt.taskId), index = work?.feedback?.findIndex(value => value.requestId === id);
      if (work?.feedback && index !== undefined && index >= 0) work.feedback[index] = JSON.parse(JSON.stringify(receipt));
      if (work && change.status !== 'uploading') {
        const messageId = `feedback-result-${id}`;
        const text = receipt.status === 'sent' ? `Feedback sent to OpenAI.\n\nThread ID: \`${receipt.feedbackId}\`` : `Could not confirm feedback delivery.\n\n${receipt.error ?? ''}`;
        work.messages ??= []; if (!work.messages.some(value => value.id === messageId)) work.messages.push({ id: messageId, role: 'assistant', text, at: receipt.completedAt! });
      }
      if (work) await this.engine.taskHistory.persist(tx, work); state.revision++;
    }, context);
  }
}
