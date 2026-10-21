import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { Engine } from '../src/engine.js';
import { discoverPublishProviders, repositoryPublishInput, type RepositoryPublishInput } from '../src/task-repository-publish.js';
import { readTaskGitStatus } from '../src/task-git-status.js';
import type { Executor } from '../src/types.js';

const exec = promisify(execFile);
const executor: Executor = { async run() { return 'Fixture'; }, async answer() {}, async steer() {} };
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Fixture timed out');
}
async function setup(t: { after(fn: () => Promise<unknown>): void }, options: { empty?: boolean; nestedData?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-publish-')); const root = join(directory, 'repo'); const bin = join(directory, 'bin');
  await mkdir(root); await mkdir(bin);
  const env = { ...process.env }; const originalPath = process.env.PATH;
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { env })).stdout;
  await git('init', '-q', '--initial-branch=main');
  await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'commit.gpgsign', 'false');
  if (!options.empty) { await writeFile(join(root, 'README.md'), 'fixture\n'); await git('add', '.'); await git('commit', '-qm', 'Initial'); }
  const config = join(directory, 'config.json'); const log = join(directory, 'calls.jsonl');
  await writeFile(config, '{}'); await writeFile(log, '');
  const script = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(config)}, 'utf8'));
const args = process.argv.slice(2); const provider = path.basename(process.argv[1]) === 'gh' ? 'github' : 'gitlab';
const input = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({provider,args,input}) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value));
if (args[0]==='auth' && args[1]==='token') { if(config.failAuth)process.exit(1);process.stdout.write('synthetic-gh-cli-token'); }
else if (args[0]==='auth' && args[1]==='status') send({hosts:{'github.com':[{host:'github.com',login:config.account || 'fixture',state:'success',active:true}]}});
else if (args.includes('user')) { if (config.failAuth) { console.error('Authorization: ghp_fixture_never_expose'); process.exit(1); } send(provider === 'github' ? {login:config.account || 'fixture'} : {username:config.account || 'fixture'}); }
else if (args.some(arg => arg.startsWith('namespaces/'))) send({id:7});
else if (args.includes('POST')) {
 if (config.holdCreate) { setTimeout(() => send({}), 60000); }
 else if (config.failCreate) { console.error('https://user:fixture-secret@github.com/ ghp_fixture_never_expose'); process.exit(1); }
 else { const repo = config.repository || 'fixture/repository'; const host = provider === 'github' ? 'github.com' : 'gitlab.com'; const url = 'https://' + host + '/' + repo;
 const visibility = config.visibility || (provider === 'github' ? input.private ? 'private' : 'public' : args.find(arg => arg.startsWith('visibility=')).slice(11));
 send(provider === 'github' ? {full_name:repo,html_url:url,ssh_url:'git@'+host+':'+repo+'.git',clone_url:config.wrongURL || url+'.git',private:visibility==='private'} : {path_with_namespace:repo,web_url:url,ssh_url_to_repo:'git@'+host+':'+repo+'.git',http_url_to_repo:url+'.git',visibility}); }
} else { console.error('Unexpected fixture call'); process.exit(1); }
`;
  for (const command of ['gh', 'glab']) { const path = join(bin, command); await writeFile(path, script); await chmod(path, 0o755); }
  process.env.PATH = bin + ':' + originalPath;
  const data = options.nestedData ? join(root, 'friday-data') : join(directory, 'data');
  const httpRequests: { url: string; authorization: string; body?: string }[] = [];
  const requestAPI: typeof fetch = async (url, init) => {
    const configValue = JSON.parse(await readFile(config, 'utf8')); const address = new URL(String(url));
    assert(['api.github.com', 'api.bitbucket.org'].includes(address.hostname), 'Fixture must never access a real or unexpected host');
    const provider = address.hostname === 'api.github.com' ? 'github' : 'bitbucket';
    httpRequests.push({ url: String(url), authorization: new Headers(init?.headers).get('Authorization') ?? '', body: init?.body as string });
    await appendFile(log, JSON.stringify({ provider, args: ['http', init?.method ?? 'GET', address.pathname] }) + '\n');
    if (address.pathname.endsWith('/user')) return configValue.denyUser || configValue.failAuth ? json({ message: 'fixture denied' }, 403) : json(provider === 'github' ? { login: configValue.account || 'fixture' } : { display_name: 'Fixture Bitbucket' });
    if (configValue.holdCreate) return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Fixture interrupted')), { once: true }));
    if (configValue.failCreate) return json({ message: 'synthetic-fixture-secret' }, 500);
    const repository = configValue.repository || 'fixture/repository'; const host = provider === 'github' ? 'github.com' : 'bitbucket.org'; const publicURL = 'https://' + host + '/' + repository;
    const body = JSON.parse(init?.body as string);
    return json(provider === 'github' ? { full_name: repository, html_url: publicURL, clone_url: configValue.wrongURL || publicURL + '.git', ssh_url: 'git@' + host + ':' + repository + '.git', private: configValue.visibility ? configValue.visibility === 'private' : body.private } :
      { full_name: repository, is_private: body.is_private, links: { html: { href: publicURL }, clone: [{ name: 'ssh', href: 'git@' + host + ':' + repository + '.git' }, { name: 'https', href: publicURL + '.git' }] } });
  };
  const engine = await new Engine(data, executor, undefined, { environment: {}, request: requestAPI }).open();
  t.after(async () => { await engine.close(); process.env.PATH = originalPath; await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: root, context: '' }));
  const id = await engine.createTask({ prompt: 'Initial', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'initial' });
  await until(() => engine.snapshot(), state => state.tasks[0]?.status === 'completed');
  const input: RepositoryPublishInput = { provider: 'github', repository: 'fixture/repository', visibility: 'private', remoteName: 'origin', protocol: 'ssh', account: 'fixture' };
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const configure = (value: object) => writeFile(config, JSON.stringify(value));
  const publicationCount = async () => (await calls()).filter(value => value.args.includes('POST')).length;
  const request = async (overrides: Partial<RepositoryPublishInput> = {}, requestId = 'publish') => ({ action: 'publish_repository' as const, requestId,
    fingerprint: (await readTaskGitStatus(root, data)).fingerprint, repositoryPublish: { ...input, ...overrides } });
  const operation = async (target = engine) => (await until(() => target.snapshot(), state => !!state.tasks[0]?.gitOperation && !['queued', 'running'].includes(state.tasks[0].gitOperation.status))).tasks[0].gitOperation!;
  const localRemote = async (url = 'git@github.com:fixture/repository.git') => {
    const bare = join(directory, 'remote.git'); await exec('git', ['init', '--bare', '-q', bare], { env });
    await git('config', `url.file://${bare}.insteadOf`, url); return bare;
  };
  const auth = new Auth(data); const app = createAPI(engine, auth, () => []); const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  return { directory, root, data, git, engine, id, input, calls, configure, publicationCount, request, operation, localRemote, app, headers, httpRequests };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('GitHub publishing uses an explicit host/account, persists each result, pushes only commits, and deduplicates receipts', async t => {
  const f = await setup(t); const bare = await f.localRemote();
  await writeFile(join(f.root, 'uncommitted.txt'), 'private draft');
  const request = await f.request(); const before = await f.git('rev-parse', 'HEAD');
  const response = await f.app.request(`/api/tasks/${f.id}/git/operations`, { method: 'POST', headers: f.headers, body: JSON.stringify(request) });
  assert.equal(response.status, 202); const { id } = await response.json(); const result = await f.operation();
  assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.repositoryPublication?.status, 'pushed');
  assert.equal(await f.git('rev-parse', 'HEAD'), before); assert.equal((await f.git('status', '--porcelain')).trim(), '?? uncommitted.txt');
  assert.equal((await exec('git', ['--git-dir', bare, 'show', 'main:README.md'])).stdout, 'fixture\n');
  assert.equal((await f.git('rev-parse', '--abbrev-ref', '@{upstream}')).trim(), 'origin/main');
  assert.equal(await f.engine.gitOperations.start(f.id, request), id); assert.equal(await f.publicationCount(), 1);
  const create = (await f.calls()).find(value => value.args.includes('POST'));
  assert.deepEqual(create.args, ['http', 'POST', '/user/repos']);
  assert.deepEqual(JSON.parse(f.httpRequests.find(value => value.body)?.body ?? '{}'), { name: 'repository', private: true, auto_init: false });
});

