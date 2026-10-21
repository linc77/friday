import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { IPty, IDisposable } from 'node-pty';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import { TerminalStore } from './terminal-store.js';
import { terminalID, terminalRequestID, terminalSize, type TaskTerminalSummary, type TerminalEvent, type TerminalOperation } from './terminal-types.js';
import { terminalDescendants, terminalEnvironment, terminalProcesses, terminalPty, terminalShell, stopTerminal } from './terminal-pty.js';
import { branchBlocksTask } from './branch-switch.js';
import type { TaskBrowserTerminalOwner } from './task-browser.js';
import { terminalProviderEnvironment } from './terminal-provider-environment.js';
import { verifyScratchWorkspace } from './managed-scratch-workspace.js';
import { verifyManagedProjectFolder } from './managed-project-folders.js';

type Live = { pty: IPty; generation: number; taskId: string; id: string; pending: Buffer[]; bytes: number; timer?: NodeJS.Timeout; listeners: IDisposable[]; exited: Promise<void>; done: () => void; closing: boolean; error?: string; stopped?: Promise<void> };
const key = (task: string, id: string) => task + '\0' + id;
const stamp = () => new Date().toISOString();
const safeTitle = (value: string) => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 128);

export class TaskTerminals {
  readonly store = new TerminalStore();
  readonly definition;
  private bootId = randomUUID();
  private live = new Map<string, Live>();
  private observers = new Map<string, Set<(event: TerminalEvent) => void>>();
  private locks = new Map<string, Promise<unknown>>();
  private deleting = new Set<string>();
  private failures = new Map<string, { generation: number; error: string }>();
  private stopping = false;
  private poll?: NodeJS.Timeout;
  private polling?: Promise<boolean>;
  constructor(private readonly engine: Engine) {
    this.definition = defineTask<TerminalOperation, { phase: 'execute' }, { status: string }, {}>({
      name: 'friday.terminal', version: 1, initial: () => ({ phase: 'execute' }),
      phases: { execute: async (task, runtime, ctx) => {
        const operation = task.input;
        const finish = async (status: string) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status } } }), ctx);
        const row = this.store.get(operation.taskId, operation.terminalId);
        if (!row || row.generation !== operation.generation) { await finish('superseded'); return; }
        if (operation.bootId !== this.bootId || await runtime.memo<boolean>('external-started', ctx)) {
          const owned = this.live.get(key(row.taskId, row.id));
          if (operation.bootId === this.bootId && owned?.generation === row.generation && !owned.closing && !owned.error && operation.action !== 'close') {
            this.update(row.taskId, row.id, operation.generation, { status: 'running', pid: owned.pty.pid }); await finish('completed'); return;
          }
          if (['exited', 'closed', 'error', 'interrupted'].includes(row.status)) { await finish(row.status); return; }
          this.update(row.taskId, row.id, operation.generation, { status: 'interrupted', pid: owned?.pty.pid ?? null, hasRunningSubprocess: !!owned, error: '终端操作曾中断，等待明确重新启动；不会自动重放。' });
          await finish('interrupted'); return;
        }
        try {
          await runtime.memo('external-started', true, ctx);
          await this.lock(operation.taskId, operation.terminalId, async () => {
            runtime.signal.throwIfAborted();
            if (operation.action === 'close') await this.performClose(operation.taskId, operation.terminalId, operation.generation, operation.deleteHistory);
            else await this.performStart(operation, runtime.signal);
          });
          await finish('completed');
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          const owned = this.live.get(key(row.taskId, row.id));
          if (owned?.generation === operation.generation) await this.stop(owned).catch(() => {});
          const remaining = this.live.get(key(row.taskId, row.id));
          this.update(row.taskId, row.id, operation.generation, { status: 'error', pid: remaining?.pty.pid ?? null, error: error instanceof Error ? error.message.slice(0, 500) : '终端启动失败', hasRunningSubprocess: !!remaining });
          await finish('error');
        }
      } },
      abort: async (task, runtime, ctx) => {
        await this.lock(task.input.taskId, task.input.terminalId, async () => {
          const live = this.live.get(key(task.input.taskId, task.input.terminalId));
          if (live?.generation === task.input.generation) await this.stop(live);
          this.update(task.input.taskId, task.input.terminalId, task.input.generation, { status: 'interrupted', pid: null, hasRunningSubprocess: false, error: '终端操作已中断；输入不会自动重放。' });
        });
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { status: 'interrupted' } } }), ctx);
      },
    });
  }
  async open() { await this.store.open(this.engine.directory); this.poll = setInterval(() => { void this.refreshProcesses(); }, 1000); this.poll.unref(); }
  private summary(row: TaskTerminalSummary) {
    const failed = this.failures.get(key(row.taskId, row.id)); const owned = this.live.get(key(row.taskId, row.id));
    return failed?.generation === row.generation ? { ...row, status: 'error' as const, error: failed.error, pid: owned?.pty.pid ?? null, hasRunningSubprocess: !!owned } : row;
  }
  summaries(taskId: string) { return this.store.list(taskId).map(row => this.summary(row)).filter(row => row.status !== 'closed'); }
  async browserProcessOwners(): Promise<ReadonlyMap<number, TaskBrowserTerminalOwner>> {
    const owners = new Map<number, TaskBrowserTerminalOwner>();
    if (this.stopping || !this.live.size) return owners;
    let rows: Awaited<ReturnType<typeof terminalProcesses>>;
    try { rows = await terminalProcesses(); } catch { return owners; }
    if (this.stopping) return owners;
    for (const live of this.live.values()) {
      const row = this.store.get(live.taskId, live.id);
      if (live.closing || live.error || !row || row.status !== 'running' || row.generation !== live.generation || row.pid !== live.pty.pid) continue;
      for (const child of terminalDescendants(rows, live.pty.pid)) owners.set(child.pid, { threadId: live.taskId, terminalId: live.id });
    }
    return owners;
  }
  private emit(taskId: string, id: string, event: TerminalEvent) { for (const listener of this.observers.get(key(taskId, id)) ?? []) { try { listener(event); } catch { this.observers.get(key(taskId, id))?.delete(listener); } } }
  private update(taskId: string, id: string, generation: number, change: Partial<TaskTerminalSummary>) {
    const row = this.store.get(taskId, id); if (!row || row.generation !== generation) return;
    Object.assign(row, change, { updatedAt: stamp() }); this.store.save(row);
    this.emit(taskId, id, { type: 'metadata', terminal: row, sequence: row.sequence, generation }); this.engine.emit('change');
  }
  private async lock<T>(taskId: string, id: string, operation: () => Promise<T>) {
    const idKey = key(taskId, id); const previous = this.locks.get(idKey) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(operation); this.locks.set(idKey, pending);
    try { return await pending; } finally { if (this.locks.get(idKey) === pending) this.locks.delete(idKey); }
  }
  async lifecycle(taskId: string, input: { terminalId: string; requestId: string; action: TerminalOperation['action']; cols?: number; rows?: number; shell?: string; force?: boolean; deleteHistory?: boolean }, scriptRunId?: string) {
    const id = terminalID(input.terminalId); const request = terminalRequestID(input.requestId); const size = terminalSize(input.cols, input.rows);
    if (this.stopping || this.deleting.has(taskId)) throw new Error('终端服务正在关闭');
    const existing = this.store.getOperation(request);
    if (existing) { if (existing.taskId !== taskId || existing.terminalId !== id || existing.action !== input.action) throw new Error('终端请求 ID 已被使用'); return this.store.get(taskId, id); }
    if (input.action !== 'open' && !await this.refreshProcesses() && this.live.has(key(taskId, id)) && !input.force) throw new Error('暂时无法核对终端中的程序，请确认停止后再操作');
    const shell = input.action === 'close' ? undefined : await terminalShell(input.shell);
    try { await this.engine.root.commit(async tx => {
      const state = await tx.doc(WorkspaceDoc); const work = state.tasks.find(task => task.id === taskId) ?? this.engine.projectScripts.terminalOwner(state, taskId);
      if (!work || 'agent' in work && work.agent === 'friday' || work.projectId === null) throw new Error('请先选择本地任务的工作区');
      if (input.action !== 'close' && 'agent' in work && (work.archivedAt || work.archiveCleanup?.status === 'pending')) throw new Error('请先恢复并完成归档清理，再打开终端');
      const receipt = this.store.getOperation(request); if (receipt) { if (receipt.taskId !== taskId || receipt.terminalId !== id || receipt.action !== input.action) throw new Error('终端请求 ID 已被使用'); return; }
      if (input.action !== 'close' && branchBlocksTask({ ...state, changeRequestCheckouts: state.changeRequestCheckouts?.filter(p => !('preparationId' in work && p.id === work.preparationId)) }, work.cwd)) throw new Error('工作区正在执行 Git、分支或回退操作，请稍后打开终端');
      let row = this.store.get(taskId, id);
      if (input.action === 'open' && row) { this.store.operation({ taskId, terminalId: id, requestId: request, action: 'open', generation: row.generation, bootId: this.bootId, force: false, deleteHistory: false }); return; }
      if (input.action !== 'open' && !row) throw new Error('终端不存在');
      if (input.action !== 'open' && row?.hasRunningSubprocess && !input.force) throw new Error('终端仍有程序正在运行，请确认停止后再操作');
      if (input.action !== 'close') {
        const cwd = await realpath(work.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error('终端目录不存在');
        if (this.summaries(taskId).length >= 16 && !row) throw new Error('每个任务最多打开 16 个终端');
        const reserved = this.store.list().filter(value => ['starting', 'running', 'closing'].includes(value.status) || this.live.has(key(value.taskId, value.id)));
        if (reserved.length >= 64 && !reserved.some(value => value.taskId === taskId && value.id === id)) throw new Error('同时打开的终端过多，请先关闭不用的终端');
        row = { id, taskId, generation: (row?.generation ?? 0) + 1, cwd, shell: shell!, label: row?.label ?? `Terminal ${this.summaries(taskId).length + 1}`, title: basename(shell!), status: 'starting', pid: null,
          ...size, sequence: 0, baseSequence: 1, hasRunningSubprocess: true, createdAt: row?.createdAt ?? stamp(), updatedAt: stamp() };
      } else row = { ...row!, status: 'closing', updatedAt: stamp() };
      const operation: TerminalOperation = { taskId, terminalId: id, requestId: request, action: input.action, generation: row.generation, bootId: this.bootId, force: input.force === true, deleteHistory: input.deleteHistory === true, ...(scriptRunId ? { scriptRunId } : {}) };
      this.store.save(row); this.store.operation(operation);
      try { await tx.createTask(this.definition, operation, { ownership: { kind: 'conversation' } }); }
      catch (error) { this.store.save({ ...row, status: 'error', error: '终端操作未能提交，未自动重试', hasRunningSubprocess: false }); throw error; }
    }, context); } catch (error) {
      const operation = this.store.getOperation(request); const row = operation && this.store.get(taskId, id);
      if (row && operation.bootId === this.bootId && row.generation === operation.generation && ['starting', 'closing'].includes(row.status)) this.update(taskId, id, row.generation, { status: 'error', error: '终端操作未能确认提交，请明确重新启动或关闭。' });
      throw error;
    }
    this.engine.emit('change'); this.engine.harness.resume(); return this.store.get(taskId, id);
  }
  private async performStart(operation: TerminalOperation, signal: AbortSignal) {
    const old = this.live.get(key(operation.taskId, operation.terminalId)); if (old) await this.stop(old);
    const module = await terminalPty(); signal.throwIfAborted();
    const row = this.store.get(operation.taskId, operation.terminalId);
    if (!row || row.generation !== operation.generation || row.status !== 'starting' || this.stopping || this.deleting.has(operation.taskId)) return;
    const state = await this.engine.snapshot(), task = state.tasks.find(task => task.id === operation.taskId);
    if(task?.executionWorkspace?.projectFolder)await verifyManagedProjectFolder(task.executionWorkspace.projectFolder,this.engine.directory);
    if (!operation.scriptRunId && task?.executionWorkspace?.scratch) {
      if (task.executionWorkspace.state !== 'ready') throw new Error('请先完成临时工作区准备再打开终端');
      if (row.cwd !== task.cwd || row.cwd !== task.executionWorkspace.cwd) throw new Error('临时任务目录已改变，请重新打开终端');
      await verifyScratchWorkspace(task.executionWorkspace);
    }
    const providerEnvironment = await terminalProviderEnvironment(this.engine.directory, task);
    signal.throwIfAborted();
    this.store.clear(row); row.sequence = 0; row.baseSequence = 1; this.store.save(row);
    const pty = module.spawn(row.shell, ['-l'], { name: 'xterm-256color', cols: row.cols, rows: row.rows, cwd: row.cwd, env: { ...terminalEnvironment(row.shell, row.cwd, this.bootId + ':' + row.id + ':' + row.generation), ...providerEnvironment, ...(operation.scriptRunId ? this.engine.projectScripts.runtimeEnvironment(state, operation.scriptRunId) : {}) }, encoding: null });
    let done!: () => void; const exited = new Promise<void>(resolve => { done = resolve; });
    const live: Live = { pty, generation: row.generation, taskId: row.taskId, id: row.id, pending: [], bytes: 0, listeners: [], exited, done, closing: false };
    this.live.set(key(row.taskId, row.id), live);
    live.listeners.push(pty.onData(data => {
      if (live.error) return;
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      live.pending.push(bytes); live.bytes += bytes.length;
      if (live.bytes >= 64 * 1024) this.flush(live);
      else live.timer ??= setTimeout(() => this.flush(live), 16);
    }));
    live.listeners.push(pty.onExit(result => {
      this.flush(live); live.done();
      if (this.live.get(key(row.taskId, row.id)) === live) this.live.delete(key(row.taskId, row.id));
      for (const listener of live.listeners) listener.dispose();
      try { this.update(row.taskId, row.id, row.generation, { status: live.error ? 'error' : live.closing ? 'closed' : 'exited', pid: null, hasRunningSubprocess: false, exitCode: result.exitCode, exitSignal: result.signal, ...(live.error ? { error: live.error } : {}) }); } catch { this.engine.emit('change'); /* Keep the in-memory failure visible if storage is full. */ }
    }));
    this.update(row.taskId, row.id, row.generation, { status: 'running', pid: pty.pid, hasRunningSubprocess: false });
    this.emit(row.taskId, row.id, this.snapshot(row.taskId, row.id));
  }
  private flush(live: Live) {
    if (live.timer) clearTimeout(live.timer); live.timer = undefined;
    if (!live.bytes || live.error) return;
    const data = Buffer.concat(live.pending); live.pending = []; live.bytes = 0;
    const row = this.store.get(live.taskId, live.id); if (!row || row.generation !== live.generation) return;
    try { for (let offset = 0; offset < data.length; offset += 16 * 1024) {
      const chunk = data.subarray(offset, offset + 16 * 1024); const sequence = this.store.output(row, chunk);
      this.emit(row.taskId, row.id, { type: 'output', data: chunk.toString('base64'), sequence, generation: row.generation });
    } } catch {
      live.error = '终端输出保存失败，已停止接收输入，请重新启动。';
      this.failures.set(key(live.taskId, live.id), { generation: live.generation, error: live.error });
      try { live.pty.pause(); } catch {}
      try { this.update(live.taskId, live.id, live.generation, { status: 'error', error: live.error, hasRunningSubprocess: true }); } catch {}
      this.engine.emit('change'); void this.stop(live).catch(() => {});
    }
  }
  snapshot(taskId: string, id: string): Extract<TerminalEvent, { type: 'snapshot' }> {
    const row = this.store.get(taskId, terminalID(id)); if (!row) throw new Error('终端不存在');
    const live = this.live.get(key(taskId, id)); if (live) this.flush(live);
    const current = this.summary(this.store.get(taskId, id)!);
    return { type: 'snapshot', terminal: current, history: Buffer.concat(this.store.history(current).map(frame => frame.data)).toString('base64'), sequence: current.sequence, generation: current.generation, truncated: !!current.historyTruncated };
  }
  observe(taskId: string, id: string, generation: number | undefined, after: number | undefined, receive: (event: TerminalEvent) => void) {
    const row = this.store.get(taskId, terminalID(id)); if (!row) throw new Error('终端不存在');
    const live = this.live.get(key(taskId, id)); if (live) this.flush(live);
    const current = this.summary(this.store.get(taskId, id)!);
    const idKey = key(taskId, id); const listeners = this.observers.get(idKey) ?? new Set(); listeners.add(receive); this.observers.set(idKey, listeners);
    const replay = generation === current.generation && after !== undefined ? this.store.history(current, after) : [];
    if (generation !== current.generation || after === undefined || after < current.baseSequence - 1 || after > current.sequence || replay.length > 128 || replay.reduce((sum, frame) => sum + frame.data.length, 0) > 256 * 1024) receive(this.snapshot(taskId, id));
    else {
      receive({ type: 'metadata', terminal: current, sequence: current.sequence, generation: current.generation });
      for (const frame of replay) receive({ type: 'output', data: frame.data.toString('base64'), sequence: frame.sequence, generation: current.generation });
    }
    return () => { listeners.delete(receive); if (!listeners.size) this.observers.delete(idKey); };
  }
  isLive(owner: string, id: string, generation: number) { const live = this.live.get(key(owner, id)); return live?.generation === generation && !live.closing && !live.error; }
  async closeIdle(owner: string, id: string, generation: number) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!await this.refreshProcesses()) return;
    const row = this.store.get(owner, id); if (row?.generation !== generation || row.status !== 'running' || row.hasRunningSubprocess) return;
    await this.lifecycle(owner, { action: 'close', terminalId: id, requestId: id + '-idle-close' });
  }
  async write(taskId: string, id: string, input: { requestId: string; generation: number; data: string }) {
    terminalID(id); terminalRequestID(input.requestId);
    if (typeof input.data !== 'string' || !input.data || input.data.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new Error('终端输入无效');
    const bytes = Buffer.from(input.data, 'base64'); if (!bytes.length || bytes.length > 65_536) throw new Error('终端输入过大');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return this.lock(taskId, id, async () => {
      const receipt = this.store.receipt(input.requestId);
      if (receipt) { if (receipt.taskId !== taskId || receipt.terminalId !== id || receipt.generation !== input.generation || receipt.digest !== digest) throw new Error('终端输入请求 ID 已被使用'); return receipt; }
      const row = this.store.get(taskId, id); const live = this.live.get(key(taskId, id));
      if (this.stopping || this.deleting.has(taskId) || row?.status !== 'running' || row.generation !== input.generation || live?.generation !== input.generation || live.closing || live.error) throw new Error('终端已退出、重新启动或断开，未发送输入');
      const started = { requestId: input.requestId, taskId, terminalId: id, generation: input.generation, digest, state: 'started' as const }; this.store.input(started);
      try { live.pty.write(bytes); this.store.input({ ...started, state: 'sent' }); return { ...started, state: 'sent' }; }
      catch { this.store.input({ ...started, state: 'uncertain' }); return { ...started, state: 'uncertain' }; }
    });
  }
  receipt(taskId: string, id: string, requestId: string) {
    const value = this.store.receipt(terminalRequestID(requestId));
    if (value && (value.taskId !== taskId || value.terminalId !== terminalID(id))) throw new Error('终端输入回执不属于此会话');
    return value ?? null;
  }
  async resize(taskId: string, id: string, generation: number, cols: number, rows: number) {
    const size = terminalSize(cols, rows);
    await this.lock(taskId, terminalID(id), async () => {
      const live = this.live.get(key(taskId, id)); if (this.stopping || live?.generation !== generation || live.closing) throw new Error('终端已退出或重新启动');
      live.pty.resize(size.cols, size.rows); this.update(taskId, id, generation, size);
    });
  }
  async clear(taskId: string, id: string, generation: number) {
    await this.lock(taskId, terminalID(id), async () => { const row = this.store.get(taskId, id); if (!row || row.generation !== generation) throw new Error('终端已重新启动'); const live = this.live.get(key(taskId, id)); if (live) this.flush(live); const current = this.store.get(taskId, id)!; this.store.clear(current); this.emit(taskId, id, { type: 'clear', generation, sequence: current.sequence }); });
  }
  rename(taskId: string, id: string, label: string) {
    const row = this.store.get(taskId, terminalID(id)); if (!row) throw new Error('终端不存在');
    if (!label.trim() || label.length > 128 || /[\x00-\x1f\x7f]/.test(label)) throw new Error('终端名称无效'); this.update(taskId, id, row.generation, { label: label.trim() });
  }
  async refreshProcesses(): Promise<boolean> {
    if (this.polling) return this.polling;
    if (this.stopping) return false; if (!this.live.size) return true;
    this.polling = (async () => { try {
      const rows = await terminalProcesses(); if (this.stopping) return;
      for (const live of this.live.values()) {
        const row = this.store.get(live.taskId, live.id); if (!row || row.generation !== live.generation) continue;
        let title = row.title; try { title = safeTitle(live.pty.process) || title; } catch {}
        const children = terminalDescendants(rows, live.pty.pid); const busy = !!live.error || children.some(child => child.pid !== live.pty.pid) || title.replace(/^-/, '') !== basename(row.shell);
        if (busy !== row.hasRunningSubprocess || title !== row.title) this.update(live.taskId, live.id, live.generation, { hasRunningSubprocess: busy, title });
      }
      return true;
    } catch { return false; /* Preserve the live handle and require confirmation on unknown status. */ }
    })().then(value => value === true);
    try { return await this.polling; } finally { this.polling = undefined; }
  }
  private stop(live: Live): Promise<void> {
    if (live.stopped) return live.stopped;
    live.closing = true;
    live.stopped = Promise.resolve().then(async () => { this.flush(live); if (!await stopTerminal(live.pty, live.exited)) throw new Error('终端进程尚未退出，请再次明确停止'); this.flush(live); for (const listener of live.listeners) listener.dispose(); if (this.live.get(key(live.taskId, live.id)) === live) this.live.delete(key(live.taskId, live.id)); });
    return live.stopped.finally(() => { live.stopped = undefined; });
  }
  private async performClose(taskId: string, id: string, generation: number, deleteHistory: boolean) {
    const row = this.store.get(taskId, id); if (!row || row.generation !== generation) return;
    const live = this.live.get(key(taskId, id)); if (live?.generation === generation) await this.stop(live);
    this.failures.delete(key(taskId, id));
    this.update(taskId, id, generation, { status: 'closed', pid: null, hasRunningSubprocess: false });
    const current = this.store.get(taskId, id)!; if (deleteHistory) this.store.clear(current);
    this.emit(taskId, id, { type: 'closed', generation, sequence: current.sequence });
  }
  async archiveTask(taskId: string) {
    for (const row of this.store.list(taskId)) await this.lock(taskId, row.id, () => this.performClose(taskId, row.id, row.generation, false));
  }
  async deleteTask(taskId: string) {
    this.deleting.add(taskId);
    for (const row of this.store.list(taskId)) await this.lock(taskId, row.id, () => this.performClose(taskId, row.id, row.generation, true));
    this.store.deleteTask(taskId);
    for (const idKey of this.failures.keys()) if (idKey.startsWith(taskId + '\0')) this.failures.delete(idKey);
  }
  beginShutdown() { this.stopping = true; if (this.poll) clearInterval(this.poll); }
  async close() {
    this.beginShutdown(); const owned = [...this.live.values()]; await Promise.all(owned.map(live => this.stop(live).catch(() => {})));
    for (const pending of this.locks.values()) await pending.catch(() => {});
    for (const live of owned) { try { this.update(live.taskId, live.id, live.generation, { status: live.error ? 'error' : 'interrupted', pid: null, hasRunningSubprocess: false, error: live.error ?? '服务已停止；保留输出，等待明确重新启动，不重放输入。' }); } catch {} }
    this.store.close(); this.observers.clear();
  }
}
