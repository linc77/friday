import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { workspaceCommand } from '../src/git-process.js';
import { decodeStack, stackSubmission, affectedStack } from '../src/task-change-request-stack-data.js';
import type { SourceControlConnectionOptions } from '../src/source-control-connections.js';
import type { StackActionSubmission } from '../src/task-change-request-stack-types.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function until<T>(read: () => Promise<T>, accept: (v: T) => boolean) { const end = Date.now() + 15000; while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(r => setTimeout(r, 15)); } throw Error('Stack fixture timed out'); }
async function setup(t: { after(fn: () => Promise<unknown>): void }, conflict = false) {
  const dir = await mkdtemp(join(tmpdir(), 'friday-stack-')), cwd = join(dir, 'repo'), bare = join(dir, 'remote.git'), data = join(dir, 'data'); await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.test');
  await writeFile(join(cwd, 'a'), 'a0\n'); await writeFile(join(cwd, 'b'), 'b0\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base');
  git(cwd, 'checkout', '-qb', 'linc/lower'); await writeFile(join(cwd, 'a'), 'a1\n'); git(cwd, 'commit', '-qam', 'lower');
  git(cwd, 'checkout', '-qb', 'linc/upper'); await writeFile(join(cwd, 'b'), 'b1\n'); git(cwd, 'commit', '-qam', 'upper');
  git(cwd, 'checkout', '-q', 'main'); await writeFile(join(cwd, conflict ? 'b' : 'c'), conflict ? 'b2\n' : 'base advanced\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'advance base'); git(cwd, 'checkout', '-q', 'linc/upper');
  git(dir, 'clone', '-q', '--bare', cwd, bare); await writeFile(join(cwd, 'a'), 'USER DIRTY\n');
  const url = 'https://github.com/fixture/project/pull/18', canonical = 'https://github.com/fixture/project.git';
  const state = { requests: [] as { path: string; method: string; body?: any }[], pushes: [] as string[][], config: [] as Record<string, string | undefined>[], failStack: 0, branchAccess: true, repoWrite: true, holdPush: false, beforePush: undefined as (() => void) | undefined, unknownPush: false, unknownMerge: false, pendingMerge: false, holdPoll: false, draft: false, closed: false, missingHead: false, mergePolls: 0 };
  const heads = () => [17, 18].map((number, i) => ({ number, headSha: git(bare, 'rev-parse', 'refs/heads/linc/' + (i ? 'upper' : 'lower')) }));
  const stack = () => ({ id: 7, number: 50, url: 'https://api.github.com/repos/fixture/project/stacks/50', html_url: 'https://github.com/fixture/project/stacks/50', base: { ref: 'main' }, pull_requests: heads().map((h, i) => ({ number: h.number, title: i ? 'Upper' : 'Lower', draft: state.draft && i === 0, state: state.closed && i === 0 ? 'closed' : 'open', head: { ref: i ? 'linc/upper' : 'linc/lower', ...(state.missingHead && i === 0 ? {} : { sha: h.headSha }) } })) });
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: 0, environment: { GH_TOKEN: 'synthetic-stack-token' }, command: () => null,
    execute: async (directory, command, args, opt = {}) => {
      assert.equal(command, 'git'); if (args.includes('push')) { state.pushes.push(args); state.beforePush?.(); if (state.holdPush) return new Promise((_resolve, reject) => opt.signal?.addEventListener('abort', () => reject(Error('Fixture stopped')), { once: true })); }
      state.config.push(opt.env ?? {}); const result = await workspaceCommand(directory, command, args.map(a => a === canonical ? bare : a), opt);
      if (args.includes('push') && state.unknownPush) throw Error('Lost push response'); return result;
    }, request: async (input, init) => {
      const address = new URL(String(input)); assert.equal(address.host, 'api.github.com'); const path = address.pathname.slice(1) + address.search, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined; state.requests.push({ path, method, body });
      if (path === 'graphql') {
        if (body.query.includes('FridayStackBranchAccess')) return Response.json({ data: { repository: { l0: { headRepository: { viewerPermission: state.branchAccess ? 'WRITE' : 'READ' }, maintainerCanModify: false }, l1: { headRepository: { viewerPermission: 'WRITE' } } } } });
        return Response.json({ data: { viewer: { login: 'reviewer' }, repository: { viewerPermission: state.repoWrite ? 'WRITE' : 'READ', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: { id: 'node-' + body.variables.number, viewerCanUpdate: true, viewerCanUpdateBranch: false, headRefOid: heads().find(h => h.number === body.variables.number)?.headSha, headRepository: { viewerPermission: 'WRITE' } } } } });
      }
      if (path.includes('/stacks')) { if (state.failStack) return new Response('{}', { status: state.failStack }); return Response.json(path.includes('?') ? [stack()] : stack()); }
      if (path.includes('/merge-async')) {
        if (method === 'PUT') { if (state.unknownMerge) throw Error('Lost merge response'); return Response.json({ status: state.pendingMerge ? 'pending' : 'enqueued', details: state.pendingMerge ? { uuid: 'fixed/merge receipt' } : {} }); }
        state.mergePolls++; if (state.holdPoll) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('Stopped poll')), { once: true }));
        return Response.json({ status: 'merged', details: {} });
      }
      const number = Number(path.split('/').at(-1)), head = heads().find(h => h.number === number);
      if (!head) throw Error('Unexpected synthetic API path');
      return Response.json({ number, html_url: url.replace('/18', '/' + number), title: 'Fixture ' + number, state: 'open', head: { sha: head.headSha, ref: number === 17 ? 'linc/lower' : 'linc/upper' }, base: { ref: 'main' }, user: { login: 'author' } });
    } };
  const executor = { async run() { return 'Fixture completed'; }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, options).open(); await engine.mutate(s => s.projects.push({ id: 'p', name: 'Fixture', path: cwd, context: '' }));
  const id = await engine.createTask({ prompt: 'Fixture', projectId: 'p', agent: 'codex', mode: 'code', requestId: 'task' }); await until(() => engine.snapshot(), s => s.tasks[0]?.status === 'completed');
  await engine.mutate(s => { s.tasks[0].changeRequests = [{ number: 18, title: 'Upper', url, base: 'main', head: 'linc/upper', state: 'open', provider: 'github', host: 'github.com', repository: 'fixture/project' }]; });
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  return { get engine() { return engine; }, dir, cwd, bare, data, id, url, state, heads, stack,
    input: (action: StackActionSubmission['action'] = 'update-branch', requestId = 'stack'): StackActionSubmission => ({ url, requestId, action, stackNumber: 50, targetNumber: 18, expectedStackHeads: heads(), ...(action === 'merge' ? { mergeMethod: 'squash' } : { updateMethod: 'rebase' }) }),
    finish: async (operationId: string) => (await until(() => engine.snapshot(), s => { const op = s.tasks[0]?.changeRequestOperations?.find(o => o.id === operationId); return !!op && !['queued', 'running'].includes(op.status); })).tasks[0].changeRequestOperations!.find(o => o.id === operationId)!,
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, options).open(); },
    resumeAfterCrash: async () => { engine = await new Engine(data, executor, undefined, options).open(); } };
}

