import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm, access, cp } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') throw new Error('Use pnpm start or your host service manager outside macOS.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const label = 'dev.friday.server';
const domain = `gui/${process.getuid()}`;
const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist');
const action = process.argv[2] ?? 'status';
const call = (...args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
if (action === 'install') {
  const data = process.env.FRIDAY_DATA_DIR ?? join(homedir(), 'Library/Application Support/Friday');
  await mkdir(dirname(plist), { recursive: true });
  await mkdir(data, { recursive: true, mode: 0o700 });
  // Run the installed service from Application Support, outside macOS's protected Documents folder.
  // It must not need Documents permission just to boot or serve the personal inbox.
  const runtime = join(data, 'runtime');
  call('bootout', `${domain}/${label}`);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  for (const part of ['server/src', 'skills', 'node_modules', 'package.json']) {
    await cp(join(root, part), join(runtime, part), { recursive: true, force: true, verbatimSymlinks: true });
  }
  let node = process.execPath;
  try { await access('/opt/homebrew/bin/node'); node = '/opt/homebrew/bin/node'; } catch {}
  const config = {
    Label: label,
    ProgramArguments: [node, '--import', join(runtime, 'node_modules/tsx/dist/loader.mjs'), join(runtime, 'server/src/main.ts')],
    WorkingDirectory: runtime, RunAtLoad: true, KeepAlive: true, ThrottleInterval: 10,
    EnvironmentVariables: {
      PATH: `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
      FRIDAY_DATA_DIR: data, FRIDAY_HOST: '127.0.0.1', FRIDAY_PORT: process.env.FRIDAY_PORT ?? '4317',
      ...(process.env.FRIDAY_MODEL_ID ? { FRIDAY_MODEL_ID: process.env.FRIDAY_MODEL_ID } : {}),
      ...Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])),
    },
    StandardOutPath: join(data, 'service.log'), StandardErrorPath: join(data, 'service-error.log'),
  };
  const temporary = plist + '.json';
  await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
  const conversion = spawnSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', plist, temporary], { encoding: 'utf8' });
  await rm(temporary);
  if (conversion.status !== 0) throw new Error(conversion.stderr || conversion.stdout);
  call('bootout', `${domain}/${label}`);
  const result = call('bootstrap', domain, plist);
  if (result.status !== 0) throw new Error(result.stderr);
  console.log(`Friday service installed. Data: ${data}`);
} else if (action === 'uninstall') {
  call('bootout', `${domain}/${label}`);
  await rm(plist, { force: true });
  console.log('Friday service removed; all data has been preserved.');
} else if (action === 'restart') {
  const result = call('kickstart', '-k', `${domain}/${label}`);
  if (result.status !== 0) throw new Error(result.stderr);
  console.log('Friday service restarted.');
} else if (action === 'status') {
  const result = call('print', `${domain}/${label}`);
  console.log(result.stdout || result.stderr); process.exitCode = result.status ?? 1;
} else throw new Error('Usage: node scripts/service.mjs install|uninstall|restart|status');
