import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { defaultCodexSettings, saveCodexSettings, saveProviderSettings } from '../src/codex-settings.js';
import { defaultClaudeSettings } from '../src/claude-provider.js';
import type { ModelStatus } from '../src/codex-provider.js';
import { defaultSourceControlWritingStyle, defaultTextGenerationModel, resolveTextGenerationSettings, textGenerationSettingsChange, TextGenerationSettingsConflict, type TextGenerationModelSelection } from '../src/text-generation-settings.js';
import { readTaskGitStatus } from '../src/task-git-status.js';
import type { Executor, ExecutionRequest, TextGenerationRequest, Workspace } from '../src/types.js';

const exec = promisify(execFile);
const model = (agent: 'codex' | 'claude', model: string): TextGenerationModelSelection => ({ agent, model, reasoningEffort: 'low' });
const profile = (provider: string, connected = true): ModelStatus => ({ provider, displayName: provider, enabled: true, connected, installed: connected, version: null, account: null,
  models: [], checkedAt: new Date().toISOString(), error: null, loginPending: false, settings: null, model: '' });
const empty = (): Workspace => ({ revision: 0, tasks: [], ideas: [], memories: [], requests: {}, projects: [{ id: 'project', name: 'Project', path: '/tmp', context: '' }] });
test('text selection accepts every supported native generator, rejects Registry and falls back to an enabled additional driver', () => {
  for (const agent of ['pi', 'grok', 'cursor', 'muse', 'opencode', 'antigravity']) {
    const result = textGenerationSettingsChange({ projectId: null, expectedVersion: 0, changes: { textGenerationModelSelection: { agent, model: 'native-model', reasoningEffort: '' } } });
    assert.equal(result.changes.textGenerationModelSelection?.agent, agent);
  }
  assert.throws(() => textGenerationSettingsChange({ projectId: null, expectedVersion: 0, changes: { textGenerationModelSelection: { agent: 'acp-registry', model: 'native-model', reasoningEffort: '' } } }), /Provider/);
  assert.equal(resolveTextGenerationSettings(empty(), null, { codex: false, claude: false, pi: true }).effective.textGenerationModelSelection.agent, 'pi');
});
async function until(read: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000; while (!await read()) { if (Date.now() > deadline) throw new Error('Text generation did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
class Writer implements Executor {
  titles: TextGenerationRequest[] = []; git: ExecutionRequest[] = [];
  title: (request: TextGenerationRequest) => Promise<string> = async () => '{"title":"Generated title"}';
  gitText: (request: ExecutionRequest) => Promise<string> = async () => '{"subject":"Generated commit","body":""}';
  async run(request: ExecutionRequest) {
    if (request.purpose === 'git_text') {
      this.git.push(request); await request.update({ kind: 'session', threadId: 'writer-session' }); await request.update({ kind: 'turn', turnId: 'writer-turn' }); return this.gitText(request);
    }
    await request.update({ kind: 'session', threadId: 'main-session' }); await request.update({ kind: 'turn', turnId: 'main-turn' }); return 'Original answer';
  }
  async generateText(request: TextGenerationRequest) {
    this.titles.push(request); await request.update({ kind: 'session', threadId: 'title-session-' + this.titles.length });
    await request.update({ kind: 'turn', turnId: 'title-turn-' + this.titles.length }); return this.title(request);
  }
  async answer() {} async steer() {}
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-text-settings-'))); const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
  const executor = new Writer(); let engine = await new Engine(directory, executor).open();
  const profiles = () => { engine.codexConnection.status = async () => profile('Codex'); engine.claudeConnection.status = async () => profile('Claude'); }; profiles();
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }));
  t.after(async () => { await engine.close(); await rm(base, { recursive: true, force: true }); });
  return { directory, cwd, executor, get engine() { return engine; },
    reopen: async () => { await engine.close(); engine = await new Engine(directory, executor).open(); profiles(); },
    save: async (changes: object, projectId: string | null = null, reset: string[] = []) => engine.textGeneration.save({ projectId, expectedVersion: (await engine.snapshot()).textGenerationSettings?.version ?? 0, changes, reset }),
  };
}
test('additional generator instances freeze their own selection and cannot inherit foreground account bindings or options', async t => {
  const f = await setup(t);
  await f.engine.providerInstances.change({ operation: 'create', instanceId: 'pi_writer', instance: { driver: 'pi', displayName: 'Writer', enabled: true } });
  const directory = await f.engine.providerInstances.configDirectory('pi', 'pi_writer');
  await saveProviderSettings(directory, 'pi-provider.json', { ...defaultCodexSettings, displayName: 'Pi', enabled: true });
  const selected = { agent: 'pi', providerInstanceId: 'pi_writer', model: 'fixture/small', reasoningEffort: 'high', modelOptions: [{ id: 'reasoningEffort', value: 'high' }] };
  await f.save({ textGenerationModelSelection: selected });
  const id = await f.engine.createTask({ prompt: 'Main task', title: 'Main', requestId: 'main', projectId: 'project', mode: 'research', agent: 'codex' });
  await until(async () => (await f.engine.snapshot()).tasks.find(task => task.id === id)?.status === 'completed');
  await f.engine.patchTask(id, task => { task.codexHome = '/foreground-account'; task.nativeProviderAccount = 'foreground-binding'; task.modelOptions = [{ id: 'serviceTier', value: 'fast' }]; });
  await f.engine.taskTitles.start(id, 'pi-title');
  await until(() => f.executor.titles.length === 1);
  const generated = f.executor.titles[0].task;
  assert.equal(generated.agent, 'pi'); assert.equal(generated.providerInstanceId, 'pi_writer'); assert.equal(generated.codexHome, undefined); assert.equal(generated.nativeProviderAccount, undefined); assert.deepEqual(generated.modelOptions, selected.modelOptions);
  await until(async () => (await f.engine.snapshot()).titleRequests?.['pi-title'].status === 'completed');
  await f.reopen(); assert.equal((await f.engine.textGeneration.snapshot(null)).effective.textGenerationModelSelection.providerInstanceId, 'pi_writer');
});

