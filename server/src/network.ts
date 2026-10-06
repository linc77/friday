import { execFileSync } from 'node:child_process';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

const proxyKeys = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];
export function proxySettings(env: NodeJS.ProcessEnv, system = '') {
  const explicit = proxyKeys.some(key => env[key] !== undefined);
  const value = (name: string) => system.match(new RegExp(`^\\s{2}${name} : (.+)$`, 'm'))?.[1]?.trim();
  const systemProxy = (prefix: string) => {
    if (value(`${prefix}Enable`) !== '1') return '';
    const host = value(`${prefix}Proxy`); const port = Number(value(`${prefix}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return '';
    return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  };
  const all = env.all_proxy ?? env.ALL_PROXY ?? '';
  const httpProxy = explicit ? env.http_proxy ?? env.HTTP_PROXY ?? all : systemProxy('HTTP');
  const httpsProxy = explicit ? env.https_proxy ?? env.HTTPS_PROXY ?? (all || httpProxy) : systemProxy('HTTPS');
  for (const address of [httpProxy, httpsProxy]) if (address) {
    let url: URL;
    try { url = new URL(address); } catch { throw new Error('代理地址无效，请检查 HTTP_PROXY / HTTPS_PROXY。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Friday 需要 HTTP 或 HTTPS 代理地址。');
  }
  const exceptions = system.match(/^\s{2}ExceptionsList : <array> \{([\s\S]*?)^\s{2}\}/m)?.[1] ?? '';
  const systemBypass = [...exceptions.matchAll(/^\s+\d+ : ([^\s]+)$/gm)].map(match => match[1]).filter(host => !host.includes('/') && !host.includes('<'));
  const requestedBypass = env.no_proxy ?? env.NO_PROXY ?? (explicit ? '' : systemBypass.join(','));
  const noProxy = requestedBypass.split(/[,\s]+/).includes('*') ? '*' : ['localhost', '127.0.0.1', '[::1]', requestedBypass].filter(Boolean).join(',');
  return { httpProxy, httpsProxy, noProxy, source: httpProxy || httpsProxy ? explicit ? 'environment' : 'system' : 'direct' } as const;
}

// Configure the process once, before OAuth or model requests. Node's fetch does not use macOS proxies by default.
export function configureNetwork(env = process.env, platform = process.platform) {
  let system = '';
  if (platform === 'darwin' && !proxyKeys.some(key => env[key] !== undefined)) {
    try { system = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000 }); } catch { /* No system proxy available. */ }
  }
  return installProxy(proxySettings(env, system));
}

export function installProxy(settings: ReturnType<typeof proxySettings>) {
  const previous = getGlobalDispatcher();
  const dispatcher = new EnvHttpProxyAgent(settings);
  setGlobalDispatcher(dispatcher);
  return { source: settings.source, close: async () => { setGlobalDispatcher(previous); await dispatcher.close(); } };
}