test('GitLab publishing resolves nested namespaces and preserves visibility, HTTPS and a custom remote', async t => {
  const f = await setup(t); await f.configure({ repository: 'group/subgroup/project' });
  await f.localRemote('https://gitlab.com/group/subgroup/project.git');
  await f.engine.gitOperations.start(f.id, await f.request({ provider: 'gitlab', repository: 'group/subgroup/project', visibility: 'public', protocol: 'https', remoteName: 'publish' }));
  const result = await f.operation(); assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.repositoryPublication?.remoteName, 'publish');
  assert.equal(result.repositoryPublication?.remoteURL, 'https://gitlab.com/group/subgroup/project.git'); assert.equal(result.repositoryPublication?.status, 'pushed');
  const calls = await f.calls(); assert(calls.some(value => value.args.includes('namespaces/group%2Fsubgroup')));
  const create = calls.find(value => value.args.includes('POST')); assert(create.args.includes('namespace_id=7')); assert(create.args.includes('visibility=public'));
});

test('An empty repository creates a private organization repository and remote without attempting a push or a commit', async t => {
  const f = await setup(t, { empty: true }); await f.configure({ repository: 'organization/empty' });
  await f.engine.gitOperations.start(f.id, await f.request({ repository: 'organization/empty', protocol: 'https' }));
  const result = await f.operation(); assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.repositoryPublication?.status, 'remote_added');
  assert.equal(result.head, null); assert.equal((await f.git('remote', 'get-url', 'origin')).trim(), 'https://github.com/organization/empty.git');
  assert((await f.calls()).find(value => value.args.includes('POST')).args.includes('/orgs/organization/repos'));
  await assert.rejects(f.git('rev-parse', '--verify', 'HEAD'));
});