test('Native stack decoding keeps order, merged precedence and missing heads; only an exact reviewed affected set can act', () => {
  const raw = [{ number: 50, url: 'https://api.github.com/repos/a/b/stacks/50', base: 'main', pull_requests: [{ number: 1, state: 'closed', merged_at: 'now', head: { ref: 'one', sha: 'a'.repeat(40) } }, { number: 2, state: 'open', head: { ref: 'two' } }] }];
  const value = decodeStack(raw)!; assert.deepEqual(value.layers.map(l => l.state), ['merged', 'open']); assert.equal(value.id, '50'); assert.equal(decodeStack([]), null);
  assert.throws(() => affectedStack(value, { requestId: 'x', url: 'x', action: 'merge', stackNumber: 50, targetNumber: 2, expectedStackHeads: [{ number: 2, headSha: 'b'.repeat(40) }] }), /代码版本/);
  assert.equal(decodeStack([{...raw[0],pull_requests:[{number:2,head:{ref:'two',sha:'abc123'}}]}])?.layers[0].headSha,'abc123');
  assert.throws(() => stackSubmission({ requestId: '__proto__' }), /格式无效/); assert.throws(() => decodeStack([{}]), /数据无效/);
});
test('Stack navigation is host-authorized and saved metadata has no action heads; only 404 means unstacked', async t => {
  const f = await setup(t), first = await f.engine.changeRequestStacks.get(f.id, f.url); assert.equal(first.stack?.layers.length, 2);
  const saved = (await f.engine.snapshot()).tasks[0].changeRequestStacks![f.url]!; assert(!JSON.stringify(saved).includes(f.heads()[0].headSha));
  await assert.rejects(f.engine.changeRequestStacks.open(f.id, { url: f.url, stackNumber: 50, number: 999 }), /成员已改变/);
  assert.equal((await f.engine.changeRequestStacks.open(f.id, { url: f.url, stackNumber: 50, number: 17 })).url, f.url.replace('/18', '/17'));
  f.state.failStack = 503; await assert.rejects(f.engine.changeRequestStacks.get(f.id, f.url)); assert.equal((await f.engine.snapshot()).tasks[0].changeRequestStacks![f.url]?.number, 50);
  f.state.failStack = 404; assert.equal((await f.engine.changeRequestStacks.get(f.id, f.url)).stack, null); assert.equal((await f.engine.snapshot()).tasks[0].changeRequestStacks![f.url], null);
});
test('Cascade rebase moves only each layer’s own commits, leaves the dirty checkout alone and leases every push', async t => {
  const f = await setup(t), input = f.input(), old = f.heads(); const id = await f.engine.changeRequestStacks.start(f.id, input), result = await f.finish(id); assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.completedEffects, ['layer-17', 'layer-18']); const updated = f.heads(); assert.notEqual(updated[0].headSha, old[0].headSha); assert.notEqual(updated[1].headSha, old[1].headSha);
  assert.equal(git(f.bare, 'rev-list', '--count', 'refs/heads/main..refs/heads/linc/upper'), '2'); assert.equal(git(f.bare, 'merge-base', 'refs/heads/linc/lower', 'refs/heads/linc/upper'), updated[0].headSha);
  assert.equal(await readFile(join(f.cwd, 'a'), 'utf8'), 'USER DIRTY\n'); assert(f.state.pushes.every((args, i) => args.includes('--force-with-lease=refs/heads/linc/' + (i ? 'upper:' : 'lower:') + old[i].headSha)));
  assert.deepEqual(await readdir(join(f.data, 'stack-checkouts')), []); assert(!JSON.stringify(await f.engine.snapshot()).includes('synthetic-stack-token'));
  assert(f.state.config.some(env => Object.values(env).some(v => v?.startsWith('AUTHORIZATION: basic ')))); assert(f.state.pushes.every(args => !args.some(a => a.includes('synthetic-stack-token'))));
  await f.reopen(); assert.equal(await f.engine.changeRequestStacks.start(f.id, input), id); assert.equal(f.state.pushes.length, 2);
});
test('A higher-layer conflict keeps lower pushes, names the failed layer and cleans the private checkout', async t => {
  const f = await setup(t, true), old = f.heads(), id = await f.engine.changeRequestStacks.start(f.id, f.input()), result = await f.finish(id);
  assert.equal(result.status, 'failed'); assert.match(result.error!, /#18.*已完成 1 层/); assert.deepEqual(result.completedEffects, ['layer-17']); assert.notEqual(f.heads()[0].headSha, old[0].headSha); assert.equal(f.heads()[1].headSha, old[1].headSha); assert.deepEqual(await readdir(join(f.data, 'stack-checkouts')), []);
});
test('Unknown push results are never replayed, even when the remote applied the first layer', async t => {
  const f = await setup(t); f.state.unknownPush = true; const input = f.input(), id = await f.engine.changeRequestStacks.start(f.id, input), result = await f.finish(id);
  assert.equal(result.status, 'interrupted'); assert.equal(f.state.pushes.length, 1); await f.reopen(); assert.equal(await f.engine.changeRequestStacks.start(f.id, input), id); assert.equal(f.state.pushes.length, 1);
});
test('Merge through a selected layer uses one native async request and a fixed head; pending receipts poll read-only', async t => {
  const f = await setup(t); await f.engine.mutate(s => { s.sourceControlPreferences = { version: 1, defaults: { removeAgentCreditsOnMerge: true }, projects: {} }; }); f.state.pendingMerge = true; const input = f.input('merge'), id = await f.engine.changeRequestStacks.start(f.id, input), result = await f.finish(id);
  assert.equal(result.status, 'completed', result.error); const writes = f.state.requests.filter(r => r.path.includes('merge-async') && r.method === 'PUT'); assert.equal(writes.length, 1); assert.deepEqual(writes[0].body, { merge_method: 'squash', merge_action: 'default', sha: input.expectedStackHeads[1].headSha }); assert.equal(f.state.mergePolls, 1); assert(f.state.requests.some(r => r.path.endsWith('/fixed%2Fmerge%20receipt')));
  assert(!f.state.requests.some(r => String(r.body?.query).includes('viewerMergeBodyText')), 'Stack merges keep the platform message even when regular merges remove credits');
  await f.reopen(); assert.equal(await f.engine.changeRequestStacks.start(f.id, input), id);
});
test('Unknown merge responses are never resent; malformed, stale, closed, draft and unwritable stacks send no mutation', async t => {
  const f = await setup(t); const good = f.input(); await assert.rejects(f.engine.changeRequestStacks.start(f.id, { ...good, expectedStackHeads: [{ number: 18, headSha: 'a'.repeat(40) }] }), /版本/);
  f.state.draft = true; await assert.rejects(f.engine.changeRequestStacks.start(f.id, f.input('merge')), /草稿/); f.state.draft = false; f.state.closed = true; await assert.rejects(f.engine.changeRequestStacks.start(f.id, good), /开放/); f.state.closed = false;
  f.state.branchAccess = false; await assert.rejects(f.engine.changeRequestStacks.start(f.id, good), /权限/); f.state.branchAccess = true; f.state.repoWrite = false; await assert.rejects(f.engine.changeRequestStacks.start(f.id, good), /账号/); f.state.repoWrite = true;
  assert.equal(f.state.requests.filter(r => r.path.includes('merge-async')).length, 0); assert.equal(f.state.pushes.length, 0);
  f.state.unknownMerge = true; const input = f.input('merge'), id = await f.engine.changeRequestStacks.start(f.id, input); assert.equal((await f.finish(id)).status, 'interrupted'); await f.reopen(); assert.equal(await f.engine.changeRequestStacks.start(f.id, input), id); assert.equal(f.state.requests.filter(r => r.path.includes('merge-async') && r.method === 'PUT').length, 1);
});
test('Stack operations lock every member against single-PR writes, and deleting their task stops and cleans owned work', async t => {
  const f = await setup(t); await f.engine.changeRequestStacks.open(f.id, { url: f.url, stackNumber: 50, number: 17 }); f.state.holdPush = true; await f.engine.changeRequestStacks.start(f.id, f.input()); await until(async () => f.state.pushes.length, n => n === 1);
  await assert.rejects(f.engine.changeRequests.start(f.id, { url: f.url.replace('/18', '/17'), requestId: 'comment', action: 'comment', body: 'Blocked' }), /正在发送/);
  await f.engine.deleteTask(f.id); assert.equal((await f.engine.snapshot()).tasks.length, 0); assert.deepEqual(await readdir(join(f.data, 'stack-checkouts')), []);
});
test('Stack endpoints authenticate, reject missing tasks and refuse client-selected foreign members before any write', async t => {
  const f = await setup(t), auth = new Auth(f.data), app = createAPI(f.engine, auth); t.after(async () => auth.close()); const path = '/api/tasks/' + f.id + '/change-request/stack';
  assert.equal((await app.request(path + '?' + new URLSearchParams({ url: f.url }))).status, 401);
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }; assert.equal((await app.request('/api/tasks/missing/change-request/stack?' + new URLSearchParams({ url: f.url }), { headers })).status, 400);
  assert.equal((await app.request(path + '/open', { method: 'POST', headers, body: JSON.stringify({ url: f.url, number: 999, stackNumber: 50 }) })).status, 400); assert.equal(f.state.pushes.length, 0);
});


