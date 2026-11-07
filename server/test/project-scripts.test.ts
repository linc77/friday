import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { TerminalStore } from '../src/terminal-store.js';
import type { TaskTerminalSummary } from '../src/terminal-types.js';
import { importableProjectScripts, projectScripts, projectScriptSettings, resolveProjectScripts, updateProjectScriptSettings } from '../src/project-script-settings.js';
import { parseScriptShortcut } from '../src/project-script-shortcuts.js';
import { projectScriptProgress } from '../src/project-script-progress.js';
import type { ProjectScript } from '../src/project-script-types.js';
import type { ExecutionRequest, Executor } from '../src/types.js';

// These synthetic commands use POSIX syntax. Do not inherit the account's
// default shell (which may be Fish) in this isolated test worker.
process.env.SHELL = '/bin/sh';

const script = (extra: Partial<ProjectScript> = {}): ProjectScript => ({ id: 'test', name: 'Test', command: 'printf SCRIPT_OUTPUT', icon: 'test', runOnWorktreeCreate: false, ...extra });
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
async function until<T>(read: () => T | Promise<T>, predicate: (v: T) => boolean) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { const v = await read(); if (predicate(v)) return v; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('Project script transition timed out');
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }, scripts: ProjectScript[] = []) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-project-script-'))), repo = join(base, 'repo'), data = join(base, 'data'); await mkdir(repo);
  git(repo, 'init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture\n'); git(repo, 'add', '.'); git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  const calls: ExecutionRequest[] = [];
  const executor: Executor = { async run(r) { calls.push(r); return 'fixture'; }, async answer() {}, async steer() {} };
  const f = { base, repo, data, calls, executor, engine: await new Engine(data, executor).open() };
  t.after(async () => { await f.engine.close(); await rm(base, { recursive: true, force: true }); });
  await f.engine.mutate(s => s.projects.push({ id: 'p', name: 'Project', path: repo, context: '', scripts }));
  const task = async (worktree = false) => {
    const id = await f.engine.createTask({ prompt: 'fixture', projectId: 'p', agent: 'codex', mode: 'code', requestId: 'task-' + Math.random().toString(36).slice(2), ...(worktree ? { workspace: { mode: 'worktree' as const } } : {}) }); return id;
  };
  const run = (id: string) => f.engine.projectScripts.get(id);
  const done = (id: string) => until(() => run(id), r => !['queued','running'].includes(r.status));
  const output = async (id: string) => { const r = await run(id); return Buffer.from(f.engine.terminals.snapshot(r.terminalOwner, r.terminalId).history, 'base64').toString('utf8'); };
  return Object.assign(f, { task, run, done, output });
}

test('Script defaults, explicit empty overrides, inheritance and optimistic idempotent updates match T3', async t => {
  const f = await fixture(t, [script({ id: 'legacy' })]);
  let settings = await updateProjectScriptSettings(f.engine, { projectId: null, version: 0, requestId: 'defaults', scripts: [script()] }); assert.equal(settings.version, 1);
  const state = await f.engine.snapshot(), project = state.projects[0]; assert.equal(resolveProjectScripts(state, project).scripts[0].id, 'legacy');
  settings = await updateProjectScriptSettings(f.engine, { projectId: 'p', version: 1, requestId: 'inherit', scripts: null }); assert.equal(settings.source, 'default'); assert.equal(settings.scripts[0].id, 'test');
  await updateProjectScriptSettings(f.engine, { projectId: null, version: 0, requestId: 'defaults', scripts: [Object.fromEntries(Object.entries(script()).reverse())] });
  await updateProjectScriptSettings(f.engine, { projectId: 'p', version: 2, requestId: 'disable', scripts: [] }); assert.deepEqual(resolveProjectScripts(await f.engine.snapshot(), project).scripts, []);
  await updateProjectScriptSettings(f.engine, { projectId: 'p', version: 2, requestId: 'disable', scripts: [] });
  await assert.rejects(updateProjectScriptSettings(f.engine, { projectId: 'p', version: 3, requestId: 'disable', scripts: null }), /不同内容/);
  await assert.rejects(updateProjectScriptSettings(f.engine, { projectId: null, version: 1, requestId: 'stale', scripts: [] }), /其他设备/);
  assert.throws(() => projectScripts([script({ previewUrl: 'file:///private' })]), /预览地址/); assert.throws(() => projectScripts([script(), script()]), /重复/);
  assert.equal(projectScripts([script({ runOnWorktreeCreate: true }), script({ id: 'second', runOnWorktreeCreate: true })]).length, 2);
});