test('A failed first push keeps the created repository and remote; a later ordinary push never creates again', async t => {
  const f = await setup(t); await f.localRemote(); const hook = join(f.root, '.git/hooks/pre-push');
  await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
  const request = await f.request(); await f.engine.gitOperations.start(f.id, request); const result = await f.operation();
  assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /仓库已创建并添加远端/); assert.equal(result.repositoryPublication?.status, 'remote_added');
  assert.equal(await f.publicationCount(), 1); assert.equal((await f.git('remote')).trim(), 'origin');
  await assert.rejects(f.engine.gitOperations.start(f.id, await f.request({}, 'another-publish')), /尚未配置远端/);
  await rm(hook);
  await f.engine.gitOperations.start(f.id, { requestId: 'resume-push', action: 'push', fingerprint: (await readTaskGitStatus(f.root)).fingerprint, confirmedDefaultBranch: true });
  assert.equal((await f.operation()).status, 'completed'); assert.equal(await f.publicationCount(), 1);
  assert.equal((await f.engine.snapshot()).tasks[0].gitOperations?.at(-1)?.repositoryPublication?.status, 'remote_added');
});

test('Provider discovery and API auth never return raw credential failures; malformed input and changed accounts fail before creation', async t => {
  const f = await setup(t); const route = `/api/tasks/${f.id}/git/publish-providers`;
  assert.equal((await f.app.request(route)).status, 401);
  const ready = await f.app.request(route, { headers: f.headers }); assert.equal(ready.status, 200); assert.deepEqual((await ready.json()).providers.map((value: any) => value.provider), ['github', 'gitlab', 'bitbucket', 'forgejo', 'gitcafe', 'azure-devops']);
  for (const override of [{ repository: '../outside' }, { provider: 'unknown' }, { remoteName: '--force' }, { protocol: 'file' }, { visibility: 'internal' }]) assert.throws(() => repositoryPublishInput({ ...f.input, ...override }));
  await f.configure({ account: 'different' }); await assert.rejects(f.engine.gitOperations.start(f.id, await f.request()), /账号已经改变/); assert.equal(await f.publicationCount(), 0);
  await f.configure({ failAuth: true }); const unavailable = await discoverPublishProviders(f.root);
  assert(unavailable.filter(value => ['github','gitlab','bitbucket'].includes(value.provider)).every(value => value.status === 'unauthenticated'));
  assert(unavailable.filter(value => !['github','gitlab','bitbucket'].includes(value.provider)).every(value => ['missing','unauthenticated'].includes(value.status))); assert.doesNotMatch(JSON.stringify(unavailable), /ghp_|Authorization/);
});

