import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { taskGit } from '../src/git-process.js';
import { readTaskGitStatus } from '../src/task-git-status.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, NativeRewindRequest, NativeRewindResult, Workspace, WorkItem } from '../src/types.js';

class RewindExecutor implements Executor {
  requests: ExecutionRequest[] = []; turns: string[] = []; calls = 0; lose = false; unsupported = false;
  beforeApply?: (request: NativeRewindRequest) => Promise<void>;
  afterApply?: (request: NativeRewindRequest) => Promise<void>;
  async run(request: ExecutionRequest) {
    this.requests.push(request); const turnId = 'turn-' + this.requests.length;
    await request.update({ kind: 'session', threadId: request.task.threadId ?? 'native-thread' });
    await request.update({ kind: 'turn', turnId }); this.turns.push(turnId);
    if (request.task.agent === 'claude') await request.update({ kind: 'nativeHead', head: 'assistant-' + turnId });
    await writeFile(join(request.task.cwd, 'file'), turnId + '\n');
    await request.update({ kind: 'item', item: { id: turnId + '-event', kind: 'message', phase: 'final_answer', text: 'Answer ' + turnId, at: new Date().toISOString(), turnId, status: 'completed' } });
    return 'Answer ' + turnId;
  }
  async rewind(request: NativeRewindRequest): Promise<NativeRewindResult> {
    if (this.unsupported) throw new Error('旧历史格式，不能回退');
    if (request.inspectOnly) return { state: JSON.stringify(this.turns) === JSON.stringify(request.original?.keep) ? 'applied' : 'unchanged', threadId: 'native-thread', turns: this.turns };
    const index = request.targetTurnId ? this.turns.indexOf(request.targetTurnId) : this.turns.length;
    assert.deepEqual(this.turns.slice(index), request.removeTurns);
    await request.started({ threadId: 'native-thread', turns: [...this.turns], keep: this.turns.slice(0, index) });
    await this.beforeApply?.(request);
    this.calls++; this.turns = this.turns.slice(0, index);
    await this.afterApply?.(request);
    if (this.lose) { this.lose = false; throw new Error('lost native receipt'); }
    await request.candidate('native-thread');
    return { state: 'applied', threadId: 'native-thread', turns: [...this.turns] };
  }
  async answer() {}
  async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { const state = await engine.snapshot(); if (predicate(state)) return state; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Rewind transition timed out');
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, managed = true, agent: 'codex' | 'claude' = 'codex') {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-rewind-'))); const root = join(base, 'source'); const data = join(base, 'data'); await mkdir(root);
  const git = (cwd: string, args: string[]) => taskGit(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args]);
  await git(root, ['init', '-q', '--initial-branch=main']); await writeFile(join(root, 'file'), 'initial\n'); await writeFile(join(root, '.gitignore'), '*.ignored\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-qm', 'Initial']);
  const executor = new RewindExecutor(); const engine = await new Engine(data, executor).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'First visible', projectId: 'project', agent, mode: 'code', requestId: 'first', ...(managed ? { workspace: { mode: 'worktree' as const } } : {}) });
  await until(engine, state => state.tasks[0]?.status === 'completed');
  await engine.createTask({ continueId: id, prompt: 'Second removed', projectId: 'project', agent, mode: 'code', requestId: 'second' });
  const state = await until(engine, state => state.tasks[0]?.status === 'completed' && state.tasks[0].runs?.length === 2);
  const work = state.tasks[0]; const messageID = work.runs![1].messageId;
  const settled = () => until(engine, state => !!state.tasks[0]?.rewindOperation && !['queued', 'running'].includes(state.tasks[0].rewindOperation.status));
  const submitted = new Map<string, Parameters<Engine['taskRewinds']['start']>[1]>();
  const start = async (restoreFiles: boolean, requestId = 'rewind') => {
    if (!submitted.has(requestId)) { const options = await engine.taskRewinds.options(id, messageID); submitted.set(requestId, { requestId, messageId: messageID, fingerprint: options.fingerprint, fileFingerprint: options.fileFingerprint, restoreFiles }); }
    return engine.taskRewinds.start(id, submitted.get(requestId)!);
  };
  return { root, data, engine, executor, id, work, messageID, settled, start, git };
}