test('Text generation defaults and disabled-provider fallback follow T3 without promoting the foreground task model', () => {
  const state = empty(); const enabled = { codex: true, claude: true };
  const initial = resolveTextGenerationSettings(state, null, enabled); assert.deepEqual(initial.effective.textGenerationModelSelection, defaultTextGenerationModel());
  assert.deepEqual(initial.effective.sourceControlWriterModelSelection, initial.effective.textGenerationModelSelection);
  assert.equal(initial.sources.textGenerationModelSelection, 'default');
  const fallback = resolveTextGenerationSettings(state, null, { codex: false, claude: true });
  assert.deepEqual(fallback.effective.textGenerationModelSelection, { agent: 'claude', model: 'claude-haiku-5-5', reasoningEffort: '' });
  assert.equal(fallback.sources.textGenerationModelSelection, 'fallback');
  state.textGenerationSettings = { version: 1, defaults: { textGenerationModelSelection: model('codex', 'host'), sourceControlWriterModelSelection: model('claude', 'writer'), sourceControlWritingStyle: defaultSourceControlWritingStyle() },
    projects: { project: { textGenerationModelSelection: model('claude', 'project') } } };
  assert.equal(resolveTextGenerationSettings(state, 'project', enabled).effective.textGenerationModelSelection.model, 'project');
  const disabled = resolveTextGenerationSettings(state, 'project', { codex: true, claude: false });
  assert.equal(disabled.effective.textGenerationModelSelection.model, 'host'); assert.equal(disabled.sources.textGenerationModelSelection, 'host');
  assert.equal(disabled.effective.sourceControlWriterModelSelection.model, 'host');
  state.textGenerationSettings.projects.project.sourceControlWriterModelSelection = null;
  const follow = resolveTextGenerationSettings(state, 'project', enabled);
  assert.equal(follow.effective.sourceControlWriterModelSelection.model, 'project'); assert.equal(follow.sources.sourceControlWriterModelSelection, 'text_generation');
  delete state.textGenerationSettings.projects.project.sourceControlWriterModelSelection;
  assert.equal(resolveTextGenerationSettings(state, 'project', enabled).effective.sourceControlWriterModelSelection.model, 'writer');
});

test('Settings patches reject invalid keys, scopes, versions and model values before changing state', () => {
  const valid = { projectId: null, expectedVersion: 0, changes: { textGenerationModelSelection: model('codex', 'fixture') } };
  for (const input of [null, { ...valid, projectId: '__proto__' }, { ...valid, expectedVersion: -1 }, { ...valid, expectedVersion: 1.5 }, { ...valid, unknown: true },
    { ...valid, changes: {} }, { ...valid, changes: { arbitrary: model('codex', 'x') } }, { ...valid, changes: { textGenerationModelSelection: null } },
    { ...valid, changes: { textGenerationModelSelection: { ...model('codex', 'x'), agent: 'unsupported' } } },
    { ...valid, changes: { textGenerationModelSelection: model('codex', '\nmodel') } }, { ...valid, reset: ['textGenerationModelSelection'] },
    { ...valid, changes: {}, reset: ['not_a_key'] }, { ...valid, changes: {}, reset: ['sourceControlWriterModelSelection', 'sourceControlWriterModelSelection'] }]) assert.throws(() => textGenerationSettingsChange(input));
  assert.deepEqual(textGenerationSettingsChange(valid).changes.textGenerationModelSelection, model('codex', 'fixture'));
});

