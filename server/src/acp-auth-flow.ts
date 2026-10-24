import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { acpRecord, type AcpRecord, type AcpProcess } from './acp-process.js';
import { acpNativeSession, type AcpNativeLease } from './acp-native.js';
import { terminalPty, stopTerminal } from './terminal-pty.js';

// Auth kinds, terminal invocation and post-login verification follow T3
// 8cd9641f provider-acp-registry/server/{auth,probe}.ts. MIT, T3 Tools Inc.;
// full license: vendor/t3code/LICENSE.
export type AcpAuthMethod = { id: string; name: string; description?: string; type: 'agent' | 'terminal' | 'env_var'; envVarNames?: string[]; link?: string };
export type AcpAuthInteraction = { id: string; type: 'browser'; url: string } | { id: string; type: 'terminal'; output: string; outputOffset: number };
export type AcpAuthState = { pending: boolean; flowId: string; revision: number; phase: string; methodId?: string; interaction?: AcpAuthInteraction; error?: string };
type AuthHost = {
  open(handler?: AcpProcess['onRequest']): Promise<AcpNativeLease>;
  resolve(): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv; close(): Promise<void> }>;
  cwd: string;
  settled(): Promise<void>;
  changed(): Promise<void>;
  redact(error: unknown): string;
};
export function acpAuthWebURL(value: unknown) {
  if (typeof value !== 'string' || value.length > 8192) return;
  try { const url = new URL(value); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch {}
}
export function acpAuthMethods(values: unknown): AcpAuthMethod[] {
  if (!Array.isArray(values)) return [];
  const result: AcpAuthMethod[] = [], ids = new Set<string>();
  for (const raw of values) {
    const value = acpRecord(raw), id = value?.id, type = value?.type ?? 'agent';
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || ids.has(id) || !['agent', 'terminal', 'env_var'].includes(type)) continue;
    ids.add(id);
    const vars = type === 'env_var' && Array.isArray(value?.vars) ? value.vars.flatMap((item: unknown) => {
      const name = acpRecord(item)?.name; return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? [name] : [];
    }).slice(0, 16) : [];
    const link = type === 'env_var' ? acpAuthWebURL(value?.link) : undefined;
    result.push({ id, name: typeof value?.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 160) : id,
      ...(typeof value?.description === 'string' ? { description: value.description.slice(0, 2000) } : {}), type,
      ...(vars.length ? { envVarNames: vars } : {}), ...(link ? { link } : {}) });
    if (result.length === 32) break;
  }
  return result;
}

/** An explicitly started, ephemeral sign-in. Restarts never replay a login,
 * terminal input or browser consent. Flow and interaction IDs reject callbacks
 * from old windows; terminal output stays in a bounded owner-only buffer. */
