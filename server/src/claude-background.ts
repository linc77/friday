import { createHash } from 'node:crypto';

export type ClaudeBackgroundKind = 'command' | 'monitor' | 'subagent' | 'background_task';
export type ClaudeBackgroundStatus = 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'unknown';
export type ClaudeBackgroundOrigin = { turnId: string; runId?: string; eventId: string };
export type ClaudeBackgroundTask = {
  id: string; provider: 'claude'; sessionId: string; transportId: string;
  taskId: string; nativeRunId?: string; generation: number; taskType?: string;
  kind: ClaudeBackgroundKind; status: ClaudeBackgroundStatus; member: boolean; backgrounded: boolean;
  ambient: boolean; description: string; startedAt: string; updatedAt: string; completedAt?: string;
  toolUseId?: string; parentTaskId?: string; origin?: ClaudeBackgroundOrigin; summary?: string;
  usage?: { totalTokens: number; toolUses: number; durationMs: number };
};
type ObjectValue = Record<string, unknown>;
type Tool = { name: string; backgrounded: boolean; description: string; origin?: ClaudeBackgroundOrigin };
const object = (value: unknown): ObjectValue | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
export const claudeBackgroundEnded = (task: { status: ClaudeBackgroundStatus }) => ['completed', 'failed', 'stopped', 'interrupted'].includes(task.status);
const terminal = (status: ClaudeBackgroundStatus) => claudeBackgroundEnded({ status });
function text(value: unknown, limit = 2_000) {
  if (typeof value !== 'string') return undefined;
  let result = value.slice(0, limit); if (/[\uD800-\uDBFF]$/.test(result)) result = result.slice(0, -1);
  return result;
}
const kind = (type?: string, tool?: Tool): ClaudeBackgroundKind => tool?.name === 'Monitor' ? 'monitor' : type === 'local_bash' ? 'command' : type === 'local_agent' || tool?.name === 'Agent' || tool?.name === 'Task' ? 'subagent' : 'background_task';
const validRun = (value: unknown) => value === undefined || identifier(value);

/** SDK background_tasks_changed is a per-process level with REPLACE semantics.
 * Edge events enrich task outcomes, but never stand in for a missing level.
 * This class projects native facts only; it starts and resumes no execution. */
export class ClaudeBackground {
  private tasks = new Map<string, ClaudeBackgroundTask>();
  private latest = new Map<string, string>();
  private tools = new Map<string, Tool>();
  private seen = new Set<string>();
  private levelSeen = false;
  private nativeFlags = new Set<string>();
  constructor(readonly sessionId: string, readonly transportId: string, private now = () => new Date().toISOString()) {}

