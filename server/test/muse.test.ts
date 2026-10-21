import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MuseConnection, museModels, museServeArgs } from '../src/muse-provider.js';
import { MuseExecutor, museApprovalChoices, museQuestionAnswers } from '../src/muse.js';
import { nativeProviderDefaults } from '../src/native-provider-config.js';
import type { WorkItem, ExecutionUpdate } from '../src/types.js';
const binary = fileURLToPath(new URL('./fixtures/muse.mjs', import.meta.url));
const task = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'muse-task', agent: 'muse', cwd, model: 'muse-native', reasoningEffort: 'high', threadId: null, currentRunId: 'muse-run', interactionMode: 'default', events: [], approvals: [], ...changes }) as WorkItem;
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-muse-')), wire = join(directory, 'wire.jsonl'), home = join(directory, 'sessions'), connection = new MuseConnection(directory), executor = new MuseExecutor(connection); await chmod(binary, 0o755);
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...nativeProviderDefaults('muse'), enabled: true, binaryPath: binary, environment: Object.entries({ MUSE_TEST_WIRE: wire, MUSE_TEST_HOME: home, META_API_KEY: 'fixture-must-not-reach-muse', ...environment }).map(([name, value]) => ({ name, value })) });
  const trace = async () => (await readFile(wire, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, wire, home, connection, executor, trace };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await read()) { if (Date.now() > end) throw new Error('Muse fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }
test('Muse model capabilities preserve explicit empty variants and the pinned unknown-variant defaults; native permissions keep scope and stage', () => {
  const models = museModels({ providerId: 'meta', models: [{ modelId: 'unknown', providerId: 'meta', displayLabel: 'muse-native', variants: 'unknown' }, { modelId: 'plain', providerId: 'meta', variants: [] }] });
  assert.deepEqual(models[0]!.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']); assert.equal(models[0]!.defaultReasoningEffort, 'high'); assert.deepEqual(models[1]!.reasoningEfforts, []);
  assert.deepEqual(museServeArgs(true), ['serve', '--disable-shell', '--disable-write', '--no-session-log']); assert.deepEqual(museServeArgs(false, 'auto'), ['serve', '--trust-workspace', '--disable-sandbox']);
  const choices = museApprovalChoices({ availableChoices: [{ choiceId: 'always', decision: 'approvedPolicyAmendment', scope: 'localPersistent' }, { choiceId: 'abort', decision: 'abort', scope: 'once' }] }); assert.equal(choices.get('acceptAlways')?.choiceId, 'always'); assert.equal(choices.get('decline')?.choiceId, 'abort');
  assert.deepEqual(museQuestionAnswers([{ id: 'q', options: [{ label: 'One' }], selection: { mode: 'multiple' } }], { q: ['One', 'Note'] }), [{ questionId: 'q', selectedLabels: ['One'], note: 'Note' }]);
});
test('Muse uses the actual installed SDK for read-only discovery and never treats a cached catalog as proof of authentication', async t => {
  const { connection, directory, trace } = await setup(t); const status = await connection.status(true); assert.equal(status.connected, true); assert.equal(status.account, null); assert.deepEqual(status.models.map(value => value.id), ['muse-native', 'muse-no-thinking']);
  assert.ok(!JSON.stringify(status).includes('fixture-must-not-reach-muse')); assert.equal((await connection.status(false)).settings, null);
  const catalog = await connection.workspace(directory); assert.deepEqual(catalog.commands.map(value => value.name), ['compact']);
  const records = await trace(); assert.ok(records.every(value => !value.receivedMetaKey)); assert.ok(!records.some(value => value.method === 'session/start')); assert.ok(records.some(value => value.method === 'model/list' && value.args.includes('--disable-write')));
});
test('Muse MSP streams revisioned items and real context usage, saves native IDs before dispatch and resumes without replaying history', async t => {
  const { connection, executor, directory, trace } = await setup(t), updates: ExecutionUpdate[] = []; let sessionId = '', account = '';
  const update = async (value: ExecutionUpdate) => { updates.push(value); if (value.kind === 'session') { sessionId = value.threadId; account = value.nativeProviderAccount!; } };
  const result = await executor.run({ task: task(directory), prompt: 'reply', signal: new AbortController().signal, update, beforeStart: async () => { assert.ok(sessionId && account); } }); assert.equal(result, 'Muse reply café\u2028line\u2029end');
  assert.ok(updates.some(value => value.kind === 'contextUsage' && value.usage?.usedTokens === 321)); assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.detail === 'native output' && value.item.exitCode === 0));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'message' && value.item.phase === 'final_answer')); assert.ok(!JSON.stringify(updates).includes('Foreign Muse text') && !JSON.stringify(updates).includes('Stale revision'));
  const native = sessionId; updates.length = 0;
  await executor.run({ task: task(directory, { threadId: native, nativeProviderAccount: account }), prompt: 'continue', signal: new AbortController().signal, update }); assert.equal(sessionId, native); assert.ok(!JSON.stringify(updates).includes('Loaded Muse history'));
  const records = await trace(); assert.ok(records.some(value => value.method === 'session/resume' && value.params.permissionProfile === ':ask-me')); assert.ok(records.some(value => value.method === 'turn/start' && value.params.reasoningEffort === 'high'));
  await assert.rejects(executor.run({ task: task(directory, { nativeProviderAccount: 'different' }), prompt: 'reply', signal: new AbortController().signal, update }), /账号配置/);
});
test('Muse native approvals and user answers use requirement IDs and SDK commands and wait for the host acknowledgement', async t => {
  const { executor, directory, trace } = await setup(t); let answer: Promise<void> | undefined;
  const update = async (value: ExecutionUpdate) => { if (value.kind === 'approval') answer = new Promise<void>((resolve, reject) => setImmediate(() => { void executor.answer('muse-task', value.approval.id, value.approval.questions?.length ? 'accept' : 'acceptForSession', { target: ['One', 'Two', 'Note'] }).then(resolve, reject); })); };
  await executor.run({ task: task(directory), prompt: 'approval', signal: new AbortController().signal, update }); await answer;
  await executor.run({ task: task(directory), prompt: 'question', signal: new AbortController().signal, update }); await answer;
  const records = await trace(); const permission = records.find(value => value.method === 'approval/decide'); assert.equal(permission.params.choiceId, 'session'); assert.equal(permission.params.requirementId.sourceIndex, 1); assert.ok(permission.params.commandId);
  assert.deepEqual(records.find(value => value.method === 'userInput/answer').params.answers, [{ questionId: 'target', selectedLabels: ['One', 'Two'], note: 'Note' }]);
});
test('Muse Steer uses expectedTurnId and one native command per request while cancellation stops its actual SDK process group', async t => {
  const { executor, directory, trace } = await setup(t), controller = new AbortController();
  const running = executor.run({ task: task(directory), prompt: 'hold', signal: controller.signal, update: async () => {} });
  await until(async () => (await trace()).some(value => value.child)); const child = (await trace()).find(value => value.child).child;
  await Promise.all([executor.steer('muse-task', 'Additional instruction', 'steer-one'), executor.steer('muse-task', 'Additional instruction', 'steer-one')]); assert.equal((await trace()).filter(value => value.method === 'turn/steer').length, 1);
  controller.abort(); await assert.rejects(running, /已中止/); assert.ok((await trace()).some(value => value.interrupted));
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
});
test('Muse native compaction uses the separate command and accepts no-op/error as failure without inventing a reply', async t => {
  const { executor, directory, trace } = await setup(t), updates: ExecutionUpdate[] = [];
  assert.equal(await executor.run({ task: task(directory), prompt: 'Friday context must not become a compact instruction', command: 'compact', signal: new AbortController().signal, update: async value => { updates.push(value); } }), '');
  assert.ok((await trace()).some(value => value.method === 'session/compact')); assert.ok(!(await trace()).some(value => value.method === 'turn/start'));
  await assert.rejects(executor.run({ task: task(directory), prompt: 'error', signal: new AbortController().signal, update: async () => {} }), /Native Muse failure/);
});