test('Edit-from-here preserves source files, rewinds native and visible history together and leaves original request tombstones intact', async t => {
  const { engine, executor, id, work, messageID, start, settled } = await setup(t);
  await engine.mutate(state => {
    const task = state.tasks[0]; task.events.push({ id: 'legacy-tool-receipt', kind: 'note', text: 'An older receipt', at: work.runs![1].at });
    task.runs![0].contextUsage = { usedTokens: 100, maxTokens: 200000, updatedAt: work.runs![0].at };
    task.contextUsage = { usedTokens: 200, maxTokens: 200000, updatedAt: work.runs![1].at };
  });
  const operationID = await start(false); let state = await settled(); const task = state.tasks[0];
  assert.equal(task.rewindOperation?.status, 'completed', task.rewindOperation?.error); assert.deepEqual(executor.turns, ['turn-1']);
  assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'turn-2\n');
  assert.deepEqual(task.messages?.filter(message => !message.revertedAt).map(message => message.text), ['First visible', 'Answer turn-1']);
  assert.equal(task.events.find(event => event.id === 'turn-2-event')?.revertedAt != null, true); assert.equal(task.runs?.[1]?.revertedAt != null, true);
  assert.ok(task.events.find(event => event.id === 'legacy-tool-receipt')?.revertedAt);
  assert.equal(task.result, 'Answer turn-1'); assert.equal(task.rewindOperation?.editor.text, 'Second removed');
  assert.equal(task.contextUsage?.usedTokens, 100, 'Rewind restores only the retained run report, never future occupancy');
  assert.equal(task.rewindOperation?.messageId, messageID);
  assert.equal(await start(false), operationID); assert.equal(executor.calls, 1);
  await engine.createTask({ continueId: id, prompt: 'Must deduplicate', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'second' });
  assert.equal(executor.requests.length, 2);
  await engine.createTask({ continueId: id, prompt: 'Edited replacement', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'new-editor-request' });
  state = await until(engine, state => state.tasks[0]?.status === 'completed' && state.tasks[0].runs?.length === 3);
  assert.deepEqual(state.tasks[0].messages?.filter(message => !message.revertedAt).map(message => message.text), ['First visible', 'Answer turn-1', 'Edited replacement', 'Answer turn-3']);
});

test('File rewind restores the selected start snapshot, keeps current HEAD and ignored files, removes later untracked files and leaves changes unstaged', async t => {
  const { engine, work, git, start, settled } = await setup(t);
  await git(work.cwd, ['add', 'file']); await git(work.cwd, ['commit', '-qm', 'Keep this current HEAD']); const head = (await git(work.cwd, ['rev-parse', 'HEAD'])).stdout;
  await writeFile(join(work.cwd, 'keep.ignored'), 'ignored survives\n'); await writeFile(join(work.cwd, 'later-untracked'), 'remove me\n');
  await start(true); const state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'completed', state.tasks[0].rewindOperation?.error);
  assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'turn-1\n'); assert.equal((await git(work.cwd, ['rev-parse', 'HEAD'])).stdout, head);
  assert.equal(await readFile(join(work.cwd, 'keep.ignored'), 'utf8'), 'ignored survives\n'); await assert.rejects(readFile(join(work.cwd, 'later-untracked')), { code: 'ENOENT' });
  assert.equal((await git(work.cwd, ['diff', '--cached'])).stdout, ''); assert.match((await git(work.cwd, ['diff', '--', 'file'])).stdout, /-turn-2\n\+turn-1/);
  assert.ok(state.tasks[0].rewindOperation?.backup?.status === 'ready');
  assert.doesNotMatch((await git(work.cwd, ['for-each-ref', '--format=%(refname)'])).stdout, /friday/);
});

test('A cleaned managed worktree is recreated from its exact Git registration and snapshot without resetting its branch', async t => {
  const { engine, work, git, start, settled } = await setup(t);
  const head = (await git(work.cwd, ['rev-parse', 'HEAD'])).stdout; const branch = (await git(work.cwd, ['symbolic-ref', '--short', 'HEAD'])).stdout;
  await rm(work.cwd, { recursive: true });
  await start(true); const state = await settled();
  assert.equal(state.tasks[0].rewindOperation?.status, 'completed', state.tasks[0].rewindOperation?.error);
  assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'turn-1\n');
  assert.equal((await git(work.cwd, ['rev-parse', 'HEAD'])).stdout, head); assert.equal((await git(work.cwd, ['symbolic-ref', '--short', 'HEAD'])).stdout, branch);
  assert.equal((await git(work.cwd, ['diff', '--cached'])).stdout, '');
});