test('A concurrent source update wins against the captured force-with-lease; it is never overwritten', async t => {
  const f = await setup(t), old = f.heads();
  f.state.beforePush = () => { f.state.beforePush = undefined; git(f.bare, 'update-ref', 'refs/heads/linc/lower', old[1].headSha); };
  const id = await f.engine.changeRequestStacks.start(f.id, f.input()), result = await f.finish(id);
  assert.equal(result.status, 'interrupted'); assert.equal(f.heads()[0].headSha, old[1].headSha); assert.equal(f.state.pushes.length, 1);
});

test('Merge scope ends at the selected layer rather than silently including the layers above', async t => {
  const f = await setup(t), input = { ...f.input('merge'), targetNumber: 17, expectedStackHeads: [f.heads()[0]] };
  const id = await f.engine.changeRequestStacks.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed');
  const request = f.state.requests.find(r => r.method === 'PUT' && r.path.includes('merge-async'))!;
  assert.equal(request.path, 'repos/fixture/project/pulls/17/merge-async'); assert.equal(request.body.sha, input.expectedStackHeads[0].headSha);
});

test('A real process death after a known async merge UUID resumes only polling and never repeats the merge request', async t => {
  const f = await setup(t), marker = join(f.dir, 'merge-crash'); await f.engine.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/stack-merge-crash.ts', import.meta.url)), f.data, f.id, f.url, JSON.stringify(f.stack()), marker], { stdio: 'ignore', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8' } });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; } });
  await until(async () => ({ log: await readFile(marker, 'utf8').catch(() => ''), run: await readFile(marker + '.run', 'utf8').catch(() => '') }), v => v.log.includes('poll') && /^[\w-]{36}$/.test(v.run.trim()));
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended; await f.resumeAfterCrash();
  const id = (await readFile(marker + '.run', 'utf8')).trim(); assert.equal((await f.finish(id)).status, 'completed');
  assert.equal(f.state.requests.filter(r => r.method === 'PUT' && r.path.includes('merge-async')).length, 0); assert.equal(f.state.mergePolls, 1); assert.deepEqual((await readFile(marker, 'utf8')).trim().split('\n'), ['put', 'poll']);
});
