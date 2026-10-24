import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { defaultPiSettings } from '../src/pi-provider.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import type { WorkItem } from '../src/types.js';
// @ts-expect-error Independent native HTTP fixture.
import { openCodeFixture } from './fixtures/opencode.mjs';

for (const kind of ['pi', 'opencode-1', 'opencode-2'] as const) test(`${kind} Durable history survives fork, rewind, restart and a second rewind with the correct native ownership`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'friday-native-history-')), data = join(root, 'data'), cwd = join(root, 'workspace'); await mkdir(cwd);
  const agent: 'pi' | 'opencode' = kind === 'pi' ? 'pi' : 'opencode', model = agent === 'pi' ? 'fixture/small' : 'native/model';
  let engine = await new Engine(data, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  const http = agent === 'opencode' ? await openCodeFixture({ generation: kind.endsWith('1') ? 1 : 2, directory: cwd }) : undefined;
  t.after(async () => { await engine.close(); await http?.close(); await rm(root, { recursive: true, force: true }); });
  if (agent === 'pi') {
    const binary = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url)); await chmod(binary, 0o755);
    await engine.piConnection.save({ ...defaultPiSettings, enabled: true, binaryPath: binary, homePath: join(root, 'pi-account') });
  } else await engine.opencodeConnection.save({ ...nativeProviderDefaults('opencode'), enabled: true, serverUrl: http.url, serverPassword: '私有密码' });
  await engine.mutate(state => { state.projects = [{ id: 'p', path: cwd, name: 'History fixture', context: '' }]; });
  const input = { agent, model, mode: 'code' as const, projectId: 'p', title: 'History fixture' };
  const wait = async (id: string, ready: (work: WorkItem) => boolean) => {
    const end = Date.now() + 12_000;
    for (;;) { const work = (await engine.snapshot()).tasks.find(work => work.id === id)!; if (work && ready(work)) return work; if (Date.now() > end) throw new Error(JSON.stringify({ kind, status: work?.status, error: work?.error, fork: work?.forkOperation, rewind: work?.rewindOperation })); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const id = await engine.createTask({ ...input, prompt: 'first', requestId: 'first' }); await wait(id, work => work.status === 'completed');
  await engine.createTask({ ...input, continueId: id, prompt: 'second', requestId: 'second' });
  const source = await wait(id, work => work.status === 'completed' && work.runs?.length === 2);
  const childId = await engine.taskForks.start(id, { requestId: 'fork', runId: source.runs![0]!.id });
  const child = await wait(childId, work => !!work.forkOperation && !['queued', 'running'].includes(work.forkOperation.status));
  assert.equal(child.forkOperation!.status, 'completed', child.forkOperation!.error); assert.notEqual(child.threadId, source.threadId);
  assert.equal(child.providerInstanceId, source.providerInstanceId); assert.equal(child.piHome, source.piHome); assert.equal(child.nativeProviderAccount, source.nativeProviderAccount);
  const lazyId = await engine.taskForks.start(id, { requestId: 'lazy-fork', runId: source.runs![0]!.id, lazy: true });
  const lazy = await wait(lazyId, work => work.forkOperation?.status === 'completed');
  assert.equal(lazy.threadId, null); assert.equal(lazy.forkOperation?.dispatchPending, true);
  await engine.createTask({ ...input, continueId: lazyId, prompt: 'first lazy child turn', requestId: 'lazy-first-turn' });
  const lazyContinued = await wait(lazyId, work => work.status === 'completed' && work.runs?.some(run => !run.inheritedFrom) === true);
  assert.equal(lazyContinued.forkOperation?.status, 'completed', lazyContinued.forkOperation?.error);
  assert.ok(lazyContinued.threadId && lazyContinued.threadId !== source.threadId && lazyContinued.threadId !== child.threadId);
  assert.equal(lazyContinued.runs!.at(-1)!.threadId, lazyContinued.threadId);
  const rewind = async (taskId: string, messageId: string, requestId: string) => {
    const options = await engine.taskRewinds.options(taskId, messageId);
    await engine.taskRewinds.start(taskId, { requestId, messageId, fingerprint: options.fingerprint, restoreFiles: false });
    const work = await wait(taskId, work => !!work.rewindOperation && !['queued', 'running'].includes(work.rewindOperation.status));
    assert.equal(work.rewindOperation!.status, 'completed', work.rewindOperation!.error); return work;
  };
  const retained = await rewind(id, source.runs![1]!.messageId, 'rewind');
  assert.equal(retained.messages!.filter(message => !message.revertedAt && message.role === 'user').length, 1);
  assert.ok(retained.runs!.filter(run => !run.revertedAt).every(run => run.threadId === retained.threadId));
  await engine.close(); engine = await new Engine(data, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  await engine.createTask({ ...input, continueId: id, prompt: 'replacement', requestId: 'replacement' });
  const continued = await wait(id, work => work.status === 'completed' && work.runs?.length === 3);
  assert.equal(continued.threadId, retained.threadId);
  await rewind(id, continued.runs![2]!.messageId, 'rewind-again');
  const original = (await engine.snapshot()).tasks.find(work => work.id === childId)!;
  assert.equal(original.threadId, child.threadId, 'Source rewinds cannot rebind a fork');
  if (agent === 'pi') assert.equal(JSON.parse(await readFile(source.threadId!, 'utf8')).messages.length, 2, 'Native Pi source remains intact');
});