test('Scoped settings persist, explicit null differs from inheritance, reset is selective and concurrent saves cannot overwrite each other', async t => {
  const f = await setup(t);
  await f.save({ textGenerationModelSelection: model('codex', 'host-title'), sourceControlWriterModelSelection: model('claude', 'host-writer') });
  await f.save({ textGenerationModelSelection: model('claude', 'project-title'), sourceControlWriterModelSelection: null }, 'project');
  let state = await f.engine.textGeneration.snapshot('project'); assert.equal(state.effective.sourceControlWriterModelSelection.model, 'project-title');
  await f.save({}, 'project', ['sourceControlWriterModelSelection']); state = await f.engine.textGeneration.snapshot('project');
  assert.equal(Object.hasOwn(state.overrides, 'sourceControlWriterModelSelection'), false); assert.equal(state.effective.sourceControlWriterModelSelection.model, 'host-writer');
  assert.equal(state.effective.textGenerationModelSelection.model, 'project-title');
  await f.reopen(); assert.equal((await f.engine.textGeneration.snapshot('project')).effective.textGenerationModelSelection.model, 'project-title');
  const version = (await f.engine.snapshot()).textGenerationSettings!.version;
  const responses = await Promise.allSettled(['one', 'two'].map(value => f.engine.textGeneration.save({ projectId: null, expectedVersion: version, changes: { textGenerationModelSelection: model('codex', value) } })));
  assert.equal(responses.filter(value => value.status === 'fulfilled').length, 1);
  const failed = responses.find(value => value.status === 'rejected'); assert.ok(failed?.status === 'rejected' && failed.reason instanceof TextGenerationSettingsConflict);
  assert.equal((await f.engine.snapshot()).textGenerationSettings!.version, version + 1);
  await f.save({}, 'project', ['textGenerationModelSelection']); assert.deepEqual((await f.engine.textGeneration.snapshot('project')).overrides, {});
  await f.save({}, null, ['textGenerationModelSelection', 'sourceControlWriterModelSelection']);
  assert.deepEqual((await f.engine.textGeneration.snapshot(null)).effective.textGenerationModelSelection, defaultTextGenerationModel());
});

test('Title requests freeze their own provider and model, protect that provider configuration, and later requests use updated preferences', async t => {
  const f = await setup(t); let release!: (value: string) => void;
  await f.save({ textGenerationModelSelection: model('codex', 'title-model') });
  f.executor.title = () => new Promise(resolve => { release = resolve; });
  const id = await f.engine.createTask({ prompt: 'Independent title', projectId: 'project', agent: 'claude', model: 'foreground-model', reasoningEffort: 'high', mode: 'research', requestId: 'frozen' });
  await until(async () => !!release && (await f.engine.snapshot()).tasks[0].status === 'completed');
  const before = (await f.engine.snapshot()).tasks[0];
  assert.equal(before.agent, 'claude'); assert.equal(before.model, 'foreground-model');
  assert.equal(f.executor.titles[0].task.agent, 'codex'); assert.equal(f.executor.titles[0].task.model, 'title-model');
  const auth = new Auth(f.directory); t.after(async () => auth.close()); const app = createAPI(f.engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await app.request('/api/agents/codex/settings', { method: 'PUT', headers, body: '{}' })).status, 409);
  assert.equal((await app.request('/api/agents/claude/settings', { method: 'PUT', headers, body: '{}' })).status, 400, 'an idle foreground provider is not the title provider');
  await f.save({ textGenerationModelSelection: model('claude', 'next-title-model') });
  assert.equal(f.executor.titles[0].task.model, 'title-model'); release('{"title":"First generated title"}');
  await until(async () => !(await f.engine.snapshot()).tasks[0].titleRegeneration);
  f.executor.title = async () => '{"title":"Next generated title"}'; await f.engine.taskTitles.start(id, 'next-generation');
  await until(() => f.executor.titles.length === 2); assert.equal(f.executor.titles[1].task.agent, 'claude'); assert.equal(f.executor.titles[1].task.model, 'next-title-model');
  await until(async () => !(await f.engine.snapshot()).tasks[0].titleRegeneration);
  const after = (await f.engine.snapshot()).tasks[0]; assert.equal(after.threadId, before.threadId); assert.equal(after.result, before.result); assert.equal(after.model, 'foreground-model');
});

