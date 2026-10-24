import { createHash } from 'node:crypto';
import type { ExecutionRequest, ExecutionUpdate } from './types.js';
import type { ProviderDriver } from './provider-instances.js';
import { nativeObservedRunId, type NativeObservedUpdate } from './native-runtime-types.js';

type Slot = { nativeId: string; key: string; controller: AbortController; ready: Promise<ExecutionRequest>; done: Promise<void>; resolve(): void; started: boolean; completed: boolean; result: string };
const observedKinds = new Set(['contextUsage', 'item', 'commandOutput', 'output', 'nativeHead', 'ready', 'backgroundWaiting', 'approval', 'approvalResolved', 'event']);

/** Observe a turn the provider started itself. The existing Durable native-turn
 * task persists its identity and recovery. This class never sends a prompt. */
export class NativeTurnObserver {
  private slots = new Map<string, Slot>();
  private closed = false;
  private closing!: () => void;
  private readonly closeSignal = new Promise<void>(resolve => { this.closing = resolve; });
  constructor(private provider: ProviderDriver, private source: () => ExecutionRequest, readonly sessionId: string, readonly threadId: string) {}
  has(key: string) { return [...this.slots.values()].some(slot => slot.key === key && !slot.completed); }
  nativeId(key: string) { return [...this.slots.values()].find(slot => slot.key === key)?.nativeId; }
  async open(nativeId: string): Promise<ExecutionRequest> {
    if (!nativeId || nativeId.length > 2000 || /[\x00-\x1f]/.test(nativeId)) throw new Error('原生后续轮次标识无效');
    const found = this.slots.get(nativeId); if (found) return found.ready;
    if (this.closed) throw new Error('原生后续连接已关闭');
    const source = this.source(), providerInstanceId = source.task.providerInstanceId ?? this.provider;
    const key = 'observed:' + createHash('sha256').update(JSON.stringify([this.provider, this.sessionId, nativeId])).digest('hex');
    let resolve!: () => void; const done = new Promise<void>(yes => { resolve = yes; });
    const slot: Slot = { nativeId, key, controller: new AbortController(), ready: undefined!, done, resolve, started: false, completed: false, result: '' };
    this.slots.set(nativeId, slot);
    const scope = { provider: this.provider, providerInstanceId, threadId: this.threadId, sessionId: this.sessionId, key };
    slot.ready = (async () => {
      await Promise.race([source.finalized ?? Promise.resolve(), this.closeSignal]);
      if (this.closed || slot.completed) throw new Error('原生连接已关闭，未启动后续观察');
      await source.update({ kind: 'nativeTurnStart', ...scope, turnId: nativeId, parameters: { cwd: source.task.cwd, mode: source.task.mode, interactionMode: source.task.interactionMode, ...(source.task.model ? { model: source.task.model } : {}), ...(source.task.reasoningEffort ? { reasoningEffort: source.task.reasoningEffort } : {}), modelOptions: source.task.modelOptions ?? [] } });
      slot.started = true;
      if (this.closed || slot.completed) {
        await source.update({ kind: 'nativeTurnFinish', ...scope, status: 'interrupted', result: slot.result, error: '原生连接在观察登记期间关闭，未重放执行' });
        throw new Error('原生连接已关闭');
      }
      const update = async (value: ExecutionUpdate) => {
        if (slot.completed || this.closed) return;
        if (value.kind === 'subagent' || value.kind === 'subagentBackground') { await source.update(value); return; }
        if (!observedKinds.has(value.kind)) throw new Error('原生观察不能创建新的执行会话或重发输入');
        if (value.kind === 'output') slot.result = value.text;
        await source.update({ kind: 'nativeTurnUpdate', ...scope, value: value as NativeObservedUpdate });
      };
      return { ...source, task: { ...source.task, currentRunId: nativeObservedRunId(key), threadId: this.threadId, turnId: nativeId, executionSessionId: this.sessionId }, signal: slot.controller.signal, update, beforeStart: undefined, finalized: Promise.resolve(), taskMcp: undefined, command: undefined, prompt: '' };
    })();
    void slot.ready.catch(() => { slot.completed = true; slot.resolve(); });
    return slot.ready;
  }
  async finish(nativeId: string, status: 'completed' | 'failed' | 'interrupted', result?: string, error?: string) {
    const slot = this.slots.get(nativeId); if (!slot || slot.completed) return;
    try {
      const request = await slot.ready;
      const providerInstanceId = request.task.providerInstanceId ?? this.provider;
      await this.source().update({ kind: 'nativeTurnFinish', provider: this.provider, providerInstanceId, threadId: this.threadId, sessionId: this.sessionId, key: slot.key, status, result: result ?? slot.result, ...(error ? { error } : {}) });
    } finally { slot.completed = true; slot.controller.abort(); slot.resolve(); }
  }
  async wait(key: string, signal: AbortSignal) {
    const slot = [...this.slots.values()].find(slot => slot.key === key); if (!slot) throw new Error('原生后续连接不可用');
    signal.throwIfAborted(); if (slot.completed) return;
    let abort!: () => void;
    try { await Promise.race([slot.done, new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('原生后续观察已取消')); signal.addEventListener('abort', abort, { once: true }); })]); }
    finally { if (abort) signal.removeEventListener('abort', abort); }
  }
  async close() {
    if (this.closed) return; this.closed = true; this.closing();
    await Promise.allSettled([...this.slots.values()].map(async slot => {
      if (slot.completed) return;
      try { if (slot.started) await this.source().update({ kind: 'nativeTurnFinish', provider: this.provider, providerInstanceId: this.source().task.providerInstanceId ?? this.provider, threadId: this.threadId, sessionId: this.sessionId, key: slot.key, status: 'interrupted', result: slot.result, error: '原生连接已中断，未自动重放后续执行' }); }
      finally { slot.completed = true; slot.controller.abort(); slot.resolve(); }
    }));
  }
}
