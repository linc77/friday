import { providerInstanceID } from './provider-instances.js';
import { randomUUID } from 'node:crypto';
import { defineTask, type TaskId } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { providerDigest, ProviderResetError, type ProviderResetOutcome, type ProviderResetScope, type ProviderUsageLimits } from './provider-usage-limits.js';

type Status = 'queued' | 'running' | 'completed' | 'uncertain' | 'rejected';
export type ProviderCreditReset = { requestId: string; digest: string; scope: ProviderResetScope; durableId: number; status: Status; createdAt: string; completedAt?: string; nativeCreditId?: string; outcome?: ProviderResetOutcome; error?: string; warning?: string; limits?: ProviderUsageLimits };
export type ProviderCreditAccount = { tail: number; pendingKey?: string; pendingCreditId?: string; pendingUncertain?: boolean };
type Input = { requestId: string; scope: ProviderResetScope; predecessor: number | null };
type Change = { provider: string; providerInstanceId?: string; fingerprint: string; requestId: string; confirmed: boolean };
const stamp = () => new Date().toISOString();
const live = (status: Status) => status === 'queued' || status === 'running';

/** Account serialization and recovery belong to the existing Pi Durable
 * engine. A lost native answer keeps its account key for the next explicit
 * request; recovery never reissues the external consumption automatically. */
