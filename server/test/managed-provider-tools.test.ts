import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ManagedProviderTools, type ManagedToolArchive, type ManagedToolPackage } from '../src/managed-provider-tools.js';
const run = promisify(execFile);
async function setup(t: { after(fn: () => Promise<unknown>): void }, fetch?: typeof globalThis.fetch, manager?: (kind: 'npx' | 'uvx') => string | null) { const directory = await mkdtemp(join(tmpdir(), 'friday-managed-tools-')), tools = new ManagedProviderTools(directory, { fetch, manager }); t.after(async () => { await tools.close(); await rm(directory, { recursive: true, force: true }); }); return { tools, directory }; }
const payload = Buffer.from('#!/bin/sh\nprintf managed-native'), sha256 = createHash('sha256').update(payload).digest('hex');
const archive: ManagedToolArchive = { tool: 'fixture-acp', version: '1.2.3', url: 'https://example.test/fixture.bin', sha256, archiveBytes: payload.length, files: [{ name: 'bin/agent', bytes: payload.length }] };
test('A managed binary publishes a private complete receipt once, survives restart and cannot be removed while leased', async t => {
  let downloads = 0; const { tools, directory } = await setup(t, (async () => { downloads++; return new Response(payload); }) as typeof fetch);
  assert.equal(await tools.installedArchive(archive), undefined); assert.equal(downloads, 0);
  const one = tools.prepareArchive(archive), two = tools.prepareArchive(archive); assert.equal(one, two); const installed = await one; assert.equal(downloads, 1); assert.equal((await run(installed.command)).stdout, 'managed-native'); assert.equal(tools.state(archive.tool).phase, 'complete');
  const receipt = join(installed.directory, '.install-complete.json'); assert.equal((await stat(receipt)).mode & 0o777, 0o600); assert.ok(JSON.parse(await readFile(receipt, 'utf8')).binding);
  const restarted = new ManagedProviderTools(directory); t.after(() => restarted.close()); assert.equal((await restarted.installedArchive(archive))?.command, installed.command);
  const lease = await tools.acquire(installed); await assert.rejects(tools.remove(archive.tool), /仍被/); await lease.close(); await lease.close(); await tools.remove(archive.tool); assert.equal(await tools.installedArchive(archive), undefined);
});
test('Hash failure and cancelled downloads leave no accepted install or staging files and never replace another leased version', async t => {
  const { tools, directory } = await setup(t, (async () => new Response(payload)) as typeof fetch);
  await assert.rejects(tools.prepareArchive({ ...archive, sha256: '0'.repeat(64) }), /校验/); assert.equal(tools.state(archive.tool).phase, 'failed'); assert.equal(await tools.installedArchive(archive), undefined);
  assert.deepEqual(await readdir(join(directory, 'tools', archive.tool, 'versions')), []);
  let wake!: () => void; const began = new Promise<void>(resolve => { wake = resolve; });
  const slow = new ManagedProviderTools(directory, { fetch: (async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); wake(); } }))) as typeof fetch }); t.after(() => slow.close());
  const pending = slow.prepareArchive(archive); void pending.catch(() => {}); await began;
  await assert.rejects(slow.prepareArchive({ ...archive, version: 'other' }), /取消/); await slow.cancel(archive.tool, slow.state(archive.tool).operationId!); await assert.rejects(pending); assert.equal(slow.state(archive.tool).phase, 'cancelled'); assert.deepEqual(await readdir(join(directory, 'tools', archive.tool, 'versions')), []);
});
test('Pinned npm and uv installations use private paths, verify versions and remain executable after their receipt is committed', async t => {
  const manager = fileURLToPath(new URL('./fixtures/acp-package-manager.mjs', import.meta.url)); await chmod(manager, 0o755); const { tools } = await setup(t, undefined, () => manager);
  for (const kind of ['npx', 'uvx'] as const) {
    const input: ManagedToolPackage = { tool: 'fixture-' + kind, version: '1.2.3', kind, package: kind === 'npx' ? '@fixture/fixture-agent@1.2.3' : 'fixture-agent==1.2.3', candidates: ['fixture-agent'] };
    assert.equal(await tools.installedPackage(input), undefined); const installed = await tools.preparePackage(input); assert.equal((await run(installed.command)).stdout.trim(), kind === 'npx' ? 'npm-private-native' : 'uv-private-native'); assert.equal((await tools.installedPackage(input))?.command, installed.command); assert.ok(!installed.command.includes('.install-'));
  }
  await assert.rejects(tools.preparePackage({ tool: 'floating', version: 'latest', kind: 'npx', package: 'fixture@latest', candidates: ['fixture'] }), /准确版本/);
});
