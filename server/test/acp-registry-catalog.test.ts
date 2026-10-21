import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AcpRegistryCatalog, decodeAcpRegistry, resolveAcpDistribution, acpRegistryTarget, acpRegistryRank } from '../src/acp-registry-catalog.js';
import { nativeToolDownload, extractNativeToolArchive, nativeToolExecutable, nativeToolPath } from '../src/native-tool-archive.js';
const run = promisify(execFile);
const agent = (id = 'test-agent', changes: Record<string, unknown> = {}) => ({ id, name: id, version: '1.2.3', description: 'A coding agent', authors: ['Example authors'], distribution: { npx: { package: '@example/acp-agent@1.2.3', args: ['--acp'], env: { FIXTURE: 'native' } } }, ...changes });
const envelope = (agents: unknown[]) => JSON.stringify({ version: '1.0.0', agents });
async function directory(t: { after(fn: () => Promise<unknown>): void }) { const path = await mkdtemp(join(tmpdir(), 'friday-acp-registry-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('ACP Registry validates pinned distributions, identifiers, environment and archive commands before exposing an agent', () => {
  const binaries = { 'darwin-aarch64': { archive: 'https://example.test/agent.zip', cmd: './bin/agent', sha256: 'a'.repeat(64) } };
  const result = decodeAcpRegistry(envelope([agent('valid'), agent('binary', { distribution: { binary: binaries } }), agent('../escape'), agent('invalid-version', { version: '..' }), agent('floating', { distribution: { npx: { package: 'example@latest' } } }), agent('bad-env', { distribution: { npx: { package: 'example@1.2.3', env: { 'BAD=KEY': 'x' } } } }), agent('traversal', { distribution: { binary: { 'darwin-aarch64': { ...binaries['darwin-aarch64'], cmd: '../outside' } } } })]));
  assert.deepEqual(result.agents.map(value => value.id), ['valid', 'binary']); assert.throws(() => decodeAcpRegistry(envelope(Array(513).fill(agent())))); assert.throws(() => decodeAcpRegistry(' '.repeat(1024 * 1024 + 1)));
  assert.deepEqual(resolveAcpDistribution(result.agents[0]!, 'auto', 'darwin-aarch64'), { kind: 'npx', package: '@example/acp-agent@1.2.3', args: ['--acp'], env: { FIXTURE: 'native' } });
});
test('Registry platform fallback and search rank follow the fixed T3 preference order without probing or installing an agent', () => {
  const value = decodeAcpRegistry(envelope([agent('devin', { name: 'Devin Code', description: 'Search repository issues', distribution: { binary: { 'windows-x86_64': { archive: 'https://example.test/agent.zip', cmd: 'agent.exe' } }, npx: { package: 'agent@1.2.3' }, uvx: { package: 'agent==1.2.3' } } })])).agents[0]!;
  assert.equal(acpRegistryTarget('darwin', 'arm64'), 'darwin-aarch64'); assert.equal(acpRegistryTarget('freebsd', 'x64'), undefined); assert.equal(resolveAcpDistribution(value, 'auto', 'windows-aarch64')?.target, 'windows-x86_64'); assert.equal(resolveAcpDistribution(value, 'npx')?.kind, 'npx'); assert.equal(resolveAcpDistribution(value, 'uvx')?.package, 'agent==1.2.3');
  assert.deepEqual(['Devin', 'dev', 'dev co', 'example', 'repository issues', 'unrelated'].map(query => acpRegistryRank(value, query)), [0, 10, 20, 40, 50, undefined]);
});
test('Registry metadata reads coalesce, keep a private validated offline cache and return at most 20 compatible search matches', async t => {
  const path = await directory(t); let calls = 0, offline = false;
  const catalog = new AcpRegistryCatalog(path, { fetch: (async (_url, options) => { calls++; assert.equal(options?.redirect, 'error'); if (offline) throw new Error('offline'); await new Promise(resolve => setTimeout(resolve, 10)); return new Response(envelope(Array.from({ length: 30 }, (_, index) => agent('agent-' + index))), { headers: { 'Content-Type': 'application/json' } }); }) as typeof fetch });
  const [one, two] = await Promise.all([catalog.index(), catalog.index()]); assert.equal(calls, 1); assert.deepEqual(one, two); assert.equal((await catalog.search('')).agents.length, 20); assert.equal((await stat(join(path, 'acp-registry/index.json'))).mode & 0o777, 0o600);
  offline = true; const cached = new AcpRegistryCatalog(path, { fetch: (async () => { throw new Error('offline'); }) as typeof fetch }); assert.equal((await cached.agent('agent-1')).id, 'agent-1'); assert.equal((await cached.index(true)).agents.length, 30); await assert.rejects(cached.agent('../outside'), /标识/);
});
test('Registry rejects oversized streams and invalid UTF-8 before writing any cache', async t => {
  for (const body of [new Uint8Array(1024 * 1024 + 1), new Uint8Array([0xc3, 0x28])]) {
    const path = await directory(t), catalog = new AcpRegistryCatalog(path, { fetch: (async () => new Response(body)) as typeof fetch }); await assert.rejects(catalog.index(), /暂不可用/); await assert.rejects(readFile(join(path, 'acp-registry/index.json')), { code: 'ENOENT' });
  }
});
test('Managed tool downloads enforce streamed size, SHA-256 and HTTPS on every redirect', async t => {
  const path = await directory(t), payload = Buffer.from('native tool payload'), hash = createHash('sha256').update(payload).digest('hex'); let progress = 0;
  const fetch = (async () => new Response(payload)) as typeof globalThis.fetch;
  assert.equal((await nativeToolDownload('https://example.test/agent.zip', join(path, 'valid'), { sha256: hash, expectedBytes: payload.length, signal: new AbortController().signal, fetch, progress: bytes => { progress = bytes; } })).sha256, hash); assert.equal(progress, payload.length);
  await assert.rejects(nativeToolDownload('https://example.test/agent.zip', join(path, 'wrong-hash'), { sha256: '0'.repeat(64), signal: new AbortController().signal, fetch }), /校验/);
  await assert.rejects(nativeToolDownload('https://example.test/agent.zip', join(path, 'too-large'), { maximumBytes: 4, signal: new AbortController().signal, fetch }), /预算/);
  await assert.rejects(nativeToolDownload('https://example.test/agent.zip', join(path, 'redirect'), { signal: new AbortController().signal, fetch: (async () => new Response(null, { status: 302, headers: { Location: 'http://example.test/plain' } })) as typeof globalThis.fetch }), /HTTPS/);
});
test('Managed tool ZIP/tar extraction reads real archives and rejects escaping paths, links and executable aliases outside its root', async t => {
  const path = await directory(t), source = join(path, 'source'); await mkdir(join(source, 'bin'), { recursive: true }); await writeFile(join(source, 'bin/agent'), '#!/bin/sh\nprintf native');
  const zip = join(path, 'agent.zip'), tar = join(path, 'agent.tar.gz'); await run('/usr/bin/zip', ['-qr', zip, '.'], { cwd: source }); await run('/usr/bin/tar', ['-czf', tar, '.'], { cwd: source });
  for (const [archive, url, name] of [[zip, 'https://example.test/agent.zip', 'zip'], [tar, 'https://example.test/agent.tar.gz', 'tar']]) { const root = join(path, name!); await extractNativeToolArchive(archive!, root, url!, new AbortController().signal); const command = await nativeToolExecutable(root, './bin/agent'); assert.equal((await run(command)).stdout, 'native'); }
  for (const name of ['../out', '/absolute', 'drive:path', 'a/../../out', 'a\\out', 'a\nother']) assert.throws(() => nativeToolPath(name));
  await symlink(join(path, 'outside'), join(source, 'escape')); const linked = join(path, 'linked.zip'); await run('/usr/bin/zip', ['-qry', linked, '.'], { cwd: source }); await assert.rejects(extractNativeToolArchive(linked, join(path, 'reject-link'), 'https://example.test/linked.zip', new AbortController().signal), /非普通文件/);
  const linkedTar = join(path, 'linked.tar.gz'); await run('/usr/bin/tar', ['-czf', linkedTar, '.'], { cwd: source }); await assert.rejects(extractNativeToolArchive(linkedTar, join(path, 'reject-tar'), 'https://example.test/linked.tar.gz', new AbortController().signal), /链接/);
});