test('A main checkout and a worktree referenced by an archived thread can rewind chat but cannot restore shared files', async t => {
  const checkout = await setup(t, false); const options = await checkout.engine.taskRewinds.options(checkout.id, checkout.messageID);
  assert.equal(options.canRestore, false); await assert.rejects(checkout.start(true), /独占/); await checkout.start(false, 'keep-after-restore-rejected'); await checkout.settled();
  const managed = await setup(t);
  await managed.engine.mutate(state => { const other = JSON.parse(JSON.stringify(state.tasks[0])) as WorkItem; other.id = 'archived-sharer'; other.archivedAt = new Date().toISOString(); other.durableId = null; state.tasks.push(other); });
  assert.equal((await managed.engine.taskRewinds.options(managed.id, managed.messageID)).canRestore, false); await assert.rejects(managed.start(true), /独占/);
});

test('A lost native reply holds input until read-only reconciliation and never repeats the revert', async t => {
  const { engine, executor, id, start, settled } = await setup(t); executor.lose = true;
  const operationID = await start(false); let state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'interrupted'); assert.equal(executor.calls, 1);
  await assert.rejects(engine.createTask({ continueId: id, prompt: 'blocked', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'blocked' }), /回退|工作区/);
  await engine.taskRewinds.resolve(id, operationID, { requestId: 'inspect-receipt', action: 'inspect' });
  state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'completed'); assert.equal(executor.calls, 1); assert.equal(state.tasks[0].result, 'Answer turn-1');
});

test('A service interruption after native revert reconciles through Durable and never overwrites offline file edits', async t => {
  const { engine, executor, id, data, work, start } = await setup(t);
  let applied = false;
  executor.afterApply = request => new Promise((_, reject) => { applied = true; request.signal.addEventListener('abort', () => reject(new Error('service stopped')), { once: true }); });
  const operationID = await start(true);
  await until(engine, state => applied && !!state.tasks[0].rewindOperation?.nativeStart); await engine.close();
  await writeFile(join(work.cwd, 'file'), 'offline user edit\n');
  const reopened = await new Engine(data, executor).open();
  try {
    let state = await until(reopened, state => state.tasks[0]?.rewindOperation?.status === 'needs_review');
    assert.equal(executor.calls, 1); assert.equal(state.tasks[0].result, 'Answer turn-1');
    assert.equal(state.tasks[0].rewindOperation?.filesStartedAt, undefined); assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'offline user edit\n');
    await reopened.taskRewinds.resolve(id, operationID, { requestId: 'keep-offline-files', action: 'keep_files' });
    state = await until(reopened, state => state.tasks[0]?.rewindOperation?.status === 'completed');
    assert.equal(executor.calls, 1); assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'offline user edit\n');
  } finally { await reopened.close(); }
});

test('Rewinding an uncertain promoted input retires its queue projection while preserving the original delivery receipt in audit history', async t => {
  const { engine, id, work, start, settled } = await setup(t); const run = work.runs![1];
  assert.ok(run.durableId !== null);
  await engine.mutate(state => {
    const task = state.tasks.find(task => task.id === id)!;
    task.messages!.push({ id: 'uncertain-steer', role: 'user', text: 'Steer', runId: run.id, turnId: run.turnId, at: new Date().toISOString(), delivery: 'uncertain' });
    task.queue = { dispatcherId: null, paused: true, error: 'unknown delivery', messages: [{ id: 'queued-steer', dispatchId: 'uncertain-steer', text: 'Steer', images: [], createdAt: new Date().toISOString(), status: 'uncertain', runId: run.durableId! }] };
  });
  await start(false); const state = await settled(); const task = state.tasks[0];
  assert.equal(task.rewindOperation?.status, 'completed'); assert.equal(task.queue?.messages[0].status, 'cancelled'); assert.equal(task.queue?.error, null);
  const receipt = task.messages?.find(message => message.id === 'uncertain-steer'); assert.equal(receipt?.delivery, 'uncertain'); assert.ok(receipt?.revertedAt);
});