test('Writing styles merge partial edits, freeze a Workspace override, reset independently and resolve older stored preferences', async t => {
  const f = await setup(t);
  const initial = await f.engine.textGeneration.snapshot('project');
  assert.deepEqual(initial.effective.sourceControlWritingStyle, defaultSourceControlWritingStyle()); assert.equal(initial.sources.sourceControlWritingStyle, 'default');
  await f.save({ textGenerationModelSelection: model('codex', 'preserved'), sourceControlWritingStyle: { mode: 'custom', customInstructions: '  Use Chinese.\nKeep test evidence.  ', followChangeRequestTemplates: false } });
  await f.save({ sourceControlWritingStyle: { mode: 'conventional_commits' } }, 'project');
  let project = await f.engine.textGeneration.snapshot('project');
  assert.deepEqual(project.effective.sourceControlWritingStyle, { mode: 'conventional_commits', customInstructions: 'Use Chinese.\nKeep test evidence.', followChangeRequestTemplates: false });
  assert.equal(project.sources.sourceControlWritingStyle, 'workspace');
  await f.save({ sourceControlWritingStyle: { followChangeRequestTemplates: true } });
  assert.equal((await f.engine.textGeneration.snapshot('project')).effective.sourceControlWritingStyle.followChangeRequestTemplates, false);
  await f.reopen(); assert.equal((await f.engine.textGeneration.snapshot('project')).effective.sourceControlWritingStyle.mode, 'conventional_commits');
  await f.save({}, 'project', ['sourceControlWritingStyle']); project = await f.engine.textGeneration.snapshot('project');
  assert.deepEqual(project.overrides, {}); assert.equal(project.effective.sourceControlWritingStyle.followChangeRequestTemplates, true);
  await f.save({}, null, ['sourceControlWritingStyle']);
  const host = await f.engine.textGeneration.snapshot(null); assert.deepEqual(host.effective.sourceControlWritingStyle, defaultSourceControlWritingStyle());
  assert.equal(host.effective.textGenerationModelSelection.model, 'preserved');
  const legacy = await f.engine.snapshot(); Reflect.deleteProperty(legacy.textGenerationSettings!.defaults, 'sourceControlWritingStyle');
  const resolved = resolveTextGenerationSettings(legacy, 'project', { codex: true, claude: false });
  assert.deepEqual(resolved.defaults.sourceControlWritingStyle, defaultSourceControlWritingStyle()); assert.equal(resolved.version, host.version);
});

test('Invalid writing-style patches cannot be coerced into a mode or overwrite another preference', () => {
  for (const style of [null, {}, { mode: 'arbitrary' }, { mode: ['custom'] }, { customInstructions: 1 }, { customInstructions: '\ud800' }, { customInstructions: 'bad\0text' }, { followChangeRequestTemplates: 'false' }, { extra: true }]) {
    assert.throws(() => textGenerationSettingsChange({ projectId: null, expectedVersion: 0, changes: { sourceControlWritingStyle: style } }));
  }
});

test('Auxiliary title settings failure cannot reject or fail the main task submission', async t => {
  const f = await setup(t);
  await saveCodexSettings(f.directory, { ...defaultCodexSettings, enabled: false });
  await saveProviderSettings(f.directory, 'claude-provider.json', { ...defaultClaudeSettings, enabled: false });
  const id = await f.engine.createTask({ prompt: 'Main task remains valid', projectId: 'project', agent: 'claude', mode: 'research', requestId: 'disabled-title-profiles' });
  await until(async () => (await f.engine.snapshot()).tasks[0].status === 'completed' && !(await f.engine.snapshot()).tasks[0].titleRegeneration);
  assert.equal(f.executor.titles.length, 0); assert.equal((await f.engine.snapshot()).tasks[0].id, id); assert.equal((await f.engine.snapshot()).tasks[0].result, 'Original answer');
  assert.equal((await f.engine.snapshot()).titleRequests!['title:disabled-title-profiles'].status, 'failed');
});

test('Unavailable source control overrides follow text generation while explicit project null skips the host writer choice', async t => {
  const f = await setup(t); f.engine.claudeConnection.status = async () => profile('Claude', false);
  await f.save({ textGenerationModelSelection: model('codex', 'base'), sourceControlWriterModelSelection: model('claude', 'unavailable-writer') });
  const snapshot = await f.engine.textGeneration.snapshot(null); assert.equal(snapshot.effective.sourceControlWriterModelSelection.model, 'base'); assert.equal(snapshot.sources.sourceControlWriterModelSelection, 'text_generation');
  assert.equal((await f.engine.textGeneration.select(await f.engine.snapshot(), 'project', 'source_control')).model, 'base');
  f.engine.claudeConnection.status = async () => profile('Claude');
  await f.save({ textGenerationModelSelection: model('codex', 'project-base'), sourceControlWriterModelSelection: null }, 'project');
  assert.equal((await f.engine.textGeneration.snapshot('project')).effective.sourceControlWriterModelSelection.model, 'project-base');
});

