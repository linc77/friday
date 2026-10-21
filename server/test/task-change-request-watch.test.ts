import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Engine } from '../src/engine.js';
import { TaskChangeRequestWatch } from '../src/task-change-request-watch.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { taskChangeRequestList } from '../src/task-change-request-list.js';
import { SourceControlRequestPolicy } from '../src/source-control-request-policy.js';
import { taskSidebarActivity } from '../src/task-sidebar-activity.js';
import type { ExecutionRequest } from '../src/types.js';
const url='https://github.com/owner/repo/pull/17',sha='a'.repeat(40);
async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean){const end=Date.now()+5000;while(Date.now()<end){const v=await read();if(ready(v))return v;await new Promise(r=>setTimeout(r,5));}throw new Error('watch fixture timed out');}
async function fixture(t:{after(callback:()=>Promise<unknown>):void},resident=false){
 const dir=await mkdtemp(join(tmpdir(),'friday-pr-watch-')),cwd=join(dir,'repo'),data=join(dir,'data');await mkdir(cwd);let clock=Date.now();
 const state={checks:[] as {name:string;status:string;required?:boolean}[],comments:[] as any[],calls:[] as ExecutionRequest[],reads:[] as string[],fail:false,limited:false,threadMode:'none',fp:true,remote:'open',gate:undefined as ((signal?:AbortSignal|null)=>Promise<void>)|undefined};
 const options={policy:new SourceControlRequestPolicy(()=>clock),environment:{GH_TOKEN:'synthetic-watch-token'},changeRequestSyncIntervalMs:0,changeRequestWatchIntervalMs:resident?15:0,command:()=>null,request:async(input:any,init?:RequestInit)=>{
  const u=new URL(String(input));assert.equal(u.host,'api.github.com');state.reads.push(u.pathname);if(state.limited)return new Response('{}',{status:429,headers:{'Retry-After':'60'}});if(state.fail)throw new TypeError('Synthetic unreadable host');
  if(u.pathname==='/graphql'){
   const q=JSON.parse(String(init?.body)).query;
   if(q.includes('FridayWatchFingerprint'))return Response.json({data:{repository:{pullRequest:state.fp?{state:state.remote,mergeable:'MERGEABLE',headRefOid:sha,comments:{totalCount:state.comments.length,nodes:state.comments.map(v=>({lastEditedAt:v.updated_at}))},reviews:{totalCount:0,nodes:[]},reviewThreads:{totalCount:state.threadMode==='none'?0:1},commits:{nodes:[{commit:{statusCheckRollup:{contexts:{checkRunCountsByState:state.checks.map(v=>({state:v.status,count:1})),statusContextCountsByState:[]}}}}]}}:null}}});
   if(q.includes('FridayWatchChecks'))return Response.json({data:{repository:{pullRequest:{headRefOid:sha,commits:{nodes:[{commit:{statusCheckRollup:{contexts:{nodes:state.checks.map(v=>({name:v.name,status:'COMPLETED',conclusion:v.status,isRequired:v.required})),pageInfo:{hasNextPage:false}}}}}]}}}}});
   if(q.includes('FridayThreadComments'))return Response.json({data:{repository:{pullRequest:{id:'node'}},node:{id:'thread',pullRequest:{id:'node'},comments:{totalCount:2,pageInfo:{hasNextPage:false},nodes:state.threadMode==='complete'?[{id:'tail',body:'Late thread reply',author:{login:'reviewer'},createdAt:new Date(clock+1000).toISOString()}]:[]}}}});
   if(q.includes('FridayReviewThreads'))return Response.json({data:{viewer:{login:'agent-user'},repository:{pullRequest:{reviewThreads:{nodes:state.threadMode==='none'?[]:[{id:'thread',path:'a.ts',line:1,diffSide:'RIGHT',isResolved:false,isOutdated:false,comments:{totalCount:2,pageInfo:{hasNextPage:true,endCursor:'tail-cursor'},nodes:[{id:'own',body:'Own reply',author:{login:'agent-user'},createdAt:new Date(clock-1000).toISOString()}]}}],pageInfo:{hasNextPage:false}},comments:{nodes:[]},reviews:{nodes:[]}}}}});
   if(q.includes('FridayTimelineCommits'))return Response.json({data:{repository:{pullRequest:{commits:{nodes:[],pageInfo:{hasPreviousPage:false}},reviewDismissals:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
   return Response.json({data:{viewer:{login:'agent-user'},repository:{viewerPermission:'WRITE',pullRequest:{id:'node',viewerCanUpdate:true,headRefOid:sha,mergeStateStatus:'CLEAN',isCrossRepository:false}}}});
  }
  if(u.pathname.endsWith('/pulls/17')){await state.gate?.(init?.signal);return Response.json({number:17,html_url:url,title:'Change',state:state.remote==='merged'?'closed':state.remote,merged:state.remote==='merged',merged_at:state.remote==='merged'?new Date(clock).toISOString():null,head:{ref:'feature',sha},base:{ref:'main',sha:'b'.repeat(40)},user:{login:'agent-user'},updated_at:new Date(clock).toISOString(),mergeable_state:'clean'});}
  if(u.pathname.endsWith('/check-runs'))return Response.json({check_runs:[]});
  if(u.pathname.endsWith('/status'))return Response.json({statuses:[]});
  if(u.pathname.endsWith('/issues/17/comments'))return Response.json(state.comments);
  if(u.pathname.endsWith('/reviews'))return Response.json([]);
  throw new Error('Unexpected synthetic watch endpoint');
 }};
 const executor={async run(request:ExecutionRequest){state.calls.push(request);await request.update({kind:'session',threadId:request.task.threadId??'native-session'});await request.update({kind:'turn',turnId:'turn-'+state.calls.length});return 'Done';},async answer(){},async steer(){}};
 let engine=await new Engine(data,executor,undefined,options).open();await engine.mutate(s=>{s.projects=[{id:'p',name:'Project',path:cwd,context:''}];s.taskSettlementSettings={version:0,defaults:{sidebarAutoSettleAfterDays:null,sidebarAutoSettleOnMerge:false},projects:{}};});
 const id=await engine.createTask({projectId:'p',prompt:'Human request',agent:'codex',mode:'code',requestId:'initial'});await until(()=>engine.snapshot(),s=>s.tasks[0]?.status==='completed');
 await engine.changeRequestLinks.change(id,{requestId:'link',reference:url,expectedRevision:0},true);
 let worker=resident?engine.changeRequestWatch:new TaskChangeRequestWatch(engine,60000,()=>clock);let command=0;
 const watch=async(watching=true)=>worker.change(id,{requestId:'watch-'+command++,reference:url,watching,expectedRevision:(await engine.changeRequestLinks.list(id)).revision});
 t.after(async()=>{await worker.close();await engine.close();await rm(dir,{recursive:true,force:true});});
 return {id,state,dir,data,cwd,get engine(){return engine;},get worker(){return worker;},watch,advance:()=>{clock+=120000;},
 start:async()=>{await watch();worker.start();await worker.drain();},poll:async()=>{clock+=120000;worker.poll();await worker.drain();},done:async(count:number)=>until(()=>engine.snapshot(),s=>state.calls.length>=count&&s.tasks[0]?.status==='completed'),
 reopen:async()=>{await worker.close();await engine.close();options.policy=new SourceControlRequestPolicy(()=>clock);engine=await new Engine(data,executor,undefined,options).open();worker=resident?engine.changeRequestWatch:new TaskChangeRequestWatch(engine,60000,()=>clock);}};
}

test('A host change wakes the same native task once, persists the watermark and does not become human-authored activity',async t=>{
 const f=await fixture(t),original=(await f.engine.snapshot()).tasks[0],authored=taskSidebarActivity(original).latestUserAuthoredMessageAt;f.state.checks=[{name:'build',status:'FAILURE',required:true}];await f.start();await f.done(2);
 let task=(await f.engine.snapshot()).tasks[0];assert.equal(task.id,f.id);assert.equal(task.threadId,original.threadId);assert.equal(task.queue?.messages.length,1);assert.equal(task.messages?.find(m=>m.creationSource==='monitor')?.notification?.outcome,'failed');assert.equal(taskSidebarActivity(task).latestUserAuthoredMessageAt,authored);assert.match(f.state.calls[1].prompt,/Checks failed/);
 const reads=f.state.reads.length;await f.poll();assert.equal(f.state.calls.length,2);assert(f.state.reads.length-reads<=1,'A quiet host fingerprint avoids detail and discussion reads');
 await f.reopen();f.worker.start();await f.worker.drain();assert.equal(f.state.calls.length,2,'A restart cannot report the same CI failure twice');
 f.state.checks=[{name:'build',status:'SUCCESS',required:true},{name:'advisory',status:'IN_PROGRESS'}];await f.poll();await f.done(3);assert.match(f.state.calls[2].prompt,/required check passed/);
});

test('Stopping or restarting a watch during a host read rejects its late update and explicit retry cannot restore an old watch',async t=>{
 const f=await fixture(t);await f.start();let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{began=r;}),wait=new Promise<void>(r=>{release=r;});f.state.gate=async()=>{began();await wait;};f.state.checks=[{name:'build',status:'FAILURE'}];
 f.worker.poll();const drain=f.worker.drain();await started;await f.watch(false);const stopped=(await f.engine.changeRequestLinks.list(f.id)).links[0];assert(!stopped.watch);assert(stopped.endedWatch);release();await drain;assert.equal(f.state.calls.length,1);assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
 f.state.gate=undefined;await f.watch();await f.worker.drain();await f.done(2);assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
});

test('Eight consecutive non-rate failures stop the watch and publish exactly one failure wake',async t=>{
 const f=await fixture(t);await f.start();f.state.fail=true;for(let i=0;i<7;i++){await f.poll();assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);}
 await f.poll();await f.done(2);const link=(await f.engine.changeRequestLinks.list(f.id)).links[0];assert(!link.watch&&link.endedWatch);assert.match(f.state.calls[1].prompt,/8 次/);await f.poll();assert.equal(f.state.calls.length,2);
});

test('Merged or settled tasks end their watches quietly, and a closed request emits one final update',async t=>{
 const f=await fixture(t);await f.start();await f.engine.mutate(s=>{s.tasks[0].settledAt=new Date().toISOString();});await f.poll();assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);assert.equal(f.state.calls.length,1);
 await f.engine.mutate(s=>{s.tasks[0].settledAt=null;});await f.watch();f.state.remote='closed';await f.worker.drain();await f.done(2);assert.match(f.state.calls[1].prompt,/已关闭/);assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
 f.state.remote='open';await f.watch();await f.worker.drain();await f.engine.mutate(s=>{s.tasks[0].changeRequests![0].snapshot!.state='merged';});const reads=f.state.reads.length;f.worker.reconcile();await f.worker.drain();assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);assert.equal(f.state.reads.length,reads);assert.equal(f.state.calls.length,2);
});

test('Watch routes authenticate, preserve retry receipts and reject subagents and settled tasks',async t=>{
 const f=await fixture(t),auth=new Auth(f.data);t.after(async()=>auth.close());const api=createAPI(f.engine,auth),body={requestId:'api-watch',reference:url,watching:true,expectedRevision:1},post=(value:unknown,authorized=true)=>api.request('/api/tasks/'+f.id+'/change-request/watch',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+auth.token}:{})},body:JSON.stringify(value)});
 assert.equal((await post(body,false)).status,401);assert.equal((await post(body)).status,200);await f.watch(false);assert.equal((await post(body)).status,200);assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
 await f.engine.mutate(s=>{s.tasks[0].settledAt=new Date().toISOString();});assert.equal((await post({...body,requestId:'settled',expectedRevision:(await f.engine.changeRequestLinks.list(f.id)).revision})).status,400);
 assert.equal((await post({...body,requestId:'invalid',watching:'true'})).status,400);const overview=await(await api.request('/api/overview',{headers:{Authorization:'Bearer '+auth.token}})).json();assert.equal(overview.changeRequestWatchRequests,undefined);
 const childRevision=(await f.engine.changeRequestLinks.list(f.id)).revision;await f.engine.mutate(s=>{s.tasks[0].settledAt=null;s.tasks[0].subagentOrigin={rootTaskId:'parent',parentTaskId:'parent',subagentId:'child',sessionId:'session',threadId:'parent-native',nativeId:'child-native'};});assert.equal((await post({...body,requestId:'child',expectedRevision:childRevision})).status,400);
});

