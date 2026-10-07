import type { ExecutionUpdate, TaskEvent } from './types.js';

const stamp = () => new Date().toISOString();
const printable = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

// Preserve Codex item identity and lifecycle. Completion replaces the streamed
// snapshot of the same item; it is never a second command in the transcript.
export class CodexEvents {
  private items = new Map<string, TaskEvent>();
  private flushed = new Map<string, number>();
  constructor(private update: (update: ExecutionUpdate) => Promise<void>) {}

  get result() {
    const replies = [...this.items.values()].filter(i => i.kind === 'message');
    return replies.findLast(i => i.phase === 'final_answer')?.text
      || replies.findLast(i => !i.phase)?.text
      || '任务已完成，详见执行记录。';
  }

  private async save(item: TaskEvent, streaming = false) {
    this.items.set(item.id, item);
    if (streaming && Date.now() - (this.flushed.get(item.id) ?? 0) < 150) return;
    this.flushed.set(item.id, Date.now());
    await this.update({ kind: 'item', item: { ...item } });
    if (item.kind === 'message' && item.phase !== 'commentary') await this.update({ kind: 'output', text: item.text });
  }

  private item(id: string, turnId: string, kind: string): TaskEvent {
    const key = `codex:${turnId}:${id}`;
    return this.items.get(key) ?? { id: key, itemId: id, turnId, kind, text: '', at: stamp(), status: 'running' };
  }

  async startTurn(turnId: string) {
    const item = this.item('turn', turnId, 'turn');
    if (!this.items.has(item.id)) await this.save(item);
  }

  async finishTurn(turnId: string, status: NonNullable<TaskEvent['status']>) {
    const completedAt = stamp();
    for (const item of this.items.values()) {
      if (item.turnId !== turnId || item.status !== 'running') continue;
      await this.save({ ...item, status: item.kind === 'message' && status === 'completed' ? 'completed' : status === 'completed' && item.kind !== 'turn' ? 'interrupted' : status,
        completedAt, durationMs: Date.parse(completedAt) - Date.parse(item.at) });
    }
  }

  async handle(method: string | undefined, p: any, currentTurnId: string) {
    const turnId = p.turnId ?? currentTurnId;
    if (!turnId) return false;
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') {
      const kind = method.includes('agentMessage') ? 'message' : method.includes('commandExecution') ? 'command' : method.includes('reasoning') ? 'reasoning' : 'plan';
      const item = { ...this.item(p.itemId, turnId, kind) };
      if (kind === 'command') item.detail = ((item.detail ?? '') + p.delta).slice(-12_000);
      else item.text = (item.text + p.delta).slice(-80_000);
      await this.save(item, true); return true;
    }
    if (method === 'turn/plan/updated') {
      const item = this.item('plan', turnId, 'plan');
      await this.save({ ...item, text: (p.plan ?? []).map((step: any) => `${step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'} ${step.step}`).join('\n'), detail: p.explanation ?? '', status: 'completed' });
      return true;
    }
    if (method !== 'item/started' && method !== 'item/completed') return false;
    const wire = p.item;
    if (!wire?.id) return false;
    const kinds: Record<string, string> = { agentMessage: 'message', commandExecution: 'command', fileChange: 'files', reasoning: 'reasoning', plan: 'plan', webSearch: 'search', mcpToolCall: 'tool', dynamicToolCall: 'tool', imageView: 'image', contextCompaction: 'compaction' };
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
      item.text = wire.command ?? previous.text;
      if (typeof wire.aggregatedOutput === 'string') item.detail = wire.aggregatedOutput.slice(-12_000);
      if (typeof wire.exitCode === 'number') item.exitCode = wire.exitCode;
    } else if (kind === 'files') {
      item.text = (wire.changes ?? []).map((change: any) => change.path).join('\n');
      item.detail = (wire.changes ?? []).map((change: any) => `${change.path}\n${typeof change.kind === 'string' ? change.kind : change.kind?.type ?? ''}\n${change.diff ?? ''}`).join('\n\n').slice(-20_000);
    } else if (kind === 'reasoning') {
      // Only the public summary belongs in the client; never expose raw reasoning.
      item.text = Array.isArray(wire.summary) ? wire.summary.join('\n\n') : previous.text;
    } else if (kind === 'plan') item.text = wire.text ?? previous.text;
    else if (kind === 'search') { item.text = wire.query ?? wire.action?.query ?? wire.action?.url ?? '搜索网页'; item.detail = printable(wire.action); }
    else if (kind === 'tool') {
      item.text = wire.server ? `${wire.server} · ${wire.tool}` : wire.tool ?? '工具调用';
      // Tool results can contain screenshots/base64; retain readable text only.
      const content = wire.result?.content ?? wire.contentItems ?? [];
      item.detail = (wire.error ? printable(wire.error) : content.filter((c: any) => typeof c.text === 'string').map((c: any) => c.text).join('\n')).slice(-12_000);
      if (done && wire.success === false) item.status = 'failed';
    } else if (kind === 'image') item.text = wire.path ?? '';
    else if (kind === 'compaction') item.text = '整理上下文';
    await this.save(item); return true;
  }
}
