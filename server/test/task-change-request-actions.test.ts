import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { ServiceMaintenance } from '../src/maintenance.js';
import { changeRequestDetail, changeRequestEffects, commentBody, reviewComment } from '../src/task-change-request-data.js';
import { sourceControlRepository } from '../src/task-change-requests.js';
import type { SourceControlConnectionOptions } from '../src/source-control-connections.js';
import type { Executor, Workspace } from '../src/types.js';
import type { ChangeRequestOperation } from '../src/task-change-request-actions.js';
import { collaborationInput } from '../src/task-change-request-collaboration.js';
import { saveSourceControlPreferences } from '../src/source-control-preferences.js';

const sha = 'a'.repeat(40), base = 'b'.repeat(40), body = '  Literal `code`, $(not_a_command), 中文\n\n    preserved indent\n';
type Provider = 'github' | 'gitlab' | 'bitbucket';
const executor: Executor = { async run() { return 'Fixture completed'; }, async answer() {}, async steer() {} };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const output = (value: unknown) => ({ stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', code: 0, digest: '' });
async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw new Error('Change request fixture timed out');
}
async function setup(t: { after(fn: () => Promise<unknown>): void }, provider: Provider = 'github', customHost?: string, sync = false) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-review-')), data = join(directory, 'data'), cwd = join(directory, 'repo'); await mkdir(cwd);
  const repository = sourceControlRepository(provider === 'github' ? 'https://github.com/fixture/project' : provider === 'gitlab' ? `https://${customHost ?? 'gitlab.com'}/group/sub/project` : 'https://bitbucket.org/fixture/project', [], customHost ? [customHost] : [])!;
  const url = `https://${repository.host}/${repository.path}/${provider === 'github' ? 'pull' : provider === 'gitlab' ? '-/merge_requests' : 'pull-requests'}/17`;
  const raw: Record<string, any> = provider === 'github' ? { number: 17, title: 'Fixture change', html_url: url, state: 'open', user: { login: 'author' }, head: { ref: 'linc/feature', sha, repo: { full_name: repository.path } }, base: { ref: 'main', sha: base }, body, additions: 1, deletions: 1 }
    : provider === 'gitlab' ? { iid: 17, title: 'Fixture change', web_url: url, state: 'opened', author: { username: 'author', id: 7 }, source_branch: 'linc/feature', target_branch: 'main', sha, diff_refs: { head_sha: sha, base_sha: base, start_sha: base }, description: body, user: { can_merge: true } }
    : { id: 17, title: 'Fixture change', links: { html: { href: url } }, state: 'OPEN', author: { display_name: 'author' }, source: { branch: { name: 'linc/feature' }, commit: { hash: sha } }, destination: { branch: { name: 'main' }, commit: { hash: base } }, description: body };
  const state = { writes: [] as { path: string; method: string; body?: any }[], reads: [] as string[], hold: false, failPath: '', readHoldPath: '', readHeld: false, readFailureStatus: 0, summaryReads: 0, viewerAuthor: false, canWrite: true, queue: false, getHead: sha, knownPermission: '', cliArgs: [] as string[][],
    threads: [] as any[], discussions: [] as any[], remoteComments: undefined as any[] | undefined, members: [] as any[], subjects: {} as Record<string, any>, nextComments: [] as any[], labelNodes: [] as any[],
    reactionGroups: [] as any[], subjectReactions: {} as Record<string, any[]>, awards: [] as any[], noteAwards: {} as Record<string, any[]>, viewedFiles: {} as Record<string, string>, blobs: {} as Record<string, string>, revisionsUnavailable: false, viewer: 'reviewer', patch: '', updatePermission: undefined as boolean | undefined, behindBy: undefined as number | undefined,
    mergeStatus: 'BLOCKED', autoMerge: undefined as null | { mergeMethod: string } | undefined, sourcePermission: undefined as string | undefined, sourceExists: true, sourceHead: sha, defaultBranch: 'main',
    mergeBody: '', mergeMessageHead: sha, mergeMessageFailure: false, mergeMessageQueries: [] as any[], allowRebase: false,
    fileContents: {} as Record<string, string>, diffFiles: undefined as any[] | undefined, rawDiff: undefined as string | undefined, commits: [] as any[], commitFiles: [] as any[], commitFailure: false, commitsTruncated: false, commitResponseSha: '', dismissals: [] as any[], dismissalFailureAfter: false, reviews: [] as any[], fork: false, forkOwner: 'contributor', workflowHeads: undefined as any[] | undefined, workflowHeadsMore: false, workflowRuns: [] as any[], afterWrite: undefined as (() => void) | undefined };
  const handle = async (path: string, method: string, payload?: any, signal?: AbortSignal | null): Promise<unknown> => {
    if (provider === 'github' && path === 'graphql' && process.env.FRIDAY_TEST_GITHUB_QUERIES) appendFileSync(process.env.FRIDAY_TEST_GITHUB_QUERIES, JSON.stringify(payload.query) + '\n', { mode: 0o600 });
    if (path === 'graphql' && String(payload.query).startsWith('query')) {
      if (payload.query.includes('FridaySummaryBatch')) {
        state.summaryReads++;
        const data: Record<string, unknown> = {};
        for (const field of Object.keys(payload.variables).filter(v => v.startsWith('number'))) {
          const index = field.slice(6); data['r' + index] = { pullRequest: { number: raw.number, title: raw.title, url, state: raw.merged ? 'MERGED' : raw.state.toUpperCase(), isDraft: raw.draft === true,
            updatedAt: raw.updated_at ?? null, mergedAt: raw.merged_at ?? null, closedAt: raw.closed_at ?? null, headRefName: raw.head.ref, baseRefName: raw.base.ref, headRefOid: raw.head.sha, author: raw.user,
            additions: raw.additions, deletions: raw.deletions, changedFiles: raw.changed_files, reviewDecision: null, mergeable: 'UNKNOWN', commits: { nodes: [] }, stack: null } };
        }
        return { data };
      }

      if (payload.query.includes('FridayMergeMessage')) { state.mergeMessageQueries.push(payload.variables); if (state.mergeMessageFailure) throw Error('Synthetic merge message failure'); return { data: { repository: { pullRequest: { viewerMergeBodyText: state.mergeBody, headRefOid: state.mergeMessageHead, isMergeQueueEnabled: state.queue } } } }; }
      if (payload.query.includes('FridayTimelineCommits')) {
        if (state.commitFailure) throw new Error('Synthetic commit read failure');
        const start = Number(payload.variables.after ?? 0), end = start + 100; if (state.dismissalFailureAfter && start >= 100) throw new Error('Synthetic dismissal page failure');
        return { data: { repository: { pullRequest: { commits: { nodes: state.commits.slice(-100).map(commit => ({ commit })), pageInfo: { hasPreviousPage: state.commitsTruncated } }, reviewDismissals: { nodes: state.dismissals.slice(start, end), pageInfo: { hasNextPage: end < state.dismissals.length, endCursor: String(end) } } } } } };
      }
      if (payload.query.includes('FridayWorkflowHeads')) return { data: { repository: { pullRequests: { nodes: state.workflowHeads ?? [{ number: 17, headRefOid: state.getHead, isCrossRepository: state.fork, headRepositoryOwner: { login: state.forkOwner } }], pageInfo: { hasNextPage: state.workflowHeadsMore, endCursor: 'repeated' } } } } };
      if (payload.query.includes('FridayBranchToDelete')) return { data: { repository: { pullRequest: { state: raw.merged ? 'MERGED' : raw.state.toUpperCase(), headRefName: raw.head.ref, baseRefName: raw.base.ref, headRefOid: state.getHead, headRepository: { id: 'source-repository', viewerPermission: state.sourcePermission ?? (state.canWrite ? 'WRITE' : 'READ') } } } } };
      if (payload.query.includes('FridaySourceBranch')) return { data: { node: { __typename: 'Repository', defaultBranchRef: state.defaultBranch ? { name: state.defaultBranch } : null, ref: state.sourceExists ? { target: { oid: state.sourceHead } } : null } } };
      if (payload.query.includes('FridayReviewBlobs')) return { data: { project: state.revisionsUnavailable ? null : { repository: { blobs: { nodes: payload.variables.paths.filter((path: string) => state.blobs[path] !== undefined).map((path: string) => ({ path, oid: state.blobs[path] })) } } } } };
      if (payload.query.includes('FridayAwards')) return { data: { currentUser: { username: state.viewer }, project: { mergeRequest: { awardEmoji: { nodes: state.awards }, notes: { nodes: Object.entries(state.noteAwards).map(([id, awards]) => ({ id: 'gid://gitlab/Note/' + id, awardEmoji: { nodes: awards } })), pageInfo: { hasNextPage: false } } } } } };
      if (payload.query.includes('FridayFilesViewed')) {
        const at = Number(payload.variables.after ?? 0), entries = Object.entries(state.viewedFiles), next = at + 100;
        return { data: { repository: { pullRequest: { files: { nodes: entries.slice(at, next).map(([path, viewerViewedState]) => ({ path, viewerViewedState })), pageInfo: { hasNextPage: next < entries.length, endCursor: String(next) } } } } } };
      }
      if (payload.query.includes('FridayRequestReactions')) return { data: { viewer: { login: state.viewer }, repository: { pullRequest: { reactionGroups: state.reactionGroups } } } };
      if (payload.query.includes('FridayReactionSubject')) return { data: { node: state.subjects[payload.variables.id] ?? null } };
      if (payload.query.includes('FridayReviewThreads')) return { data: { viewer: { login: state.viewer }, repository: { pullRequest: { reactionGroups: state.reactionGroups, comments: { nodes: Object.entries(state.subjectReactions).map(([id, reactionGroups]) => ({ id, reactionGroups })) }, reviewThreads: { nodes: state.threads, pageInfo: { hasNextPage: false } } } } } };
      if (payload.query.includes('FridayReviewSubject')) return { data: { node: state.subjects[payload.variables.id] ?? null } };
      if (payload.query.includes('FridayThreadComments')) return { data: { viewer: { login: 'reviewer' }, repository: { pullRequest: { id: 'node-17' } }, node: { ...state.subjects[payload.variables.id], comments: { nodes: state.nextComments, pageInfo: { hasNextPage: false } } } } };
      if (payload.query.includes('FridayReviewerCandidates')) return { data: { repository: { assignableUsers: { nodes: [{ login: 'reviewer' }, { login: 'second', name: 'Second Reviewer' }, { login: 'author' }], pageInfo: { hasNextPage: true } }, pullRequest: { author: { login: 'author' }, reviewRequests: { nodes: [{ requestedReviewer: { login: 'reviewer' } }, { requestedReviewer: { slug: 'team', combinedSlug: 'fixture/team', teamName: 'Fixture team' } }] } } } } };
      if (payload.query.includes('FridayLabelCandidates')) return { data: { repository: { labels: { nodes: state.labelNodes, pageInfo: { hasNextPage: true } }, pullRequest: { labels: { nodes: raw.labels ?? [] } } } } };
      return { data: { viewer: { login: 'reviewer' }, repository: { viewerPermission: state.canWrite ? 'WRITE' : 'READ', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: state.allowRebase, pullRequest: { id: 'node-17', viewerDidAuthor: state.viewerAuthor, viewerCanUpdate: state.canWrite || state.viewerAuthor, isMergeQueueEnabled: state.queue, viewerCanUpdateBranch: state.updatePermission, mergeStateStatus: state.mergeStatus,
        headRefOid: state.getHead, headRef: state.sourceExists ? { id: 'source-ref' } : null, headRepository: { id: 'source-repository', nameWithOwner: state.fork ? 'contributor/project' : repository.path, viewerPermission: state.sourcePermission ?? (state.canWrite ? 'WRITE' : 'READ') },
        isCrossRepository: state.fork, headRepositoryOwner: { login: state.forkOwner }, autoMergeRequest: state.autoMerge, baseRef: state.behindBy === undefined ? null : { compare: { behindBy: state.behindBy } } } } } };
    }
    const write = method !== 'GET';
    if (write) {
      state.writes.push({ path, method, body: payload });
      if (state.hold) return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Fixture connection interrupted')), { once: true }));
      if (state.failPath && path.endsWith(state.failPath)) throw new Error('Synthetic remote failure');
      if (provider === 'github' && path === 'graphql' && payload.query.includes('FridayViewedFiles')) {
        for (const match of payload.query.matchAll(/f(\d+):(markFileAsViewed|unmarkFileAsViewed)/g)) state.viewedFiles[payload.variables['path' + match[1]]] = match[2] === 'markFileAsViewed' ? 'VIEWED' : 'UNVIEWED';
      }
      if (provider === 'github' && path === 'graphql' && payload.query.includes('FridayReaction(')) {
        const groups = payload.variables.id === 'node-17' ? state.reactionGroups : state.subjectReactions[payload.variables.id] ?? (state.subjectReactions[payload.variables.id] = []);
        let group = groups.find(v => v.content === payload.variables.content);
        if (!group) { group = { content: payload.variables.content, viewerHasReacted: false, reactors: { totalCount: 0, nodes: [] } }; groups.push(group); }
        const adding = payload.query.includes('addReaction(');
        if (adding !== group.viewerHasReacted) { group.reactors.totalCount += adding ? 1 : -1; group.viewerHasReacted = adding; group.reactors.nodes = adding ? [...group.reactors.nodes, { login: state.viewer }] : group.reactors.nodes.filter((v: any) => v.login !== state.viewer); }
      }
      if (provider === 'github' && method === 'PATCH') { if (payload.state) raw.state = payload.state; if (payload.title) raw.title = payload.title; if (payload.body !== undefined) raw.body = payload.body; }
      if (provider === 'github' && path === 'graphql') { if (String(payload.query).includes('convertPullRequestToDraft')) raw.draft = true; if (String(payload.query).includes('markPullRequestReadyForReview')) raw.draft = false; }
      if (provider === 'gitlab' && payload?.state_event) raw.state = payload.state_event === 'close' ? 'closed' : 'opened';
      if (provider === 'gitlab' && typeof payload?.title === 'string') raw.title = payload.title;
      if (provider !== 'github' && payload?.description !== undefined) raw.description = payload.description;
      if (provider === 'bitbucket' && payload?.title) raw.title = payload.title;
      if (provider === 'gitlab' && Array.isArray(payload?.reviewer_ids)) raw.reviewers = payload.reviewer_ids.map((id: number) => [...raw.reviewers ?? [], ...state.members].find(v => v.id === id) ?? { id });
      if (provider === 'bitbucket' && Array.isArray(payload?.reviewers)) raw.reviewers = payload.reviewers.map((person: any) => [...raw.reviewers ?? [], ...state.members].find(v => v.uuid === person.uuid) ?? person);
      if (provider === 'bitbucket' && path.endsWith('/decline')) raw.state = 'DECLINED';
      state.afterWrite?.();
      if (path === 'graphql' && payload.query.includes('FridayRevert')) return { data: { revertPullRequest: { revertPullRequest: { url: url.replace('/17', '/18') } } } };
      return path === 'graphql' ? { data: { result: { pullRequest: { id: 'node-17' } } } } : { id: 99 };
    }
    state.reads.push(path);
    if (state.readHoldPath && path.startsWith(state.readHoldPath)) { state.readHeld = true; return new Promise((_resolve, reject) => { if (signal?.aborted) reject(signal.reason); else signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
    if (path.startsWith(`repos/${repository.path}/actions/runs?`)) return { workflow_runs: state.workflowRuns };
    if (path === 'user') return { username: state.viewer, login: state.viewer, id: 9 };
    const withoutQuery = path.split('?')[0];
    if (provider === 'github' && withoutQuery.includes('/contents/')) {
      const file = decodeURIComponent(withoutQuery.split('/contents/')[1]), ref = new URLSearchParams(path.split('?')[1]).get('ref');
      const text = state.fileContents[ref + ':' + file]; if (text === undefined) throw new Error('Synthetic missing file');
      return { path: file, type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) };
    }
    if (withoutQuery.endsWith('/commits')) { if (state.commitFailure) throw new Error('Synthetic commit read failure'); return provider === 'bitbucket' ? { values: state.commits } : state.commits; }
    if (provider === 'github' && /\/commits\/[a-f0-9]+$/.test(withoutQuery)) { const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1); return { sha: state.commitResponseSha || sha, files: state.commitFiles.slice((page - 1) * 100, page * 100) }; }
    if (provider === 'gitlab' && /repository\/commits\/[a-f0-9]+\/diff$/.test(withoutQuery)) return state.commitFiles;
    if (provider === 'bitbucket' && /\/diff\/[a-f0-9]+$/.test(withoutQuery)) return state.patch || 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    if (/\/(pulls|merge_requests|pullrequests)\/17$/.test(withoutQuery)) {
      const value = structuredClone(raw);
      if (provider === 'github') value.head.sha = state.getHead; else if (provider === 'gitlab') value.sha = state.getHead; else value.source.commit.hash = state.getHead;
      return value;
    }
    if (withoutQuery === `projects/${encodeURIComponent(repository.path)}`) return { merge_method: 'merge', squash_option: 'default_off', permissions: { project_access: { access_level: state.canWrite ? 30 : 10 } } };
    if (withoutQuery.endsWith('/users')) return state.members;
    if (withoutQuery.endsWith('/members')) return { values: state.members.map(user => ({ user })) };
    if (withoutQuery.endsWith('/award_emoji')) return state.awards;
    if (withoutQuery.endsWith('/discussions')) return state.discussions;
    if (withoutQuery.includes('/discussions/')) return state.discussions.find(v => v.id === withoutQuery.split('/').at(-1)) ?? {};
    if (/\/(?:notes|comments)\/[1-9]\d*$/.test(withoutQuery)) {
      const id = withoutQuery.split('/').at(-1); return [...state.discussions.flatMap(v => v.notes), ...state.remoteComments ?? []].find(v => String(v.id) === id) ?? {};
    }
    if (path.includes('/permissions/repositories')) return { values: state.knownPermission ? [{ repository: { full_name: repository.path }, permission: state.knownPermission }] : [] };
    if (path.includes('/check-runs')) return { check_runs: [{ name: 'Build', status: 'completed', conclusion: 'success' }] };
    if (path.endsWith('/status')) return { statuses: [] };
    if (path.includes('/statuses')) return { values: [] };
    if (withoutQuery.endsWith('/files')) { const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? 1); return state.diffFiles?.slice((page - 1) * 100, page * 100) ?? [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' }]; }
    if (withoutQuery.endsWith('/diffs')) return [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }];
    if (withoutQuery.endsWith('/diffstat')) return { values: [{ old: { path: 'a.ts' }, new: { path: 'a.ts' }, lines_added: 1, lines_removed: 1 }] };
    if (withoutQuery.endsWith('/diff')) return state.patch || 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const entries = state.remoteComments ?? [{ id: 1, node_id: 'comment-node', body, user: { login: 'reviewer', display_name: 'reviewer' }, author: { username: 'reviewer' }, content: { raw: body }, created_at: '2026-10-19T00:00:00Z', created_on: '2026-10-19T00:00:00Z' }];
    return provider === 'bitbucket' ? { values: entries } : withoutQuery.endsWith('/reviews') ? state.reviews : entries;
  };
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: sync ? 60_000 : 0, environment: { GH_TOKEN: 'synthetic-github-token', FRIDAY_BITBUCKET_ACCESS_TOKEN: 'synthetic-bitbucket-token' }, command: name => name === 'glab' ? '/synthetic/glab' : null,
    request: async (input, init) => {
      const url = new URL(String(input)); assert(['api.github.com', 'api.bitbucket.org'].includes(url.hostname));
      const path = url.pathname.replace(/^\/(?:2\.0\/)?/, '') + url.search;
      if (state.readFailureStatus && path === `repos/${repository.path}/pulls/17`) return new Response('{}', { status: state.readFailureStatus });
      if (new Headers(init?.headers).get('Accept') === 'application/vnd.github.diff' && state.rawDiff !== undefined) { state.reads.push(path); return new Response(state.rawDiff); }
      const value = await handle(path, init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined, init?.signal);
      return typeof value === 'string' ? new Response(value) : response(value);
    }, execute: async (_cwd, _command, args, opts) => {
      if (args[0] === 'mr') { state.cliArgs.push(args); await handle('merge-cli', 'POST', {}, opts?.signal); return output({}); }
      const path = args.find(v => v === 'user' || v === 'graphql' || v.startsWith('projects/'))!;
      const payload = opts?.input ? JSON.parse(String(opts.input)) : undefined;
      return output(await handle(path, args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET', payload, opts?.signal));
    } };
  let engine = await new Engine(data, executor, undefined, options).open();
  if (customHost) await engine.sourceControl.credentials!.update({ version: 0, requestId: 'self-managed', gitlabHost: { host: customHost, enabled: true } });
  await engine.mutate(workspace => workspace.projects.push({ id: 'project', name: 'Fixture', path: cwd, context: '' }));
  const id = await engine.createTask({ prompt: 'Fixture', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'task' });
  await until(() => engine.snapshot(), s => s.tasks[0]?.status === 'completed');
  await engine.mutate(s => { s.tasks[0].changeRequests = [{ number: 17, url, title: 'Fixture change', state: 'open', base: 'main', head: 'linc/feature', provider, host: repository.host, repository: repository.path }]; });
  t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  return { get engine() { return engine }, state, id, url, raw, repository, cwd, data, input: (action = 'comment', requestId = 'comment-request') => ({ requestId, action, url, expectedHeadSha: sha, body }),
    finish: async (operationId: string): Promise<ChangeRequestOperation> => (await until(() => engine.snapshot(), s => !!s.tasks[0]?.changeRequestOperations?.find(op => op.id === operationId && !['queued', 'running'].includes(op.status)))).tasks[0].changeRequestOperations!.find(op => op.id === operationId)!,
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, options).open(); return engine; } };
}

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: details, activity, remote diff and durable literal comments survive without the local worktree`, async t => {
  const f = await setup(t, provider); await rm(f.cwd, { recursive: true });
  const detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.body, body); assert.equal(detail.headSha, sha);
  assert.deepEqual(detail.verdicts, provider === 'gitlab' ? ['comment', 'approve'] : ['comment', 'approve', 'request-changes']);
  assert.equal((await f.engine.changeRequests.activity(f.id, f.url)).items[0].body, body);
  assert.match((await f.engine.changeRequests.files(f.id, f.url, sha)).files[0].patch, /\+new/);
  const input = f.input(); const [a, b] = await Promise.all([f.engine.changeRequests.start(f.id, input), f.engine.changeRequests.start(f.id, input)]); assert.equal(a, b);
  assert.equal((await f.finish(a)).status, 'completed'); assert.equal(f.state.writes.length, 1);
  assert.equal(provider === 'bitbucket' ? f.state.writes[0].body.content.raw : f.state.writes[0].body.body, body);
  const publicState = JSON.stringify(await f.engine.snapshot()); assert(!publicState.includes(body)); assert(!publicState.includes('synthetic-github-token'));
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), a); assert.equal(f.state.writes.length, 1);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, body: 'Different body' }), /不同操作/);
});

test('Review positions preserve renamed paths; unsupported verdicts and stale heads never write', async t => {
  const f = await setup(t, 'gitlab');
  const comments = [{ path: 'a.ts', oldPath: 'old.ts', position: { kind: 'context', oldLine: 1, newLine: 1, side: 'left' }, body }];
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('review'), verdict: 'request-changes', comments }), /不支持/);
  const operationId = await f.engine.changeRequests.start(f.id, { ...f.input('review'), verdict: 'approve', comments });
  assert.equal((await f.finish(operationId)).status, 'completed');
  assert.deepEqual(f.state.writes.map(v => v.path.split('/').at(-1)), ['discussions', 'notes', 'approve']);
  assert.equal(f.state.writes[0].body.position.old_path, 'old.ts'); assert.equal(f.state.writes[0].body.position.head_sha, sha);
  assert.equal(f.state.writes[1].body.body, body);
  f.state.getHead = 'c'.repeat(40);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('review', 'stale'), verdict: 'approve', comments: [] }), /代码版本已改变/);
  const ordinary = await f.engine.changeRequests.start(f.id, f.input('comment', 'after-push')); assert.equal((await f.finish(ordinary)).status, 'completed');
  await assert.rejects(f.engine.changeRequests.files(f.id, f.url, sha), /代码版本已改变/);
});

test('A partly sent review records each effect, retains the verdict last and never replays after restart', async t => {
  const f = await setup(t, 'bitbucket'); f.state.failPath = '/approve';
  const input = { ...f.input('review'), verdict: 'approve', comments: [{ path: 'a.ts', position: { kind: 'added', newLine: 1 }, body: 'Line comment' }] };
  const id = await f.engine.changeRequests.start(f.id, input); const op = await f.finish(id);
  assert.equal(op.status, 'interrupted'); assert.deepEqual(op.completedEffects, ['inline-0', 'summary']); assert.equal(f.state.writes.length, 3);
  await f.reopen(); await f.engine.changeRequests.start(f.id, input); assert.equal(f.state.writes.length, 3);
});

test('Uncertain in-flight comments block concurrent actions and maintenance, then remain interrupted on restart', async t => {
  const f = await setup(t); f.state.hold = true;
  const input = f.input(); const id = await f.engine.changeRequests.start(f.id, input);
  await until(async () => f.state.writes.length, n => n === 1);
  await assert.rejects(f.engine.changeRequests.start(f.id, f.input('comment', 'concurrent')), /正在发送/);
  await assert.rejects(new ServiceMaintenance(() => f.engine.snapshot()).prepare(), /PR／MR/);
  await f.reopen(); const op = await f.finish(id); assert.equal(op.status, 'interrupted');
  assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});

test('GitHub viewer permissions, own-review rules and queue merge use the platform capability response', async t => {
  const f = await setup(t); f.state.viewerAuthor = true; f.state.canWrite = false;
  let detail = await f.engine.changeRequests.detail(f.id, f.url); assert(!detail.actions.includes('merge')); assert(detail.actions.includes('close')); assert.deepEqual(detail.verdicts, ['comment']);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('review'), verdict: 'approve', comments: [] }), /不支持/);
  f.state.canWrite = true; f.state.queue = true; detail = await f.engine.changeRequests.detail(f.id, f.url); assert.deepEqual(detail.mergeMethods, ['merge', 'squash']);
  const id = await f.engine.changeRequests.start(f.id, { ...f.input('merge'), mergeMethod: 'squash' }); assert.equal((await f.finish(id)).status, 'completed');
  assert.match(f.state.writes[0].body.query, /enablePullRequestAutoMerge/);
  assert.equal(f.state.writes[0].body.variables.input.mergeMethod, 'SQUASH');
});

test('Bitbucket reports write restrictions; GitLab merge explicitly disables automatic merge', async t => {
  const bb = await setup(t, 'bitbucket'); bb.state.knownPermission = 'read'; const detail = await bb.engine.changeRequests.detail(bb.id, bb.url);
  assert(!detail.actions.includes('merge')); assert.deepEqual(detail.actions, ['close']);
  const gl = await setup(t, 'gitlab'); const id = await gl.engine.changeRequests.start(gl.id, { ...gl.input('merge'), mergeMethod: 'squash' }); assert.equal((await gl.finish(id)).status, 'completed');
  assert(gl.state.cliArgs[0].includes('--auto-merge=false')); assert(gl.state.cliArgs[0].includes('--squash')); assert(gl.state.cliArgs[0].includes('https://gitlab.com/group/sub/project'));
});

test('Authenticated task-scoped APIs reject invalid data and foreign targets without credential-bearing requests', async t => {
  const f = await setup(t); const auth = new Auth(f.data); const token = auth.token; const api = createAPI(f.engine, auth, () => []);
  assert.equal((await api.request(`/api/tasks/${f.id}/change-request?url=${encodeURIComponent(f.url)}`)).status, 401);
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  assert.equal((await api.request(`/api/tasks/${f.id}/change-request/operations`, { method: 'POST', headers, body: JSON.stringify({ ...f.input(), body: '\ud800' }) })).status, 400);
  assert.equal(f.state.reads.length, 0); assert.equal(f.state.writes.length, 0);
  await assert.rejects(f.engine.changeRequests.detail(f.id, 'https://credential-thief.invalid/fixture/project/pull/17'), /没有关联|Git 仓库/);
  assert.equal(f.state.writes.length, 0);
  const res = await api.request(`/api/tasks/${f.id}/change-request?url=${encodeURIComponent(f.url)}`, { headers }); assert.equal(res.status, 200);
  assert.equal((await res.json()).headSha, sha);
});

test('Review input rejects malformed positions without trimming valid Markdown', () => {
  assert.equal(commentBody(body), body); assert.throws(() => commentBody('\ud800'), /无效/);
  assert.throws(() => reviewComment({ path: '../secret', position: { kind: 'added', newLine: 1 }, body }), /位置无效/);
  assert.throws(() => reviewComment({ path: 'a.ts', position: { kind: 'context', oldLine: 1, newLine: 1, side: 'bad' }, body }), /位置无效/);
});

test('A credential change before the durable phase rejects the old account without a write', async t => {
  const f = await setup(t); const original = f.engine.sourceControl.pin.bind(f.engine.sourceControl); let pins = 0;
  f.engine.sourceControl.pin = async (...args) => {
    if (++pins === 2) await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'rotate', githubToken: { host: 'github.com', token: 'synthetic-rotated-token' } });
    return original(...args);
  };
  const id = await f.engine.changeRequests.start(f.id, f.input()); const result = await f.finish(id);
  assert.equal(result.status, 'failed'); assert.match(result.error ?? '', /凭据已改变/); assert.equal(f.state.writes.length, 0);
});

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: lifecycle actions refresh the persisted association and expose only supported next actions`, async t => {
  const f = await setup(t, provider);
  if (provider !== 'bitbucket') {
    const draft = await f.engine.changeRequests.start(f.id, f.input('draft', 'draft')); assert.equal((await f.finish(draft)).status, 'completed');
    assert((await f.engine.changeRequests.detail(f.id, f.url)).isDraft);
    const ready = await f.engine.changeRequests.start(f.id, f.input('ready', 'ready')); assert.equal((await f.finish(ready)).status, 'completed');
    assert(!(await f.engine.changeRequests.detail(f.id, f.url)).isDraft);
  }
  const close = await f.engine.changeRequests.start(f.id, f.input('close', 'close')); assert.equal((await f.finish(close)).status, 'completed');
  assert.equal((await f.engine.snapshot()).tasks[0].pullRequests?.[0].state, 'closed');
  if (provider === 'bitbucket') await assert.rejects(f.engine.changeRequests.start(f.id, f.input('reopen', 'reopen')), /不支持/);
  else {
    const reopen = await f.engine.changeRequests.start(f.id, f.input('reopen', 'reopen')); assert.equal((await f.finish(reopen)).status, 'completed');
    assert.equal((await f.engine.snapshot()).tasks[0].pullRequests?.[0].state, 'open');
  }
});

