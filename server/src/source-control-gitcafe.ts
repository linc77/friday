/*
Adapted from T3 Code 8cd9641f GitCafeSourceControlProvider, GitCafePullRequestProvider and gitCafePullRequestJson.
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
import { summaryFromRaw, taskPullRequestReading, selectBranchPullRequest } from './task-change-request-summary.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AdditionalHTTPConnection } from './source-control-provider-transports.js';
import { additionalChangeRequestURL, additionalRepositoryPath, gitCafeRepositoryIdentity } from './source-control-provider-identity.js';
import type { AdditionalPullRequest, AdditionalChangeRequestDetail, AdditionalChangeRequestActivity, AdditionalChangeRequestInput } from './source-control-provider-models.js';
import type { ChangeRequestEffect, ChangeRequestActivity } from './task-change-request-data.js';
import type { ChangeRequestThread, CollaborationInput } from './task-change-request-collaboration.js';
import type { ChangeRequestStack } from './task-change-request-stack-types.js';
import type { ReviewReaction, ReviewReactionContent, ReviewStateInput } from './task-change-request-review-state.js';
import type { ChangeRequestDiffFile } from './task-change-request-diff.js';
import { additionalRawDiffFiles } from './source-control-provider-diff.js';
import { gitCafeDiffPatch, type GitCafeDiffFile } from './vendor/t3-gitcafe-diff.js';

const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const text=(v:unknown)=>typeof v==='string'?v:'';
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f\d]{40,64}$/i.test(v);
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
const opaque=(v:unknown):string=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,2048}$/.test(v))throw new Error('GitCafe 资源 ID 无效');return v;};
const number=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<1)throw new Error('GitCafe PR 编号无效');return Number(v);};
const actor=(v:unknown)=>{const a=object(v);return a.kind==='local'?text(a.handle):a.kind==='github'?text(a.login):'';};
const avatar=(v:unknown,host:string)=>{const a=object(v);if(!['local','github'].includes(a.kind)||typeof a.avatarUrl!=='string'||!a.avatarUrl)return;try{const url=new URL(a.avatarUrl,'https://'+host);return url.protocol==='https:'&&!url.username&&!url.password?url.href:undefined;}catch{return;}};
const emoji:Record<ReviewReactionContent,string>={'thumbs-up':'👍','thumbs-down':'👎',laugh:'😄',hooray:'🎉',confused:'😕',heart:'❤️',rocket:'🚀',eyes:'👀'};
const reactionContent=(value:string)=>(Object.keys(emoji) as ReviewReactionContent[]).find(key=>emoji[key].replaceAll('\uFE0F','')===value.replaceAll('\uFE0F',''));
async function parallel<A,B>(items:A[],run:(value:A)=>Promise<B>,limit=4){let next=0;const out:B[]=Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await run(items[i]);}}));return out;}
type Cursor={version:number;headOid:string;baseOid:string;after:string};
export function gitCafeDiffCursor(raw:unknown):Cursor|null{
  if(raw===undefined||raw===null||raw==='')return null;if(typeof raw!=='string'||raw.length>8192)throw new Error('GitCafe Diff 游标无效');let value:any;try{value=JSON.parse(raw);}catch{throw new Error('GitCafe Diff 游标无效');}
  if(!value||!version(value.version)||!sha(value.headOid)||!sha(value.baseOid)||typeof value.after!=='string'||!value.after||value.after.length>4096||/[\x00-\x1f]/.test(value.after))throw new Error('GitCafe Diff 游标无效');return {version:value.version,headOid:value.headOid,baseOid:value.baseOid,after:value.after};
}
export class GitCafeSourceControl {
  readonly identity;private readonly repo:string;
  constructor(private readonly connection:AdditionalHTTPConnection){if(connection.identity.provider!=='gitcafe')throw new Error('GitCafe 连接归属无效');this.identity=Object.freeze(structuredClone(connection.identity));this.repo='repos/'+this.identity.repository.split('/').map(encodeURIComponent).join('/');}
  private pull(n:number){return this.repo+'/pulls/'+number(n);}
  private normalize(raw:Record<string,any>,expected?:number):AdditionalPullRequest{
    const n=number(raw.number);if(expected!==undefined&&n!==expected||!['open','closed','merged'].includes(raw.state)||typeof raw.title!=='string'||!text(raw.sourceBranch)||!text(raw.targetBranch))throw new Error('GitCafe 返回的 PR 信息无效');
    return {number:n,title:raw.title,url:additionalChangeRequestURL(this.identity,n),state:raw.state,base:raw.targetBranch,head:raw.sourceBranch,provider:'gitcafe',host:this.identity.host,repository:this.identity.path};
  }
  private async readPull(n:number,signal?:AbortSignal){const raw=await this.connection.json(this.pull(n),{signal});this.normalize(raw,n);if(!version(raw.version)||typeof raw.draft!=='boolean'||raw.headOid!==null&&!sha(raw.headOid)||['comment','edit','review','merge','moderate'].some(key=>typeof object(raw.capabilities)[key]!=='boolean'))throw new Error('GitCafe 未返回可确认的 PR 版本或权限');opaque(raw.id);return raw;}
  private async pages(path:string,signal?:AbortSignal){const items:any[]=[];let next:string|null=null;for(let page=0;page<10;page++){
    const query=new URLSearchParams({limit:'100'});if(next!==null)query.set('after',next);const result=await this.connection.json(path+(path.includes('?')?'&':'?')+query,{signal});if(!Array.isArray(result.items)||result.next!==null&&typeof result.next!=='string')throw new Error('GitCafe 分页结果无效');items.push(...result.items);const previous:string|null=next;next=result.next;if(next===null||next===previous||!result.items.length)break;
  }return {items,next};}
  async summary(n:number,signal?:AbortSignal){return this.normalize(await this.readPull(n,signal),n);}
  async summaryReading(n:number,signal?:AbortSignal){const observedAt=Date.now(),raw=await this.readPull(n,signal);const result=summaryFromRaw(this.normalize(raw,n),raw,observedAt);if(raw.stack===null)result.stack=null;else if(Number.isSafeInteger(raw.stack?.number)&&raw.stack.number>0)result.stack=raw.stack.number;return result;}
  async checkout(n:number,signal?:AbortSignal){const raw=await this.readPull(n,signal),pullRequest=this.normalize(raw,n),repo=raw.sourceRepo?text(raw.sourceRepo.owner)+'/'+text(raw.sourceRepo.name):this.identity.repository,source=gitCafeRepositoryIdentity('https://'+this.identity.host+'/'+repo.split('/').map(encodeURIComponent).join('/'));if(!source||!sha(raw.headOid))throw new Error('GitCafe 未返回可确认的源仓库和提交');return {pullRequest,headSha:raw.headOid,source};}
  async defaultBranch(signal?:AbortSignal){return text((await this.connection.json(this.repo,{signal})).defaultBranch)||undefined;}
  async find(branch:string,base?:string,sourceRepository=this.identity.repository,signal?:AbortSignal,includeTerminal=false):Promise<AdditionalPullRequest|null>{
    const query=new URLSearchParams({sourceBranches:JSON.stringify([branch]),sort:'newest'});if(!includeTerminal)query.set('state','open');const values=await this.pages(this.repo+'/pulls?'+query,signal);
    const candidates:AdditionalPullRequest[]=[];for(const item of values.items){if(item.sourceBranch!==branch||base&&item.targetBranch!==base)continue;const raw=await this.readPull(number(item.number),signal),source=raw.sourceRepo?raw.sourceRepo.owner+'/'+raw.sourceRepo.name:this.identity.repository;if(source!==sourceRepository)continue;const pr=this.normalize(raw);if(includeTerminal||pr.state==='open'){if(includeTerminal)candidates.push(taskPullRequestReading(pr,raw));else return pr;}}return selectBranchPullRequest(candidates);
  }
  async create(input:{branch:string;base:string;title:string;body:string;sourceRepository?:string},signal?:AbortSignal){
    if(!this.connection.command)throw new Error('GitCafe CLI 不可用');const folder=await mkdtemp(join(tmpdir(),'friday-cafe-pr-')),file=join(folder,'body.txt');
    try{await writeFile(file,input.body,{mode:0o600,flag:'wx'});const source=input.sourceRepository??this.identity.repository;
      await this.connection.command(['pr','create','--json','--repo',this.identity.repository,'--head',source===this.identity.repository?input.branch:source+':'+input.branch,'--base',input.base,'--title',input.title,'--body-file',file],{signal});
    }finally{await rm(folder,{recursive:true,force:true});}
    const found=await this.find(input.branch,input.base,input.sourceRepository,signal);if(!found)throw new Error('GitCafe PR 创建结果尚未确认，请在平台核对');return found;
  }
  async createRepository(visibility:'private'|'public',signal?:AbortSignal){
    if(!this.connection.command)throw new Error('GitCafe CLI 不可用');const [owner,name]=this.identity.repository.split('/');if(!owner||!name||[owner,name].some(part=>!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part)))throw new Error('GitCafe 仓库名称无效');
    const response=await this.connection.command(['repo','create',name,'--org',owner,'--visibility',visibility,'--json'],{signal});let resource=object(object(response.data).resource);const end=Date.now()+30000;
    while(!['complete','blocked'].includes(resource.state)&&Date.now()<end){await delay(500,undefined,{signal});resource=await this.connection.json('orgs/'+encodeURIComponent(text(resource.owner))+'/admissions/'+opaque(resource.repoId),{signal,timeoutMs:Math.max(1,Math.min(30000,end-Date.now()))});}
    if(resource.state!=='complete'||resource.owner+'/'+resource.name!==this.identity.repository)throw new Error('GitCafe 仓库接纳尚未完成或归属已改变，请在平台核对');
    return {repository:this.identity.repository,url:this.identity.webURL,sshURL:`ssh@${this.identity.host}:${this.identity.repository}.git`,httpsURL:this.identity.webURL+'.git'};
  }
  private async details(n:number,revision:{version:number;headOid:string;baseOid:string},paths:string[],signal?:AbortSignal):Promise<GitCafeDiffFile[]>{
    if(!paths.length)return [];const chunks=Array.from({length:Math.ceil(paths.length/64)},(_,index)=>paths.slice(index*64,index*64+64));
    return (await parallel(chunks,async paths=>{const value=await this.connection.json(this.pull(n)+'/diff-files',{method:'POST',body:{paths,expectedVersion:revision.version},signal});if(value.version!==revision.version||value.headOid!==revision.headOid||value.comparisonBaseOid!==revision.baseOid||!Array.isArray(value.items))throw new Error('GitCafe Diff 版本已改变，请刷新');return value.items as GitCafeDiffFile[];})).flat();
  }
  private async lineStats(n:number,expectedVersion:number,signal?:AbortSignal){
    const files:GitCafeDiffFile[]=[];let after:string|null=null,revision:{version:number;headOid:string;baseOid:string}|undefined;
    for(let page=0;page<20;page++){const query=new URLSearchParams({expectedVersion:String(expectedVersion),limit:'500'});if(after)query.set('after',after);const raw=await this.connection.json(this.pull(n)+'/changes?'+query,{signal});
      if(raw.version!==expectedVersion||!sha(raw.headOid)||!sha(raw.comparisonBaseOid)||!Array.isArray(raw.items)||raw.next!==null&&(typeof raw.next!=='string'||!raw.next))throw new Error('GitCafe 文件统计版本已改变');if(revision&&(raw.headOid!==revision.headOid||raw.comparisonBaseOid!==revision.baseOid))throw new Error('GitCafe 文件统计版本已改变');revision??={version:raw.version,headOid:raw.headOid,baseOid:raw.comparisonBaseOid};files.push(...raw.items);const previous:string|null=after;after=raw.next;if(after===null||after===previous||!raw.items.length)break;}
    let counted=files;if(!files.some(file=>file.additions!==undefined)&&files.length<=256&&revision)counted=await this.details(n,revision,files.filter(file=>!file.binary&&!file.tooLarge).map(file=>file.path),signal).catch(()=>[]);
    return {changedFiles:files.length,additions:counted.reduce((sum,file)=>sum+(file.additions??0),0),deletions:counted.reduce((sum,file)=>sum+(file.deletions??0),0)};
  }
  async detail(n:number,signal?:AbortSignal):Promise<AdditionalChangeRequestDetail>{
    const pull=await this.readPull(n,signal),path=this.pull(n);const [status,checks,stats]=await Promise.all([this.connection.json(path+'/status',{signal}),pull.headOid?this.pages(this.repo+'/commits/'+encodeURIComponent(pull.headOid)+'/checks',signal):null,pull.headOid?this.lineStats(n,pull.version,signal).catch(error=>{if(signal?.aborted)throw error;return null;}):null]);
    const caps=object(pull.capabilities),merge=object(status.merge),open=caps.comment===true&&(pull.lockedAt==null||caps.moderate===true),state=pull.state;
    const actions:AdditionalChangeRequestDetail['actions']=[...(caps.edit&&state==='open'?[pull.draft?'ready' as const:'draft' as const,'close' as const]:caps.edit&&state==='closed'?['reopen' as const]:[]),...(caps.merge&&state==='open'&&!pull.draft&&merge.permitted!==false?['merge' as const]:[])];
    const strategies=Array.isArray(merge.strategies)?merge.strategies:[],blockers=Array.isArray(merge.blockers)?merge.blockers:[];
    return {pullRequest:this.normalize(pull,n),body:text(pull.description),author:actor(pull.author),authorAvatarURL:avatar(pull.author,this.identity.host),createdAt:text(pull.createdAt),updatedAt:text(pull.updatedAt),...(pull.closedAt?{closedAt:pull.closedAt}:{}),...(pull.mergedAt?{mergedAt:pull.mergedAt}:{}),
      isDraft:pull.draft===true,headSha:text(pull.headOid),providerVersion:pull.version,mergeability:merge.conflicts==='conflicting'?'conflicting':'unknown',baseComparison:merge.fastForward===true?'up-to-date':merge.fastForward===false?'behind':'unknown',
      actions,mergeMethods:['merge','squash','rebase'].filter(strategy=>merge.permitted!==false&&strategies.includes(strategy)&&!blockers.some(blocker=>Array.isArray(blocker.blockedStrategies)&&blocker.blockedStrategies.includes(strategy))),
      verdicts:caps.review?['approve','request-changes','comment']:[],canComment:open,stackRebase:caps.merge===true,updateMethods:[],additions:stats?.additions??0,deletions:stats?.deletions??0,changedFiles:stats?.changedFiles??0,
      reviewers:Array.isArray(pull.reviewers)?pull.reviewers.map((row:any)=>actor(row.actor)).filter(Boolean):[],labels:Array.isArray(pull.labels)?pull.labels.map((row:any)=>text(row.name)):[],
      checks:(checks?.items??[]).map((row:any)=>({name:text(row.name),state:row.status!=='completed'?'pending':['success','neutral','skipped','cancelled'].includes(row.conclusion)?row.conclusion:row.conclusion==='action_required'?'action-required':'failure',...(row.detailsUrl?{url:row.detailsUrl}:{})})),
      ...(object(status.checks).total>0?{checksState:object(status.checks).failing>0?'failing' as const:object(status.checks).pending>0?'pending' as const:'passing' as const}:{}),
      management:{canEdit:caps.edit===true,canResolve:open,canRequestReviewers:false,canSetLabels:false,canReact:true}};
  }
  async diff(n:number,input:{head:string;cursor?:unknown;commit?:unknown;base?:string},signal?:AbortSignal){
    if(input.commit!==undefined)throw new Error('GitCafe 暂不支持提交 Diff');const cursor=gitCafeDiffCursor(input.cursor),v=cursor?.version??(await this.readPull(n,signal)).version;
    const query=new URLSearchParams({expectedVersion:String(v),limit:'64'});if(cursor)query.set('after',cursor.after);const page=await this.connection.json(this.pull(n)+'/changes?'+query,{signal});
    if(page.version!==v||page.headOid!==input.head||!sha(page.headOid)||!sha(page.comparisonBaseOid)||!Array.isArray(page.items)||cursor&&(cursor.headOid!==page.headOid||cursor.baseOid!==page.comparisonBaseOid)||input.base&&input.base!==page.comparisonBaseOid)throw new Error('GitCafe Diff 版本已改变，请刷新');
    const revision={version:v,headOid:page.headOid,baseOid:page.comparisonBaseOid},metadata=page.items as GitCafeDiffFile[];
    metadata.forEach(file=>{additionalRepositoryPath(file.path);if(file.oldPath)additionalRepositoryPath(file.oldPath);});const detailed=await this.details(n,revision,metadata.filter(file=>!file.binary&&!file.tooLarge).map(file=>file.path),signal),byPath=new Map(detailed.map(file=>[file.path,file])),items=metadata.map(file=>byPath.get(file.path)??file),patch=gitCafeDiffPatch({items});
    const parsed=additionalRawDiffFiles(patch.patch),fileMap=new Map(parsed.files.map(file=>[file.path,file]));const files:ChangeRequestDiffFile[]=items.map(file=>({...fileMap.get(file.path)!,path:file.path,...(file.oldPath?{oldPath:file.oldPath}:{}),status:file.status==='deleted'?'removed':file.status??'modified',additions:file.additions??fileMap.get(file.path)?.additions??0,deletions:file.deletions??fileMap.get(file.path)?.deletions??0,patch:fileMap.get(file.path)?.patch??'',unavailable:!!(file.binary||file.tooLarge||file.hunksOmitted),...(file.binary?{omissionReason:'binary' as const}:file.tooLarge?{omissionReason:'too_large' as const}:file.hunksOmitted?{omissionReason:'host_omitted' as const}:{})}));
    if(page.next!==null&&(typeof page.next!=='string'||!page.next))throw new Error('GitCafe Diff 游标无效');return {headSha:page.headOid,baseSha:page.comparisonBaseOid,patch:patch.patch,files,truncated:patch.truncated,nextCursor:page.next===null?null:JSON.stringify({...revision,after:page.next}),omittedFileStats:patch.omittedFileStats??[]};
  }
  private write(key:string,path:string,method:'POST'|'PATCH'|'DELETE',body?:Record<string,unknown>,check:'written'|'version'|'empty'='empty'):ChangeRequestEffect{return {key,run:async signal=>{const response=await this.connection.json(path,{method,body,signal,allowEmpty:check==='empty'});if(check==='written')opaque(response.id);if(check==='version'&&!version(response.version))throw new Error('GitCafe 写入结果尚未确认');}};}
  async effects(detail:AdditionalChangeRequestDetail,input:AdditionalChangeRequestInput,signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    const n=detail.pullRequest.number,path=this.pull(n);this.assertDetail(detail);
    if(input.action==='comment'){if(!detail.canComment)throw new Error('当前账号不能评论');return [this.write('comment',path+'/comments/','POST',{body:input.body??''},'written')];}
    if(input.action==='review'&&(input.comments?.length||!input.verdict||!detail.verdicts.includes(input.verdict)))throw new Error('GitCafe 暂不支持行批注或此审查结论');
    const pull=await this.readPull(n,signal);if(pull.version!==detail.providerVersion||pull.headOid!==detail.headSha)throw new Error('GitCafe PR 版本已改变，请刷新');
    if(input.action==='review'){if(!sha(pull.headOid))throw new Error('GitCafe 尚未返回源提交');return [this.write('review',path+'/reviews','POST',{verdict:input.verdict==='request-changes'?'request_changes':input.verdict,...(input.body?{body:input.body}:{}),commitOid:pull.headOid,expectedVersion:pull.version,requestId:randomUUID()},'written')];}
    if(!detail.actions.includes(input.action as any))throw new Error('GitCafe 不支持此操作');
    if(input.action==='merge'){
      const strategy=input.mergeMethod??detail.mergeMethods[0];if(!detail.mergeMethods.includes(strategy)||pull.mergeRoute==='unsupported')throw new Error('GitCafe 不支持此合并方式');
      const baseOid=pull.mergeRoute==='provider'?pull.observedBaseOid:(await this.connection.json(this.repo+'/commit?ref='+encodeURIComponent('refs/heads/'+pull.targetBranch),{signal})).oid;
      if(!sha(pull.headOid)||!sha(baseOid))throw new Error('GitCafe 尚未返回合并基准');const body={requestId:randomUUID(),expectedVersion:pull.version,headOid:pull.headOid,baseOid,strategy};
      return [{key:'merge',run:async signal=>{const value=await this.connection.json(path+'/merge',{method:'POST',body,signal});if(!['accepted','completed','failed'].includes(value.state)||value.state==='failed')throw new Error('GitCafe 合并结果尚未确认或失败，请在平台核对');}}];
    }
    return [this.write(input.action,path+'/'+input.action,'POST',{expectedVersion:pull.version})];
  }
  private assertDetail(detail:AdditionalChangeRequestDetail){if(detail.pullRequest.host!==this.identity.host||detail.pullRequest.repository!==this.identity.path)throw new Error('GitCafe 操作归属已改变');}
  async activity(n:number,signal?:AbortSignal):Promise<AdditionalChangeRequestActivity>{
    const pull=await this.readPull(n,signal),path=this.pull(n);const [comments,reviews,commits,reactionPage]=await Promise.all([this.pages(path+'/comments',signal),this.pages(path+'/reviews',signal),pull.headOid?this.pages(path+'/commits',signal):{items:[],next:null},this.pages(path+'/reactions/',signal).catch(error=>{if(signal?.aborted)throw error;return undefined;})]);
    const reactions:ReviewReaction[]=[],bySubject:Record<string,ReviewReaction[]>={};for(const row of reactionPage?.items??[]){const content=object(row.emoji).kind==='unicode'?reactionContent(text(row.emoji.value)):undefined;if(!content)continue;const value:ReviewReaction={content,count:row.count,actors:Array.isArray(row.reactors)?row.reactors.map(actor).filter(Boolean):[],viewerHasReacted:row.viewerReactionId!=null};if(object(row.subject).kind==='pull_request')reactions.push(value);else if(object(row.subject).kind==='pull_request_comment')(bySubject[row.subject.id]??=[]).push(value);}
    const sorted=comments.items.toSorted((a,b)=>text(a.createdAt).localeCompare(text(b.createdAt))),groups=new Map<string,any[]>();
    const comment=(row:any):ChangeRequestActivity=>({id:opaque(row.id),sourceID:opaque(row.id),kind:row.path==null?'issue-comment':'review-comment',commentKind:row.path==null?'issue-comment':'review-comment',author:actor(row.author),authorAvatarURL:avatar(row.author,this.identity.host),body:text(row.body),createdAt:text(row.createdAt),...(row.path?{path:row.path}:{}),...(row.capabilities?{canEdit:row.capabilities.edit===true}:{})});
    for(const row of sorted)if(row.path&&row.line>0&&['left','right'].includes(row.side)){additionalRepositoryPath(row.path);const thread=opaque(row.threadId);groups.set(thread,[...(groups.get(thread)??[]),row]);}
    const threads:ChangeRequestThread[]=[...groups.values()].map(rows=>{const first=rows[0],latest=rows.at(-1),root=rows.find(row=>row.id===row.threadId);return {id:opaque(first.threadId),path:first.path,line:first.line,side:first.side,isResolved:root?.resolvedAt!=null,isOutdated:pull.headOid!=null&&latest.commitOid!=null&&latest.commitOid!==pull.headOid,comments:rows.map(row=>({...comment(row),commentKind:'review-comment' as const,reactions:bySubject[row.id]})),commentCount:rows.length,...(root?.capabilities?{canResolve:root.resolvedAt==null?root.capabilities.resolve:root.capabilities.unresolve}:{})};});
    return {items:[...sorted.map(comment),...reviews.items.map(row=>({id:opaque(row.id),kind:'review',author:actor(row.author),body:text(row.body),createdAt:text(row.createdAt),state:row.dismissedAt!=null?'DISMISSED':row.verdict==='approve'?'APPROVED':row.verdict==='request_changes'?'CHANGES_REQUESTED':'COMMENTED'}))].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),truncated:comments.next!==null||reviews.next!==null,threads,
      commits:commits.items.map(row=>({oid:text(row.oid),messageHeadline:text(row.summary),committedDate:new Date(Number(row.time)*1000).toISOString(),authors:[]})),commitsTruncated:commits.next!==null,reactions,bySubject};
  }
  async collaborationEffects(detail:AdditionalChangeRequestDetail,input:CollaborationInput,signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    this.assertDetail(detail);const path=this.pull(detail.pullRequest.number);
    if(input.action==='labels'||input.action==='reviewers')throw new Error('GitCafe 暂不支持标签或审查者请求');
    if(input.action==='edit_request'){if(!detail.management?.canEdit)throw new Error('当前账号不能编辑此 PR');const pull=await this.readPull(detail.pullRequest.number,signal);if(pull.version!==detail.providerVersion)throw new Error('GitCafe PR 版本已改变');return [this.write('edit-request',path,'PATCH',{expectedVersion:pull.version,...(input.title===undefined?{}:{title:input.title}),...(input.body===undefined?{}:{description:input.body})},'version')];}
    const comments=await this.pages(path+'/comments',signal);
    if(input.action==='edit_comment'){const comment=comments.items.find(row=>row.id===input.commentId);if(!comment||comment.capabilities?.edit===false)throw new Error('评论不属于此 PR 或不能编辑');const endpoint=path+'/comments/'+opaque(input.commentId),current=await this.connection.json(endpoint+'/detail',{signal});if(!version(current.version)||current.id!==input.commentId)throw new Error('GitCafe 评论版本无效');return [this.write('edit-comment',endpoint,'PATCH',{body:input.body,expectedVersion:current.version},'written')];}
    const root=comments.items.find(row=>row.id===input.threadId&&row.id===row.threadId);if(!root)throw new Error('线程不属于此 PR');const endpoint=path+'/comments/'+opaque(input.threadId);
    if(input.action==='reply'){if(!detail.canComment)throw new Error('当前账号不能回复');return [this.write('reply',endpoint+'/replies','POST',{body:input.body},'written')];}
    if(input.resolved===(root.resolvedAt!=null))return [];if(!version(root.version)||root.capabilities&&(input.resolved?root.capabilities.resolve:root.capabilities.unresolve)===false)throw new Error('GitCafe 线程版本或权限已改变');return [this.write('resolve',endpoint+(input.resolved?'/resolve':'/unresolve'),'POST',{expectedVersion:root.version},'written')];
  }
  async reactionEffects(n:number,input:ReviewStateInput,signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    if(input.action!=='reaction'||!input.content||!Object.hasOwn(emoji,input.content))throw new Error('GitCafe reaction 无效');const path=this.pull(n),pull=await this.readPull(n,signal),subject=input.subjectId?{kind:'pull_request_comment',id:opaque(input.subjectId)}:{kind:'pull_request',id:opaque(pull.id)};
    if(input.subjectId&&!(await this.pages(path+'/comments',signal)).items.some(row=>row.id===input.subjectId))throw new Error('reaction 资源不属于此 PR');const reactions=await this.pages(path+'/reactions/',signal),mine=reactions.items.find(row=>object(row.subject).kind===subject.kind&&row.subject.id===subject.id&&object(row.emoji).kind==='unicode'&&reactionContent(row.emoji.value)===input.content)?.viewerReactionId;
    if(input.reacted===(mine!=null))return [];return input.reacted?[this.write('reaction',path+'/reactions/','POST',{subject,emoji:{kind:'unicode',value:emoji[input.content]}})]:mine==null?[]:[this.write('reaction',path+'/reactions/'+opaque(mine),'DELETE')];
  }
  async stack(n:number,signal?:AbortSignal):Promise<(ChangeRequestStack&{revision:number})|null>{
    const raw=(await this.connection.json(this.pull(n)+'/stack',{signal})).stack;if(raw===null)return null;if(!raw||!Array.isArray(raw.members)||!version(raw.revision)||raw.revision<1)throw new Error('GitCafe Stack 无效');
    const members=await parallel(raw.members as any[],async member=>member.state==='merged'?member:{...member,headOid:(await this.readPull(number(member.pullRequestNumber),signal)).headOid});
    return {id:opaque(raw.id),number:number(raw.number),url:this.identity.webURL+'/stacks/'+number(raw.number),base:text(raw.landingBase),revision:raw.revision,layers:members.sort((a,b)=>a.position-b.position).map(member=>({number:number(member.pullRequestNumber),title:text(member.title),state:member.state,isDraft:member.draft===true,headBranch:text(member.sourceBranch),...(member.headOid?{headSha:member.headOid}:{})}))};
  }
  async stackEffects(n:number,input:{action:'merge'|'update-branch';stackNumber:number;expectedStackHeads:{number:number;headSha:string}[];mergeMethod?:string},signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    const stack=await this.stack(n,signal),land=input.action==='merge';if(!stack||stack.number!==input.stackNumber)throw new Error('GitCafe Stack 已改变');const index=stack.layers.findIndex(layer=>layer.number===n);if(index<0)throw new Error('PR 已不属于此 Stack');const moved=(land?stack.layers.slice(0,index+1):stack.layers).filter(layer=>layer.state!=='merged');
    if(moved.length!==input.expectedStackHeads.length||moved.some(layer=>!layer.headSha||!input.expectedStackHeads.some(expected=>expected.number===layer.number&&expected.headSha===layer.headSha)))throw new Error('GitCafe Stack 提交已改变，请刷新');
    const path=this.repo+'/pulls/stacks/'+stack.number+(land?'/land-through':'/restack'),body=land?{expectedRevision:stack.revision,requestId:randomUUID(),throughPullRequestNumber:n,strategy:input.mergeMethod??'merge'}:{expectedRevision:stack.revision,requestId:randomUUID()};
    return [{key:land?'land-stack':'restack',run:async signal=>{const result=await this.connection.json(path,{method:'POST',body,signal});if(['failed','stopped','cancelled','reconciliation_required'].includes(result.state))throw new Error('GitCafe Stack 操作失败或需要核对');}}];
  }
}