test('A mismatching provider URL or visibility cannot add a remote and the same failed receipt does not create again', async t => {
  const f = await setup(t); await f.configure({ wrongURL: 'https://user:fixture-secret@evil.test/repository.git' });
  const request = await f.request(); const receipt = await f.engine.gitOperations.start(f.id, request); const result = await f.operation();
  assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /地址或可见性/); assert.equal(await f.git('remote'), '');
  assert.equal(await f.engine.gitOperations.start(f.id, request), receipt); assert.equal(await f.publicationCount(), 1); assert.doesNotMatch(JSON.stringify(result), /fixture-secret|evil\.test/);
  await f.configure({ visibility: 'public' });
  await f.engine.gitOperations.start(f.id, await f.request({}, 'visibility-mismatch')); const visibility = await f.operation();
  assert.equal(visibility.status, 'failed'); assert.match(visibility.error ?? '', /地址或可见性/); assert.equal(await f.git('remote'), '');
  await f.configure({ failCreate: true });
  await f.engine.gitOperations.start(f.id, await f.request({}, 'create-failure')); const failure = await f.operation();
  assert.equal(failure.status, 'failed'); assert.match(failure.error ?? '', /创建结果尚未确认/); assert.doesNotMatch(JSON.stringify(failure), /fixture-secret|ghp_fixture/);
});

test('Runtime data in any published history is rejected even after deletion from HEAD', async t => {
  const f = await setup(t, { nestedData: true });
  // Only synthetic source data is added; the running engine directory is never committed.
  await writeFile(join(f.root, 'friday-data/synthetic.txt'), 'fixture'); await f.git('add', 'friday-data/synthetic.txt'); await f.git('commit', '-qm', 'Historical synthetic data');
  await f.git('rm', 'friday-data/synthetic.txt'); await f.git('commit', '-qm', 'Remove synthetic data');
  await assert.rejects(f.engine.gitOperations.start(f.id, await f.request()), /历史包含 Friday 私有数据/); assert.equal(await f.publicationCount(), 0);
});

test('Restarting an uncertain create request never replays the external side effect', async t => {
  const f = await setup(t); await f.configure({ holdCreate: true }); const request = await f.request();
  const receipt = await f.engine.gitOperations.start(f.id, request);
  await until(f.publicationCount, count => count === 1); await f.engine.close();
  const reopened = await new Engine(f.data, executor).open();
  try {
    const state = await until(() => reopened.snapshot(), state => state.tasks[0]?.gitOperation?.status === 'interrupted');
    assert.match(state.tasks[0].gitOperation?.error ?? '', /不会自动重复/);
    assert.equal(await reopened.gitOperations.start(f.id, request), receipt); assert.equal(await f.publicationCount(), 1); assert.equal(await f.git('remote'), '');
  } finally { await reopened.close(); }
});