test('Script keybindings sync with settings, normalize T3 aliases and plus keys, reject scope/conflicts atomically, and retain old clients', async t => {
  const f = await fixture(t), scripts = [script(), script({ id: 'build' })];
  const request = { projectId: null, version: 0, requestId: 'keys', scripts, keybindings: { test: 'CMD+Shift+K', build: 'mod++' } };
  const saved = await updateProjectScriptSettings(f.engine, request); assert.deepEqual(saved.keybindings, { test: 'meta+shift+k', build: 'mod++' });
  assert.deepEqual((await projectScriptSettings(f.engine, 'p')).keybindings, saved.keybindings);
  await updateProjectScriptSettings(f.engine, { ...request, keybindings: { build: 'mod++', test: 'meta+shift+k' } });
  await assert.rejects(updateProjectScriptSettings(f.engine, { ...request, version: 1, requestId: 'collision', keybindings: { build: 'mod+shift+k' } }), /重复/);
  assert.equal((await projectScriptSettings(f.engine)).version, 1); assert.equal((await projectScriptSettings(f.engine)).keybindings.build, 'mod++');
  await assert.rejects(updateProjectScriptSettings(f.engine, { ...request, version: 1, requestId: 'foreign', keybindings: { foreign: 'mod+k' } }), /设置范围/);
  await updateProjectScriptSettings(f.engine, { projectId: null, version: 1, requestId: 'legacy', scripts }); assert.deepEqual((await projectScriptSettings(f.engine)).keybindings, saved.keybindings);
  const pruned = await updateProjectScriptSettings(f.engine, { projectId: null, version: 2, requestId: 'delete-key', scripts: [script()], keybindings: { build: null } }); assert.deepEqual(pruned.keybindings, { test: 'meta+shift+k' });
  assert.equal(parseScriptShortcut('mod+ctrl+option+esc')?.key, 'escape'); assert.equal(parseScriptShortcut('mod+k+j'), null); assert.equal(parseScriptShortcut('mod+space')?.key, ' ');
});

test('Script progress strips terminal controls, bounds lines, and stays in authenticated projections rather than durable root state', async t => {
  assert.equal(projectScriptProgress('\x1b]0;title\x07\x1b[31mReady\x1b[0m\r\n__FRIDAY_SCRIPT_DONE_abcd:0\n'), 'Ready');
  assert(projectScriptProgress(('long'.repeat(1000) + '\n').repeat(20)).length <= 4096);
  assert.equal(projectScriptProgress('begin' + 'x'.repeat(600) + 'end').length, 400); assert(projectScriptProgress('begin' + 'x'.repeat(600) + 'end').startsWith('begin'));
  const f = await fixture(t, [script({ command: "printf 'LINE_%s\\n' \"$((23*47))\"" })]), task = await f.task(); await until(() => f.engine.snapshot(), s => s.tasks[0].status === 'completed');
  const id = await f.engine.projectScripts.startTask(task, 'test', 'progress'); await f.done(id); const auth = new Auth(f.data); t.after(async () => auth.close()); const api = createAPI(f.engine, auth, () => []), headers = { Authorization: 'Bearer ' + auth.token };
  assert.equal((await api.request('/api/project-scripts/runs/' + id)).status, 401);
  const receipt = await(await api.request('/api/project-scripts/runs/' + id, { headers })).json(); assert.match(receipt.run.progress, /LINE_1081/);
  const projected = await(await api.request('/api/tasks/' + task + '/scripts', { headers })).json(); assert.match(projected.runs[0].progress, /LINE_1081/);
  assert.equal((await f.engine.snapshot()).projectScriptRuns?.[0] && Object.hasOwn((await f.engine.snapshot()).projectScriptRuns![0], 'progress'), false);
  await f.engine.mutate(s => { delete s.projectScriptRuns![0].generation; });
  const pending = await(await api.request('/api/project-scripts/runs/' + id, { headers })).json(); assert.equal(pending.run.progress, undefined, 'A terminal without its captured generation cannot project output');
});