test('A safely queued monitor wake resumes after restart, while a human pause remains held',async t=>{
 const f=await fixture(t);await f.engine.mutate(s=>{s.tasks[0].queue={dispatcherId:null,paused:false,messages:[{id:'saved-monitor',dispatchId:'saved-monitor-dispatch',text:'Saved watch update',images:[],createdAt:new Date().toISOString(),status:'queued',creationSource:'monitor'}]};s.requests['saved-monitor']=f.id;});
 await f.reopen();await f.done(2);assert.equal(f.state.calls.filter(r=>r.prompt.includes('Saved watch update')).length,1);
 await f.engine.mutate(s=>{s.tasks[0].queue!.paused=true;s.tasks[0].queue!.messages.push({id:'human-held-monitor',dispatchId:'human-held-dispatch',text:'Human held update',images:[],createdAt:new Date().toISOString(),status:'queued',creationSource:'monitor'});});
 await f.reopen();assert.equal(f.state.calls.length,2);assert.equal((await f.engine.snapshot()).tasks[0].queue?.paused,true);
});

test('Scoped MCP tools link and watch only their owning task and run, revoke on completion, and never carry the owner token',async t=>{
 const f=await fixture(t);await f.engine.mutate(s=>{s.tasks[0].status='running';s.tasks[0].currentRunId='tool-run';});const task=(await f.engine.snapshot()).tasks[0],controller=new AbortController(),grant=await f.engine.runtimeTools.bind(task,'tool-run',controller.signal);
 let callId=0;const rpc=async(method:string,params:unknown={},id:number|string=++callId,headers=grant.connection.headers)=>{const r=await fetch(grant.connection.url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});return {status:r.status,body:await r.text()};};
 assert.equal((await rpc('tools/list',{},'no-auth',{})).status,401);const init=await rpc('initialize',{protocolVersion:'2025-03-26'});assert.equal(init.status,200);assert.match(init.body,/friday_tasks/);const tools=await rpc('tools/list');assert.match(tools.body,/watch_pull_request/);
 const linked=await rpc('tools/call',{name:'link_pull_request',arguments:{reference:'https://github.com/owner/other/pull/2'}},'same-id');assert.match(linked.body,/"isError":false/);assert.equal((await f.engine.changeRequestLinks.list(f.id)).links.find(p=>p.number===2)?.linkSource,'agent');
 const standard=await rpc('tools/call',{name:'link_pull_request',arguments:{host:'github.com',repository:'owner/repo',number:17,threadId:f.id}});assert.match(standard.body,/alreadyLinked/);assert.match(standard.body,/true/);const listed=await rpc('tools/call',{name:'list_thread_pull_requests',arguments:{threadId:f.id}});assert.match(listed.body,/pullRequests/);assert.match(listed.body,/chains/);const missingStop=await rpc('tools/call',{name:'unwatch_pull_request',arguments:{url:'https://github.com/owner/absent/pull/999'}});assert.match(missingStop.body,/"isError":false/);
 const watched=await rpc('tools/call',{name:'watch_pull_request',arguments:{url}});assert.match(watched.body,/"isError":false/);assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
 assert.match((await rpc('tools/call',{name:'link_pull_request',arguments:{reference:url,taskId:'someone-else'}})).body,/"isError":true/);
 const auth=new Auth(f.data);assert(!JSON.stringify(await f.engine.snapshot()).includes(auth.token));auth.close();assert(!JSON.stringify(await f.engine.snapshot()).includes(grant.connection.headers.Authorization));
 await f.engine.taskQueue.pause(f.id,{runId:'tool-run'});assert.match((await rpc('tools/call',{name:'watch_pull_request',arguments:{reference:url}})).body,/"isError":true/,'A stop intent wins before the external turn has finished aborting');
 await f.engine.mutate(s=>{s.tasks[0].currentRunId='new-run';});assert.match((await rpc('tools/call',{name:'unwatch_pull_request',arguments:{reference:url}})).body,/"isError":true/);grant.release();assert.equal((await rpc('tools/list')).status,401);
});


