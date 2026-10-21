import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPiSettings, PiConnection, piLaunchArgs, piModelInventory, validatePiSettings } from '../src/pi-provider.js';
import { PiExecutor } from '../src/pi.js';
import { piFramer } from '../src/pi-rpc.js';
import type { ExecutionUpdate, WorkItem } from '../src/types.js';
import { terminalProviderEnvironment } from '../src/terminal-provider-environment.js';

const fixture = fileURLToPath(new URL('./fixtures/pi.mjs', import.meta.url));
const work = (cwd: string, changes: Partial<WorkItem> = {}) => ({ id: 'pi-task', agent: 'pi', cwd, title: 'Pi fixture', model: 'fixture/small', reasoningEffort: 'medium', currentRunId: 'pi-run-1', events: [], approvals: [], threadId: null, interactionMode: 'default', ...changes }) as WorkItem;
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-pi-')), connection = new PiConnection(directory), executor = new PiExecutor(connection), wire = join(directory, 'wire.jsonl');
  t.after(async () => { await executor.close(); await rm(directory, { recursive: true, force: true }); });
  await chmod(fixture, 0o755);
  await connection.save({ ...defaultPiSettings, enabled: true, binaryPath: fixture, homePath: join(directory, 'account'), environment: [{ name: 'PI_TEST_WIRE', value: wire }] });
  const trace = async () => (await readFile(wire, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, connection, executor, trace };
}
async function until(read: () => Promise<boolean>) { const end = Date.now() + 5000; while (!await read()) { if (Date.now() > end) throw new Error('Pi fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('Pi JSONL framing preserves Unicode separators and discards only an oversized LF frame', () => {
  const frame = piFramer(80);
  assert.deepEqual(frame('{"text":"café\u2028line\u2029end"}\r'), []);
  assert.deepEqual(frame('\n'), ['{"text":"café\u2028line\u2029end"}']);
  assert.deepEqual(frame('x'.repeat(100) + '\n{"next":true}\n'), ['{"next":true}']);
});
test('Pi model reasoning options follow native per-model maps and custom model IDs imply no capabilities', async () => {
  const inputs = [{ provider: 'f', id: 'base', reasoning: true }, { provider: 'f', id: 'extra', reasoning: true, thinkingLevelMap: { high: null, xhigh: 9999, max: null } }, { provider: 'f', id: 'plain', reasoning: false }];
  const models = piModelInventory({ models: inputs }, { model: inputs[1], thinkingLevel: 'high' });
  assert.deepEqual(models[1]!.reasoningEfforts, ['off', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(models[2]!.reasoningEfforts, ['off', 'minimal', 'low', 'medium', 'xhigh']); assert.equal(models[2]!.defaultReasoningEffort, 'xhigh');
  assert.deepEqual(models[3]!.reasoningEfforts, []); assert.throws(() => piModelInventory({ models: [{}] }, {}), /原生身份/);
  for (const args of ['--mode rpc', '--session x', '--print hello', 'prompt', '@file', '--model', '--resume', '-- --not-a-flag']) assert.throws(() => piLaunchArgs(args), /参数|提示词/);
  assert.deepEqual(piLaunchArgs('--model=provider/model --thinking high --custom-extension-flag="a b" --offline'), ['--model', 'provider/model', '--thinking', 'high', '--custom-extension-flag=a b', '--offline']);
  assert.throws(() => validatePiSettings({ ...defaultPiSettings, permissionMode: 'plan' }), /权限|规划/);
  assert.equal(validatePiSettings({ ...defaultPiSettings, permissionMode: 'acceptEdits' }).permissionMode, 'acceptEdits');
});
test('Pi owner settings redact credentials, preserve masked secrets, discover real commands and keep terminal account identity', async t => {
  const { directory, connection } = await setup(t);
  await connection.save({ ...defaultPiSettings, enabled: true, binaryPath: fixture, homePath: join(directory, 'account'), environment: [{ name: 'FIXTURE_KEY', value: 'never-public' }], customModels: [{ id: 'custom/model', name: 'Custom' }] });
  const owner = await connection.status(true), remote = await connection.status(false);
  assert.equal(owner.connected, true); assert.equal(remote.settings, null); assert.equal(owner.settings!.environment[0]!.value, null); assert.ok(!JSON.stringify(owner).includes('never-public'));
  assert.deepEqual(owner.models.find(value => value.id === 'custom/model')?.reasoningEfforts, []);
  await connection.save(owner.settings); assert.equal(JSON.parse(await readFile(join(directory, 'pi-provider.json'), 'utf8')).environment[0].value, 'never-public');
  const workspace = await connection.workspace(directory); assert.equal(workspace.commands[0]!.name, 'compact'); assert.equal(workspace.commands[1]!.name, 'native-command'); assert.equal(workspace.skills[0]!.name, 'fixture');
  const environment = await terminalProviderEnvironment(directory, { agent: 'pi', piHome: join(directory, 'account') }); assert.equal(environment.FIXTURE_KEY, 'never-public');
  await assert.rejects(terminalProviderEnvironment(directory, { agent: 'pi', piHome: join(directory, 'other') }), /配置已改变/);
});
test('Pi persists the native session before prompt, streams Unicode output and resumes the same native file', async t => {
  const { directory, connection, executor, trace } = await setup(t), before = join(directory, 'external-start');
  const saved = (await connection.status(true)).settings!; await connection.save({ ...saved, environment: [...saved.environment, { name: 'PI_TEST_BEFORE_START', value: before }] });
  const updates: ExecutionUpdate[] = []; let threadId = '';
  const run = (task: WorkItem) => executor.run({ task, prompt: 'reply', signal: new AbortController().signal, update: async value => { updates.push(value); if (value.kind === 'session') threadId = value.threadId; }, beforeStart: async () => { assert.ok(threadId); await writeFile(before, threadId); } });
  assert.equal(await run(work(directory)), 'Pi reply café\u2028line\u2029end');
  const first = threadId; assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'reasoning'));
  assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'command' && value.item.status === 'completed' && value.item.detail === 'fixture'));
  assert.ok(updates.some(value => value.kind === 'contextUsage' && value.usage?.usedTokens === 123 && value.usage.maxTokens === 8192));
  await run(work(directory, { currentRunId: 'pi-run-2', threadId: first, piHome: join(directory, 'account') })); assert.equal(threadId, first);
  const records = await trace(), prompts = records.filter(value => value.type === 'prompt'); assert.equal(prompts.length, 2); assert.ok(prompts.every(value => value.sessionFile === first));
  assert.ok(records.some(value => value.type === 'switch_session' && value.sessionPath === first));
  await assert.rejects(run(work(directory, { piHome: join(directory, 'other') })), /配置目录/);
});
test('Pi native approval and question responses retain native IDs and session grants survive continued rounds', async t => {
  const { directory, executor, trace } = await setup(t); let threadId = '', approvals = 0;
  const update = async (value: ExecutionUpdate) => {
    if (value.kind === 'session') threadId = value.threadId;
    if (value.kind === 'approval') { approvals++; await executor.answer('pi-task', value.approval.id, 'acceptForSession', value.approval.questions.length ? { [value.approval.questions[0]!.id]: ['Two'] } : {}); }
  };
  assert.equal(await executor.run({ task: work(directory), prompt: 'approval', signal: new AbortController().signal, update }), 'Approved native reply');
  assert.equal(await executor.run({ task: work(directory, { threadId }), prompt: 'approval', signal: new AbortController().signal, update }), 'Approved native reply'); assert.equal(approvals, 1);
  await executor.run({ task: work(directory, { threadId }), prompt: 'question', signal: new AbortController().signal, update }); assert.equal(approvals, 2);
  const records = await trace(); assert.ok(records.some(value => value.type === 'extension_ui_response' && value.value === 'Two')); assert.ok(records.some(value => value.nativeResponse?.confirmed === true));
});
test('Pi cancellation terminates its real process group and native errors do not complete as successful text', async t => {
  const { directory, executor, trace } = await setup(t), controller = new AbortController();
  const running = executor.run({ task: work(directory), prompt: 'hold', signal: controller.signal, update: async () => {} });
  await until(async () => (await trace()).some(value => value.child)); const child = (await trace()).find(value => value.child)!.child;
  controller.abort(); await assert.rejects(running, /已中止/);
  await until(async () => { try { process.kill(child, 0); return false; } catch { return true; } });
  await assert.rejects(executor.run({ task: work(directory), prompt: 'error', signal: new AbortController().signal, update: async () => {} }), /Native model failure/);
});