test('Bounded terminal tails release their read cursor, retain byte order and cannot mix restarted generations', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-script-tail-'))), store = new TerminalStore(); await store.open(directory);
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  const row: TaskTerminalSummary = { taskId: 'script-owner', id: 'script', generation: 1, cwd: directory, shell: '/bin/sh', label: 'script', title: 'sh', status: 'closed', pid: null, cols: 80, rows: 24, sequence: 0, baseSequence: 1, hasRunningSubprocess: false, createdAt: '', updatedAt: '' }; store.save(row);
  const chunks = Array.from({ length: 24 }, (_, i) => Buffer.alloc(1024, 65 + i)); for (const bytes of chunks) store.output(row, bytes);
  assert.deepEqual(store.historyTail(row), Buffer.concat(chunks).subarray(-8192));
  store.output(row, Buffer.from('still-writable')); assert.match(store.historyTail(row).toString('utf8'), /still-writable$/);
  const restarted = { ...row, generation: 2, sequence: 0 }; store.save(restarted); store.output(restarted, Buffer.from('second generation'));
  assert.equal(store.historyTail(restarted).toString('utf8'), 'second generation'); assert(!store.historyTail(row).toString('utf8').includes('second generation'));
  store.deleteTask(row.taskId); assert.equal(store.historyTail(row).length, 0);
});

test('Manual scripts use a real interactive terminal, preserve multiline heredocs, export roots and deduplicate after config changes', async t => {
  const command = "cat <<'END' > result\nheredoc value\nEND\nprintf '%s|%s|%s' \"$T3CODE_PROJECT_ROOT\" \"$NO_COLOR\" \"$FORCE_COLOR\"\n# trailing comment";
  const f = await fixture(t, [script({ command })]), taskId = await f.task(); await until(() => f.engine.snapshot(), s => s.tasks[0].status === 'completed');
  const id = await f.engine.projectScripts.startTask(taskId, 'test', 'manual'), run = await f.done(id); assert.equal(run.status, 'completed', run.error); assert.equal(run.exitCode, 0);
  assert.equal(await readFile(join(f.repo, 'result'), 'utf8'), 'heredoc value\n'); assert.match(await f.output(id), new RegExp(f.repo + '\\|1\\|0'));
  assert(!JSON.stringify(await f.engine.snapshot()).includes('heredoc value\r\n'), 'PTY output stays in private terminal storage');
  await f.engine.mutate(s => { s.projects[0].scripts = []; }); assert.equal(await f.engine.projectScripts.startTask(taskId, 'test', 'manual'), id);
  assert.equal((await f.engine.snapshot()).projectScriptRuns?.length, 1);
});

test('Interactive stdin waits for user input rather than consuming the completion wrapper; errors retain output and cancel stops only the script', async t => {
  const f = await fixture(t, [script({ command: "printf 'WAIT_INPUT\\n'; read answer; printf 'ANSWER=%s\\n' \"$answer\"; exit 7" })]), taskId = await f.task(); await until(() => f.engine.snapshot(), s => s.tasks[0].status === 'completed');
  const id = await f.engine.projectScripts.startTask(taskId, 'test', 'interactive'); await until(() => f.output(id).catch(() => ''), text => text.includes('WAIT_INPUT\r\n'));
  let run = await f.run(id); assert.equal(run.status, 'running'); await f.engine.terminals.write(run.terminalOwner, run.terminalId, { requestId: 'answer', generation: run.generation!, data: Buffer.from('typed value\r').toString('base64') });
  run = await f.done(id); assert.equal(run.status, 'failed'); assert.equal(run.exitCode, 7); assert.match(await f.output(id), /ANSWER=typed value/); assert.equal(f.engine.terminals.store.get(run.terminalOwner, run.terminalId)?.status, 'running');
  await f.engine.mutate(s => { s.projects[0].scripts = [script({ command: 'sleep 60' })]; }); const long = await f.engine.projectScripts.startTask(taskId, 'test', 'long'); await until(() => f.run(long), r => r.status === 'running');
  await f.engine.projectScripts.cancel(long); assert.equal((await f.run(long)).status, 'cancelled'); assert.equal((await f.engine.snapshot()).tasks[0].status, 'completed');
});

