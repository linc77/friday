/*
Adapted from T3 Code 8cd9641f PullRequestWatchReactor.ts / pullRequestWatch.ts / pullRequestBatches.graphql.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import { WorkspaceDoc } from './state.js';
import type { TaskPullRequest, WorkItem, Workspace } from './types.js';
import { allTaskChangeRequestLinks, linkTaskChangeRequest, ChangeRequestLinksConflict } from './task-change-request-links.js';
import { taskPullRequests } from './task-pull-requests.js';
import { changeRequestSyncKey } from './task-change-request-summary.js';
import { sourceControlRateFailure } from './source-control-request-policy.js';
import { watchFingerprint, watchDetail, watchRemarks, type WatchFingerprint } from './task-change-request-watch-data.js';
import type { TaskPullRequestWatch, WatchNotification } from './task-change-request-watch-types.js';
import type { ChangeRequestThread } from './task-change-request-collaboration.js';
import { evaluatePullRequestWatch, pullRequestWatchMessage } from './vendor/t3-pull-request-watch.js';
export type WatchActor = { runId: string; cwd: string; projectId: string | null };
export type WatchReceipt = { taskId: string; digest: string; url: string; watching: boolean; revision: number };
const stamp=()=>new Date().toISOString();
const inactive=(task:WorkItem)=>!!(task.archivedAt||task.settledAt||task.settledOverride==='settled'||task.subagentOrigin);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function assertWatchActor(task:WorkItem,actor?:WatchActor) { if(actor&&(task.currentRunId!==actor.runId||task.lastStoppedRunId===actor.runId||task.cwd!==actor.cwd||task.projectId!==actor.projectId||!['queued','running','waiting'].includes(task.status)))throw new Error('Agent 轮次已结束或任务范围已改变'); }
export function endPullRequestWatch(pr:TaskPullRequest,ended=pr.watch){delete pr.watch;if(ended)pr.endedWatch=ended;}
type Target={task:WorkItem;link:TaskPullRequest;watch:TaskPullRequestWatch;projectPath?:string};
type Last={at:number;fingerprint:string;inFlight:boolean;complete:boolean;watches:string[];host:WatchFingerprint|null};
/** Polling only reads hosts. Watermarks and ordinary Durable queue entries
 * commit together; the existing queue owns external execution and recovery. */