test('GitHub submits an atomic review with the selected old-side line and pinned head', async t => {
  const f = await setup(t); const id = await f.engine.changeRequests.start(f.id, { ...f.input('review'), verdict: 'request-changes', comments: [{ path: 'a.ts', oldPath: 'old.ts', body, position: { kind: 'context', oldLine: 3, newLine: 9, side: 'left' } }] });
  assert.equal((await f.finish(id)).status, 'completed'); assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.writes[0].body.comments[0].line, 3); assert.equal(f.state.writes[0].body.comments[0].side, 'LEFT');
  assert.equal(f.state.writes[0].body.commit_id, sha); assert.equal(f.state.writes[0].body.event, 'REQUEST_CHANGES');
});

test('GitHub thread activity exposes old and resolved state, editable nodes and scoped comment pagination', async t => {
  const f = await setup(t);
  f.state.threads = [{ id: 'thread-node', path: 'old.ts', line: 7, diffSide: 'LEFT', isResolved: true, isOutdated: true, comments: { nodes: [{ id: 'inline-node', author: { login: 'reviewer' }, body, createdAt: '2026-10-19T00:00:00Z', viewerCanUpdate: true }], totalCount: 12, pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } } }];
  f.state.subjects['thread-node'] = { id: 'thread-node', __typename: 'PullRequestReviewThread', pullRequest: { id: 'node-17' } };
  f.state.nextComments = [{ id: 'next-comment', author: { login: 'other' }, body: 'Later reply', createdAt: '2026-10-19T00:01:00Z', viewerCanUpdate: false }];
  const activity = await f.engine.changeRequests.activity(f.id, f.url);
  assert.equal(activity.items[0].canEdit, true); assert.equal(activity.items[0].sourceID, 'comment-node');
  assert.equal(activity.threads[0].side, 'left'); assert.equal(activity.threads[0].commentCount, 12); assert.equal(activity.threads[0].nextCursor, 'cursor-1'); assert.equal(activity.threads[0].isOutdated, true); assert.equal(activity.threads[0].isResolved, true);
  const page = await f.engine.changeRequests.threadComments(f.id, f.url, 'thread-node', 'cursor-1'); assert.equal(page.comments[0].body, 'Later reply'); assert.equal(page.comments[0].canEdit, false); assert.equal(page.nextCursor, null);
  f.state.subjects['thread-node'].pullRequest.id = 'node-999';
  await assert.rejects(f.engine.changeRequests.threadComments(f.id, f.url, 'thread-node', 'cursor-1'), /不属于/); assert.equal(f.state.writes.length, 0);
});

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: replies, resolution and comment edits use scoped durable writes after a new code push`, async t => {
  const f = await setup(t, provider), threadID = provider === 'github' ? 'thread-node' : provider === 'gitlab' ? 'abc123' : '10';
  const commentID = provider === 'github' ? 'comment-node' : '10'; f.state.getHead = 'c'.repeat(40);
  if (provider === 'github') {
    f.state.subjects[threadID] = { id: threadID, __typename: 'PullRequestReviewThread', pullRequest: { id: 'node-17' } };
    f.state.subjects[commentID] = { id: commentID, __typename: 'IssueComment', pullRequest: { id: 'node-17' }, viewerCanUpdate: true };
  } else if (provider === 'gitlab') f.state.discussions = [{ id: threadID, notes: [{ id: 10, author: { username: 'reviewer' }, body, resolvable: true, resolved: false, position: { position_type: 'text', old_path: 'old.ts', new_path: 'a.ts', new_line: 1 } }] }];
  else f.state.remoteComments = [{ id: 10, user: { nickname: 'reviewer' }, content: { raw: body }, inline: { path: 'a.ts', to: 1 }, created_on: '2026-10-19T00:00:00Z' }, { id: 11, user: { nickname: 'other' }, content: { raw: 'Reply' }, parent: { id: 10 }, created_on: '2026-10-19T00:01:00Z' }];
  if (provider === 'gitlab') f.state.remoteComments = f.state.discussions.flatMap(v => v.notes);
  const write = async (action: string, requestId: string, extra: object) => { const id = await f.engine.changeRequests.start(f.id, { ...f.input(action, requestId), ...extra }); const op = await f.finish(id); assert.equal(op.status, 'completed', op.error); };
  if (provider !== 'github') {
    const activity = await f.engine.changeRequests.activity(f.id, f.url); assert.equal(activity.threads.length, 1); assert.equal(activity.items.length, 0); assert.equal(activity.threads[0].comments[0].canEdit, true);
    if (provider === 'bitbucket') assert.equal(activity.threads[0].comments.length, 2);
  }
  await write('reply', 'reply', { threadId: threadID }); await write('resolve', 'resolve', { threadId: threadID, resolved: true }); await write('resolve', 'unresolve', { threadId: threadID, resolved: false });
  await write('edit_comment', 'edit-comment', { commentId: commentID, commentKind: 'issue-comment' });
  assert.equal(f.state.writes.length, 4);
  if (provider === 'github') { assert.match(f.state.writes[0].body.query, /addPullRequestReviewThreadReply/); assert.equal(f.state.writes[0].body.variables.body, body); assert.match(f.state.writes[2].body.query, /unresolveReviewThread/); assert.match(f.state.writes[3].body.query, /updateIssueComment/); }
  if (provider === 'gitlab') { assert.match(f.state.writes[0].path, /discussions\/abc123\/notes$/); assert.equal(f.state.writes[0].body.body, body); assert.equal(f.state.writes[1].body.resolved, true); assert.equal(f.state.writes[2].body.resolved, false); assert.match(f.state.writes[3].path, /notes\/10$/); }
  if (provider === 'bitbucket') { assert.equal(f.state.writes[0].body.parent.id, 10); assert.equal(f.state.writes[0].body.content.raw, body); assert.equal(f.state.writes[1].method, 'POST'); assert.equal(f.state.writes[2].method, 'DELETE'); assert.equal(f.state.writes[3].body.content.raw, body); }
  assert(!JSON.stringify(await f.engine.snapshot()).includes(body));
});

test('GitHub review-comment edits are separately addressed; foreign resources and known edit denial never write', async t => {
  const f = await setup(t); f.state.subjects['inline-node'] = { id: 'inline-node', __typename: 'PullRequestReviewComment', reviewPullRequest: { id: 'node-17' }, viewerCanUpdate: true };
  const input = { ...f.input('edit_comment'), commentId: 'inline-node', commentKind: 'review-comment' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.match(f.state.writes[0].body.query, /updatePullRequestReviewComment/);
  f.state.subjects['inline-node'].reviewPullRequest.id = 'node-999';
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'foreign' }), /不属于/);
  f.state.subjects['inline-node'].reviewPullRequest.id = 'node-17'; f.state.subjects['inline-node'].viewerCanUpdate = false;
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'denied' }), /不能编辑/); assert.equal(f.state.writes.length, 1);
});

test('GitHub candidate lists retain requested teams and applied labels outside the first repository page', async t => {
  const f = await setup(t); f.raw.labels = [{ name: 'retired-label', color: '00ff00' }]; f.state.labelNodes = [{ name: 'new/label', color: '112233', description: 'New work' }];
  const candidates = await f.engine.changeRequests.reviewers(f.id, f.url); assert(candidates.truncated); assert(!candidates.candidates.some(v => v.login === 'author')); assert(candidates.candidates.some(v => v.kind === 'team' && v.id === 'team' && v.login === 'fixture/team' && v.isRequested));
  const labels = await f.engine.changeRequests.labels(f.id, f.url); assert(labels.truncated); assert(labels.candidates.some(v => v.name === 'retired-label' && v.isApplied)); assert(labels.candidates.some(v => v.name === 'new/label' && !v.isApplied));
  const id = await f.engine.changeRequests.start(f.id, { ...f.input('reviewers'), reviewers: [{ id: 'team', kind: 'team' }], requested: false }); assert.equal((await f.finish(id)).status, 'completed');
  assert.equal(f.state.writes[0].method, 'DELETE'); assert.deepEqual(f.state.writes[0].body, { reviewers: [], team_reviewers: ['team'] });
  f.state.canWrite = false;
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('reviewers', 'denied-reviewer'), reviewers: [{ id: 'second', kind: 'user' }], requested: true }), /不能请求/);
});

for (const provider of ['gitlab', 'bitbucket'] as const) test(`${provider}: reviewer edits preserve an intervening reviewer and remove only the selected person`, async t => {
  const f = await setup(t, provider);
  const person = (n: number, name: string) => provider === 'gitlab' ? { id: n, username: name } : { uuid: `{00000000-0000-0000-0000-${String(n).padStart(12, '0')}}`, nickname: name };
  const old = person(3, 'old'), added = person(9, 'reviewer'), concurrent = person(22, 'concurrent'), author = person(7, 'author');
  const idOf = (v: any) => String(provider === 'gitlab' ? v.id : v.uuid);
  f.raw.reviewers = [old]; f.state.members = [old, added, author];
  const candidates = await f.engine.changeRequests.reviewers(f.id, f.url); assert.equal(candidates.candidates.length, 2); assert(candidates.candidates.find(v => v.id === idOf(old))?.isRequested);
  const original = f.engine.sourceControl.pin.bind(f.engine.sourceControl); let pins = 0;
  f.engine.sourceControl.pin = async (...args) => { if (++pins === 2) f.raw.reviewers.push(concurrent); return original(...args); };
  const id = await f.engine.changeRequests.start(f.id, { ...f.input('reviewers'), reviewers: [{ id: idOf(added), kind: 'user' }], requested: true }); assert.equal((await f.finish(id)).status, 'completed');
  const values = provider === 'gitlab' ? f.state.writes[0].body.reviewer_ids.map(String) : f.state.writes[0].body.reviewers.map((v: any) => v.uuid);
  assert.deepEqual(new Set(values), new Set([idOf(old), idOf(added), idOf(concurrent)]));
  const remove = await f.engine.changeRequests.start(f.id, { ...f.input('reviewers', 'remove'), reviewers: [{ id: idOf(old), kind: 'user' }], requested: false }); assert.equal((await f.finish(remove)).status, 'completed');
  assert.deepEqual(new Set(f.raw.reviewers.map(idOf)), new Set([idOf(added), idOf(concurrent)]));
});

test('Label changes add only selected labels; partial removals retain receipts and do not replay', async t => {
  const f = await setup(t);
  const add = await f.engine.changeRequests.start(f.id, { ...f.input('labels'), labels: ['new/label'], applied: true }); assert.equal((await f.finish(add)).status, 'completed'); assert.deepEqual(f.state.writes[0].body, { labels: ['new/label'] });
  f.state.failPath = '/second%2Flabel';
  const input = { ...f.input('labels', 'remove-labels'), labels: ['old label', 'second/label'], applied: false };
  const id = await f.engine.changeRequests.start(f.id, input); const result = await f.finish(id); assert.equal(result.status, 'interrupted'); assert.deepEqual(result.completedEffects, ['label-0']);
  assert.match(f.state.writes[1].path, /labels\/old%20label$/); assert.equal(f.state.writes.length, 3);
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 3);
});

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: request edits send only the edited field and retain an intentionally empty description`, async t => {
  const f = await setup(t, provider); const input = { requestId: 'edit-description', action: 'edit_request', url: f.url, body: '' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.deepEqual(f.state.writes[0].body, provider === 'github' ? { body: '' } : { description: '' });
  const title = await f.engine.changeRequests.start(f.id, { ...input, requestId: 'edit-title', body: undefined, title: '  New title  ' }); assert.equal((await f.finish(title)).status, 'completed'); assert.deepEqual(f.state.writes[1].body, { title: 'New title' });
  assert.equal((await f.engine.snapshot()).tasks[0].pullRequests?.[0].title, 'New title');
  if (provider !== 'github') { await assert.rejects(f.engine.changeRequests.labels(f.id, f.url), /未提供/); await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'labels-denied', action: 'labels', labels: ['new'], applied: true }), /不支持/); assert.equal(f.state.writes.length, 2); }
});

