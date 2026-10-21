import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { taskSearchInput } from '../src/task-search.js';
import { taskHistoryEpoch } from '../src/task-history.js';
import type { ChatMessage, Executor, TaskEvent, TaskGitOperation, TaskRewindOperation, TaskRun, WorkItem } from '../src/types.js';

const at = (n: number) => new Date(Date.UTC(2026, 9, 18) + n * 1000).toISOString();
class NoWork implements Executor { async run(): Promise<string> { throw new Error('Search must never start an agent'); } async answer() {} async steer() {} }
async function setup(t: { after: (callback: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-task-search-'))); const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  let engine = await new Engine(directory, new NoWork()).open();
  await engine.mutate(state => { state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }); });
  const auth = new Auth(directory);
  t.after(async () => { await engine.close(); auth.close(); await rm(base, { recursive: true, force: true }); });
  const add = async (id: string, messages: ChatMessage[] = [], overrides: Partial<WorkItem> = {}) => {
    const task: WorkItem = { id, title: id, prompt: '', projectId: 'project', cwd, agent: 'codex', mode: 'research', status: 'completed', createdAt: at(0), updatedAt: at(20),
      durableId: null, threadId: 'native', turnId: null, result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: id,
      messages, eventArchive: { count: 0, version: 0, coverage: 'complete', recent: [] }, ...overrides };
    await engine.mutate(state => { state.tasks.push(task); }); return task;
  };
  return { get engine() { return engine; }, directory, auth, cwd, add,
    app: () => createAPI(engine, auth, () => []), headers: { Authorization: 'Bearer ' + auth.token },
    search: (query: string, limit = 50) => engine.taskSearch.search(taskSearchInput(query, limit)),
    async reopen() { await engine.close(); engine = await new Engine(directory, new NoWork()).open(); } };
}
const message = (id: string, role: 'user' | 'assistant', text: string, when = 1): ChatMessage => ({ id, role, text, at: at(when) });

test('Search returns one completed public message per visible task, preferring the newest user match and excluding tools, streaming and removed workspaces', async t => {
  const f = await setup(t);
  await f.add('both', [message('answer', 'assistant', 'needle in answer', 5), message('older', 'user', 'older needle', 1), message('newer', 'user', 'newer NEEDLE', 4)]);
  await f.add('assistant', [message('a', 'assistant', 'needle in the answer')], { updatedAt: at(50) });
  for (const overrides of [{ archivedAt: at(10) }, { projectId: 'removed' }, { agent: 'friday' }]) await f.add('hidden-' + Object.keys(overrides)[0], [message('hidden', 'user', 'needle hidden')], overrides);
  await f.add('streaming', [], { status: 'running', events: [{ id: 'stream', kind: 'message', text: 'needle still streaming', at: at(2), status: 'running' },
    { id: 'tool', kind: 'tool', text: 'needle tool', detail: 'needle private tool output', at: at(3) }, { id: 'reasoning', kind: 'reasoning', text: 'needle summary', at: at(4) }] });
  const result = await f.search('NEEDLE');
  assert.deepEqual(result.matches.map(match => [match.taskId, match.source, match.snippet]), [['both', 'user', 'newer NEEDLE'], ['assistant', 'assistant', 'needle in the answer']]);
  assert.equal((await f.search('needle', 1)).matches[0].taskId, 'both');
  const own = (await f.engine.snapshot()).tasks.find(task => task.id === 'both')!; assert.equal(result.matches[0].epoch, taskHistoryEpoch(own));
  const app = f.app(); const response = await app.request('/api/tasks/search?query=needle', { headers: f.headers }); assert.equal(response.status, 200);
  const data = await response.json(); assert.equal(data.sessionId, f.engine.streamSession); assert.equal(data.query, 'needle'); assert.equal(data.matches.length, 2);
  assert.ok(!JSON.stringify(data).includes('private tool'));
});

