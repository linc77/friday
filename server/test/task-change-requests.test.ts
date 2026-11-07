import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Engine } from '../src/engine.js';
import { readTaskGitStatus, TaskGitStatuses } from '../src/task-git-status.js';
import { sourceControlRepository, normalizeTaskChangeRequest, findTaskChangeRequest, createTaskChangeRequest } from '../src/task-change-requests.js';
import type { SourceControlConnectionOptions, PinnedSourceControlConnection } from '../src/source-control-connections.js';
import type { Executor, ExecutionRequest } from '../src/types.js';

const exec = promisify(execFile);
const json = (value: unknown) => new Response(JSON.stringify(value));
const output = (value: unknown) => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', code: 0, digest: '' });
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Change request fixture timed out');
}
function item(provider: 'github' | 'gitlab' | 'bitbucket', state = 'open', head = 'linc/feature') {
  const path = provider === 'gitlab' ? 'group/sub/project' : 'fixture/project';
  if (provider === 'github') return { number: 17, html_url: `https://github.com/${path}/pull/17`, title: 'Fixture PR', state: state === 'merged' ? 'closed' : state, merged_at: state === 'merged' ? '2026-10-19T00:00:00Z' : null, head: { ref: head, repo: { full_name: path } }, base: { ref: 'main' } };
  if (provider === 'gitlab') return { iid: 17, web_url: `https://gitlab.com/${path}/-/merge_requests/17`, title: 'Fixture MR', state: state === 'open' ? 'opened' : state, source_branch: head, target_branch: 'main', source_project_id: 9, target_project_id: 9 };
  return { id: 17, links: { html: { href: `https://bitbucket.org/${path}/pull-requests/17` } }, title: 'Fixture PR', state: state === 'open' ? 'OPEN' : state === 'closed' ? 'DECLINED' : 'MERGED', source: { branch: { name: head }, repository: { full_name: path } }, destination: { branch: { name: 'main' } } };
}

test('Repository identities require exact public or configured hosts, preserve GitLab groups and reject local paths and hostile names', () => {
  assert.equal(sourceControlRepository('git@github.com:fixture/project.git')?.provider, 'github');
  assert.equal(sourceControlRepository('ssh://git@gitlab.com/group/sub/project.git')?.path, 'group/sub/project');
  assert.equal(sourceControlRepository('https://bitbucket.org/fixture/project.git')?.provider, 'bitbucket');
  assert.equal(sourceControlRepository('https://gitlab.com/group/project.git', ['gitlab.com'])?.provider, 'gitlab');
  assert.equal(sourceControlRepository('https://github.corp.test/fixture/project.git'), undefined);
  assert.equal(sourceControlRepository('https://github.corp.test/fixture/project.git', ['github.corp.test'])?.provider, 'github');
  for (const url of ['/tmp/project.git', 'file:///tmp/project.git', 'https://github.com.attacker.test/fixture/project.git', 'https://github.com/a/../project.git', 'https://github.com/a%2Frepo/project.git']) assert.equal(sourceControlRepository(url), undefined);
});

test('A same-named branch from a fork is not adopted, and an incorrectly bound connection cannot create on another target', async () => {
  for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
    const identity = sourceControlRepository(`https://${provider === 'github' ? 'github.com/fixture/project' : provider === 'gitlab' ? 'gitlab.com/group/sub/project' : 'bitbucket.org/fixture/project'}.git`)!;
    const own = item(provider); const foreign: any = structuredClone(own);
    if (provider === 'github') foreign.head.repo.full_name = 'different/project'; else if (provider === 'gitlab') foreign.source_project_id = 10; else foreign.source.repository.full_name = 'different/project';
    let writes = 0;
    const pinned: PinnedSourceControlConnection = { provider, host: identity.host, source: 'settings', array: async () => [foreign, own], json: async (_path, options) => { if (options?.method === 'POST') writes++; return { values: [foreign, own] }; } };
    assert.equal((await findTaskChangeRequest(pinned, identity, 'linc/feature'))?.number, 17);
    await assert.rejects(createTaskChangeRequest({ ...pinned, host: 'different.example.test' }, identity, { branch: 'linc/feature', base: 'main', title: 'Fixture', body: 'Body' }), /连接与目标/);
    assert.equal(writes, 0);
  }
});