test('Collaboration validation rejects duplicate selections, missing states, malformed kinds and invalid Unicode', () => {
  assert.throws(() => collaborationInput({ action: 'resolve', threadId: 'one' }), /无效/);
  assert.throws(() => collaborationInput({ action: 'reviewers', requested: true, reviewers: [{ id: 'one', kind: 'user' }, { id: 'one', kind: 'user' }] }), /重复/);
  assert.throws(() => collaborationInput({ action: 'labels', applied: false, labels: ['one', 'one'] }), /重复/);
  assert.throws(() => collaborationInput({ action: 'edit_comment', body, commentId: 'one', commentKind: 'review' }), /无效/);
  assert.throws(() => collaborationInput({ action: 'edit_request', title: '\ud800' }), /无效/);
});

test('GitHub viewed-state reads are bounded and ordered bursts persist one durable mutation with exact filenames', async t => {
  const f = await setup(t);
  for (let i = 0; i < 501; i++) f.state.viewedFiles['file-' + i] = i === 0 ? 'DISMISSED' : 'VIEWED';
  const viewed = await f.engine.changeRequests.viewed(f.id, f.url); assert.equal(viewed.storage, 'host'); assert.equal(viewed.files.length, 500); assert.equal(viewed.truncated, true); assert.equal(viewed.files[0].state, 'dismissed');
  const input = { ...f.input('files_viewed'), files: [{ path: ' leading \tname ', viewed: true }, { path: ' leading \tname ', viewed: false }] };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.equal(f.state.writes.length, 1);
  assert.match(f.state.writes[0].body.query, /f0:markFileAsViewed/); assert.match(f.state.writes[0].body.query, /f1:unmarkFileAsViewed/); assert.equal(f.state.viewedFiles[' leading \tname '], 'UNVIEWED');
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});