test('A partial review-thread tail cannot advance the remark watermark and a later complete read wakes exactly once',async t=>{
 const f=await fixture(t);f.state.threadMode='incomplete';await f.start();let link=(await f.engine.changeRequestLinks.list(f.id)).links[0];assert.equal(link.watch?.remarksThrough,link.watch?.startedAt);assert.equal(f.state.calls.length,1);
 f.state.threadMode='complete';await f.poll();await f.done(2);assert.match(f.state.calls[1].prompt,/Late thread reply/);link=(await f.engine.changeRequestLinks.list(f.id)).links[0];assert(link.watch!.remarksThrough>link.watch!.startedAt);await f.poll();assert.equal(f.state.calls.length,2);
});

test('Rate-limit pauses preserve the watch without spending the unreadable-host failure limit',async t=>{
 const f=await fixture(t);await f.start();f.state.limited=true;for(let i=0;i<9;i++)await f.poll();assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);assert.equal(f.state.calls.length,1);f.state.limited=false;await f.poll();assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
});

test('Watches in the same project share a complete host read and wake each owning task independently',async t=>{
 const f=await fixture(t);await f.start();const second=await f.engine.createTask({projectId:'p',prompt:'Other human task',agent:'codex',mode:'code',requestId:'second'});await until(()=>f.engine.snapshot(),s=>s.tasks.find(t=>t.id===second)?.status==='completed');
 await f.engine.changeRequestLinks.change(second,{requestId:'second-link',reference:url,expectedRevision:0},true);await f.worker.change(second,{requestId:'second-watch',reference:url,watching:true,expectedRevision:1});f.state.checks=[{name:'build',status:'FAILURE'}];const reads=f.state.reads.filter(x=>x.endsWith('/pulls/17')).length;await f.poll();await until(()=>f.engine.snapshot(),s=>f.state.calls.length===4&&s.tasks.every(t=>t.status==='completed'));assert.equal(f.state.reads.filter(x=>x.endsWith('/pulls/17')).length-reads,1);assert((await f.engine.snapshot()).tasks.every(t=>t.queue?.messages.length===1));
});