test('A synchronous setup runs once before the Agent in the Worktree; default async permits the Agent after sending input', async t => {
  const f = await fixture(t, [script({ command: 'printf ready > setup-marker', runOnWorktreeCreate: true, async: false }), script({ id: 'ignored', command: 'printf BAD > second', runOnWorktreeCreate: true })]);
  const id = await f.task(true); const state = await until(() => f.engine.snapshot(), s => s.tasks.find(v => v.id === id)?.status === 'completed'); const task = state.tasks.find(v => v.id === id)!;
  assert.equal(await readFile(join(task.cwd, 'setup-marker'), 'utf8'), 'ready'); assert.equal(state.projectScriptRuns?.length, 1); assert.equal(state.projectScriptRuns?.[0].trigger, 'setup'); assert.equal(f.calls[0].task.cwd, task.cwd);
  await assert.rejects(readFile(join(f.repo, 'setup-marker')), /ENOENT/); await assert.rejects(readFile(join(task.cwd, 'second')), /ENOENT/);
  await f.engine.mutate(s => { s.projects[0].scripts = [script({ command: "printf 'SETUP_WAIT\\n'; read answer", runOnWorktreeCreate: true })]; });
  const asyncId = await f.task(true); const second = await until(() => f.engine.snapshot(), s => s.tasks.find(v => v.id === asyncId)?.status === 'completed'); const run = second.projectScriptRuns!.find(r => r.taskId === asyncId)!;
  assert.equal(run.status, 'running'); await f.engine.projectScripts.cancel(run.id); assert.equal((await f.engine.snapshot()).tasks.find(v => v.id === asyncId)?.status, 'completed');
});

test('Stopping synchronous setup never starts the Agent; a failed setup requires an explicit retry with a new attempt', async t => {
  const f = await fixture(t, [script({ command: 'read answer', runOnWorktreeCreate: true, async: false })]); const id = await f.task(true);
  await until(() => f.engine.snapshot(), s => s.projectScriptRuns?.[0]?.status === 'running'); await f.engine.cancel(id); assert.equal((await f.engine.snapshot()).projectScriptRuns?.[0].status, 'cancelled'); assert.equal(f.calls.length, 0);
  await f.engine.mutate(s => { s.projects[0].scripts = [script({ command: 'exit 3', runOnWorktreeCreate: true, async: false })]; }); const failed = await f.task(true);
  const broken = await until(() => f.engine.snapshot(), s => s.tasks.find(v => v.id === failed)?.status === 'failed');
  const task = broken.tasks.find(v => v.id === failed)!, parent = task.runs!.find(r => r.id === task.currentRunId)!;
  assert.equal(f.calls.length, 0); assert.equal(broken.projectScriptRuns?.at(-1)?.status, 'failed');
  assert.equal(parent.workspacePreparation?.status, 'failed'); assert(parent.workspacePreparation?.checkoutCompletedAt); assert.equal(parent.before, undefined);
  const auth = new Auth(f.data); t.after(async () => auth.close()); const api = createAPI(f.engine, auth), path = '/api/tasks/' + failed + '/scripts';
  assert.equal((await api.request(path)).status, 401);
  const details = await(await api.request(path, { headers: { Authorization: 'Bearer ' + auth.token } })).json();
  assert.equal(details.worktreeSetup.phase, 'failed');
  assert.deepEqual(details.worktreeSetup.stages.map((stage: { id: string; status: string }) => [stage.id, stage.status]), [
    ['fetch', 'skipped'], ['checkout', 'done'], ['submodules', 'skipped'], ['setup-script', 'failed'], ['agent', 'pending'],
  ]);
  await writeFile(join(task.cwd, 'keep-after-failure'), 'preserved');
  await f.engine.mutate(s => { s.projects[0].scripts = [script({ command: 'printf repaired > setup-marker', runOnWorktreeCreate: true, async: false })]; });
  await Promise.all([f.engine.taskPreparations.retry(failed, parent.id, 'explicit-retry'), f.engine.taskPreparations.retry(failed, parent.id, 'explicit-retry')]);
  const repaired = await until(() => f.engine.snapshot(), s => s.tasks.find(v => v.id === failed)?.status === 'completed');
  const resumed = repaired.tasks.find(v => v.id === failed)!;
  assert.equal(f.calls.length, 1); assert.equal(resumed.cwd, task.cwd); assert.equal(resumed.runs?.find(r => r.id === parent.id)?.workspacePreparation?.attempt, 2);
  assert.equal(repaired.projectScriptRuns?.filter(r => r.taskId === failed).length, 2);
  assert.equal(await readFile(join(task.cwd, 'keep-after-failure'), 'utf8'), 'preserved'); assert.equal(await readFile(join(task.cwd, 'setup-marker'), 'utf8'), 'repaired');
});

