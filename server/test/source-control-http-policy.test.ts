import test from 'node:test';
import assert from 'node:assert/strict';
import { SourceControlConnections, SourceControlHTTPError } from '../src/source-control-connections.js';
import { SourceControlRequestPolicy, SourceControlRateLimitPausedError, withSourceControlInteraction } from '../src/source-control-request-policy.js';

test('Real GitHub REST and GraphQL adapters share quota and pause state under the pinned credential', async t => {
  const policy = new SourceControlRequestPolicy(() => 1000), environment = { GH_TOKEN: 'synthetic-a' }; let calls = 0, refused = false;
  const connections = new SourceControlConnections(undefined, { environment, command: () => null, policy, request: async (input, options) => {
    calls++; const gql = String(input).endsWith('/graphql');
    assert(['Bearer synthetic-a', 'Bearer synthetic-b'].includes(new Headers(options?.headers).get('Authorization')!));
    return Response.json(gql ? refused ? { errors: [{ type: 'RATE_LIMITED', message: 'Private refusal' }] } : { data: { viewer: { login: 'viewer' } } } : { title: 'Read' }, { headers: { 'x-ratelimit-resource': gql ? 'graphql' : 'core', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': gql ? '20' : '9', 'x-ratelimit-reset': '1000', ...(gql && refused ? { 'retry-after': '30' } : {}) } });
  } }); t.after(() => connections.close());
  const p = await connections.pin('/tmp', 'github'); await p.json('repos/owner/repo');
  await assert.rejects(p.json('repos/owner/repo'), SourceControlRateLimitPausedError); assert.equal(calls, 1);
  await withSourceControlInteraction(true, () => p.json('repos/owner/repo')); assert.equal(calls, 2);
  refused = true; await assert.rejects(p.graphql!('query { viewer { login } }', {}), (error: unknown) => error instanceof SourceControlHTTPError && error.rateLimited === true && error.retryAt === 31000);
  await assert.rejects(p.graphql!('query { viewer { login } }', {}), SourceControlRateLimitPausedError); assert.equal(calls, 3);
  environment.GH_TOKEN = 'synthetic-b'; const next = await connections.pin('/tmp', 'github'); refused = false; await next.graphql!('query { viewer { login } }', {}); assert.equal(calls, 4);
});
test('Conditional REST carries its validator, accepts 304 and never treats a header as an extra request', async t => {
  const calls: string[] = [], connections = new SourceControlConnections(undefined, { environment: { GH_TOKEN: 'synthetic' }, command: () => null, request: async (_input, options) => {
    const etag = new Headers(options?.headers).get('If-None-Match'); calls.push(etag ?? ''); return etag ? new Response(null, { status: 304 }) : Response.json({ head: 'one' }, { headers: { etag: '"one"' } });
  } }); t.after(() => connections.close()); const p = await connections.pin('/tmp', 'github');
  const first = await p.conditional!('repos/owner/repo/pulls/1'); assert.equal(first.headers.get('etag'), '"one"');
  assert.equal((await p.conditional!('repos/owner/repo/pulls/1', { ifNoneMatch: '"one"' })).status, 304);
  await assert.rejects(p.conditional!('repos/owner/repo/pulls/1', { ifNoneMatch: '"bad"\r\nAuthorization: other' }), /条件请求/); assert.deepEqual(calls, ['', '"one"']);
});


test('A rate-limited login probe retains configured credentials instead of reporting an authentication failure', async t => {
  const connections = new SourceControlConnections(undefined, { environment: { GH_TOKEN: 'synthetic-quota-probe' }, command: () => null, request: async () => new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }) });
  t.after(() => connections.close()); const result = await connections.probe('/fixture', 'github');
  assert.equal(result.status, 'configured'); assert(result.credentialFingerprint); assert.equal(result.credentialSource, 'environment');
});
