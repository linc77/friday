import test from 'node:test';
import assert from 'node:assert/strict';
import { changeRequestFileContents, changeRequestFilePath } from '../src/task-change-request-file-contents.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import type { PinnedSourceControlConnection } from '../src/source-control-connections.js';
const head = 'a'.repeat(40), base = 'b'.repeat(40), selected = 'c'.repeat(40), parent = 'd'.repeat(40), blob = 'e'.repeat(40);
type Provider = 'github' | 'gitlab' | 'bitbucket';
function fixture(provider: Provider = 'github') {
  const host = provider === 'github' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org', repo = provider === 'gitlab' ? 'owner/group/repo' : 'owner/repo';
  const repository = sourceControlRepository(`https://${host}/${repo}`)!, root = provider === 'github' ? `repos/${repo}/pulls/17` : provider === 'gitlab' ? `projects/${encodeURIComponent(repo)}/merge_requests/17` : `repositories/${repo}/pullrequests/17`;
  const url = `https://${host}/${repo}/${provider === 'github' ? 'pull' : provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/17`;
  const state = { head, base, parent: parent as string | null, visible: true, contents: Buffer.from('before\nunchanged outside hunk\n'), requests: [] as string[], fileReads: [] as { path: string; revision: string }[], status: 'renamed', path: 'src/新 name.ts', oldPath: 'src/old name.ts', rawType: 'file', wrongPath: false, wrongCommit: false, encoding: 'base64', onBlob: undefined as (() => void) | undefined };
  const patch = () => `diff --git ${JSON.stringify('a/' + state.oldPath)} ${JSON.stringify('b/' + state.path)}\n--- ${state.status === 'added' ? '/dev/null' : JSON.stringify('a/' + state.oldPath)}\n+++ ${state.status === 'removed' ? '/dev/null' : JSON.stringify('b/' + state.path)}\n@@ -1 +1 @@\n-before\n+after\n`;
  const raw = () => provider === 'github' ? { number: 17, html_url: url, title: 'Fixture', state: 'open', head: { sha: state.head, ref: 'feature' }, base: { sha: state.base, ref: 'main' } }
    : provider === 'gitlab' ? { iid: 17, web_url: url, title: 'Fixture', state: 'opened', sha: state.head, source_branch: 'feature', target_branch: 'main', diff_refs: { base_sha: state.base, head_sha: state.head, start_sha: state.base } }
    : { id: 17, links: { html: { href: url } }, title: 'Fixture', state: 'OPEN', source: { commit: { hash: state.head }, branch: { name: 'feature' } }, destination: { commit: { hash: state.base }, branch: { name: 'main' } } };
  const rows = () => provider === 'github' ? [{ filename: state.path, previous_filename: state.oldPath, status: state.status, patch: '@@ -1 +1 @@\n-before\n+after' }]
    : provider === 'gitlab' ? [{ old_path: state.oldPath, new_path: state.path, new_file: state.status === 'added', deleted_file: state.status === 'removed', renamed_file: state.status === 'renamed', diff: '@@ -1 +1 @@\n-before\n+after' }]
    : [{ old: state.status === 'added' ? undefined : { path: state.oldPath }, new: state.status === 'removed' ? undefined : { path: state.path }, status: state.status }];
  const history = () => !state.visible ? [] : provider === 'github' ? [{ commit: { oid: selected, committedDate: '2026-10-20T01:00:00Z', messageHeadline: 'one change', authors: { nodes: [] } } }] : provider === 'gitlab' ? [{ id: selected, committed_date: '2026-10-20T01:00:00Z', title: 'one change' }] : [{ hash: selected, date: '2026-10-20T01:00:00Z', message: 'one change' }];
  const json = async (path: string): Promise<Record<string, any>> => {
    state.requests.push(path); const route = path.split('?')[0];
    if (route === root) return raw();
    if (route.endsWith('/diffstat')) return { values: rows() };
    if (route === root + '/commits') return { values: history() };
    if (route.includes('/contents/') || /\/repository\/files\//.test(route)) {
      const target = decodeURIComponent(provider === 'github' ? route.split('/contents/')[1] : route.split('/repository/files/')[1]), revision = new URL('https://synthetic.test/' + path).searchParams.get('ref')!;
      state.fileReads.push({ path: target, revision }); state.onBlob?.();
      return { type: state.rawType, path: state.wrongPath ? 'other' : target, file_path: state.wrongPath ? 'other' : target, size: state.contents.length, encoding: state.encoding, content: state.contents.toString('base64'), sha: blob };
    }
    if (route.includes('/git/blobs/')) return { sha: blob, size: state.contents.length, encoding: 'base64', content: state.contents.toString('base64') };
    if (route.endsWith('/' + selected)) return provider === 'github' ? { sha: state.wrongCommit ? head : selected, parents: state.parent ? [{ sha: state.parent }] : [], files: rows() } : provider === 'gitlab' ? { id: state.wrongCommit ? head : selected, parent_ids: state.parent ? [state.parent] : [] } : { hash: state.wrongCommit ? head : selected, parents: state.parent ? [{ hash: state.parent }] : [] };
    throw Error('Unexpected synthetic JSON endpoint: ' + path);
  };
  const pinned: PinnedSourceControlConnection = { provider, host, source: 'cli', json,
    graphql: async () => ({ repository: { pullRequest: { commits: { nodes: history(), pageInfo: { hasPreviousPage: false } }, reviewDismissals: { nodes: [], pageInfo: { hasNextPage: false } } } } }),
    array: async path => { state.requests.push(path); return path.includes('/commits?') && !path.includes('/repository/') ? history() : rows(); },
    text: async path => { state.requests.push(path); return patch(); },
    bytes: async path => { state.requests.push(path); const match = path.match(/\/src\/([a-f0-9]+)\/(.+)/)!; state.fileReads.push({ path: decodeURIComponent(match[2]), revision: match[1] }); state.onBlob?.(); return state.contents; } };
  return { state, pinned, repository, read: (options: Record<string, unknown> = {}) => changeRequestFileContents(pinned, repository, 17, { path: state.path, head, side: 'new', ...options }) };
}
for (const provider of ['github', 'gitlab', 'bitbucket'] as const) {
  test(`${provider}: whole-change file contents use immutable sides and the original path for a renamed Unicode file`, async () => {
    const f = fixture(provider), old = await f.read({ side: 'old' }), value = await f.read(); assert.equal(old.revision, base); assert.equal(old.path, f.state.oldPath); assert.equal(old.kind, 'text'); assert.equal(value.revision, head); assert.equal(value.text, 'before\nunchanged outside hunk\n'); assert.deepEqual(f.state.fileReads.map(v => v.revision), [base, head]);
  });
  test(`${provider}: selected-commit files use that commit and its first parent and must remain in PR history`, async () => {
    const f = fixture(provider); const old = await f.read({ side: 'old', commit: selected }), value = await f.read({ commit: selected }); assert.equal(old.revision, parent); assert.equal(value.revision, selected); assert.equal(value.scopeCommit, selected);
    f.state.visible = false; const count = f.state.fileReads.length; await assert.rejects(f.read({ commit: selected }), /可见提交记录/); assert.equal(f.state.fileReads.length, count);
  });
  test(`${provider}: added old sides and deleted new sides are absent and never read another file`, async () => {
    const f = fixture(provider); f.state.status = 'added'; f.state.parent = null; const added = await f.read({ side: 'old', commit: selected }); assert.equal(added.kind, 'absent'); assert.equal(added.revision, null); assert.equal(f.state.fileReads.length, 0);
    f.state.status = 'removed'; f.state.path = f.state.oldPath; const deleted = await f.read(); assert.equal(deleted.kind, 'absent'); assert.equal(f.state.fileReads.length, 0);
  });
  test(`${provider}: binary image bytes remain exact and non-image invalid UTF-8 is unavailable`, async () => {
    const f = fixture(provider); f.state.path = 'image.png'; f.state.oldPath = 'before.png'; f.state.contents = Buffer.from([137, 80, 78, 71, 0, 255, 1]); const image = await f.read(); assert.equal(image.kind, 'image'); assert.deepEqual(Buffer.from(image.base64!, 'base64'), f.state.contents);
    f.state.path = 'opaque.bin'; const opaque = await f.read(); assert.equal(opaque.kind, 'unavailable'); assert.equal(opaque.reason, 'binary'); assert.equal(opaque.base64, undefined);
  });
  test(`${provider}: a push or target-branch move during a file read cannot mix versions`, async () => {
    const f = fixture(provider); f.state.onBlob = () => { f.state.head = selected; }; await assert.rejects(f.read(), /代码版本已改变/);
    const g = fixture(provider); g.state.onBlob = () => { g.state.base = parent; }; await assert.rejects(g.read(), /代码版本已改变/);
    const h = fixture(provider); h.state.onBlob = () => { h.state.visible = false; }; await assert.rejects(h.read({ commit: selected }), /可见提交记录/);
  });
}
test('Revision reads reject traversal, unknown sides, foreign provider bindings and paths not in the selected diff before reading contents', async () => {
  const f = fixture(); for (const path of ['../secret', '/absolute', 'a/../b', '.git/config', 'a\\b', 'a\0b']) assert.throws(() => changeRequestFilePath(path));
  await assert.rejects(f.read({ side: 'other' }), /审查范围无效/); await assert.rejects(f.read({ path: 'unrelated' }), /所选 Diff/); assert.equal(f.state.fileReads.length, 0);
  await assert.rejects(changeRequestFileContents({ ...f.pinned, host: 'evil.test' }, f.repository, 17, { path: f.state.path, head, side: 'new' }), /目标不一致/);
});
test('Full text preserves BOM and exact content, refuses symlinks, oversized and mismatching metadata, and uses blobs for large GitHub images', async () => {
  const f = fixture(); f.state.contents = Buffer.from('\ufeffliteral <script>\r\n'); assert.equal((await f.read()).text, '\ufeffliteral <script>\r\n'); f.state.rawType = 'symlink'; assert.equal((await f.read()).reason, 'symlink');
  f.state.rawType = 'file'; f.state.contents = Buffer.alloc(1024 * 1024 + 1, 97); assert.equal((await f.read()).reason, 'oversized'); f.state.contents = Buffer.from('ok'); f.state.wrongPath = true; await assert.rejects(f.read(), /路径不一致/);
  f.state.wrongPath = false; f.state.path = 'large.png'; f.state.encoding = 'none'; f.state.contents = Buffer.alloc(1024 * 1024 + 1, 1); assert.equal((await f.read()).kind, 'image'); assert(f.state.requests.some(v => v.includes('/git/blobs/')));
});
test('Old commit files require the exact parent metadata and case-insensitive SHA input resolves to the selected immutable commit', async () => {
  const f = fixture(); f.state.wrongCommit = true; await assert.rejects(f.read({ side: 'old', commit: selected }), /版本不一致/); assert.equal(f.state.fileReads.length, 0);
  f.state.wrongCommit = false; const value = await f.read({ head: head.toUpperCase(), commit: selected.toUpperCase() }); assert.equal(value.requestHeadSha, head); assert.equal(value.scopeCommit, selected);
});