test('An uncertain file restore keeps the projected native history and requires an explicit inspected retry', async t => {
  const { engine, id, work, start, settled } = await setup(t);
  const original = engine.taskRuns.checkpoints.restore.bind(engine.taskRuns.checkpoints); let calls = 0;
  engine.taskRuns.checkpoints.restore = async () => { calls++; await writeFile(join(work.cwd, 'file'), 'partially restored\n'); throw new Error('fixture partial restore'); };
  const operationID = await start(true); let state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'needs_review'); assert.equal(state.tasks[0].result, 'Answer turn-1');
  assert.equal(state.tasks[0].messages?.filter(message => !message.revertedAt).length, 2);
  engine.taskRuns.checkpoints.restore = async (...args) => { calls++; return original(...args); };
  await assert.rejects(engine.taskRewinds.resolve(id, operationID, { requestId: 'stale-file-review', action: 'retry_files', fileFingerprint: 'stale' }), /文件已经改变/);
  const review = await readTaskGitStatus(work.cwd, { directory: engine.directory, workspace: work.executionWorkspace });
  await engine.taskRewinds.resolve(id, operationID, { requestId: 'retry-file-review', action: 'retry_files', fileFingerprint: review.fingerprint });
  state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'completed', state.tasks[0].rewindOperation?.error); assert.equal(calls, 2); assert.equal(await readFile(join(work.cwd, 'file'), 'utf8'), 'turn-1\n');
});

test('Unsupported native history can explicitly start a fresh session using only the retained visible prefix', async t => {
  const { engine, executor, id, start, settled } = await setup(t); executor.unsupported = true;
  const operationID = await start(false); let state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'failed');
  await engine.taskRewinds.resolve(id, operationID, { requestId: 'new-session-after-review', action: 'new_session' });
  state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'completed'); assert.equal(state.tasks[0].threadId, null);
  await engine.createTask({ continueId: id, prompt: 'New continuation', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'after-detach' });
  await until(engine, state => state.tasks[0]?.status === 'completed' && executor.requests.length === 3);
  assert.match(executor.requests[2].prompt, /First visible/); assert.doesNotMatch(executor.requests[2].prompt, /Second removed|Answer turn-2/);
});

test('Claude rewind uses the retained SDK cursor and first-turn rewind allocates a fresh native session', async t => {
  const { engine, id, work, messageID, start, settled } = await setup(t, true, 'claude');
  await start(false); let state = await settled(); assert.equal(state.tasks[0].claudeResumeSessionAt, 'assistant-turn-1');
  assert.equal(state.tasks[0].threadId, 'native-thread');
  const firstMessage = work.runs![0].messageId; const options = await engine.taskRewinds.options(id, firstMessage);
  await engine.taskRewinds.start(id, { requestId: 'rewind-first', messageId: firstMessage, fingerprint: options.fingerprint, restoreFiles: false });
  state = await settled(); assert.equal(state.tasks[0].threadId, null); assert.equal(state.tasks[0].messages?.filter(message => !message.revertedAt).length, 0);
  assert.notEqual(messageID, firstMessage);
});

test('An admitted rewind reserves source operations and its APIs authenticate and reject changed history', async t => {
  const { engine, executor, id, data, work, messageID, start, settled } = await setup(t);
  let release!: () => void; executor.beforeApply = () => new Promise<void>(resolve => { release = resolve; });
  const auth = new Auth(data); const app = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const route = `/api/tasks/${id}/rewind/options?messageId=${messageID}`; assert.equal((await app.request(route)).status, 401);
  const options = await (await app.request(route, { headers })).json();
  const bad = await app.request(`/api/tasks/${id}/rewind`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'stale', messageId: messageID, fingerprint: 'stale', restoreFiles: false }) }); assert.equal(bad.status, 400);
  await start(false); await until(engine, state => !!state.tasks[0]?.rewindOperation?.nativeStart && !!release);
  try {
    await assert.rejects(engine.taskQueue.enqueue(id, { text: 'old history queue' }, 'queue-during-rewind'), /回退/);
    await assert.rejects(new ServiceMaintenance(() => engine.snapshot()).prepare(), /执行或等待/);
    await assert.rejects(engine.updateTaskMetadata(id, { archived: true }), /回退/);
    assert.equal(options.canRestore, true); assert.equal(options.removedTurns, 1);
    await engine.mutate(state => state.projects.push({ id: 'managed-link', name: 'Managed', path: work.cwd, context: '' }));
    await assert.rejects(engine.createTask({ prompt: 'same workspace', projectId: 'managed-link', agent: 'codex', mode: 'code', requestId: 'during-rewind' }), /工作区/);
  } finally { release(); }
  const state = await settled(); assert.equal(state.tasks[0].rewindOperation?.status, 'completed');
});
