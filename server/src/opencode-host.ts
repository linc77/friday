// Own the CLI process tree independently of a client window. If Friday exits
// abruptly, its stdin pipe closes and this host terminates the owned group.
// No credentials or session data travel in command-line arguments.
import { spawn } from 'node:child_process';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Missing OpenCode executable');
const child = spawn(command, args, { env: process.env, cwd: process.cwd(), stdio: ['ignore', 'inherit', 'inherit'] });
let closing = false;
const shutdown = () => {
  if (closing) return; closing = true;
  if (process.platform === 'win32') child.kill('SIGTERM');
  else { try { process.kill(-process.pid, 'SIGTERM'); } catch {} }
  const timer = setTimeout(() => { if (process.platform === 'win32') { child.kill('SIGKILL'); process.exit(1); } else { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(1); } } }, 1000); timer.unref();
};
process.stdin.resume(); process.stdin.on('end', shutdown); process.stdin.on('error', shutdown);
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
child.on('error', () => process.exit(1)); child.on('close', code => process.exit(code ?? 0));
