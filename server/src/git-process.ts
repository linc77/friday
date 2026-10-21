import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';

export function gitOutputText(text: string) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/([?&](?:access_token|token|key|password|secret)=)[^\s&]+/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/\r/g, '').trimEnd();
}
export type GitProcessOptions = {
  signal?: AbortSignal; timeout?: number | null; input?: string | Buffer; env?: NodeJS.ProcessEnv;
  inputPath?: string; stdoutPath?: string;
  allowFailure?: boolean; onLine?: (line: string) => void; hashOutput?: boolean; limit?: number;
  killGraceMs?: number;
  // Read-only metadata may keep a bounded prefix while draining a larger blob.
  truncateStdout?: boolean;
  streamStderr?: boolean;
};
export function workspaceCommand(cwd: string, command: string, args: string[], options: GitProcessOptions = {}) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...inherited, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...options.env };
  return new Promise<{ stdout: string; stderr: string; code: number; digest: string; stdoutTruncated?: boolean }>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('Git 操作已中断')); return; }
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, env, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
    const hash = createHash('sha256'); const limit = options.limit ?? 1024 * 1024;
    let stdout = ''; let stderr = ''; let bytes = 0; let overflow = false; let timedOut = false; let line = ''; let settled = false;
    let stdoutBytes = 0; let stdoutTruncated = false;
    let hardStop: NodeJS.Timeout | undefined;
    let streamError: Error | undefined;
    const stdoutDecoder = new StringDecoder('utf8'); const stderrDecoder = new StringDecoder('utf8');
    const kill = (signal: NodeJS.Signals) => { try { if (grouped && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch {} };
    const abort = () => { kill('SIGTERM'); clearTimeout(hardStop); hardStop = setTimeout(() => kill('SIGKILL'), options.killGraceMs ?? 2_000); };
    const timer = options.timeout===null?undefined:setTimeout(() => { timedOut = true; abort(); }, options.timeout ?? 15_000);
    const collectText = (value: string, error: boolean) => {
      if (!error && (options.hashOutput || options.stdoutPath)) { /* Stream binary packs or hash full patches without retaining payloads. */ }
      else {
        if (error) stderr = (stderr + value).slice(-limit); else stdout += value;
      }
      if (options.onLine && !(options.stdoutPath && !error)) {
        line += value;
        const lines = line.split(/[\r\n]/); line = lines.pop()!.slice(-4096);
        for (const value of lines) if (value.trim()) options.onLine(gitOutputText(value).slice(0, 2000));
      }
    };
    const collect = (chunk: Buffer, error: boolean) => {
      if (!error) hash.update(chunk);
      if(error&&options.streamStderr){collectText(stderrDecoder.write(chunk),true);return;}
      if (!error && options.truncateStdout && !options.hashOutput && !options.stdoutPath) {
        const remaining = Math.max(0, limit - stdoutBytes); stdoutBytes += chunk.length;
        if (chunk.length > remaining) stdoutTruncated = true;
        if (!overflow && remaining) collectText(stdoutDecoder.write(chunk.subarray(0, remaining)), false);
        return;
      }
      if (error || !options.hashOutput && !options.stdoutPath) {
        bytes += chunk.length;
        if (bytes > limit) { if (!overflow) { overflow = true; abort(); } return; }
      }
      if (!overflow) collectText((error ? stderrDecoder : stdoutDecoder).write(chunk), error);
    };
    child.stdout.on('data', chunk => collect(chunk, false)); child.stderr.on('data', chunk => collect(chunk, true));
    options.signal?.addEventListener('abort', abort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(hardStop); options.signal?.removeEventListener('abort', abort); };
    child.once('error', () => { if (!settled) { settled = true; cleanup(); reject(new Error('无法启动 ' + command + '，请检查本机工具安装')); } });
    const pipes: Promise<void>[] = [];
    const track = (promise: Promise<void>, input = false) => pipes.push(promise.catch(error => {
      if (input && (error as NodeJS.ErrnoException).code === 'EPIPE') return;
      streamError = error instanceof Error ? error : new Error('Git 文件传输失败');
      if (!settled) abort();
    }));
    if (options.stdoutPath) track(pipeline(child.stdout, createWriteStream(options.stdoutPath, { flags: 'wx', mode: 0o600 })));
    child.once('close', async code => {
      if (settled) return;
      await Promise.all(pipes);
      if (settled) return; settled = true; cleanup();
      if (!overflow) { if (!stdoutTruncated) collectText(stdoutDecoder.end(), false); collectText(stderrDecoder.end(), true); }
      if (line.trim()) options.onLine?.(gitOutputText(line).slice(0, 2000));
      if (options.signal?.aborted || timedOut || overflow) { reject(new Error(options.signal?.aborted ? 'Git 操作已中断' : timedOut ? 'Git 操作超时，请核对当前状态后重试' : 'Git 输出过大，请在本机终端中检查')); return; }
      if (streamError) { reject(new Error('Git 文件传输失败：' + gitOutputText(streamError.message))); return; }
      if (code !== 0 && !options.allowFailure) { reject(new Error(gitOutputText(stderr || stdout).slice(-6000) || 'Git 操作失败')); return; }
      resolve({ stdout, stderr: gitOutputText(stderr), code: code ?? -1, digest: hash.digest('hex'), ...(options.truncateStdout ? { stdoutTruncated } : {}) });
    });
    child.stdin.on('error', () => {});
    if (options.inputPath) track(pipeline(createReadStream(options.inputPath), child.stdin), true);
    else child.stdin.end(options.input ?? '');
  });
}
export function taskGit(cwd: string, args: string[], options: GitProcessOptions & { hooks?: boolean } = {}) {
  return workspaceCommand(cwd, 'git', ['--no-pager', '-c', 'core.fsmonitor=false', ...(options.hooks ? [] : ['-c', 'core.hooksPath=/dev/null']), ...args], options);
}
