import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { linkTaskChangeRequest, unlinkTaskChangeRequest, parseChangeRequestLink } from '../src/task-change-request-links.js';
import { taskPullRequests } from '../src/task-pull-requests.js';
import type { TaskPullRequest, WorkItem } from '../src/types.js';
const url = 'https://github.com/Owner/Repo/pull/17', now = '2026-10-20T08:00:00Z', sha = 'a'.repeat(40);
const pr = (n = 17): TaskPullRequest => ({ number: n, url: url.replace('/17', '/' + n), title: 'PR ' + n, state: 'open', base: 'main', head: 'feature/' + n, provider: 'github', host: 'github.com', repository: 'Owner/Repo' });
const task = (): WorkItem => ({ id:'task', projectId:'p', cwd:'/fixture', title:'Task', prompt:'Task', agent:'codex', mode:'code', status:'completed', createdAt:now, updatedAt:now, threadId:'session', turnId:null, durableId:null, result:'', error:null, events:[], approvals:[], artifact:null, lastRequestId:'task' });
test('Link parsing preserves six platform authorities and canonical roots, treating shell-like input as data', () => {
 for (const input of [url + '/files#diff-1', 'https://gitlab.example/group/sub/repo/-/merge_requests/17?x=1', 'https://bitbucket.org/owner/repo/pull-requests/17', 'http://forge.example:8080/mount/owner/repo/pulls/17', 'https://git.cafe/owner/repo/pulls/17', 'https://dev.azure.com/Org/Project/_git/Repo/pullrequest/17']) { const p = parseChangeRequestLink(input); assert(p); assert.equal(p.number,17); assert(!p.url.includes('?')); assert(!p.url.includes('#')); }
 for (const input of ['https://user:secret@github.com/a/b/pull/1', 'file:///tmp/pull/17', 'https://github.com/a/b/pull/0', 'https://github.com/a/b/pull/9007199254740992', 'gh pr checkout 17; touch /tmp/unsafe', 'https://bitbucket.foreign/a/b/pull-requests/17']) assert.equal(parseChangeRequestLink(input),undefined,input);
});
test('Explicit empty links suppress legacy operation fallbacks and canonical duplicates never replace the original source', () => {
 const t = task(); t.gitOperation = { pullRequest:pr() } as WorkItem['gitOperation'];
 assert.equal(taskPullRequests(t).length,1); assert(unlinkTaskChangeRequest(t,pr(),'2026-10-20T09:00:00Z')); assert.equal(taskPullRequests(t).length,0); assert.equal(t.changeRequests?.length,0);
 assert(linkTaskChangeRequest(t,pr(),'manual',now)); const linkedAt = t.changeRequests![0].linkedAt;
 assert.equal(linkTaskChangeRequest(t,{...pr(),url:url.toLowerCase(),repository:'owner/repo'},'agent','later'),false);
 assert.equal(t.changeRequests![0].linkedAt,linkedAt); assert.equal(t.changeRequests![0].linkSource,'manual');
});
test('Unlinking a native stack member creates a hidden tombstone that only an explicit non-stack link can restore', () => {
 const t = task(); linkTaskChangeRequest(t,pr(),'manual',now); linkTaskChangeRequest(t,pr(18),'stack',now);
 t.changeRequestStacks = {[url]:{id:'stack',number:7,url:'https://github.com/Owner/Repo/stacks/7',base:'main',syncedAt:now,layers:[{number:17,headBranch:'lower',state:'open'},{number:18,headBranch:'upper',state:'open'}]}};
 assert(unlinkTaskChangeRequest(t,pr(),now)); assert.equal(taskPullRequests(t).length,1); assert.equal(t.changeRequests?.find(p=>p.number===17)?.linkSource,'stack-dismissed');
 assert.equal(linkTaskChangeRequest(t,pr(),'stack',now),false); assert(linkTaskChangeRequest(t,pr(),'manual','2026-10-21T00:00:00Z')); assert.equal(taskPullRequests(t).length,2); assert.equal(t.changeRequests?.find(p=>p.number===17)?.linkedAt,now);
});
test('The first manual link preserves a different current-branch PR, and more than forty explicit links remain associated', () => {
 const t=task(); t.branchPullRequest=pr(); linkTaskChangeRequest(t,pr(18),'manual',now); assert.deepEqual(taskPullRequests(t).map(p=>p.number),[17,18]);
 for(let n=19;n<70;n++)linkTaskChangeRequest(t,pr(n),'manual',now); assert.equal(taskPullRequests(t).length,53);
});
async function fixture(t: {after(callback:()=>Promise<unknown>):void}) {
 const directory=await mkdtemp(join(tmpdir(),'friday-pr-links-')),cwd=join(directory,'repo'),data=join(directory,'data');await mkdir(cwd);
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 execFileSync('git',['init','-q','--initial-branch=main'],{cwd,env});execFileSync('git',['remote','add','origin','https://github.com/Owner/Repo.git'],{cwd,env});
 const environment={GH_TOKEN:'synthetic-link-a'},reads:string[]=[];
 const options={environment,changeRequestSyncIntervalMs:0,command:()=>null,request:async(input:any,init?:RequestInit)=>{const u=new URL(String(input));reads.push(u.pathname);if(u.pathname==='/graphql')return Response.json({data:{viewer:{login:'reviewer'},repository:{viewerPermission:'WRITE',pullRequest:{id:'node',viewerCanUpdate:true}}}});if(u.pathname.endsWith('/check-runs'))return Response.json({check_runs:[]});if(u.pathname.endsWith('/status'))return Response.json({statuses:[]});return Response.json({number:17,title:'Host metadata',html_url:url,state:'open',head:{ref:'feature/17',sha},base:{ref:'main',sha:'b'.repeat(40)},body:'PRIVATE DESCRIPTION',updated_at:now,user:{login:'author'}});}};
 const executor={async run(){return 'Done';},async answer(){},async steer(){}};let engine=await new Engine(data,executor,undefined,options).open();const auth=new Auth(data);
 await engine.mutate(s=>{s.projects=[{id:'p',name:'Project',path:cwd,context:''}];s.tasks=[{...task(),cwd}];s.taskSettlementSettings={version:0,defaults:{sidebarAutoSettleAfterDays:null,sidebarAutoSettleOnMerge:false},projects:{}};});
 let api=createAPI(engine,auth);const headers={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'};
 t.after(async()=>{auth.close();await engine.close();await rm(directory,{recursive:true,force:true});});
 return {get engine(){return engine;},get api(){return api;},headers,environment,reads,cwd,
  post:(action:string,body:unknown,authenticated=true)=>api.request('/api/tasks/task/change-request/'+action,{method:'POST',headers:authenticated?headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),
  reopen:async()=>{await engine.close();engine=await new Engine(data,executor,undefined,options).open();api=createAPI(engine,auth);}};
}
test('Authenticated link mutations use CAS and atomic idempotency receipts, preserve explicit unlink across restart and never call a host', async t=>{
 const f=await fixture(t),body={requestId:'link',reference:url,expectedRevision:0};
 assert.equal((await f.post('link',body,false)).status,401);assert.equal((await f.post('link',body)).status,200);assert.equal(f.reads.length,0);
 const linkedAt=(await f.engine.snapshot()).tasks[0].updatedAt;assert.notEqual(linkedAt,now);
 assert.equal((await f.post('link',body)).status,200);assert.equal((await f.engine.changeRequestLinks.list('task')).revision,1);
 assert.equal((await f.engine.snapshot()).tasks[0].updatedAt,linkedAt,'Acknowledged retries preserve activity time');
 assert.equal((await f.post('link',{...body,requestId:'stale',reference:url.replace('/17','/18')})).status,409);
 assert.equal((await f.post('unlink',{requestId:'unlink',reference:url,expectedRevision:1})).status,200);await f.reopen();assert.deepEqual((await f.engine.changeRequestLinks.list('task')).links,[]);
 assert.equal((await f.post('link',body)).status,200);assert.deepEqual((await f.engine.changeRequestLinks.list('task')).links,[],'Retrying an old acknowledged link cannot undo a later unlink');
 assert.equal((await f.post('link',{...body,reference:url.replace('/17','/19')})).status,400);
 const overview=await(await f.api.request('/api/overview',{headers:f.headers})).json();assert.equal(overview.changeRequestLinkRequests,undefined);assert(!JSON.stringify(overview).includes('synthetic-link'));
});
test('Bare numbers resolve from the project repository; full cross-repository links do not require a local worktree or credentials',async t=>{
 const f=await fixture(t);const reference=await f.engine.changeRequestLinks.reference('task','#17');assert.equal(reference.url,url);
 assert.equal((await f.post('link',{requestId:'number',reference:'gh pr checkout #17',expectedRevision:0})).status,200);
 await rm(f.cwd,{recursive:true,force:true});f.environment.GH_TOKEN='';
 assert.equal((await f.post('link',{requestId:'other',reference:'https://github.com/Other/Another/pull/3',expectedRevision:1})).status,200);assert.equal(f.reads.length,0);
});
test('An explicit view grant allows an unlinked PR without relinking it and stays bound to the credential that opened it',async t=>{
 const f=await fixture(t);await f.post('link',{requestId:'link',reference:url,expectedRevision:0});assert.equal((await f.post('open',{reference:url})).status,200);
 await f.post('unlink',{requestId:'unlink',reference:url,expectedRevision:1});
 const detail=await f.engine.changeRequests.detail('task',url);assert.equal(detail.body,'PRIVATE DESCRIPTION');assert.equal((await f.engine.changeRequestLinks.list('task')).links.length,0);
 const reads=f.reads.length;f.environment.GH_TOKEN='synthetic-link-b';await assert.rejects(f.engine.changeRequests.detail('task',url),/凭据已改变/);assert.equal(f.reads.length,reads);
});


test('Viewing a PR on a task with no link history never creates an implicit association',async t=>{
 const f=await fixture(t);assert.equal((await f.post('open',{reference:url})).status,200);await f.engine.changeRequests.detail('task',url);assert.deepEqual((await f.engine.changeRequestLinks.list('task')).links,[]);
});
