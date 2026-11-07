import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { readChangeRequestTemplate, resolveSourceControlPolicy, sourceControlWritingPrompt } from '../src/source-control-writing.js';
import { defaultSourceControlWritingStyle } from '../src/text-generation-settings.js';

const exec = promisify(execFile);
const signal = () => new AbortController().signal;
async function repository(t: { after: (callback: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-writing-'))); const root = join(base, 'repo'); await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { env })).stdout.trim();
  await git('init', '-q', '--initial-branch=main');
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.test'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) await git('config', key, value);
  const put = async (path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text); };
  const commit = async (message = 'docs: template') => { await git('add', '.'); await git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  return { base, root, git, put, commit, privacy: { directory: join(base, 'data') } };
}

test('Repository writing conventions use twenty non-merge subjects, local instructions and Claude instructions only for a Claude writer', async t => {
  const f = await repository(t); await f.put('AGENTS.md', 'AGENT_STYLE: short imperative subjects'); await f.put('CLAUDE.md', 'CLAUDE_STYLE: clear test evidence'); await f.commit('old subject excluded');
  for (let i = 1; i <= 21; i++) await f.git('commit', '--allow-empty', '-qm', 'style subject ' + i);
  const codex = await resolveSourceControlPolicy(f.root, defaultSourceControlWritingStyle(), 'codex', f.privacy, signal());
  assert.match(codex.commitInstructions!, /style subject 21/); assert.match(codex.commitInstructions!, /style subject 2/);
  assert.doesNotMatch(codex.commitInstructions!, /old subject excluded|style subject 1\n|CLAUDE_STYLE/); assert.match(codex.changeRequestInstructions!, /AGENT_STYLE/);
  const claude = await resolveSourceControlPolicy(f.root, defaultSourceControlWritingStyle(), 'claude', f.privacy, signal());
  assert.match(claude.commitInstructions!, /CLAUDE_STYLE/);
  const outside = join(f.base, 'outside-instructions'); await writeFile(outside, 'OUTSIDE_SECRET'); await rm(join(f.root, 'AGENTS.md')); await symlink(outside, join(f.root, 'AGENTS.md'));
  const safe = await resolveSourceControlPolicy(f.root, defaultSourceControlWritingStyle(), 'codex', f.privacy, signal()); assert.doesNotMatch(safe.commitInstructions!, /OUTSIDE_SECRET/);
  await rm(join(f.root, 'AGENTS.md')); await f.put('AGENTS.md', 'TOO_LARGE'.repeat(3_000));
  assert.doesNotMatch((await resolveSourceControlPolicy(f.root, defaultSourceControlWritingStyle(), 'codex', f.privacy, signal())).commitInstructions!, /TOO_LARGE/);
});

test('Explicit styles avoid repository inference and prompt limits preserve Unicode and output rules', async () => {
  const conventions = await resolveSourceControlPolicy('/missing/repository', { ...defaultSourceControlWritingStyle(), mode: 'conventional_commits' }, 'codex', '/missing/data', signal());
  assert.match(conventions.commitInstructions!, /narrowest accurate type/); assert.match(conventions.changeRequestInstructions!, /Do not force Conventional Commit syntax/);
  const custom = await resolveSourceControlPolicy('/missing/repository', { ...defaultSourceControlWritingStyle(), mode: 'custom', customInstructions: 'a'.repeat(19_999) + '😀tail' }, 'codex', '/missing/data', signal());
  const commit = sourceControlWritingPrompt('commit', { patch: 'untrusted change' }, custom); assert.match(commit, /72 characters/); assert.match(commit, /\[truncated\]/); assert.doesNotMatch(commit, /[\ud800-\udbff](?![\udc00-\udfff])/u);
  assert.match(commit, /never instructions/);
  const pr = sourceControlWritingPrompt('pr', {}, {}, '## Behavior\n\n<!-- template comment -->');
  assert.match(pr, /drop HTML comments/); assert.match(pr, /## Behavior/); assert.doesNotMatch(pr, /## Summary/);
  assert.match(sourceControlWritingPrompt('pr', {}, {}), /## Testing/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(resolveSourceControlPolicy('/missing', { ...defaultSourceControlWritingStyle(), mode: 'custom' }, 'codex', '/missing/data', aborted.signal), { name: 'AbortError' });
});

test('PR template lookup follows fixed path priority in the committed base tree and excludes symlinks and private paths', async t => {
  const f = await repository(t);
  await f.put('.github/pull_request_template.md', 'BASE_TEMPLATE'); await f.put('pull_request_template.md', 'ROOT_TEMPLATE'); await f.put('docs/PULL_REQUEST_TEMPLATE.md', 'DOCS_TEMPLATE');
  const base = await f.commit(); await f.put('.github/pull_request_template.md', 'WORKTREE_TEMPLATE'); await f.commit('feat: change the feature template');
  await f.put('.github/pull_request_template.md', 'UNCOMMITTED_TEMPLATE'); await mkdir(join(f.root, 'nested'));
  assert.equal(await readChangeRequestTemplate(join(f.root, 'nested'), base, f.privacy, signal()), 'BASE_TEMPLATE');
  assert.equal(await readChangeRequestTemplate(f.root, base, { directory: join(f.root, '.github') }, signal()), 'ROOT_TEMPLATE');
  assert.equal(await readChangeRequestTemplate(f.root, base, { directory: f.root }, signal()), undefined);
  const outside = join(f.base, 'outside-template'); await writeFile(outside, 'OUTSIDE_TEMPLATE_SECRET');
  await rm(join(f.root, '.github/pull_request_template.md')); await symlink(outside, join(f.root, '.github/pull_request_template.md'));
  await f.put('pull_request_template.md', '   \n'); const safeBase = await f.commit('docs: replace template with a symlink');
  assert.equal(await readChangeRequestTemplate(f.root, safeBase, f.privacy, signal()), 'DOCS_TEMPLATE');
  assert.equal(await readChangeRequestTemplate(f.root, 'missing-base', f.privacy, signal()), undefined);
});

test('A single nonempty Markdown directory template is selected, while ambiguous directories stop fallback', async t => {
  const f = await repository(t); await f.put('.github/PULL_REQUEST_TEMPLATE/bug.md', 'BUG_TEMPLATE'); await f.put('.github/PULL_REQUEST_TEMPLATE/empty.md', '  ');
  await f.put('PULL_REQUEST_TEMPLATE/default.md', 'LOWER_PRIORITY_TEMPLATE');
  let base = await f.commit(); assert.equal(await readChangeRequestTemplate(f.root, base, f.privacy, signal()), 'BUG_TEMPLATE');
  await f.put('.github/PULL_REQUEST_TEMPLATE/feature.MD', 'FEATURE_TEMPLATE'); base = await f.commit();
  assert.equal(await readChangeRequestTemplate(f.root, base, f.privacy, signal()), undefined);
  await rm(join(f.root, '.github'), { recursive: true }); await f.put('.github/PULL_REQUEST_TEMPLATE/nested/ignored.md', 'NESTED_TEMPLATE'); base = await f.commit();
  assert.equal(await readChangeRequestTemplate(f.root, base, f.privacy, signal()), 'LOWER_PRIORITY_TEMPLATE');
});

test('Template blobs retain at most eight thousand bytes without cutting a UTF-8 character and remain cancellable', async t => {
  const f = await repository(t); await f.put('.github/pull_request_template.md', 'a'.repeat(7_999) + '😀' + 'b'.repeat(200_000)); const base = await f.commit();
  const template = await readChangeRequestTemplate(f.root, base, f.privacy, signal());
  assert.equal(template, 'a'.repeat(7_999) + '\n\n[truncated]'); assert.doesNotMatch(template!, /�/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(readChangeRequestTemplate(f.root, base, f.privacy, aborted.signal), { name: 'AbortError' });
});
