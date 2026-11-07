import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeSkills } from '../src/claude-skills.js';
import { planClaudeSkillDispatch, codexSkillMentionText } from '../src/vendor/t3-claude-skill-dispatch.js';
import { ProviderWorkspaceCache, type ProviderWorkspace } from '../src/provider-workspace.js';
import { CodexConnection } from '../src/codex-provider.js';
import { defaultCodexSettings } from '../src/codex-settings.js';
import { ClaudeConnection, defaultClaudeSettings } from '../src/claude-provider.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';

test('Pinned skill dispatch preserves surrounding prose, dispatches only known names and keeps the last skill in the last text block', () => {
  const names = new Set(['review', 'implement', '2spec']);
  assert.equal(planClaudeSkillDispatch('echo $HOME and $unknown', names), undefined);
  assert.deepEqual(planClaudeSkillDispatch('ok, now $implement all the tickets', names), { leadingText: 'ok, now', commandText: '/implement all the tickets', skillName: 'implement' });
  assert.deepEqual(planClaudeSkillDispatch('$review\nfocus on auth', names), { leadingText: undefined, commandText: '/review\nfocus on auth', skillName: 'review' });
  assert.deepEqual(planClaudeSkillDispatch('$review the diff, then €implement the fixes', names), { leadingText: '/review the diff, then', commandText: '/implement the fixes', skillName: 'implement' });
  assert.equal(planClaudeSkillDispatch('use $2spec for this', names)?.commandText, '/2spec for this');
  assert.equal(planClaudeSkillDispatch('budget $1 $100K $1e6', names), undefined);
  assert.equal(codexSkillMentionText('use €review then ¥implement; $100K €200 and £2spec'), 'use $review then ¥implement; $100K €200 and $2spec', 'Punctuation and monetary values follow the exact composer token boundaries');
});

test('Claude discovery follows directory names, user precedence, YAML booleans, complete override maps and repository/local/managed precedence', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-skill-discovery-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, 'home'), repo = join(directory, 'repo'), cwd = join(repo, 'nested'), managed = join(directory, 'managed'), added = join(directory, 'added');
  await mkdir(join(repo, '.git'), { recursive: true }); await mkdir(cwd); await mkdir(join(managed, 'ClaudeCode'), { recursive: true });
  const skill = async (root: string, name: string, text: string) => { const path = join(root, name); await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), text); };
  await skill(join(home, 'skills'), 'review', '---\nname: ignored-alias\ndescription: Review: exact changes # keep comment separate\ndisable-model-invocation: yes\n---\nInstructions');
  await skill(join(cwd, '.claude/skills'), 'review', '---\ndescription: Project must not win\n---\n');
  await skill(join(home, 'skills'), 'private', '---\nuser-invocable: off\n---\n');
  await skill(join(home, 'skills'), 'malformed', '---\ndescription: [broken\n---\n');
  await skill(join(home, 'skills'), 'plain', 'No frontmatter');
  await skill(join(added, '.claude/skills'), 'additional', '---\ndescription: >-\n  Folded description\n  with another line\n---\n');
  await writeFile(join(home, 'settings.json'), '{"skillOverrides":{"review":"off","plain":"off"}}');
  await mkdir(join(cwd, '.claude'), { recursive: true }); await writeFile(join(cwd, '.claude/settings.json'), '{"skillOverrides":{"review":"on"}}');
  await writeFile(join(cwd, '.claude/settings.local.json'), '{"skillOverrides":{"review":"off","invalid":true}}');
  await mkdir(join(repo, '.claude'), { recursive: true }); await writeFile(join(repo, '.claude/settings.local.json'), '{ // comment\n"skillOverrides":{"plain":"on"},\n}');
  await writeFile(join(managed, 'ClaudeCode/managed-settings.json'), '{"skillOverrides":{"plain":"user-invocable-only"}}');
  const skills = await discoverClaudeSkills(home, cwd, { PROGRAMDATA: managed }, added, 'win32');
  assert.deepEqual(skills.map(skill => skill.name), ['additional', 'plain', 'private', 'review']);
  assert.equal(skills.find(skill => skill.name === 'review')?.description, 'Review: exact changes');
  assert.equal(skills.find(skill => skill.name === 'review')?.enabled, true, 'One invalid value discards the entire local override map');
  assert.equal(skills.find(skill => skill.name === 'review')?.userInvocationOnly, true); assert.equal(skills.find(skill => skill.name === 'review')?.scope, 'user');
  assert.equal(skills.find(skill => skill.name === 'plain')?.enabled, true); assert.equal(skills.find(skill => skill.name === 'plain')?.userInvocationOnly, true);
  assert.equal(skills.find(skill => skill.name === 'private')?.userInvocable, false); assert.equal(skills.find(skill => skill.name === 'additional')?.description, 'Folded description with another line');
});