test('Closing a watch worker aborts and drains its complete host read without a late wake',async t=>{
 const f=await fixture(t);await f.start();let began!:()=>void;const started=new Promise<void>(r=>{began=r;});f.state.gate=signal=>{began();return new Promise((_r,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});};f.state.checks=[{name:'build',status:'FAILURE'}];f.worker.poll();const drained=f.worker.drain();await started;await f.worker.close();await drained;assert.equal(f.state.calls.length,1);assert.equal((await f.engine.changeRequestLinks.list(f.id)).links[0].watch?.failedChecks.length,0);
});

test('The ordinary task Stop action clears idle PR watches before any later host update',async t=>{
 const f=await fixture(t);await f.start();const task=(await f.engine.snapshot()).tasks[0];await f.engine.cancel(f.id,{runId:task.currentRunId});assert(!(await f.engine.changeRequestLinks.list(f.id)).links[0].watch);f.state.checks=[{name:'build',status:'FAILURE'}];await f.poll();assert.equal(f.state.calls.length,1);
});


test('MCP link listings preserve native stacks, derived siblings, cycles and hidden members',async t=>{
 const f=await fixture(t),task=(await f.engine.snapshot()).tasks[0],make=(number:number,head:string,base:string)=>({number,url:url.replace('/17','/'+number),provider:'github' as const,host:'github.com',repository:'owner/repo',state:'open' as const,title:'PR '+number,head,base,snapshot:{state:'open' as const,title:'PR '+number,headBranch:head,baseBranch:base,isDraft:false,updatedAt:null,syncedAt:new Date().toISOString(),closedAt:null,mergedAt:null}});
 task.changeRequests=[make(1,'lower','main'),make(2,'upper','lower'),make(3,'sibling','lower'),make(4,'cycle-a','cycle-b'),make(5,'cycle-b','cycle-a')];task.changeRequestLinksRevision=1;let list=taskChangeRequestList(task);assert.deepEqual(list.chains[0],{kind:'derived',numbers:[1,2,3]});assert.deepEqual(list.pullRequests.slice(0,3).map(p=>p.stack?.position),[1,2,2]);assert.equal(list.pullRequests.length,5);
 task.changeRequestStacks={[task.changeRequests[0].url]:{id:'native',number:4,url:'https://github.com/owner/repo/stacks/4',base:'main',syncedAt:new Date().toISOString(),layers:[{number:1,headBranch:'lower',state:'open'},{number:2,headBranch:'upper',state:'open'}]}};task.changeRequests[2].dismissedAt=new Date().toISOString();list=taskChangeRequestList(task);assert.deepEqual(list.chains[0],{kind:'native',numbers:[1,2]});assert.equal(list.pullRequests.length,4);
});