test('Authenticated connected devices can edit preferences with conflict detection; deleting a Workspace removes its override', async t => {
  const f = await setup(t); const auth = new Auth(f.directory); t.after(async () => auth.close()); const app = createAPI(f.engine, auth, () => []);
  const device = auth.pair(auth.createPairing().code, 'Phone', 'test'); const headers = { Authorization: 'Bearer ' + device.token, 'Content-Type': 'application/json' };
  const post = (body: object) => app.request('/api/text-generation/settings', { method: 'PATCH', headers, body: JSON.stringify(body) });
  assert.equal((await app.request('/api/text-generation/settings')).status, 401);
  const body = { projectId: 'project', expectedVersion: 0, changes: { textGenerationModelSelection: model('codex', 'phone-choice') } };
  const accepted = await post(body); assert.equal(accepted.status, 200); assert.equal((await accepted.json()).version, 1);
  assert.equal((await post(body)).status, 409); assert.equal((await post({ ...body, expectedVersion: 1, projectId: '__proto__' })).status, 400);
  const state = await (await app.request('/api/overview', { headers })).json(); assert.equal(state.textGenerationSettingsVersion, 1);
  assert.ok(!JSON.stringify(state.textGenerationSettings).includes('environment'));
  assert.equal((await app.request('/api/projects/project', { method: 'DELETE', headers })).status, 200);
  const after = await f.engine.snapshot(); assert.equal(after.textGenerationSettingsVersion, 2); assert.deepEqual(after.textGenerationSettings!.projects, {});
  assert.equal((await app.request('/api/text-generation/settings?projectId=project', { headers })).status, 400);
  auth.revoke(device.id); assert.equal((await post({ ...body, expectedVersion: 2 })).status, 401);
});

test('Real local Git generation uses the separate writer and keeps its model frozen while preferences change', async t => {
  const f = await setup(t); const git = async (...args: string[]) => (await exec('git', ['-C', f.cwd, ...args])).stdout;
  await git('init', '-q', '--initial-branch=main'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.test'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(join(f.cwd, 'file.txt'), 'before\n'); await git('add', '.'); await git('commit', '-qm', 'Initial');
  const id = await f.engine.createTask({ prompt: 'Original task', title: 'Explicit task title', projectId: 'project', agent: 'codex', model: 'main-model', mode: 'research', requestId: 'git-task' });
  await until(async () => (await f.engine.snapshot()).tasks[0].status === 'completed');
  await f.save({ textGenerationModelSelection: model('codex', 'title-only'), sourceControlWriterModelSelection: model('claude', 'writer-only') });
  await writeFile(join(f.cwd, 'file.txt'), 'after\n');
  let release!: (value: string) => void; f.executor.gitText = () => new Promise(resolve => { release = resolve; });
  const currentTask = (await f.engine.snapshot()).tasks[0];
  const status = await readTaskGitStatus(f.cwd, { directory: f.directory, workspace: currentTask.executionWorkspace });
  await f.engine.gitOperations.start(id, { requestId: 'writer-commit', action: 'commit', fingerprint: status.fingerprint });
  await until(() => !!release); const request = f.executor.git[0]; assert.equal(request.task.agent, 'claude'); assert.equal(request.task.model, 'writer-only');
  const auth = new Auth(f.directory); t.after(async () => auth.close()); const app = createAPI(f.engine, auth, () => []); const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  assert.equal((await app.request('/api/agents/claude/settings', { method: 'PUT', headers, body: '{}' })).status, 409);
  await f.save({ sourceControlWriterModelSelection: model('codex', 'next-writer') }); assert.equal(request.task.model, 'writer-only');
  release('{"subject":"Separate writer commit","body":""}');
  await until(async () => (await f.engine.snapshot()).tasks[0].gitOperation?.status === 'completed');
  assert.equal((await git('log', '-1', '--format=%s')).trim(), 'Separate writer commit');
  const task = (await f.engine.snapshot()).tasks[0]; assert.equal(task.model, 'main-model'); assert.equal(task.threadId, 'main-session');
  assert.equal(task.gitOperation?.generationModelSelection?.model, 'writer-only'); assert.equal(task.gitOperation?.generation?.threadId, 'writer-session');
});
