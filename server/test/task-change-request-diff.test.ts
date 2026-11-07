import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceControlHTTPError, SourceControlResponseTooLarge, type PinnedSourceControlConnection, type JsonOptions } from '../src/source-control-connections.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import { changeRequestDiffSlice, diffCursor, diffPageFiles, rawDiffFiles } from '../src/task-change-request-diff.js';
import { changeRequestFileContents } from '../src/task-change-request-file-contents.js';
const head = 'a'.repeat(40), base = 'b'.repeat(40), commit = 'c'.repeat(40), parent = 'd'.repeat(40);
const hunk = '@@ -1 +1 @@\n-old\n+new\n';
function fixture(provider: 'github' | 'gitlab' | 'bitbucket' = 'github') {
  const repo = sourceControlRepository(`https://${provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'}/fixture/project`)!;
  const state = { head, base, visible: true, pages: new Map<number, unknown[]>(), raw: new SourceControlHTTPError(406, 'raw unavailable') as string | Error, onPage: undefined as (() => void) | undefined, legacy: undefined as Record<string, unknown> | undefined, contentReads: [] as string[], calls: [] as { path: string; options?: JsonOptions }[] };
  const endpoint = (path: string) => { const page = Number(new URL(path, 'https://fixture.invalid').searchParams.get('page') ?? 1); const result = state.pages.get(page) ?? []; state.onPage?.(); return result; };
  const identity = () => provider === 'github' ? { number: 17, title: 'Fixture', html_url: 'https://github.com/fixture/project/pull/17', state: 'open', head: { ref: 'feature', sha: state.head }, base: { ref: 'main', sha: state.base } }
    : provider === 'gitlab' ? { iid: 17, title: 'Fixture', web_url: 'https://gitlab.com/fixture/project/-/merge_requests/17', state: 'opened', sha: state.head, source_branch: 'feature', target_branch: 'main', diff_refs: { base_sha: state.base, head_sha: state.head } }
    : { id: 17, title: 'Fixture', links: { html: { href: 'https://bitbucket.org/fixture/project/pull-requests/17' } }, state: 'OPEN', source: { branch: { name: 'feature' }, commit: { hash: state.head } }, destination: { branch: { name: 'main' }, commit: { hash: state.base } } };
  const pinned: PinnedSourceControlConnection = { provider, host: repo.host, source: 'environment',
    json: async (path, options) => {
      options?.signal?.throwIfAborted(); state.calls.push({ path, options });
      if (path.includes('/contents/') || path.includes('/repository/files/')) { state.contentReads.push(path); const file = decodeURIComponent(path.split('/contents/')[1]?.split('?')[0] ?? path.split('/repository/files/')[1].split('?')[0]); return { path: file, type: 'file', encoding: 'base64', size: 7, content: Buffer.from('literal').toString('base64') }; }
      if (/\/commits\/[a-f0-9]+\?/.test(path)) return { sha: commit, files: endpoint(path) };
      if (/\/(?:commit|commits)\/[a-f0-9]+$/.test(path)) return provider === 'gitlab' ? { id: commit, parent_ids: [parent] } : { sha: commit, parents: [{ sha: parent }] };
      if (path.includes('/diffstat')) return { values: endpoint(path), ...(state.pages.has(Number(new URL(path, 'https://fixture.invalid').searchParams.get('page') ?? 1) + 1) ? { next: 'https://foreign.invalid/ignored' } : {}) };
      if (path.endsWith('/changes') && state.legacy) return state.legacy;
      return identity();
    },
    array: async (path, options) => { options?.signal?.throwIfAborted(); state.calls.push({ path, options }); if (state.legacy && path.includes('/diffs?')) throw new SourceControlHTTPError(404, 'legacy'); return endpoint(path); },
    text: async (path, options) => { options?.signal?.throwIfAborted(); state.calls.push({ path, options }); if (state.raw instanceof Error) throw state.raw; return state.raw; },
    bytes: async (path, options) => { state.contentReads.push(path); return Buffer.from('literal'); },
    graphql: async () => ({ repository: { pullRequest: { commits: { nodes: state.visible ? [{ commit: { oid: commit, messageHeadline: 'Fixture', committedDate: '2026-10-20T00:00:00Z' } }] : [], pageInfo: { hasPreviousPage: false } }, reviewDismissals: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
  };
  return { repo, state, pinned, read: (cursor?: string, selected?: string) => changeRequestDiffSlice(pinned, repo, 17, { head, base, ...(cursor ? { cursor } : {}), ...(selected ? { commit: selected } : {}) }) };
}

test('T3 raw diff fast path preserves Unicode renames, metadata-only and binary entries without fetching file pages', async () => {
  const f = fixture(); f.state.raw = 'diff --git "a/旧 文件.ts" "b/新 文件.ts"\nsimilarity index 100%\nrename from "旧 文件.ts"\nrename to "新 文件.ts"\n' + 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n';
  const result = await f.read(); assert.equal(result.nextCursor, null); assert.equal(result.files.length, 2); assert.equal(result.files[0].status, 'renamed'); assert.equal(result.files[0].oldPath, '旧 文件.ts'); assert.equal(result.files[0].unavailable, false); assert.equal(result.files[0].noHunks, true); assert.equal(result.files[1].omissionReason, 'binary'); assert.equal(f.state.calls.some(c => c.path.includes('/files?')), false);
  assert.equal(f.state.calls.find(c => c.options?.accept)?.options?.timeoutMs, 60000); assert.equal(f.state.calls.find(c => c.options?.accept)?.options?.maxResponseBytes, 8 * 1024 * 1024);
});
test('Fallback slices keep omission statistics separate from the next cursor and can load beyond the previous 1000-file cap', async () => {
  const f = fixture(); f.state.pages.set(1, Array.from({ length: 100 }, (_, i) => ({ filename: 'file-' + i, status: 'modified', additions: 1, patch: hunk })));
  const first = await f.read(); assert.equal(first.nextCursor, '2'); assert.equal(first.truncated, false); assert.equal(first.files.length, 100);
  f.state.pages.set(11, [{ filename: 'beyond.ts', status: 'modified', additions: 17, deletions: 4 }]); const later = await f.read('11'); assert.equal(later.files[0].path, 'beyond.ts'); assert.equal(later.files[0].omissionReason, 'host_omitted'); assert.equal(later.truncated, true); assert.equal(later.nextCursor, null); assert.deepEqual(later.omittedFileStats, [{ path: 'beyond.ts', additions: 17, deletions: 4 }]);
  const before = f.state.calls.length; await assert.rejects(f.read('https://foreign.invalid/next'), /游标/); assert.equal(f.state.calls.length, before);
});
test('Raw byte limits fall back, malformed page entries still advance by raw count, and large inline hunks are retained', async () => {
  const f = fixture(); f.state.raw = new SourceControlResponseTooLarge(); f.state.pages.set(1, Array.from({ length: 100 }, () => ({ filename: '' })));
  const invalid = await f.read(); assert.equal(invalid.nextCursor, '2'); assert.equal(invalid.truncated, true); assert.equal(invalid.files.length, 0);
  const patch = '@@ -0,0 +1 @@\n+' + 'x'.repeat(1024 * 1024 + 1) + '\n'; f.state.pages.set(2, [{ filename: 'large.txt', status: 'added', patch }]); const second = await f.read('2'); assert(second.files[0].patch.endsWith(patch)); assert.equal(second.files[0].unavailable, false);
});
for (const provider of ['github','gitlab','bitbucket'] as const) test(`${provider}: every slice and cursor-scoped complete file rechecks the PR head and base`, async () => {
  const f = fixture(provider); const entry = provider === 'github' ? { filename: 'later.ts', patch: hunk } : provider === 'gitlab' ? { old_path: 'later.ts', new_path: 'later.ts', diff: hunk } : { old: { path: 'later.ts' }, new: { path: 'later.ts' }, lines_added: 1, lines_removed: 1 };
  f.state.pages.set(12, [entry]); if (provider === 'bitbucket') f.state.raw = 'diff --git a/later.ts b/later.ts\n--- a/later.ts\n+++ b/later.ts\n' + hunk;
  const full = await changeRequestFileContents(f.pinned, f.repo, 17, { path: 'later.ts', head, base, side: 'new', cursor: '12' }); assert.equal(full.text, 'literal'); assert.equal(full.requestBaseSha, base); assert.equal(f.state.contentReads.length, 1);
  f.state.onPage = () => { f.state.base = 'e'.repeat(40); }; await assert.rejects(f.read('12'), /代码版本/);
  f.state.base = base; f.state.contentReads = []; await assert.rejects(changeRequestFileContents(f.pinned, f.repo, 17, { path: 'later.ts', head, base, side: 'new', cursor: '12' }), /代码版本/); assert.equal(f.state.contentReads.length, 0);
});
test('GitLab legacy changes preserve overflow; actual hunks override obsolete collapsed flags', async () => {
  const f = fixture('gitlab'); f.state.legacy = { changes: [{ old_path: 'a', new_path: 'a', diff: '', collapsed: true }], overflow: true, changes_count: '1000+' };
  const result = await f.read(); assert.equal(result.nextCursor, null); assert.equal(result.truncated, true); assert.equal(result.files[0].omissionReason, 'collapsed');
  const shown = diffPageFiles('gitlab', [{ old_path: 'a', new_path: 'a', diff: hunk, collapsed: true }], '1'); assert.equal(shown.files[0].unavailable, false);
});
test('Bitbucket pagination never follows a credential-bearing foreign next URL', async () => {
  const f = fixture('bitbucket'); f.state.pages.set(1, [{ old: { path: 'a' }, new: { path: 'a' } }]); f.state.pages.set(2, []); f.state.raw = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n' + hunk;
  const first = await f.read(); assert.equal(first.nextCursor, '2'); await f.read(first.nextCursor!); assert(!f.state.calls.some(c => c.path.includes('foreign.invalid')));
});
test('Commit slices bind visible membership and full old contents to the first parent', async () => {
  const f = fixture(); f.state.pages.set(2, [{ filename: 'changed.ts', patch: hunk }]); const slice = await f.read('2', commit); assert.equal(slice.headSha, commit); assert.equal(slice.requestHeadSha, head);
  const old = await changeRequestFileContents(f.pinned, f.repo, 17, { path: 'changed.ts', head, base, side: 'old', cursor: '2', commit }); assert.equal(old.revision, parent);
  f.state.onPage = () => { f.state.visible = false; }; await assert.rejects(f.read('2', commit), /可见提交/);
});
test('Cursor validation and cancellation do not start platform reads', async () => {
  for (const value of ['0','01','-1','1e3','99999999','2&x=y','']) assert.throws(() => diffCursor(value), /游标/);
  const f = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(changeRequestDiffSlice(f.pinned, f.repo, 17, { head }, controller.signal)); assert.equal(f.state.calls.length, 0);
  assert.equal(rawDiffFiles('diff --git a/a b/a\nold mode 100644\nnew mode 100755\n').files[0].unavailable, false);
});

test('Raw HTTP errors survive a failed fallback, while cancellation never starts a fallback page', async () => {
  const f = fixture(), original = new SourceControlHTTPError(503, 'raw unavailable'); f.state.raw = original;
  f.pinned.array = async () => { throw new Error('fallback failed'); };
  await assert.rejects(f.read(), error => error === original);
  const aborted = fixture(), controller = new AbortController();
  aborted.pinned.text = async () => { controller.abort(); throw new SourceControlHTTPError(503, 'cancelled'); };
  await assert.rejects(changeRequestDiffSlice(aborted.pinned, aborted.repo, 17, { head }, controller.signal));
  assert.equal(aborted.state.calls.filter(c => c.path.includes('/files?')).length, 0);
});

test('Complete files cannot escape a slice, use a stale base, and raw contents can pass the legacy file-count cap', async () => {
  const f = fixture(); f.state.pages.set(11, [{ filename: 'later.ts', patch: hunk }]);
  await assert.rejects(changeRequestFileContents(f.pinned, f.repo, 17, { path: 'elsewhere.ts', head, base, side: 'new', cursor: '11' }), /所选 Diff/);
  await assert.rejects(changeRequestFileContents(f.pinned, f.repo, 17, { path: 'later.ts', head, base: 'e'.repeat(40), side: 'new', cursor: '11' }), /基准/);
  assert.equal(f.state.contentReads.length, 0);
  const priorPages = f.state.calls.filter(c => c.path.includes('/files?')).length;
  f.state.raw = Array.from({ length: 1101 }, (_, i) => `diff --git a/file-${i} b/file-${i}\nold mode 100644\nnew mode 100755\n`).join('');
  const full = await changeRequestFileContents(f.pinned, f.repo, 17, { path: 'file-1100', head, base, side: 'new', slice: true });
  assert.equal(full.text, 'literal'); assert.equal(f.state.calls.filter(c => c.path.includes('/files?')).length, priorPages);
  assert.equal(f.state.contentReads.length, 1);
});