test('GitLab environment marks survive restart, retain unchanged blobs and remain separate for each reviewer', async t => {
  const f = await setup(t, 'gitlab'); f.state.blobs['a.ts'] = sha;
  const input = { ...f.input('files_viewed'), files: [{ path: 'a.ts', viewed: true }] };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.equal(f.state.writes.length, 0);
  await f.reopen(); assert.equal((await f.engine.changeRequests.viewed(f.id, f.url)).files[0].state, 'viewed');
  f.state.getHead = 'c'.repeat(40); assert.equal((await f.engine.changeRequests.viewed(f.id, f.url)).files[0].state, 'viewed');
  f.state.blobs['a.ts'] = 'd'.repeat(40); assert.equal((await f.engine.changeRequests.viewed(f.id, f.url)).files[0].state, 'dismissed');
  f.state.viewer = 'another-reviewer'; assert.equal((await f.engine.changeRequests.viewed(f.id, f.url)).files.length, 0);
  f.state.viewer = 'reviewer'; assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal((await f.engine.changeRequests.viewed(f.id, f.url)).files[0].state, 'dismissed');
});

test('GitHub reactions preserve actor counts, validate subject ownership and persist uncertain receipts', async t => {
  const f = await setup(t);
  f.state.reactionGroups = [{ content: 'HEART', viewerHasReacted: true, reactors: { totalCount: 2, nodes: [{ login: 'reviewer' }, { login: 'other' }] } }];
  const before = await f.engine.changeRequests.reactions(f.id, f.url); assert.deepEqual(before.reactions[0], { content: 'heart', count: 2, actors: ['other'], viewerHasReacted: true });
  const input = { ...f.input('reaction'), content: 'heart', reacted: false, subjectId: 'node-17' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.match(f.state.writes[0].body.query, /removeReaction/);
  assert.equal((await f.engine.changeRequests.reactions(f.id, f.url)).reactions[0].viewerHasReacted, false);
  f.state.subjects['inline-reaction'] = { id: 'inline-reaction', __typename: 'PullRequestReviewComment', commentRequest: { id: 'other-pr' } };
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'foreign-reaction', subjectId: 'inline-reaction', reacted: true }), /不属于/);
  f.state.subjects['inline-reaction'].commentRequest.id = 'node-17';
  const added = await f.engine.changeRequests.start(f.id, { ...input, requestId: 'inline-reaction', subjectId: 'inline-reaction', reacted: true }); assert.equal((await f.finish(added)).status, 'completed');
  const timeline = await f.engine.changeRequests.activity(f.id, f.url); assert.equal(timeline.reactions[0].count, 1);
  f.state.hold = true;
  const uncertainInput = { ...input, requestId: 'uncertain-reaction', content: 'rocket', reacted: true };
  const unknown = await f.engine.changeRequests.start(f.id, uncertainInput); await until(async () => f.state.writes.length, n => n === 3);
  await f.reopen(); assert.equal((await f.finish(unknown)).status, 'interrupted'); assert.equal(await f.engine.changeRequests.start(f.id, uncertainInput), unknown); assert.equal(f.state.writes.length, 3);
});

