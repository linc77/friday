import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { formatTaskTitleContext, generatedTaskTitle, limitTitleMessage } from '../src/task-title-text.js';
import type { ExecutionRequest, Executor, TextGenerationRequest } from '../src/types.js';

async function until(read: () => boolean | Promise<boolean>, message = 'Title state did not settle') {
  const deadline = Date.now() + 10_000;
  while (!await read()) { if (Date.now() > deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
class Titles implements Executor {
  requests: TextGenerationRequest[] = []; foreground = 0;
  generate: (request: TextGenerationRequest) => Promise<string> = async () => '{"title":"可恢复的任务标题"}';
  async run({ update }: ExecutionRequest) {
    this.foreground++; await update({ kind: 'session', threadId: 'user-thread' }); await update({ kind: 'turn', turnId: 'user-turn' }); return 'Original answer';
  }
  async generateText(request: TextGenerationRequest) {
    this.requests.push(request); await request.update({ kind: 'session', threadId: 'title-session-' + this.requests.length });
    await request.update({ kind: 'turn', turnId: 'title-turn-' + this.requests.length }); return this.generate(request);
  }
  async answer() {} async steer() {}
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, executor = new Titles()) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-title-'))); const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(directory, executor).open();
  await engine.mutate(state => { state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }); });
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { executor, directory, get engine() { return engine; },
    create: (requestId = 'task', title?: string) => engine.createTask({ prompt: 'Fix the task output', projectId: 'project', agent: 'codex', mode: 'research', requestId, ...(title ? { title } : {}) }),
    reopen: async () => { await engine.close(); engine = await new Engine(directory, executor).open(); },
  };
}

test('Title context preserves the first goal, recent user priorities, answer context and bounded image selection without reasoning or tools', () => {
  const image = (id: string) => ({ id, name: id + '.png', mediaType: 'image/png' });
  const messages = [{ role: 'user', text: 'ORIGINAL GOAL ' + 'x'.repeat(5000), images: [image('first')] },
    { role: 'reasoning', text: 'PRIVATE THOUGHTS' }, { role: 'tool', text: 'PRIVATE TOOL' },
    ...Array.from({ length: 20 }, (_, i) => [{ role: 'user', text: `USER ${i} ` + '🧭'.repeat(1500), images: [image('image-' + i)] }, { role: 'assistant', text: `ANSWER ${i} ` + 'a'.repeat(1500) }]).flat()];
  const context = formatTaskTitleContext(messages);
  assert.ok(context.message.length <= 8000); assert.match(context.message, /^\[Earlier content truncated\]/);
  assert.match(context.message, /ORIGINAL GOAL/); assert.match(context.message, /USER 19/); assert.match(context.message, /ANSWER 19/);
  assert.ok(!context.message.includes('PRIVATE')); assert.equal(context.images[0].id, 'first'); assert.ok(context.images.length <= 4);
  for (let length = 30; length < 45; length++) assert.doesNotThrow(() => encodeURIComponent(limitTitleMessage('🧭'.repeat(50), length)));
  assert.equal(generatedTaskTitle('```json\n{"title":"  修复实时输出  ","needsRefinement":false}\n```'), '修复实时输出');
  assert.equal(generatedTaskTitle('{"title":"New thread"}'), undefined); assert.equal(generatedTaskTitle('{"title":""}'), undefined);
  assert.throws(() => generatedTaskTitle('{"title":42}')); assert.throws(() => generatedTaskTitle('{"title":"bad\\u0000title"}'));
  const long = generatedTaskTitle(JSON.stringify({ title: '🧭'.repeat(100) }))!; assert.ok(long.length <= 120); assert.doesNotThrow(() => encodeURIComponent(long));
  assert.throws(() => generatedTaskTitle('{"title":"missing closing brace"'));
  assert.throws(() => generatedTaskTitle('任务已完成，详见执行记录。'), 'executor fallback prose is not a generated title');
  assert.throws(() => generatedTaskTitle('{"title":"Title","needsRefinement":"true"}'));
});

