import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { TerminalStore } from '../src/terminal-store.js';
import { terminalDescendants, terminalProcesses } from '../src/terminal-pty.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import type { TerminalEvent, TaskTerminalSummary } from '../src/terminal-types.js';
import type { Executor } from '../src/types.js';

async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Terminal transition timed out');
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-terminal-'))); const root = join(base, 'project'); const data = join(base, 'data'); await mkdir(root);
  const executor: Executor = { async run() { return 'fixture'; }, async answer() {}, async steer() {} };
  const engine = await new Engine(data, executor).open(); const auth = new Auth(data);
  t.after(async () => { auth.close(); await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Terminal fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'fixture', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'fixture' });
  await until(() => engine.snapshot(), value => value.tasks[0].status === 'completed');
  const manager = engine.terminals; const row = (terminal = 'term-1') => manager.store.get(id, terminal)!;
  const open = async (terminalId = 'term-1') => {
    await manager.lifecycle(id, { terminalId, requestId: 'open-' + terminalId, action: 'open', shell: '/bin/sh' });
    await until(() => row(terminalId), value => value.status === 'running' || value.status === 'error');
    assert.equal(row(terminalId).status, 'running', row(terminalId).error); return row(terminalId);
  };
  const write = (command: string, requestId: string, terminalId = 'term-1') => manager.write(id, terminalId, { requestId, generation: row(terminalId).generation, data: Buffer.from(command).toString('base64') });
  const output = (terminalId = 'term-1') => Buffer.from(manager.snapshot(id, terminalId).history, 'base64').toString('utf8');
  const api = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  return { base, root, data, executor, engine, manager, id, row, open, write, output, api, auth, headers };
}

test('A real PTY supports raw VT output, UTF-8, resize, detach/reconnect and idempotent input without tying its lifetime to observers', async t => {
  const { root, manager, id, row, open, write, output } = await fixture(t); const initial = await open();
  const events: TerminalEvent[] = []; const detach = manager.observe(id, 'term-1', undefined, undefined, event => events.push(event));
  assert.equal(events[0].type, 'snapshot');
  await write("stty -echo; printf '\\033[0mFRIDAY_ECHO_DISABLED\\033[0m\\n'\r", 'no-echo');
  await until(output, value => value.includes('\x1b[0mFRIDAY_ECHO_DISABLED\x1b[0m'));
  const command = "test -t 0 && test -t 1 && printf '\\033[31m真实终端\\033[0m\\n'; pwd\r";
  await write(command, 'actual-tty'); await until(output, value => value.includes('\x1b[31m真实终端\x1b[0m') && value.includes(root));
  assert.equal((await write(command, 'actual-tty')).state, 'sent');
  await assert.rejects(write('printf SHOULD_NOT_RUN\r', 'actual-tty'), /已被使用/);
  assert.equal(output().split('真实终端').length - 1, 1);
  await manager.resize(id, 'term-1', initial.generation, 91, 17); await write('stty size\r', 'size'); await until(output, value => value.includes('17 91'));
  const cursor = manager.snapshot(id, 'term-1'); detach(); const count = events.length;
  await write('printf DETACHED_OUTPUT\r', 'detached'); await until(output, value => value.includes('DETACHED_OUTPUT'));
  assert.equal(events.length, count); assert.equal(row().pid, initial.pid);
  const replay: TerminalEvent[] = []; const off = manager.observe(id, 'term-1', cursor.generation, cursor.sequence, event => replay.push(event)); off();
  assert.equal(replay[0].type, 'metadata'); assert.ok(replay.some(event => event.type === 'output' && Buffer.from(event.data, 'base64').includes(Buffer.from('DETACHED_OUTPUT'))));
  await manager.lifecycle(id, { terminalId: 'term-1', requestId: 'same-open', action: 'open' });
  assert.equal(row().pid, initial.pid); await assert.rejects(manager.lifecycle(id, { terminalId: 'another', requestId: 'same-open', action: 'open' }), /已被使用/);
});