test('Literal patterns, ASCII case folding, response limits and UTF-16-safe 240-character snippets match T3 search semantics', async t => {
  const f = await setup(t);
  await f.add('literal', [message('literal', 'user', "needle 100% a_b !c \\d 'quotes' 中文内容", 3)]);
  assert.equal((await f.search('100%')).matches.length, 1); assert.equal((await f.search('a_b')).matches.length, 1);
  assert.equal((await f.search('!c')).matches.length, 1); assert.equal((await f.search('ne%le')).matches.length, 0);
  assert.equal((await f.search("needle' OR 1=1 --")).matches.length, 0); assert.equal((await f.search('中文')).matches.length, 1);
  await f.add('unicode-case', [message('u', 'user', 'ÜPPER CASE')]); assert.equal((await f.search('üpper')).matches.length, 0); assert.equal((await f.search('case')).matches.length, 1);
  await f.add('long', [message('long', 'assistant', '🚀'.repeat(300) + '\n\tneedle in the middle\n' + '🌏'.repeat(300))]);
  const snippet = (await f.search('middle')).matches[0].snippet;
  assert.ok(snippet.length <= 240 && snippet.includes('needle in the middle') && !snippet.includes('\n'));
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…')); assert.ok(!snippet.includes('\uFFFD'));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(snippet));
  for (let index = 0; index < 55; index++) await f.add('limit-' + String(index).padStart(2, '0'), [message('limit', 'user', 'bounded result')]);
  const limited = await f.search('bounded'); assert.equal(limited.matches.length, 50); assert.equal(limited.matches[0].taskId, 'limit-00');
});

test('Cold public assistant messages remain searchable across compaction, late updates and restart without indexing command output', async t => {
  const f = await setup(t); await f.add('cold');
  const events: TaskEvent[] = [{ id: 'public', kind: 'message', phase: 'commentary', text: 'needle in a cold public message', at: at(1), status: 'completed' },
    ...Array.from({ length: 820 }, (_, index): TaskEvent => ({ id: 'tool-' + index, kind: 'command', text: 'Inspect', detail: 'needle only in command output', at: at(index + 2), status: 'completed' }))];
  await f.engine.patchTask('cold', task => { task.events.push(...events); });
  assert.ok(!(await f.engine.snapshot()).tasks[0].events.some(event => event.id === 'public'));
  assert.equal((await f.search('cold public')).matches[0].taskId, 'cold'); assert.equal((await f.search('command output')).matches.length, 0);
  const original = (await f.engine.taskHistory.eventItems('cold', ['public'])).events[0];
  await f.engine.patchTask('cold', task => { task.events.push({ ...original, text: 'replacement public answer' }); }, ['public']);
  assert.equal((await f.search('cold public')).matches.length, 0); assert.equal((await f.search('replacement')).matches.length, 1);
  await f.reopen(); assert.equal((await f.search('replacement')).matches[0].snippet, 'replacement public answer');
});

test('Search applies rewind projections to cold events, excludes reverted answers and retains explicitly kept inputs', async t => {
  const f = await setup(t);
  const run: TaskRun = { id: 'run', durableId: null, messageId: 'input', requestId: 'input', cwd: f.cwd, at: at(1), status: 'completed', mode: 'research', interactionMode: 'default', turnId: 'turn' };
  await f.add('projection', [{ ...message('input', 'user', 'kept needle request'), runId: 'run' }, { ...message('answer', 'assistant', 'removed needle answer', 8), runId: 'run' }], { runs: [run] });
  await f.engine.patchTask('projection', task => { task.events.push({ id: 'old-output', kind: 'message', text: 'retired public marker', at: at(3), runId: 'run', turnId: 'turn', status: 'completed' },
    ...Array.from({ length: 650 }, (_, index): TaskEvent => ({ id: 'note-' + index, kind: 'note', text: 'internal', at: at(index + 5) }))); });
  assert.equal((await f.search('public marker')).matches.length, 1);
  await f.engine.patchTask('projection', task => {
    task.runs![0].executionExcludedAt = at(30);
    task.rewindOperations = [{ id: 'rewind', durableId: 0, requestId: 'rewind', runId: 'run', projectedAt: at(30), messageId: 'input', removedRunIds: [], removedExecutionRunIds: ['run'], removeTurns: ['turn'], keepTurns: [],
      status: 'completed', phase: 'completed', restoreFiles: false, cwd: f.cwd, fingerprint: 'fixture', createdAt: at(30), updatedAt: at(30),
      sourceThreadId: 'native', sourceTurnId: 'turn', targetTurnId: null, editor: { text: 'kept needle request', images: [], interactionMode: 'default' }, attempt: 1 }];
  });
  assert.equal((await f.search('removed needle')).matches.length, 0); assert.equal((await f.search('public marker')).matches.length, 0);
  assert.equal((await f.search('kept needle')).matches[0].source, 'user');
});