  registerTool(id: string, name: string, input: unknown, origin?: ClaudeBackgroundOrigin) {
    if (!identifier(id) || !identifier(name)) return;
    const tool: Tool = { name, backgrounded: object(input)?.run_in_background === true || name === 'Monitor', description: text(object(input)?.command) ?? name, ...(origin ? { origin: { ...origin } } : {}) };
    this.tools.set(id, tool);
    for (const task of this.tasks.values()) if (task.toolUseId === id) {
      task.kind = kind(task.taskType, tool);
      if (origin) task.origin = { ...origin };
      if (!this.levelSeen && !this.nativeFlags.has(task.id) && !terminal(task.status)) { task.backgrounded = tool.backgrounded; task.member = task.backgrounded; }
    }
  }
  bindTask(taskId: string, toolUseId: string) {
    const tool = this.tools.get(toolUseId); if (!identifier(taskId) || !tool || !['Bash', 'Monitor'].includes(tool.name)) return false;
    const previous = this.current(taskId);
    if (previous && (previous.toolUseId && previous.toolUseId !== toolUseId || previous.generation > 0 && previous.toolUseId !== toolUseId)) return false;
    const task = previous ? this.tasks.get(previous.id)! : this.select(taskId, undefined); if (!task) return false;
    task.toolUseId = toolUseId; task.taskType = 'local_bash'; task.kind = kind(task.taskType, tool); task.backgrounded = true;
    if (!this.levelSeen && !terminal(task.status)) task.member = true;
    if (!task.description) task.description = tool.description;
    if (tool.origin) task.origin = { ...tool.origin }; return true;
  }
  values() { return [...this.tasks.values()].map(task => structuredClone(task)); }
  current(taskId: string) { const id = this.latest.get(taskId); const task = id ? this.tasks.get(id) : undefined; return task && structuredClone(task); }
  active() { return this.values().filter(task => !task.ambient && task.member && !terminal(task.status)); }
  holdsCompletion() { return this.active().some(task => task.kind !== 'command'); }
  parent(taskId: string): ClaudeBackgroundTask | undefined {
    const child = this.current(taskId); if (!child?.parentTaskId) return undefined;
    const visited = new Set([taskId]); let id: string | undefined = child.parentTaskId;
    while (id) { if (visited.has(id)) return undefined; visited.add(id); const task = this.current(id); if (!task) return undefined; id = task.parentTaskId; }
    return this.current(child.parentTaskId);
  }
  private select(taskId: string, runId: string | undefined, options: { reopen?: string; toolUseId?: string } = {}) {
    const previous = this.current(taskId);
    if (previous?.nativeRunId !== undefined && (runId === undefined || runId < previous.nativeRunId)) return;
    const newRun = previous?.nativeRunId !== runId;
    const legacyResume = runId === undefined && previous && terminal(previous.status) && options.reopen === 'started'
      && options.toolUseId !== previous.toolUseId && options.toolUseId !== undefined && this.tools.has(options.toolUseId);
    if (previous && !newRun && !legacyResume) return this.tasks.get(previous.id);
    if (previous) {
      const old = this.tasks.get(previous.id)!; old.member = false;
      if (!terminal(old.status)) { old.status = 'unknown'; old.updatedAt = this.now(); }
    }
    const generation = previous ? previous.generation + 1 : 0;
    const id = 'claude-bg:' + createHash('sha256').update(JSON.stringify([this.transportId, taskId, runId ?? generation])).digest('hex');
    const stamp = this.now();
    const task: ClaudeBackgroundTask = { id, provider: 'claude', sessionId: this.sessionId, transportId: this.transportId, taskId,
      ...(runId ? { nativeRunId: runId } : {}), generation, kind: 'background_task', status: 'running', member: false, backgrounded: false,
      ambient: false, description: '', startedAt: stamp, updatedAt: stamp,
      ...(previous?.parentTaskId ? { parentTaskId: previous.parentTaskId } : {}) };
    this.tasks.set(id, task); this.latest.set(taskId, id); return task;
  }

