import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const app = resolve(process.argv[2] ?? 'dist/Friday.app');
const directory = await mkdtemp(join(tmpdir(), 'friday-release-test-'));
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
let child; let token;
let registered = false;
const label = 'dev.friday.release-test.' + process.pid;
const domain = 'gui/' + process.getuid();
const launchctl = args => execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
async function start() {
  child = spawn(join(app, 'Contents/MacOS/FridayService'), [], {
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', FRIDAY_DATA_DIR: directory, FRIDAY_PORT: String(port) }, stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(await readFile(join(directory, 'service-error.log'), 'utf8'));
    try {
      const response = await fetch(base + '/health');
      if (response.ok) {
        const health = await response.json(); assert.equal(health.name, 'Friday'); assert.ok(health.build);
        token = (await readFile(join(directory, 'owner-token'), 'utf8')).trim(); return;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('Bundled service did not become healthy.');
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const process = child;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { process.kill('SIGKILL'); reject(new Error('Service did not stop gracefully')); }, 15000);
    process.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`Service exited ${code}`)); });
    process.kill('SIGTERM');
  });
}
const api = (path, method = 'GET', body) => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
try {
  await start(); const originalToken = token;
  assert.equal((await api('/api/ideas', 'POST', { text: 'Packaged release persistence check' })).status, 201);
  assert.equal((await api('/api/service/update', 'POST', {})).status, 200);
  assert.equal((await api('/api/ideas', 'POST', { text: 'Must not be written' })).status, 503);
  assert.equal((await api('/api/service/update', 'DELETE')).status, 200);
  assert.equal((await api('/api/ideas', 'POST', { text: 'Writes resume after cancelled update' })).status, 201);
  await stop(); await start(); assert.equal(token, originalToken);
  const state = await (await api('/api/state')).json(); assert.equal(state.ideas.length, 2);
  await stop();
  const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const plist = join(directory, 'test-agent.plist');
  await writeFile(plist, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(join(app, 'Contents/MacOS/FridayService'))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>EnvironmentVariables</key><dict><key>FRIDAY_DATA_DIR</key><string>${xml(directory)}</string><key>FRIDAY_PORT</key><string>${port}</string></dict></dict></plist>`);
  launchctl(['bootstrap', domain, plist]); registered = true;
  let healthy = false;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(base + '/health'); if (response.ok) { healthy = true; break; } } catch {}
    await delay(100);
  }
  assert.equal(healthy, true, 'LaunchAgent must start the packaged service');
  assert.equal((await (await api('/api/state')).json()).ideas.length, 2);
  launchctl(['bootout', domain + '/' + label]); registered = false;
  console.log('Bundled Node/service starts without a development environment; write barrier, graceful shutdown, credentials, SQLite persistence and LaunchAgent lifecycle passed.');
} finally {
  if (registered) { try { launchctl(['bootout', domain + '/' + label]); } catch {} }
  await stop(); await rm(directory, { recursive: true, force: true });
}