test('Initial title work is independent of the user turn and persists its own session before generation continues', async t => {
  const f = await fixture(t); let release!: (value: string) => void;
  f.executor.generate = () => new Promise(resolve => { release = resolve; });
  const id = await f.create();
  await until(async () => !!release && (await f.engine.snapshot()).tasks[0].status === 'completed');
  const before = (await f.engine.snapshot()).tasks[0]; const receipt = (await f.engine.snapshot()).titleRequests!['title:task'];
  assert.equal(receipt.sessions?.['attempt-0'].threadId, 'title-session-1'); assert.equal(receipt.sessions?.['attempt-0'].turnId, 'title-turn-1');
  assert.equal(before.threadId, 'user-thread'); assert.equal(before.turnId, 'user-turn'); assert.equal(before.result, 'Original answer');
  assert.equal(f.executor.requests[0].task.threadId, null); assert.equal(f.executor.requests[0].purpose, 'task_title');
  assert.ok(before.titleRegeneration); assert.match(f.executor.requests[0].prompt, /Fix the task output/);
  const maintenance = new ServiceMaintenance(() => f.engine.snapshot()); await assert.rejects(maintenance.prepare(), /生成任务标题/);
  release('{"title":"修复任务输出"}');
  await until(async () => !(await f.engine.snapshot()).tasks[0].titleRegeneration);
  const after = (await f.engine.snapshot()).tasks[0]; assert.equal(after.title, '修复任务输出');
  for (const key of ['threadId', 'turnId', 'result', 'status', 'updatedAt', 'messages', 'events', 'currentRunId'] as const) assert.deepEqual(after[key], before[key], key);
  await f.reopen(); assert.equal((await f.engine.snapshot()).tasks[0].title, '修复任务输出'); assert.equal(f.executor.foreground, 1);
  assert.equal((await f.engine.snapshot()).titleRequests!['title:task'].sessions?.['attempt-0'].threadId, 'title-session-1');
  assert.equal((await f.engine.snapshot()).tasks[0].id, id);
});

test('Manual rename (including the same title) wins against an in-flight generation and clears its public busy state', async t => {
  const f = await fixture(t); const id = await f.create('manual', 'Manual title');
  let release!: (value: string) => void; f.executor.generate = () => new Promise(resolve => { release = resolve; });
  await f.engine.taskTitles.start(id, 'rename-race'); await until(() => !!release);
  await f.engine.updateTaskMetadata(id, { title: 'Manual title' });
  assert.equal(f.executor.requests[0].signal.aborted, true);
  release('{"title":"Late generated title"}');
  await until(async () => (await f.engine.snapshot()).titleRequests!['rename-race'].status !== 'pending');
  const task = (await f.engine.snapshot()).tasks[0]; assert.equal(task.title, 'Manual title'); assert.equal(task.titleRegeneration, null);
  assert.equal((await f.engine.snapshot()).titleRequests!['rename-race'].status, 'superseded');
});

test('A newer generation owns completion, retries are idempotent, and fallback or unchanged titles preserve the current title', async t => {
  const f = await fixture(t); const id = await f.create('regenerate', 'Original title');
  const releases: ((value: string) => void)[] = []; f.executor.generate = () => new Promise(resolve => releases.push(resolve));
  const first = await f.engine.taskTitles.start(id, 'first'); await until(() => releases.length === 1);
  assert.equal(await f.engine.taskTitles.start(id, 'first'), first);
  await f.engine.taskTitles.start(id, 'second'); await until(() => releases.length === 2);
  assert.equal(await f.engine.taskTitles.start(id, 'first'), first);
  assert.equal(f.executor.requests[1].signal.aborted, false, 'a late retry must not cancel a newer request');
  releases[1]('{"title":"Improved title"}'); await until(async () => (await f.engine.snapshot()).tasks[0].title === 'Improved title');
  releases[0]('{"title":"Stale title"}'); await until(async () => (await f.engine.snapshot()).titleRequests!['first'].status !== 'pending');
  assert.equal((await f.engine.snapshot()).tasks[0].title, 'Improved title');
  for (const value of ['New thread', 'Improved title']) {
    f.executor.generate = async () => JSON.stringify({ title: value }); const key = 'fallback-' + value;
    await f.engine.taskTitles.start(id, key); await until(async () => (await f.engine.snapshot()).titleRequests![key].status !== 'pending');
    assert.equal((await f.engine.snapshot()).tasks[0].title, 'Improved title');
  }
  assert.match(f.executor.requests[0].prompt, /Original title/); assert.match(f.executor.requests[0].prompt, /USER:/);
});

