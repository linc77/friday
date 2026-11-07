import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceControlCredentials, sourceControlCredentialPatch, sourceControlHost } from '../src/source-control-credentials.js';
import { SourceControlConnections, SourceControlHTTPError, SourceControlResponseTooLarge, githubEnvironmentToken } from '../src/source-control-connections.js';
import { createPublishedRepository, repositoryPublishInput, validatePublishAccount } from '../src/task-repository-publish.js';
import { resolveTaskTitleLinks } from '../src/task-title-links.js';

async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-source-control-')); const credentials = new SourceControlCredentials(directory);
  t.after(async () => { await credentials.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, credentials };
}

test('Raw GitHub diff transport pins its Accept header, bounds bytes, enforces timeout and refuses cross-origin redirects', async t => {
  const calls: { url: string; headers: Record<string, string> }[] = []; let mode = 'diff';
  const service = new SourceControlConnections(undefined, { environment: { GH_TOKEN: 'synthetic-diff-token' }, command: () => null,
    request: async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers as Record<string, string> });
      if (mode === 'redirect') return new Response('', { status: 302, headers: { location: 'https://foreign.invalid/raw' } });
      if (mode === 'slow') return new Promise((_resolve, reject) => { if (init?.signal?.aborted) reject(init.signal.reason); else init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }); });
      return new Response(mode === 'large' ? 'x'.repeat(1024 + 1) : 'diff --git a/a b/a\n');
    } }); t.after(async () => service.close());
  const pinned = await service.pin('/unused', 'github');
  assert.match(await pinned.text!('repos/u/r/pulls/1', { accept: 'application/vnd.github.diff', timeoutMs: 60000 }), /diff --git/);
  assert.equal(calls[0].headers.Accept, 'application/vnd.github.diff'); assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-diff-token');
  const before = calls.length; await assert.rejects(pinned.json('repos/u/r', { accept: 'application/vnd.github.diff' }), /Diff 请求无效/); assert.equal(calls.length, before);
  mode = 'large'; await assert.rejects(pinned.text!('repos/u/r/pulls/1', { maxResponseBytes: 1024 }), SourceControlResponseTooLarge);
  mode = 'redirect'; const count = calls.length; await assert.rejects(pinned.text!('repos/u/r/pulls/1', { accept: 'application/vnd.github.diff' }), /重定向/); assert.equal(calls.length, count + 1);
  mode = 'slow'; await assert.rejects(pinned.text!('repos/u/r/pulls/1', { timeoutMs: 5 }));
});
test('A nonzero GitLab API response cannot masquerade as valid JSON and exposes only a typed HTTP status for legacy diff fallback', async t => {
  const service = new SourceControlConnections(undefined, { environment: {}, command: name => name === 'glab' ? '/synthetic/glab' : null,
    execute: async () => ({ stdout: '{}', stderr: 'synthetic error (HTTP 404)', code: 1, digest: '' }) }); t.after(async () => service.close());
  const pinned = await service.pin('/unused', 'gitlab');
  await assert.rejects(pinned.array('projects/fixture%2Fproject/merge_requests/17/diffs'), error => error instanceof SourceControlHTTPError && error.status === 404 && !error.message.includes('synthetic error'));
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test('Credential updates are atomic, private, versioned and redacted across replacement, removal and restart', async t => {
  const { directory, credentials } = await setup(t);
  const first = { version: 0, requestId: 'first', githubToken: { host: 'GitHub.COM', token: 'synthetic-secret-one' }, bitbucket: { accessToken: 'synthetic-access', email: 'fixture@example.test', apiToken: 'synthetic-api' } };
  const result = await credentials.update(first); assert.equal(result.version, 1); assert.equal(result.bitbucket.hasAccessToken, true);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-/); assert.equal((await stat(join(directory, 'source-control-credentials.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await credentials.update(first), result, 'A lost save response reuses the same receipt');
  await assert.rejects(credentials.update({ ...first, githubToken: { host: 'github.com', token: 'different-secret' } }), /请求已使用/);
  const writes = await Promise.allSettled([
    credentials.update({ version: 1, requestId: 'parallel-one', githubToken: { host: 'code.example.test', token: 'synthetic-enterprise' } }),
    credentials.update({ version: 1, requestId: 'parallel-two', bitbucket: { accessToken: '' } }),
  ]);
  assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1); assert.equal(writes.filter(value => value.status === 'rejected').length, 1);
  const removed = await credentials.update({ version: 2, requestId: 'remove-public', githubToken: { host: 'github.com', token: '' }, bitbucket: { accessToken: '' } });
  assert.equal(removed.bitbucket.hasAccessToken, false); assert.equal(removed.bitbucket.hasAPIToken, true); assert(!removed.githubTokens.some(value => value.host === 'github.com'));
  const legacy = JSON.parse(await readFile(join(directory, 'source-control-credentials.json'), 'utf8')); delete legacy.githubHosts;
  await writeFile(join(directory, 'source-control-credentials.json'), JSON.stringify(legacy));
  const reopened = new SourceControlCredentials(directory); try { assert.deepEqual(await reopened.settings(), removed); } finally { await reopened.close(); }
  assert((await readFile(join(directory, 'source-control-credentials.json'), 'utf8')).includes('synthetic-api'));
  assert.deepEqual((await readdir(directory)).filter(value => value.endsWith('.tmp')), []);
});

test('Credential fields reject header injection, credential URLs, unknown fields and unsafe file aliases without echoing input', async t => {
  const { directory, credentials } = await setup(t);
  for (const host of ['https://github.com', 'user:token@github.com', 'github.com/path', 'github.com?token=x', 'github.com:65536']) assert.throws(() => sourceControlHost(host), /主机名无效/);
  for (const token of ['synthetic\r\nAuthorization: leaked', 'synthetic\0secret', '秘密']) {
    assert.throws(() => sourceControlCredentialPatch({ version: 0, requestId: 'invalid', githubToken: { host: 'github.com', token } }), /Token 无效/);
  }
  assert.throws(() => sourceControlCredentialPatch({ version: 0, requestId: 'invalid', bitbucket: { token: 'secret' } }), /设置无效/);
  await symlink(join(directory, 'unrelated'), join(directory, 'source-control-credentials.json'));
  await assert.rejects(credentials.settings(), /无法读取/); assert.deepEqual(await readdir(directory), ['source-control-credentials.json']);
});

test('A GitHub token works without a CLI and stays pinned while saved credentials change during creation', async t => {
  const { directory, credentials } = await setup(t); await credentials.update({ version: 0, requestId: 'token', githubToken: { host: 'github.com', token: 'synthetic-pinned-token' } });
  const seen: { url: string; authorization: string; method: string; body?: string }[] = [];
  const request: typeof fetch = async (url, options) => {
    seen.push({ url: String(url), authorization: new Headers(options?.headers).get('Authorization') ?? '', method: options?.method ?? 'GET', body: options?.body as string });
    if (String(url).endsWith('/user')) { await credentials.update({ version: 1, requestId: 'replace', githubToken: { host: 'github.com', token: 'synthetic-replacement-token' } }); return json({ login: 'fixture' }); }
    return json({ full_name: 'fixture/repository', html_url: 'https://github.com/fixture/repository', clone_url: 'https://github.com/fixture/repository.git', ssh_url: 'git@github.com:fixture/repository.git', private: true });
  };
  const connections = new SourceControlConnections(credentials, { environment: {}, request });
  const input = repositoryPublishInput({ provider: 'github', repository: 'fixture/repository', visibility: 'private', protocol: 'ssh', remoteName: 'origin', account: 'fixture' });
  try {
    const result = await createPublishedRepository(directory, input, undefined, connections); assert.equal(result.status, 'created');
    assert(seen.every(value => value.authorization === 'Bearer synthetic-pinned-token')); assert(seen.every(value => value.url.startsWith('https://api.github.com/')));
    assert.deepEqual(JSON.parse(seen[1].body!), { name: 'repository', private: true, auto_init: false });
  } finally { await connections.close(); }
});

test('GitHub credentials are selected by exact host and never follow a redirect to another origin', async t => {
  const { directory, credentials } = await setup(t);
  await credentials.update({ version: 0, requestId: 'enterprise', githubToken: { host: 'code.example.test', token: 'synthetic-enterprise-token' } });
  const calls: string[] = []; const connections = new SourceControlConnections(credentials, { environment: { GH_TOKEN: 'synthetic-public-token' }, request: async (url, options) => {
    calls.push(String(url)); assert.equal(options?.redirect, 'manual');
    assert.equal(new Headers(options?.headers).get('Authorization'), String(url).includes('code.example.test') ? 'Bearer synthetic-enterprise-token' : 'Bearer synthetic-public-token');
    return String(url).includes('code.example.test') ? new Response('', { status: 302, headers: { Location: 'https://different.example.test/' } }) : json({ login: 'public-fixture' });
  } });
  try {
    const privateHost = await connections.pin(directory, 'github', 'code.example.test'); await assert.rejects(privateHost.json('user'));
    const publicHost = await connections.pin(directory, 'github'); assert.equal((await publicHost.json('user')).login, 'public-fixture');
    assert.deepEqual(calls, ['https://code.example.test/api/v3/user', 'https://api.github.com/user']);
  } finally { await connections.close(); }
});

test('Bitbucket follows only its own API diff redirects and accepts explicit empty mutation responses', async t => {
  const { credentials, directory } = await setup(t); const calls: string[] = [];
  const connections = new SourceControlConnections(credentials, { environment: { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-bitbucket' }, request: async (input, options) => {
    const url = String(input); calls.push(url); assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-bitbucket');
    if (url.endsWith('/diff')) { assert.equal(new Headers(options?.headers).get('Accept'), null); return new Response(null, { status: 302, headers: { Location: '/2.0/repositories/fixture/project/diff/revision' } }); }
    if (url.endsWith('/revision')) return new Response('diff --git a/a.ts b/a.ts\n');
    if (url.endsWith('/approve')) return new Response(null, { status: 204 });
    return new Response(null, { status: 302, headers: { Location: 'https://foreign.invalid/token' } });
  } });
  try {
    const p = await connections.pin(directory, 'bitbucket'); assert.match(await p.text!('repositories/fixture/project/pullrequests/17/diff'), /diff --git/);
    assert.deepEqual(await p.json('repositories/fixture/project/pullrequests/17/approve', { method: 'POST', allowEmpty: true }), {});
    await assert.rejects(p.json('repositories/fixture/project/foreign'), /不受信任/); assert.equal(calls.length, 4);
  } finally { await connections.close(); }
});

test('GitHub Enterprise GraphQL uses its API root and keeps errors private', async t => {
  const { credentials, directory } = await setup(t);
  await credentials.update({ version: 0, requestId: 'graphql-host', githubToken: { host: 'code.example.test', token: 'synthetic-enterprise' } });
  let fail = false;
  const connections = new SourceControlConnections(credentials, { environment: {}, request: async (input, init) => {
    assert.equal(String(input), 'https://code.example.test/api/graphql'); assert.equal(init?.method, 'POST');
    return json(fail ? { errors: [{ message: 'synthetic-private-error' }] } : { data: { viewer: { login: 'fixture' } } });
  } });
  try { const p = await connections.pin(directory, 'github', 'code.example.test'); assert.deepEqual(await p.graphql!('query { viewer { login } }', {}), { viewer: { login: 'fixture' } }); fail = true; await assert.rejects(p.graphql!('query {}', {}), error => error instanceof Error && !error.message.includes('synthetic-private-error')); }
  finally { await connections.close(); }
});

test('Bitbucket prefers a saved workspace token, permits missing user scope, and binds the publication to that credential', async t => {
  const { directory, credentials } = await setup(t);
  await credentials.update({ version: 0, requestId: 'bitbucket', bitbucket: { accessToken: 'synthetic-access', email: 'fixture@example.test', apiToken: 'synthetic-api' } });
  const headers: string[] = []; const requests: string[] = [];
  const connections = new SourceControlConnections(credentials, { environment: { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-env' }, request: async (url, options) => {
    requests.push(String(url)); headers.push(new Headers(options?.headers).get('Authorization') ?? '');
    if (String(url).endsWith('/user')) return json({ message: 'synthetic-secret-must-not-escape' }, 403);
    assert.deepEqual(JSON.parse(options?.body as string), { scm: 'git', is_private: false });
    return json({ full_name: 'workspace/repository', is_private: false, links: { html: { href: 'https://bitbucket.org/workspace/repository' }, clone: [{ name: 'ssh', href: 'git@bitbucket.org:workspace/repository.git' }, { name: 'https', href: 'https://fixture@bitbucket.org/workspace/repository.git' }] } });
  } });
  try {
    const provider = await connections.probe(directory, 'bitbucket'); assert.equal(provider.status, 'configured'); assert.doesNotMatch(JSON.stringify(provider), /synthetic-/);
    const input = repositoryPublishInput({ provider: 'bitbucket', repository: 'workspace/repository', visibility: 'public', protocol: 'https', account: provider.account, credentialFingerprint: provider.credentialFingerprint });
    const publication = await createPublishedRepository(directory, input, undefined, connections);
    assert.equal(publication.remoteURL, 'https://bitbucket.org/workspace/repository.git'); assert.equal(publication.status, 'created');
    assert(headers.every(value => value === 'Bearer synthetic-access')); assert.equal(requests.filter(value => value.includes('/repositories/')).length, 1);
    await credentials.update({ version: 1, requestId: 'remove-access', bitbucket: { accessToken: '' } });
    await assert.rejects(validatePublishAccount(directory, input, undefined, connections), /凭据已经改变/);
    assert.equal(requests.filter(value => value.includes('/repositories/')).length, 1);
  } finally { await connections.close(); }
});

test('Bitbucket email/API token auth uses Basic, saved settings precede environment, and all removals restore environment fallback', async t => {
  const { directory, credentials } = await setup(t); await credentials.update({ version: 0, requestId: 'pair', bitbucket: { email: 'fixture@example.test', apiToken: 'synthetic-api' } });
  const authorization: string[] = []; const connections = new SourceControlConnections(credentials, { environment: { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-env' }, request: async (_url, options) => {
    authorization.push(new Headers(options?.headers).get('Authorization') ?? ''); return json({ display_name: '夹具 用户', account_id: 'fixture-account' });
  } });
  try {
    const provider = await connections.probe(directory, 'bitbucket'); assert.equal(provider.status, 'ready'); assert.equal(provider.account, '夹具 用户');
    await credentials.update({ version: 1, requestId: 'remove-pair', bitbucket: { email: '', apiToken: '' } });
    await connections.probe(directory, 'bitbucket');
    assert.deepEqual(authorization, ['Basic ' + Buffer.from('fixture@example.test:synthetic-api').toString('base64'), 'Bearer synthetic-env']);
  } finally { await connections.close(); }
});

test('Source control response limits, malformed JSON and cancellation cannot expose credentials or keep service shutdown waiting', async t => {
  const { directory, credentials } = await setup(t); await credentials.update({ version: 0, requestId: 'token', githubToken: { host: 'github.com', token: 'synthetic-token' } });
  let mode = 'large'; let started!: () => void; const observed = new Promise<void>(resolve => { started = resolve; });
  const connections = new SourceControlConnections(credentials, { environment: {}, request: async (_url, options) => {
    if (mode === 'large') return new Response('x'.repeat(256 * 1024 + 1));
    if (mode === 'malformed') return new Response('{bad json');
    started(); return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('synthetic-token-must-not-escape')), { once: true }));
  } });
  const pinned = await connections.pin(directory, 'github'); await assert.rejects(pinned.json('user'), /内容过大/);
  mode = 'malformed'; const malformed = await connections.probe(directory, 'github'); assert.equal(malformed.status, 'unauthenticated'); assert.doesNotMatch(JSON.stringify(malformed), /synthetic-token|bad json/);
  mode = 'pending'; const pending = connections.probe(directory, 'github'); await observed; await connections.close(); const result = await pending;
  assert.equal(result.status, 'unauthenticated'); assert.doesNotMatch(JSON.stringify(result), /synthetic-token/); await assert.rejects(pinned.json('user'), /连接已关闭/);
});

test('Environment credentials follow the exact GitHub host policy, including residency hosts and an explicit enterprise host', async t => {
  const { directory, credentials } = await setup(t);
  const environment = { GH_TOKEN: 'synthetic-public', GH_ENTERPRISE_TOKEN: 'synthetic-enterprise', GH_HOST: 'chosen.example.test' };
  assert.equal(githubEnvironmentToken('github.com', environment), 'synthetic-public');
  assert.equal(githubEnvironmentToken('tenant.ghe.com', environment), 'synthetic-public');
  assert.equal(githubEnvironmentToken('chosen.example.test', environment), 'synthetic-enterprise');
  assert.equal(githubEnvironmentToken('unrelated.example.test', environment), undefined);
  const requests: { url: string; auth: string }[] = [];
  const connections = new SourceControlConnections(credentials, { environment, command: () => null, request: async (url, options) => {
    requests.push({ url: String(url), auth: new Headers(options?.headers).get('Authorization') ?? '' }); return json({ login: 'fixture' });
  } });
  try {
    for (const host of ['github.com', 'tenant.ghe.com', 'chosen.example.test']) await (await connections.pin(directory, 'github', host)).json('user');
    await assert.rejects(connections.pin(directory, 'github', 'unrelated.example.test'));
    assert.deepEqual(requests.map(value => value.url), ['https://api.github.com/user', 'https://api.tenant.ghe.com/user', 'https://chosen.example.test/api/v3/user']);
    assert.deepEqual(requests.map(value => value.auth), ['Bearer synthetic-public', 'Bearer synthetic-public', 'Bearer synthetic-enterprise']);
    await credentials.update({ version: 0, requestId: 'disabled-enterprise', githubHost: { host: 'chosen.example.test', enabled: false } });
    const disabled = await connections.probe(directory, 'github', 'chosen.example.test'); assert.equal(disabled.status, 'unauthenticated'); assert.match(disabled.hint ?? '', /停用/); assert.equal(requests.length, 3);
  } finally { await connections.close(); }
});

test('GitHub routing selects a CLI account, caches tokens, falls back for a stale selection and disables every credential source', async t => {
  const { directory, credentials } = await setup(t);
  await credentials.update({ version: 0, requestId: 'select', githubHost: { host: 'github.com', account: 'second', enabled: true } });
  const calls: string[][] = []; const headers: string[] = [];
  const connections = new SourceControlConnections(credentials, { environment: {}, command: () => '/fixture/gh', execute: async (_cwd, _command, args, options) => {
    assert.equal(options?.env?.GH_DEBUG, ''); assert.equal(options?.env?.GH_ENTERPRISE_TOKEN, ''); assert.equal(options?.env?.GH_TOKEN, ''); calls.push(args);
    const account = args.includes('--user') ? args[args.indexOf('--user') + 1] : 'active';
    return { stdout: account === 'missing' ? '' : 'synthetic-cli-' + account, stderr: '', code: account === 'missing' ? 1 : 0, digest: '' };
  }, request: async (_url, options) => { headers.push(new Headers(options?.headers).get('Authorization') ?? ''); return json({ login: 'fixture' }); } });
  try {
    await (await connections.pin(directory, 'github')).json('user'); await connections.pin(directory, 'github');
    assert.equal(calls.length, 1); assert(calls[0].includes('second')); assert.deepEqual(headers, ['Bearer synthetic-cli-second']);
    await credentials.update({ version: 1, requestId: 'stale', githubHost: { host: 'github.com', account: 'missing' } });
    await (await connections.pin(directory, 'github')).json('user'); assert.equal(calls.length, 3); assert(calls[1].includes('missing')); assert(!calls[2].includes('--user'));
    await credentials.update({ version: 2, requestId: 'disable', githubHost: { host: 'github.com', enabled: false }, githubToken: { host: 'github.com', token: 'synthetic-saved' } });
    await assert.rejects(connections.pin(directory, 'github'), /主机已在 Source Control/); assert.equal(headers.length, 2);
    const reopened = new SourceControlCredentials(directory); try { assert.deepEqual((await reopened.settings()).githubHosts, [{ host: 'github.com', enabled: false, account: 'missing' }]); } finally { await reopened.close(); }
    await credentials.update({ version: 3, requestId: 'follow', githubHost: { host: 'github.com', enabled: true, account: null } });
    assert.deepEqual((await credentials.settings()).githubHosts, [{ host: 'github.com', enabled: true }]);
    assert.equal((await connections.pin(directory, 'github')).source, 'settings');
  } finally { await connections.close(); }
});

test('CLI account discovery whitelists public metadata and never returns a CLI token or raw error', async t => {
  const { directory, credentials } = await setup(t);
  const connections = new SourceControlConnections(credentials, { environment: {}, command: () => '/fixture/gh', execute: async (_cwd, _command, args, options) => {
    assert.deepEqual(args, ['auth', 'status', '--json', 'hosts']); assert.equal(options?.env?.GH_TOKEN, '');
    return { stdout: JSON.stringify({ hosts: { 'github.com': [{ host: 'github.com', login: 'first', active: true, state: 'success', oauthToken: 'synthetic-secret-must-not-return' }, { host: 'github.com', login: 'broken', active: false, state: 'error', error: 'synthetic-secret-must-not-return' }] } }), stderr: '', code: 0, digest: '' };
  } });
  try {
    const accounts = await connections.githubAccounts(directory, true); assert.equal(accounts.length, 2); assert.equal(accounts[0].account, 'first'); assert.equal(accounts[1].authenticated, false);
    assert.doesNotMatch(JSON.stringify(accounts), /synthetic-secret|oauthToken|error/);
  } finally { await connections.close(); }
});

test('Linked subjects use the saved enterprise credential and honor host disable without contacting an unregistered host', async t => {
  const { directory, credentials } = await setup(t); await credentials.update({ version: 0, requestId: 'enterprise-link', githubToken: { host: 'code.example.test', token: 'synthetic-enterprise' } });
  const calls: string[] = []; const connections = new SourceControlConnections(credentials, { environment: {}, command: () => null, request: async (url, options) => {
    calls.push(String(url)); assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer synthetic-enterprise'); return json({ title: 'Private linked issue', body: 'Bounded source context' });
  } });
  try {
    const input = { message: 'Fix https://code.example.test/team/project/issues/8?token=discard and https://unregistered.test/team/project/issues/9', cwd: directory, signal: new AbortController().signal };
    const context = await resolveTaskTitleLinks(input, { connections }); assert.match(context ?? '', /Private linked issue/); assert.doesNotMatch(context ?? '', /discard|unregistered/);
    assert.deepEqual(calls, ['https://code.example.test/api/v3/repos/team/project/issues/8']);
    await credentials.update({ version: 1, requestId: 'disable-link', githubHost: { host: 'code.example.test', enabled: false } });
    assert.match(await resolveTaskTitleLinks(input, { connections }) ?? '', /unavailable/); assert.equal(calls.length, 1);
  } finally { await connections.close(); }
});

test('An older gh reports an account-list upgrade hint without treating a working token as signed out', async t => {
  const { directory, credentials } = await setup(t);
  const connections = new SourceControlConnections(credentials, { environment: { GH_TOKEN: 'synthetic-environment-token' }, command: () => '/fixture/cli',
    request: async () => json({ login: 'fixture' }), execute: async (_cwd, _command, args) => args[0] === 'auth'
      ? { stdout: '', stderr: 'unknown flag: --json synthetic-secret-never-return', code: 1, digest: '' }
      : { stdout: JSON.stringify({ username: 'fixture' }), stderr: '', code: 0, digest: '' } });
  try {
    const result = await connections.discovery(directory); assert.match(result.githubAccountHint ?? '', /2\.81\.0/);
    assert.equal(result.providers.find(value => value.provider === 'github')?.status, 'ready'); assert.doesNotMatch(JSON.stringify(result), /synthetic-/);
  } finally { await connections.close(); }
});

test('Authenticated repository Git confines headers to the selected host/repository and never persists credential config', async t => {
  const { directory, credentials } = await setup(t);
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const connections = new SourceControlConnections(credentials, { environment: { GH_TOKEN: 'synthetic-git-header', FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-bb-git' }, command: () => null,
    execute: async (_cwd, _command, args, options) => { calls.push({ args, env: options?.env ?? {} }); return { stdout: '', stderr: '', code: 0, digest: '' }; } });
  t.after(async () => connections.close());
  for (const [provider, host] of [['github', 'github.com'], ['bitbucket', 'bitbucket.org']] as const) {
    const pinned = await connections.pin(directory, provider, host); await pinned.repositoryGit!(directory, 'owner/repo', ['fetch', '--quiet', `https://${host}/owner/repo.git`, 'refs/heads/main']);
    const call = calls.at(-1)!, entries = Array.from({ length: Number(call.env.GIT_CONFIG_COUNT) }, (_, i) => [call.env['GIT_CONFIG_KEY_' + i], call.env['GIT_CONFIG_VALUE_' + i]]);
    assert(entries.some(([key]) => key === `http.https://${host}/owner/repo.git.extraheader`)); assert(entries.some(([key, value]) => key === 'http.extraheader' && value === '')); assert(entries.some(([key, value]) => key === 'credential.helper' && value === '')); assert(entries.some(([key, value]) => key === 'http.followRedirects' && value === 'false'));
    assert(!call.args.join(' ').includes('synthetic')); assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null'); assert(!JSON.stringify(await credentials.settings()).includes('synthetic'));
    await assert.rejects(pinned.repositoryGit!(directory, '../other/repo', ['fetch']), /仓库无效/);
  }
});
