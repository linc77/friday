import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable, type Transform } from 'node:stream';
import { ClientApp, ndJsonStream, RequestError, type ClientConnection, type ClientRequestContext, type AnyMessage } from '@agentclientprotocol/sdk';

export type AcpRecord = Record<string, any>;
export const acpRecord = (value: unknown): AcpRecord | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : undefined;
const wireKey = (id: unknown) => typeof id + ':' + String(id);
type Reply = { written: Promise<void>; resolve: () => void; reject: (error: Error) => void };

/** The stable SDK owns JSON-RPC framing, dispatch and cancellation. Its raw
 * handlers preserve the negotiating v1/v2 wire shape used by T3; protocol
 * generation is determined from initialize's response, never its number alone.
 * The output observer confirms that native permission replies were written. */
export class AcpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  private stopping = false;
  private closed = false;
  private failure?: Error;
  private exited: Promise<void>;
  private closing?: Promise<void>;
  private receipts = new Map<string, Reply>();
  onRequest?: (request: ClientRequestContext<unknown>) => Promise<unknown>;
  onNotification?: (method: string, params: unknown) => void;
  onExit?: (error: Error) => void;
  constructor(readonly label: string, command: string, args: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, options: { stdoutTransform?: Transform; onStderr?: (chunk: Buffer) => void } = {}) {
    this.child = spawn(command, args, { cwd, env, stdio: 'pipe', detached: process.platform !== 'win32' });
    this.exited = new Promise(resolve => this.child.once('close', code => {
      this.closed = true; this.fail(new Error(`${label} 进程已退出（${code ?? 'signal'}）`));
      this.connection?.close(); if (!this.stopping) this.onExit?.(this.failure!); resolve();
    }));
    this.child.on('error', error => this.fail(new Error(`无法启动 ${label}（${(error as NodeJS.ErrnoException).code ?? 'IO'}）`)));
    this.child.stdin.on('error', () => this.fail(new Error(`${label} 输入连接已关闭`)));
    if (options.onStderr) this.child.stderr.on('data', chunk => { try { options.onStderr!(chunk); } catch (error) { const failure = error instanceof Error ? error : new Error(label + ' stderr transport failed'); this.fail(failure); this.onExit?.(failure); void this.close(); } });
    this.child.stderr.resume(); // Native diagnostics can contain credentials.
    const stdout = options.stdoutTransform ? this.child.stdout.pipe(options.stdoutTransform) : this.child.stdout;
    if (options.stdoutTransform) options.stdoutTransform.on('error', error => { this.fail(error); this.onExit?.(error); void this.close(); });
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(stdout) as ReadableStream<Uint8Array>, { maxMessageBytes: 64 * 1024 * 1024 });
    const writer = stream.writable.getWriter();
    const writable = new WritableStream<AnyMessage>({
      write: async value => {
        await writer.write(value);
        const record = value as AcpRecord;
        if (record.id !== undefined && ('result' in record || 'error' in record)) this.receipts.get(wireKey(record.id))?.resolve();
      }, close: () => writer.close(), abort: reason => writer.abort(reason),
    });
    const readable = stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform: (value, controller) => {
        // The NDJSON decoder accepts JSON-RPC batches. Deliver each native
        // record in wire order through the SDK's stable raw handler surface.
        for (const message of Array.isArray(value) ? value : [value]) {
          // Native attribution extensions and their following session chunks
          // must reach the adapter in the same wire order. Mixing direct
          // session updates with SDK-dispatched extension notifications can
          // deliver a child's author marker after its text. No ActiveSession
          // router is used by this raw transport; the SDK still owns RPCs.
          if (typeof message.method === 'string' && message.id === undefined) this.onNotification?.(message.method, message.params);
          else controller.enqueue(message);
        }
      },
    }));
    this.connection = new ClientApp({ name: 'Friday' })
      .onRequest('*', async request => {
        if (!this.onRequest) throw RequestError.methodNotFound(request.method);
        return this.onRequest(request);
      })
      .onNotification('*', notification => this.onNotification?.(notification.method, notification.params))
      .connect({ readable, writable });
    void this.connection.closed.then(() => {
      if (!this.stopping) { const error = this.failure ?? new Error(`${label} ACP 连接已关闭`); this.fail(error); this.onExit?.(error); }
    });
  }
  private fail(error: Error) { this.failure ??= error; for (const receipt of this.receipts.values()) receipt.reject(error); }
  async call(method: string, params: AcpRecord = {}, timeoutMs: number | null = 30_000): Promise<AcpRecord> {
    if (this.closed || this.failure) throw this.failure ?? new Error(`${this.label} 连接已关闭`);
    let timer: NodeJS.Timeout | undefined;
    // The stable public raw entry preserves provider extensions and v2 payloads
    // instead of forcing the experimental v2 API's initialization state machine.
    const agent = this.connection.agent;
    const requestWire = agent.request.bind(agent) as (method: string, params: AcpRecord) => Promise<unknown>;
    const request = requestWire(method, params);
    try {
      const mapped = timeoutMs === null ? await request : await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${this.label} ${method} 请求超时；不会自动重试`)), timeoutMs); })]);
      return acpRecord(mapped) ?? {};
    } finally { clearTimeout(timer); }
  }
  notify(method: string, params: AcpRecord) {
    const agent = this.connection.agent;
    return (agent.notify.bind(agent) as (method: string, params: AcpRecord) => Promise<void>)(method, params);
  }
  watchReply(id: unknown) {
    const key = wireKey(id); let resolve!: () => void, reject!: (error: Error) => void;
    const written = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void written.catch(() => {});
    const reply = { written, resolve, reject }; this.receipts.set(key, reply);
    return { written, dispose: () => { if (this.receipts.get(key) === reply) this.receipts.delete(key); } };
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopping = true; this.connection.close(); this.fail(new Error(`${this.label} 连接已关闭`));
      if (!this.closed) {
        this.signal('SIGTERM'); let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
        if (!this.closed) this.signal('SIGKILL');
      }
      await this.exited;
      // A native parent may exit on TERM while an owned shell ignores it.
      // The detached process group remains ours until its final member exits.
      if (process.platform !== 'win32' && this.child.pid) { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }
      this.receipts.clear();
    })();
  }
  private signal(signal: NodeJS.Signals) {
    if (this.closed || !this.child.pid) return;
    try { if (process.platform === 'win32') this.child.kill(signal); else process.kill(-this.child.pid, signal); } catch { /* Already exited. */ }
  }
}
