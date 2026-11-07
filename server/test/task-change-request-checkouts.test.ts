import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { workspaceCommand } from '../src/git-process.js';
import { checkoutReference, resolveCheckout, checkoutGitPlan, inspectCheckout } from '../src/task-change-request-checkout-git.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { SourceControlConnectionOptions } from '../src/source-control-connections.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import type { ExecutionRequest, WorkItem } from '../src/types.js';
// Script fixtures use POSIX syntax regardless of the developer's login shell.
process.env.SHELL = '/bin/sh';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean) { const end = Date.now() + 20000; while (Date.now() < end) { const value = await read(); if (ready(value)) return value; await new Promise(r => setTimeout(r, 20)); } throw Error('Checkout fixture timed out'); }
async function fixture(t: { after(fn: () => Promise<unknown>): void }, provider: 'github' | 'gitlab' | 'bitbucket' = 'github', customHost?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'friday-pr-checkout-')), cwd = join(dir, 'repo'), data = join(dir, 'data'), baseBare = join(dir, 'base.git'), forkBare = join(dir, 'fork.git'); await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.test'); await writeFile(join(cwd, 'file'), 'base\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); const base = git(cwd, 'rev-parse', 'HEAD'); git(dir, 'clone', '-q', '--bare', cwd, baseBare);
  await writeFile(join(cwd, 'file'), 'fork\n'); git(cwd, 'commit', '-qam', 'fork'); const head = git(cwd, 'rev-parse', 'HEAD'); git(dir, 'clone', '-q', '--bare', cwd, forkBare); git(cwd, 'reset', '--hard', base);
  const host = customHost ?? (provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org');
  const repository = 'upstream/project', source = 'contributor/project', targetURL = `https://${host}/${repository}.git`, sourceURL = `https://${host}/${source}.git`, url = `https://${host}/${repository}/${provider === 'github' ? 'pull' : provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/17`;
  for (const [address, bare] of [[targetURL, baseBare], [sourceURL, forkBare]]) git(cwd, 'config', `url.file://${bare}.insteadOf`, address);
  git(cwd, 'remote', 'add', 'origin', targetURL); git(cwd, 'fetch', '-q', 'origin'); git(cwd, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(baseBare, 'fetch', '-q', forkBare, 'main');
  git(baseBare, 'update-ref', provider === 'gitlab' ? 'refs/merge-requests/17/head' : 'refs/pull/17/head', head); // both bare clones share the original objects
  const state = { sha: head, source: source as string | null, fetches: 0, hold: false, forceFetchFailure: false, requests: [] as ExecutionRequest[], onGit: undefined as (() => Promise<void>) | undefined };
  const environment: NodeJS.ProcessEnv = provider === 'github' ? { GH_TOKEN: 'synthetic-checkout-token' } : provider === 'bitbucket' ? { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-checkout-token' } : {};
  const item = () => provider === 'github' ? { number: 17, title: 'Fork change', html_url: url, state: 'open', head: { ref: 'main', sha: state.sha, user: { login: 'contributor' }, repo: state.source ? { full_name: state.source, owner: { login: 'contributor' } } : null }, base: { ref: 'main' } }
    : provider === 'gitlab' ? { iid: 17, title: 'Fork change', web_url: url, state: 'opened', source_branch: 'main', target_branch: 'main', source_project_id: state.source ? 11 : null, target_project_id: 22, sha: state.sha }
    : { id: 17, title: 'Fork change', links: { html: { href: url } }, state: 'OPEN', source: { branch: { name: 'main' }, commit: { hash: state.sha }, repository: { full_name: state.source } }, destination: { branch: { name: 'main' } } };
  const respond = (path: string) => path === 'user' ? { username: 'fixture', id: 11 } : /\/(pulls|merge_requests|pullrequests)\/17$/.test(path) ? item() : path === 'projects/11' ? { path_with_namespace: source } : provider === 'bitbucket' ? { mainbranch: { name: 'main' } } : { default_branch: 'main' };
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: 0, environment, command: name => provider === 'gitlab' && name === 'glab' ? '/synthetic/glab' : null,
    request: async (input, init) => { const address = new URL(String(input)); assert(['api.github.com', 'api.bitbucket.org'].includes(address.host)); assert.equal(init?.method, 'GET'); return Response.json(respond(address.pathname.replace(/^\/(?:2\.0\/)?/, ''))); },
    execute: async (path, command, args, options) => {
      if (command === 'git') {
        if (args.includes('fetch')) { state.fetches++; await state.onGit?.(); if (state.forceFetchFailure && args.includes(sourceURL)) return { stdout: '', stderr: '', code: 1, digest: '' }; if (state.hold) await new Promise<void>((_, reject) => options?.signal?.addEventListener('abort', () => reject(Error('synthetic interruption')), { once: true })); }
        return workspaceCommand(path, command, args, options);
      }
      const apiPath = args.find(v => v === 'user' || v.startsWith('projects/'))!; return { stdout: JSON.stringify(respond(apiPath)), stderr: '', code: 0, digest: '' };
    } };
  const executor = { async run(r: ExecutionRequest) { state.requests.push(r); return 'done'; }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, options).open(); if (customHost) await engine.sourceControl.credentials!.update({ version: 0, requestId: 'self-managed', gitlabHost: { host: customHost, enabled: true } }); await engine.mutate(s => s.projects.push({ id: 'p', name: 'Fixture', path: cwd, context: '' }));
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const preview = () => engine.changeRequestCheckouts.resolve('p', { reference: '#17' });
  const input = async (mode: 'checkout' | 'worktree' = 'worktree', extra: Record<string, unknown> = {}) => { const value = await preview(); return { requestId: 'prepare', reference: '#17', mode, fingerprint: value.fingerprint, localFingerprint: value.localFingerprint, ...extra }; };
  const finish = (id: string) => until(() => engine.changeRequestCheckouts.get('p', id), p => !['queued', 'running'].includes(p.status));
  return { get engine() { return engine; }, cwd, data, dir, base, head, url, baseBare, forkBare, state, environment, preview, input, finish,
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, options).open(); } };
}

