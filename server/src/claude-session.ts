import { Worker } from 'node:worker_threads';
import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';

type Read = { action: 'read'; sessionId: string; dir: string };
type Fork = { action: 'fork'; sessionId: string; dir: string; upToMessageId: string; title: string };

// The SDK's disk session APIs resolve CLAUDE_CONFIG_DIR from process.env. A
// worker gives each account its own environment without mutating the service's
// environment while other tasks are running. All transcript logic stays in SDK.
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const sdk = await import(workerData.sdk);
  const input = workerData.input;
  const result = input.action === 'fork'
    ? await sdk.forkSession(input.sessionId, { dir: input.dir, upToMessageId: input.upToMessageId, title: input.title })
    : await sdk.getSessionMessages(input.sessionId, { dir: input.dir });
  parentPort.postMessage({ ok: true, result }); parentPort.close();
})().catch(() => { parentPort.postMessage({ ok: false }); parentPort.close(); });
`;

export function claudeSessionCall(home: string, input: Read, signal: AbortSignal): Promise<SessionMessage[]>;
export function claudeSessionCall(home: string, input: Fork, signal: AbortSignal): Promise<{ sessionId: string }>;
export async function claudeSessionCall(home: string, input: Read | Fork, signal: AbortSignal): Promise<any> {
  signal.throwIfAborted();
  const worker = new Worker(workerCode, { eval: true, execArgv: [], env: { ...process.env, CLAUDE_CONFIG_DIR: home }, workerData: { sdk: import.meta.resolve('@anthropic-ai/claude-agent-sdk'), input }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  return new Promise((resolve, reject) => {
    let reply: { ok: boolean; result?: unknown } | undefined; let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; void worker.terminate(); };
    const abort = () => stop(new Error('Claude 会话操作已中止，未知结果不会自动重复'));
    const timer = setTimeout(() => stop(new Error('Claude 会话操作超时，未知结果不会自动重复')), 20_000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    worker.on('message', message => { reply = message; });
    worker.on('error', () => { failure ??= new Error('Claude 原生会话操作失败，请核对配置目录和历史边界'); });
    worker.on('exit', code => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code === 0 && reply?.ok) resolve(reply.result);
      else reject(new Error('Claude 原生会话操作失败，请核对配置目录和历史边界'));
    });
  });
}
