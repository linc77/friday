import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import { TaskChangeRequestDiscovery } from '../src/task-change-request-discovery.js';
import type { WorkItem } from '../src/types.js';
const sha='a'.repeat(40),url='https://github.com/owner/repo/pull/17';
async function fixture(t:{after(callback:()=>Promise<unknown>):void},resident=false){
 const directory=await mkdtemp(join(tmpdir(),'friday-pr-discovery-')),cwd=join(directory,'repo'),data=join(directory,'data');await mkdir(cwd);
 const env={PATH:process.env.PATH,LANG:'en_US.UTF-8',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'};
 const git=(...args:string[])=>execFileSync('git',args,{cwd,env,encoding:'utf8'}).trim();git('init','-q','--initial-branch=main');git('remote','add','origin','https://github.com/owner/repo.git');
 const now=Date.now(),at=(ms:number)=>new Date(now+ms).toISOString();
 const state={reads:[] as string[],pullReads:0,remoteState:'open',updatedAt:at(-1000),beforeRead:undefined as ((signal?:AbortSignal|null)=>Promise<void>)|undefined,fork:false,head:'feature',selector:'owner:feature',limited:false};
 const options={environment:{GH_TOKEN:'synthetic-discovery-token'},changeRequestSyncIntervalMs:resident?60000:0,command:()=>null,request:async(input:any,init?:RequestInit)=>{
  const u=new URL(String(input));assert.equal(u.hostname,'api.github.com');state.reads.push(u.pathname+u.search);
  if(u.pathname.endsWith('/pulls')){state.pullReads++;assert.equal(u.searchParams.get('head'),state.selector);assert.equal(u.searchParams.get('state'),'all');await state.beforeRead?.(init?.signal);if(state.limited)return new Response('{}',{status:429,headers:{'Retry-After':'60'}});
   return Response.json([{number:17,title:'Remote change',html_url:url,state:state.remoteState==='merged'?'closed':state.remoteState,merged:state.remoteState==='merged',merged_at:state.remoteState==='merged'?state.updatedAt:null,closed_at:state.remoteState==='closed'?state.updatedAt:null,updated_at:state.updatedAt,head:{ref:state.head,sha,repo:{full_name:state.fork?'other/repo':'owner/repo'}},base:{ref:'main',sha:'b'.repeat(40)},user:{login:'author'}}]);}
  return Response.json({default_branch:'main'});
 }};
 const engine=await new Engine(data,{async run(){return 'Done';},async answer(){},async steer(){}},undefined,options).open();
 const task=(id:string):WorkItem=>({id,title:id,prompt:'Work',projectId:'p',cwd,agent:'codex',mode:'code',status:'completed',createdAt:at(-10000),updatedAt:at(-4000),result:'Done',error:null,events:[],approvals:[],threadId:'session-'+id,turnId:null,durableId:null,artifact:null,lastRequestId:id,
  executionWorkspace:{mode:'checkout',sourcePath:cwd,root:cwd,cwd,branch:'feature',commit:null,state:'ready'},messages:[{id:'user',role:'user',text:'Work',at:at(-5000)}],runs:[{id:'run',durableId:null,messageId:'user',requestId:'run',cwd,at:at(-5000),completedAt:at(-4000),status:'completed',mode:'code',interactionMode:'default'}]});
 await engine.mutate(s=>{s.projects=[{id:'p',name:'Project',path:cwd,context:''}];s.tasks=[task('a'),task('b')];s.taskSettlementSettings={version:0,defaults:{sidebarAutoSettleAfterDays:null,sidebarAutoSettleOnMerge:true},projects:{}};});
 const discovery=resident?engine.changeRequestDiscovery:new TaskChangeRequestDiscovery(engine,60000);
 t.after(async()=>{await discovery.close();await engine.close();await rm(directory,{recursive:true,force:true});});
 return {engine,discovery,state,cwd,at,start:async()=>{discovery.start();await discovery.drain();},force:async()=>{discovery.request('a');discovery.request('b');await discovery.drain();}};
}
test('Resident discovery groups current-branch references without manually linking them and cached sweeps write no timestamp churn',async t=>{
 const f=await fixture(t);await f.start();let snapshot=await f.engine.snapshot();assert.equal(f.state.pullReads,1);assert(snapshot.tasks.every(t=>t.branchPullRequest?.number===17));assert(snapshot.tasks.every(t=>!t.changeRequests?.length));
 const revision=snapshot.revision,reads=f.state.reads.length;f.discovery.poll();await f.discovery.drain();snapshot=await f.engine.snapshot();assert.equal(snapshot.revision,revision);assert.equal(f.state.reads.length,reads);
});
test('A confirmed merge of the frozen task branch settles without inactivity or a window and preserves a different checked-out branch',async t=>{
 const f=await fixture(t);await f.start();f.state.remoteState='merged';await f.force();await f.engine.taskSettlement.sweep();const s=await f.engine.snapshot();assert(s.tasks.every(t=>!!t.settledAt));assert.equal(s.tasks[0].settledAt,f.at(-4000));
 const branch=execFileSync('git',['symbolic-ref','--short','HEAD'],{cwd:f.cwd,encoding:'utf8'}).trim();assert.equal(branch,'main');assert(s.tasks.every(t=>t.branchPullRequest?.head==='feature'));
});
test('A similarly named foreign Fork or another branch cannot be adopted as this task’s PR',async t=>{
 const f=await fixture(t);f.state.fork=true;await f.start();assert((await f.engine.snapshot()).tasks.every(t=>!t.branchPullRequest));f.state.fork=false;f.state.head='main';await f.force();assert((await f.engine.snapshot()).tasks.every(t=>!t.branchPullRequest));
});
test('A project or frozen branch change during the host read rejects its late discovery result',async t=>{
 const f=await fixture(t);let began!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{began=r;}),wait=new Promise<void>(r=>{release=r;});f.state.beforeRead=async()=>{began();await wait;};
 f.discovery.start();const drained=f.discovery.drain();await started;await f.engine.mutate(s=>{s.tasks[0].executionWorkspace!.branch='other';s.projects[0].path+='/changed';});release();await drained;assert((await f.engine.snapshot()).tasks.every(t=>!t.branchPullRequest));
});
test('Rate-limit failures retain the prior reference and pause fresh requests, while shutdown cancels an active read',async t=>{
 const f=await fixture(t);await f.start();f.state.limited=true;await f.force();const reads=f.state.pullReads;await f.force();assert.equal(f.state.pullReads,reads);assert((await f.engine.snapshot()).tasks.every(t=>t.branchPullRequest?.number===17));
});
test('Closing discovery drains an aborted HTTP lookup without publishing a late branch snapshot',async t=>{
 const f=await fixture(t);let began!:()=>void;const started=new Promise<void>(r=>{began=r;});f.state.beforeRead=signal=>{began();return new Promise((_r,reject)=>{if(signal?.aborted)reject(signal.reason);else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});});};
 f.discovery.start();const drained=f.discovery.drain();await started;await f.discovery.close();await drained;assert((await f.engine.snapshot()).tasks.every(t=>!t.branchPullRequest));
});