test('GitLab reaction metadata covers note awards and posting addresses only a note in this MR', async t => {
  const f = await setup(t, 'gitlab');
  f.state.discussions = [{ id: 'abc', notes: [{ id: 10, body: 'Line', author: { username: 'reviewer' } }] }];
  f.state.awards = [{ id: 7, name: 'thumbsup', user: { username: 'reviewer' } }, { id: 8, name: 'thumbsup', user: { username: 'other' } }]; f.state.noteAwards['10'] = f.state.awards;
  const reactions = await f.engine.changeRequests.reactions(f.id, f.url); assert.equal(reactions.reactions[0].count, 2); assert.equal(reactions.bySubject['10'][0].actors[0], 'other');
  const input = { ...f.input('reaction'), content: 'thumbs-up', reacted: false, subjectId: '10' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed'); assert.match(f.state.writes[0].path, /notes\/10\/award_emoji\/7$/);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'wrong-note', subjectId: '99' }), /不属于/); assert.equal(f.state.writes.length, 1);
});

test('Review operations accept T3’s full 500-file batch without inheriting the small general API body limit', async t => {
  const f = await setup(t); const auth = new Auth(f.data); const api = createAPI(f.engine, auth, () => []); t.after(async () => auth.close());
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  const body = { requestId: 'full-file-batch', url: f.url, action: 'files_viewed', files: Array.from({ length: 500 }, (_, i) => ({ path: 'x'.repeat(800) + i, viewed: true })) };
  assert(Buffer.byteLength(JSON.stringify(body)) > 256 * 1024);
  const response = await api.request('/api/tasks/missing/change-request/operations', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 400); assert.match((await response.json()).error, /任务不存在/); assert.equal(f.state.writes.length, 0);
  assert.equal((await api.request('/api/tasks/missing/change-request/viewed-files')).status, 401); assert.equal((await api.request('/api/tasks/missing/change-request/reactions')).status, 401);
});

test('GitHub branch update uses the explicit capability, method, captured head and behind count', async t => {
  const f = await setup(t);
  assert(!(await f.engine.changeRequests.detail(f.id, f.url)).actions.includes('update-branch'));
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('update-branch'), updateMethod: 'rebase' }), /不支持/);
  f.state.updatePermission = true; f.state.behindBy = 2;
  const detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.behindBy, 2); assert.deepEqual(detail.updateMethods, ['merge', 'rebase']);
  const input = { ...f.input('update-branch'), updateMethod: 'rebase' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed');
  assert.deepEqual(f.state.writes[0].body.variables.input, { pullRequestId: 'node-17', expectedHeadOid: sha, updateMethod: 'REBASE' });
  f.state.behindBy = 0;
  assert.equal((await f.finish(await f.engine.changeRequests.start(f.id, { ...input, requestId: 'already-current' }))).status, 'completed'); assert.equal(f.state.writes.length, 1);
  f.state.getHead = 'c'.repeat(40); await assert.rejects(f.engine.changeRequests.start(f.id, { ...input, requestId: 'new-head' }), /代码版本已改变/);
});

for (const mergeStatus of ['BLOCKED', 'CLEAN', 'HAS_HOOKS', 'UNSTABLE']) test(`GitHub auto-merge follows T3 immediate state ${mergeStatus} and stays idempotent`, async t => {
  const f = await setup(t); f.state.mergeStatus = mergeStatus;
  const input = { ...f.input('enable-auto-merge'), mergeMethod: 'squash' };
  const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed');
  assert.match(f.state.writes[0].body.query, mergeStatus === 'BLOCKED' ? /enablePullRequestAutoMerge/ : /\{mergePullRequest/);
  if (mergeStatus !== 'BLOCKED') assert.equal(f.state.writes[0].body.variables.input.expectedHeadOid, sha);
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});

test('Merge queue arms auto-merge even when clean; explicit false and unknown remain distinct', async t => {
  const f = await setup(t); f.state.mergeStatus = 'CLEAN'; f.state.queue = true;
  assert.equal((await f.engine.changeRequests.detail(f.id, f.url)).autoMergeEnabled, undefined);
  assert.equal((await f.finish(await f.engine.changeRequests.start(f.id, f.input('enable-auto-merge')))).status, 'completed');
  assert.match(f.state.writes[0].body.query, /enablePullRequestAutoMerge/);
  f.state.autoMerge = { mergeMethod: 'SQUASH' };
  const armed = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(armed.autoMergeEnabled, true); assert.equal(armed.autoMergeMethod, 'squash');
  assert.equal((await f.finish(await f.engine.changeRequests.start(f.id, f.input('enable-auto-merge', 'already-armed')))).status, 'completed'); assert.equal(f.state.writes.length, 1);
  assert.equal((await f.finish(await f.engine.changeRequests.start(f.id, f.input('disable-auto-merge', 'cancel')))).status, 'completed'); assert.match(f.state.writes[1].body.query, /disablePullRequestAutoMerge/);
  f.state.autoMerge = null;
  assert.equal((await f.engine.changeRequests.detail(f.id, f.url)).autoMergeEnabled, false);
  await f.finish(await f.engine.changeRequests.start(f.id, f.input('disable-auto-merge', 'already-cancelled'))); assert.equal(f.state.writes.length, 2);
  f.state.canWrite = false; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('enable-auto-merge', 'read-only')), /不支持/);
});

