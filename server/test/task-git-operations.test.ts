import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { readTaskGitStatus, TaskGitStatuses } from '../src/task-git-status.js';
import type { ExecutionRequest, Executor, TaskGitOperation, Workspace } from '../src/types.js';

const exec = promisify(execFile);
class TextExecutor implements Executor {
  generated: ExecutionRequest[] = [];
  onGenerate?: (request: ExecutionRequest) => Promise<void>;
  async run(request: ExecutionRequest) {
    if (request.purpose !== 'git_text') return 'Initial answer';
    this.generated.push(request);
    await request.update({ kind: 'session', threadId: 'git-generation-' + this.generated.length });
    await request.update({ kind: 'turn', turnId: 'git-generation-turn-' + this.generated.length });
    await this.onGenerate?.(request);
    if (request.prompt.startsWith('Write a pull request')) return JSON.stringify({ title: 'Update the fixture', body: 'Changes preserve the selected files.\n\nLiteral `code` and $(not_a_command).' });
    return JSON.stringify({ subject: 'Update selected files', body: 'Preserve other changes.' });
  }
  async answer() {}
  async steer() {}
}
async function until(engine: Engine, predicate: (state: Workspace) => boolean) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await engine.snapshot(); if (predicate(state)) return state;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  throw new Error('Git operation timed out');
}
async function setup(t: { after: (fn: () => Promise<unknown>) => void }, options: { empty?: boolean; subdirectory?: boolean; nestedData?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-git-operation-'));
  const root = join(directory, 'project'); await mkdir(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { env })).stdout;
  await git('init', '-q', '--initial-branch=main');
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', join(root, '.git/hooks')]]) await git('config', key, value);
  await mkdir(join(root, 'scope'));
  const put = (path: string, content: string) => writeFile(join(root, path), content);
  if (!options.empty) { await put('scope/selected.txt', 'before\n'); await put('excluded.txt', 'excluded before\n'); await git('add', '.'); await git('commit', '-qm', 'Initial'); }
  const cwd = options.subdirectory ? join(root, 'scope') : root;
  const dataDirectory = options.nestedData ? join(root, 'friday-data') : join(directory, 'data');
  const executor = new TextExecutor();
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.hostname, 'api.github.com', 'Only the injected GitHub fixture may be queried');
    if (url.pathname === '/user') return new Response(JSON.stringify({ login: 'friday-fixture' }));
    const state = join(root, '.git/fixture-pr.json'); const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const action = init?.method === 'POST' ? 'create' : 'list';
    await appendFile(join(root, '.git/gh-wire.jsonl'), JSON.stringify({ args: ['http', action], body: body?.body }) + '\n');
    if (action === 'create') {
      const value = { number: 42, html_url: 'https://github.com/friday-fixture/parity-fixture/pull/42', title: body.title, state: 'open', head: { ref: body.head, repo: { full_name: 'friday-fixture/parity-fixture' } }, base: { ref: body.base } };
      await writeFile(state, JSON.stringify(value)); return new Response(JSON.stringify(value));
    }
    try { return new Response('[' + await readFile(state, 'utf8') + ']'); } catch { return new Response('[]'); }
  };
  const engine = await new Engine(dataDirectory, executor, undefined, { environment: {}, request, changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: cwd, context: '' }));
  const id = await engine.createTask({ prompt: 'Initial', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'initial' });
  await until(engine, state => state.tasks[0]?.status === 'completed');
  const auth = new Auth(dataDirectory); const app = createAPI(engine, auth, () => []);
  const headers = { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' };
  const post = (path: string, body: object) => app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const operation = async (): Promise<TaskGitOperation> => (await until(engine, state => !!state.tasks[0]?.gitOperation && !['queued', 'running'].includes(state.tasks[0].gitOperation.status))).tasks[0].gitOperation!;
  return { directory, root, cwd, git, put, engine, executor, id, auth, app, headers, post, operation };
}