test('A read worker searches committed data while a writer is held, keeps the main loop responsive and does not advance Durable state', async t => {
  const f = await setup(t); await f.add('reader', [message('reader', 'user', 'x'.repeat(8 * 1024 * 1024) + ' reader needle')]);
  const writer = new DatabaseSync(join(f.directory, 'friday.sqlite'));
  const before = writer.prepare('SELECT next_seq FROM durable_metadata').get()!.next_seq;
  let ticks = 0; const timer = setInterval(() => ticks++, 5); writer.exec('BEGIN IMMEDIATE');
  try {
    const result = await f.search('reader needle'); assert.equal(result.matches[0].taskId, 'reader'); assert.ok(ticks > 0);
    assert.equal(writer.prepare('SELECT next_seq FROM durable_metadata').get()!.next_seq, before);
  } finally { clearInterval(timer); writer.exec('ROLLBACK'); writer.close(); }
});

test('API authenticates, validates bounds, hides newly archived results and rechecks revoked viewers before returning snippets', async t => {
  const f = await setup(t); await f.add('scope', [message('scope', 'user', 'scope needle')]); const app = f.app();
  assert.equal((await app.request('/api/tasks/search?query=needle')).status, 401);
  for (const query of ['', 'x', 'x'.repeat(201)]) assert.equal((await app.request('/api/tasks/search?query=' + encodeURIComponent(query), { headers: f.headers })).status, 400);
  for (const limit of ['0', '51', '1.5', 'bad', '']) assert.equal((await app.request('/api/tasks/search?query=needle&limit=' + limit, { headers: f.headers })).status, 400);
  const original = f.engine.taskSearch.search.bind(f.engine.taskSearch);
  f.engine.taskSearch.search = async (...args) => { const result = await original(...args); await f.engine.updateTaskMetadata('scope', { archived: true }); return result; };
  const hidden = await (await app.request('/api/tasks/search?query=needle', { headers: f.headers })).json(); assert.deepEqual(hidden.matches, []);
  await f.engine.updateTaskMetadata('scope', { archived: false });
  const pair = f.auth.createPairing(); const device = f.auth.pair(pair.code, 'Search viewer', 'test');
  f.engine.taskSearch.search = async (...args) => { const result = await original(...args); f.auth.revoke(device.id); return result; };
  assert.equal((await app.request('/api/tasks/search?query=needle', { headers: { Authorization: 'Bearer ' + device.token } })).status, 401);
});

test('Reader schema failures expose a bounded unavailable response and worker shutdown rejects later queries', async t => {
  const f = await setup(t); await f.add('schema', [message('schema', 'user', 'schema needle')]); const app = f.app();
  const db = new DatabaseSync(join(f.directory, 'friday.sqlite')); db.exec('UPDATE durable_schema SET version=2 WHERE singleton=1');
  try {
    const response = await app.request('/api/tasks/search?query=needle', { headers: f.headers }); assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(f.directory));
  } finally { db.exec('UPDATE durable_schema SET version=1 WHERE singleton=1'); db.close(); }
  assert.equal((await f.search('needle')).matches.length, 1);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.engine.taskSearch.search(taskSearchInput('needle'), controller.signal));
  await f.engine.taskSearch.close(); await assert.rejects(f.search('needle'));
});

test('PR metadata remains visible in compact overviews after later Git operations and is not persisted into the workspace', async t => {
  const f = await setup(t); const pr = { number: 42, title: 'Needle PR title', url: 'https://github.com/example/project/pull/42', state: 'open' as const, base: 'main', head: 'feature' };
  const operation = (id: string, withPR: boolean): TaskGitOperation => ({ id, durableId: 0, action: withPR ? 'create_pr' : 'push', status: 'completed', cwd: f.cwd, root: f.cwd,
    createdAt: at(2), updatedAt: at(2), phase: 'completed', steps: [], files: [], branch: 'feature', head: 'commit', contentFingerprint: 'fingerprint', ...(withPR ? { pullRequest: pr } : {}) });
  await f.add('pr', [], { gitOperation: operation('later', false), gitOperations: [operation('first', true), operation('duplicate', true)] });
  const overview = await (await f.app().request('/api/overview', { headers: f.headers })).json(); assert.deepEqual(overview.tasks[0].pullRequests, [pr]);
  const { WorkspaceDoc } = await import('../src/state.js'); const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context');
  assert.equal((await f.engine.harness.snapshot(WorkspaceDoc, BACKGROUND_CONTEXT))!.tasks[0].pullRequests, undefined);
});