test('Settle executes once per transition in a Worktree and skips current-directory tasks', async t => {
  const f = await fixture(t, [script({ command: 'printf x >> settle-marker', runOnSettle: true })]); const id = await f.task(true), current = await f.task();
  await until(() => f.engine.snapshot(), s => s.tasks.every(v => v.status === 'completed'));
  await f.engine.mutate(s => { for (const task of s.tasks) task.settledAt = '2026-10-20T01:00:00.000Z'; }); let runs = (await f.engine.snapshot()).projectScriptRuns!; assert.equal(runs.length, 1); assert.equal(runs[0].taskId, id); await f.done(runs[0].id);
  await f.engine.mutate(() => {}); assert.equal((await f.engine.snapshot()).projectScriptRuns?.length, 1);
  await f.engine.mutate(s => { s.tasks.find(v => v.id === id)!.settledAt = null; });
  await f.engine.mutate(s => { s.tasks.find(v => v.id === id)!.settledAt = '2026-10-20T02:00:00.000Z'; }); runs = (await f.engine.snapshot()).projectScriptRuns!; assert.equal(runs.length, 2); await f.done(runs[1].id);
  const state = await f.engine.snapshot(); assert.equal(await readFile(join(state.tasks.find(v => v.id === id)!.cwd, 'settle-marker'), 'utf8'), 'xx'); assert(!runs.some(r => r.taskId === current));
});

test('A manual Settle detaches the idle provider before admitting its Worktree script and never stops the newly admitted script', async t => {
  const f = await fixture(t, [script({ command: 'printf ordered > settle-order', runOnSettle: true })]), id = await f.task(true);
  await until(() => f.engine.snapshot(), state => state.tasks[0].status === 'completed');
  await f.engine.mutate(state => { state.tasks[0].executionSessionId = 'owned'; });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), detached = new Promise<void>(resolve => { entered = resolve; });
  f.executor.stopNativeSession = async () => { entered(); await gate; };
  const ending = f.engine.updateTaskMetadata(id, { settled: true, requestId: 'settle-script-order' });
  try { await detached; assert.equal((await f.engine.snapshot()).projectScriptRuns?.length ?? 0, 0); }
  finally { release(); }
  await ending;
  const state = await until(() => f.engine.snapshot(), state => (state.projectScriptRuns?.length ?? 0) === 1), run = await f.done(state.projectScriptRuns![0].id);
  assert.equal(run.status, 'completed'); assert.equal(await readFile(join(state.tasks[0].cwd, 'settle-order'), 'utf8'), 'ordered');
  assert.equal((await f.engine.snapshot()).projectScriptRuns?.length, 1);
});