test('The installed MCP SDK can initialize, list and call the actual loopback task tools without a model',async t=>{
 const f=await fixture(t);await f.engine.mutate(s=>{s.tasks[0].status='running';s.tasks[0].currentRunId='sdk-run';});const task=(await f.engine.snapshot()).tasks[0],lease=await f.engine.runtimeTools.bind(task,'sdk-run',new AbortController().signal);t.after(()=>lease.release());
 const require=createRequire(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
 const {Client}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href),{StreamableHTTPClientTransport}=await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href);
 const client=new Client({name:'friday-watch-test',version:'1.0.0'},{capabilities:{}});t.after(()=>client.close());await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url),{requestInit:{headers:lease.connection.headers}}));
 const tools=await client.listTools();assert.equal(tools.tools.length,5);const linked=await client.callTool({name:'link_pull_request',arguments:{url:'https://github.com/owner/other/pull/3'}});assert.equal(linked.isError,false);const listed=await client.callTool({name:'list_thread_pull_requests',arguments:{}});assert.match(JSON.stringify(listed),/alreadyLinked|pullRequests/);const watched=await client.callTool({name:'watch_pull_request',arguments:{url}});assert.equal(watched.isError,false);assert((await f.engine.changeRequestLinks.list(f.id)).links[0].watch);
});


test('The Engine-owned resident timer follows CI changes without a window or a manual poll',async t=>{
 const f=await fixture(t,true);f.state.checks=[{name:'build',status:'FAILURE',required:true}];await f.watch();await f.done(2);f.state.checks=[{name:'build',status:'SUCCESS',required:true}];await f.done(3);assert.match(f.state.calls[2].prompt,/required check passed/);assert.equal((await f.engine.snapshot()).tasks[0].queue?.messages.length,2);
});
