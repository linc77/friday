import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defaultPiSettings } from '../src/pi-provider.js';
import { providerInstanceID } from '../src/provider-instances.js';
import { composerWorkspace } from '../src/provider-workspace.js';

const binary = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
async function setup(t: { after(fn: () => Promise<unknown>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-instances-')), cwd = join(directory, 'workspace'); await mkdir(cwd);
  let engine: Engine | undefined = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine?.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Instance fixture', path: cwd, context: '' }]; });
  const add = async (id: string) => {
    await engine!.providerInstances.change({ operation: 'create', instanceId: id, instance: { driver: 'pi', displayName: id, enabled: true } });
    const connection = await engine!.providerInstances.get('pi', id), defaults = defaultPiSettings;
    await chmod(binary, 0o755);
    await connection.save({ ...defaults, enabled: true, binaryPath: binary, homePath: join(directory, id + '-sessions'), environment: [{ name: 'PI_TEST_WIRE', value: join(directory, id + '.jsonl') }, { name: 'INSTANCE_SECRET', value: id + '-private-secret' }] });
    return connection;
  };
  return { directory, cwd, current: () => engine!, add, restart: async () => { await engine!.close(); engine = undefined; engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open(); return engine; } };
}
async function complete(engine: Engine, id: string) {
  const end = Date.now() + 15000;
  for (;;) {
    const task = (await engine.snapshot()).tasks.find(task => task.id === id)!;
    if (!['queued', 'running', 'waiting'].includes(task.status)) { assert.equal(task.status, 'completed', task.error ?? 'Task failed'); return task; }
    if (Date.now() > end) throw new Error('Instance fixture timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
test('instances isolate native sessions, task routing, catalogs and credentials across service restart', async t => {
  const fixture = await setup(t); let engine = fixture.current();
  const first = await fixture.add('pi_one'), second = await fixture.add('pi_two');
  assert.notEqual(first, second); assert.notEqual(first.directory, second.directory); assert.notEqual(first.directory, engine.directory);
  assert.equal(await engine.providerInstances.get('pi', 'pi_one'), first);
  const input = { prompt: 'reply', title: 'Instance fixture', projectId: 'project', mode: 'code' as const, agent: 'pi' as const, model: 'fixture/small', modelOptions: [] };
  const ids = await Promise.all(['pi_one', 'pi_two'].map(providerInstanceId => engine.createTask({ ...input, providerInstanceId, requestId: providerInstanceId })));
  const tasks = await Promise.all(ids.map(id => complete(engine, id)));
  assert.notEqual(tasks[0].threadId, tasks[1].threadId);
  assert.deepEqual(tasks.map(task => task.providerInstanceId), ['pi_one', 'pi_two']);
  assert.deepEqual(tasks[0].modelOptions, input.modelOptions);
  assert.deepEqual(tasks[0].runs?.[0].modelOptions, input.modelOptions);
  await assert.rejects(engine.createTask({ ...input, continueId: ids[0], providerInstanceId: 'pi_two', requestId: 'wrong-instance' }), /不能切换/);
  await assert.rejects(engine.providerInstances.get('claude', 'pi_one'), /原实例/);
  await assert.rejects(composerWorkspace(engine, { provider: 'pi', taskId: ids[0], providerInstanceId: 'pi_two' }), /实例/);
  const catalog = await composerWorkspace(engine, { provider: 'pi', taskId: ids[0] }); assert.equal(catalog.providerInstanceId, 'pi_one');
  await assert.rejects(engine.providerInstances.change({ operation: 'remove', instanceId: 'pi_one' }), /关联任务/);
  engine = await fixture.restart();
  await engine.createTask({ ...input, continueId: ids[0], requestId: 'after-restart' });
  const continued = await complete(engine, ids[0]); assert.equal(continued.threadId, tasks[0].threadId); assert.equal(continued.providerInstanceId, 'pi_one'); assert.deepEqual(continued.modelOptions, input.modelOptions);
  for (let index = 0; index < 2; index++) {
    const own = join(fixture.directory, ['pi_one', 'pi_two'][index] + '-sessions');
    assert.ok(tasks[index].threadId!.startsWith(own));
    const trace = (await readFile(join(fixture.directory, ['pi_one', 'pi_two'][index] + '.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(trace.filter(value => value.type === 'prompt').length, index === 0 ? 2 : 1);
  }
  assert.equal((await stat(join(fixture.directory, 'provider-instances.json'))).mode & 0o777, 0o600);
});
test('owner controls instance configuration; paired metadata redacts secrets and cannot alias removed or default identities', async t => {
  const fixture = await setup(t), engine = fixture.current(); await fixture.add('pi_one');
  const auth = new Auth(fixture.directory), api = createAPI(engine, auth, () => []);
  const owner = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' }, paired = { Authorization: 'Bearer ' + auth.pair(auth.createPairing().code, 'paired', '127.0.0.1').token, 'Content-Type': 'application/json' };
  const inventory = await api.request('/api/provider-instances', { headers: paired }); assert.equal(inventory.status, 200); assert.ok(!(await inventory.text()).includes('storageKey'));
  const status = await api.request('/api/agents/pi?instanceId=pi_one', { headers: paired }); assert.equal(status.status, 200); assert.ok(!(await status.text()).includes('pi_one-private-secret'));
  assert.equal((await api.request('/api/provider-instances', { method: 'PUT', headers: paired, body: '{}' })).status, 403);
  assert.equal((await api.request('/api/agents/pi/settings?instanceId=pi_one', { method: 'PUT', headers: paired, body: '{}' })).status, 403);
  assert.equal((await api.request('/api/agents/pi?instanceId=claude', { headers: owner })).status, 400);
  await assert.rejects(engine.providerInstances.change({ operation: 'remove', instanceId: 'pi' }), /默认/);
  await engine.providerInstances.change({ operation: 'remove', instanceId: 'pi_one' });
  assert.ok(!(await engine.providerInstances.list()).some(value => value.instanceId === 'pi_one'));
  await assert.rejects(engine.providerInstances.get('pi', 'pi_one'), /原实例/);
  await assert.rejects(engine.providerInstances.change({ operation: 'create', instanceId: 'pi_one', instance: { driver: 'claude', displayName: 'Other account', enabled: true } }), /已使用/);
  for (const value of ['../elsewhere', 'a/b', '__proto__', 'a'.repeat(65), '', 1]) assert.throws(() => providerInstanceID(value));
});