test('Restart never resends an uncertain script; HTTP authentication and maintenance cover prep-only scripts without fake Agent tasks', async t => {
  const f = await fixture(t, [script({ command: 'printf x >> once; read answer' })]), id = await f.task(); await until(() => f.engine.snapshot(), s => s.tasks[0].status === 'completed');
  const runId = await f.engine.projectScripts.startTask(id, 'test', 'once'); await until(() => f.output(runId).catch(() => ''), text => text.includes('read answer'));
  await until(() => readFile(join(f.repo, 'once'), 'utf8').catch(() => ''), text => text === 'x'); await f.engine.close(); f.engine = await new Engine(f.data, f.executor).open();
  const run = await f.done(runId); assert.equal(run.status, 'interrupted'); assert.equal(await readFile(join(f.repo, 'once'), 'utf8'), 'x'); assert.equal(await f.engine.projectScripts.startTask(id, 'test', 'once'), runId);
  const auth = new Auth(f.data); t.after(async () => auth.close()); const api = createAPI(f.engine, auth, () => []), path = '/api/project-scripts/runs/' + runId;
  assert.equal((await api.request(path)).status, 401); assert.equal((await api.request(path, { headers: { Authorization: 'Bearer ' + auth.token } })).status, 200);
  const state = await f.engine.snapshot(); state.projectScriptTerminalsBusy = true; const maintenance = new ServiceMaintenance(async () => state); await assert.rejects(maintenance.prepare(), /项目脚本/); assert.equal(maintenance.preparing, false);
});

test('t3.json import reads bounded ordinary files as data, supplies defaults, and never installs or executes discovered commands', async t => {
  const f = await fixture(t); const file = join(f.repo, 't3.json');
  await writeFile(file, JSON.stringify({ scripts: [{ name: 'Untrusted data', command: 'touch must-not-execute' }] }));
  const value = await importableProjectScripts(f.engine, 'p'); assert.equal(value.scripts[0].icon, 'play'); assert.equal(value.scripts[0].runOnWorktreeCreate, false);
  assert.deepEqual(await importableProjectScripts(f.engine, 'p'), value); assert.equal((await f.engine.snapshot()).projectScriptRuns, undefined); await assert.rejects(readFile(join(f.repo, 'must-not-execute')), /ENOENT/);
  await writeFile(file, ' '.repeat(256 * 1024 + 1)); await assert.rejects(importableProjectScripts(f.engine, 'p'), /256 KiB/);
  await rm(file); await symlink(join(f.repo, 'file'), file); await assert.rejects(importableProjectScripts(f.engine, 'p'), /普通文件/);
});

test('Completed prep scripts preserve background processes and block maintenance until the explicit terminal close', async t => {
  const f = await fixture(t), taskId = await f.task(true); const state = await until(() => f.engine.snapshot(), s => s.tasks[0].status === 'completed');
  await f.engine.mutate(s => { s.projects[0].scripts = [script({ command: 'sleep 60 &', runOnWorktreeCreate: true })]; });
  const id = await f.engine.projectScripts.setup({ projectId: 'p', preparationId: 'fixture-prep', plan: state.tasks.find(t => t.id === taskId)!.executionWorkspace!, requestId: 'prep-bg' }); assert(id);
  const run = await f.done(id); assert.equal(run.status, 'completed', run.error);
  await until(() => f.engine.snapshot(), s => s.projectScriptTerminalsBusy === true); assert.equal(f.engine.terminals.store.get(run.terminalOwner, run.terminalId)?.status, 'running');
  const maintenance = new ServiceMaintenance(() => f.engine.snapshot()); await assert.rejects(maintenance.prepare(), /项目脚本/);
  const auth = new Auth(f.data); t.after(async () => auth.close()); const api = createAPI(f.engine, auth, () => []), headers = { Authorization: 'Bearer ' + auth.token };
  assert.equal((await api.request('/api/project-scripts/runs')).status, 401);
  const open = await(await api.request('/api/project-scripts/runs?projectId=p', { headers })).json(); assert.equal(open.runs[0].id, id); assert.equal(open.runs[0].taskId, undefined);
  await f.engine.terminals.lifecycle(run.terminalOwner, { action: 'close', terminalId: run.terminalId, requestId: 'close-bg', force: true });
  await until(() => f.engine.snapshot(), s => s.projectScriptTerminalsBusy === false); await maintenance.prepare(); maintenance.cancel();
  const closed = await(await api.request('/api/project-scripts/runs?projectId=p', { headers })).json(); assert.equal(closed.runs.length, 0);
});