test('Workspace metadata cache coalesces reads, expires after the pinned five minutes, isolates identities, and never caches failures', async () => {
  const cache = new ProviderWorkspaceCache(); let calls = 0; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const value = (): ProviderWorkspace => ({ provider: 'codex', cwd: '/project', checkedAt: new Date().toISOString(), skills: [], commands: [] });
  const first = cache.read('account-a', false, async () => { calls++; await held; return value(); });
  const second = cache.read('account-a', false, async () => { throw new Error('Must share the in-flight read'); }); release();
  assert.equal(await first, await second); assert.equal(calls, 1);
  await cache.read('account-a', false, async () => { throw new Error('Must use fresh cache'); });
  await cache.read('account-b', false, async () => { calls++; return value(); }); assert.equal(calls, 2);
  await cache.read('expired', false, async () => ({ ...value(), checkedAt: new Date(Date.now() - 301000).toISOString() }));
  await cache.read('expired', false, async () => { calls++; return value(); }); assert.equal(calls, 3);
  await assert.rejects(cache.read('failure', false, async () => { throw new Error('Temporary failure'); }));
  await cache.read('failure', false, async () => { calls++; return value(); }); assert.equal(calls, 4);
  let drain!: () => void; const waiting = new Promise<void>(resolve => { drain = resolve; });
  const stale = cache.read('refresh-race', false, async () => { await waiting; return { ...value(), cwd: '/old-scan' }; });
  let forced = 0;
  const refreshed = cache.read('refresh-race', true, async () => { forced++; return { ...value(), cwd: '/forced-scan' }; });
  drain(); assert.equal((await stale).cwd, '/old-scan'); assert.equal((await refreshed).cwd, '/forced-scan'); assert.equal(forced, 1);
});

test('Authenticated composer discovery binds actual task/project/reused checkout and provider account, without creating any native turn', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-composer-catalog-'))), data = join(directory, 'data'), cwd = join(directory, 'project'), reused = join(directory, 'worktree');
  await mkdir(cwd); await mkdir(reused); const executor = { async run() { throw new Error('Discovery must not run a model'); }, async answer() {}, async steer() {} };
  const engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open(), auth = new Auth(data);
  t.after(async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); });
  const binary = fileURLToPath(new URL('fixtures/codex-provider.mjs', import.meta.url)); await chmod(binary, 0o755);
  await engine.codexConnection.save({ ...defaultCodexSettings, enabled: true, binaryPath: binary, homePath: join(directory, 'codex-home') });
  await engine.mutate(state => {
    state.projects = [{ id: 'project', name: 'Project', path: cwd, context: '' }];
    state.tasks = [{ id: 'source', projectId: 'project', cwd: reused, agent: 'codex', status: 'completed', mode: 'code', title: 'Source', prompt: '', result: '', createdAt: '', updatedAt: '', durableId: null, threadId: 'native', turnId: null, events: [], approvals: [], artifact: null, error: null, lastRequestId: 'source' }];
  });
  const api = createAPI(engine, auth, () => []), headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const post = (body: unknown, authorized = true) => api.request('/api/composer/capabilities', { method: 'POST', headers: authorized ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ provider: 'codex', projectId: 'project' }, false)).status, 401);
  const response = await post({ provider: 'codex', projectId: 'project', cwd: '/untrusted/path' }); assert.equal(response.status, 200);
  const catalog = await response.json(); assert.equal(catalog.cwd, cwd); assert.equal(catalog.skills[0].displayName, 'Review Changes'); assert.equal(catalog.commands[0].name, 'compact');
  assert(!JSON.stringify(catalog).includes('codex-home')); assert(!JSON.stringify(catalog).includes('environment'));
  const same = await post({ provider: 'codex', projectId: 'project' }); assert.equal((await same.json()).checkedAt, catalog.checkedAt);
  const reusedResponse = await post({ provider: 'codex', projectId: 'project', reuseTaskId: 'source' }); assert.equal((await reusedResponse.json()).cwd, reused);
  assert.equal((await post({ provider: 'claude', taskId: 'source' })).status, 400);
  assert.equal((await post({ provider: 'codex', projectId: 'missing' })).status, 400);
  assert.equal((await post({ provider: 'codex', projectId: 'project', reuseTaskId: 'missing' })).status, 400);
  await post({ provider: 'codex', projectId: 'project', reload: true });
  const wire = (await readFile(join(data, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(wire.filter(message => message.method === 'skills/list' && message.params.cwds[0] === cwd).length, 2);
  assert(wire.some(message => message.method === 'skills/list' && message.params.forceReload === true));
  assert(!wire.some(message => ['thread/start', 'thread/resume', 'turn/start'].includes(message.method)));
  assert.equal((await engine.snapshot()).tasks.length, 1);
});

test('Claude workspace command initialization uses the requested cwd, disables hooks and model input, and discovers user skills', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'friday-claude-catalog-'))), cwd = join(directory, 'workspace'), home = join(directory, 'home');
  await mkdir(cwd); await mkdir(join(home, 'skills/review'), { recursive: true }); await writeFile(join(home, 'skills/review/SKILL.md'), '---\ndescription: Review changes\n---\n');
  const binary = fileURLToPath(new URL('fixtures/claude-provider.mjs', import.meta.url)); await chmod(binary, 0o755);
  const connection = new ClaudeConnection(directory); t.after(async () => { await connection.close(); await rm(directory, { recursive: true, force: true }); });
  await connection.save({ ...defaultClaudeSettings, binaryPath: binary, homePath: home });
  const catalog = await connection.workspace(cwd); assert.equal(catalog.cwd, cwd); assert.equal(catalog.skills[0].name, 'review'); assert.equal(catalog.commands[0].name, 'compact');
  const wire = (await readFile(join(cwd, 'claude-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const launch = wire.find(message => message.args); assert(launch.args.includes('--no-session-persistence')); assert(launch.args.includes('--strict-mcp-config')); assert(launch.args.includes('{"disableAllHooks":true}'));
  assert(!wire.some(message => message.type === 'user'));
});