export class TaskChangeRequestWatch {
 private controller=new AbortController(); private timer?:NodeJS.Timeout;private queued?:NodeJS.Timeout;private running?:Promise<void>;
 private started=false;private stopped=false;private pending:'all'|'reconcile'|undefined;private requested=new Set<string>();
 private last=new Map<string,Last>();private failures=new Map<string,number>();private paused=new Map<string,number>();private tails=new Map<string,{count:number;comments:ChangeRequestThread['comments']}>();
 constructor(private engine:Engine,private intervalMs=120000,readonly now:()=>number=Date.now){}
 start(){if(this.started||this.stopped||this.intervalMs<=0)return;this.started=true;this.enqueue('all');}
 poll(){if(this.started)this.enqueue('all');}
 reconcile(){if(this.started)this.enqueue('reconcile');}
 request(id:string){if(this.stopped||this.intervalMs<=0)return;this.requested.add(id);if(this.started)this.enqueue('reconcile');}
 private enqueue(mode:'all'|'reconcile'){if(this.stopped)return;if(this.pending!=='all')this.pending=mode;if(!this.running&&!this.queued){this.queued=setTimeout(()=>{this.queued=undefined;this.launch();},20);this.queued.unref();}}
 private launch(){if(this.running||this.stopped)return;this.running=(async()=>{while(this.pending&&!this.stopped){const mode=this.pending;this.pending=undefined;await this.sweep(mode);if(mode==='all'&&!this.stopped){clearTimeout(this.timer);this.timer=setTimeout(()=>this.enqueue('all'),this.intervalMs);this.timer.unref();}}})().catch(()=>{if(!this.stopped)console.warn('[Friday runtime] PR watch sweep failed');}).finally(()=>{this.running=undefined;if(this.pending&&!this.stopped)this.launch();});}
 async drain(){clearTimeout(this.queued);this.queued=undefined;if(this.pending&&!this.running)this.launch();while(this.running)await this.running;}
 async change(id:string,raw:unknown,actor?:WatchActor){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('自动跟进请求无效');const v=raw as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['requestId','reference','watching','expectedRevision'].includes(k))||typeof v.requestId!=='string'||!/^[\w-]{1,128}$/.test(v.requestId)||['__proto__','constructor','prototype'].includes(v.requestId)||typeof v.watching!=='boolean'||!Number.isSafeInteger(v.expectedRevision)||Number(v.expectedRevision)<0)throw new Error('自动跟进请求无效');
  const digest=createHash('sha256').update(JSON.stringify([id,v.reference,v.watching,v.expectedRevision,actor??null])).digest('hex');
  const receipt=(s:Workspace)=>{const r=s.changeRequestWatchRequests?.[v.requestId as string];if(r&&r.digest!==digest)throw new Error('自动跟进请求 ID 已用于不同内容');return r;};
  const saved=receipt(await this.engine.snapshot());if(saved)return {url:saved.url,watching:saved.watching,revision:saved.revision};
  const pr=await this.engine.changeRequestLinks.reference(id,v.reference);
  const result=await this.engine.root.commit(async tx=>{
   const s=await tx.doc(WorkspaceDoc),saved=receipt(s);if(saved)return {url:saved.url,watching:saved.watching,revision:saved.revision};
   const task=s.tasks.find(t=>t.id===id);if(!task||task.agent==='friday'||task.subagentOrigin)throw new Error('本地任务不存在或由父任务管理');assertWatchActor(task,actor);
   if((task.changeRequestLinksRevision??0)!==v.expectedRevision)throw new ChangeRequestLinksConflict(task.changeRequestLinksRevision??0);
   if(v.watching&&inactive(task))throw new Error('已结束或归档的任务不能自动跟进');
   const at=new Date(Math.max(this.now(),Date.parse(taskPullRequests(task).find(p=>changeRequestSyncKey(p)===changeRequestSyncKey(pr))?.endedWatch?.startedAt??'')+1||0)).toISOString();
   if(v.watching&&actor)linkTaskChangeRequest(task,pr,'agent',at);
   const links=allTaskChangeRequestLinks(task),link=links.find(p=>!p.dismissedAt&&p.linkSource!=='stack-dismissed'&&changeRequestSyncKey(p)===changeRequestSyncKey(pr));if(v.watching&&!link)throw new Error('请先将此 PR／MR 关联到任务');
   if(v.watching&&link?.snapshot?.state==='merged')throw new Error('PR 已合并，不能重新开始自动跟进');
   let changed=false;
   if(v.watching&&link&&!link.watch){const old=link.endedWatch;link.watch={startedAt:at,headSha:old?.headSha??null,failedChecks:old?.failedChecks??[],passed:old?.passed??false,passedChecks:old?.passedChecks??[],conflicting:old?.conflicting??false,remarksThrough:at,remarkIds:[],wakes:0};changed=true;}
   if(!v.watching&&link?.watch){endPullRequestWatch(link);changed=true;}
   if(changed){task.changeRequests=links;task.changeRequestLinksRevision=(task.changeRequestLinksRevision??0)+1;task.updatedAt=stamp();}
   const result={url:pr.url,watching:v.watching as boolean,revision:task.changeRequestLinksRevision??0};s.changeRequestWatchRequests??={};s.changeRequestWatchRequests[v.requestId as string]={taskId:id,digest,...result};s.revision++;return result;
  },context);
  this.request(id);return result;
 }
 private async record(target:Target,next:TaskPullRequestWatch|undefined,wake?:{text:string;notification:WatchNotification},ended?:TaskPullRequestWatch){
  const requestId='pr-watch-'+randomUUID();
  await this.engine.root.commit(async tx=>{
   const state=await tx.doc(WorkspaceDoc),task=state.tasks.find(t=>t.id===target.task.id);
   if(!task||task.projectId!==target.task.projectId||task.cwd!==target.task.cwd||state.projects.find(p=>p.id===task.projectId)?.path!==target.projectPath)return;
   const links=allTaskChangeRequestLinks(task),link=links.find(p=>!p.dismissedAt&&p.linkSource!=='stack-dismissed'&&changeRequestSyncKey(p)===changeRequestSyncKey(target.link));
   if(!link?.watch||!same(link.watch,target.watch)||wake&&inactive(task))return;
   if(next)link.watch=next;else endPullRequestWatch(link,ended??link.watch);
   task.changeRequests=links;state.revision++;
   if(wake)await this.engine.taskQueue.enqueueMonitor(tx,state,task,wake.text,wake.notification,requestId);
  },context);this.engine.harness.resume();
 }
 private async sweep(mode:'all'|'reconcile'){
  const state=await this.engine.snapshot(),revision=await this.engine.sourceControl.revision(),projects=new Map(state.projects.map(p=>[p.id,p]));
  const groups=new Map<string,Target[]>(),requests=new Set(this.requested);for(const id of requests)this.requested.delete(id);
  for(const task of state.tasks){if(task.agent==='friday')continue;for(const link of taskPullRequests(task)){if(!link.watch)continue;const target={task,link,watch:link.watch,projectPath:projects.get(task.projectId??'')?.path};
   if(inactive(task)||task.projectId&&!projects.has(task.projectId)||link.snapshot?.state==='merged'){await this.record(target,undefined);continue;}
   const key=JSON.stringify([task.projectId??task.cwd,target.projectPath,changeRequestSyncKey(link),revision]);groups.set(key,[...groups.get(key)??[],target]);
  }}
  for(const cache of [this.last,this.failures,this.paused])for(const key of cache.keys())if(!groups.has(key))cache.delete(key);
  let index=0;const values=[...groups.entries()];
  const read=async()=>{while(index<values.length&&!this.stopped){const [key,targets]=values[index++]!;if(mode!=='all'&&!targets.some(t=>requests.has(t.task.id)))continue;if((this.paused.get(key)??0)>this.now())continue;
   try{await this.readGroup(key,targets);}catch(error){if(this.stopped)return;const rate=sourceControlRateFailure(error);if(rate){this.paused.set(key,rate.retryAt??this.now()+30000);continue;}
    this.last.delete(key);const count=(this.failures.get(key)??0)+1;this.failures.set(key,count);
    if(count>=8){for(const target of targets)await this.record(target,undefined,{text:`Friday 无法连续读取 PR #${target.link.number}（${target.link.url}）8 次，已停止自动跟进。请检查平台连接，确认后可调用 watch_pull_request 重新开始。`,notification:{source:{kind:'monitor'},outcome:'failed',summary:`#${target.link.number}：无法读取，已停止自动跟进`}});this.failures.delete(key);}
   }
  }};
  await Promise.all(Array.from({length:Math.min(4,values.length)},read));
 }
 private async readGroup(key:string,targets:Target[]){
  const first=targets[0]!,signal=this.controller.signal,target=await this.engine.changeRequests.target(first.task.id,first.link.url,signal);
  let fingerprint:WatchFingerprint|null;try{fingerprint=await watchFingerprint(target.pinned,target.repository,target.number,signal);}catch(error){if(signal.aborted||sourceControlRateFailure(error))throw error;fingerprint=null;}
  const old=this.last.get(key),now=this.now(),watches=targets.map(t=>t.task.id+' '+t.watch.startedAt),snapshot=JSON.stringify(targets.map(t=>t.link.snapshot?{state:t.link.snapshot.state,updatedAt:t.link.snapshot.updatedAt,checksState:t.link.snapshot.checksState,mergeability:t.link.snapshot.mergeability,reviewDecision:t.link.snapshot.reviewDecision,isDraft:t.link.snapshot.isDraft}:null));
  let detail=true,activity=true;
  if(old&&watches.every(k=>old.watches.includes(k))){
   if(fingerprint){activity=old.host?.remarks!==fingerprint.remarks||!old.complete||now-old.at>=30*60000;detail=activity||old.host?.status!==fingerprint.status||old.inFlight;}
   else detail=activity=old.inFlight||!old.complete||old.fingerprint!==snapshot||now-old.at>=10*60000;
  }
  if(!detail)return;
  await this.engine.changeRequests.invalidateReference(target.repository,target.number);
  const reads=await Promise.allSettled([this.engine.changeRequests.detail(first.task.id,first.link.url,signal),activity?this.engine.changeRequests.activity(first.task.id,first.link.url,signal):null] as const);
  if(reads[0].status==='rejected')throw reads[0].reason;if(reads[1].status==='rejected')throw reads[1].reason;
  const raw=reads[0].value,comments=reads[1].value;
  if(raw.pullRequest.state!=='open'){
   for(const t of targets)await this.record(t,undefined,raw.pullRequest.state==='closed'?{text:`PR #${t.link.number}（${t.link.url}）已关闭，Friday 已停止自动跟进。重新打开后可以调用 watch_pull_request。`,notification:{source:{kind:'monitor'},outcome:'updated',summary:`#${t.link.number}：已关闭，停止跟进`}}:undefined);this.last.delete(key);return;
  }
  const normalized=await watchDetail(target.pinned,target.repository,target.number,raw,signal);
  const remarks=comments?await watchRemarks(comments,async thread=>{
   const tailKey=key+' '+thread.id,count=thread.commentCount,held=this.tails.get(tailKey);if(held?.count===count)return held.comments;
   try{const entries=new Map<string,ChangeRequestThread['comments'][number]>(),cursors=new Set<string>();let cursor=thread.nextCursor;
    while(cursor){if(cursors.has(cursor))return null;cursors.add(cursor);const page=await this.engine.changeRequests.threadComments(first.task.id,first.link.url,thread.id,cursor,signal);for(const c of page.comments)entries.set(c.id,c);cursor=page.nextCursor??undefined;}
    if(thread.comments.length+entries.size<count)return null;const comments=[...entries.values()];this.tails.set(tailKey,{count,comments});while(this.tails.size>512)this.tails.delete(this.tails.keys().next().value!);return comments;
   }catch{signal.throwIfAborted();return null;}
  }):null;
  const fresh=await this.engine.changeRequests.target(first.task.id,first.link.url,signal);if(fresh.pinned.fingerprint!==target.pinned.fingerprint||await this.engine.sourceControl.revision()!==JSON.parse(key).at(-1))return;
  this.failures.delete(key);this.last.set(key,{at:activity||!old?now:old.at,fingerprint:snapshot,inFlight:normalized.mergeability==='unknown'||normalized.checks.some(c=>c.status==='pending'),complete:activity?remarks!==null:old?.complete??false,watches,host:fingerprint});
  for(const t of targets){const report=evaluatePullRequestWatch(t.watch,normalized,remarks);if(report.changes.length){const wake=pullRequestWatchMessage({number:t.link.number,url:t.link.url,baseBranch:raw.pullRequest.base,headSha:normalized.headSha,report});await this.record(t,report.exhausted?undefined:report.next,wake,report.exhausted?report.next:undefined);}else if(!same(t.watch,report.next))await this.record(t,report.next);}
 }
 async close(){this.stopped=true;this.controller.abort();clearTimeout(this.timer);clearTimeout(this.queued);this.pending=undefined;await this.running;this.requested.clear();this.last.clear();this.failures.clear();this.paused.clear();this.tails.clear();}
}