test('All providers normalize exact repository URLs, retain merge/close states and reject a different target URL', () => {
  for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
    const identity = sourceControlRepository(`https://${provider === 'github' ? 'github.com/fixture/project' : provider === 'gitlab' ? 'gitlab.com/group/sub/project' : 'bitbucket.org/fixture/project'}.git`)!;
    for (const state of ['open', 'closed', 'merged']) assert.equal(normalizeTaskChangeRequest(identity, item(provider, state)).state, state);
    assert.throws(() => normalizeTaskChangeRequest({ ...identity, path: 'different/project' }, item(provider)), /仓库不一致/);
  }
});

class Writer implements Executor {
  requests: ExecutionRequest[] = []; onGenerate?: () => Promise<void>;
  async run(request: ExecutionRequest) {
    if (request.purpose !== 'git_text') return 'Initial';
    this.requests.push(request); await request.update({ kind: 'session', threadId: 'writer-' + this.requests.length });
    await request.update({ kind: 'turn', turnId: 'writer-turn-' + this.requests.length }); await this.onGenerate?.();
    return JSON.stringify({ title: 'Fixture change', body: 'Literal `code`, $(not_a_command), 中文 and @file stay as text.' });
  }
  async answer() {} async steer() {}
}

async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: 'github' | 'gitlab' | 'bitbucket') {
  const directory = await mkdtemp(join(tmpdir(), 'friday-change-request-')); const root = join(directory, 'repo'); await mkdir(root);
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args])).stdout;
  await git('init', '-q', '--initial-branch=main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(root, 'file.txt'), 'before\n'); await git('add', '.'); await git('commit', '-qm', 'Initial');
  const bare = join(directory, 'remote.git'); await exec('git', ['init', '--bare', '-q', '--initial-branch=main', bare]);
  const url = provider === 'github' ? 'https://github.com/fixture/project.git' : provider === 'gitlab' ? 'https://gitlab.com/group/sub/project.git' : 'https://bitbucket.org/fixture/project.git';
  await git('config', `url.file://${bare}.insteadOf`, url); await git('remote', 'add', 'origin', url); await git('push', '-u', 'origin', 'main');
  await git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  await git('switch', '-c', 'linc/feature'); await writeFile(join(root, 'file.txt'), 'after\n'); await git('add', '.'); await git('commit', '-qm', 'Feature');
  const state: { value?: ReturnType<typeof item>; creations: number; hold: boolean; bodies: Record<string, unknown>[]; auth: string[]; lists: number; closeOnList?: number } = { creations: 0, hold: false, bodies: [], auth: [], lists: 0 };
  const respond = async (path: string, method: string, body: Record<string, unknown> | undefined, signal?: AbortSignal | null) => {
    const pathname = path.split('?')[0];
    if (pathname === 'user') return provider === 'gitlab' ? { username: 'fixture', id: 9 } : provider === 'github' ? { login: 'fixture' } : { username: 'fixture' };
    if (method === 'POST') {
      state.creations++; state.bodies.push(body!); state.value = item(provider);
      if (state.hold) return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Uncertain fixture response')), { once: true }));
      return state.value;
    }
    if (/\/(?:pulls|merge_requests|pullrequests)\/17$/.test(pathname)) return state.value;
    if (/\/(?:pulls|merge_requests|pullrequests)$/.test(pathname)) {
      state.lists++; const value = state.value;
      if (state.closeOnList === state.lists) state.value = item(provider, 'closed');
      return provider === 'bitbucket' ? { values: value && (value as any).state === 'OPEN' ? [value] : [] } : value ? [value] : [];
    }
    return provider === 'bitbucket' ? { mainbranch: { name: 'main' } } : { default_branch: 'main' };
  };
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: 0, environment: {}, command: name => name === 'gh' || name === 'glab' ? '/fixture/' + name : null,
    execute: async (_cwd, _command, args, extra) => {
      if (args[0] === 'auth' && args[1] === 'status') return output({ hosts: { 'github.com': [{ host: 'github.com', login: 'fixture', active: true, state: 'success' }, { host: 'github.com', login: 'other', active: false, state: 'success' }] } });
      if (args[0] === 'auth' && args[1] === 'token') return output('synthetic-cli-' + (args.includes('--user') ? args[args.indexOf('--user') + 1] : 'fixture'));
      const path = args.find(value => value === 'user' || value.startsWith('projects/'))!;
      const body: Record<string, unknown> = {}; for (let index = 0; index < args.length; index++) if (args[index] === '--raw-field') { const field = args[++index]; const equals = field.indexOf('='); body[field.slice(0, equals)] = field.slice(equals + 1); }
      return output(await respond(path, args.includes('POST') ? 'POST' : 'GET', body, extra?.signal));
    },
    request: async (input, init) => {
      const address = new URL(String(input)); assert(['api.github.com', 'api.bitbucket.org'].includes(address.hostname)); state.auth.push(new Headers(init?.headers).get('Authorization') ?? '');
      const path = address.pathname.replace(/^\/(?:2\.0\/)?/, '') + address.search;
      return json(await respond(path, init?.method ?? 'GET', init?.body ? JSON.parse(init.body as string) : undefined, init?.signal));
    } };
  const data = join(directory, 'data'); const writer = new Writer(); const engine = await new Engine(data, writer, undefined, options).open();
  if (provider === 'bitbucket') await engine.sourceControl.credentials!.update({ version: 0, requestId: 'bitbucket-token', bitbucket: { accessToken: 'synthetic-bitbucket-token' } });
  await engine.mutate(workspace => workspace.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'Initial', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'initial' });
  await until(() => engine.snapshot(), value => value.tasks[0]?.status === 'completed');
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  const request = async (requestId = 'create') => ({ action: 'create_pr' as const, requestId, fingerprint: (await readTaskGitStatus(root, data, engine.sourceControl)).fingerprint });
  const operation = async (target = engine) => (await until(() => target.snapshot(), value => !!value.tasks[0]?.gitOperation && !['queued', 'running'].includes(value.tasks[0].gitOperation.status))).tasks[0].gitOperation!;
  return { directory, root, data, git, state, options, engine, writer, id, request, operation };
}

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider} task PR/MR creation uses exact branch/body data, persists the target, and reuses an existing request`, async t => {
  const f = await setup(t, provider); const input = await f.request(); const operationID = await f.engine.gitOperations.start(f.id, input); const result = await f.operation();
  assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.pullRequest?.provider, provider); assert.equal(result.pullRequest?.number, 17); assert.equal(result.changeRequestTarget?.provider, provider);
  assert.equal(f.state.creations, 1); assert.match(String(f.state.bodies[0][provider === 'github' ? 'body' : 'description']), /\$\(not_a_command\).*中文/);
  assert.equal((await f.git('rev-parse', '--abbrev-ref', '@{upstream}')).trim(), 'origin/linc/feature');
  assert.equal(await f.engine.gitOperations.start(f.id, input), operationID);
  await f.engine.gitOperations.start(f.id, await f.request('adopt-existing')); assert.equal((await f.operation()).status, 'completed'); assert.equal(f.state.creations, 1); assert.equal(f.writer.requests.length, 1);
  if (provider === 'gitlab') assert.match(f.writer.requests[0].prompt, /^Write a merge request/);
  assert.doesNotMatch(JSON.stringify(await f.engine.snapshot()), /synthetic-cli-|synthetic-bitbucket-token/);
});

test('An account change during description generation stops the write while preserving the reviewed Git branch', async t => {
  const f = await setup(t, 'github'); const head = await f.git('rev-parse', 'HEAD');
  f.writer.onGenerate = async () => { await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'switch-account', githubHost: { host: 'github.com', account: 'other' } }); };
  await f.engine.gitOperations.start(f.id, await f.request()); const result = await f.operation();
  assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /账号或凭据已改变/); assert.equal(f.state.creations, 0); assert.equal(await f.git('rev-parse', 'HEAD'), head);
});

test('Unknown create results are never replayed on restart; an explicit fresh action can adopt the actual provider result', async t => {
  const f = await setup(t, 'bitbucket'); f.state.hold = true; const input = await f.request(); const receipt = await f.engine.gitOperations.start(f.id, input);
  await until(async () => f.state.creations, count => count === 1); await f.engine.close(); f.state.hold = false;
  const reopened = await new Engine(f.data, f.writer, undefined, f.options).open();
  try {
    await until(() => reopened.snapshot(), value => value.tasks[0]?.gitOperation?.status === 'interrupted');
    assert.equal(await reopened.gitOperations.start(f.id, input), receipt); assert.equal(f.state.creations, 1);
    const fingerprint = (await readTaskGitStatus(f.root, f.data, reopened.sourceControl)).fingerprint;
    await reopened.gitOperations.start(f.id, { ...input, requestId: 'explicit-adopt', fingerprint }); const adopted = await f.operation(reopened);
    assert.equal(adopted.status, 'completed'); assert.equal(adopted.pullRequest?.number, 17); assert.equal(f.state.creations, 1);
  } finally { await reopened.close(); }
});

test('Changing a remote after review invalidates the confirmation before any provider write', async t => {
  const f = await setup(t, 'github'); const input = await f.request(); await f.git('remote', 'set-url', '--push', 'origin', join(f.directory, 'different.git'));
  await assert.rejects(f.engine.gitOperations.start(f.id, input), /工作区已经改变/); assert.equal(f.state.creations, 0);
});

test('A host disabled in settings cannot reuse an old cached PR status or create another request', async t => {
  const f = await setup(t, 'github'); f.state.value = item('github'); await f.git('push', '-u', 'origin', 'linc/feature');
  const statuses = new TaskGitStatuses(f.data, f.engine.sourceControl); t.after(async () => statuses.close());
  const active = await statuses.read(f.root, true); assert.equal(active.pullRequest?.number, 17); assert.equal(active.canCreatePR, true);
  await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'disable', githubHost: { host: 'github.com', enabled: false } });
  const disabled = await statuses.read(f.root, true); assert.equal(disabled.canCreatePR, false); assert.equal(disabled.pullRequest, undefined);
  await assert.rejects(f.engine.gitOperations.start(f.id, await f.request()), /平台认证/); assert.equal(f.state.creations, 0);
});

test('Closing an adopted request between phases updates its state instead of creating a replacement', async t => {
  const f = await setup(t, 'github'); f.state.value = item('github'); f.state.closeOnList = 2;
  await f.engine.gitOperations.start(f.id, await f.request()); const result = await f.operation();
  assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.pullRequest?.state, 'closed'); assert.equal(f.state.creations, 0); assert.equal(f.writer.requests.length, 0);
});


test('All-state branch discovery requests terminal records for GitHub, GitLab and Bitbucket and projects their public timestamps',async()=>{
 for(const provider of ['github','gitlab','bitbucket'] as const){
  const identity=sourceControlRepository(`https://${provider==='github'?'github.com/fixture/project':provider==='gitlab'?'gitlab.com/group/sub/project':'bitbucket.org/fixture/project'}`)!;
  const row:any=item(provider,'merged');row.merged_at='2026-10-20T00:00:00Z';row.closed_on='2026-10-20T00:00:00Z';row.body='PRIVATE';let path='';
  const p:PinnedSourceControlConnection={provider,host:identity.host,source:'settings',json:async url=>{path=url;return {values:[row]};},array:async url=>{path=url;return [row];}};
  const found=await findTaskChangeRequest(p,identity,'linc/feature',undefined,{source:identity,includeTerminal:true});assert.equal(found?.state,'merged');assert.equal(found?.snapshot?.mergedAt,'2026-10-20T00:00:00Z');assert(!JSON.stringify(found).includes('PRIVATE'));
  const query=new URL(path,'https://fixture/').searchParams;if(provider==='bitbucket')assert.deepEqual(query.getAll('state'),['OPEN','MERGED','DECLINED','SUPERSEDED']);else assert.equal(query.get('state'),'all');
 }
});


test('An open branch request wins over a more recently updated terminal request',async()=>{
 const identity=sourceControlRepository('https://github.com/fixture/project')!,closed:any=item('github','merged'),open:any=item('github');
 closed.updated_at='2026-10-20T05:00:00Z';open.number=18;open.html_url=open.html_url.replace('/17','/18');open.updated_at='2026-10-20T00:00:00Z';
 const pinned:PinnedSourceControlConnection={provider:'github',host:'github.com',source:'settings',json:async()=>({}),array:async()=>[closed,open]};
 assert.equal((await findTaskChangeRequest(pinned,identity,'linc/feature',undefined,{source:identity,includeTerminal:true}))?.number,18);
});
