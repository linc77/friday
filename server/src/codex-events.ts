import type { ExecutionUpdate, TaskEvent } from './types.js';
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, type TerminalOutputState } from './vendor/t3-terminal-output.js';
import { codexFileChanges, taskCommandActions, taskPlanSteps } from './task-event-data.js';

const stamp = () => new Date().toISOString();
const printable = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

// Preserve Codex item identity and lifecycle. Completion replaces the streamed
// snapshot of the same item; it is never a second command in the transcript.
export class CodexEvents {
  private items = new Map<string, TaskEvent>();
  private flushed = new Map<string, number>();
  private pending = new Map<string, NodeJS.Timeout>();
  private commands = new Map<string, TerminalOutputState>();
  private summaries = new Map<string, Map<number, string>>();
  private writes = Promise.resolve();
  constructor(private update: (update: ExecutionUpdate) => Promise<void>, private onError: (error: Error) => void = () => {}) {}
  get backgroundCommands() { return [...this.items.values()].filter(item => item.kind === 'command' && item.background && item.status === 'running'); }
  owns(itemId: string) { return [...this.items.values()].some(item => item.itemId === itemId); }
  restore(items: TaskEvent[]) {
    for (const item of items) {
      this.cancelFlush(item.id); this.items.set(item.id, { ...item });
      if (item.kind === 'command' && item.status === 'running') this.commands.set(item.id, appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, item.detail ?? ''));
      else this.commands.delete(item.id);
    }
  }
  isBackground(eventId: string) { return this.items.get(eventId)?.background === true; }
  async confirmStopped(itemId: string) {
    const item = this.backgroundCommands.find(item => item.itemId === itemId);
    if (!item) return;
    const completedAt = stamp(); this.commands.delete(item.id);
    await this.save({ ...item, status: 'interrupted', completedAt, durationMs: Date.parse(completedAt) - Date.parse(item.at) });
  }

  get result() {
    const replies = [...this.items.values()].filter(i => i.kind === 'message');
    return replies.findLast(i => i.phase === 'final_answer')?.text
      || replies.findLast(i => !i.phase)?.text
      || [...this.items.values()].findLast(i => i.kind === 'proposal')?.text
      || '任务已完成，详见执行记录。';
  }

  private async save(item: TaskEvent, streaming = false) {
    const previous = this.items.get(item.id);
    this.items.set(item.id, item);
    const remaining = 150 - (Date.now() - (this.flushed.get(item.id) ?? 0));
    // Publish the first content immediately. A trailing flush must not depend on
    // another delta arriving: the model can pause after any token burst.
    if (streaming && (previous?.text || previous?.detail) && remaining > 0) {
      if (!this.pending.has(item.id)) this.pending.set(item.id, setTimeout(() => {
        this.pending.delete(item.id);
        const latest = this.items.get(item.id);
        if (latest) void this.publish(latest).catch(this.onError);
      }, remaining));
      return;
    }
    this.cancelFlush(item.id);
    await this.publish(item);
  }

  private cancelFlush(id: string) {
    clearTimeout(this.pending.get(id));
    this.pending.delete(id);
  }

  private publish(item: TaskEvent) {
    this.flushed.set(item.id, Date.now());
    const snapshot = { ...item };
    // Timer flushes and wire completions share a queue, so a late write can
    // never replace an authoritative completion with an older running item.
    const write = this.writes.then(async () => {
      await this.update({ kind: 'item', item: snapshot });
      if (snapshot.kind === 'message' && snapshot.phase !== 'commentary') await this.update({ kind: 'output', text: snapshot.text });
    });
    this.writes = write;
    void write.catch(() => {});
    return write;
  }

  private item(id: string, turnId: string, kind: string): TaskEvent {
    const key = `codex:${turnId}:${id}`;
    return this.items.get(key) ?? { id: key, itemId: id, turnId, kind, text: '', at: stamp(), status: 'running' };
  }

  async startTurn(turnId: string) {
    const item = this.item('turn', turnId, 'turn');
    if (!this.items.has(item.id)) await this.save(item);
  }

  async finishTurn(turnId: string, status: NonNullable<TaskEvent['status']>, retainCommands = false) {
    const completedAt = stamp();
    for (const item of this.items.values()) if (item.turnId === turnId) { this.cancelFlush(item.id); if (!(retainCommands && item.kind === 'command' && item.status === 'running')) this.commands.delete(item.id); }
    for (const item of this.items.values()) {
      if (item.turnId !== turnId || item.status !== 'running') continue;
      if (retainCommands && item.kind === 'command') { await this.save({ ...item, background: true }); continue; }
      await this.save({ ...item, status: item.kind === 'message' && status === 'completed' ? 'completed' : status === 'completed' && item.kind !== 'turn' ? 'interrupted' : status,
        completedAt, durationMs: Date.parse(completedAt) - Date.parse(item.at) });
    }
    await this.writes;
  }

  async handle(method: string | undefined, p: any, currentTurnId: string) {
    const turnId = p.turnId ?? currentTurnId;
    if (!turnId) return false;
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
      const kind = method.includes('agentMessage') ? 'message' : method.includes('commandExecution') ? 'command' : method.includes('reasoning') ? 'reasoning' : 'proposal';
      const item = { ...this.item(p.itemId, turnId, kind) };
      if (kind === 'command') {
        if (!this.items.has(item.id)) await this.save(item);
        const output = appendTerminalOutput(this.commands.get(item.id) ?? EMPTY_TERMINAL_OUTPUT, p.delta);
        this.commands.set(item.id, output);
        item.detail = output.text;
        item.detailTruncated = output.truncated;
        await this.update({ kind: 'commandOutput', eventId: item.id, delta: p.delta });
        // Output has its own view-only stream. Keep an interrupted fallback in
        // memory, but do not turn every chunk into a Durable workspace write.
        this.items.set(item.id, item);
        return true;
      }
      else if (kind === 'reasoning') {
        const parts = this.summaries.get(item.id) ?? new Map<number, string>();
        const index = p.summaryIndex ?? 0;
        parts.set(index, (parts.get(index) ?? '') + p.delta);
        this.summaries.set(item.id, parts);
        item.text = [...parts].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
      }
      else item.text = item.text + p.delta;
      await this.save(item, true); return true;
    }
    if (method === 'turn/plan/updated') {
      const item = this.item('plan', turnId, 'plan');
      const plan = taskPlanSteps(p.plan);
      await this.save({ ...item, plan, text: plan.map(step => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'} ${step.step}`).join('\n'), detail: p.explanation ?? '', status: 'completed' });
      return true;
    }
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const wire = p.item;
    if (!wire?.id) return false;
    const kinds: Record<string, string> = { agentMessage: 'message', commandExecution: 'command', fileChange: 'files', reasoning: 'reasoning', plan: 'proposal', webSearch: 'search', mcpToolCall: 'tool', dynamicToolCall: 'tool', imageView: 'image', contextCompaction: 'compaction' };
    const kind = kinds[wire.type];
    if (!kind) return false;
    const done = method === 'item/completed';
    const previous = this.item(wire.id, turnId, kind);
    const item: TaskEvent = { ...previous, status: done ? wire.status === 'failed' || (kind === 'command' && typeof wire.exitCode === 'number' && wire.exitCode !== 0) ? 'failed' : wire.status === 'declined' ? 'declined' : 'completed' : 'running' };
    if (done) { item.completedAt = stamp(); item.durationMs = wire.durationMs ?? Date.parse(item.completedAt) - Date.parse(item.at); }
    if (kind === 'message') {
      item.text = typeof wire.text === 'string' ? wire.text : previous.text;
      if (wire.phase === 'commentary' || wire.phase === 'final_answer') item.phase = wire.phase;
    } else if (kind === 'command') {
      if (typeof wire.processId === 'string' && wire.processId.length > 0) item.processId = wire.processId;
      item.text = wire.command ?? previous.text;
      if (typeof wire.aggregatedOutput === 'string') { item.detail = wire.aggregatedOutput; delete item.detailTruncated; }
      if (!done && typeof wire.aggregatedOutput === 'string') this.commands.set(item.id, appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, wire.aggregatedOutput));
      if (done) this.commands.delete(item.id);
      if (typeof wire.exitCode === 'number') item.exitCode = wire.exitCode;
      if (Array.isArray(wire.commandActions)) item.commandActions = taskCommandActions(wire.commandActions);
    } else if (kind === 'files') {
      item.changes = codexFileChanges(wire.changes);
      item.text = item.changes.map(change => change.path).join('\n');
      item.detail = item.changes.map(change => `${change.path}\n${change.kind}\n${change.diff}`).join('\n\n').slice(0, 20_000);
    } else if (kind === 'reasoning') {
      // Only the public summary belongs in the client; never expose raw reasoning.
      // Some peers omit summaries from item/completed after streaming them.
      const summary = Array.isArray(wire.summary) ? wire.summary.join('\n\n') : '';
      item.text = summary || previous.text;
      if (done) this.summaries.delete(item.id);
    } else if (kind === 'proposal') item.text = wire.text ?? previous.text;
    else if (kind === 'search') { item.text = wire.query ?? wire.action?.query ?? wire.action?.url ?? '搜索网页'; item.detail = printable(wire.action); }
    else if (kind === 'tool') {
      item.text = wire.server ? `${wire.server} · ${wire.tool}` : wire.tool ?? '工具调用';
      // Tool results can contain screenshots/base64; retain readable text only.
      const content = wire.result?.content ?? wire.contentItems ?? [];
      item.detail = (wire.error ? printable(wire.error) : content.filter((c: any) => typeof c.text === 'string').map((c: any) => c.text).join('\n'));
      if (done && wire.success === false) item.status = 'failed';
    } else if (kind === 'image') item.text = wire.path ?? '';
    else if (kind === 'compaction') item.text = '整理上下文';
    await this.save(item); return true;
  }
}
