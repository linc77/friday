import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceControlRequestPolicy, SourceControlRateLimitPausedError, githubRateLimited, sourceControlRetryAt, withSourceControlInteraction } from '../src/source-control-request-policy.js';
import { SourceControlHTTPError } from '../src/source-control-http-errors.js';

const key = { provider: 'github' as const, host: 'GitHub.Com', scope: 'credential-a' };
const quota = (remaining: number, reset = 1000) => new Headers({ 'x-ratelimit-resource': 'core', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': String(remaining), 'x-ratelimit-reset': String(reset) });
test('Retry headers and GraphQL/REST quota refusals follow the actual provider response', () => {
  assert.equal(sourceControlRetryAt(' 12 ', 1000), 13000); assert.equal(sourceControlRetryAt('0', 1000), 1000);
  assert.equal(sourceControlRetryAt('Thu, 01 Jan 1970 00:00:30 GMT', 1000), 30000);
  assert.equal(sourceControlRetryAt('9999999999999999999999999', 1000), undefined); assert.equal(sourceControlRetryAt('invalid', 1000), undefined);
  assert(githubRateLimited(200, new Headers(), '', [{ type: 'RATE_LIMITED' }]));
  assert(githubRateLimited(200, new Headers(), '', [{ message: 'API rate limit already exceeded' }]));
  assert(githubRateLimited(403, new Headers({ 'retry-after': '10' })));
  assert(!githubRateLimited(403, new Headers(), 'Forbidden')); assert(!githubRateLimited(200, quota(0)));
});
test('Pauses isolate credentials, normalize hosts, and stale answers cannot clear or multiply a newer cooldown', async t => {
  let now = 1000; const policy = new SourceControlRequestPolicy(() => now); t.after(() => policy.close());
  const lease = policy.check(key); policy.recordRateLimit(key, lease); policy.recordRateLimit(key, lease);
  assert.throws(() => policy.check({ ...key, host: 'github.com' }), (error: unknown) => error instanceof SourceControlRateLimitPausedError && error.retryAt === 31000);
  assert.equal(policy.check({ ...key, scope: 'credential-b' }), 0); assert.equal(policy.check({ ...key, host: 'enterprise.test' }), 0);
  assert.equal(policy.check({ ...key, provider: 'gitlab' }), 0);
  policy.recordSuccess(key, lease); assert.throws(() => policy.check(key));
  now = 31000; const second = policy.check(key); policy.recordRateLimit(key, second);
  assert.throws(() => policy.check(key), (error: unknown) => error instanceof SourceControlRateLimitPausedError && error.retryAt === 91000);
  policy.recordSuccess(key, second); now = 91000; policy.recordSuccess(key, policy.check(key)); policy.recordRateLimit(key, policy.check(key));
  assert.throws(() => policy.check(key), (error: unknown) => error instanceof SourceControlRateLimitPausedError && error.retryAt === 121000);
});
test('Late explicit retry times extend a pause without letting expired responses resurrect it', async t => {
  let now = 0; const policy = new SourceControlRequestPolicy(() => now); t.after(() => policy.close());
  policy.recordRateLimit(key, 0, 1000); policy.recordRateLimit(key, 0, 2000);
  assert.throws(() => policy.check(key), (error: unknown) => error instanceof SourceControlRateLimitPausedError && error.retryAt === 2000);
  now = 3000; policy.recordSuccess(key, policy.check(key)); policy.recordRateLimit(key, 0);
  assert.doesNotThrow(() => policy.check(key));
});
test('GitHub keeps ten percent for interactions, accepts higher remaining quota in the same window, and never debits locally', async t => {
  let now = 0; const policy = new SourceControlRequestPolicy(() => now); t.after(() => policy.close());
  policy.observeGithub(key.host, key.scope, quota(9));
  assert.throws(() => policy.admitGithub(key.host, key.scope, 'core'));
  policy.admitGithub(key.host, key.scope, 'core', true); policy.admitGithub(key.host, 'credential-b', 'core'); policy.admitGithub(key.host, key.scope, 'graphql');
  policy.observeGithub(key.host, key.scope, quota(20));
  for (let i = 0; i < 25; i++) await policy.request(key, {}, async () => 'read');
  policy.observeGithub(key.host, key.scope, quota(0, 999)); policy.admitGithub(key.host, key.scope, 'core');
  policy.observeGithub(key.host, key.scope, quota(0)); assert.throws(() => policy.admitGithub(key.host, key.scope, 'core', true));
  now = 1000000; policy.admitGithub(key.host, key.scope, 'core');
});
test('A rate refusal holds background REST and GraphQL, while an interaction can spend the reserve without clearing the pause', async t => {
  const policy = new SourceControlRequestPolicy(() => 1000); t.after(() => policy.close()); let calls = 0;
  await assert.rejects(policy.request(key, {}, async () => { calls++; throw new SourceControlHTTPError(429, 'Limited', { retryAt: 30000 }); }));
  await assert.rejects(policy.request(key, { resource: 'graphql' }, async () => { calls++; }), SourceControlRateLimitPausedError);
  await withSourceControlInteraction(true, () => policy.request(key, {}, async () => { calls++; }));
  await assert.rejects(policy.request(key, {}, async () => { calls++; }), SourceControlRateLimitPausedError); assert.equal(calls, 2);
});
test('The shared GitHub pool covers REST and GraphQL bodies; close aborts active requests and drains queued ones', async () => {
  const policy = new SourceControlRequestPolicy(Date.now, 2); let active = 0, maximum = 0, calls = 0;
  const pending = Array.from({ length: 8 }, (_, index) => policy.request({ ...key, scope: String(index) }, { resource: index % 2 ? 'graphql' : 'core' }, signal => new Promise((_resolve, reject) => {
    calls++; active++; maximum = Math.max(maximum, active);
    signal.addEventListener('abort', () => { active--; reject(signal.reason); }, { once: true });
  })));
  const settled = Promise.allSettled(pending); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); await policy.close(); assert.equal(maximum, 2); assert.equal(active, 0); assert((await settled).every(value => value.status === 'rejected')); assert.equal(calls, 2);
});
test('Queued cancellation removes only its own waiter and ambiguous writes are attempted once', async t => {
  const policy = new SourceControlRequestPolicy(Date.now, 1); t.after(() => policy.close()); let finish!: () => void, calls = 0;
  const first = policy.request(key, {}, async () => new Promise<void>(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve)); const controller = new AbortController();
  const second = policy.request(key, { signal: controller.signal }, async () => { calls++; }); const rejected = assert.rejects(second);
  const third = policy.request(key, {}, async () => { calls++; }); controller.abort(); await rejected; finish(); await Promise.all([first, third]); assert.equal(calls, 1);
  await assert.rejects(policy.request(key, { interactive: true }, async () => { calls++; throw new Error('Uncertain write'); })); assert.equal(calls, 2);
});