test('Preparation cancellation is authenticated, attempt-scoped, idempotent and refuses an Agent already handed off', async t => {
  const f = await fixture(t, [script({ command:'read answer',runOnWorktreeCreate:true,async:false })]);
  const id=await f.task(true), pending=await until(()=>f.engine.snapshot(),s=>s.projectScriptRuns?.[0]?.status==='running');
  const task=pending.tasks.find(v=>v.id===id)!, run=task.runs!.find(r=>r.id===task.currentRunId)!;
  const auth=new Auth(f.data);t.after(async()=>auth.close());const api=createAPI(f.engine,auth), path='/api/tasks/'+id+'/preparation/cancel';
  const request=(body:unknown, authenticated=true)=>api.request(path,{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{Authorization:'Bearer '+auth.token}:{})},body:JSON.stringify(body)});
  const body={runId:run.id,attempt:1}; assert.equal((await request(body,false)).status,401);
  assert.equal((await request({...body,attempt:2})).status,400);assert.equal((await request({...body,runId:'foreign'})).status,400);
  assert.equal((await request(body)).status,200);assert.equal((await request(body)).status,200);
  const cancelled=(await f.engine.snapshot()).tasks.find(v=>v.id===id)!;assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.runs![0].workspacePreparation?.status,'cancelled');assert.equal(f.calls.length,0);
  await f.engine.mutate(s=>{s.projects[0].scripts=[script({command:'read answer',runOnWorktreeCreate:true})];});
  const secondId=await f.task(true), handedOff=await until(()=>f.engine.snapshot(),s=>s.tasks.find(v=>v.id===secondId)?.status==='completed');
  const second=handedOff.tasks.find(v=>v.id===secondId)!;
  const late=await api.request('/api/tasks/'+secondId+'/preparation/cancel',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+auth.token},body:JSON.stringify({runId:second.currentRunId,attempt:1})});
  assert.equal(late.status,400);assert.equal((await f.engine.snapshot()).projectScriptRuns?.find(r=>r.taskId===secondId)?.status,'running');assert.equal(f.calls.length,1);
});

test('A persisted cancellation claim survives restart before the abort RPC and never replays setup or starts the Agent', async t => {
  const f=await fixture(t,[script({command:'printf x >> once; read answer',runOnWorktreeCreate:true,async:false})]), id=await f.task(true);
  const state=await until(()=>f.engine.snapshot(),s=>s.projectScriptRuns?.[0]?.startedAt!==undefined), task=state.tasks.find(v=>v.id===id)!;
  await f.engine.mutate(s=>{s.tasks.find(v=>v.id===id)!.runs![0].workspacePreparation!.cancelRequestedAt=new Date().toISOString();});
  await f.engine.close();f.engine=await new Engine(f.data,f.executor).open();
  const ended=await until(()=>f.engine.snapshot(),s=>s.tasks.find(v=>v.id===id)?.status==='cancelled');
  assert.equal(ended.projectScriptRuns?.length,1);assert.equal(f.calls.length,0);assert.equal(await readFile(join(task.cwd,'once'),'utf8'),'x');
});

test('The cancellation claim wins the before-start transaction even when external session initialization already began', async t => {
  const f=await fixture(t);
  let initialized=false, cancellationClaimed=false, release!:()=>void, abort!:()=>void, actualTurns=0;
  const allowStart=new Promise<void>(resolve=>{release=resolve;}), allowAbort=new Promise<void>(resolve=>{abort=resolve;});
  f.executor.deferredStart=()=>true;
  f.executor.run=async request=>{initialized=true;await allowStart;await request.beforeStart?.();actualTurns++;return 'must not execute';};
  const originalCancel=f.engine.cancel.bind(f.engine);f.engine.cancel=async(id,scope)=>{cancellationClaimed=true;await allowAbort;await originalCancel(id,scope);};
  try {
  const id=await f.task(true);await until(()=>initialized,Boolean);
  const task=(await f.engine.snapshot()).tasks.find(v=>v.id===id)!;
  const stopping=f.engine.taskPreparations.cancel(id,task.currentRunId!,1);await until(()=>cancellationClaimed,Boolean);release();
  await until(()=>f.engine.snapshot(),s=>s.tasks.find(v=>v.id===id)?.status==='cancelled');abort();await stopping;
  const stopped=(await f.engine.snapshot()).tasks.find(v=>v.id===id)!;
  assert.equal(actualTurns,0);assert.equal(stopped.runs![0].startedAt,undefined);assert.equal(stopped.runs![0].before,undefined);
  } finally { release();abort(); }
});