test('A terminal PR from the default branch cannot become a fresh task association or settle unrelated main-branch work',async t=>{
 const f=await fixture(t);await f.engine.mutate(s=>{for(const task of s.tasks)task.executionWorkspace!.branch='main';});f.state.head='main';f.state.selector='owner:main';f.state.remoteState='merged';await f.start();await f.engine.taskSettlement.sweep();assert((await f.engine.snapshot()).tasks.every(task=>!task.branchPullRequest&&!task.settledAt));
});

test('A stored terminal branch reference cannot settle offline without a fresh confirmation',async t=>{
 const f=await fixture(t);await f.start();await f.engine.mutate(s=>{for(const task of s.tasks){const pr=task.branchPullRequest!;pr.state='merged';pr.snapshot!.state='merged';pr.snapshot!.mergedAt=f.at(-1000);}});
 await f.engine.taskSettlement.sweep();assert((await f.engine.snapshot()).tasks.every(task=>!task.settledAt));
});

test('Settlement confirms the frozen branch and keeps a reopened remote request active',async t=>{
 const f=await fixture(t,true);await f.start();const reads=f.state.pullReads;
 await f.engine.mutate(s=>{for(const task of s.tasks){const pr=task.branchPullRequest!;pr.state='closed';pr.snapshot!.state='closed';pr.snapshot!.closedAt=f.at(-1000);}});
 await f.engine.taskSettlement.sweep();const tasks=(await f.engine.snapshot()).tasks;
 assert(f.state.pullReads>reads,'Terminal fallback must bypass the cached open lookup');assert(tasks.every(task=>task.branchPullRequest?.state==='open'&&!task.settledAt));
});