test('A selected commit preserves excluded staged and working changes, handles special paths and runs native hooks with redacted progress', async t => {
  const { root, cwd, git, put, engine, id, operation, executor } = await setup(t);
  await put('scope/selected.txt', 'selected after\n'); await put('excluded.txt', 'excluded staged\n'); await git('add', 'excluded.txt'); await put('excluded.txt', 'excluded working\n');
  const special = 'scope/new + [file]\n.txt'; await put(special, 'new content\n');
  const hook = join(root, '.git/hooks/pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf "hook https://user:fake-secret@example.test/repo ghp_fixturetoken123\\n"\n'); await chmod(hook, 0o755);
  const review = await readTaskGitStatus(cwd);
  const request = { requestId: 'selected-commit', action: 'commit' as const, fingerprint: review.fingerprint, filePaths: ['scope/selected.txt', special], commitMessage: 'Commit selected files' };
  const receipt = await engine.gitOperations.start(id, request); const result = await operation();
  assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.commitSHA, (await git('rev-parse', 'HEAD')).trim());
  assert.equal(await git('show', 'HEAD:scope/selected.txt'), 'selected after\n'); assert.equal(await git('show', 'HEAD:excluded.txt'), 'excluded before\n');
  assert.match(await git('diff', '--cached', '--', 'excluded.txt'), /\+excluded staged/); assert.match(await git('diff', '--', 'excluded.txt'), /\+excluded working/);
  assert.equal(await git('show', `HEAD:${special}`), 'new content\n');
  assert.match(result.output?.join('\n') ?? '', /hook.*\[redacted\]/); assert.doesNotMatch(JSON.stringify(result.output), /fake-secret|ghp_fixturetoken/);
  assert.equal(executor.generated.length, 0);
  const count = await git('rev-list', '--count', 'HEAD'); assert.equal(await engine.gitOperations.start(id, request), receipt); assert.equal(await git('rev-list', '--count', 'HEAD'), count);
});

test('A runtime data directory inside the repository never enters Diff, model context, commit selection or the committed tree', async t => {
  const { cwd, git, put, engine, executor, id, app, headers, operation } = await setup(t, { nestedData: true });
  await put('scope/selected.txt', 'safe code change\n');
  const response = await app.request(`/api/tasks/${id}/git/status`, { headers }); const review = await response.json();
  assert.deepEqual(review.files.map((file: { path: string }) => file.path), ['scope/selected.txt']);
  const changes = await app.request(`/api/tasks/${id}/changes`, { headers }); assert.deepEqual((await changes.json()).files.map((file: { path: string }) => file.path), ['scope/selected.txt']);
  assert.equal((await app.request(`/api/tasks/${id}/diff?path=friday-data%2Fowner-token`, { headers })).status, 400);
  await engine.gitOperations.start(id, { requestId: 'private-data-safe', action: 'commit', fingerprint: review.fingerprint });
  const result = await operation(); assert.equal(result.status, 'completed', result.error ?? '');
  assert.doesNotMatch(executor.generated[0]?.prompt ?? '', /owner-token|friday\.sqlite|friday-data/);
  assert.doesNotMatch(await git('ls-tree', '-r', '--name-only', 'HEAD'), /friday-data/);
  assert.equal(await git('show', 'HEAD:scope/selected.txt'), 'safe code change\n');
  const fresh = await readTaskGitStatus(cwd, engine.directory); assert.equal(fresh.files.length, 0);
});

test('A registered managed worktree inside Friday data supports current Diff and commits without exposing internal data', async t => {
  const { engine, app, headers, git, executor } = await setup(t);
  const id = await engine.createTask({ prompt: 'Managed task', projectId: 'project', mode: 'code', agent: 'codex', requestId: 'managed-initial', workspace: { mode: 'worktree' } });
  const ready = await until(engine, state => state.tasks.find(task => task.id === id)?.status === 'completed');
  const work = ready.tasks.find(task => task.id === id)!;
  assert.equal(work.executionWorkspace?.state, 'ready');
  await writeFile(join(work.cwd, 'scope/selected.txt'), 'managed source change\n');
  const changes = await app.request(`/api/tasks/${id}/changes`, { headers });
  assert.deepEqual((await changes.json()).files.map((file: { path: string }) => file.path), ['scope/selected.txt']);
  const diff = await app.request(`/api/tasks/${id}/diff?path=scope%2Fselected.txt`, { headers });
  assert.match((await diff.json()).patch, /\+managed source change/);
  const review = await (await app.request(`/api/tasks/${id}/git/status`, { headers })).json();
  assert.equal(review.files.length, 1);
  await engine.gitOperations.start(id, { requestId: 'managed-commit', action: 'commit', fingerprint: review.fingerprint });
  const final = await until(engine, state => state.tasks.find(task => task.id === id)?.gitOperation?.status === 'completed');
  assert.equal(final.tasks.find(task => task.id === id)?.gitOperation?.status, 'completed');
  const committed = (await exec('git', ['-C', work.cwd, 'show', 'HEAD:scope/selected.txt'])).stdout;
  assert.equal(committed, 'managed source change\n');
  assert.equal(await git('show', 'HEAD:scope/selected.txt'), 'before\n');
  assert.doesNotMatch(executor.generated[0]?.prompt ?? '', /owner-token|friday\.sqlite/);
  // A task without a registered plan cannot publish a directory under private data.
  await engine.mutate(state => { const task = state.tasks.find(task => task.id === id)!; delete task.executionWorkspace; });
  assert.equal((await (await app.request(`/api/tasks/${id}/changes`, { headers })).json()).files.length, 0);
  await assert.rejects(engine.gitOperations.start(id, { requestId: 'unregistered-managed', action: 'commit', fingerprint: review.fingerprint }), /数据目录/);
});