test('Authenticated Source Control settings persist redacted state, reject stale or invalid edits, and reuse save receipts', async t => {
  const f = await setup(t); const route = '/api/source-control/settings';
  assert.equal((await f.app.request(route)).status, 401);
  const initial = await (await f.app.request(route, { headers: f.headers })).json(); assert.equal(initial.version, 0);
  const body = { version: 0, requestId: 'save-settings', githubToken: { host: 'github.com', token: 'synthetic-private-token' }, bitbucket: { accessToken: 'synthetic-bitbucket' } };
  const save = () => f.app.request(route, { method: 'PATCH', headers: f.headers, body: JSON.stringify(body) });
  const saved = await save(); assert.equal(saved.status, 200); const value = await saved.json();
  assert.equal(value.version, 1); assert.equal(value.bitbucket.hasAccessToken, true); assert.doesNotMatch(JSON.stringify(value), /synthetic-/);
  assert.equal((await save()).status, 200);
  const conflict = await f.app.request(route, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ ...body, requestId: 'stale-settings' }) }); assert.equal(conflict.status, 409);
  const invalid = await f.app.request(route, { method: 'PATCH', headers: f.headers, body: JSON.stringify({ ...body, version: 1, requestId: 'bad-header', bitbucket: { accessToken: 'synthetic\r\nsecret' } }) });
  assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /synthetic/);
  const malformed = await f.app.request(route, { method: 'PATCH', headers: f.headers, body: 'synthetic-private-token-is-not-json' });
  assert.equal(malformed.status, 400); assert.doesNotMatch(await malformed.text(), /synthetic/);
  const discovery = await (await f.app.request('/api/source-control/discovery', { headers: f.headers })).json();
  assert.equal(discovery.providers.find((provider: { provider: string }) => provider.provider === 'github').status, 'ready');
  assert.doesNotMatch(JSON.stringify(discovery), /synthetic-/);
  assert.doesNotMatch(JSON.stringify(await f.engine.snapshot()), /synthetic-private-token|synthetic-bitbucket/);
});

test('A Bitbucket workspace token publishes and pushes with an opaque credential receipt and no implicit account owner', async t => {
  const f = await setup(t); await f.configure({ repository: 'workspace/repository', denyUser: true });
  await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'bitbucket', bitbucket: { accessToken: 'synthetic-workspace-token' } });
  await f.localRemote('git@bitbucket.org:workspace/repository.git');
  const providers = await (await f.app.request(`/api/tasks/${f.id}/git/publish-providers`, { headers: f.headers })).json();
  const provider = providers.providers.find((value: { provider: string }) => value.provider === 'bitbucket'); assert.equal(provider.status, 'configured');
  const input = await f.request({ provider: 'bitbucket', repository: 'workspace/repository', account: provider.account, credentialFingerprint: provider.credentialFingerprint });
  const response = await f.app.request(`/api/tasks/${f.id}/git/operations`, { method: 'POST', headers: f.headers, body: JSON.stringify(input) }); assert.equal(response.status, 202);
  const result = await f.operation(); assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.repositoryPublication?.status, 'pushed');
  assert.equal(result.repositoryPublication?.url, 'https://bitbucket.org/workspace/repository'); assert.equal(await f.publicationCount(), 1);
  assert.doesNotMatch(JSON.stringify(await f.engine.snapshot()), /synthetic-workspace-token/);
  assert(f.httpRequests.filter(value => value.url.includes('bitbucket')).every(value => value.authorization === 'Bearer synthetic-workspace-token'));
});

test('A changed Bitbucket credential cannot consume an old publish confirmation or create an external repository', async t => {
  const f = await setup(t);
  await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'first-token', bitbucket: { accessToken: 'synthetic-first-token' } });
  const provider = await f.engine.sourceControl.probe(f.root, 'bitbucket');
  const input = await f.request({ provider: 'bitbucket', repository: 'workspace/repository', account: provider.account, credentialFingerprint: provider.credentialFingerprint });
  await f.engine.sourceControl.credentials!.update({ version: 1, requestId: 'changed-token', bitbucket: { accessToken: 'synthetic-next-token' } });
  await assert.rejects(f.engine.gitOperations.start(f.id, input), /凭据已经改变/); assert.equal(await f.publicationCount(), 0);
});
