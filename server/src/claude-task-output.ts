import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const pollMs = 250;
const locateAttempts = 40;
const maxReadBytes = 256 * 1024;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const taskID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
export type ClaudeOutputChunk = { text: string; reset?: boolean; truncated?: boolean };

export function claudeTaskOutputRoot(environment: NodeJS.ProcessEnv, cwd: string) {
  const uid = process.getuid?.(); if (uid === undefined) return undefined;
  const base = environment.CLAUDE_CODE_TMPDIR?.trim() || '/tmp';
  return join(isAbsolute(base) ? base : resolve(cwd, base), `claude-${uid}`);
}

// Claude Code's private layout, also followed by T3 ClaudeTaskOutputTail.ts:
// <tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output.
// We never consume an output_file path supplied in a notification. Unsupported
// layouts and unreadable files simply fall back to the SDK's final tool result.
export class ClaudeTaskOutputTail {
  readonly done: Promise<void>;
  private stopped = false;
  private wake?: () => void;
  private root?: string;
  constructor(private input: { root: string; sessionId: string; taskId: string; onChunk: (chunk: ClaudeOutputChunk) => Promise<void> }) {
    this.done = this.follow().catch(() => {});
  }
  async stop() { this.stopped = true; this.wake?.(); await this.done; }
  private async pause() {
    if (this.stopped) return;
    await new Promise<void>(resolve => {
      const end = () => { clearTimeout(timer); if (this.wake === end) this.wake = undefined; resolve(); };
      const timer = setTimeout(end, pollMs); this.wake = end;
      if (this.stopped) end();
    });
  }
  private async directory(path: string) {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.();
  }
  private async locate() {
    if (!await this.directory(this.input.root)) return undefined;
    const root = await realpath(this.input.root);
    if (this.root && this.root !== root) return undefined;
    this.root = root;
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory() || project.isSymbolicLink()) continue;
      const projectPath = join(root, project.name); const session = join(projectPath, this.input.sessionId); const tasks = join(session, 'tasks');
      try {
        if (!await this.directory(projectPath) || !await this.directory(session) || !await this.directory(tasks)) continue;
        const file = join(tasks, this.input.taskId + '.output'); const stat = await lstat(file);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && stat.nlink === 1 && await realpath(file) === file) return file;
      } catch { /* This project has no output for the current session. */ }
    }
    return undefined;
  }
  private async read(path: string, offset: number, previous?: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(); const named = await lstat(path);
      if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || !Number.isSafeInteger(info.size)
        || info.ino !== named.ino || info.dev !== named.dev || await realpath(path) !== path || !this.root || !path.startsWith(this.root + '/')) return undefined;
      // Recheck the parent chain: an output directory replaced by a symlink
      // must not turn this viewer into a reader of another local file.
      const tasks = resolve(path, '..'); const session = resolve(tasks, '..'); const project = resolve(session, '..');
      if (!await this.directory(project) || !await this.directory(session) || !await this.directory(tasks)) return undefined;
      const identity = `${info.dev}:${info.ino}`;
      const reset = previous !== undefined && (previous !== identity || info.size < offset);
      const from = reset ? 0 : offset;
      const start = Math.max(from, info.size - maxReadBytes); const skipped = start > from;
      const buffer = Buffer.alloc(Math.min(maxReadBytes, Math.max(0, info.size - start)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      return { bytes: buffer.subarray(0, bytesRead), offset: start + bytesRead, identity, reset, skipped };
    } finally { await handle.close(); }
  }
  private async follow() {
    if (!uuid.test(this.input.sessionId) || !taskID.test(this.input.taskId) || process.getuid?.() === undefined) return;
    let file: string | undefined;
    for (let attempt = 0; attempt < locateAttempts; attempt++) {
      try { file = await this.locate(); } catch {}
      if (file) break;
      if (this.stopped) return;
      await this.pause();
    }
    if (!file) return;
    let decoder = new TextDecoder(); let offset = 0; let identity: string | undefined; let failures = 0;
    let last = this.stopped;
    while (true) {
      let result: Awaited<ReturnType<ClaudeTaskOutputTail['read']>>;
      try { result = await this.read(file, offset, identity); } catch {}
      if (result) {
        failures = 0;
        if (result.reset || result.skipped) decoder = new TextDecoder();
        const text = (result.skipped ? '\n' : '') + decoder.decode(result.bytes, { stream: true });
        offset = result.offset; identity = result.identity;
        if (text || result.reset) await this.input.onChunk({ text, ...(result.reset ? { reset: true } : {}), ...(result.skipped ? { truncated: true } : {}) });
      } else if (++failures >= locateAttempts) return;
      if (last) {
        const rest = decoder.decode(); if (rest) await this.input.onChunk({ text: rest });
        return;
      }
      await this.pause(); last = this.stopped;
    }
  }
}

/** One SDK query owns these read-only followers. No file, task or native run
 * is resumed here; a new query must explicitly announce its own Bash calls. */
export class ClaudeTaskOutputReaders {
  private readers = new Map<string, { taskId: string; runId?: string; tail: ClaudeTaskOutputTail }>();
  private closed = false;
  constructor(private input: { root?: string; sessionId: string; parentTaskId?: string; isCommand: (id: string) => boolean; onChunk: (id: string, chunk: ClaudeOutputChunk) => Promise<void> }) {}
  private async stop(id: string) {
    const reader = this.readers.get(id); if (!reader) return;
    this.readers.delete(id); await reader.tail.stop();
  }
  async handle(message: SDKMessage) {
    if (this.closed || !this.input.root || !('session_id' in message) || message.session_id !== this.input.sessionId) return;
    if (message.type === 'system' && message.subtype === 'task_started') {
      const id = message.tool_use_id;
      if (!id || message.task_type !== 'local_bash' || message.is_backgrounded === true || message.parent_task_id && message.parent_task_id !== this.input.parentTaskId || message.ambient || message.skip_transcript
        || !this.input.isCommand(id) || this.readers.has(id)) return;
      const tail = new ClaudeTaskOutputTail({ root: this.input.root, sessionId: this.input.sessionId, taskId: message.task_id, onChunk: chunk => this.input.onChunk(id, chunk) });
      this.readers.set(id, { taskId: message.task_id, ...(message.run_id ? { runId: message.run_id } : {}), tail });
    } else if (message.type === 'user' && !message.parent_tool_use_id && Array.isArray(message.message.content)) {
      // Drain the last file bytes before publishing the authoritative result.
      for (const block of message.message.content) if (block.type === 'tool_result') await this.stop(block.tool_use_id);
    } else if (message.type === 'system' && (message.subtype === 'task_notification' || message.subtype === 'task_updated')) {
      for (const [id, reader] of this.readers) {
        if (reader.taskId !== message.task_id || reader.runId && reader.runId !== message.run_id) continue;
        if (message.subtype === 'task_notification' || message.patch.is_backgrounded === true || ['completed', 'failed', 'killed'].includes(message.patch.status ?? '')) await this.stop(id);
      }
    }
  }
  async close() { this.closed = true; await Promise.all([...this.readers.keys()].map(id => this.stop(id))); }
}
