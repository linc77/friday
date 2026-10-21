import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { SourceControlConnections, type SourceControlConnectionOptions } from '../src/source-control-connections.js';
import { sourceControlRepository, pinTaskChangeRequest, readTaskChangeRequest, findTaskChangeRequest, taskRepositoryDefaultBranch } from '../src/task-change-requests.js';
import { changeRequestDetail } from '../src/task-change-request-data.js';
import { changeRequestDiffSlice } from '../src/task-change-request-diff.js';
import { changeRequestFileContents } from '../src/task-change-request-file-contents.js';
import { checkoutReference, resolveCheckout, checkoutGitPlan, performCheckout } from '../src/task-change-request-checkout-git.js';
import { taskGit } from '../src/git-process.js';
import { repositoryPublishInput, validatePublishAccount } from '../src/task-repository-publish.js';
import type { AdditionalSourceControlKind } from '../src/source-control-provider-identity.js';
import { SourceControlCredentials } from '../src/source-control-credentials.js';

const head = 'a'.repeat(40), base = 'b'.repeat(40), token = 'synthetic-private-token';
const output = (value: unknown, stderr = '') => ({ code: 0, stdout: JSON.stringify(value), stderr, digest: '' });
function fixture(provider: AdditionalSourceControlKind) {
  const remote = provider === 'forgejo' ? 'https://forge.example/team/owner/repo' : provider === 'gitcafe' ? 'https://git.cafe/owner/repo' : 'https://dev.azure.com/Org/My%20Project/_git/repo';
  const url = remote + (provider === 'azure-devops' ? '/pullrequest/17' : '/pulls/17');
  const state = { writes: [] as string[], reads: [] as string[], fail: false, failAccount: false, stack: false };
  const raw = provider === 'forgejo' ? { number: 17, title: 'Feature', html_url: url, state: 'open', body: 'private body', user: { login: 'author' }, head: { ref: 'feature', sha: head, repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: base }, merge_base: base }
    : provider === 'gitcafe' ? { id: 'pr-17', number: 17, title: 'Feature', state: 'open', description: 'private body', sourceBranch: 'feature', targetBranch: 'main', sourceRepo: { owner: 'owner', name: 'repo' }, headOid: head, version: 3, draft: false, capabilities: { comment: true, edit: true, review: true, merge: true, moderate: false } }
    : { pullRequestId: 17, title: 'Feature', description: 'private body', status: 'active', sourceRefName: 'refs/heads/feature', targetRefName: 'refs/heads/main', repository: { name: 'repo', remoteUrl: remote, project: { name: 'My Project' } }, lastMergeSourceCommit: { commitId: head }, createdBy: { displayName: 'author' } };
  const handle = (path: string, method: string): unknown => {
    state.reads.push(path);
    if (method !== 'GET') { state.writes.push(path); if (state.fail) throw new Error('Synthetic ambiguous write'); return provider === 'gitcafe' ? { id: 'comment-99' } : { id: 99 }; }
    if (path === 'user') return { login: 'viewer', id: 1 };
    const parsed = new URL(path, 'https://fixture/'), route = parsed.pathname.replace(/^\//, '');
    if (route.endsWith('/pulls/17/stack')) return {stack:state.stack?{id:'stack-9',number:9,revision:2,landingBase:'main',members:[{pullRequestNumber:17,title:'Feature',state:'open',draft:false,sourceBranch:'feature',position:1,headOid:'stale-advertised-head'}]}:null};
    if (route.endsWith('/pulls/17')) return raw;
    if (route.endsWith('/pulls') || route.endsWith('/pulls/')) return provider === 'forgejo' ? [raw] : { items: [raw], next: null };
    if (route.endsWith('/pulls/17/status')) return { merge: { permitted: true, strategies: ['merge', 'squash'] } };
    if (route.endsWith('/pulls/17/changes')) return { version: 3, headOid: head, comparisonBaseOid: base, items: [], next: null };
    if (route === 'repos/owner/repo') return { full_name: 'owner/repo', default_branch: 'main', defaultBranch: 'main', permissions: { push: true } };
    return provider === 'forgejo' ? [] : { items: [], next: null };
  };
  const options: SourceControlConnectionOptions = { changeRequestSyncIntervalMs: 0,
    environment: { CAFE_TOKEN: token }, command: name => name === (provider === 'forgejo' ? 'tea' : provider === 'gitcafe' ? 'cafe' : 'az') ? '/synthetic/' + name : null,
    request: async (address, init) => { const target = new URL(String(address)); assert.equal(target.host, 'git.cafe'); assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ' + token); return new Response(JSON.stringify(handle(target.pathname.replace(/^\/api\//, '') + target.search, init?.method ?? 'GET'))); },
    execute: async (_cwd, _command, args, opts) => {
      if (args[0] === 'login') return output([{ name: 'mounted', url: 'https://forge.example/team', user: 'viewer', default: 'true' }]);
      if (args[0] === 'api') { const target = new URL(args.at(-1)!); assert.equal(target.origin + '/team/api/v1/', 'https://forge.example/team/api/v1/'); const path = target.pathname.replace('/team/api/v1/', '') + target.search; return output(handle(path, args[args.indexOf('--method') + 1]), 'HTTP/1.1 200 OK\nLink: <unused>; rel="last"'); }
      if (args.includes('auth') && args.includes('status')) return output({ schemaVersion: 1, data: { username: state.failAccount ? 'changed' : 'viewer' } });
      if (args[0] === 'account') return output({ name: state.failAccount ? 'changed@example.com' : 'viewer@example.com' });
      if (args[0] === 'repos' && args[1] === 'show') return output({ remoteUrl: remote, defaultBranch: 'refs/heads/main' });
      if (args[0] === 'repos' && args[1] === 'pr') {
        if (args[2] === 'show') return output(raw);
        if (args[2] === 'list') return output([raw]);
        state.writes.push(args[2]!); if (state.fail) throw new Error('Synthetic ambiguous write'); return output(raw);
      }
      const resource = args[args.indexOf('--resource') + 1];
      if (resource === 'pullRequestIterations') return output({ value: [{ id: 3, sourceRefCommit: { commitId: head }, commonRefCommit: { commitId: base } }] });
      if (resource === 'pullRequestIterationChanges') return output({ changeEntries: [], nextSkip: 0 });
      if (resource === 'pullRequestThreads') return output({ value: [] });
      throw new Error('Unexpected provider invocation: ' + args.slice(0, 3).join(' '));
    },
  };
  return { remote, url, options, state, raw };
}

for (const provider of ['forgejo', 'gitcafe', 'azure-devops'] as const) test(`${provider}: public repository, pinned reads, capabilities and diff dispatch never enter another platform protocol`, async t => {
  const f = fixture(provider), connections = new SourceControlConnections(undefined, f.options); t.after(() => connections.close());
  const repository = (await connections.repository('/tmp', f.remote))!; assert.equal(repository.provider, provider);
  const pinned = await pinTaskChangeRequest('/tmp', repository, connections);
  assert.equal((await readTaskChangeRequest(pinned, repository, 17)).url, f.url);
  assert.equal((await findTaskChangeRequest(pinned, repository, 'feature'))?.number, 17);
  assert.equal(await taskRepositoryDefaultBranch(pinned, repository), 'main');
  const detail = await changeRequestDetail(pinned, repository, 17); assert.equal(detail.headSha, head); assert.equal(detail.capabilities?.inlineReviews, provider === 'forgejo');
  const diff = await changeRequestDiffSlice(pinned, repository, 17, { head }); assert.equal(diff.requestHeadSha, head); assert.equal(diff.scopeCommit, null);
  await assert.rejects(pinned.json('repositories/owner/repo/pullrequests/17'), /专用/);
  if (provider === 'gitcafe') await assert.rejects(changeRequestFileContents(pinned, repository, 17, { path: 'a.txt', head, side: 'new' }), /不支持/);
  assert.equal(checkoutReference(f.url, repository).number, 17);
  assert.throws(() => checkoutReference(f.url.replace('/17', '/18').replace('/owner/repo', '/foreign/repo').replace('/_git/repo', '/_git/foreign'), repository));
  assert.equal(f.state.writes.length, 0);
});

for (const provider of ['forgejo', 'gitcafe', 'azure-devops'] as const) test(`${provider}: actual task operations keep Durable receipts and never replay an uncertain provider write`, async t => {
  const f = fixture(provider), directory = await mkdtemp(join(tmpdir(), 'friday-provider-bridge-')), cwd = join(directory, 'repo'), data = join(directory, 'data'); await mkdir(cwd);
  const executor = { async run() { return 'Done'; }, async answer() {}, async steer() {} };
  let engine = await new Engine(data, executor, undefined, f.options).open(); t.after(async () => { await engine.close(); await rm(directory, { recursive: true, force: true }); });
  await engine.mutate(state => state.projects.push({ id: 'project', name: 'Fixture', path: cwd, context: '' }));
  const taskID = await engine.createTask({ prompt: 'Fixture', projectId: 'project', agent: 'codex', mode: 'code', requestId: 'task' });
  const repository = (await engine.sourceControl.repository(cwd, f.remote))!, pinned = await pinTaskChangeRequest(cwd, repository, engine.sourceControl), pr = await readTaskChangeRequest(pinned, repository, 17);
  await engine.changeRequestLinks.change(taskID, {requestId: 'fixture-link', reference: pr.url, expectedRevision: 0}, true); await rm(cwd, { recursive: true });
  assert.equal((await engine.changeRequests.detail(taskID, f.url)).pullRequest.provider, provider);
  assert.equal((await engine.changeRequests.activity(taskID, f.url)).truncated, false);
  const submission = { requestId: 'write', url: f.url, expectedHeadSha: head, ...(provider === 'azure-devops' ? { action: 'close' } : { action: 'comment', body: 'literal $(data)\n中文' }) };
  f.state.fail = true; const operationID = await engine.changeRequests.start(taskID, submission);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const op = (await engine.snapshot()).tasks.find(value => value.id === taskID)?.changeRequestOperations?.find(value => value.id === operationID); if (op && !['queued', 'running'].includes(op.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  const operation = (await engine.snapshot()).tasks.find(value => value.id === taskID)!.changeRequestOperations!.find(value => value.id === operationID)!;
  assert.equal(operation.status, 'interrupted'); assert.equal(f.state.writes.length, 1);
  await engine.close(); engine = await new Engine(data, executor, undefined, f.options).open();
  assert.equal(await engine.changeRequests.start(taskID, submission), operationID); assert.equal(f.state.writes.length, 1);
  const projected = JSON.stringify(await engine.snapshot()); assert(!projected.includes(token)); assert(!projected.includes('private body')); assert(!projected.includes('literal $(data)'));
});

test('Publishing binds Forgejo mounts and Azure organization/project, and requires the observed credential', async t => {
  const f = fixture('azure-devops'), connections = new SourceControlConnections(undefined, f.options); t.after(() => connections.close());
  const provider = (await connections.discover('/tmp')).find(value => value.provider === 'azure-devops')!;
  const input = repositoryPublishInput({ provider: 'azure-devops', repository: 'Org/My Project/repo', account: provider.account, credentialFingerprint: provider.credentialFingerprint, visibility: 'private', protocol: 'https' });
  await validatePublishAccount('/tmp', input, undefined, connections); f.state.failAccount = true;
  await assert.rejects(validatePublishAccount('/tmp', input, undefined, connections), /改变|重新确认/);
  assert.throws(() => repositoryPublishInput({ ...input, credentialFingerprint: undefined }), /凭据/);
  assert.throws(() => repositoryPublishInput({ ...input, provider: 'forgejo', repository: 'owner/repo', baseURL: 'https://forge.example/team?token=bad' }), /服务地址/);
  assert.equal(sourceControlRepository('https://dev.azure.com/Org/My%20Project/_git/repo')?.additional?.project, 'My Project');
});

test('Saved GitCafe tokens use the private credential store, with versioned reset and no secret in settings', async t => {
  const f=fixture('gitcafe'),directory=await mkdtemp(join(tmpdir(),'friday-cafe-credentials-')),credentials=new SourceControlCredentials(directory);
  const connections=new SourceControlConnections(credentials,{...f.options,environment:{CAFE_TOKEN:'different-environment-token'}});t.after(async()=>{await connections.close();await rm(directory,{recursive:true,force:true});});
  const saved=await credentials.update({version:0,requestId:'save',gitCafeToken:token});assert.equal(saved.gitcafe.hasToken,true);assert(!JSON.stringify(saved).includes(token));
  const repository=(await connections.repository(directory,f.remote))!,pinned=await pinTaskChangeRequest(directory,repository,connections);assert.equal(pinned.source,'settings');await readTaskChangeRequest(pinned,repository,17);
  await assert.rejects(credentials.update({version:0,requestId:'stale',gitCafeToken:''}),/修改/);
  const reset=await credentials.update({version:1,requestId:'reset',gitCafeToken:''});assert.equal(reset.gitcafe.hasToken,false);assert.equal(await credentials.gitCafeToken(),undefined);
});

for(const action of ['merge','update-branch'] as const)test(`GitCafe ${action}: stack revisions enter the existing Durable lane and uncertain writes never repeat`,async t=>{
  const f=fixture('gitcafe');f.state.stack=true;f.state.fail=true;
  const directory=await mkdtemp(join(tmpdir(),'friday-cafe-stack-')),cwd=join(directory,'repo'),data=join(directory,'data');await mkdir(cwd);
  const executor={async run(){return 'Done';},async answer(){},async steer(){}};let engine=await new Engine(data,executor,undefined,f.options).open();t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  await engine.mutate(state=>state.projects.push({id:'project',name:'Fixture',path:cwd,context:''}));const taskID=await engine.createTask({prompt:'Fixture',projectId:'project',agent:'codex',mode:'code',requestId:'task'});
  const repository=(await engine.sourceControl.repository(cwd,f.remote))!,pinned=await pinTaskChangeRequest(cwd,repository,engine.sourceControl);await engine.changeRequestLinks.change(taskID,{requestId:'fixture-link',reference:(await readTaskChangeRequest(pinned,repository,17)).url,expectedRevision:0},true);
  const stack=await engine.changeRequestStacks.get(taskID,f.url);assert.equal(stack.stack?.layers[0]?.headSha,head);
  const submission={requestId:'stack-write',url:f.url,action,stackNumber:9,targetNumber:17,expectedStackHeads:[{number:17,headSha:head}],mergeMethod:'merge'};
  const operationID=await engine.changeRequestStacks.start(taskID,submission);const deadline=Date.now()+8000;
  while(Date.now()<deadline){const op=(await engine.snapshot()).tasks.find(value=>value.id===taskID)?.changeRequestOperations?.find(value=>value.id===operationID);if(op&&!['queued','running'].includes(op.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  const op=(await engine.snapshot()).tasks.find(value=>value.id===taskID)!.changeRequestOperations!.find(value=>value.id===operationID)!;assert.equal(op.status,'interrupted');assert.deepEqual(f.state.writes,[`repos/owner/repo/pulls/stacks/9/${action==='merge'?'land-through':'restack'}`]);
  await engine.close();engine=await new Engine(data,executor,undefined,f.options).open();assert.equal(await engine.changeRequestStacks.start(taskID,submission),operationID);assert.equal(f.state.writes.length,1);
});

for(const provider of ['forgejo','gitcafe','azure-devops'] as const)test(`${provider}: captured PR heads use the real local checkout lane and preserve the target branch`,async t=>{
  const f=fixture(provider),directory=await mkdtemp(join(tmpdir(),'friday-provider-checkout-')),cwd=join(directory,'repo'),data=join(directory,'data'),bare=join(directory,'remote.git');await mkdir(cwd);await mkdir(data);
  const git=async(args:string[])=>(await taskGit(cwd,args)).stdout.trim();
  await git(['init','--initial-branch=main']);await git(['config','user.name','Fixture']);await git(['config','user.email','fixture@example.invalid']);
  await writeFile(join(cwd,'file.txt'),'base\n');await git(['add','file.txt']);await git(['commit','-m','Base']);const original=await git(['rev-parse','HEAD']);
  await git(['checkout','-b','feature']);await writeFile(join(cwd,'file.txt'),'feature\n');await git(['commit','-am','Feature']);const expected=await git(['rev-parse','HEAD']);
  await git(['init','--bare','--initial-branch=main',bare]);await git(['remote','add','origin',f.remote]);await git(['config',`url.${bare}.insteadOf`,f.remote]);await git(['push','origin','main','feature']);await git(['checkout','main']);await git(['branch','-D','feature']);
  const execute=f.options.execute!,request=f.options.request!;
  f.options.execute=async(...args)=>{const value=await execute(...args);return {...value,stdout:value.stdout.replaceAll(head,expected)};};
  f.options.request=async(...args)=>{const value=await request(...args);return new Response((await value.text()).replaceAll(head,expected),{status:value.status,headers:value.headers});};
  const connections=new SourceControlConnections(undefined,f.options);t.after(async()=>{await connections.close();await rm(directory,{recursive:true,force:true});});
  const resolution=await resolveCheckout(cwd,f.url,connections,data);assert.equal(resolution.headSha,expected);assert.equal(resolution.headRepository?.provider,provider);
  const plan=await checkoutGitPlan(resolution,'checkout',data,'checkout-'+provider),pinned=await pinTaskChangeRequest(cwd,resolution.authority.repository,connections);
  await performCheckout(resolution,plan,pinned,'checkout-'+provider,false);
  assert.equal(await git(['rev-parse','HEAD']),expected);assert.equal(await git(['rev-parse','refs/heads/main']),original);assert.equal(await git(['status','--porcelain']),'');
});


for(const provider of ['forgejo','gitcafe','azure-devops'] as const)test(`${provider}: all-state branch lookup returns terminal timestamps without exposing response bodies`,async t=>{
 const f=fixture(provider),stamp='2026-10-20T00:00:00Z';
 Object.assign(f.raw,provider==='forgejo'?{state:'closed',merged:true,merged_at:stamp,updated_at:stamp}:provider==='gitcafe'?{state:'merged',mergedAt:stamp,updatedAt:stamp}:{status:'completed',closedDate:stamp});
 const connections=new SourceControlConnections(undefined,f.options);t.after(()=>connections.close());const repository=(await connections.repository('/fixture',f.remote))!,pinned=await pinTaskChangeRequest('/fixture',repository,connections);
 assert.equal(await findTaskChangeRequest(pinned,repository,'feature'),null);
 const found=await findTaskChangeRequest(pinned,repository,'feature',undefined,{source:repository,includeTerminal:true});assert.equal(found?.state,'merged');assert.equal(found?.snapshot?.mergedAt,stamp);assert(!JSON.stringify(found).includes('private body'));
});
