import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// cloudflared owns transport/reconnect; launchd owns process lifetime. Friday
// keeps its existing HTTP/SSE protocol and device authorization.
const label = 'dev.friday.remote';
const launch = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);

export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入固定的 HTTPS 主机地址，例如 https://friday.example.com'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !url.hostname.includes('.') || url.hostname.endsWith('.trycloudflare.com')) {
    throw new Error('需要不含路径、凭据或参数的固定 HTTPS 地址；临时 Quick Tunnel 不支持 SSE。');
  }
  return url.origin;
}

function paths(home, data) {
  const directory = join(data, 'remote');
  return { directory, plist: join(home, 'Library/LaunchAgents', label + '.plist'),
    token: join(directory, 'tunnel-token'), config: join(directory, 'cloudflared.yml'),
    settings: join(directory, 'endpoint.json'), log: join(directory, 'tunnel.log') };
}

export function agentDefinition(binary, files) {
  const args = [binary, 'tunnel', '--config', files.config, '--no-autoupdate', '--loglevel', 'warn', 'run', '--token-file', files.token];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(files.log)}</string>
<key>StandardErrorPath</key><string>${xml(files.log)}</string>
</dict></plist>\n`;
}

async function privateFile(path, contents) {
  const temporary = path + '.new';
  await writeFile(temporary, contents, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export async function install({ home, data, url, tokenFile, binary, run = launch, uid = process.getuid() }) {
  const origin = publicOrigin(url);
  if (!tokenFile) throw new Error('请提供保存隧道 token 的本机文件路径，不要把 token 放在命令参数中。');
  if (!isAbsolute(binary)) throw new Error('cloudflared 路径必须是绝对路径。');
  await access(binary, constants.X_OK);
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (token.length < 32 || token.length > 16_384 || /\s/.test(token)) throw new Error('隧道 token 文件格式无效。');
  const files = paths(home, data);
  // Validate everything before stopping an existing connector.
  const definition = agentDefinition(binary, files);
  await mkdir(files.directory, { recursive: true, mode: 0o700 });
  await chmod(files.directory, 0o700);
  await mkdir(dirname(files.plist), { recursive: true });
  const domain = `gui/${uid}`;
  const loaded = run('print', `${domain}/${label}`);
  if (loaded.status === 0) {
    const stopped = run('bootout', `${domain}/${label}`);
    if (stopped.status !== 0) throw new Error('无法停止已有 Friday 远程入口，配置未更改。');
  }
  await privateFile(files.token, token + '\n');
  // Ignore unrelated ~/.cloudflared config. Routes belong to this named tunnel
  // in the Cloudflare dashboard, with only the Friday loopback origin exposed.
  await privateFile(files.config, '{}\n');
  await privateFile(files.settings, JSON.stringify({ url: origin }, null, 2) + '\n');
  await writeFile(files.log, '', { flag: 'a', mode: 0o600 });
  await chmod(files.log, 0o600);
  await privateFile(files.plist, definition);
  const result = run('bootstrap', domain, files.plist);
  if (result.status !== 0) throw new Error('远程入口配置已保存，但 launchd 启动失败。请检查 LaunchAgent 后重新安装。');
  return origin;
}

export async function stop({ home, data, run = launch, uid = process.getuid() }) {
  const files = paths(home, data);
  const service = `gui/${uid}/${label}`;
  const loaded = run('print', service);
  if (loaded.status === 0 && run('bootout', service).status !== 0) throw new Error('无法停止 Friday 远程入口，未删除启动配置。');
  await rm(files.plist, { force: true });
  // Retain the private token for a deliberate reinstall; do not touch other tunnels.
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('此入口使用 macOS launchd；其他平台请按 Cloudflare 官方说明管理 cloudflared。');
  process.umask(0o077);
  const home = homedir();
  const data = resolve(process.env.FRIDAY_DATA_DIR ?? join(home, 'Library/Application Support/Friday'));
  const [action = 'status', url, tokenFile, ...extra] = process.argv.slice(2);
  if (extra.length || !['install', 'stop', 'status'].includes(action) || (action !== 'install' && url)) {
    throw new Error('Usage: pnpm remote:install <https://host> <token-file> | pnpm remote:status | pnpm remote:stop');
  }
  if (action === 'install') {
    let binary = process.env.FRIDAY_CLOUDFLARED;
    if (!binary) {
      for (const candidate of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) {
        try { await access(candidate, constants.X_OK); binary = candidate; break; } catch {}
      }
    }
    if (!binary) throw new Error('请先安装 cloudflared：brew install cloudflared');
    const origin = await install({ home, data, url, tokenFile, binary });
    console.log(`Friday 远程入口进程已注册：${origin}\n这还不代表远程连接可用。请验证 /health、设备配对、消息提交和 SSE 回复。`);
  } else if (action === 'stop') {
    await stop({ home, data });
    console.log('Friday 远程入口已停止；主机服务、数据与私有隧道凭据保留。');
  } else {
    const files = paths(home, data);
    let settings;
    try { settings = JSON.parse(await readFile(files.settings, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    console.log(settings ? `主机地址：${settings.url}` : '尚未配置 Friday 远程入口。');
    const result = launch('print', `gui/${process.getuid()}/${label}`);
    console.log(result.status === 0 ? 'launchd 已加载连接器；请另行验证外部连接。' : '连接器未加载。');
    console.log(`连接器日志：${files.log}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