export class AcpAuthFlow {
  readonly id = randomUUID();
  private value: AcpAuthState = { pending: true, flowId: this.id, revision: 0, phase: 'starting' };
  private events = new EventEmitter();
  private lease?: AcpNativeLease;
  private pty?: IPty;
  private ptyExited?: Promise<void>;
  private resources?: Awaited<ReturnType<AuthHost['resolve']>>;
  private consent?: { id: string; resolve(value: boolean): void };
  private cancelled = false;
  private interrupted = false;
  private changedCredentials = false;
  private done: Promise<void>;
  private deadline?: NodeJS.Timeout;
  constructor(private host: AuthHost, methodId?: string) {
    this.done = this.run(methodId);
    this.deadline = setTimeout(() => { this.interrupted = true; void this.cancel(); }, 5 * 60_000);
    this.deadline.unref();
  }
  state(): AcpAuthState { return structuredClone(this.value); }
  get pending() { return this.value.pending; }
  subscribe(listener: () => void) { this.events.on('change', listener); return () => { this.events.off('change', listener); }; }
  private publish() { this.value.revision++; this.events.emit('change'); }
  private current() { if (this.cancelled) throw new Error('认证已取消'); }
  private async request(request: Parameters<NonNullable<AcpProcess['onRequest']>>[0]) {
    const input = acpRecord(request.params), url = acpAuthWebURL(input?.url), id = input?.elicitationId;
    if (!['elicitation/create', 'elicitation_create'].includes(request.method) || input?.mode !== 'url' || !url || typeof id !== 'string' || !id.trim() || id.length > 128 || this.consent || this.cancelled) return { action: 'decline' };
    const token = randomUUID();
    this.value.phase = 'browser'; this.value.interaction = { type: 'browser', id: token, url };
    this.publish();
    const accepted = await new Promise<boolean>(resolve => { this.consent = { id: token, resolve }; });
    this.consent = undefined; delete this.value.interaction; this.value.phase = 'authenticating';
    this.publish();
    return { action: accepted ? 'accept' : 'decline' };
  }
  private async open() {
    const lease = await this.host.open(request => this.request(request));
    if (this.cancelled) { await lease.close(); this.current(); }
    this.lease = lease; return lease;
  }
  private async verify(lease: AcpNativeLease) {
    this.current(); this.value.phase = 'verifying'; delete this.value.interaction;
    this.publish();
    await acpNativeSession(lease.client, lease.initialized, { cwd: this.host.cwd, mcpServers: [] });
    this.current();
  }
  private async terminal(method: AcpRecord) {
    const args = method.args ?? [], env = method.env ?? {};
    if (!Array.isArray(args) || args.length > 64 || args.some(value => typeof value !== 'string' || value.length > 8192 || value.includes('\0')) || !acpRecord(env) || Object.keys(env).length > 256 || Object.entries(env).some(([name, value]) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) || typeof value !== 'string' || value.length > 16384 || value.includes('\0'))) throw new Error('工具声明的终端认证参数无效');
    await this.lease?.close(); this.lease = undefined; this.current();
    const resolved = await this.host.resolve(); this.resources = resolved; this.current();
    const module = await terminalPty(); this.current();
    const variables = Object.fromEntries(Object.entries({ ...resolved.env, ...env, TERM: 'xterm-256color', TERM_PROGRAM: 'Friday' }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    this.changedCredentials = true;
    const pty = module.spawn(resolved.command, [...resolved.args, ...args], { cwd: this.host.cwd, env: variables, cols: 80, rows: 24, name: 'xterm-256color' });
    this.pty = pty; this.value.phase = 'terminal'; this.value.interaction = { id: 'terminal', type: 'terminal', output: '', outputOffset: 0 };
    this.publish();
    let ended!: (code: number) => void;
    const exit = new Promise<number>(resolve => { ended = resolve; }); this.ptyExited = exit.then(() => {});
    const data = pty.onData(chunk => {
      const interaction = this.value.interaction;
      if (this.cancelled || interaction?.type !== 'terminal') return;
      interaction.outputOffset += chunk.length;
      let output = (interaction.output + chunk).slice(-16_384);
      if (output.length && output.charCodeAt(0) >= 0xdc00 && output.charCodeAt(0) <= 0xdfff) output = output.slice(1);
      interaction.output = output;
      this.publish();
    });
    const stop = pty.onExit(value => ended(value.exitCode));
    try { if (await exit !== 0) throw new Error('终端登录未成功完成'); }
    finally { data.dispose(); stop.dispose(); this.pty = undefined; }
    this.current();
  }
  private async run(methodId?: string) {
    try {
      let lease = await this.open(); this.current();
      const methods = acpAuthMethods(lease.initialized.authMethods), selected = methodId ? methods.find(value => value.id === methodId) : methods[0];
      if (!selected) throw new Error('工具未提供所选认证方式，请重新读取认证方式');
      this.value.methodId = selected.id; this.value.phase = 'authenticating';
      this.publish();
      if (selected.type === 'terminal') {
        await this.terminal(lease.initialized.authMethods.find((value: AcpRecord) => value.id === selected.id));
        lease = await this.open();
      } else if (selected.type === 'agent') {
        this.changedCredentials = true;
        await lease.client.call(lease.initialized.protocolGeneration === 2 ? 'auth/login' : 'authenticate', { methodId: selected.id }, 300000);
      }
      // Legacy env_var methods only verify the configured environment; their
      // IDs must never be sent to authenticate/auth/login.
      await this.verify(lease);
      this.changedCredentials = true;
      this.value.phase = 'complete';
    } catch (error) {
      this.value.phase = this.cancelled ? 'cancelled' : 'failed';
      if (!this.cancelled || this.interrupted) this.value.error = this.interrupted ? '认证等待超时，请重新开始' : this.host.redact(error);
    } finally {
      clearTimeout(this.deadline);
      this.consent?.resolve(false); this.consent = undefined;
      const cleanup = await Promise.allSettled([
        ...(this.pty && this.ptyExited ? [stopTerminal(this.pty, this.ptyExited)] : []),
        ...(this.lease ? [this.lease.close()] : []), ...(this.resources ? [this.resources.close()] : []),
      ]);
      const cleanupFailure = cleanup.find(value => value.status === 'rejected');
      if (cleanupFailure?.status === 'rejected') { this.value.error = this.host.redact(cleanupFailure.reason); this.value.phase = 'failed'; }
      delete this.value.interaction;
      // An interrupted sign-in may already have changed native credentials.
      // Invalidate the prior binding even when completion was uncertain.
      try { if (this.changedCredentials) await this.host.settled(); } catch (error) { this.value.error = this.host.redact(error); this.value.phase = 'failed'; }
      this.value.pending = false;
      this.publish();
      await this.host.changed().catch(() => {});
    }
  }
  async ready() {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.done, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer); return this.state();
  }
  respond(input: unknown) {
    const value = acpRecord(input), interaction = this.value.interaction;
    if (!value || value.flowId !== this.id || !this.value.pending || !interaction || value.interactionId !== interaction.id) throw new Error('认证交互已改变，请刷新后重试');
    if (interaction.type === 'browser') {
      if (!['accept', 'decline'].includes(value.action) || !this.consent) throw new Error('浏览器认证回答无效');
      const consent = this.consent; this.consent = undefined; delete this.value.interaction; consent.resolve(value.action === 'accept');
      this.publish();
    } else {
      if (!this.pty || value.data !== undefined && (typeof value.data !== 'string' || Buffer.byteLength(value.data) > 16384) || value.cols !== undefined && (!Number.isInteger(value.cols) || value.cols < 2 || value.cols > 500) || value.rows !== undefined && (!Number.isInteger(value.rows) || value.rows < 2 || value.rows > 300) || (value.cols === undefined) !== (value.rows === undefined)) throw new Error('终端认证输入无效');
      if (value.cols !== undefined) this.pty.resize(value.cols, value.rows);
      if (value.data) this.pty.write(value.data);
    }
    return this.state();
  }
  async cancel(flowId?: string) {
    if (flowId !== undefined && flowId !== this.id) throw new Error('认证流程已改变，请刷新后重试');
    if (!this.value.pending) return this.state();
    this.cancelled = true; this.consent?.resolve(false); this.consent = undefined;
    if (this.pty && this.ptyExited) await stopTerminal(this.pty, this.ptyExited);
    await this.lease?.close(); await this.done; return this.state();
  }
}
