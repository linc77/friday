import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';
import { OpenCode, type OpenCodeClient } from '@opencode/client';
import { nativeProviderCommand, nativeProviderEnvironment, type NativeProviderSettings } from './native-provider-config.js';
import { workspaceCommand } from './git-process.js';
import { acpRecord, type AcpRecord } from './acp-process.js';

export type OpenCodeGeneration = 1 | 2;
export const minimumOpenCodeVersion = '1.14.19';
export function openCodeGeneration(version: string): OpenCodeGeneration {
  const match = version.match(/\b(\d+)\.(\d+)\.(\d+)\b/); if (!match) throw new Error('无法确认 OpenCode 版本');
  const parts = match.slice(1).map(Number);
  if (parts[0]! < 1 || parts[0] === 1 && (parts[1]! < 14 || parts[1] === 14 && parts[2]! < 19)) throw new Error(`OpenCode 需要 ${minimumOpenCodeVersion} 或更新版本`);
  return parts[0]! >= 2 ? 2 : 1;
}
export const openCodeAuthorization = (password: string): Record<string, string> => password ? { Authorization: 'Basic ' + Buffer.from(`opencode:${password}`, 'utf8').toString('base64') } : {};
const at = (base: string, path: string) => base.replace(/\/+$/, '') + path;
export async function probeOpenCodeServer(url: string, password: string): Promise<{ generation: OpenCodeGeneration; version: string }> {
  for (const path of ['/api/info', '/global/health']) {
    let response: Response;
    try { response = await fetch(at(url, path), { headers: openCodeAuthorization(password), signal: AbortSignal.timeout(5000), redirect: 'error' }); }
    catch { throw new Error('无法连接 OpenCode 服务'); }
    if (response.status === 401) { await response.body?.cancel(); throw new Error('OpenCode 服务拒绝了连接密码'); }
    if (response.status !== 200 || response.headers.get('Content-Type')?.split(';')[0]?.trim() !== 'application/json') { await response.body?.cancel(); continue; }
    let value: AcpRecord | undefined; try { value = acpRecord(await response.json()); } catch { continue; }
    if (typeof value?.version !== 'string' || path === '/api/info' && !Number.isInteger(value.pid) || path === '/global/health' && value?.healthy !== true) continue;
    const generation = openCodeGeneration(value.version);
    if (path === '/api/info' && generation !== 2 || path === '/global/health' && generation !== 1) continue;
    return { generation, version: value.version };
  }
  throw new Error('服务没有返回有效的 OpenCode 版本信息');
}