for (const action of ['merge','enable-auto-merge'] as const) for (const method of ['merge','squash']) test(`Agent credits: ${action}/${method} uses GitHub's proposed body, preserves humans and pins the captured head`, async t => {
  const f = await setup(t); f.state.mergeBody = 'Details\n\nCo-authored-by: Alice <alice@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>';
  await saveSourceControlPreferences(f.engine, { projectId: 'project', expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } });
  const input = { ...f.input(action), mergeMethod: method }, id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed');
  assert.equal(f.state.mergeMessageQueries[0].method, method.toUpperCase()); assert.equal(f.state.writes[0].body.variables.input.commitBody, 'Details\n\nCo-authored-by: Alice <alice@example.com>'); assert.equal(f.state.writes[0].body.variables.input.expectedHeadOid, sha);
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1); assert.equal(f.state.mergeMessageQueries.length, 1);
});
test('Agent credits: unchanged/default bodies, empty cleaned bodies, rebase, queue and explicit Workspace opt-out preserve T3 semantics', async t => {
  const f = await setup(t); f.state.mergeBody = 'Co-authored-by: Claude <noreply@anthropic.com>';
  await f.finish(await f.engine.changeRequests.start(f.id, f.input('merge', 'defaults'))); assert.equal(f.state.mergeMessageQueries.length, 0); assert.equal(f.state.writes[0].body.variables.input.commitBody, undefined);
  await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } });
  await f.finish(await f.engine.changeRequests.start(f.id, f.input('merge', 'empty'))); assert.equal(f.state.writes[1].body.variables.input.commitBody, '');
  f.state.mergeBody = 'Co-authored-by: Alice <alice@example.com>\n'; await f.finish(await f.engine.changeRequests.start(f.id, f.input('merge', 'human'))); assert.equal(Object.hasOwn(f.state.writes[2].body.variables.input, 'commitBody'), false);
  f.state.allowRebase = true; const queries = f.state.mergeMessageQueries.length; await f.finish(await f.engine.changeRequests.start(f.id, { ...f.input('merge', 'rebase'), mergeMethod: 'rebase' })); assert.equal(f.state.mergeMessageQueries.length, queries);
  f.state.queue = true; f.state.mergeBody = 'Generated by Codex'; await f.finish(await f.engine.changeRequests.start(f.id, f.input('merge', 'queue'))); const queued = f.state.writes.at(-1)!.body; assert.match(queued.query, /enablePullRequestAutoMerge/); assert.equal(Object.hasOwn(queued.variables.input, 'commitBody'), false); assert.equal(Object.hasOwn(queued.variables.input, 'expectedHeadOid'), false);
  f.state.queue = false; await saveSourceControlPreferences(f.engine, { projectId: 'project', expectedVersion: 1, changes: { removeAgentCreditsOnMerge: false } }); const before = f.state.mergeMessageQueries.length;
  await f.finish(await f.engine.changeRequests.start(f.id, f.input('merge', 'project-opt-out'))); assert.equal(f.state.mergeMessageQueries.length, before);
});
test('Agent credits: read failures and moved message heads stop before the external-write receipt', async t => {
  const f = await setup(t); await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } });
  f.state.mergeMessageFailure = true; let id = await f.engine.changeRequests.start(f.id, f.input('merge', 'read-error')); let result = await f.finish(id); assert.equal(result.status, 'failed'); assert.match(result.error!, /Synthetic merge message/); assert.equal(f.state.writes.length, 0);
  f.state.mergeMessageFailure = false; f.state.mergeMessageHead = 'c'.repeat(40); id = await f.engine.changeRequests.start(f.id, f.input('enable-auto-merge', 'message-moved')); result = await f.finish(id); assert.equal(result.status, 'failed'); assert.match(result.error!, /代码版本/); assert.equal(f.state.writes.length, 0);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('merge', 'stack'), stackNumber: 4 }), /堆叠/); assert.equal(f.state.writes.length, 0);
});
test('Agent credits: an immediately mergeable auto action also rewrites its new commit body', async t => {
  const f = await setup(t); f.state.mergeBody = 'Details\nGenerated by Codex'; await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } });
  for (const status of ['CLEAN','HAS_HOOKS','UNSTABLE']) { f.state.mergeStatus = status; const id = await f.engine.changeRequests.start(f.id, f.input('enable-auto-merge', 'immediate-' + status)); assert.equal((await f.finish(id)).status, 'completed'); assert.match(f.state.writes.at(-1)!.body.query, /\{mergePullRequest/); assert.equal(f.state.writes.at(-1)!.body.variables.input.commitBody, 'Details'); }
});
test('Agent credits: uncertain cleaned merge writes never repeat after settings change and service restart', async t => {
  const f = await setup(t); f.state.mergeBody = 'Details\nGenerated by Codex'; await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } }); f.state.hold = true;
  const input = f.input('enable-auto-merge'), id = await f.engine.changeRequests.start(f.id, input); await until(async () => f.state.writes.length, n => n === 1); assert.equal(f.state.writes[0].body.variables.input.commitBody, 'Details');
  await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 1, changes: { removeAgentCreditsOnMerge: false } }); await f.reopen(); assert.equal((await f.finish(id)).status, 'interrupted'); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1); assert.equal(f.state.mergeMessageQueries.length, 1);
});
for (const provider of ['gitlab','bitbucket'] as const) test(`Agent credits: ${provider} retains its native merge behavior with the GitHub setting enabled`, async t => {
  const f = await setup(t, provider); await saveSourceControlPreferences(f.engine, { projectId: null, expectedVersion: 0, changes: { removeAgentCreditsOnMerge: true } }); const id = await f.engine.changeRequests.start(f.id, f.input('merge')); assert.equal((await f.finish(id)).status, 'completed'); assert.equal(f.state.mergeMessageQueries.length, 0); assert(f.state.writes.length > 0);
});

test('GitLab branch rebase and deferred merge use T3 CLI flags, cancellation is a scoped API call', async t => {
  const f = await setup(t, 'gitlab');
  assert.equal((await f.engine.changeRequests.detail(f.id, f.url)).autoMergeEnabled, undefined);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('update-branch'), updateMethod: 'merge' }), /不支持/);
  await f.finish(await f.engine.changeRequests.start(f.id, { ...f.input('update-branch'), updateMethod: 'rebase' }));
  await f.finish(await f.engine.changeRequests.start(f.id, { ...f.input('enable-auto-merge', 'arm'), mergeMethod: 'squash' }));
  assert.deepEqual(f.state.cliArgs, [['mr', 'rebase', '17', '--repo', 'https://gitlab.com/group/sub/project'], ['mr', 'merge', '17', '--repo', 'https://gitlab.com/group/sub/project', '--auto-merge=true', '--yes', '--squash']]);
  f.raw.auto_merge_enabled = true; f.raw.squash_on_merge = true;
  let detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.autoMergeEnabled, true); assert.equal(detail.autoMergeMethod, 'squash');
  await f.finish(await f.engine.changeRequests.start(f.id, f.input('disable-auto-merge', 'cancel'))); assert.match(f.state.writes.at(-1)!.path, /merge_requests\/17\/cancel_merge_when_pipeline_succeeds$/);
  f.raw.user.can_merge = false; detail = await f.engine.changeRequests.detail(f.id, f.url);
  for (const action of ['update-branch', 'enable-auto-merge', 'disable-auto-merge'] as const) { assert(!detail.actions.includes(action)); await assert.rejects(f.engine.changeRequests.start(f.id, f.input(action, action)), /不支持/); }
});

test('GitHub revert returns a durable result link and never creates another PR after restart', async t => {
  const f = await setup(t);
  await assert.rejects(f.engine.changeRequests.start(f.id, f.input('revert')), /不支持/);
  f.raw.state = 'closed'; f.raw.merged = true;
  const input = f.input('revert'); const id = await f.engine.changeRequests.start(f.id, input), op = await f.finish(id);
  assert.equal(op.status, 'completed'); assert.equal(op.resultURL, f.url.replace('/17', '/18')); assert.match(f.state.writes[0].body.query, /revertPullRequest/);
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal((await f.finish(id)).resultURL, op.resultURL); assert.equal(f.state.writes.length, 1);
});

test('Deleting a fork source branch uses source permissions and atomic beforeOid, never the local checkout', async t => {
  const f = await setup(t); f.raw.state = 'closed'; f.raw.merged = true; f.state.canWrite = false; f.state.sourcePermission = 'WRITE'; f.state.fork = true;
  await rm(f.cwd, { recursive: true });
  assert((await f.engine.changeRequests.detail(f.id, f.url)).actions.includes('delete-branch'));
  const input = f.input('delete-branch'); const id = await f.engine.changeRequests.start(f.id, input); assert.equal((await f.finish(id)).status, 'completed');
  assert.deepEqual(f.state.writes[0].body.variables.input, { repositoryId: 'source-repository', refUpdates: [{ name: 'refs/heads/linc/feature', beforeOid: sha, afterOid: '0'.repeat(40) }] });
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});

test('Source branch deletion refuses open, base, default, unknown default, new commits, read-only and stack requests', async t => {
  const f = await setup(t);
  await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /不支持/);
  f.raw.state = 'closed';
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('delete-branch'), stackNumber: 1 }), /堆叠/);
  f.raw.head.ref = 'main'; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /目标分支/); f.raw.head.ref = 'linc/feature';
  f.state.defaultBranch = 'linc/feature'; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /默认分支/);
  f.state.defaultBranch = ''; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /默认分支/);
  f.state.defaultBranch = 'main'; f.state.sourceHead = 'c'.repeat(40); await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /新提交/);
  f.state.sourceHead = sha; f.state.sourcePermission = 'READ'; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('delete-branch')), /不支持/);
  f.state.sourcePermission = 'WRITE'; f.state.sourceExists = false;
  assert.equal((await f.finish(await f.engine.changeRequests.start(f.id, f.input('delete-branch')))).status, 'completed'); assert.equal(f.state.writes.length, 0);
});

const workflowRun = (id: number) => ({ id, name: 'Test', head_sha: sha, head_branch: 'linc/feature', event: 'pull_request', status: 'completed', conclusion: 'action_required' });
test('Fork workflow approval captures only this head and its current run IDs, each with its own receipt', async t => {
  const f = await setup(t); f.state.fork = true; f.state.workflowRuns = [workflowRun(10), workflowRun(11), { ...workflowRun(99), head_sha: 'c'.repeat(40) }];
  assert.equal((await f.engine.changeRequests.detail(f.id, f.url)).workflowApprovalsRequired, 2);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('approve-workflows', 'wrong-source'), expectedWorkflowSource: { branch: 'another', owner: 'contributor' } }), /来源已改变/);
  await assert.rejects(f.engine.changeRequests.start(f.id, { ...f.input('approve-workflows', 'wrong-owner'), expectedWorkflowSource: { branch: 'linc/feature', owner: 'another' } }), /来源已改变/);
  f.state.afterWrite = () => { f.state.workflowRuns = [workflowRun(12)]; };
  const input = { ...f.input('approve-workflows'), expectedWorkflowSource: { branch: 'linc/feature', owner: 'ConTRIbutor' } }; const id = await f.engine.changeRequests.start(f.id, input); const op = await f.finish(id);
  assert.equal(op.status, 'completed'); assert.deepEqual(op.completedEffects, ['approve-workflow-10', 'approve-workflow-11']);
  assert.deepEqual(f.state.writes.map(v => v.path), ['repos/fixture/project/actions/runs/10/approve']);
  await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
});

test('Workflow approval refuses ambiguous or truncated fork heads before sending anything', async t => {
  const f = await setup(t); f.state.fork = true; f.state.workflowRuns = [workflowRun(10)];
  f.state.workflowHeads = [17, 18].map(number => ({ number, headRefOid: sha, isCrossRepository: true, headRepositoryOwner: { login: 'contributor' } }));
  await assert.rejects(f.engine.changeRequests.start(f.id, f.input('approve-workflows')), /多个或不同/);
  assert.equal((await f.engine.changeRequests.detail(f.id, f.url)).workflowApprovalsUnavailable, true);
  f.state.workflowHeads = undefined; f.state.workflowHeadsMore = true; await assert.rejects(f.engine.changeRequests.start(f.id, f.input('approve-workflows')), /列表不完整/);
  f.state.workflowHeadsMore = false; f.state.workflowRuns = Array.from({ length: 1001 }, (_, i) => workflowRun(i + 1));
  await assert.rejects(f.engine.changeRequests.start(f.id, f.input('approve-workflows')), /列表不完整/); assert.equal(f.state.writes.length, 0);
});

for (const change of ['head', 'owner', 'branch', 'fork']) test(`Workflow approval stops remaining writes when the fork ${change} changes`, async t => {
  const f = await setup(t); f.state.fork = true; f.state.workflowRuns = [workflowRun(10), workflowRun(11)];
  f.state.afterWrite = () => { if (change === 'head') f.state.getHead = 'c'.repeat(40); else if (change === 'owner') f.state.forkOwner = 'another'; else if (change === 'branch') f.raw.head.ref = 'another'; else f.state.fork = false; };
  const id = await f.engine.changeRequests.start(f.id, f.input('approve-workflows')); const op = await f.finish(id);
  assert.equal(op.status, 'failed'); assert.deepEqual(op.completedEffects, ['approve-workflow-10']); assert.equal(f.state.writes.length, 1);
});