export class ProviderCreditResets {
  readonly definition;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<Input, { phase: 'wait' | 'consume' }, { status: string }, {}>({
      name: 'friday.provider_credit_reset', version: 1, initial: () => ({ phase: 'wait' }),
      phases: {
        wait: async (task, runtime, ctx) => {
          await runtime.commit(() => task.input.predecessor === null
            ? { status: 'running', checkpoint: { phase: 'consume' } }
            : { status: 'waiting', checkpoint: { phase: 'consume' }, on: [task.input.predecessor as TaskId], policy: 'allSettled' }, ctx);
        },
        consume: async (task, runtime, ctx) => {
          const input = task.input;
          let key = await runtime.memo<string>('key', ctx), outcome = await runtime.memo<ProviderResetOutcome>('outcome', ctx);
          if (outcome) { await this.finish(input, 'completed', key, { outcome, warning: '重置结果已保存，配额刷新暂未成功；请稍后刷新，不要重复消费。' }, true); await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx); return; }
          if (await runtime.memo<boolean>('started', ctx)) {
            await this.finish(input, 'uncertain', key, { error: '重置结果尚未确认，请先检查。重试会查询同一个重置请求。' });
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'uncertain' } } }), ctx); return;
          }
          try {
            let creditId: string | undefined;
            await engine.mutate(state => {
              const receipt = state.providerCreditResets?.[input.requestId], account = state.providerCreditAccounts?.[input.scope.accountKey];
              if (!receipt || !account) throw new Error('Reset scope missing');
              if (!account.pendingKey) { account.pendingKey = randomUUID(); delete account.pendingUncertain; if (input.scope.creditId) account.pendingCreditId = input.scope.creditId; else delete account.pendingCreditId; }
              key = account.pendingKey; creditId = account.pendingCreditId; receipt.status = 'running'; if (creditId) receipt.nativeCreditId = creditId;
            });
            await runtime.memo('key', key!, ctx); if (creditId) await runtime.memo('creditId', creditId, ctx); await runtime.memo('started', true, ctx);
            const connection = await engine.providerInstances.get(input.scope.provider, input.scope.providerInstanceId ?? input.scope.provider, true);
            outcome = await connection.consumeResetCredit({ ...input.scope, ...(creditId ? { creditId } : {}) }, key!);
            await runtime.memo('outcome', outcome, ctx);
            await engine.mutate(state => { const receipt = state.providerCreditResets?.[input.requestId]; if (receipt) receipt.outcome = outcome; });
            try {
              const limits = await connection.usageLimits(true);
              if (limits.credentialFingerprint === input.scope.fingerprint) {
                await engine.mutate(state => {
                  const receipt = state.providerCreditResets?.[input.requestId]; if (receipt) receipt.limits = limits;
                });
                await engine.publishProviderUsage(input.scope.providerInstanceId ?? input.scope.provider, limits, connection.usageIdentity?.(limits.credentialFingerprint));
              }
            } catch { await engine.mutate(state => { const receipt = state.providerCreditResets?.[input.requestId]; if (receipt) receipt.warning = '重置结果已保存，配额刷新暂未成功；请稍后刷新，不要重复消费。'; }); }
            await this.finish(input, 'completed', key, { outcome }, true);
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'completed' } } }), ctx);
          } catch (error) {
            if (runtime.signal.aborted) throw error;
            const settled = error instanceof ProviderResetError && error.settled;
            await this.finish(input, settled ? 'rejected' : 'uncertain', key, { error: error instanceof ProviderResetError ? error.message : '重置结果尚未确认，请先检查。重试会查询同一个重置请求。' }, settled);
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: settled ? 'rejected' : 'uncertain' } } }), ctx);
          }
        },
      },
      abort: async (task, runtime, ctx) => {
        const key = await runtime.memo<string>('key', ctx);
        const outcome = await runtime.memo<ProviderResetOutcome>('outcome', ctx);
        await this.finish(task.input, outcome ? 'completed' : 'uncertain', key, outcome ? { outcome } : { error: '重置请求曾中断，请检查结果后重试。' }, !!outcome);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: outcome ? 'completed' : 'uncertain' } } }), ctx);
      },
    });
  }
  async start(change: Change) {
    if (!['codex', 'claude'].includes(change.provider) || change.confirmed !== true || !/^[a-f0-9]{64}$/.test(change.fingerprint) || !/^[A-Za-z0-9_-]{1,100}$/.test(change.requestId) || ['__proto__', 'constructor', 'prototype'].includes(change.requestId)) throw new Error('请确认账号和重置信息后重试。');
    const id = providerInstanceID(change.providerInstanceId ?? change.provider);
    const digest = providerDigest([change.provider, change.fingerprint, ...(id !== change.provider ? [id] : [])]);
    const existing = (await this.engine.snapshot()).providerCreditResets?.[change.requestId];
    if (existing) { if (existing.digest !== digest) throw new Error('重置请求 ID 已用于其他账号。'); return this.result(existing); }
    const connection = await this.engine.providerInstances.get(change.provider as 'codex' | 'claude', id, true);
    const scope = { ...await connection.resetScope(), ...(id !== change.provider ? { providerInstanceId: id } : {}) }; if (scope.fingerprint !== change.fingerprint) throw new Error('账号已经改变，请刷新配额后重新确认。');
    let receipt!: ProviderCreditReset;
    await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); state.providerCreditResets ??= {}; state.providerCreditAccounts ??= {};
      const previous = state.providerCreditResets[change.requestId]; if (previous) { if (previous.digest !== digest) throw new Error('重置请求 ID 已用于其他账号。'); receipt = JSON.parse(JSON.stringify(previous)); return; }
      const account = state.providerCreditAccounts[scope.accountKey];
      const predecessor = account && Object.values(state.providerCreditResets).some(value => value.durableId === account.tail && live(value.status)) ? account.tail : null;
      const durableId = await tx.createTask(this.definition, { requestId: change.requestId, scope, predecessor }, { ownership: { kind: 'conversation' } });
      receipt = { requestId: change.requestId, digest, scope, durableId, status: 'queued', createdAt: stamp() };
      state.providerCreditResets[change.requestId] = receipt;
      if (account) account.tail = durableId; else state.providerCreditAccounts[scope.accountKey] = { tail: durableId };
      state.revision++;
    }, context);
    return this.result(receipt);
  }
  private async result(receipt: ProviderCreditReset) {
    if (live(receipt.status)) { this.engine.harness.resume(); await this.engine.harness.waitForTask(receipt.durableId as TaskId, context); }
    const latest = (await this.engine.snapshot()).providerCreditResets?.[receipt.requestId] ?? receipt;
    const { requestId, status, outcome, error, warning, limits } = latest;
    return { requestId, status, ...(outcome ? { outcome } : {}), ...(error ? { error } : {}), ...(warning ? { warning } : {}), ...(limits ? { limits } : {}) };
  }
  private async finish(input: Input, status: Status, key: string | undefined, update: Partial<ProviderCreditReset>, settled = false) {
    await this.engine.mutate(state => {
      const receipt = state.providerCreditResets?.[input.requestId]; if (!receipt || !live(receipt.status)) return;
      Object.assign(receipt, update, { status, completedAt: stamp() });
      const account = state.providerCreditAccounts?.[input.scope.accountKey];
      if (key && account?.pendingKey === key) {
        if (status === 'uncertain') account.pendingUncertain = true;
        // A later preflight refusal cannot prove an earlier unknown spend
        // failed. Only the provider's explicit outcome resolves that intent.
        if (settled && (status === 'completed' || !account.pendingUncertain)) { delete account.pendingKey; delete account.pendingCreditId; delete account.pendingUncertain; }
      }
    });
  }
}