export class OpenCodeServer {
  readonly v1?: OpencodeClient;
  readonly v2?: OpenCodeClient;
  private closing?: Promise<void>;
  private exited?: Promise<void>;
  private dead = false;
  private constructor(readonly url: string, readonly password: string, readonly generation: OpenCodeGeneration, readonly version: string, readonly cwd: string, readonly child?: ChildProcessWithoutNullStreams) {
    const headers = openCodeAuthorization(password);
    // Redirects must not forward the configured server credential.
    const request: typeof fetch = (input, init) => {
      const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return fetch(input, { ...init, redirect: 'error', signal: upstream ? AbortSignal.any([upstream, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
    };
    if (generation === 1) this.v1 = createOpencodeClient({ baseUrl: url, directory: cwd, headers, fetch: request });
    else this.v2 = OpenCode.make({ baseUrl: url, headers, fetch: request });
    if (child) this.exited = child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise(resolve => child.once('close', () => { this.dead = true; resolve(); }));
  }
  get available() { return !this.closing && !this.dead && (!this.child || this.child.exitCode === null && !this.child.signalCode); }
  static async connect(settings: NativeProviderSettings, cwd: string) {
    const env = nativeProviderEnvironment('opencode', settings);
    if (settings.serverUrl) {
      const password = settings.serverPassword || env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD || '', probe = await probeOpenCodeServer(settings.serverUrl, password);
      return new OpenCodeServer(settings.serverUrl, password, probe.generation, probe.version, cwd);
    }
    const command = await nativeProviderCommand('opencode', settings);
    const version = await workspaceCommand(cwd, command, ['--version'], { env, timeout: 10_000, limit: 1024 * 1024 });
    if (version.code !== 0) throw new Error('OpenCode 已安装但无法运行');
    const generation = openCodeGeneration(version.stdout), password = randomBytes(32).toString('base64url');
    const environment: NodeJS.ProcessEnv = { ...env, NO_COLOR: '1', ...(generation === 2 ? { OPENCODE_PASSWORD: password } : { OPENCODE_SERVER_PASSWORD: password }) };
    if (generation === 2) delete environment.OPENCODE_SERVER_PASSWORD; else delete environment.OPENCODE_PASSWORD;
    const reservation = createServer(); await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const address = reservation.address(); if (!address || typeof address === 'string') throw new Error('无法分配 OpenCode 服务端口');
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    const source = import.meta.url.endsWith('.ts'), host = fileURLToPath(new URL(source ? './opencode-host.ts' : './opencode-host.js', import.meta.url));
    const child = spawn(process.execPath, [...(source ? ['--import', import.meta.resolve('tsx')] : []), host, command, 'serve', '--hostname=127.0.0.1', `--port=${address.port}`], { cwd, env: environment, detached: process.platform !== 'win32', stdio: 'pipe' });
    let timer: NodeJS.Timeout | undefined, pending = '', settled = false;
    const url = await new Promise<string>((resolve, reject) => {
      const fail = () => { if (!settled) { settled = true; reject(new Error('OpenCode 服务未能启动，请检查主机工具配置')); } };
      const decoder = new StringDecoder('utf8'), collect = (buffer: Buffer) => {
        pending = (pending + decoder.write(buffer)).slice(-64 * 1024);
        const match = pending.match(/server listening on\s+(https?:\/\/[^\s]+)/i);
        if (!match || settled) return;
        let candidate: URL; try { candidate = new URL(match[1]!); } catch { fail(); return; }
        if (candidate.protocol !== 'http:' || candidate.hostname !== '127.0.0.1' || !candidate.port || candidate.username || candidate.password) { fail(); return; }
        settled = true; resolve(candidate.origin);
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect); child.once('error', fail); child.once('close', fail); timer = setTimeout(fail, 30_000);
    }).catch(async error => { clearTimeout(timer); await stop(child); throw error; }); clearTimeout(timer);
    try { const probe = await probeOpenCodeServer(url, password); if (probe.generation !== generation) throw new Error('OpenCode CLI 与服务协议不一致'); return new OpenCodeServer(url, password, generation, probe.version, cwd, child); }
    catch (error) { await stop(child); throw error; }
  }
  async subscribe(receive: (value: AcpRecord) => void, failure: (error: Error) => void) {
    const controller = new AbortController();
    const acceptance = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try { response = await fetch(at(this.url, this.generation === 2 ? '/api/event' : '/event'), { headers: { ...openCodeAuthorization(this.password), Accept: 'text/event-stream', ...(this.generation === 1 ? { 'x-opencode-directory': this.cwd } : {}) }, signal: controller.signal, redirect: 'error' }); }
    catch { throw new Error('无法订阅 OpenCode 事件'); }
    finally { clearTimeout(acceptance); }
    if (!response.ok || !response.headers.get('Content-Type')?.includes('text/event-stream') || !response.body) { await response.body?.cancel(); throw new Error('OpenCode 未接受事件订阅'); }
    let timer: NodeJS.Timeout | undefined;
    const touch = () => { clearTimeout(timer); timer = setTimeout(() => { failure(new Error('OpenCode 事件流已停止发送数据')); controller.abort(); }, 45_000); };
    touch(); const reader = response.body.getReader();
    const done = (async () => {
      let text = ''; const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break; touch(); text += decoder.decode(part.value, { stream: true });
          if (text.length > 64 * 1024 * 1024) throw new Error('OpenCode 事件帧过大');
          let match: RegExpExecArray | null;
          while ((match = /\r?\n\r?\n/.exec(text))) {
            const frame = text.slice(0, match.index); text = text.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); if (!data) continue;
            let value: AcpRecord | undefined; try { value = acpRecord(JSON.parse(data)); } catch { throw new Error('OpenCode 返回了无法读取的事件帧'); }
            if (value) receive(value);
          }
        }
        if (!controller.signal.aborted) throw new Error('OpenCode 事件连接已关闭');
      } catch (error) { if (!controller.signal.aborted) failure(error instanceof Error ? error : new Error('OpenCode 事件连接异常')); }
      finally { clearTimeout(timer); reader.releaseLock(); }
    })();
    // HTTP acceptance is the barrier; callers can now create or resume a
    // session without waiting for the first model event to open the stream.
    return { close: async () => { clearTimeout(timer); controller.abort(); await done; } };
  }
  async updateV1Permissions(sessionID: string, permission: AcpRecord[]) {
    // The 1.14 server accepts permission updates, while the pinned generated
    // SDK omits that newer field from both its type and request serializer.
    let response: Response;
    try { response = await fetch(at(this.url, '/session/' + encodeURIComponent(sessionID)), { method: 'PATCH', headers: { ...openCodeAuthorization(this.password), 'Content-Type': 'application/json', 'x-opencode-directory': this.cwd }, body: JSON.stringify({ permission }), signal: AbortSignal.timeout(8000), redirect: 'error' }); }
    catch { throw new Error('无法更新 OpenCode 会话权限'); }
    await response.body?.cancel(); if (!response.ok) throw new Error('OpenCode 拒绝了会话权限更新');
  }
  close(): Promise<void> { return this.closing ??= this.child ? stop(this.child, this.exited) : Promise.resolve(); }
}
async function stop(child: ChildProcessWithoutNullStreams, exited = new Promise<void>(resolve => child.once('close', () => resolve()))) {
  if (child.exitCode !== null || child.signalCode) return;
  const signal = (value: NodeJS.Signals) => { try { if (process.platform === 'win32') child.kill(value); else if (child.pid) process.kill(-child.pid, value); } catch {} };
  signal('SIGTERM'); let timer: NodeJS.Timeout | undefined;
  await Promise.race([exited, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
  if (child.exitCode === null && !child.signalCode) signal('SIGKILL'); await exited;
}