test('Busy close and restart require confirmation, force-close stops the shell and its owned children, and generation guards reject stale keyboard input', async t => {
  const { engine, manager, id, row, open, write, output } = await fixture(t); const initial = await open();
  await write('stty -echo; sleep 60\r', 'busy');
  const children = await until(() => terminalProcesses().then(rows => terminalDescendants(rows, initial.pid!)), rows => rows.some(value => value.command.endsWith('sleep')));
  await manager.refreshProcesses(); assert.equal(row().hasRunningSubprocess, true);
  await assert.rejects(manager.lifecycle(id, { terminalId: 'term-1', requestId: 'close-unconfirmed', action: 'close' }), /确认/);
  await assert.rejects(manager.lifecycle(id, { terminalId: 'term-1', requestId: 'restart-unconfirmed', action: 'restart', shell: '/bin/sh' }), /确认/);
  await assert.rejects(new ServiceMaintenance(() => engine.snapshot()).prepare(), /终端|任务|程序/);
  await manager.lifecycle(id, { terminalId: 'term-1', requestId: 'restart-confirmed', action: 'restart', shell: '/bin/sh', force: true });
  await until(row, value => value.status === 'running' && value.generation === 2);
  for (const child of children) assert.ok(!(await terminalProcesses()).some(value => value.pid === child.pid && value.command === child.command), 'old owned process survived restart');
  await assert.rejects(manager.write(id, 'term-1', { requestId: 'stale', generation: 1, data: Buffer.from('printf STALE\r').toString('base64') }), /重新启动/);
  await manager.lifecycle(id, { terminalId: 'term-1', requestId: 'restart-confirmed', action: 'restart', force: true }); assert.equal(row().generation, 2);
  await write('stty -echo; printf SECOND_GENERATION\r', 'second'); await until(output, value => value.includes('SECOND_GENERATION'));
  await manager.clear(id, 'term-1', 2); assert.equal(output(), '');
  await manager.lifecycle(id, { terminalId: 'term-1', requestId: 'close-confirmed', action: 'close', force: true }); await until(row, value => value.status === 'closed'); assert.deepEqual(manager.summaries(id), []);
});

test('Graceful service shutdown preserves history and marks the terminal interrupted; reconnecting never recreates a shell or replays inputs', async t => {
  const { engine, manager, id, row, open, write, output, data, executor } = await fixture(t); await open();
  await write('printf KEEP_HISTORY\r', 'history'); await until(output, value => value.includes('KEEP_HISTORY')); const oldPid = row().pid;
  await engine.close(); const reopened = await new Engine(data, executor).open();
  try {
    const saved = reopened.terminals.snapshot(id, 'term-1'); assert.equal(saved.terminal.status, 'interrupted'); assert.equal(saved.terminal.pid, null); assert.ok(Buffer.from(saved.history, 'base64').includes(Buffer.from('KEEP_HISTORY')));
    await reopened.terminals.lifecycle(id, { terminalId: 'term-1', requestId: 'open-after-reconnect', action: 'open' });
    assert.equal(reopened.terminals.snapshot(id, 'term-1').terminal.status, 'interrupted'); assert.ok(!(await terminalProcesses()).some(value => value.pid === oldPid));
    assert.equal(reopened.terminals.receipt(id, 'term-1', 'history')?.state, 'sent');
  } finally { await reopened.close(); }
});

test('HTTP terminal APIs authenticate, scope output and input receipts to the task, and closing a stream leaves its PTY alive', async t => {
  const { api, headers, manager, id, row, open, auth } = await fixture(t); await open(); const path = `/api/tasks/${id}/terminals/term-1`;
  assert.equal((await api.request(path)).status, 401);
  assert.equal((await api.request('/api/tasks/missing/terminals/term-1', { headers })).status, 404);
  assert.equal((await api.request(path, { headers })).status, 200);
  const stream = await api.request(path + '/events', { headers }); assert.equal(stream.status, 200); const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: terminal/); await reader.cancel(); assert.equal(row().status, 'running');
  const pair = auth.createPairing(); const device = auth.pair(pair.code, 'terminal reader', 'local');
  const remote = await api.request(path + '/events', { headers: { Authorization: 'Bearer ' + device.token } }); const remoteReader = remote.body!.getReader(); await remoteReader.read(); auth.revoke(device.id);
  await until(() => remoteReader.read(), value => value.done);
  assert.equal(row().status, 'running');
  await assert.rejects(manager.write('another-task', 'term-1', { requestId: 'wrong-task', generation: 1, data: Buffer.from('bad\r').toString('base64') }), /未发送/);
});

