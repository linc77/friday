import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubChecksRevalidator, knownGitHubWorkflowRuns } from '../src/github-conditional-checks.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import type { PinnedSourceControlConnection } from '../src/source-control-connections.js';
import { SourceControlHTTPError } from '../src/source-control-http-errors.js';

const sha = 'a'.repeat(40), other = 'b'.repeat(40), repository = sourceControlRepository('https://github.com/owner/repo')!;
function fixture() {
  const state = { now: 0, sha, fork: false, calls: [] as { path: string; etag?: string }[], reads: 0, pages: false, changed: 0, failure: 0, readSha: undefined as string | undefined, fingerprint: 'credential-a' };
  const revalidator = new GitHubChecksRevalidator(() => state.now);
  const p: PinnedSourceControlConnection = { provider: 'github', host: 'github.com', fingerprint: state.fingerprint, source: 'settings', json: async () => ({}), array: async () => [],
    conditional: async (path, options) => {
      state.calls.push({ path, etag: options?.ifNoneMatch });
      if (state.failure) throw new SourceControlHTTPError(state.failure, 'Synthetic response');
      const root = path.endsWith('/pulls/17'), runs = path.includes('/actions/runs'), etag = JSON.stringify(path + ':' + state.sha + ':' + (root ? 0 : state.changed));
      if (options?.ifNoneMatch === etag) return { status: 304, headers: new Headers(), body: '' };
      const more = state.pages && path.includes('check-runs') && new URL(path, 'https://fixture/').searchParams.get('page') === '1';
      return { status: 200, headers: new Headers({ etag, ...(more ? { link: '<https://foreign.invalid/ignored>; rel="next"' } : {}) }), body: JSON.stringify(root ? { head: { sha: state.sha, repo: { id: state.fork ? 2 : 1 } }, base: { repo: { id: 1 } } } : runs ? { workflow_runs: [{ id: 5, head_branch: 'feature', status: 'action_required' }] } : {}) };
    } };
  const read = async () => { state.reads++; return { state: 'open' as const, headSha: state.readSha ?? state.sha, checks: [{ name: 'build', state: 'success' }], workflowApprovalsRequired: knownGitHubWorkflowRuns()?.runs.length ?? 0 }; };
  return { state, p, revalidator, read, get: () => revalidator.get(p, repository, 17, read) };
}
test('Unchanged head/check/status pages reuse the full result, and five minutes forces a full refresh', async t => {
  const f = fixture(); t.after(() => f.revalidator.close());
  const first = await f.get(); first.checks[0].name = 'caller mutation';
  assert.equal((await f.get()).checks[0].name, 'build'); assert.equal(f.state.reads, 1); assert(f.state.calls.slice(3).every(call => call.etag));
  f.state.now = 5 * 60_000; await f.get(); assert.equal(f.state.reads, 2);
});
test('A 304 retains its own next-page flag and never follows the server-supplied next URL', async t => {
  const f = fixture(); f.state.pages = true; t.after(() => f.revalidator.close()); await f.get();
  f.state.calls = []; await f.get(); assert.equal(f.state.reads, 1);
  assert(f.state.calls.some(call => call.path.includes('check-runs') && call.path.includes('page=2'))); assert(f.state.calls.every(call => call.path.startsWith('repos/owner/repo/')));
});
test('New head SHAs clear the old validators, and credential changes get independent validators', async t => {
  const f = fixture(); t.after(() => f.revalidator.close()); await f.get(); f.state.sha = other; f.state.calls = []; await f.get();
  assert.equal(f.state.reads, 2); assert(f.state.calls.filter(call => !call.path.endsWith('/pulls/17')).every(call => !call.etag && call.path.includes(other)));
  f.p.fingerprint = 'credential-b'; f.state.calls = []; await f.get(); assert.equal(f.state.reads, 3); assert(f.state.calls.every(call => !call.etag));
});
test('Fork workflow pages feed the full reader once, while a changed page invalidates the held checks', async t => {
  const f = fixture(); f.state.fork = true; t.after(() => f.revalidator.close());
  assert.equal((await f.get()).workflowApprovalsRequired, 1); await f.get(); assert.equal(f.state.reads, 1);
  assert(f.state.calls.some(call => call.path.includes('/actions/runs?head_sha=' + sha + '&event=pull_request')));
  f.state.changed++; await f.get(); assert.equal(f.state.reads, 2);
});
test('Unsupported conditional endpoints fall back; authentication and quota errors propagate without serving stale checks', async t => {
  const f = fixture(); t.after(() => f.revalidator.close()); f.state.failure = 405;
  await f.get(); await f.get(); assert.equal(f.state.calls.length, 1); assert.equal(f.state.reads, 2);
  for (const failure of [401, 403, 429]) {
    const q = fixture(); q.state.failure = failure;
    await assert.rejects(q.get(), (error: unknown) => error instanceof SourceControlHTTPError && error.status === failure); assert.equal(q.state.reads, 0); await q.revalidator.close();
  }
});
test('A full read for another head cannot become an unchanged conditional cache hit', async t => {
  const f = fixture(); t.after(() => f.revalidator.close()); f.state.readSha = other; await f.get(); await f.get(); assert.equal(f.state.reads, 2);
});
test('A cancelled waiter neither releases the current reader nor prevents the next reader', async t => {
  const f = fixture(); t.after(() => f.revalidator.close()); let release!: () => void;
  const first = f.revalidator.get(f.p, repository, 17, async () => { await new Promise<void>(resolve => { release = resolve; }); return f.read(); });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController(), second = f.revalidator.get(f.p, repository, 17, f.read, controller.signal); const rejected = assert.rejects(second); controller.abort(); await rejected;
  const third = f.get(); release(); await first; await third; assert.equal(f.state.reads, 1);
});