test('Checkout reference parser accepts URLs/numbers/CLI text as data and rejects shell/foreign-host input', () => {
  const repository = sourceControlRepository('https://github.com/upstream/project.git')!;
  for (const text of ['17', '#17', 'gh pr checkout 17', 'https://github.com/other/repo/pull/17']) assert.equal(checkoutReference(text, repository).number, 17);
  for (const text of ['gh pr checkout 17; touch /tmp/file', '17 && true', '$(echo 17)', 'https://evil.test/u/r/pull/17', 'https://github.com@evil.test/u/r/pull/17', 'https://github.com/u/r/pull/17?x=1', '#0']) assert.throws(() => checkoutReference(text, repository));
});
test('PR Worktree setup runs before draft handoff, reuses the interactive terminal without fake tasks, and skips unchanged reuse and local checkout', async t => {
  const f = await fixture(t);
  await f.engine.mutate(s => { s.projects[0].scripts = [{ id: 'setup', name: 'Setup', command: 'printf setup >> setup-marker; printf "%s" "$T3CODE_WORKTREE_PATH" > setup-path', icon: 'configure', runOnWorktreeCreate: true, async: false }]; });
  const id = await f.engine.changeRequestCheckouts.start('p', await f.input()), prepared = await f.finish(id); assert.equal(prepared.status, 'ready', prepared.error); assert(prepared.setupRunId);
  assert.equal(await readFile(join(prepared.plan!.cwd, 'setup-marker'), 'utf8'), 'setup'); assert.equal(await readFile(join(prepared.plan!.cwd, 'setup-path'), 'utf8'), prepared.plan!.root);
  let state = await f.engine.snapshot(); assert.equal(state.tasks.length, 0); assert.equal(f.state.requests.length, 0); const run = state.projectScriptRuns![0]; assert.equal(run.status, 'completed'); assert.match(run.terminalOwner, /^script-/);
  const auth = new Auth(f.data); t.after(async () => auth.close()); const app = createAPI(f.engine, auth, () => []), terminalPath = `/api/tasks/${run.terminalOwner}/terminals/${run.terminalId}`;
  assert.equal((await app.request(terminalPath)).status, 401); assert.equal((await app.request(terminalPath, { headers: { Authorization: 'Bearer ' + auth.token } })).status, 200);
  const reused = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('worktree', { requestId: 'reuse-script' }))); assert.equal(reused.status, 'ready', reused.error); assert.equal(reused.plan?.scriptWorktree, true); assert.equal(reused.setupRunId, undefined); assert.equal((await f.engine.snapshot()).projectScriptRuns?.length, 1);
  const taskId = await f.engine.createTask({ prompt: 'fixture', projectId: 'p', agent: 'codex', mode: 'code', workspace: { mode: 'worktree', preparationId: id }, requestId: 'send-script-task' });
  await until(() => f.engine.snapshot(), s => s.tasks[0]?.status === 'completed'); state = await f.engine.snapshot(); assert.equal(state.projectScriptRuns?.length, 1); assert.equal(state.projectScriptRuns?.[0].taskId, taskId);
  await f.engine.deleteTask(taskId); assert.equal(f.engine.terminals.store.get(run.terminalOwner, run.terminalId), undefined);
  const local = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('checkout', { requestId: 'local-script' }))); assert.equal(local.status, 'ready', local.error); assert.equal(local.setupRunId, undefined); await assert.rejects(readFile(join(f.cwd, 'setup-marker')), /ENOENT/);
});
for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: local cross-Fork checkout preserves target main, tracks true Fork head and never starts an Agent`, async t => {
  const f = await fixture(t, provider); const preview = await f.preview(); assert.equal(preview.localBranch, provider === 'bitbucket' ? 'linc/pr-17/main' : 'contributor/main'); assert.equal(preview.worktreeBranch, 'linc/pr-17/main');
  const input = await f.input('checkout'), id = await f.engine.changeRequestCheckouts.start('p', input), result = await f.finish(id); assert.equal(result.status, 'ready', result.error); assert.equal(result.isOnHead, true);
  assert.equal(git(f.cwd, 'branch', '--show-current'), preview.localBranch); assert.equal(git(f.cwd, 'rev-parse', 'main'), f.base); assert.equal(git(f.cwd, 'rev-parse', '@{upstream}'), f.head); assert.equal(git(f.cwd, 'config', 'branch.' + preview.localBranch + '.merge'), 'refs/heads/main');
  assert.equal(f.state.requests.length, 0); assert.equal((await f.engine.snapshot()).tasks.length, 0); await f.reopen(); assert.equal(await f.engine.changeRequestCheckouts.start('p', input), id); assert(!JSON.stringify(await f.engine.snapshot()).includes('synthetic-checkout-token'));
});
test('Managed PR worktree leaves dirty main alone; draft contexts read its files and bind to the new task', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'file'), 'unsent main edits\n'); const id = await f.engine.changeRequestCheckouts.start('p', await f.input()); const prepared = await f.finish(id); assert.equal(prepared.status, 'ready', prepared.error); assert.equal(prepared.plan?.mode, 'worktree');
  assert.equal(await readFile(join(f.cwd, 'file'), 'utf8'), 'unsent main edits\n'); const scope = { projectId: 'p', preparationId: id }, owner = await f.engine.contexts.owner(scope); assert.equal(owner.cwd, prepared.plan?.cwd); assert.equal((await owner.files.read('file')).text, 'fork\n');
  const ref = await f.engine.contexts.capture({ id: 'prepared-file', scope, kind: 'file', path: 'file' });
  const taskId = await f.engine.createTask({ prompt: `[file](friday-context://v1/file/${ref.id})`, contextIds: [ref.id], projectId: 'p', agent: 'codex', mode: 'code', workspace: { mode: 'worktree', preparationId: id }, requestId: 'send' });
  await until(() => f.engine.snapshot(), s => s.tasks[0]?.status === 'completed'); const task = (await f.engine.snapshot()).tasks.find(v => v.id === taskId)!; assert.equal(task.cwd, prepared.plan?.cwd); assert.equal(task.changeRequests?.[0].url, f.url); assert.equal((await f.engine.contexts.read(ref.id, { taskId })).text, 'fork\n');
  await assert.rejects(f.engine.contexts.read(ref.id, { projectId: 'p' }), /不存在/); assert.equal(f.state.requests.length, 1); assert.equal(f.state.requests[0].task.cwd, prepared.plan?.cwd);
});
test('Existing PR worktrees preserve local commits and dirty files, then reuse the same directory honestly', async t => {
  const f = await fixture(t), first = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); const root = first.root;
  await writeFile(join(root, 'extra'), 'local\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'local'); const local = git(root, 'rev-parse', 'HEAD'); await writeFile(join(root, 'file'), 'dirty\n');
  const second = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('worktree', { requestId: 'reuse' })));
  assert.equal(second.status, 'ready', second.error); assert.equal(second.root, root); assert.equal(second.reused, true); assert.equal(second.isOnHead, false); assert.equal(git(root, 'rev-parse', 'HEAD'), local); assert.equal(await readFile(join(root, 'file'), 'utf8'), 'dirty\n');
});
test('Unrelated bare-name worktree is reused without mutation or tracking changes', async t => {
  const f = await fixture(t); git(f.cwd, 'branch', 'topic', f.base); const linked = join(f.dir, 'linked'); git(f.cwd, 'worktree', 'add', '-q', linked, 'topic');
  // T3 reuses the raw source branch only if it is checked out elsewhere.
  git(linked, 'branch', '-m', 'main-other'); git(f.cwd, 'branch', '-m', 'main', 'source-main'); git(linked, 'branch', '-m', 'main-other', 'main');
  const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(result.root, await realpath(linked)); assert.equal(result.branch, 'main'); assert.equal(result.isOnHead, false); assert.equal(result.plan?.mode, 'checkout'); assert.equal(f.state.fetches, 0); assert.equal(git(linked, 'rev-parse', 'HEAD'), f.base);
});
test('Dirty local confirmation and account/HEAD changes invalidate before mutations', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'file'), 'edits\n'); await assert.rejects(f.engine.changeRequestCheckouts.start('p', await f.input('checkout')), /未提交改动/);
  const input = await f.input('checkout', { force: true }); await writeFile(join(f.cwd, 'file'), 'new edits\n'); await assert.rejects(f.engine.changeRequestCheckouts.start('p', input), /已经改变/);
  const headInput = await f.input(); f.state.sha = f.base; await assert.rejects(f.engine.changeRequestCheckouts.start('p', headInput), /已经改变/); f.state.sha = f.head;
  const accountInput = await f.input(); f.environment.GH_TOKEN = 'synthetic-account-changed'; await assert.rejects(f.engine.changeRequestCheckouts.start('p', accountInput), /已经改变/); assert.equal(git(f.cwd, 'branch', '--show-current'), 'main'); assert.equal(f.state.fetches, 0);
});
test('Explicit local force replaces the selected branch and clears tracked dirty files only after confirmation', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'file'), 'dirty\n'); const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('checkout', { force: true }))); assert.equal(result.status, 'ready', result.error); assert.equal(git(f.cwd, 'rev-parse', 'HEAD'), f.head); assert.equal(await readFile(join(f.cwd, 'file'), 'utf8'), 'fork\n');
});
test('Deleted or inaccessible Fork falls back to the PR ref, never target main', async t => {
  const f = await fixture(t); f.state.source = null; const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(result.plan?.commit, f.head); assert.equal(git(result.root, 'rev-parse', 'HEAD'), f.head);
});
test('Inaccessible source branch falls back to the captured PR ref without using a wrong upstream', async t => {
  const f = await fixture(t); f.state.forceFetchFailure = true; const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(result.plan?.commit, f.head); assert.equal(f.state.fetches, 2);
});
test('Prepared branch association is checked at adoption; normal edits and commits are allowed', async t => {
  const f = await fixture(t); const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); await writeFile(join(result.root, 'new'), 'edit\n'); git(result.root, 'add', '.'); git(result.root, 'commit', '-qm', 'work'); const adopted = await f.engine.changeRequestCheckouts.adopt('p', result.id); assert.equal(adopted.plan.commit, git(result.root, 'rev-parse', 'HEAD'));
  git(result.root, 'switch', '-q', '-c', 'elsewhere'); await assert.rejects(f.engine.changeRequestCheckouts.adopt('p', result.id), /已经改变/); await assert.rejects(f.engine.changeRequestCheckouts.adopt('other', result.id), /不存在/);
});
test('Active local work blocks current-directory checkout while independent PR worktree remains available', async t => {
  const f = await fixture(t); const taskId = await f.engine.createTask({ prompt: 'fixture', projectId: 'p', agent: 'codex', mode: 'code', requestId: 'existing' }); await until(() => f.engine.snapshot(), s => s.tasks[0]?.status === 'completed');
  await f.engine.mutate(s => { s.tasks[0].status = 'running'; }); await assert.rejects(f.engine.changeRequestCheckouts.start('p', await f.input('checkout')), /正在执行或排队/);
  const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(git(f.cwd, 'branch', '--show-current'), 'main'); await f.engine.mutate(s => { s.tasks.find(v => v.id === taskId)!.status = 'completed'; });
});
test('Unknown durable checkout attempt is never replayed, and maintenance waits for active preparation', async t => {
  const f = await fixture(t); f.state.hold = true; const input = await f.input(), id = await f.engine.changeRequestCheckouts.start('p', input); await until(async () => f.state.fetches, v => v === 1);
  const maintenance = new ServiceMaintenance(() => f.engine.snapshot()); await assert.rejects(maintenance.prepare(), /PR／MR 目录/); await f.reopen(); f.state.hold = false;
  const result = await f.finish(id); assert.equal(result.status, 'interrupted'); assert.equal(f.state.fetches, 1); assert.equal(await f.engine.changeRequestCheckouts.start('p', input), id);
  await assert.rejects(f.engine.changeRequestCheckouts.start('p', { ...input, force: true }), /不同操作/); assert.equal(f.state.fetches, 1);
});
test('Inspection can reconcile an exact completed checkout without another mutation', async t => {
  const f = await fixture(t), result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); const resolution = await resolveCheckout(f.cwd, '#17', f.engine.sourceControl, f.data); const plan = await checkoutGitPlan(resolution, 'worktree', f.data, 'unused'); const count = f.state.fetches;
  const inspected = await inspectCheckout(resolution, plan, f.data, true); assert.equal(inspected.isOnHead, true); assert.equal(inspected.plan.cwd, result.plan?.cwd); assert.equal(f.state.fetches, count);
});
test('Checkout routes authenticate, bind projects, and expose only local saved preparation receipts', async t => {
  const f = await fixture(t), auth = new Auth(f.data), app = createAPI(f.engine, auth); t.after(async () => auth.close()); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await app.request('/api/projects/p/change-request/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await app.request('/api/projects/missing/change-request/resolve', { method: 'POST', headers, body: JSON.stringify({ reference: '#17' }) })).status, 400);
  const input = await f.input(), response = await app.request('/api/projects/p/change-request/prepare', { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(response.status, 202); const id = (await response.json() as { id: string }).id; await f.finish(id);
  const before = f.state.fetches; assert.equal((await app.request(`/api/projects/p/change-request/preparations/${id}`, { headers })).status, 200); assert.equal(f.state.fetches, before);
  assert.equal((await app.request(`/api/projects/other/change-request/preparations/${id}`, { headers })).status, 400);
});
test('A local edit made while fetching invalidates force instead of discarding newly written work', async t => {
  const f = await fixture(t); f.state.onGit = async () => { await writeFile(join(f.cwd, 'file'), 'changed during fetch\n'); };
  const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('checkout', { force: true }))); assert.equal(result.status, 'interrupted'); assert.match(result.error!, /准备期间已经改变/); assert.equal(await readFile(join(f.cwd, 'file'), 'utf8'), 'changed during fetch\n'); assert.equal(git(f.cwd, 'branch', '--show-current'), 'main');
});
test('A clean PR worktree on the former upstream safely follows a rewritten source head', async t => {
  const f = await fixture(t), first = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input()));
  const writer = join(f.dir, 'writer'); git(f.dir, 'clone', '-q', f.forkBare, writer); git(writer, 'config', 'user.name', 'Fixture'); git(writer, 'config', 'user.email', 'fixture@example.test'); git(writer, 'reset', '--hard', f.base); await writeFile(join(writer, 'file'), 'rewritten\n'); git(writer, 'commit', '-qam', 'rewrite'); f.state.sha = git(writer, 'rev-parse', 'HEAD'); git(writer, 'push', '-q', '--force', 'origin', 'HEAD:main');
  const second = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input('worktree', { requestId: 'rewrite' })));
  assert.equal(second.status, 'ready', second.error); assert.equal(second.root, first.root); assert.equal(second.isOnHead, true); assert.equal(git(second.root, 'rev-parse', 'HEAD'), f.state.sha); assert.equal(git(f.cwd, 'branch', '--show-current'), 'main');
});
test('Cancel stops a held checkout and releases directory/update locks without starting an Agent', async t => {
  const f = await fixture(t); f.state.hold = true; const id = await f.engine.changeRequestCheckouts.start('p', await f.input()); await until(async () => f.state.fetches, value => value === 1);
  await f.engine.changeRequestCheckouts.cancel('p', id); const result = await f.finish(id); assert.equal(result.status, 'interrupted'); f.state.hold = false;
  const maintenance = new ServiceMaintenance(() => f.engine.snapshot()); await maintenance.prepare(); maintenance.cancel(); assert.equal(f.state.requests.length, 0); assert.equal(git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/friday/pr-checkout'), '');
});
test('Staged-only changes are part of local destructive confirmation even when working files match HEAD', async t => {
  const f = await fixture(t); await writeFile(join(f.cwd, 'file'), 'first staged\n'); git(f.cwd, 'add', 'file'); await writeFile(join(f.cwd, 'file'), 'base\n'); const input = await f.input('checkout', { force: true });
  await writeFile(join(f.cwd, 'file'), 'second staged\n'); git(f.cwd, 'add', 'file'); await writeFile(join(f.cwd, 'file'), 'base\n');
  await assert.rejects(f.engine.changeRequestCheckouts.start('p', input), /已经改变/); assert.equal(git(f.cwd, 'show', ':file'), 'second staged'); assert.equal(f.state.fetches, 0);
});

test('Self-managed GitLab: resolve, Fork source and managed worktree stay on the chosen custom host', async t => {
  const f = await fixture(t, 'gitlab', 'code.example.test:8443'), preview = await f.preview(); assert.equal(preview.pullRequest.host, 'code.example.test:8443'); assert.equal(preview.headRepository?.host, 'code.example.test:8443'); assert.equal(preview.headRepository?.provider, 'gitlab');
  const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(result.isOnHead, true); assert.equal(git(result.root, 'config', 'branch.linc/pr-17/main.merge'), 'refs/heads/main');
});
test('Self-managed GitLab checkout preserves configured SSH protocol and port when adding a Fork remote', async t => {
  const f = await fixture(t, 'gitlab', 'code.example.test:8443'); const origin = 'ssh://git@code.example.test:2222/upstream/project.git', fork = 'ssh://git@code.example.test:2222/contributor/project.git';
  git(f.cwd, 'config', 'url.file://' + f.baseBare + '.insteadOf', origin); git(f.cwd, 'config', '--add', 'url.file://' + f.forkBare + '.insteadOf', fork); git(f.cwd, 'remote', 'set-url', 'origin', origin);
  const result = await f.finish(await f.engine.changeRequestCheckouts.start('p', await f.input())); assert.equal(result.status, 'ready', result.error); assert.equal(result.pullRequest.host, 'code.example.test:8443'); assert.equal(git(f.cwd, 'config', 'remote.contributor.url'), fork); assert.equal(result.isOnHead, true);
});

test('A failed synchronous PR setup keeps a warning and opens the draft without implicitly replaying the script', async t => {
  const f=await fixture(t);
  await f.engine.mutate(s=>{s.projects[0].scripts=[{id:'setup',name:'Setup',command:'printf x >> attempts; exit 7',icon:'configure',runOnWorktreeCreate:true,async:false}];});
  const input=await f.input(), id=await f.engine.changeRequestCheckouts.start('p',input), failed=await f.finish(id);
  assert.equal(failed.status,'ready');assert(failed.setupRunId);assert(failed.setupWarning);assert(failed.plan);
  const runs=(await f.engine.snapshot()).projectScriptRuns!, run=runs.find(r=>r.id===failed.setupRunId)!;
  assert.equal(run.exitCode,7);assert.equal(await readFile(join(run.cwd,'attempts'),'utf8'),'x');
  const adopted=await f.engine.changeRequestCheckouts.adopt('p',id);assert.equal(adopted.plan.cwd,run.cwd);
  assert.equal(await f.engine.changeRequestCheckouts.start('p',input),id);
  assert.equal((await f.engine.snapshot()).projectScriptRuns?.length,1);assert.equal((await f.engine.snapshot()).tasks.length,0);
  const taskID=await f.engine.createTask({prompt:'fixture',projectId:'p',agent:'codex',mode:'code',requestId:'warned-draft',workspace:{mode:'worktree',preparationId:id}});
  await until(()=>f.engine.snapshot(),s=>s.tasks.find(t=>t.id===taskID)?.status==='completed');
  assert.equal(f.state.requests.length,1);assert.equal((await f.engine.snapshot()).projectScriptRuns?.length,1);assert.equal(await readFile(join(run.cwd,'attempts'),'utf8'),'x');
});

test('New PR worktrees initialize submodules once, retaining a warning and a usable draft on failure',async t=>{
  const f=await fixture(t);
  git(f.cwd,'reset','--hard',f.head);
  await writeFile(join(f.cwd,'.gitmodules'),'[submodule "missing"]\n\tpath = missing\n\turl = '+join(f.dir,'absent.git')+'\n');
  git(f.cwd,'update-index','--add','--cacheinfo','160000,'+f.head+',missing');git(f.cwd,'add','.gitmodules');git(f.cwd,'commit','-qm','submodule fixture');const head=git(f.cwd,'rev-parse','HEAD');git(f.cwd,'push','-q',f.forkBare,'HEAD:main');f.state.sha=head;git(f.cwd,'reset','--hard',f.base);
  const id=await f.engine.changeRequestCheckouts.start('p',await f.input()),receipt=await f.finish(id);assert.equal(receipt.status,'ready',receipt.error);assert.equal(receipt.plan?.submodules?.status,'warning');assert.equal(receipt.plan?.submodules?.mode,'recursive');assert.equal(git(receipt.root,'rev-parse','HEAD'),head);assert.equal(f.state.requests.length,0);
  await f.engine.changeRequestCheckouts.adopt('p',id);
  await writeFile(join(receipt.root,'keep'),'user file');const reused=await f.finish(await f.engine.changeRequestCheckouts.start('p',await f.input('worktree',{requestId:'reuse-submodule-warning'})));assert.equal(reused.reused,true);assert.equal(reused.plan?.submodules,undefined);assert.equal(await readFile(join(reused.root,'keep'),'utf8'),'user file');
});
