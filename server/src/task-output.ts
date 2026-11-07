import type { Engine } from './engine.js';
import type { TaskEvent, Workspace } from './types.js';
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT, normalizeTerminalOutput, TERMINAL_OUTPUT_TAIL_CHARS, type TerminalOutputState } from './vendor/t3-terminal-output.js';

// Match T3 WireProjection: tool bodies are read on demand; public messages,
// summaries and proposed plans remain whole in the conversation window.
export function compactTaskEvent(event: TaskEvent): TaskEvent {
  if (!['command', 'tool', 'search'].includes(event.kind) || event.kind !== 'command' && !event.detail) return event;
  const { detail: _, ...projected } = event;
  return { ...projected, detailOmitted: true };
}
export function compactTaskOutputs(state: Workspace): Workspace {
  return { ...state, tasks: state.tasks.map(task => task.agent === 'friday' ? task : { ...task, events: task.events.map(compactTaskEvent) }) };
}

export function taskEventDetail(event: TaskEvent): TaskEvent {
  const max = 256 * 1024;
  if (!event.detail || Buffer.byteLength(event.detail, 'utf8') <= max) return event;
  // TextDecoder discards only an incomplete final character. It does not drop
  // a real U+FFFD from the provider's output or split an emoji at the boundary.
  const decoder = new TextDecoder();
  const prefix = decoder.decode(Buffer.from(event.detail.slice(0, max), 'utf8').subarray(0, max), { stream: true });
  return { ...event, detail: prefix, detailTruncated: true };
}

export type TaskCommandOutputFrame = {
  taskId: string; eventId: string; epoch: string; text: string; truncated: boolean; running: boolean;
};
type Entry = { runId?: string; tail: TerminalOutputState; backgroundSessionId?: string };
const key = (task: string, event: string) => JSON.stringify([task, event]);

/** A view-only stream, independent from Durable execution. Raw chunks have no
 * replay semantics. Final public output is persisted on the existing item. */
