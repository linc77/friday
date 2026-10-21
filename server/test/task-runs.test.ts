import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { taskGit } from '../src/git-process.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';

class RunExecutor implements Executor {
  requests: ExecutionRequest[] = [];
  handle: (request: ExecutionRequest) => Promise<string> = async () => 'Done';
  async run(request: ExecutionRequest) { this.requests.push(request); return this.handle(request); }
  async answer() {}
  async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Run transition timed out');
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-runs-'))); const root = join(base, 'source'); const data = join(base, 'data'); await mkdir(root);
  await taskGit(root, ['init', '-q', '--initial-branch=main']); await writeFile(join(root, 'file'), 'initial\n');
  await taskGit(root, ['add', '.']); await taskGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial']);
  const executor = new RunExecutor(); const engine = await new Engine(data, executor).open();
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  return { base, root, data, executor, engine };
}

test('Durable turns persist boundaries before execution, retain session IDs, aggregate real net changes and serve immutable authenticated diffs', async t => {
  const { root, data, engine, executor } = await setup(t);
  executor.handle = async request => {
    const saved = (await engine.snapshot()).tasks.find(task => task.id === request.task.id)!;
    assert.equal(saved.runs?.at(-1)?.before?.status, 'ready');
    await request.update({ kind: 'session', threadId: 'native-thread' }); await request.update({ kind: 'turn', turnId: 'turn-' + executor.requests.length });
    await writeFile(join(request.task.cwd, 'file'), 'turn-' + executor.requests.length + '\n');
    await request.update({ kind: 'item', item: { id: 'tool-' + executor.requests.length, itemId: 'patch', kind: 'files', text: 'Applied patch', at: new Date().toISOString(), status: 'completed', changes: [{ path: 'file', kind: 'update', diff: '@@\n-old\n+new\n', additions: 1, deletions: 1 }] } });
    return 'Answer ' + executor.requests.length;
  };
  const id = await engine.createTask({ prompt: 'First', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'first', workspace: { mode: 'worktree' } });
  let state = await until(engine, state => state.tasks[0]?.status === 'completed'); const first = state.tasks[0].runs![0]!;
  assert.equal(first.status, 'completed'); assert.equal(first.threadId, 'native-thread'); assert.equal(first.turnId, 'turn-1');
  assert.deepEqual(first.changes?.map(file => file.path), ['file']);
  assert.equal(state.tasks[0].messages?.[0]?.runId, first.id); assert.equal(state.tasks[0].messages?.at(-1)?.runId, first.id);
  assert.equal(state.tasks[0].events.find(event => event.id === 'tool-1')?.runId, first.id);
  assert.equal((await taskGit(root, ['show', 'HEAD:file'])).stdout, 'initial\n');
  await engine.createTask({ continueId: id, prompt: 'Second', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'second' });
  state = await until(engine, state => state.tasks[0]?.status === 'completed' && state.tasks[0].runs?.length === 2);
  assert.notEqual(state.tasks[0].currentRunId, first.id);
  assert.equal(state.tasks[0].runs?.[1]?.before?.status, 'ready');
  assert.equal(state.tasks[0].runs?.[1]?.turnId, 'turn-2');
  const result = state.tasks[0].result; await executor.requests[0]!.update({ kind: 'output', text: 'late previous callback' });
  assert.equal((await engine.snapshot()).tasks[0]?.result, result);
  const auth = new Auth(data); const app = createAPI(engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token };
  const route = `/api/tasks/${id}/runs/${first.id}/diff?path=file`;
  assert.equal((await app.request(route)).status, 401);
  const response = await app.request(route, { headers }); assert.equal(response.status, 200);
  const diff = await response.json(); assert.match(diff.patch, /-initial\n\+turn-1/); assert.doesNotMatch(diff.patch, /turn-2/);
  assert.equal((await app.request(`/api/tasks/${id}/runs/${first.id}/diff?path=..%2Foutside`, { headers })).status, 400);
  assert.equal((await app.request(`/api/tasks/${id}/runs/missing/diff?path=file`, { headers })).status, 400);
});

