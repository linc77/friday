import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskChangeRequestSync } from '../src/task-change-request-sync.js';
import { changeRequestSyncKey, decodeCachedStack, decodeChangeRequestSummary, summaryFromRaw, supersedesSummary, type ChangeRequestSummary } from '../src/task-change-request-summary.js';
import type { Engine } from '../src/engine.js';
import type { TaskPullRequest, WorkItem, Workspace } from '../src/types.js';
import type { ChangeRequestStack } from '../src/task-change-request-stack-types.js';
import { SourceControlHTTPError } from '../src/source-control-http-errors.js';

const date = '2026-10-20T02:00:00Z', sha = 'a'.repeat(40);
const pr = (number = 17): TaskPullRequest => ({ number, url: `https://github.com/owner/repo/pull/${number}`, provider: 'github', host: 'github.com', repository: 'owner/repo', title: `Change ${number}`, state: 'open', base: 'main', head: `feature/${number}` });
const task = (id: string, links = [pr()]): WorkItem => ({ id, projectId: 'p', cwd: '/fixture', title: 'Task', prompt: 'Task', agent: 'codex', mode: 'code', status: 'completed', createdAt: date, updatedAt: date, durableId: null, threadId: null, turnId: null, result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: id, changeRequests: links });
function fixture(t: { after(callback: () => Promise<unknown>): void }, tasks = [task('a'), task('b')]) {
  let now = Date.parse(date), beforeRead: ((signal?: AbortSignal) => Promise<void>) | undefined;
  const state = { revision: 0, tasks, projects: [{ id: 'p', name: 'Project', path: '/fixture', context: '' }] } as Workspace;
  const value = { state, calls: [] as { id: string; url: string; refresh: boolean }[], invalidations: 0, settlements: 0, stackReads: 0, stackFailure: false, limited: false,
    stack: null as ChangeRequestStack | null, summary: summaryFromRaw(pr(), { updated_at: date, user: { login: 'author' }, head: { sha } }), commits: [] as Workspace[] };
  let sync: TaskChangeRequestSync;
  const engine = {
    snapshot: async () => structuredClone(state),
    root: { commit: async (write: (tx: unknown) => Promise<void>) => { const revision = state.revision; await write({ doc: async () => state }); if (revision !== state.revision) { value.commits.push(structuredClone(state)); sync.notify(); } } },
    changeRequests: {
      summary: async (id: string, url: string, signal?: AbortSignal, refresh = false) => { value.calls.push({ id, url, refresh }); await beforeRead?.(signal); if (value.limited) throw new SourceControlHTTPError(429, 'Fixture quota', { rateLimited: true, retryAt: now + 60_000 }); const link = tasks.flatMap(t => t.changeRequests ?? []).find(p => p.url === url)!; const summary = structuredClone(value.summary); summary.pullRequest = { ...link, snapshot: undefined, state: summary.snapshot.state, title: summary.snapshot.title }; return summary; },
      stack: async () => { value.stackReads++; if (value.stackFailure) throw new SourceControlHTTPError(503, 'Fixture stack unavailable'); return structuredClone(value.stack); },
      invalidatePresentation: async () => { value.invalidations++; },
    },
    taskSettlement: { notify: () => { value.settlements++; } },
  } as unknown as Engine;
  sync = new TaskChangeRequestSync(engine, 60_000, () => now); t.after(() => sync.close());
  return { ...value, get state() { return state; }, get calls() { return value.calls; }, get stackReads() { return value.stackReads; }, get invalidations() { return value.invalidations; }, commits: value.commits, value, sync,
    advance: (ms: number) => { now += ms; }, before: (read?: typeof beforeRead) => { beforeRead = read; }, start: async () => { sync.start(); await sync.drain(); }, poll: async () => { sync.poll(); await sync.drain(); } };
}

test('Summary decoding projects only allowed metadata, canonicalizes Azure identities and never regresses merged or newer readings', () => {
  const summary = summaryFromRaw(pr(), { updated_at: date, user: { login: 'author', avatar_url: 'https://avatars.example/u' }, body: 'PRIVATE', token: 'SECRET', head: { sha }, additions: 2 });
  const decoded = decodeChangeRequestSummary({ ...summary, token: 'SECRET', snapshot: { ...summary.snapshot, body: 'PRIVATE' }, pullRequest: { ...summary.pullRequest, description: 'PRIVATE' } });
  assert(decoded); assert(!JSON.stringify(decoded).includes('PRIVATE')); assert(!JSON.stringify(decoded).includes('SECRET')); assert.equal(decoded.snapshot.headSha, sha);
  assert.equal(decodeChangeRequestSummary({ ...summary, snapshot: { ...summary.snapshot, updatedAt: 'invalid' } }), undefined);
  assert.equal(decodeCachedStack({ id: '7', number: 7, url: 'https://github.com/owner/repo/stacks/7', base: 'main', layers: [{ number: 17, state: 'open', headBranch: 'branch', headSha: 'invalid' }] }), undefined);
  const merged = structuredClone(summary); merged.snapshot.state = 'merged';
  assert.equal(supersedesSummary(merged, summary), false);
  assert.equal(supersedesSummary(summary, { ...summary, snapshot: { ...summary.snapshot, updatedAt: '2026-10-19T00:00:00Z' }, observedAt: summary.observedAt + 1 }), false);
  const modern = { ...pr(), provider: 'azure-devops' as const, host: 'dev.azure.com', repository: 'Org/Project/_git/Repo', url: 'https://dev.azure.com/Org/Project/_git/Repo/pullrequest/17' };
  const legacy = { ...modern, host: 'org.visualstudio.com', repository: 'DefaultCollection/Project/_git/Repo', url: 'https://org.visualstudio.com/DefaultCollection/Project/_git/Repo/pullrequest/17' };
  assert.equal(changeRequestSyncKey(modern), changeRequestSyncKey(legacy));
});