test('Uncertain branch mutations do not replay; Bitbucket never offers unsupported advanced actions', async t => {
  const f = await setup(t); f.state.hold = true;
  const input = f.input('enable-auto-merge'); const id = await f.engine.changeRequests.start(f.id, input); await until(async () => f.state.writes.length, n => n === 1);
  await f.reopen(); assert.equal((await f.finish(id)).status, 'interrupted'); assert.equal(await f.engine.changeRequests.start(f.id, input), id); assert.equal(f.state.writes.length, 1);
  const bb = await setup(t, 'bitbucket');
  for (const action of ['update-branch', 'enable-auto-merge', 'disable-auto-merge', 'revert', 'delete-branch', 'approve-workflows']) await assert.rejects(bb.engine.changeRequests.start(bb.id, bb.input(action, action)), /不支持/);
  assert.equal(bb.state.writes.length, 0);
});

const timelineDate = '2026-10-20T01:00:00+02:00';
function timelineCommit(provider: Provider, hash = sha) {
  if (provider === 'github') return { oid: hash, messageHeadline: 'Private commit headline', committedDate: timelineDate, additions: 4, deletions: 2, authors: { nodes: [{ name: 'Co Author', avatarUrl: 'https://avatars.example.test/avatar', user: { login: 'coauthor' } }, { name: 'Unlinked Author' }] } };
  if (provider === 'gitlab') return { id: hash, title: 'Private commit headline', committed_date: timelineDate, stats: { additions: 4, deletions: 2 }, author_name: 'Co Author', author_email: 'synthetic@example.test' };
  return { hash, date: timelineDate, message: 'Private commit headline\nLong body', author: { raw: 'Unlinked Author', user: { nickname: 'coauthor', display_name: 'Co Author', links: { avatar: { href: 'https://avatars.example.test/avatar' } } } } };
}
for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: activity exposes commit authors and known stats without persisting remote history`, async t => {
  const f = await setup(t, provider); f.state.commits = [timelineCommit(provider), { id: '../invalid', oid: '../invalid', hash: '../invalid', committedDate: timelineDate }];
  const activity = await f.engine.changeRequests.activity(f.id, f.url);
  assert.equal(activity.commits.length, 1); assert.equal(activity.commits[0].oid, sha); assert.equal(activity.commits[0].messageHeadline, 'Private commit headline'); assert.equal(activity.commits[0].committedDate, timelineDate);
  assert.equal(activity.commits[0].authors[0].name, 'Co Author');
  if (provider === 'github') assert.equal(activity.commits[0].authors[1].login, 'Unlinked Author');
  if (provider !== 'bitbucket') assert.equal(activity.commits[0].additions, 4); else assert.equal(activity.commits[0].additions, undefined);
  assert.equal((activity as any).commitsUnavailable, undefined); assert(!JSON.stringify(await f.engine.snapshot()).includes('Private commit headline'));
  f.state.commitFailure = true;
  const partial = await f.engine.changeRequests.activity(f.id, f.url); assert.equal((partial as any).commitsUnavailable, true); assert.equal(partial.items.length, 1); assert.equal(f.state.writes.length, 0);
});

test('GitHub keeps newest 100 commits, attaches dismissal reasons by node ID, and keeps known history on later page failures', async t => {
  const f = await setup(t); f.state.commits = Array.from({ length: 101 }, (_, i) => timelineCommit('github', i.toString(16).padStart(40, '0'))); f.state.commitsTruncated = true;
  f.state.reviews = [{ id: 10, node_id: 'review-node', state: 'DISMISSED', body: 'Review body', submitted_at: timelineDate, user: { login: 'reviewer' } }];
  f.state.dismissals = Array.from({ length: 101 }, (_, i) => ({ review: { id: i === 100 ? 'review-node' : 'other-' + i }, dismissalMessage: 'Reason ' + i }));
  let activity = await f.engine.changeRequests.activity(f.id, f.url);
  assert.equal(activity.commits.length, 100); assert.equal(activity.commits[0].oid, '1'.padStart(40, '0')); assert.equal(activity.commitsTruncated, true); assert.equal(activity.items.find(v => v.kind === 'review')?.dismissalMessage, 'Reason 100');
  f.state.dismissalFailureAfter = true; activity = await f.engine.changeRequests.activity(f.id, f.url);
  assert.equal(activity.commits.length, 100); assert.equal((activity as any).dismissalsTruncated, true); assert.equal(activity.items.find(v => v.kind === 'review')?.dismissalMessage, undefined);
});

test('Lifecycle timestamps use platform values, and GitLab system notes do not become user comments', async t => {
  const f = await setup(t); f.raw.created_at = timelineDate; f.raw.closed_at = '2026-10-20T02:00:00Z'; f.raw.merged_at = f.raw.closed_at; f.raw.state = 'closed'; f.raw.merged = true;
  const detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.mergedAt, f.raw.merged_at); assert.equal(detail.closedAt, f.raw.closed_at);
  const gl = await setup(t, 'gitlab'); gl.state.remoteComments = [{ id: 1, system: true, body: 'Synthetic pipeline event' }, { id: 2, system: false, body: 'Human note', author: { username: 'reviewer' }, created_at: timelineDate }];
  const items = (await gl.engine.changeRequests.activity(gl.id, gl.url)).items; assert.equal(items.length, 1); assert.equal(items[0].body, 'Human note');
});

test('Bitbucket exposes participant verdicts with their original dates and maps merged closed_on correctly', async t => {
  const f = await setup(t, 'bitbucket'); f.raw.state = 'MERGED'; f.raw.closed_on = timelineDate;
  f.raw.participants = [{ user: { nickname: 'voter' }, participated_on: timelineDate, approved: true }, { user: { nickname: 'changes' }, participated_on: timelineDate, state: 'changes_requested' }, { user: { nickname: 'waiting' } }];
  const detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.mergedAt, timelineDate); assert.equal(detail.closedAt, undefined);
  const reviews = (await f.engine.changeRequests.activity(f.id, f.url)).items.filter(v => v.kind === 'review'); assert.deepEqual(reviews.map(v => v.state).sort(), ['approved', 'changes_requested']); assert(reviews.every(v => v.createdAt === timelineDate && !v.commentKind));
});

for (const provider of ['github', 'gitlab', 'bitbucket'] as const) test(`${provider}: opening a commit reads an associated immutable diff without the worktree`, async t => {
  const f = await setup(t, provider); f.state.commits = [timelineCommit(provider)];
  f.state.commitFiles = provider === 'github' ? [{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new\n' }]
    : [{ old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new\n' }];
  await rm(f.cwd, { recursive: true });
  const result = await f.engine.changeRequests.commit(f.id, f.url, sha);
  assert.equal(result.headSha, sha); assert.equal(result.commit.oid, sha); assert.equal(result.files[0].path, 'a.ts'); assert.equal(result.files[0].additions, 1); assert.equal(result.files[0].deletions, 1); assert.match(result.files[0].patch, /\+new/);
  await assert.rejects(f.engine.changeRequests.commit(f.id, f.url, '../bad'), /版本无效/);
  await assert.rejects(f.engine.changeRequests.commit(f.id, f.url, 'c'.repeat(40)), /不在当前/);
  assert(!f.state.reads.some(path => path.includes('c'.repeat(40)))); assert.equal(f.state.writes.length, 0);
});

test('GitHub commit files page within the pinned repository and reject a mismatched response SHA', async t => {
  const f = await setup(t); f.state.commits = [timelineCommit('github')];
  f.state.commitFiles = Array.from({ length: 101 }, (_, i) => ({ filename: i + '.ts', patch: i === 100 ? undefined : '@@ -1 +1 @@\n-a\n+b', status: 'modified' }));
  const result = await f.engine.changeRequests.commit(f.id, f.url, sha); assert.equal(result.files.length, 101); assert.equal(result.truncated, false); assert.equal(result.files[100].unavailable, true);
  assert(f.state.reads.some(path => path.endsWith('per_page=100&page=2')));
  f.state.commitResponseSha = 'c'.repeat(40); await assert.rejects(f.engine.changeRequests.commit(f.id, f.url, sha), /版本不一致/);
});

test('Bitbucket commit patches preserve BOM, quoted Unicode rename paths and binary unavailable state', async t => {
  const f = await setup(t, 'bitbucket'); f.state.commits = [timelineCommit('bitbucket')];
  f.state.patch = '\uFEFFdiff --git "a/old name.ts" "b/新 name.ts"\nsimilarity index 80%\nrename from old name.ts\nrename to 新 name.ts\n--- "a/old name.ts"\n+++ "b/新 name.ts"\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n';
  const result = await f.engine.changeRequests.commit(f.id, f.url, sha); assert.equal(result.files.length, 2); assert.equal(result.files[0].path, '新 name.ts'); assert.equal(result.files[0].oldPath, 'old name.ts'); assert.equal(result.files[0].status, 'renamed'); assert.equal(result.files[0].additions, 1); assert.match(result.files[0].patch, /\+new/);
  assert.equal(result.files[1].path, 'image.bin');
  // Binary patch metadata is visible, but has no fabricated textual hunk.
  assert(!result.files[1].patch.includes('@@')); assert.equal(result.files[1].unavailable, true);
});

test('Commit detail APIs require authentication and a real associated task before touching platform transport', async t => {
  const f = await setup(t), auth = new Auth(f.data), app = createAPI(f.engine, auth); t.after(() => auth.close());
  const query = '?' + new URLSearchParams({ url: f.url, sha });
  assert.equal((await app.request('/api/tasks/' + f.id + '/change-request/commit' + query)).status, 401);
  const token = auth.token;
  const response = await app.request('/api/tasks/missing/change-request/commit' + query, { headers: { Authorization: 'Bearer ' + token.trim() } }); assert.equal(response.status, 400); assert.equal(f.state.reads.length, 0); assert.equal(f.state.writes.length, 0);
});

test('Self-managed GitLab: associated MR details and durable comments retain custom host after the worktree disappears', async t => {
  const f = await setup(t, 'gitlab', 'code.example.test:8443'); await rm(f.cwd, { recursive: true });
  const detail = await f.engine.changeRequests.detail(f.id, f.url); assert.equal(detail.pullRequest.host, 'code.example.test:8443'); assert.equal(detail.pullRequest.repository, 'group/sub/project');
  const result = await f.finish(await f.engine.changeRequests.start(f.id, f.input())); assert.equal(result.status, 'completed', result.error); await f.reopen(); assert.equal(await f.engine.changeRequests.start(f.id, f.input()), result.id);
});

test('PR HTTP reads share cached results, explicit refresh sees host changes, and credential disable cannot reuse cached data', async t => {
  const f = await setup(t), auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(() => auth.close());
  const headers = { Authorization: 'Bearer ' + auth.token }, path = `/api/tasks/${f.id}/change-request?` + new URLSearchParams({ url: f.url });
  const first = await api.request(path, { headers }); assert.equal(first.status, 200); assert.equal((await first.json()).body, body);
  const reads = f.state.reads.length; f.raw.body = 'Updated privately on host';
  const second = await api.request(path, { headers }); assert.equal((await second.json()).body, body); assert.equal(f.state.reads.length, reads);
  const fresh = await api.request(path + '&refresh=true', { headers }); assert.equal((await fresh.json()).body, f.raw.body); assert(f.state.reads.length > reads);
  const before = f.state.reads.length;
  await f.engine.sourceControl.credentials!.update({ version: 0, requestId: 'disable', githubHost: { host: 'github.com', enabled: false } });
  assert.equal((await api.request(path, { headers })).status, 400); assert.equal(f.state.reads.length, before);
  assert(!JSON.stringify(await f.engine.snapshot()).includes('Updated privately on host'));
});

test('Provider mutations invalidate the PR read cache before the completed receipt becomes visible', async t => {
  const f = await setup(t), auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(() => auth.close());
  const headers = { Authorization: 'Bearer ' + auth.token }, path = `/api/tasks/${f.id}/change-request?` + new URLSearchParams({ url: f.url });
  await api.request(path, { headers }); f.state.afterWrite = () => { f.raw.body = 'Host changed during the comment'; };
  const result = await f.finish(await f.engine.changeRequests.start(f.id, f.input())); assert.equal(result.status, 'completed');
  const response = await api.request(path, { headers }); assert.equal((await response.json()).body, 'Host changed during the comment'); assert.equal(f.state.writes.length, 1);
});

test('Checks HTTP reads authenticate first and share their fifteen-second read rather than repeating conditional requests', async t => {
  const f = await setup(t), auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(() => auth.close());
  f.raw.head.repo.id = 1; f.raw.base.repo = { id: 1 };
  const headers = { Authorization: 'Bearer ' + auth.token }, path = `/api/tasks/${f.id}/change-request/checks?` + new URLSearchParams({ url: f.url });
  assert.equal((await api.request(path)).status, 401); assert.equal(f.state.reads.length, 0);
  const first = await api.request(path, { headers }); assert.equal(first.status, 200); const result = await first.json(), reads = f.state.reads.length;
  assert.deepEqual(await (await api.request(path, { headers })).json(), result); assert.equal(f.state.reads.length, reads);
});

test('Service close cancels an active cached read before draining a mutation waiting for invalidation', async t => {
  const f = await setup(t), auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(() => auth.close());
  f.state.readHoldPath = `repos/${f.repository.path}/pulls/17/reviews`;
  const pending = api.request(`/api/tasks/${f.id}/change-request/activity?` + new URLSearchParams({ url: f.url }), { headers: { Authorization: 'Bearer ' + auth.token } });
  await until(async () => f.state.readHeld, value => value);
  await f.engine.changeRequests.start(f.id, f.input());
  await until(() => f.engine.snapshot(), state => state.tasks[0]?.changeRequestOperations?.some(value => value.status === 'running') === true);
  await f.engine.close(); assert((await pending).status >= 400); assert.equal(f.state.writes.length, 0);
});

test('Full revision file API authenticates, confines files to the associated PR diff and keeps literal content out of workspace state', async t => {
  const f = await setup(t); f.state.fileContents[sha + ':a.ts'] = 'literal <script> 中文\n'; const auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(async () => auth.close());
  const path = `/api/tasks/${f.id}/change-request/file-contents?` + new URLSearchParams({ url: f.url, head: sha, side: 'new', path: 'a.ts' });
  assert.equal((await api.request(path)).status, 401); const headers = { Authorization: 'Bearer ' + auth.token };
  const response = await api.request(path, { headers }); assert.equal(response.status, 200); assert.equal((await response.json()).text, 'literal <script> 中文\n'); assert(!JSON.stringify(await f.engine.snapshot()).includes('literal <script>'));
  const before = f.state.reads.filter(v => v.includes('/contents/')).length;
  const foreign = await api.request(path.replace('path=a.ts', 'path=unrelated'), { headers }); assert.equal(foreign.status, 400); assert.equal(f.state.reads.filter(v => v.includes('/contents/')).length, before);
});
test('Whole-change inline review refuses a changed base and stops later effects after a target-branch move', async t => {
  const f = await setup(t, 'gitlab'); const review = { ...f.input('review'), expectedBaseSha: base, verdict: 'comment', body: '', comments: [{ path: 'a.ts', position: { kind: 'added', newLine: 1 }, body: 'first' }, { path: 'a.ts', position: { kind: 'added', newLine: 1 }, body: 'second' }] };
  f.raw.diff_refs.base_sha = 'c'.repeat(40); await assert.rejects(f.engine.changeRequests.start(f.id, review), /Diff 基准已改变/); assert.equal(f.state.writes.length, 0);
  f.raw.diff_refs.base_sha = base; f.state.afterWrite = () => { f.raw.diff_refs.base_sha = 'c'.repeat(40); };
  const result = await f.finish(await f.engine.changeRequests.start(f.id, review)); assert.equal(result.status, 'failed'); assert.match(result.error!, /Diff 基准已改变/); assert.equal(f.state.writes.length, 1); assert.equal(f.state.writes[0].body.body, 'first');
});

test('Diff slice API authenticates, rejects unassociated targets and binds complete files to the requested page or raw diff', async t => {
  const f = await setup(t); f.state.canWrite = false;
  const auth = new Auth(f.data), api = createAPI(f.engine, auth); t.after(async () => auth.close());
  const headers = { Authorization: 'Bearer ' + auth.token };
  const request = (resource: string, fields: Record<string, string> = {}, id = f.id) => `/api/tasks/${id}/change-request/${resource}?` + new URLSearchParams({ url: f.url, head: sha, base, ...fields });
  const path = request('diff', { cursor: '11' });
  assert.equal((await api.request(path)).status, 401);
  assert.equal((await api.request(request('diff', { cursor: '11' }, 'missing'), { headers })).status, 400);
  assert.equal((await api.request(request('diff', { cursor: '0' }), { headers })).status, 400);
  assert.equal((await api.request(request('diff', { url: f.url.replace('/17', '/18') }), { headers })).status, 400);
  assert.equal(f.state.reads.length, 0);
  f.state.diffFiles = Array.from({ length: 1001 }, (_, i) => ({ filename: i === 1000 ? 'beyond.ts' : i + '.ts', additions: 7, deletions: 2 }));
  f.state.fileContents[sha + ':beyond.ts'] = 'private literal beyond first 1000';
  const page = await api.request(path, { headers }); assert.equal(page.status, 200); const value = await page.json();
  assert.equal(value.cursor, '11'); assert.equal(value.nextCursor, null); assert.equal(value.files[0].diffCursor, '11'); assert.deepEqual(value.omittedFileStats, [{ path: 'beyond.ts', additions: 7, deletions: 2 }]);
  const full = request('file-contents', { cursor: '11', slice: 'true', path: 'beyond.ts', side: 'new' });
  assert.equal((await api.request(full)).status, 401);
  const content = await api.request(full, { headers }); assert.equal(content.status, 200); assert.equal((await content.json()).text, f.state.fileContents[sha + ':beyond.ts']);
  const before = f.state.reads.filter(p => p.includes('/contents/')).length;
  const invalidScopes: Record<string, string>[] = [{ cursor: '2' }, { base: 'c'.repeat(40) }, { slice: 'false' }];
  for (const fields of invalidScopes) {
    const denied = await api.request(request('file-contents', { cursor: '11', slice: 'true', path: 'beyond.ts', side: 'new', ...fields }), { headers }); assert.equal(denied.status, 400);
  }
  assert.equal(f.state.reads.filter(p => p.includes('/contents/')).length, before);
  f.state.rawDiff = Array.from({ length: 1001 }, (_, i) => { const name = i === 1000 ? 'beyond.ts' : i + '.ts'; return `diff --git a/${name} b/${name}\nold mode 100644\nnew mode 100755\n`; }).join('');
  const raw = await api.request(request('diff'), { headers }); assert.equal(raw.status, 200); assert.equal((await raw.json()).files.length, 1001);
  const rawContents = await api.request(request('file-contents', { slice: 'true', path: 'beyond.ts', side: 'new' }), { headers }); assert.equal(rawContents.status, 200); assert.equal((await rawContents.json()).requestBaseSha, base);
  assert(!JSON.stringify(await f.engine.snapshot()).includes('private literal beyond first 1000')); assert.equal(f.state.writes.length, 0);
});


test('Resident Engine watches refresh public PR metadata and reuse the credential-scoped summary cache after restart', async t => {
  const f = await setup(t, 'github', undefined, true);
  await f.engine.changeRequestSync.drain();
  let task = (await f.engine.snapshot()).tasks.find(t => t.id === f.id)!;
  assert.equal(task.changeRequests?.[0].snapshot?.headSha, sha); assert.equal(f.state.summaryReads, 1);
  const revision = (await f.engine.snapshot()).revision;
  await f.reopen(); await f.engine.changeRequestSync.drain();
  assert.equal(f.state.summaryReads, 1); assert.equal((await f.engine.snapshot()).tasks[0].changeRequests?.[0].snapshot?.headSha, sha);
  f.raw.title = 'Fresh host title'; f.raw.updated_at = '2026-10-20T04:00:00Z';
  f.engine.changeRequestSync.request(f.id, f.url); await f.engine.changeRequestSync.drain();
  task = (await f.engine.snapshot()).tasks.find(t => t.id === f.id)!;
  assert.equal(task.changeRequests?.[0].title, 'Fresh host title'); assert.equal(f.state.summaryReads, 2);
  assert(!JSON.stringify(task.changeRequests).includes(body)); assert((await f.engine.snapshot()).revision > revision);
});

test('Display reads retain recent data on a transient failure, while explicit refresh and authentication errors remain strict', async t => {
  const f = await setup(t); const first = await f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache'); assert.equal(first.body, body);
  await f.engine.changeRequests.invalidateReference(f.repository, 17); f.state.readFailureStatus = 503;
  const held = await f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache') as typeof first & { stale?: boolean };
  assert.equal(held.stale, true); assert.equal(held.body, body);
  await assert.rejects(f.engine.changeRequests.detail(f.id, f.url, undefined, 'refresh'));
  f.state.readFailureStatus = 401; await assert.rejects(f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache'));
});


test('Checks reuse an unchanged detail fingerprint and invalidate a changed merge status without repeating background sync forever', async t => {
  const f = await setup(t); f.raw.head.repo.id = 1; f.raw.base.repo = { id: 1 };
  const initial = await f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache'); assert.equal(initial.mergeability, 'blocked');
  await f.engine.changeRequests.checks(f.id, f.url, undefined, 'cache'); const count = f.state.reads.length;
  await f.engine.changeRequests.checks(f.id, f.url, undefined, 'cache'); assert.equal(f.state.reads.length, count);
  await f.engine.changeRequests.invalidateReference(f.repository, 17);
  await f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache'); f.state.mergeStatus = 'CLEAN';
  const changed = await f.engine.changeRequests.checks(f.id, f.url, undefined, 'cache'); assert.equal(changed.mergeability, 'clean');
  const refreshed = await f.engine.changeRequests.detail(f.id, f.url, undefined, 'cache'); assert.equal(refreshed.mergeability, 'clean');
});