  handle(input: unknown): boolean {
    const value = object(input);
    if (!value || value.type !== 'system' || value.session_id !== this.sessionId || !identifier(value.uuid) || this.seen.has(value.uuid)) return false;
    if (value.subtype === 'background_tasks_changed') {
      if (!Array.isArray(value.tasks)) return false;
      const ids = new Set<string>();
      const entries = value.tasks.map(object);
      if (entries.some(entry => !entry || !identifier(entry.task_id) || !identifier(entry.task_type) || typeof entry.description !== 'string'
        || !validRun(entry.run_id) || entry.parent_task_id !== undefined && !identifier(entry.parent_task_id)
        || entry.ambient !== undefined && typeof entry.ambient !== 'boolean' || ids.has(entry.task_id) || !ids.add(entry.task_id))) return false;
      this.seen.add(value.uuid); this.levelSeen = true;
      // Clear the old set first. A terminal edge may be missing; absence is not
      // a successful exit receipt, so retain the outcome as unknown instead.
      const previousMembers = new Set([...this.tasks.values()].filter(task => task.member).map(task => task.id));
      for (const task of this.tasks.values()) task.member = false;
      for (const entry of entries as ObjectValue[]) {
        const previous = this.current(entry.task_id as string);
        if (previous?.nativeRunId && (entry.run_id === undefined || String(entry.run_id) < previous.nativeRunId)) {
          if (previousMembers.has(previous.id)) this.tasks.get(previous.id)!.member = true;
          continue;
        }
        const task = this.select(entry.task_id as string, entry.run_id as string | undefined); if (!task) continue;
        task.taskType = entry.task_type as string; task.description = text(entry.description)!;
        task.ambient = entry.ambient === true; task.backgrounded = true; task.member = true; task.updatedAt = this.now();
        if (identifier(entry.parent_task_id)) task.parentTaskId = entry.parent_task_id;
        task.kind = kind(task.taskType, task.toolUseId ? this.tools.get(task.toolUseId) : undefined);
        if (task.status === 'unknown') task.status = 'running';
      }
      for (const task of this.tasks.values()) if (!task.member && previousMembers.has(task.id) && !terminal(task.status)) { task.status = 'unknown'; task.updatedAt = this.now(); }
      return true;
    }
    if (typeof value.subtype !== 'string' || !['task_started', 'task_updated', 'task_progress', 'task_notification'].includes(value.subtype) || !identifier(value.task_id) || !validRun(value.run_id)) return false;
    if (value.tool_use_id !== undefined && !identifier(value.tool_use_id)) return false;
    if (value.subtype === 'task_updated' && !object(value.patch)) return false;
    if (value.subtype === 'task_notification' && !['completed', 'failed', 'stopped'].includes(String(value.status))) return false;
    const task = this.select(value.task_id, value.run_id as string | undefined, { reopen: value.subtype === 'task_started' ? 'started' : undefined, toolUseId: value.tool_use_id as string | undefined });
    if (!task) return false;
    this.seen.add(value.uuid);
    // A late start/progress never resurrects the same completed run. A resumed
    // task must name a newer native run, or a newly registered legacy tool.
    if (terminal(task.status) && value.subtype !== 'task_notification') return false;
    if (terminal(task.status) && value.subtype === 'task_notification' && value.status !== task.status) return false;
    if (identifier(value.tool_use_id)) task.toolUseId = value.tool_use_id;
    if (identifier(value.task_type)) task.taskType = value.task_type;
    const tool = task.toolUseId ? this.tools.get(task.toolUseId) : undefined;
    task.kind = kind(task.taskType, tool); if (tool?.origin) task.origin = { ...tool.origin };
    if (identifier(value.parent_task_id)) task.parentTaskId = value.parent_task_id;
    if (text(value.description) !== undefined) task.description = text(value.description)!;
    if (value.ambient === true || value.skip_transcript === true) task.ambient = true;
    if (value.subtype === 'task_started') {
      if (typeof value.is_backgrounded === 'boolean') this.nativeFlags.add(task.id);
      task.backgrounded = typeof value.is_backgrounded === 'boolean' ? value.is_backgrounded : tool?.backgrounded === true;
      if (!this.levelSeen) task.member = task.backgrounded;
      task.status = 'running';
    } else if (value.subtype === 'task_updated') {
      const patch = object(value.patch)!;
      if (typeof patch.is_backgrounded === 'boolean') { this.nativeFlags.add(task.id); task.backgrounded = patch.is_backgrounded; if (!this.levelSeen) task.member = task.backgrounded; }
      if (text(patch.description) !== undefined) task.description = text(patch.description)!;
      const status: Record<string, ClaudeBackgroundStatus> = { pending: 'running', running: 'running', paused: 'paused', completed: 'completed', failed: 'failed', killed: 'stopped' };
      if (typeof patch.status === 'string' && Object.hasOwn(status, patch.status)) task.status = status[patch.status]!;
    } else if (value.subtype === 'task_progress') {
      if (text(value.summary, 4_000) !== undefined) task.summary = text(value.summary, 4_000);
      const usage = object(value.usage);
      if (usage && ['total_tokens', 'tool_uses', 'duration_ms'].every(key => typeof usage[key] === 'number' && Number.isFinite(usage[key]) && Number(usage[key]) >= 0)) {
        task.usage = { totalTokens: Number(usage.total_tokens), toolUses: Number(usage.tool_uses), durationMs: Number(usage.duration_ms) };
      }
    } else {
      task.status = value.status as ClaudeBackgroundStatus; task.completedAt ??= this.now();
      if (text(value.summary, 4_000) !== undefined) task.summary = text(value.summary, 4_000);
      if (!this.levelSeen) task.member = false;
    }
    if (terminal(task.status)) task.completedAt ??= this.now();
    task.updatedAt = this.now(); return true;
  }
  disconnect(interrupted = false) {
    for (const task of this.tasks.values()) {
      task.member = false;
      if (!terminal(task.status)) { task.status = interrupted ? 'interrupted' : 'unknown'; task.updatedAt = this.now(); if (interrupted) task.completedAt = this.now(); }
    }
  }
}
