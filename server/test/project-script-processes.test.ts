import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectScriptProcesses } from '../src/project-script-processes.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defineTask } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-script-process-')), processes = new ProjectScriptProcesses();
  await processes.open(directory);
  t.after(async () => { await processes.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, processes };
}
test('Script logs bound output, preserve split UTF-8, persist after restart and refuse a duplicate launch', async t => {
  const { directory, processes } = await fixture(t), path = join(directory, 'output.cjs');
  await writeFile(path, "process.stdout.write('x'.repeat(300000)); const b=Buffer.from('你好🚀'); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),30);");
  await processes.start('one', quote(process.execPath) + ' ' + quote(path), directory, process.env);
  assert.equal(await processes.wait('one', new AbortController().signal), 0);
  const output = processes.output('one')!; assert(output.text.endsWith('你好🚀')); assert(!output.text.includes('\ufffd')); assert(Buffer.byteLength(output.text) <= 256 * 1024);
  assert.equal(output.completed, 1); assert.equal((await stat(join(directory, 'project-script-output.sqlite'))).mode & 0o777, 0o600);
  assert.throws(() => processes.start('one', 'touch duplicate', directory, process.env), /重复/);
  await processes.close(); const reopened = new ProjectScriptProcesses(); await reopened.open(directory);
  try { assert.equal(reopened.output('one')?.text, output.text); } finally { await reopened.close(); }
});
test('Stopping and service shutdown kill owned script children without replaying them', async t => {
  const { directory, processes } = await fixture(t);
  for (const id of ['cancel', 'shutdown']) {
    const marker = join(directory, id), path = join(directory, id + '.cjs');
    await writeFile(path, `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`);
    await processes.start(id, quote(process.execPath) + ' ' + quote(path), directory, process.env);
    let pid = 0;
    for (let i = 0; i < 100 && !pid; i++) { pid = Number(await readFile(marker, 'utf8').catch(() => '')); if (!pid) await new Promise(r => setTimeout(r, 20)); }
    assert(pid > 1);
    if (id === 'cancel') await processes.stop(id); else await processes.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/); assert.equal(processes.isLive(id), false);
  }
});
test('Removed terminal endpoints are absent and unfinished legacy terminal operations are retired on reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-terminal-removal-'));
  let engine = await new Engine(directory, { run: async () => 'unused', answer: async () => {}, steer: async () => {} }).open();
  const auth = new Auth(directory);
  t.after(async () => { auth.close(); await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const api = createAPI(engine, auth), headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  for (const [path, method] of [['/api/tasks/old/terminals', 'GET'], ['/api/tasks/old/terminals', 'POST'], ['/api/tasks/old/terminals/term/events', 'GET']]) {
    assert.equal((await api.request(path, { method, headers, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 404);
  }
  const old = defineTask({ name: 'friday.terminal', version: 1, initial: () => ({ phase: 'run' as const }), phases: { run: async () => { throw new Error('A retired shell must never start'); } }, abort: async () => { throw new Error('The old handler must not run'); } });
  const id = await engine.root.commit(tx => tx.createTask(old, {}, { ownership: { kind: 'conversation' } }), context);
  await engine.close(); engine = await new Engine(directory, { run: async () => 'unused', answer: async () => {}, steer: async () => {} }).open();
  await engine.harness.waitForTask(id, context);
  assert.equal((await engine.harness.getTask(id, context))?.state.status, 'terminal');
  await assert.rejects(stat(join(directory, 'terminals.sqlite')), /ENOENT/);
});