test('Private output retention keeps raw bytes within both byte and line budgets, and interrupted input receipts never become sent on reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-terminal-store-')); const store = new TerminalStore(); await store.open(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const row: TaskTerminalSummary = { id: 'term', taskId: 'task', generation: 1, cwd: directory, shell: '/bin/sh', label: 'Terminal', title: 'sh', status: 'running', pid: 123, cols: 120, rows: 30, sequence: 0, baseSequence: 1, hasRunningSubprocess: false, createdAt: '', updatedAt: '' }; store.save(row);
  for (let index = 0; index < 540; index++) store.output(row, Buffer.alloc(16 * 1024, 65));
  assert.ok(Buffer.concat(store.history(row).map(value => value.data)).length <= 8 * 1024 * 1024); assert.equal(row.historyTruncated, true);
  store.clear(row); const bytes = Buffer.from('\x1b[32m一行\x1b[0m\r\n'.repeat(6000));
  for (let offset = 0; offset < bytes.length; offset += 16 * 1024) store.output(row, bytes.subarray(offset, offset + 16 * 1024));
  const retained = Buffer.concat(store.history(row).map(value => value.data)); assert.ok(retained.filter(byte => byte === 10).length <= 5000); assert.ok(retained.subarray(-16).equals(bytes.subarray(-16)));
  store.input({ requestId: 'uncertain', taskId: 'task', terminalId: 'term', generation: 1, digest: 'only-a-digest', state: 'started' }); store.close(); await store.open(directory);
  assert.equal(store.get('task', 'term')?.status, 'interrupted'); assert.equal(store.receipt('uncertain')?.state, 'uncertain');
  assert.equal((await stat(join(directory, 'terminals.sqlite'))).mode & 0o777, 0o600);
  store.deleteTask('task'); assert.equal(store.get('task', 'term'), undefined); assert.equal(store.receipt('uncertain')?.state, 'uncertain');
});

test('An output persistence failure stops only the affected PTY and refuses more keyboard input without crashing the resident engine', async t => {
  const { engine, manager, id, row, open, write } = await fixture(t); await open();
  const original = manager.store.output.bind(manager.store); manager.store.output = () => { throw new Error('fixture disk full'); };
  try {
    await write('printf OUTPUT_STORAGE_FAILURE\r', 'trigger-failure');
    await until(row, value => value.status === 'error');
    assert.equal((await engine.snapshot()).tasks[0].terminals?.[0].status, 'error');
    await assert.rejects(write('printf NEVER_SENT\r', 'blocked-input'), /未发送/);
    await until(() => manager.summaries(id)[0], value => value.pid === null);
  } finally { manager.store.output = original; }
});

test('Task deletion terminates a HUP-resistant subprocess and keeps old lifecycle requests as non-replayable tombstones', async t => {
  const { engine, manager, id, open, write } = await fixture(t); const row = await open();
  await write("/bin/sh -c 'trap \"\" HUP TERM; sleep 60'\r", 'resistant-child');
  const owned = await until(() => terminalProcesses().then(rows => terminalDescendants(rows, row.pid!)), rows => rows.filter(value => value.pid !== row.pid).length >= 2);
  await engine.deleteTask(id);
  assert.equal((await engine.snapshot()).tasks.length, 0);
  for (const child of owned) assert.ok(!(await terminalProcesses()).some(value => value.pid === child.pid && value.command === child.command));
  await assert.rejects(manager.lifecycle(id, { terminalId: 'term-1', requestId: 'open-term-1', action: 'open' }), /关闭/);
  await assert.rejects(manager.lifecycle(id, { terminalId: 'term-2', requestId: 'new-after-delete', action: 'open' }), /关闭/);
});
