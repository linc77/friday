import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceControlCredentials, sourceControlCredentialPatch } from '../src/source-control-credentials.js';
import { SourceControlConnections } from '../src/source-control-connections.js';
import { sourceControlRepository, sourceControlRepositoryOnHost, pinTaskChangeRequest } from '../src/task-change-requests.js';
import { discoverPublishProviders, createPublishedRepository, repositoryPublishInput } from '../src/task-repository-publish.js';
import { parseGitLabAuthStatusHosts } from '../src/vendor/t3-gitlab-auth-status.js';
const output = (v: unknown) => ({ stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '', code: 0, digest: '' });
async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-glab-host-')), credentials = new SourceControlCredentials(directory);
  t.after(async () => { await credentials.close(); await rm(directory, { recursive: true, force: true }); }); return { directory, credentials };
}
const auth = 'gitlab.com\n  ✓ Logged in to gitlab.com as public-user (keyring)\nCode.Example.Test:8443\n  ✓ Logged in to Code.Example.Test:8443 as corporate.user (keyring)\n  Token: synthetic-never-return\nbroken.example.test\n  x API failed: synthetic-never-return\n';
test('T3 GitLab host parser keeps multi-host blocks separate and ignores unauthenticated instances', () => {
  const rows = parseGitLabAuthStatusHosts(auth); assert.deepEqual(rows.map(v => [v.host, v.account]), [['gitlab.com', 'public-user'], ['code.example.test:8443', 'corporate.user'], ['broken.example.test', null]]);
});
test('GitLab discovery supports current --all and older CLI syntax, deduplicates scans and only exposes safe account metadata', async t => {
  const f = await setup(t), calls: string[][] = [];
  const connections = new SourceControlConnections(f.credentials, { environment: {}, command: name => name === 'glab' ? '/synthetic/glab' : null, execute: async (_cwd, _cmd, args) => { calls.push(args); if (args.includes('--all')) return { stdout: '', stderr: 'unknown flag: --all synthetic-never-return', code: 1, digest: '' }; return output(auth); } });
  t.after(async () => connections.close());
  const [a, b] = await Promise.all([connections.gitlabHosts(f.directory), connections.gitlabAccounts(f.directory)]); assert(a.includes('code.example.test:8443')); assert(!a.includes('broken.example.test')); assert.equal(b.length, 2); assert.equal(calls.length, 2); assert.equal(b[1].cliHost, 'Code.Example.Test:8443'); assert(!JSON.stringify(b).includes('synthetic'));
  assert.deepEqual(await connections.gitlabHosts(f.directory), a); assert.equal(calls.length, 2);
});
test('Explicit self-managed GitLab settings are versioned, replay-safe, removable and compatible with older credential files', async t => {
  const f = await setup(t), patch = { version: 0, requestId: 'add', gitlabHost: { host: 'Code.Example.Test:8443', enabled: true } };
  const settings = await f.credentials.update(patch); assert.deepEqual(settings.gitlabHosts, [{ host: 'code.example.test:8443', enabled: true }]); assert.deepEqual(await f.credentials.update(patch), settings);
  await assert.rejects(f.credentials.update({ ...patch, gitlabHost: { ...patch.gitlabHost, enabled: false } }), /请求已使用/);
  assert.equal((await f.credentials.update({ version: 1, requestId: 'disable', gitlabHost: { host: 'code.example.test:8443', enabled: false } })).gitlabHosts[0].enabled, false);
  assert.deepEqual((await f.credentials.update({ version: 2, requestId: 'remove', gitlabHost: { host: 'code.example.test:8443', enabled: null } })).gitlabHosts, []);
  const file = join(f.directory, 'source-control-credentials.json'), saved = JSON.parse(await readFile(file, 'utf8')); delete saved.gitlabHosts; await writeFile(file, JSON.stringify(saved)); assert.deepEqual((await f.credentials.settings()).gitlabHosts, []);
  for (const host of ['https://code.example.test', 'gitlab.com/path', 'github.com', 'bitbucket.org', 'residency.ghe.com', 'user:token@code.test']) assert.throws(() => sourceControlCredentialPatch({ version: 3, requestId: 'bad', gitlabHost: { host, enabled: true } }));
});
test('Provider collisions cannot redirect an already selected host to a different provider', async t => {
  const f = await setup(t); await f.credentials.update({ version: 0, requestId: 'github', githubToken: { host: 'code.example.test', token: 'synthetic-gh' } });
  await assert.rejects(f.credentials.update({ version: 1, requestId: 'gitlab', gitlabHost: { host: 'code.example.test', enabled: true } }), /属于 GitHub/);
  await f.credentials.update({ version: 1, requestId: 'other', gitlabHost: { host: 'lab.example.test', enabled: true } });
  await assert.rejects(f.credentials.update({ version: 2, requestId: 'collision', githubToken: { host: 'lab.example.test', token: 'synthetic-gh' } }), /属于 GitLab/);
  assert.equal(sourceControlRepository('https://unregistered.example.test/g/sub/repo.git'), undefined);
  assert.equal(sourceControlRepository('https://code.example.test/g/sub/repo.git', [], ['code.example.test'])?.provider, 'gitlab');
  assert.equal(sourceControlRepositoryOnHost('ssh://git@code.example.test:2222/g/sub/repo.git', { provider: 'gitlab', host: 'code.example.test' })?.path, 'g/sub/repo');
});
test('Unknown or disabled GitLab hosts cannot cause CLI API calls; a trusted host uses its exact CLI spelling', async t => {
  const f = await setup(t), calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const connections = new SourceControlConnections(f.credentials, { environment: {}, command: name => name === 'glab' ? '/synthetic/glab' : null, execute: async (_cwd, _cmd, args, opts) => { calls.push({ args, env: opts?.env ?? {} }); return args[0] === 'auth' ? output(auth) : output({ username: 'corporate.user', id: 17 }); } }); t.after(async () => connections.close());
  await assert.rejects(connections.pin(f.directory, 'gitlab', 'unregistered.example.test'), /先在 Source Control/); assert.equal(calls.filter(v => v.args[0] === 'api').length, 0);
  const pinned = await connections.pin(f.directory, 'gitlab', 'code.example.test:8443'); await pinned.json('user'); assert(calls.at(-1)!.args.includes('Code.Example.Test:8443')); assert.equal(calls.at(-1)!.env.GITLAB_API_HOST, 'code.example.test:8443');
  await assert.rejects(pinned.json('https://evil.example.test/user'), /请求路径无效/);
  await f.credentials.update({ version: 0, requestId: 'off', gitlabHost: { host: 'code.example.test:8443', enabled: false } }); const before = calls.length;
  await assert.rejects(connections.pin(f.directory, 'gitlab', 'code.example.test:8443'), /停用/); assert.equal(calls.length, before);
});
test('GitLab environment credentials and API routing stay with the configured host and remain frozen within a pin', async t => {
  const f = await setup(t); await f.credentials.update({ version: 0, requestId: 'lab', gitlabHost: { host: 'code.example.test', enabled: true } });
  const env: NodeJS.ProcessEnv = { GITLAB_TOKEN: 'synthetic-public', GITLAB_API_HOST: 'evil.example.test', CI_JOB_TOKEN: 'synthetic-ci', GITLAB_CI: 'true' }, calls: NodeJS.ProcessEnv[] = [];
  const connections = new SourceControlConnections(f.credentials, { environment: env, command: () => '/synthetic/glab', execute: async (_cwd, _cmd, args, options) => { if (args[0] === 'auth') return output(''); calls.push(options?.env ?? {}); return output({ username: 'fixture', id: 17 }); } }); t.after(async () => connections.close());
  await (await connections.pin(f.directory, 'gitlab', 'code.example.test')).json('user'); assert.equal(calls.at(-1)!.GITLAB_TOKEN, ''); assert.equal(calls.at(-1)!.CI_JOB_TOKEN, ''); assert.equal(calls.at(-1)!.GITLAB_API_HOST, 'code.example.test');
  env.GITLAB_HOST = 'code.example.test'; const pinned = await pinTaskChangeRequest(f.directory, sourceControlRepository('https://code.example.test/g/repo', [], ['code.example.test'])!, connections); env.GITLAB_TOKEN = 'synthetic-changed'; await pinned.json('user'); assert.equal(calls.at(-1)!.GITLAB_TOKEN, 'synthetic-public');
  await assert.rejects(pinTaskChangeRequest(f.directory, sourceControlRepository('https://code.example.test/g/repo', [], ['code.example.test'])!, connections, undefined, pinned.fingerprint), /凭据已改变/);
});
test('Self-managed GitLab repository publication and discovery bind host, nested namespace and SSH port', async t => {
  const f = await setup(t); await f.credentials.update({ version: 0, requestId: 'lab', gitlabHost: { host: 'code.example.test:8443', enabled: true } }); const writes: string[][] = [];
  const connections = new SourceControlConnections(f.credentials, { environment: {}, command: name => name === 'glab' ? '/synthetic/glab' : null, execute: async (_cwd, _cmd, args, options) => {
    if (args[0] === 'auth') return output(''); assert(args.includes('code.example.test:8443') || args.includes('gitlab.com'));
    const path = args.find(v => v === 'user' || v === 'projects' || v.startsWith('namespaces/')); if (path === 'user') return output({ username: 'fixture', id: 17 }); if (path?.startsWith('namespaces/')) return output({ id: 9 });
    assert.equal(options?.env?.GITLAB_API_HOST, 'code.example.test:8443'); writes.push(args); return output({ path_with_namespace: 'group/sub/repo', web_url: 'https://code.example.test:8443/group/sub/repo', ssh_url_to_repo: 'ssh://git@code.example.test:2222/group/sub/repo.git', http_url_to_repo: 'https://code.example.test:8443/group/sub/repo.git', visibility: 'private' });
  } }); t.after(async () => connections.close());
  const providers = await discoverPublishProviders(f.directory, undefined, connections); assert(providers.some(p => p.provider === 'gitlab' && p.host === 'code.example.test:8443' && p.status === 'ready'));
  const input = repositoryPublishInput({ provider: 'gitlab', host: 'code.example.test:8443', repository: 'group/sub/repo', visibility: 'private', remoteName: 'origin', protocol: 'ssh', account: 'fixture' });
  const publication = await createPublishedRepository(f.directory, input, undefined, connections); assert.equal(publication.remoteURL, 'ssh://git@code.example.test:2222/group/sub/repo.git'); assert.equal(writes.length, 1);
  await assert.rejects(createPublishedRepository(f.directory, { ...input, host: 'unregistered.example.test' }, undefined, connections), /先在 Source Control/); assert.equal(writes.length, 1);
});
test('A single settings update cannot create conflicting GitHub and GitLab mappings for one host', async t => {
  const f = await setup(t); await assert.rejects(f.credentials.update({ version: 0, requestId: 'both', githubToken: { host: 'code.example.test', token: 'synthetic-gh' }, gitlabHost: { host: 'code.example.test', enabled: true } }), /属于 GitHub/);
  assert.equal((await f.credentials.settings()).version, 0); assert.equal(sourceControlRepository('https://code.example.test/group/repo', ['code.example.test'], ['code.example.test']), undefined);
});
test('Self-managed GitLab rebases and merges use an explicit host-qualified repository outside its checkout', async t => {
  const f = await setup(t); await f.credentials.update({ version: 0, requestId: 'lab', gitlabHost: { host: 'code.example.test:8443', enabled: true } }); const calls: string[][] = [];
  const connections = new SourceControlConnections(f.credentials, { environment: {}, command: () => '/synthetic/glab', execute: async (_cwd, _cmd, args) => { calls.push(args); return output(''); } }); t.after(async () => connections.close());
  const pinned = await connections.pin(f.directory, 'gitlab', 'code.example.test:8443'); await pinned.gitLabBranchAction!('group/sub/repo', 17, 'update-branch', 'rebase'); await pinned.mergeGitLab!('group/sub/repo', 17, 'squash');
  assert(calls.filter(v => v[0] === 'mr').every(args => args[args.indexOf('--repo') + 1] === 'https://code.example.test:8443/group/sub/repo'));
  assert.equal(sourceControlRepository('ssh://git@code.example.test:2222/group/sub/repo.git', [], ['code.example.test:8443'])?.host, 'code.example.test:8443');
});
test('Binary Source Control reads preserve non-UTF8 bytes, enforce response limits and refuse credential redirects', async t => {
  const f = await setup(t), data = Uint8Array.from([137, 0, 255, 80]); let redirect = false;
  const connections = new SourceControlConnections(f.credentials, { environment: { FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-binary' }, command: () => null, request: async address => {
    assert.equal(new URL(String(address)).host, 'api.bitbucket.org'); return redirect ? new Response(null, { status: 302, headers: { location: 'https://evil.test/object' } }) : new Response(data);
  } }); t.after(async () => connections.close()); const pinned = await connections.pin(f.directory, 'bitbucket');
  assert.deepEqual(Buffer.from(await pinned.bytes!('repositories/owner/repo/src/' + 'a'.repeat(40) + '/image.png')), Buffer.from(data));
  await assert.rejects(pinned.bytes!('repositories/owner/repo/file', { maxResponseBytes: 1 }), /内容过大/); redirect = true; await assert.rejects(pinned.bytes!('repositories/owner/repo/file'), /不受信任/);
});
