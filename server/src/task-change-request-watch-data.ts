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
import type { PinnedSourceControlConnection } from './source-control-connections.js';
import type { SourceControlRepository } from './task-change-requests.js';
import type { ChangeRequestDetail, ChangeRequestActivity } from './task-change-request-data.js';
import type { ChangeRequestThread } from './task-change-request-collaboration.js';
import { object, list, words } from './task-change-request-data.js';
import type { WatchCheck, WatchDetail, WatchRemark } from './task-change-request-watch-types.js';

export type WatchFingerprint = { status: string; remarks: string };
export async function watchFingerprint(p: PinnedSourceControlConnection, r: SourceControlRepository, number: number, signal: AbortSignal): Promise<WatchFingerprint | null> {
  if (r.provider !== 'github' || !p.graphql) return null;
  const raw = await p.graphql(`query FridayWatchFingerprint($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state mergeable headRefOid comments(first:100,orderBy:{field:UPDATED_AT,direction:DESC}){totalCount nodes{lastEditedAt}} reviews(last:100){totalCount nodes{lastEditedAt}} reviewThreads{totalCount} commits(last:1){nodes{commit{statusCheckRollup{contexts{checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}}}}`, {owner:r.owner,name:r.name,number}, signal);
  const pr = object(object(raw.repository).pullRequest);
  if (typeof pr.state !== 'string' || typeof pr.headRefOid !== 'string') return null;
  const counts = object(object(object(list(object(pr.commits).nodes)[0]).commit).statusCheckRollup).contexts;
  const states = (value: unknown) => list(value).map(v => [v.state,v.count]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
  const newest = (value: unknown) => list(object(value).nodes).map(v=>typeof v.lastEditedAt==='string'?v.lastEditedAt:'').sort().at(-1)??'';
  return {status:JSON.stringify([pr.state,pr.mergeable,pr.headRefOid,states(object(counts).checkRunCountsByState),states(object(counts).statusContextCountsByState)]),remarks:JSON.stringify([object(pr.comments).totalCount,newest(pr.comments),object(pr.reviews).totalCount,newest(pr.reviews),object(pr.reviewThreads).totalCount])};
}
export function watchCheckStatus(raw: string): string {
  const state=raw.toLowerCase().replaceAll('_','-');
  if (['failure','failed','error','timed-out','startup-failure','stopped'].includes(state)) return 'failure';
  if (['cancelled','canceled','action-required'].includes(state)) return state==='canceled'?'cancelled':state;
  if (['success','successful','passed','neutral','skipped'].includes(state)) return state==='successful'||state==='passed'?'success':state;
  return 'pending';
}
export async function watchDetail(p:PinnedSourceControlConnection,r:SourceControlRepository,number:number,detail:ChangeRequestDetail,signal:AbortSignal):Promise<WatchDetail> {
  let checks:WatchCheck[]=detail.checksUnavailable?[]:detail.checks.map(v=>({...v,status:watchCheckStatus(v.state)}));
  if(r.provider==='github'&&p.graphql&&!detail.checksUnavailable){
    const values:WatchCheck[]=[],seen=new Set<string>();let after:string|null=null;
    while(true){
      const required=r.host==='github.com'?'isRequired(pullRequestNumber:$number)':'';
      const raw=await p.graphql(`query FridayWatchChecks($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{... on CheckRun{name status conclusion detailsUrl ${required}} ... on StatusContext{context state targetUrl ${required}}}}}}}}}}}`,{owner:r.owner,name:r.name,number,after},signal);
      const pr=object(object(raw.repository).pullRequest);
      if(pr.headRefOid!==detail.headSha)throw new Error('PR 的版本在自动跟进读取期间已改变');
      const rollup=object(object(list(object(pr.commits).nodes)[0]).commit).statusCheckRollup;
      if(rollup===null){checks=[];break;}
      const contexts=object(object(rollup).contexts);if(!contexts.pageInfo)throw new Error('无法完整读取 PR 检查');
      for(const v of list(contexts.nodes)){if(!v)continue;values.push({name:words(v.name??v.context,256),status:watchCheckStatus(String(v.conclusion??v.status??v.state)),...(typeof v.isRequired==='boolean'?{required:v.isRequired}:{}),...(typeof(v.detailsUrl??v.targetUrl)==='string'?{url:v.detailsUrl??v.targetUrl}:{})});}
      if(!object(contexts.pageInfo).hasNextPage){checks=values;break;}
      const cursor=object(contexts.pageInfo).endCursor;if(typeof cursor!=='string'||seen.has(cursor))throw new Error('自动跟进检查分页无效');seen.add(cursor);after=cursor;
    }
  }
  return {headSha:detail.headSha,checks,mergeability:['dirty','conflicting'].includes(detail.mergeability)?'conflicting':['unknown','checking','unchecked'].includes(detail.mergeability)?'unknown':'mergeable',viewer:detail.management?.viewer,author:{login:detail.author}};
}
export type WatchActivity = {items:ChangeRequestActivity[];threads:ChangeRequestThread[];truncated:boolean;reviewThreadsTruncated?:boolean;commentsTruncated?:boolean};
export async function watchRemarks(activity:WatchActivity, tail:(thread:ChangeRequestThread)=>Promise<ChangeRequestThread['comments']|null>):Promise<WatchRemark[]|null>{
  if(activity.commentsTruncated || activity.truncated && activity.reviewThreadsTruncated!==false)return null;
  const values:WatchRemark[]=activity.items.filter(v=>v.kind!=='event').map(v=>({id:v.id,author:v.author?{login:v.author}:null,body:v.body,createdAt:v.createdAt,...(v.editedAt?{editedAt:v.editedAt}:{}),path:v.path??null,reviewState:v.state??null,url:v.url}));
  for(const thread of activity.threads){
    const rest=thread.nextCursor?await tail(thread):[];if(rest===null)return null;
    for(const v of [...thread.comments,...rest])values.push({id:v.id,author:v.author?{login:v.author}:null,body:v.body,createdAt:v.createdAt,...(v.editedAt?{editedAt:v.editedAt}:{}),path:thread.path,reviewState:null,url:v.url});
  }
  return [...new Map(values.map(v=>[v.id,v])).values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
}