test('Initial invalid results retry twice; explicit regeneration and uncertain provider failures keep the prior title without retrying', async t => {
  const f = await fixture(t); f.executor.generate = async () => f.executor.requests.length < 3 ? '{"title":42}' : '{"title":"Third attempt title"}';
  await f.create('retry'); await until(async () => (await f.engine.snapshot()).tasks[0].title === 'Third attempt title'); assert.equal(f.executor.requests.length, 3);
  const task = (await f.engine.snapshot()).tasks[0];
  f.executor.generate = async () => { throw new Error('A lost provider response'); };
  await f.engine.taskTitles.start(task.id, 'explicit-failure'); await until(async () => !(await f.engine.snapshot()).tasks[0].titleRegeneration);
  assert.equal(f.executor.requests.length, 4); assert.equal((await f.engine.snapshot()).tasks[0].title, 'Third attempt title');
  await f.create('uncertain'); await until(async () => (await f.engine.snapshot()).titleRequests!['title:uncertain']?.status === 'failed');
  assert.equal(f.executor.requests.length, 5, 'uncertain initial failures must not start more paid turns');
});

test('Title API enforces authentication and request ownership, excludes receipts from overview, and deletion cancels native generation', async t => {
  const f = await fixture(t); const id = await f.create('api', 'API task'); const other = await f.create('other', 'Other task');
  await until(async () => (await f.engine.snapshot()).tasks.every(task => task.status === 'completed'));
  const auth = new Auth(f.directory); t.after(async () => auth.close()); const app = createAPI(f.engine, auth, () => []);
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const post = (task: string, requestId: string) => app.request(`/api/tasks/${task}/title/regenerate`, { method: 'POST', headers, body: JSON.stringify({ requestId }) });
  assert.equal((await app.request(`/api/tasks/${id}/title/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await post(id, '__proto__')).status, 400); assert.equal((await post('missing', 'missing')).status, 400);
  f.executor.generate = request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  assert.equal((await post(id, 'api-title')).status, 202); await until(() => f.executor.requests.length === 1);
  assert.equal((await app.request('/api/agents/codex/settings', { method: 'PUT', headers, body: '{}' })).status, 409, 'title generation retains ownership of its provider configuration');
  assert.equal((await post(other, 'api-title')).status, 400);
  const overview = await (await app.request('/api/overview', { headers })).json(); assert.equal(overview.titleRequests, undefined);
  assert.equal(overview.tasks.find((task: any) => task.id === id).titleRegeneration.requestId, 'api-title');
  await f.engine.deleteTask(id); assert.equal(f.executor.requests[0].signal.aborted, true);
  assert.ok(!(await f.engine.snapshot()).tasks.some(task => task.id === id));
  const count = f.executor.requests.length; assert.equal((await post(id, 'api-title')).status, 202, 'a lost request receipt must not resurrect a deleted task');
  assert.equal(f.executor.requests.length, count);
});

for (const mode of ['uncertain', 'receipt']) test(`Hard restart ${mode === 'receipt' ? 'projects a saved title receipt' : 'retires uncertain title work'} without another provider call`, async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-title-crash-'))); const path = fileURLToPath(new URL('fixtures/title-crash.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--import', 'tsx', path, base, mode], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => { errors += data.toString(); }); const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  let engine: Engine | undefined;
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await engine?.close(); await rm(base, { recursive: true, force: true }); });
  await until(async () => { if (child.exitCode !== null) throw new Error(errors); try { await access(join(base, 'ready')); return true; } catch { return false; } }, 'Child did not reach the owned crash boundary');
  child.kill('SIGKILL'); await exited;
  const executor = new Titles(); engine = await new Engine(join(base, 'data'), executor).open();
  await until(async () => !(await engine!.snapshot()).tasks[0].titleRegeneration);
  const state = await engine.snapshot(); const request = state.titleRequests!['title:crash'];
  assert.equal(executor.requests.length, 0); assert.equal(executor.foreground, 0); assert.equal(state.tasks[0].result, 'Original answer');
  assert.equal(request.sessions?.['attempt-0'].threadId, 'crash-title-session');
  assert.equal(request.status, mode === 'receipt' ? 'completed' : 'interrupted');
  assert.equal(state.tasks[0].title, mode === 'receipt' ? 'Recovered title' : 'Crash test task');
});
