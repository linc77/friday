import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceControlReviewStore } from '../src/source-control-review-store.js';
import { TaskChangeRequestReviewState, githubReactions, reviewStateInput } from '../src/task-change-request-review-state.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import { parseDiffFileRevisions, parseDiffFilePaths } from '../src/vendor/t3-diff-file-revisions.js';
import { quoteGitPatchPath, unquoteGitPatchPath } from '../src/vendor/t3-git-patch-path.js';
import type { PinnedSourceControlConnection } from '../src/source-control-connections.js';
import type { ChangeRequestDetail } from '../src/task-change-request-data.js';
import { changeRequestFiles } from '../src/task-change-request-data.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
function fixture(provider: 'github' | 'gitlab' | 'bitbucket') {
  const repository = sourceControlRepository(`https://${provider === 'github' ? 'github.com/fixture/project' : provider === 'gitlab' ? 'gitlab.com/group/sub/project' : 'bitbucket.org/fixture/project'}`)!;
  const state = { viewer: 'first', head: a, blobs: {} as Record<string, string>, unavailable: false, patch: '', writes: [] as { path: string; options: any }[], awards: [] as any[] };
  const p: PinnedSourceControlConnection = { provider, host: repository.host, source: 'settings',
    json: async (path, options) => {
      if (path === 'user') return { username: state.viewer, nickname: state.viewer };
      if (path === 'graphql') return { data: { project: state.unavailable ? null : { repository: { blobs: { nodes: (options?.body?.variables as any).paths.filter((path: string) => state.blobs[path] !== undefined).map((path: string) => ({ path, oid: state.blobs[path] })) } } } } };
      if (options?.method && options.method !== 'GET') { state.writes.push({ path, options }); return {}; }
      if (path.includes('/notes/')) return { id: Number(path.split('/').at(-1)) };
      return { sha: state.head };
    }, array: async () => state.awards,
    text: async () => { if (state.unavailable) throw new Error('Synthetic unavailable patch'); return state.patch; },
    graphql: async (query, variables) => { state.writes.push({ path: 'graphql', options: { query, variables } }); return {}; } };
  const detail: ChangeRequestDetail = { pullRequest: { number: 17, url: 'https://fixture.invalid', title: 'Fixture', state: 'open', head: 'feature', base: 'main' }, body: '', author: 'first', createdAt: '', updatedAt: '', isDraft: false, headSha: a, nodeId: 'node-17', mergeability: 'unknown', actions: [], mergeMethods: [], verdicts: [], canComment: true, reviewers: [], labels: [], checks: [] };
  return { repository, state, p, detail };
}
async function directory(t: { after(fn: () => Promise<unknown>): void }) { const dir = await mkdtemp(join(tmpdir(), 'friday-review-state-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function run(effects: Awaited<ReturnType<TaskChangeRequestReviewState['effects']>>) { for (const effect of effects) await effect.run(new AbortController().signal); }

test('Environment viewed storage is private, viewer-scoped, persistent and explicitly bounded like T3', async t => {
  const dir = await directory(t), repository = fixture('gitlab').repository, scope = { repository, number: 17, viewer: 'first' };
  let store = new SourceControlReviewStore(dir); t.after(async () => store.close());
  store.set(scope, [{ path: ' leading \tpath ', revision: a, viewed: true }, { path: 'removed.ts', revision: '', viewed: true }]);
  assert.deepEqual(new Set(store.list(scope).files.map(v => v.path)), new Set([' leading \tpath ', 'removed.ts']));
  assert.equal(store.list({ ...scope, viewer: 'second' }).files.length, 0);
  store.close(); store = new SourceControlReviewStore(dir); assert.equal(store.list(scope).files[0].path, ' leading \tpath ');
  assert.equal((await stat(join(dir, 'source-control-review.sqlite'))).mode & 0o777, 0o600);
  store.set(scope, [{ path: 'removed.ts', revision: null, viewed: false }]); assert.equal(store.list(scope).files.length, 1);
  store.set(scope, Array.from({ length: 501 }, (_, index) => ({ path: 'path-' + index, revision: null, viewed: true })));
  assert.equal(store.list(scope).files.length, 500); assert.equal(store.list(scope).truncated, true);
});

test('A dangling alias cannot create the review database at another path', async t => {
  const dir = await directory(t); await symlink(join(dir, 'target.sqlite'), join(dir, 'source-control-review.sqlite'));
  const store = new SourceControlReviewStore(dir); t.after(async () => store.close());
  assert.throws(() => store.list({ repository: fixture('gitlab').repository, number: 17, viewer: 'first' }), /独立文件/);
  await assert.rejects(stat(join(dir, 'target.sqlite')));
});

test('GitLab marks follow the file blob rather than the whole head and keep an unavailable baseline distinct from deletion', async t => {
  const dir = await directory(t), f = fixture('gitlab'); const review = new TaskChangeRequestReviewState(dir); t.after(async () => review.close());
  f.state.blobs['a.ts'] = a;
  await run(await review.effects(f.p, f.repository, f.detail, { action: 'files_viewed', files: [{ path: 'a.ts', viewed: true }] }));
  f.state.head = b; assert.equal((await review.viewed(f.p, f.repository, 17)).files[0].state, 'viewed', 'An unrelated push does not unmark an unchanged file');
  f.state.blobs['a.ts'] = c; assert.equal((await review.viewed(f.p, f.repository, 17)).files[0].state, 'dismissed');
  f.state.unavailable = true; assert.equal((await review.viewed(f.p, f.repository, 17)).files[0].state, 'viewed', 'An unknown version cannot claim the file changed');
  await run(await review.effects(f.p, f.repository, f.detail, { action: 'files_viewed', files: [{ path: 'no-baseline.ts', viewed: true }] }));
  f.state.unavailable = false; f.state.blobs['no-baseline.ts'] = b;
  assert.equal((await review.viewed(f.p, f.repository, 17)).files.find(v => v.path === 'no-baseline.ts')?.state, 'viewed');
  delete f.state.blobs['deleted.ts']; await run(await review.effects(f.p, f.repository, f.detail, { action: 'files_viewed', files: [{ path: 'deleted.ts', viewed: true }] }));
  f.state.blobs['deleted.ts'] = c; assert.equal((await review.viewed(f.p, f.repository, 17)).files.find(v => v.path === 'deleted.ts')?.state, 'dismissed');
  f.state.viewer = 'second'; assert.equal((await review.viewed(f.p, f.repository, 17)).files.length, 0);
  assert.equal(f.state.writes.length, 0, 'Environment marks do not pretend to write to GitLab');
});

test('Bitbucket viewed versions come from patch index metadata, including binary, rename and quoted paths', async t => {
  const dir = await directory(t), f = fixture('bitbucket'); const review = new TaskChangeRequestReviewState(dir); t.after(async () => review.close());
  f.state.patch = 'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\nindex ' + a + '..' + b + ' 100644\n';
  await run(await review.effects(f.p, f.repository, f.detail, { action: 'files_viewed', files: [{ path: 'new.ts', viewed: true }] }));
  assert.equal((await review.viewed(f.p, f.repository, 17)).files[0].state, 'viewed');
  f.state.patch = f.state.patch.replace(b, c); assert.equal((await review.viewed(f.p, f.repository, 17)).files[0].state, 'dismissed');
  const patch = 'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"\nindex ' + a + '..' + b + ' 100644\nBinary files differ\n';
  assert.equal(parseDiffFileRevisions(patch).get('中.txt'), b);
  const name = '\ufeff leading\tname\n '; assert.equal(unquoteGitPatchPath(quoteGitPatchPath(name)), name);
  const changed = `diff --git ${quoteGitPatchPath('a/' + name)} ${quoteGitPatchPath('b/' + name)}\nindex ${a}..${b} 100644\n--- ${quoteGitPatchPath('a/' + name)}\n+++ ${quoteGitPatchPath('b/' + name)}\n@@ -1 +1 @@\n-index pretend..fake\n+new\n`;
  assert.equal(parseDiffFileRevisions(changed).get(name), b); assert.deepEqual(parseDiffFilePaths(changed), [{ oldPath: name, newPath: name }]);
});

test('Viewed batches preserve filename whitespace, allow 500 presses and preserve duplicate press order', async t => {
  const input = reviewStateInput({ action: 'files_viewed', files: [{ path: ' a\t.ts ', viewed: true }, { path: ' a\t.ts ', viewed: false }] });
  assert.deepEqual(input.files?.map(v => v.path), [' a\t.ts ', ' a\t.ts ']);
  const f = fixture('github'), review = new TaskChangeRequestReviewState(await directory(t)); t.after(async () => review.close());
  await run(await review.effects(f.p, f.repository, f.detail, input)); const command = f.state.writes[0].options;
  assert.match(command.query, /f0:markFileAsViewed/); assert.match(command.query, /f1:unmarkFileAsViewed/); assert.equal(command.variables.path0, ' a\t.ts ');
  assert.equal(reviewStateInput({ action: 'files_viewed', files: Array.from({ length: 500 }, (_, i) => ({ path: 'a' + i, viewed: true })) }).files?.length, 500);
  assert.throws(() => reviewStateInput({ action: 'files_viewed', files: Array.from({ length: 501 }, () => ({ path: 'a', viewed: true })) }), /无效/);
  assert.throws(() => reviewStateInput({ action: 'files_viewed', files: [{ path: '\ud800', viewed: true }] }), /无效/);
});

test('Reaction metadata counts the viewer once and GitLab removes only the viewer’s award', async t => {
  const group = githubReactions([{ content: 'THUMBS_UP', viewerHasReacted: true, reactors: { totalCount: 3, nodes: [{ login: 'first' }, { login: 'other' }, { login: 'other' }] } }], 'FIRST')[0];
  assert.deepEqual(group, { content: 'thumbs-up', count: 3, actors: ['other'], viewerHasReacted: true });
  const f = fixture('gitlab'), review = new TaskChangeRequestReviewState(await directory(t)); t.after(async () => review.close());
  f.state.awards = [{ id: 9, name: 'thumbsup', user: { username: 'other' } }, { id: 17, name: 'thumbsup', user: { username: 'first' } }];
  await run(await review.effects(f.p, f.repository, f.detail, { action: 'reaction', content: 'thumbs-up', reacted: false }));
  assert.match(f.state.writes[0].path, /award_emoji\/17$/); assert.equal(f.state.writes[0].options.method, 'DELETE');
  f.state.awards = [f.state.awards[0]]; await run(await review.effects(f.p, f.repository, f.detail, { action: 'reaction', content: 'thumbs-up', reacted: false })); assert.equal(f.state.writes.length, 1);
  await run(await review.effects(f.p, f.repository, f.detail, { action: 'reaction', content: 'hooray', reacted: true })); assert.match(f.state.writes[1].path, /award_emoji\?name=tada$/);
  const bb = fixture('bitbucket'); assert.equal((await review.reactions(bb.p, bb.repository, 17)).supported, false); await assert.rejects(review.effects(bb.p, bb.repository, bb.detail, { action: 'reaction', content: 'heart', reacted: true }), /不支持/);
});

test('Displayed Bitbucket diffs resolve the same quoted filename bytes used for version marks', async () => {
  const f = fixture('bitbucket'), name = ' leading\t中🙂 ', patch = `diff --git ${quoteGitPatchPath('a/' + name)} ${quoteGitPatchPath('b/' + name)}\nindex ${a}..${b} 100644\n--- ${quoteGitPatchPath('a/' + name)}\n+++ ${quoteGitPatchPath('b/' + name)}\n@@ -1 +1 @@\n-old\n+new\n`;
  f.p.json = async path => path.includes('/diffstat') ? { values: [{ old: { path: name }, new: { path: name } }] } : { id: 17, title: 'Fixture', state: 'OPEN', links: { html: { href: 'https://bitbucket.org/fixture/project/pull-requests/17' } }, source: { branch: { name: 'feature' }, commit: { hash: a } }, destination: { branch: { name: 'main' }, commit: { hash: b } } };
  f.p.text = async () => patch;
  const files = await changeRequestFiles(f.p, f.repository, 17, a);
  assert.equal(files.files[0].path, name); assert.equal(files.files[0].patch, patch); assert.equal(files.files[0].unavailable, false);
});