test('Resident sweeps group shared links, refresh open PRs and write no timestamp-only changes', async t => {
  const f = fixture(t); await f.start(); assert.equal(f.calls.length, 1); assert.equal(f.stackReads, 1); assert.equal(f.state.revision, 1); assert(f.state.tasks.every(t => t.changeRequests?.[0].snapshot?.headSha === sha));
  const first = f.state.tasks[0].changeRequests![0].snapshot!.syncedAt;
  f.advance(60_000); await f.poll(); assert.equal(f.calls.length, 2); assert.equal(f.stackReads, 1); assert.equal(f.state.revision, 1); assert.equal(f.state.tasks[0].changeRequests![0].snapshot!.syncedAt, first);
  f.value.summary.snapshot.title = 'Changed title'; f.value.summary.snapshot.updatedAt = '2026-10-20T02:01:00Z'; await f.poll(); assert.equal(f.state.revision, 2); assert.equal(f.invalidations, 2);
});

test('Merged links stop once their merge time is known; missing merge time uses slow strict refresh, and explicit generations force terminal re-reads', async t => {
  const f = fixture(t); f.value.summary.snapshot.state = 'merged'; await f.start(); assert.equal(f.calls.length, 1);
  f.advance(60_000); await f.poll(); assert.equal(f.calls.length, 1);
  f.advance(14 * 60_000); await f.poll(); assert.equal(f.calls.length, 2); assert(f.calls[1].refresh);
  f.value.summary.snapshot.mergedAt = date; f.sync.request('a', pr().url); await f.sync.drain(); assert.equal(f.calls.length, 3);
  f.advance(24 * 60 * 60_000); await f.poll(); assert.equal(f.calls.length, 3);
  f.sync.request('a', pr().url); await f.sync.drain(); assert.equal(f.calls.length, 4);
});

test('A refresh requested during the host read survives the captured generation and runs in the next coalesced sweep', async t => {
  const f = fixture(t); let release!: () => void, began!: () => void;
  const started = new Promise<void>(r => { began = r; }); const hold = new Promise<void>(r => { release = r; });
  f.before(async () => { began(); await hold; }); f.sync.start(); const drained = f.sync.drain(); await started;
  f.sync.request('a', pr().url); f.before(); release(); await drained;
  assert.equal(f.calls.length, 2); assert(f.calls[1].refresh);
});

test('Stack siblings are linked before a terminal snapshot; dismissed siblings stay dismissed and settled tasks gain no links', async t => {
  const dismissed = { ...pr(16), dismissedAt: date }, active = task('a', [pr(), dismissed]), settled = task('b'); settled.settledAt = date;
  const f = fixture(t, [active, settled]); f.value.summary.snapshot.state = 'merged'; f.value.summary.snapshot.mergedAt = date;
  f.value.stack = { id: '7', number: 7, url: 'https://github.com/owner/repo/stacks/7', base: 'main', layers: [16, 17, 18].map(number => ({ number, state: number === 17 ? 'merged' : 'open', title: 'Layer ' + number, headBranch: 'feature/' + number, headSha: sha })) };
  await f.start();
  const commit = f.commits[0]; assert.equal(commit.tasks[0].changeRequests?.length, 3); assert(commit.tasks[0].changeRequests?.some(p => p.number === 18)); assert(commit.tasks[0].changeRequests?.find(p => p.number === 16)?.dismissedAt); assert.equal(commit.tasks[1].changeRequests?.length, 1);
  const saved = commit.tasks[0].changeRequestStacks![pr().url]!; assert(!JSON.stringify(saved).includes(sha));
});

test('Failed stack refresh keeps the previous snapshot and stack, then retries; host quota pauses pending refreshes', async t => {
  const f = fixture(t); await f.start(); const revision = f.state.revision;
  f.value.summary.snapshot.title = 'New title'; f.value.summary.snapshot.updatedAt = '2026-10-20T03:00:00Z'; f.value.stackFailure = true; await f.poll(); assert.equal(f.state.revision, revision);
  f.value.stackFailure = false; await f.poll(); assert.equal(f.state.revision, revision + 1);
  f.value.limited = true; f.sync.request('a', pr().url); await f.sync.drain(); const count = f.calls.length;
  f.sync.request('a', pr().url); await f.sync.drain(); assert.equal(f.calls.length, count);
  f.value.limited = false; f.advance(60_000); await f.poll(); assert.equal(f.calls.length, count + 1);
});

test('A service shutdown aborts and drains its outstanding host read without persisting a late snapshot', async t => {
  const f = fixture(t); let began!: () => void; const started = new Promise<void>(r => { began = r; });
  f.before(signal => { began(); return new Promise((_r, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }); });
  f.sync.start(); const drained = f.sync.drain(); await started; await f.sync.close(); await drained; assert.equal(f.state.revision, 0);
});

test('Only runs that execute gh pr or glab mr merge or close force a state read on completion', async t => {
  const f = fixture(t); await f.start(); const calls = f.calls.length;
  f.sync.command('a', 'run1', 'git status'); await f.sync.completed('a', 'run1'); await f.sync.drain(); assert.equal(f.calls.length, calls);
  f.sync.command('a', 'run2', 'gh pr merge 17 --squash'); await f.sync.completed('a', 'other'); await f.sync.drain(); assert.equal(f.calls.length, calls);
  await f.sync.completed('a', 'run2'); await f.sync.drain(); assert.equal(f.calls.length, calls + 1);
});
