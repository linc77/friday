import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubSummaryBatcher } from '../src/github-summary-batches.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import type { PinnedSourceControlConnection } from '../src/source-control-connections.js';
import { SourceControlHTTPError } from '../src/source-control-http-errors.js';
const repo = sourceControlRepository('https://github.com/owner/repo')!;
const value = (number: number) => ({ number, title: 'Change ' + number, url: `https://github.com/owner/repo/pull/${number}`, state: 'OPEN', isDraft: false, headRefName: 'feature/' + number, baseRefName: 'main', headRefOid: 'a'.repeat(40), updatedAt: '2026-10-20T00:00:00Z', mergedAt: null, closedAt: null, author: { login: 'author' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, stack: null });
function pinned(read: NonNullable<PinnedSourceControlConnection['graphqlRaw']>): PinnedSourceControlConnection { return { provider: 'github', host: 'github.com', fingerprint: 'credential-a', source: 'settings', json: async () => ({}), array: async () => [], graphqlRaw: read }; }
test('Twenty-five summary aliases share one read, preserve each PR identity and isolate missing aliases', async t => {
 const batch = new GitHubSummaryBatcher(); t.after(() => batch.close()); const calls: number[] = [];
 const p = pinned(async (query, variables) => { const numbers = Object.keys(variables).filter(k => k.startsWith('number')); calls.push(numbers.length); assert(query.includes('FridaySummaryBatch')); const data = Object.fromEntries(numbers.map(k => ['r' + k.slice(6), { pullRequest: variables[k] === 4 ? null : value(Number(variables[k])) }])); return { data, errors: numbers.some(k => variables[k] === 4) ? [{ path: ['r3', 'pullRequest'], message: 'Private diagnostic must not leak' }] : undefined }; });
 const results = await Promise.allSettled(Array.from({ length: 27 }, (_, i) => batch.get(p, repo, i + 1)));
 assert.deepEqual(calls, [25, 2]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 26); const fourth = results[3]; assert.equal(fourth.status, 'rejected'); if (fourth.status === 'rejected') assert(!fourth.reason.message.includes('Private diagnostic'));
 const first = results[0]; assert.equal(first.status, 'fulfilled'); if (first.status === 'fulfilled') { assert.equal(first.value.pullRequest.number, 1); assert.equal(first.value.snapshot.checksState, 'passing'); }
});
test('Credential namespaces batch separately and a rate-limited read is never retried', async t => {
 const batch = new GitHubSummaryBatcher(); t.after(() => batch.close()); let reads = 0;
 const p = pinned(async () => { reads++; throw new SourceControlHTTPError(429, 'Fixture quota', { retryAt: 1000, rateLimited: true }); }); const other = { ...p, fingerprint: 'credential-b' };
 const results = await Promise.allSettled([batch.get(p, repo, 1), batch.get(other, repo, 2)]); assert.equal(reads, 2); assert(results.every(r => r.status === 'rejected' && r.reason.status === 429));
});
test('Cancelling one alias does not cancel its siblings; closing the owner drains active and queued work', async t => {
 const batch = new GitHubSummaryBatcher(); t.after(() => batch.close()); let began!: () => void, release!: () => void, aborted = false;
 const started = new Promise<void>(r => { began = r; }); const wait = new Promise<void>(r => { release = r; });
 const p = pinned(async (_query, variables, signal) => { began(); signal?.addEventListener('abort', () => { aborted = true; release(); }); await wait; signal?.throwIfAborted(); return { data: Object.fromEntries(Object.keys(variables).filter(k => k.startsWith('number')).map(k => ['r' + k.slice(6), { pullRequest: value(Number(variables[k])) }])) }; });
 const c = new AbortController(), a = batch.get(p, repo, 1, c.signal), rejected = assert.rejects(a), b = batch.get(p, repo, 2);
 await started; c.abort(); await rejected; assert.equal(aborted, false); release(); assert.equal((await b).pullRequest.number, 2);
 const queued = batch.get(p, repo, 3); const stopped = assert.rejects(queued); await batch.close(); await stopped;
 await assert.rejects(batch.get(p, repo, 4), /关闭/);
});