test('Commit-and-push confirms the default branch, can create a feature branch and deduplicates the external commit after restart', async t => {
  const { directory, cwd, git, put, engine, executor, id, operation } = await setup(t);
  const remote = join(directory, 'remote.git'); await exec('git', ['init', '--bare', '-q', '--initial-branch=main', remote]);
  await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  await put('scope/selected.txt', 'feature\n');
  const review = await readTaskGitStatus(cwd);
  await assert.rejects(engine.gitOperations.start(id, { requestId: 'unconfirmed', action: 'commit_push', fingerprint: review.fingerprint, commitMessage: 'Feature' }), /确认/);
  const input = { requestId: 'feature-publish', action: 'commit_push' as const, fingerprint: review.fingerprint, commitMessage: 'Feature', featureBranch: true, branchName: 'linc/fixture-feature' };
  const receipt = await engine.gitOperations.start(id, input); const result = await operation();
  assert.equal(result.status, 'completed', result.error ?? ''); assert.equal((await git('branch', '--show-current')).trim(), 'linc/fixture-feature');
  const remoteHead = (await exec('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/linc/fixture-feature'])).stdout.trim();
  assert.equal(remoteHead, result.commitSHA); assert.equal((await git('rev-parse', '--abbrev-ref', '@{upstream}')).trim(), 'origin/linc/fixture-feature');
  await engine.close(); const reopened = await new Engine(join(directory, 'data'), executor).open();
  try { assert.equal(await reopened.gitOperations.start(id, input), receipt); assert.equal((await reopened.snapshot()).tasks[0].gitOperation?.status, 'completed'); assert.equal((await git('rev-parse', 'HEAD')).trim(), result.commitSHA); }
  finally { await reopened.close(); }
});

test('Remote status refresh discovers incoming changes and pull is fast-forward-only and refuses dirty files outside a task subdirectory', async t => {
  const { directory, root, cwd, git, engine, id, operation, put } = await setup(t, { subdirectory: true });
  const remote = join(directory, 'remote.git'); const peer = join(directory, 'peer');
  await exec('git', ['init', '--bare', '-q', '--initial-branch=main', remote]); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  await exec('git', ['clone', '-q', remote, peer]);
  const peerGit = async (...args: string[]) => (await exec('git', ['-C', peer, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args])).stdout;
  await writeFile(join(peer, 'scope/selected.txt'), 'incoming\n'); await peerGit('add', '.'); await peerGit('commit', '-qm', 'Incoming'); await peerGit('push');
  const statuses = new TaskGitStatuses(); const remoteStatus = await statuses.read(cwd, true); assert.equal(remoteStatus.behind, 1); assert.equal(remoteStatus.defaultBranch, 'main');
  await put('excluded.txt', 'outside dirty\n'); const blocked = await readTaskGitStatus(cwd); assert.equal(blocked.files.length, 0);
  await assert.rejects(engine.gitOperations.start(id, { requestId: 'dirty-pull', action: 'pull', fingerprint: blocked.fingerprint }), /全部改动/);
  await git('restore', '--', 'excluded.txt'); const reviewed = await readTaskGitStatus(cwd);
  await engine.gitOperations.start(id, { requestId: 'clean-pull', action: 'pull', fingerprint: reviewed.fingerprint });
  const result = await operation(); assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(await readFile(join(root, 'scope/selected.txt'), 'utf8'), 'incoming\n');
  assert.equal((await git('rev-parse', 'HEAD')).trim(), (await peerGit('rev-parse', 'HEAD')).trim());
});