export class TaskCommandOutputs {
  private live = new Map<string, Entry>();
  private finished = new Map<string, Entry>();
  private owners = new Map<string, string | undefined>();
  private sessions = new Map<string, string>();
  private subscribers = new Map<string, Set<() => void>>();
  constructor(private readonly engine: Engine) {}
  own(task: string, runId?: string) { this.owners.set(task, runId); }
  session(task: string, sessionId: string) { this.sessions.set(task, sessionId); }
  private bounded(map: Map<string, Entry>, id: string, entry: Entry, size: number) {
    map.delete(id); map.set(id, entry);
    while (map.size > size) { const oldest = map.keys().next().value!; map.delete(oldest); this.wake(oldest); }
  }
  private wake(id: string) { for (const wake of this.subscribers.get(id) ?? []) wake(); }
  track(task: string, event: TaskEvent, runId?: string) {
    if (event.kind !== 'command') return;
    const id = key(task, event.id);
    if (event.status === 'running') {
      if (!this.live.has(id)) this.bounded(this.live, id, { runId, tail: appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, event.detail ?? '') }, 64);
    } else {
      const previous = this.live.get(id);
      if (previous) { this.live.delete(id); this.bounded(this.finished, id, previous, 16); }
    }
    this.wake(id);
  }
  append(task: string, event: string, delta: string, runId?: string, options: { reset?: boolean; truncated?: boolean } = {}) {
    const id = key(task, event); const entry = this.live.get(id);
    const owner = runId ?? entry?.runId;
    if (!entry || this.owners.get(task) !== owner || entry.runId !== owner || !delta && !options.reset) return;
    const tail = appendTerminalOutput(options.reset ? EMPTY_TERMINAL_OUTPUT : entry.tail, delta);
    this.bounded(this.live, id, { runId: owner, tail: options.truncated ? { ...tail, truncated: true } : tail }, 64);
    this.wake(id);
  }
  trackBackground(task: string, event: TaskEvent, runId: string, sessionId: string) {
    if (this.sessions.get(task) !== sessionId) return;
    this.track(task, event, runId);
    const id = key(task, event.id); const entry = this.live.get(id) ?? this.finished.get(id);
    if (entry && entry.runId === runId) entry.backgroundSessionId = sessionId;
  }
  appendBackground(task: string, event: string, delta: string, runId: string, sessionId: string) {
    const id = key(task, event); const entry = this.live.get(id);
    if (!entry || entry.runId !== runId || entry.backgroundSessionId !== sessionId || this.sessions.get(task) !== sessionId || !delta) return;
    this.bounded(this.live, id, { ...entry, tail: appendTerminalOutput(entry.tail, delta) }, 64); this.wake(id);
  }
  appendNativeBackground(task: string, event: string, delta: string, sessionId: string, options: { reset?: boolean; truncated?: boolean } = {}) {
    const id = key(task, event); const entry = this.live.get(id) ?? this.finished.get(id);
    if (!entry || entry.backgroundSessionId !== sessionId || this.sessions.get(task) !== sessionId || !delta && !options.reset) return;
    const tail = appendTerminalOutput(options.reset ? EMPTY_TERMINAL_OUTPUT : entry.tail, delta);
    this.bounded(this.live.has(id) ? this.live : this.finished, id, { ...entry, tail: options.truncated ? { ...tail, truncated: true } : tail }, this.live.has(id) ? 64 : 16); this.wake(id);
  }
  nativeTail(task: string, event: string) {
    const entry = this.live.get(key(task, event)) ?? this.finished.get(key(task, event));
    return entry ? { text: entry.tail.text, truncated: entry.tail.truncated } : undefined;
  }
  trackNativeBackground(task: string, event: string, sessionId: string, running: boolean, output?: { text: string; truncated: boolean }) {
    if (this.sessions.get(task) !== sessionId) return;
    const id = key(task, event); const previous = this.live.get(id) ?? this.finished.get(id);
    const normalized = output ? appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, output.text) : previous?.tail ?? EMPTY_TERMINAL_OUTPUT;
    const entry: Entry = { runId: previous?.runId ?? event, backgroundSessionId: sessionId,
      tail: output?.truncated ? { ...normalized, truncated: true } : normalized };
    if (running) { this.finished.delete(id); this.bounded(this.live, id, entry, 64); }
    else { this.live.delete(id); this.bounded(this.finished, id, entry, 16); }
    this.wake(id);
  }
  async nativeFrame(taskId: string, workId: string, sessionId: string): Promise<TaskCommandOutputFrame> {
    const task = (await this.engine.snapshot()).tasks.find(task => task.id === taskId);
    const work = task?.nativeBackgroundWork?.find(work => work.id === workId && work.transportId === sessionId);
    if (!work) throw new Error('后台任务输出已不在当前任务中');
    const tail = this.nativeTail(taskId, workId) ?? work.output ?? { text: '', truncated: false };
    return { taskId, eventId: workId, epoch: sessionId, text: tail.text, truncated: tail.truncated,
      running: work.member && !['completed', 'failed', 'stopped', 'interrupted', 'unknown'].includes(work.status) && task?.nativeBackgroundConnected === true };
  }
  observe(task: string, event: string, wake: () => void) {
    const id = key(task, event); const subscribers = this.subscribers.get(id) ?? new Set();
    subscribers.add(wake); this.subscribers.set(id, subscribers);
    return () => { subscribers.delete(wake); if (!subscribers.size) this.subscribers.delete(id); };
  }
  remove(task: string) {
    this.owners.delete(task);
    this.sessions.delete(task);
    for (const map of [this.live, this.finished]) for (const id of map.keys()) if (JSON.parse(id)[0] === task) { map.delete(id); this.wake(id); }
  }
  async frame(taskId: string, eventId: string, epoch: string): Promise<TaskCommandOutputFrame> {
    const page = await this.engine.taskHistory.eventItems(taskId, [eventId]);
    const event = page.events.find(event => event.id === eventId && !event.revertedAt);
    if (page.epoch !== epoch || !event || event.kind !== 'command') throw new Error('这条命令的输出已不在当前任务历史中');
    const running = event.status === 'running';
    const entry = (running ? this.live : this.finished).get(key(taskId, eventId));
    if (entry && (running || event.detail === undefined)) return { taskId, eventId, epoch, text: entry.tail.text, truncated: entry.tail.truncated || event.detailTruncated === true, running };
    let source = event.detail ?? '';
    // Old Claude SDK records may contain a Bash result envelope.
    if (source.trimStart().startsWith('{"stdout"')) {
      try { const result = JSON.parse(source); if (typeof result.stdout === 'string' && typeof result.stderr === 'string' && typeof result.interrupted === 'boolean') source = [result.stdout, result.stderr].filter(value => value.trim()).join('\n'); } catch {}
    }
    const limit = TERMINAL_OUTPUT_TAIL_CHARS * 4; const cut = source.length > limit;
    if (cut) { source = source.slice(-limit); const line = source.indexOf('\n'); if (line >= 0 && line + 1 < source.length) source = source.slice(line + 1); }
    const tail = normalizeTerminalOutput(source);
    return { taskId, eventId, epoch, text: tail.text, truncated: tail.truncated || cut || event.detailTruncated === true, running };
  }
}