test('A failed or cancelled turn retains its actual source changes without changing the successful answer lifecycle', async t => {
  const { root, engine, executor } = await setup(t);
  executor.handle = async request => { await writeFile(join(root, 'file'), 'partial change\n'); throw new Error('fixture failure'); };
  const id = await engine.createTask({ prompt: 'Fail', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'fail' });
  let state = await until(engine, state => state.tasks[0]?.status === 'failed');
  assert.equal(state.tasks[0].runs?.[0]?.status, 'failed'); assert.deepEqual(state.tasks[0].runs?.[0]?.changes?.map(file => file.path), ['file']);
  executor.handle = request => new Promise((_, reject) => {
    void writeFile(join(root, 'file'), 'cancelled change\n').then(() => request.update({ kind: 'ready', canSteer: true }));
    request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await engine.createTask({ continueId: id, prompt: 'Cancel', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'cancel' });
  await until(engine, state => state.tasks[0]?.canSteer === true); await engine.cancel(id);
  state = await until(engine, state => state.tasks[0]?.status === 'cancelled');
  assert.equal(state.tasks[0].runs?.[1]?.status, 'cancelled'); assert.deepEqual(state.tasks[0].runs?.[1]?.changes?.map(file => file.path), ['file']);
});

test('Restart never replays an uncertain turn or attributes offline file edits to a fabricated after-checkpoint', async t => {
  const { root, data, engine, executor } = await setup(t);
  executor.handle = request => new Promise((_, reject) => {
    void request.update({ kind: 'turn', turnId: 'uncertain-turn' });
    request.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true });
  });
  await engine.createTask({ prompt: 'Interrupted', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'interrupted' });
  await until(engine, state => state.tasks[0]?.turnId === 'uncertain-turn'); await engine.close();
  await writeFile(join(root, 'file'), 'offline user change\n');
  const reopened = await new Engine(data, executor).open();
  try {
    const state = await until(reopened, state => state.tasks[0]?.status === 'interrupted');
    assert.equal(executor.requests.length, 1); assert.equal(state.tasks[0].runs?.[0]?.after, undefined);
    assert.equal(state.tasks[0].runs?.[0]?.changes, undefined); assert.match(state.tasks[0].runs?.[0]?.diffError ?? '', /中断/);
  } finally { await reopened.close(); }
});

test('A confirmed external result survives interruption during checkpoint persistence without repeating execution or capturing offline changes', async t => {
  const { root, data, engine, executor } = await setup(t);
  let finishing = false;
  executor.handle = async request => { await writeFile(join(root, 'file'), 'confirmed source change\n'); await request.update({ kind: 'turn', turnId: 'confirmed-turn' }); return 'Confirmed answer'; };
  engine.taskRuns.finish = async () => {
    finishing = true;
    await new Promise<void>((_, reject) => executor.requests.at(-1)!.signal.addEventListener('abort', () => reject(new Error('interrupted during persistence')), { once: true }));
  };
  await engine.createTask({ prompt: 'Confirmed', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'confirmed' });
  await until(engine, () => finishing); await engine.close();
  await writeFile(join(root, 'file'), 'offline user change\n');
  const reopened = await new Engine(data, executor).open();
  try {
    const state = await until(reopened, state => state.tasks[0]?.status === 'completed'); const work = state.tasks[0];
    assert.equal(executor.requests.length, 1); assert.equal(work.result, 'Confirmed answer');
    assert.equal(work.messages?.filter(message => message.role === 'assistant').length, 1);
    assert.equal(work.runs?.[0]?.status, 'completed'); assert.equal(work.runs?.[0]?.after, undefined);
    assert.equal(work.runs?.[0]?.changes, undefined); assert.match(work.runs?.[0]?.diffError ?? '', /结束检查点尚未保存/);
  } finally { await reopened.close(); }
});

test('A turn that removes its workspace subdirectory captures deletions without recreating the directory', async t => {
  const { root, engine, executor } = await setup(t); const scope = join(root, 'scope'); await mkdir(scope); await writeFile(join(scope, 'scoped'), 'scoped source\n');
  await taskGit(root, ['add', 'scope']); await taskGit(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Scope']);
  await engine.mutate(state => { state.projects[0].path = scope; });
  executor.handle = async request => { await rm(request.task.cwd, { recursive: true }); return 'Removed scope'; };
  await engine.createTask({ prompt: 'Remove', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'remove-scope' });
  const state = await until(engine, state => state.tasks[0]?.status === 'completed'); const run = state.tasks[0].runs?.[0];
  assert.equal(run?.after?.status, 'ready', run?.diffError); assert.deepEqual(run?.changes?.map(file => [file.path, file.kind]), [['scoped', 'delete']]);
  assert.match((await engine.taskRuns.diff(state.tasks[0], run!.id, 'scoped')).patch, /-scoped source/);
});
