import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { readTaskGitStatus, TaskGitStatuses } from '../src/task-git-status.js';
import type { SourceControlConnectionOptions } from '../src/source-control-connections.js';
import { creationSelection, resolveCreationContext } from '../src/task-change-request-creation.js';
import type { ExecutionRequest } from '../src/types.js';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, LANG: 'en_US.UTF-8', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
async function until<T>(read: () => Promise<T>, ready: (v: T) => boolean) { const end = Date.now() + 15000; while (Date.now() < end) { const v = await read(); if (ready(v)) return v; await new Promise(r => setTimeout(r, 15)); } throw Error('Creation fixture timed out'); }
async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: 'github' | 'gitlab' | 'bitbucket' = 'github', customHost?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'friday-create-source-')), cwd = join(dir, 'repo'), data = join(dir, 'data'), baseBare = join(dir, 'base.git'), forkBare = join(dir, 'fork.git'); await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'main'); git(cwd, 'config', 'user.name', 'Fixture'); git(cwd, 'config', 'user.email', 'fixture@example.test'); await writeFile(join(cwd, 'file'), 'base\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'base'); const baseCommit = git(cwd, 'rev-parse', 'HEAD'); git(dir, 'clone', '-q', '--bare', cwd, baseBare);
  await writeFile(join(cwd, 'file'), 'fork change\n'); git(cwd, 'commit', '-qam', 'fork'); const head = git(cwd, 'rev-parse', 'HEAD'); git(dir, 'clone', '-q', '--bare', cwd, forkBare); git(cwd, 'branch', '-m', 'contributor/main');
  const host = customHost ?? (provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'), targetPath = provider === 'gitlab' ? 'upstream/sub/project' : 'upstream/project', sourcePath = provider === 'gitlab' ? 'contributor/sub/project' : 'contributor/project';
  const targetURL = `https://${host}/${targetPath}.git`, sourceURL = `https://${host}/${sourcePath}.git`, url = `https://${host}/${targetPath}/${provider === 'github' ? 'pull' : provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/17`;
  for (const [name, address, bare] of [['origin', targetURL, baseBare], ['contributor', sourceURL, forkBare]]) { git(cwd, 'config', `url.file://${bare}.insteadOf`, address); git(cwd, 'remote', 'add', name, address); git(cwd, 'fetch', '-q', name); git(cwd, 'symbolic-ref', `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/main`); }
  git(cwd, 'branch', '--set-upstream-to=refs/remotes/contributor/main');
  const environment: NodeJS.ProcessEnv = provider === 'github' ? { GH_TOKEN: 'synthetic-creation-token' } : provider === 'bitbucket' ? { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-bitbucket-token' } : {};
  const state = { writes: [] as { path: string; body: any }[], queries: [] as string[], generated: [] as ExecutionRequest[], onGenerate: undefined as (() => Promise<void>) | undefined, existing: undefined as any, hold: false };
  const item = (body?: any) => provider === 'github' ? { number: 17, title: 'Fork change', html_url: url, state: 'open', head: { ref: String(body?.head ?? 'contributor:main').split(':').at(-1), repo: { full_name: sourcePath } }, base: { ref: body?.base ?? 'main' } }
    : provider === 'gitlab' ? { iid: 17, title: 'Fork change', web_url: url, state: 'opened', source_branch: body?.source_branch ?? 'main', target_branch: body?.target_branch ?? 'main', source_project_id: 11, target_project_id: 22 }
    : { id: 17, title: 'Fork change', links: { html: { href: url } }, state: 'OPEN', source: { branch: { name: body?.source?.branch?.name ?? 'main' }, repository: { full_name: sourcePath } }, destination: { branch: { name: body?.destination?.branch?.name ?? 'main' } } };
  const respond = async (path: string, method = 'GET', body?: any, signal?: AbortSignal | null): Promise<any> => {
    if (method === 'POST') { state.writes.push({ path, body }); state.existing = item(body); if (state.hold) return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Error('Lost create response')), { once: true })); return state.existing; }
    state.queries.push(path);
    if (path === 'user') return { username: 'contributor', id: 11 };
    if (/\/(pulls|merge_requests|pullrequests)\/17$/.test(path)) return state.existing;
    if (path.includes('/pulls?') || path.includes('/merge_requests?') || path.includes('/pullrequests?')) return provider === 'bitbucket' ? { values: state.existing ? [state.existing] : [] } : state.existing ? [state.existing] : [];
    return provider === 'gitlab' ? { id: path.includes(encodeURIComponent(sourcePath)) ? 11 : 22, default_branch: 'main' } : provider === 'bitbucket' ? { mainbranch: { name: 'main' } } : { default_branch: 'main' };
  };
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: 0, environment, command: name => provider === 'gitlab' && name === 'glab' ? '/synthetic/glab' : null,
    execute: async (_cwd, _command, args, opt) => { const path = args.find(a => a === 'user' || a.startsWith('projects/'))!; const body: any = {}; for (let i = 0; i < args.length; i++) if (args[i] === '--raw-field') { const [key, ...rest] = args[++i].split('='); body[key] = key.endsWith('_id') ? Number(rest.join('=')) : rest.join('='); } const value = await respond(path, args.includes('POST') ? 'POST' : 'GET', body, opt?.signal); return { stdout: JSON.stringify(value), stderr: '', code: 0, digest: '' }; },
    request: async (input, init) => { const address = new URL(String(input)); assert(['api.github.com', 'api.bitbucket.org'].includes(address.host)); return Response.json(await respond(address.pathname.replace(/^\/(?:2\.0\/)?/, '') + address.search, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined, init?.signal)); } };
  const executor = { async run(r: ExecutionRequest) { if (r.purpose !== 'git_text') return 'Fixture'; state.generated.push(r); await r.update({ kind: 'session', threadId: 'synthetic-writer' }); await state.onGenerate?.(); return JSON.stringify({ title: 'Fork change', body: 'Literal $(text) 中文' }); }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, options).open(); if (customHost) await engine.sourceControl.credentials!.update({ version: 0, requestId: 'self-managed', gitlabHost: { host: customHost, enabled: true } }); await engine.mutate(s => s.projects.push({ id: 'p', name: 'Fixture', path: cwd, context: '' }));
  const id = await engine.createTask({ prompt: 'Fixture', projectId: 'p', agent: 'codex', mode: 'code', requestId: 'task' }); await until(() => engine.snapshot(), s => s.tasks[0]?.status === 'completed');
  t.after(async () => { await engine.close(); await rm(dir, { recursive: true, force: true }); });
  const input = async (requestId = 'create', creation?: any) => ({ requestId, action: 'create_pr' as const, fingerprint: (await readTaskGitStatus(cwd, data, engine.sourceControl)).fingerprint, ...(creation ? { creation } : {}) });
  return { get engine() { return engine; }, dir, cwd, data, id, state, environment, sourcePath, targetPath, sourceURL, targetURL, forkBare, baseBare, baseCommit, head, url, item, input,
    finish: async (operationId: string) => (await until(() => engine.snapshot(), s => { const op = s.tasks[0]?.gitOperation; return op?.id === operationId && !['queued', 'running'].includes(op.status); })).tasks[0].gitOperation!,
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, options).open(); } };
}
for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: owner-prefixed local branches push the Fork branch and create in the separate target repository`, async t => {
  const f = await setup(t, provider), context = await f.engine.gitOperations.creationContext(f.id); assert.equal(context.source.path, f.sourcePath); assert.equal(context.target.path, f.targetPath); assert.equal(context.sourceBranch, 'main'); assert(context.isCrossRepository);
  const input = await f.input('create', { fingerprint: context.fingerprint }), id = await f.engine.gitOperations.start(f.id, input), op = await f.finish(id); assert.equal(op.status, 'completed', op.error ?? undefined); assert.equal(op.pullRequest?.url, f.url);
  assert.equal(git(f.cwd, 'branch', '--show-current'), 'contributor/main'); assert.equal(git(f.cwd, 'rev-parse', '--symbolic-full-name', '@{upstream}'), 'refs/remotes/contributor/main'); assert.equal(git(f.baseBare, 'rev-parse', 'main'), f.baseCommit); assert.equal(git(f.forkBare, 'rev-parse', 'main'), f.head);
  assert.equal(f.state.writes.length, 1); const write = f.state.writes[0];
  if (provider === 'github') { assert.equal(write.path, `repos/${f.targetPath}/pulls`); assert.equal(write.body.head, 'contributor:main'); assert.equal(write.body.maintainer_can_modify, true); }
  if (provider === 'gitlab') { assert.equal(write.path, 'projects/11/merge_requests'); assert.equal(write.body.target_project_id, 22); assert.equal(write.body.source_branch, 'main'); }
  if (provider === 'bitbucket') { assert.equal(write.path, `repositories/${f.targetPath}/pullrequests`); assert.equal(write.body.source.repository.full_name, f.sourcePath); }
  assert.equal(op.changeRequestBaseCommit, f.baseCommit); assert.equal(git(f.cwd, 'for-each-ref', '--format=%(refname)', 'refs/friday/create-pr'), ''); assert(!JSON.stringify(await f.engine.snapshot()).includes('synthetic-creation-token'));
  await f.reopen(); assert.equal(await f.engine.gitOperations.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});
test('Existing Fork requests are matched against the exact source repository and appear in refreshed Git status', async t => {
  const f = await setup(t); f.state.existing = f.item(); const statuses = new TaskGitStatuses(f.data, f.engine.sourceControl); t.after(async () => statuses.close());
  const status = await statuses.read(f.cwd, true); assert.equal(status.pullRequest?.url, f.url); assert(f.state.queries.some(q => q.includes('head=contributor%3Amain')));
  const id = await f.engine.gitOperations.start(f.id, await f.input()); assert.equal((await f.finish(id)).status, 'completed'); assert.equal(f.state.generated.length, 0); assert.equal(f.state.writes.length, 0);
});
test('Remote role changes invalidate confirmation and cached PR identity before writing', async t => {
  const f = await setup(t), context = await f.engine.gitOperations.creationContext(f.id), input = await f.input('frozen', { fingerprint: context.fingerprint });
  git(f.cwd, 'config', 'branch.contributor/main.remote', 'origin');
  await assert.rejects(f.engine.gitOperations.start(f.id, input), /工作区已经改变/); assert.equal(f.state.writes.length, 0);
});
test('Changing the source remote or account during generation prevents the PR write', async t => {
  const f = await setup(t); f.state.onGenerate = async () => { git(f.cwd, 'remote', 'set-url', '--push', 'contributor', 'https://github.com/other/project.git'); };
  const id = await f.engine.gitOperations.start(f.id, await f.input()); const op = await f.finish(id); assert.equal(op.status, 'failed'); assert.match(op.error!, /远端配置已改变/); assert.equal(f.state.writes.length, 0);
});
test('Configured target overrides and GH_REPO keep the source Fork separate; an unknown remote cannot choose a credential destination', async t => {
  const f = await setup(t); git(f.cwd, 'remote', 'add', 'upstream', f.targetURL); git(f.cwd, 'config', 'remote.upstream.gh-resolved', 'base');
  let context = await f.engine.gitOperations.creationContext(f.id); assert.equal(context.targetRemote, 'upstream');
  f.environment.GH_REPO = f.targetPath; context = await f.engine.gitOperations.creationContext(f.id); assert.equal(context.sourceRemote, 'contributor'); assert.equal(context.target.path, f.targetPath);
  await assert.rejects(f.engine.gitOperations.creationContext(f.id, { targetRemote: 'attacker' }), /所选目标远端/); f.environment.GH_REPO = 'untrusted.test/owner/project'; await assert.rejects(f.engine.gitOperations.creationContext(f.id), /主机不一致/); assert.equal(f.state.writes.length, 0);
});
test('A local owner-prefixed alias cannot create a same-repository main-to-main request', async t => {
  const f = await setup(t); await assert.rejects(f.engine.gitOperations.start(f.id, await f.input('same-source', { targetRemote: 'contributor' })), /功能分支/); assert.equal(f.state.writes.length, 0);
});
test('Creation context endpoints authenticate and refuse missing tasks; request IDs bind the complete publishing intent', async t => {
  const f = await setup(t), auth = new Auth(f.data), app = createAPI(f.engine, auth); t.after(async () => auth.close()); const path = '/api/tasks/' + f.id + '/git/change-request-context';
  assert.equal((await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }; assert.equal((await app.request('/api/tasks/missing/git/change-request-context', { method: 'POST', headers, body: '{}' })).status, 400);
  const input = await f.input(), id = await f.engine.gitOperations.start(f.id, input); await f.finish(id); await assert.rejects(f.engine.gitOperations.start(f.id, { ...input, creation: { targetRemote: 'origin', baseBranch: 'release' } }), /不同操作/); assert.equal(f.state.writes.length, 1);
  assert.throws(() => creationSelection({ targetRemote: 'origin', unexpected: true }), /选择无效/);
});


test('Account changes after a preview invalidate its publishing fingerprint before any write', async t => {
  const f = await setup(t), context = await f.engine.gitOperations.creationContext(f.id), input = await f.input('account-preview', { fingerprint: context.fingerprint });
  f.environment.GH_TOKEN = 'synthetic-other-account'; await assert.rejects(f.engine.gitOperations.start(f.id, input), /源或目标已经改变/); assert.equal(f.state.writes.length, 0);
});

test('A lost cross-Fork creation response is never replayed; an explicit new action adopts the exact existing source', async t => {
  const f = await setup(t); f.state.hold = true; const input = await f.input(), id = await f.engine.gitOperations.start(f.id, input); await until(async () => f.state.writes.length, n => n === 1);
  await f.reopen(); f.state.hold = false; assert.equal((await f.finish(id)).status, 'interrupted'); assert.equal(await f.engine.gitOperations.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
  const next = await f.engine.gitOperations.start(f.id, await f.input('explicit-adopt')); assert.equal((await f.finish(next)).status, 'completed'); assert.equal(f.state.writes.length, 1);
});

test('Self-managed GitLab: cross-Fork creation and target default fetch keep the custom host and nested groups', async t => {
  const f = await setup(t, 'gitlab', 'code.example.test:8443'), context = await f.engine.gitOperations.creationContext(f.id);
  assert.equal(context.target.host, 'code.example.test:8443'); assert.equal(context.target.provider, 'gitlab'); assert.equal(context.source.path, 'contributor/sub/project');
  const result = await f.finish(await f.engine.gitOperations.start(f.id, await f.input('custom-create', { fingerprint: context.fingerprint })));
  assert.equal(result.status, 'completed', result.error ?? undefined); assert.equal(result.pullRequest?.host, 'code.example.test:8443'); assert.equal(f.state.writes[0].path, 'projects/11/merge_requests'); assert.equal(f.state.writes[0].body.target_project_id, 22);
});