test('The PR pipeline uses literal REST bodies, keeps both generation session receipts and adopts an existing PR without creating a duplicate', async t => {
  const { directory, root, cwd, git, put, engine, executor, id, operation } = await setup(t);
  await mkdir(join(root, '.github')); await put('.github/pull_request_template.md', '## BASE_TEMPLATE\n\n<!-- explain the change -->\n');
  await git('add', '.github'); await git('commit', '-qm', 'docs: add the base PR template');
  const remote = join(directory, 'remote.git'); await exec('git', ['init', '--bare', '-q', '--initial-branch=main', remote]); await git('remote', 'add', 'origin', remote); await git('push', '-u', 'origin', 'main');
  await git('switch', '-c', 'linc/pr-fixture');
  // All Git network writes stay in this temporary bare repository. Only the
  // fixture CLI sees the GitHub URL used for source-control discovery.
  await git('config', `url.file://${remote}.insteadOf`, 'https://github.com/friday-fixture/parity-fixture.git');
  await git('remote', 'set-url', 'origin', 'https://github.com/friday-fixture/parity-fixture.git'); await git('remote', 'set-url', '--push', 'origin', remote);
  const tools = join(directory, 'tools'); await mkdir(tools); const command = join(tools, 'gh');
  await writeFile(command, `#!/usr/bin/env node
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2); const root=process.cwd(); const metadata=join(root,'.git');
if(args[0]==='auth'&&args[1]==='token'){process.stdout.write('synthetic-gh-cli-token');process.exit(0);}
const state=join(metadata,'fixture-pr.json');
if(args[0]==='pr'&&args[1]==='list'){console.log(existsSync(state)?'['+readFileSync(state,'utf8')+']':'[]');process.exit(0);}
if(args[0]==='pr'&&args[1]==='create'){const item={number:42,url:'https://github.com/friday-fixture/parity-fixture/pull/42',title:args[args.indexOf('--title')+1],state:'OPEN',baseRefName:'main',headRefName:'linc/pr-fixture'};writeFileSync(state,JSON.stringify(item));console.log(item.url);process.exit(0);}
process.exit(2);
`); await chmod(command, 0o755);
  const previous = process.env.PATH; process.env.PATH = tools + ':' + previous;
  try {
    await engine.textGeneration.save({ projectId: null, expectedVersion: 0, changes: { sourceControlWritingStyle: { mode: 'custom', customInstructions: 'FROZEN_STYLE: write clear Chinese', followChangeRequestTemplates: true } } });
    executor.onGenerate = async () => {
      if (executor.generated.length === 1) await engine.textGeneration.save({ projectId: null, expectedVersion: 1, changes: { sourceControlWritingStyle: { mode: 'conventional_commits', customInstructions: 'NEXT_STYLE', followChangeRequestTemplates: false } } });
    };
    await put('.github/pull_request_template.md', '## FEATURE_TEMPLATE\n');
    await put('scope/selected.txt', 'PR change\n'); const review = await readTaskGitStatus(cwd); assert.equal(review.github?.argument, 'friday-fixture/parity-fixture');
    await engine.gitOperations.start(id, { requestId: 'commit-pr', action: 'commit_push_pr', fingerprint: review.fingerprint });
    const result = await operation(); assert.equal(result.status, 'completed', result.error ?? ''); assert.equal(result.pullRequest?.number, 42);
    assert.equal(executor.generated.length, 2); assert.equal(Object.keys(result.generations ?? {}).length, 2); assert.equal(result.generations?.generate_commit.threadId, 'git-generation-1'); assert.equal(result.generations?.generate_pr.threadId, 'git-generation-2');
    assert.equal(result.generationWritingStyle?.mode, 'custom');
    for (const request of executor.generated) { assert.match(request.prompt, /FROZEN_STYLE/); assert.doesNotMatch(request.prompt, /NEXT_STYLE/); }
    const template = executor.generated[1].prompt.split('Repository change request template (reference data):\n')[1]?.split('\nThe following Git data')[0];
    assert.match(template ?? '', /BASE_TEMPLATE/); assert.doesNotMatch(template ?? '', /FEATURE_TEMPLATE/);
    assert.match(executor.generated[1].prompt, /\+PR change/);
    const calls = (await readFile(join(root, '.git/gh-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const creation = calls.filter(call => call.args[1] === 'create'); assert.equal(creation.length, 1); assert.match(creation[0].body, /Literal `code` and \$\(not_a_command\)/);
    const current = await readTaskGitStatus(cwd); await engine.gitOperations.start(id, { requestId: 'existing-pr', action: 'create_pr', fingerprint: current.fingerprint });
    const again = await operation(); assert.equal(again.status, 'completed', again.error ?? ''); assert.equal(again.pullRequest?.number, 42);
    const updated = (await readFile(join(root, '.git/gh-wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(updated.filter(call => call.args[1] === 'create').length, 1); assert.equal(executor.generated.length, 2);
    await rm(join(root, '.git/fixture-pr.json'));
    const latest = await readTaskGitStatus(cwd); await engine.gitOperations.start(id, { requestId: 'pr-without-template', action: 'create_pr', fingerprint: latest.fingerprint });
    const noTemplate = await operation(); assert.equal(noTemplate.status, 'completed', noTemplate.error ?? ''); assert.equal(executor.generated.length, 3);
    assert.doesNotMatch(executor.generated[2].prompt, /Repository change request template \(reference data\):/);
    assert.match(executor.generated[2].prompt, /## Summary/); assert.match(executor.generated[2].prompt, /Do not force Conventional Commit syntax/);
  } finally { process.env.PATH = previous; }
});

test('Git APIs authenticate requests, validate review fingerprints and expose persisted operation results', async t => {
  const { cwd, put, engine, id, app, headers, post, operation } = await setup(t);
  await put('scope/selected.txt', 'API change\n');
  assert.equal((await app.request(`/api/tasks/${id}/git/status`)).status, 401);
  const response = await app.request(`/api/tasks/${id}/git/status`, { headers }); assert.equal(response.status, 200); const review = await response.json();
  assert.equal((await post(`/api/tasks/${id}/git/operations`, { action: 'invalid', fingerprint: review.fingerprint, requestId: 'invalid' })).status, 400);
  assert.equal((await post(`/api/tasks/${id}/git/operations`, { action: 'commit', fingerprint: review.fingerprint, requestId: 'traversal', filePaths: ['../outside'], commitMessage: 'Invalid' })).status, 400);
  const started = await post(`/api/tasks/${id}/git/operations`, { action: 'commit', fingerprint: review.fingerprint, requestId: 'api-commit', commitMessage: 'API commit' });
  assert.equal(started.status, 202); const receipt = await started.json(); const result = await operation(); assert.equal(result.status, 'completed', result.error ?? '');
  const saved = await app.request(`/api/tasks/${id}/git/operations/${receipt.id}`, { headers }); assert.equal(saved.status, 200); assert.equal((await saved.json()).commitSHA, result.commitSHA);
  assert.equal((await readTaskGitStatus(cwd)).files.length, 0); assert.equal((await engine.snapshot()).tasks[0].status, 'completed');
});

test('Already staged renames and deletions commit within a task subdirectory without including staged files outside it', async t => {
  const { root, cwd, git, put, engine, id, operation } = await setup(t, { subdirectory: true });
  await put('scope/delete.txt', 'delete me\n'); await git('add', '.'); await git('commit', '-qm', 'Add deletion fixture');
  await rename(join(root, 'scope/selected.txt'), join(root, 'scope/renamed.txt')); await rm(join(root, 'scope/delete.txt')); await put('excluded.txt', 'outside staged\n'); await git('add', '-A');
  const review = await readTaskGitStatus(cwd);
  assert.deepEqual(review.files.map(file => file.path), ['delete.txt', 'renamed.txt']);
  await engine.gitOperations.start(id, { requestId: 'rename-delete', action: 'commit', fingerprint: review.fingerprint, commitMessage: 'Rename and remove selected files' });
  const result = await operation(); assert.equal(result.status, 'completed', result.error ?? '');
  assert.equal(await git('show', 'HEAD:scope/renamed.txt'), 'before\n');
  await assert.rejects(git('show', 'HEAD:scope/delete.txt'));
  assert.match(await git('diff', '--cached', '--', 'excluded.txt'), /outside staged/); assert.equal(await git('show', 'HEAD:excluded.txt'), 'excluded before\n');
});

test('An unborn repository detects changed staged-file contents and can commit only the reviewed new files', async t => {
  const { cwd, git, put, engine, id, operation } = await setup(t, { empty: true });
  await put('one.txt', 'old content\n'); await put('two.txt', 'other staged\n'); await git('add', '.');
  const stale = await readTaskGitStatus(cwd); await put('one.txt', 'new content\n');
  await assert.rejects(engine.gitOperations.start(id, { requestId: 'stale', action: 'commit', fingerprint: stale.fingerprint, commitMessage: 'Must not run' }), /已经改变/);
  const review = await readTaskGitStatus(cwd);
  await engine.gitOperations.start(id, { requestId: 'first', action: 'commit', fingerprint: review.fingerprint, filePaths: ['one.txt'], commitMessage: 'First selected commit' });
  const result = await operation(); assert.equal(result.status, 'completed', result.error ?? '');
  assert.equal(await git('show', 'HEAD:one.txt'), 'new content\n'); await assert.rejects(git('show', 'HEAD:two.txt'));
  assert.match(await git('diff', '--cached', '--', 'two.txt'), /other staged/);
});

test('Automatic commit text uses a separate persisted session and refuses content changed during generation', { timeout: 20_000 }, async t => {
  const { cwd, put, engine, executor, id, operation, post } = await setup(t);
  await put('scope/selected.txt', 'after\n'); const review = await readTaskGitStatus(cwd);
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  executor.onGenerate = async request => {
    const task = (await engine.snapshot()).tasks[0];
    assert.equal(task.gitOperation?.generation?.threadId, 'git-generation-1'); assert.equal(task.gitOperation?.generation?.turnId, 'git-generation-turn-1');
    assert.equal(request.task.threadId, null); assert.equal(request.task.mode, 'research'); assert.equal(request.purpose, 'git_text');
    if (request.signal.aborted) throw new Error('fixture aborted');
    await Promise.race([held, new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true }))]);
  };
  await engine.gitOperations.start(id, { requestId: 'generated', action: 'commit', fingerprint: review.fingerprint });
  await until(engine, state => !!state.tasks[0]?.gitOperation?.generation?.turnId);
  const userTask = (await engine.snapshot()).tasks[0]; assert.equal(userTask.status, 'completed'); assert.equal(userTask.result, 'Initial answer');
  await assert.rejects(engine.createTask({ continueId: id, prompt: 'Do not overlap', projectId: 'project', mode: 'code', requestId: 'overlap' }), /工作区/);
  await engine.mutate(state => state.projects.push({ id: 'parent', name: 'Parent', path: cwd + '/..', context: '' }));
  await assert.rejects(engine.createTask({ prompt: 'Do not overlap from a parent workspace', projectId: 'parent', mode: 'code', agent: 'codex', requestId: 'parent-overlap' }), /工作区/);
  await assert.rejects(engine.updateTaskMetadata(id, { archived: true }), /停止任务/);
  assert.equal((await post('/api/service/update', {})).status, 409);
  const savedPlan = await post(`/api/tasks/${id}/plan/save`, { eventId: 'missing-plan', path: 'plan.md' });
  assert.equal(savedPlan.status, 400); assert.match((await savedPlan.json()).error, /Git 操作/);
  await put('scope/selected.txt', 'user edited during generation\n'); release();
  const result = await operation(); assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /改动内容已经改变/);
  assert.equal(await readFile(join(cwd, 'scope/selected.txt'), 'utf8'), 'user edited during generation\n');
  assert.equal((await engine.snapshot()).tasks[0].messages?.length, userTask.messages?.length, 'Git text must not become another user-visible agent turn');
});

test('Restarting an interrupted generation never repeats the external request or changes Git history', { timeout: 20_000 }, async t => {
  const { directory, cwd, put, engine, executor, id, git } = await setup(t);
  await put('scope/selected.txt', 'waiting change\n');
  executor.onGenerate = request => new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('fixture interrupted')), { once: true }));
  const review = await readTaskGitStatus(cwd);
  const input = { requestId: 'interrupted-generation', action: 'commit' as const, fingerprint: review.fingerprint };
  const receipt = await engine.gitOperations.start(id, input);
  await until(engine, state => !!state.tasks[0]?.gitOperation?.generation?.turnId);
  const before = await git('rev-parse', 'HEAD'); await engine.close();
  const reopened = await new Engine(join(directory, 'data'), executor).open();
  try {
    const state = await until(reopened, state => state.tasks[0]?.gitOperation?.status === 'interrupted');
    assert.match(state.tasks[0].gitOperation?.error ?? '', /不会自动重复/); assert.equal(executor.generated.length, 1);
    assert.equal(await git('rev-parse', 'HEAD'), before); assert.equal(await reopened.gitOperations.start(id, input), receipt); assert.equal(executor.generated.length, 1);
  } finally { await reopened.close(); }
});
