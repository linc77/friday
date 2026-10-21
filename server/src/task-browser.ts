import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const browserLoopbackHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
export interface TaskBrowserTerminalOwner { threadId: string; terminalId: string }
export interface TaskBrowserServer { host: string; port: number; url: string; processName: string | null; pid: number | null; terminal: TaskBrowserTerminalOwner | null }
export function normalizeBrowserURL(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048 || !raw.trim()) throw new Error('请输入网页地址');
  const value = raw.trim(), local = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i.test(value);
  const url = new URL(value.includes('://') ? value : `${local ? 'http' : 'https'}://${value}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('网页预览只支持 HTTP 和 HTTPS');
  if (url.href.length > 2048) throw new Error('网页地址过长');
  return url.href;
}
export function resolveBrowserAddress(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('网页地址过长');
  const value = raw.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || !value) return normalizeBrowserURL(value);
  if (!/\s/.test(value)) {
    const protocol = /^([A-Za-z][A-Za-z\d+.-]*):/.exec(value)?.[1]?.toLowerCase().concat(':');
    const nonWeb = new Set(['about:', 'blob:', 'chrome:', 'data:', 'file:', 'ftp:', 'javascript:', 'mailto:', 'sms:', 'ssh:', 'tel:', 'view-source:', 'ws:', 'wss:']);
    if (protocol && (nonWeb.has(protocol) || !/^[^/?#:@]+:\d+(?:[/?#]|$)/.test(value))) {
      if (!['http:', 'https:'].includes(protocol)) throw new Error('网页预览只支持 HTTP 和 HTTPS');
      return normalizeBrowserURL(value);
    }
    const authority = value.split(/[/?#]/, 1)[0] ?? '', withoutCredentials = authority.replace(/^[^@]*@/, ''), host = withoutCredentials.replace(/:\d+$/, '');
    if (host.length < withoutCredentials.length || /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try { return normalizeBrowserURL(value); } catch {}
    }
  }
  const search = 'https://duckduckgo.com/?q=' + encodeURIComponent(value); if (search.length > 2048) throw new Error('网页地址过长'); return search;
}
export function parseBrowserListeners(raw: string, owners: ReadonlyMap<number, TaskBrowserTerminalOwner> = new Map()): TaskBrowserServer[] {
  let pid: number | null = null, processName: string | null = null;
  const values = new Map<number, TaskBrowserServer>();
  for (const line of raw.split('\n')) {
    const tag = line[0], value = line.slice(1);
    if (tag === 'p') { const number = Number.parseInt(value, 10); pid = Number.isFinite(number) && number > 0 ? number : null; processName = null; }
    if (tag === 'c') processName = value.trim() || null;
    if (tag !== 'n') continue;
    const match = /^(.+):([^:]+)$/.exec(value.split(' ', 1)[0]?.trim() ?? ''); if (!match || !['*', '[::]', '[::1]', ...browserLoopbackHosts].includes(match[1])) continue;
    const port = Number.parseInt(match[2],10); if (!Number.isFinite(port) || port < 1 || port > 65535) continue;
    const previous = values.get(port);
    const terminal = pid === null ? null : owners.get(pid) ?? null;
    if (!previous) values.set(port, { host: 'localhost', port, url: `http://localhost:${port}`, processName, pid, terminal });
    else if (!terminal) values.set(port, { ...previous, terminal: null });
  }
  return [...values.values()].sort((a, b) => a.port - b.port);
}
export function browserConfiguredURLs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('最多配置 32 个本地地址');
  const values = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) throw new Error('本地服务地址无效或过长');
    try { const url = new URL(raw.trim()); if (!['http:', 'https:'].includes(url.protocol) || !browserLoopbackHosts.has(url.hostname)) continue; if (url.hostname === '0.0.0.0') url.hostname = 'localhost'; if (url.href.length <= 2048) values.add(url.href); } catch {}
  }
  return [...values];
}
export function browserWebResponse(status: number, contentType: string | null, location: string | null): boolean {
  if ([301, 302, 303, 307, 308].includes(status) && location?.trim()) return true;
  return status >= 200 && status < 300 && status !== 204 && status !== 205 && ['text/html', 'application/xhtml+xml'].includes(contentType?.split(';')[0]?.trim().toLowerCase() ?? '');
}
export class TaskBrowserDiscovery {
  private snapshot: { at: number; raw: string } | undefined;
  private pending: Promise<string> | undefined;
  private probes = new Map<string, { expires: number; value: boolean }>();
  private probing = new Map<string, Promise<boolean>>();
  constructor(private readonly listeners = async () => {
    const result = await run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 }).catch(error => { if (error.code === 1 && !error.stdout) return { stdout: '' }; throw error; });
    return result.stdout;
  }, private readonly probe = async (url: string) => {
    try { const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1000), headers: { Accept: 'text/html, application/xhtml+xml' } }); const value = browserWebResponse(response.status, response.headers.get('Content-Type'), response.headers.get('Location')); await response.body?.cancel().catch(() => {}); return value; } catch { return false; }
  }, private readonly owners: () => Promise<ReadonlyMap<number, TaskBrowserTerminalOwner>> = async () => new Map()) {}
  private async scan() {
    if (this.snapshot && Date.now() - this.snapshot.at < 3000) return this.snapshot.raw;
    if (this.pending) return this.pending;
    this.pending = this.listeners().then(raw => { this.snapshot = { at: Date.now(), raw }; return raw; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private web(url: string, key: string): Promise<boolean> {
    const cached = this.probes.get(key); if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    const current = this.probing.get(key); if (current) return current;
    const pending = this.probe(url).then(value => { this.probes.set(key, { value, expires: Date.now() + 15000 }); return value; }).finally(() => { this.probing.delete(key); });
    this.probing.set(key, pending); return pending;
  }
  async list(configuredValue?: unknown) {
    const configured = browserConfiguredURLs(configuredValue), [raw, owners] = await Promise.all([this.scan(), this.owners()]), servers = parseBrowserListeners(raw, owners), byPort = new Map(servers.map(server => [server.port, server]));
    const groups: { server: TaskBrowserServer; urls: string[]; configured: boolean; result?: TaskBrowserServer }[] = configured.map(raw => {
      const url = new URL(raw), port = Number(url.port || (url.protocol === 'http:' ? 80 : 443));
      return { server: byPort.get(port) ?? { host: url.hostname, port, url: raw, pid: null, processName: null, terminal: null }, urls: [raw], configured: true };
    });
    // Match T3: only terminal-owned listeners receive automatic HTTP/TLS probes.
    // Explicit configured URLs may also point to a service started outside Friday.
    for (const server of servers) if (server.terminal) groups.push({ server, urls: [`http://${server.host}:${server.port}`, `https://${server.host}:${server.port}`], configured: false });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, groups.length) }, async () => {
      while (next < groups.length) {
        const group = groups[next++];
        for (const url of group.urls) {
          const resource = new URL(url); resource.hash = '';
          if (await this.web(url, resource.href + '\0' + group.server.pid)) { group.result = { ...group.server, url }; break; }
        }
      }
    }));
    for (const [key, value] of this.probes) if (value.expires < Date.now()) this.probes.delete(key);
    const visible = new Map<number, TaskBrowserServer>(); for (const group of groups) if (group.result && !visible.has(group.result.port)) visible.set(group.result.port, group.result);
    return { servers: [...visible.values()].sort((a, b) => a.port - b.port), scannedAt: new Date().toISOString() };
  }
}
