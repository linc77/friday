/*
Adapted from T3 Code 8cd9641f ForgejoSourceControlProvider, ForgejoPullRequestProvider and forgejoPullRequestJson.
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
import { extname } from 'node:path';
import type { AdditionalHTTPConnection } from './source-control-provider-transports.js';
import { additionalChangeRequestURL, additionalRepositoryPath, forgejoRepositoryIdentity } from './source-control-provider-identity.js';
import type { AdditionalPullRequest, AdditionalChangeRequestDetail, AdditionalChangeRequestActivity, AdditionalChangeRequestInput, AdditionalChangeRequestEffects } from './source-control-provider-models.js';
import type { ChangeRequestActivity, ChangeRequestEffect } from './task-change-request-data.js';
import type { CollaborationInput, ChangeRequestThread, ReviewerCandidate, LabelCandidate } from './task-change-request-collaboration.js';
import type { ReviewReaction, ReviewReactionContent, ReviewStateInput } from './task-change-request-review-state.js';
import { changeRequestFileBytes, type ChangeRequestFileContents } from './task-change-request-file-contents.js';
import { additionalRawDiffFiles } from './source-control-provider-diff.js';
import { parseDiffFileRevisions } from './vendor/t3-diff-file-revisions.js';

const record=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const text=(v:unknown)=>typeof v==='string'?v:'';
const actor=(v:unknown)=>text(record(v).login);
const avatar=(v:unknown)=>{try{const url=new URL(text(record(v).avatar_url));return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}};
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f\d]{40,64}$/i.test(v);
const date=(v:unknown)=>{const s=text(v),time=Date.parse(s);return Number.isFinite(time)?new Date(time).toISOString():s;};
const id=(v:unknown)=>{const s=String(v);if(!/^[1-9]\d*$/.test(s)||!Number.isSafeInteger(Number(s)))throw new Error('Forgejo 资源 ID 无效');return s;};
const repoPath=(value:string)=>{const parts=value.split('/');if(parts.length!==2||parts.some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f\\]/.test(part)))throw new Error('Forgejo 仓库路径无效');return 'repos/'+parts.map(encodeURIComponent).join('/');};
const reactions:Record<ReviewReactionContent,string>={'thumbs-up':'+1','thumbs-down':'-1',laugh:'laugh',hooray:'hooray',confused:'confused',heart:'heart',rocket:'rocket',eyes:'eyes'};
function reactionRows(rows:any[],viewer:string):ReviewReaction[]{return Object.entries(reactions).flatMap(([content,value])=>{const matches=rows.filter(row=>row.content===value);return matches.length?[{content:content as ReviewReactionContent,count:matches.length,actors:matches.map(row=>actor(row.user)).filter(login=>login&&login!==viewer),viewerHasReacted:matches.some(row=>actor(row.user)===viewer)}]:[];});}
async function mapLimit<A,B>(items:A[],limit:number,run:(value:A)=>Promise<B>):Promise<B[]>{const out:B[]=Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const index=next++;out[index]=await run(items[index]);}}));return out;}

export class ForgejoSourceControl {
  readonly identity;private readonly repo:string;
  constructor(private readonly connection:AdditionalHTTPConnection){if(connection.identity.provider!=='forgejo')throw new Error('Forgejo 连接归属无效');this.identity=Object.freeze(structuredClone(connection.identity));this.repo=repoPath(this.identity.repository);}
  private pull(number:number){return this.repo+'/pulls/'+id(number);}
  private issue(number:number){return this.repo+'/issues/'+id(number);}
  private async pages(path:string,signal?:AbortSignal,limit=500){
    const items:any[]=[];for(let page=1;items.length<limit;page++){
      const result=await this.connection.arrayPage(path+(path.includes('?')?'&':'?')+'limit=50&page='+page,{signal});
      const available=limit-items.length;items.push(...result.values.slice(0,available));
      if(!result.values.length||result.hasNext===false)return {items,truncated:result.values.length>available};
      if(result.values.length>available)return {items,truncated:true};
    }return {items,truncated:true};
  }
  private normalize(raw:unknown,expectedNumber?:number):AdditionalPullRequest{
    const value=record(raw),head=record(value.head),base=record(value.base),number=Number(id(value.number));
    if(typeof value.title!=='string'||!text(head.ref)||!text(base.ref)||expectedNumber!==undefined&&number!==expectedNumber)throw new Error('Forgejo 返回的 PR 信息无效');
    const expected=additionalChangeRequestURL(this.identity,number);let url:URL;try{url=new URL(value.html_url);}catch{throw new Error('Forgejo 返回的 PR 地址无效');}
    const target=new URL(expected);if(url.origin!==target.origin||url.username||url.password||url.pathname.replace(/\/$/,'').toLowerCase()!==target.pathname.toLowerCase())throw new Error('Forgejo 返回的 PR 地址与仓库不一致');
    return {number,title:value.title,url:expected,base:base.ref,head:head.ref,state:value.merged?'merged':value.state==='closed'?'closed':'open',provider:'forgejo',host:this.identity.host,repository:this.identity.path};
  }
  async summary(number:number,signal?:AbortSignal){return this.normalize(await this.connection.json(this.pull(number),{signal}),number);}
  async summaryReading(number:number,signal?:AbortSignal){const observedAt=Date.now(),raw=await this.connection.json(this.pull(number),{signal});return summaryFromRaw(this.normalize(raw,number),raw,observedAt);}
  async checkout(number:number,signal?:AbortSignal){const raw=await this.connection.json(this.pull(number),{signal}),pullRequest=this.normalize(raw,number),head=record(raw.head),source=record(head.repo),fullName=text(source.full_name);if(!sha(head.sha))throw new Error('Forgejo 未返回可确认的源提交');const base=this.identity.apiBase.replace(/\/api\/v1\/$/,'');const repository=fullName?forgejoRepositoryIdentity(base+'/'+fullName.split('/').map(encodeURIComponent).join('/'),[{name:this.identity.login??'selected',url:base,user:this.identity.account??'',default:'true',ssh_host:this.identity.sshHost}]):undefined;if(fullName&&!repository)throw new Error('Forgejo 源仓库无效');return {pullRequest,headSha:head.sha,source:repository??null};}
  async find(branch:string,base?:string,sourceRepository=this.identity.repository,signal?:AbortSignal,includeTerminal=false):Promise<AdditionalPullRequest|null>{
    const values=await this.pages(this.repo+'/pulls?'+new URLSearchParams({state:includeTerminal?'all':'open',head:branch,sort:'recentupdate'}),signal);
    const candidates:AdditionalPullRequest[]=[];for(const raw of values.items){if(text(record(raw.head).ref)!==branch||text(record(record(raw.head).repo).full_name)!==sourceRepository)continue;const pr=this.normalize(raw);if((includeTerminal||pr.state==='open')&&(!base||pr.base===base)){if(includeTerminal)candidates.push(taskPullRequestReading(pr,raw));else return pr;}}return selectBranchPullRequest(candidates);
  }
  async create(input:{branch:string;base:string;title:string;body:string;sourceRepository?:string},signal?:AbortSignal){
    const source=input.sourceRepository??this.identity.repository;repoPath(source);const head=source!==this.identity.repository?source.split('/')[0]+':'+input.branch:input.branch;
    const result=this.normalize(await this.connection.json(this.repo+'/pulls',{method:'POST',signal,body:{base:input.base,head,title:input.title,body:input.body}}));
    if(result.head!==input.branch||result.base!==input.base||result.state!=='open')throw new Error('Forgejo 创建结果与请求不一致，请在平台核对');return result;
  }
  async repository(signal?:AbortSignal){const value=await this.connection.json(this.repo,{signal});if(text(value.full_name).toLowerCase()!==this.identity.repository.toLowerCase())throw new Error('Forgejo 返回的仓库归属无效');return value;}
  async defaultBranch(signal?:AbortSignal){return text((await this.repository(signal)).default_branch)||undefined;}
  async createRepository(visibility:'private'|'public',signal?:AbortSignal){
    const user=await this.connection.json('user',{signal}),[owner,name]=this.identity.repository.split('/');
    const raw=await this.connection.json(owner===user.login?'user/repos':'orgs/'+encodeURIComponent(owner)+'/repos',{method:'POST',signal,body:{name,private:visibility==='private',auto_init:false}});
    if(text(raw.full_name).toLowerCase()!==this.identity.repository.toLowerCase()||raw.private!==(visibility==='private'))throw new Error('Forgejo 仓库创建结果与请求不一致，请在平台核对');
    const url=this.identity.webURL,httpsURL=url+'.git',sshURL=text(raw.ssh_url);let web:URL,clone:URL;
    try{web=new URL(raw.html_url);clone=new URL(raw.clone_url);}catch{throw new Error('Forgejo 返回的仓库地址无效');}
    const ssh=/^(?:[^\s@/]+@)?([^:/]+):(.+)$/.exec(sshURL);let sshHost=ssh?.[1],sshPath=ssh?.[2];
    if(sshURL.startsWith('ssh://')){const parsed=new URL(sshURL);if(parsed.password||parsed.search||parsed.hash)throw new Error('Forgejo 返回的 SSH 地址无效');sshHost=parsed.hostname;sshPath=parsed.pathname.replace(/^\//,'');}
    const host=new URL(this.identity.webURL).hostname,allowed=[host,this.identity.sshHost];
    if(web.href.replace(/\/$/,'').toLowerCase()!==url.toLowerCase()||web.username||web.password||clone.href.toLowerCase()!==httpsURL.toLowerCase()||clone.username||clone.password||!sshHost||!allowed.includes(sshHost)||sshPath?.replace(/\.git$/,'').toLowerCase()!==this.identity.repository.toLowerCase())throw new Error('Forgejo 返回的克隆地址与仓库不一致，请在平台核对');
    return {repository:this.identity.repository,url,httpsURL,sshURL};
  }
  async detail(number:number,signal?:AbortSignal):Promise<AdditionalChangeRequestDetail>{
    const [raw,repo,user]=await Promise.all([this.connection.json(this.pull(number),{signal}),this.repository(signal),this.connection.json('user',{signal})]);
    const pr=this.normalize(raw,number),viewer=actor(user);if(!viewer||!sha(record(raw.head).sha)||!sha(record(raw.base).sha))throw new Error('Forgejo 未返回可确认的账号或代码版本');
    const status=await this.pages(this.repo+'/statuses/'+record(raw.head).sha+'?sort=recentupdate',signal),checks=new Map<string,{name:string;state:string;url?:string}>();
    for(const row of [...status.items].sort((a,b)=>text(b.updated_at).localeCompare(text(a.updated_at)))){const name=text(row.context)||'check';if(checks.has(name))continue;let url:string|undefined;try{const u=new URL(text(row.target_url),pr.url);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password)url=u.href;}catch{}checks.set(name,{name,state:row.status==='success'?'success':['failure','error'].includes(row.status)?'failure':'pending',...(url?{url}:{})});}
    const canWrite=record(repo.permissions).push===true,canEdit=canWrite||actor(raw.user)===viewer,active=repo.archived!==true;
    const actions:AdditionalChangeRequestDetail['actions']=!active?[]:pr.state==='open'?[...(canWrite?['merge' as const,'update-branch' as const]:[]),...(canEdit?['close' as const]:[])]:pr.state==='closed'&&canEdit?['reopen']:[];
    const methods=[['merge',repo.allow_merge_commits],['squash',repo.allow_squash_merge],['rebase',repo.allow_rebase]].filter(([,enabled])=>enabled!==false).map(([method])=>String(method));
    return {pullRequest:pr,body:text(raw.body),author:actor(raw.user),authorAvatarURL:avatar(raw.user),createdAt:date(raw.created_at),updatedAt:date(raw.updated_at),...(raw.merged_at?{mergedAt:date(raw.merged_at)}:{}),...(raw.closed_at?{closedAt:date(raw.closed_at)}:{}),
      isDraft:raw.draft??/^(?:\[WIP\]|WIP:)/i.test(raw.title),headSha:raw.head.sha,baseSha:text(raw.merge_base)||raw.base.sha,mergeability:raw.mergeable===true?'mergeable':'unknown',
      actions,mergeMethods:methods,verdicts:!active?[]:actor(raw.user)===viewer?['comment']:['comment','approve','request-changes'],canComment:active&&(!raw.is_locked||canWrite),
      updateMethods:active&&canWrite?(repo.allow_rebase_update?['merge','rebase']:['merge']):[],baseComparison:!raw.merge_base?'unknown':raw.merge_base===raw.base.sha?'up-to-date':'behind',
      additions:raw.additions??0,deletions:raw.deletions??0,changedFiles:raw.changed_files??0,reviewers:Array.isArray(raw.requested_reviewers)?raw.requested_reviewers.map(actor).filter(Boolean):[],labels:Array.isArray(raw.labels)?raw.labels.map((v:any)=>text(v.name)):[],checks:[...checks.values()],
      management:{viewer,canEdit:active&&canEdit,canResolve:false,canRequestReviewers:active&&canEdit,canSetLabels:active&&canWrite,canReact:true,viewedFiles:'environment'}};
  }
  private write(key:string,path:string,method:'POST'|'PATCH'|'PUT'|'DELETE',body?:Record<string,unknown>):ChangeRequestEffect{return {key,run:async signal=>{await this.connection.json(path,{method,signal,body,allowEmpty:true});}};}
  effects(detail:AdditionalChangeRequestDetail,input:AdditionalChangeRequestInput):AdditionalChangeRequestEffects{
    const path=this.pull(detail.pullRequest.number);if(detail.pullRequest.host!==this.identity.host||detail.pullRequest.repository!==this.identity.path)throw new Error('Forgejo 操作归属已改变');
    if(input.action==='comment'){if(!detail.canComment)throw new Error('当前账号不能评论');return [this.write('comment',this.issue(detail.pullRequest.number)+'/comments','POST',{body:input.body??''})];}
    if(input.action==='review'){
      if(!input.verdict||!detail.verdicts.includes(input.verdict))throw new Error('当前账号不支持这项审查结论');if(input.verdict==='request-changes'&&!input.body?.trim())throw new Error('请求修改需要填写审查摘要');
      const comments=(input.comments??[]).map(comment=>{const p=comment.position,old=p.kind==='deleted'||p.kind==='context'&&p.side==='left';return {path:old?comment.oldPath??comment.path:comment.path,body:comment.body,old_position:old?p.oldLine:0,new_position:old?0:p.newLine};});
      return [this.write('review',path+'/reviews','POST',{event:input.verdict==='approve'?'APPROVED':input.verdict==='request-changes'?'REQUEST_CHANGES':'COMMENT',body:input.body??'',commit_id:detail.headSha,comments})];
    }
    if(!detail.actions.includes(input.action as any))throw new Error('当前状态或账号不支持这项 Forgejo 操作');
    if(input.action==='merge'){const method=input.mergeMethod??detail.mergeMethods[0];if(!detail.mergeMethods.includes(method))throw new Error('仓库不支持这种合并方式');return [this.write('merge',path+'/merge','POST',{Do:method})];}
    if(input.action==='close'||input.action==='reopen')return [this.write(input.action,path,'PATCH',{state:input.action==='close'?'closed':'open'})];
    if(input.action==='update-branch'){const method=input.updateMethod??'merge';if(!detail.updateMethods?.includes(method))throw new Error('仓库不支持这种更新方式');return [this.write('update-branch',path+'/update?style='+encodeURIComponent(method),'POST')];}
    throw new Error('Forgejo 不支持此操作');
  }
  async activity(number:number,signal?:AbortSignal):Promise<AdditionalChangeRequestActivity>{
    const [issue,reviews,commits,rootReactions,viewerRaw]=await Promise.all([this.connection.arrayPage(this.issue(number)+'/comments',{signal}),this.pages(this.pull(number)+'/reviews',signal),this.pages(this.pull(number)+'/commits?files=false&verification=false',signal),this.pages(this.issue(number)+'/reactions',signal),this.connection.json('user',{signal})]);
    const viewer=actor(viewerRaw);if(!viewer)throw new Error('无法确认 Forgejo 审查账号');
    const groups=await mapLimit(reviews.items.filter(row=>row.comments_count>0&&row.state!=='PENDING'),4,async review=>(await this.connection.arrayPage(this.pull(number)+'/reviews/'+id(review.id)+'/comments',{signal})).values);
    const allInline=groups.flat(),inline=allInline.slice(0,500),entries:{item:ChangeRequestActivity;reactionID?:string}[]=[];
    const comment=(row:any,kind:'issue-comment'|'review-comment'):ChangeRequestActivity=>({id:id(row.id),kind,sourceID:id(row.id),commentKind:kind,body:text(row.body),author:actor(row.user),authorAvatarURL:avatar(row.user),createdAt:date(row.created_at),...(row.updated_at&&row.updated_at!==row.created_at?{editedAt:date(row.updated_at)}:{}),...(row.html_url?{url:text(row.html_url)}:{}),canEdit:actor(row.user)===viewer,...(kind==='review-comment'?{path:text(row.path)}:{})});
    for(const row of issue.values.slice(0,500))entries.push({item:comment(row,'issue-comment'),reactionID:id(row.id)});
    for(const row of reviews.items.filter(row=>!['PENDING','REQUEST_REVIEW'].includes(row.state)))entries.push({item:{id:'review:'+id(row.id),kind:'review',author:actor(row.user),body:text(row.body),createdAt:date(row.submitted_at),state:row.state==='REQUEST_CHANGES'?'CHANGES_REQUESTED':row.state==='COMMENT'?'COMMENTED':text(row.state),...(row.html_url?{url:text(row.html_url)}:{})},reactionID:/#issuecomment-([1-9]\d*)$/.exec(text(row.html_url))?.[1]});
    for(const row of inline)entries.push({item:comment(row,'review-comment'),reactionID:id(row.id)});
    const bySubject:Record<string,ReviewReaction[]>={};await mapLimit(entries,4,async row=>{if(row.reactionID){const result=await this.connection.arrayPage(this.repo+'/issues/comments/'+row.reactionID+'/reactions',{signal});bySubject[row.item.id]=reactionRows(result.values,viewer);}});
    const byId=new Map(entries.map(row=>[row.item.id,row.item]));const threads:ChangeRequestThread[]=inline.map(row=>{const old=row.position===0&&row.original_position>0,line=old?row.original_position:row.position,item=byId.get(id(row.id))!;return {id:id(row.id),path:text(row.path),...(line>0?{line}:{}),side:old?'left':'right',isResolved:row.resolver!=null,isOutdated:false,canResolve:false,comments:[{...item,commentKind:'review-comment',reactions:bySubject[item.id]}],commentCount:1};});
    return {items:entries.map(row=>row.item).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),truncated:issue.values.length>500||reviews.truncated||allInline.length>500,threads,
      commits:commits.items.map(row=>({oid:text(row.sha),messageHeadline:text(record(row.commit).message).split('\n')[0],committedDate:date(record(record(row.commit).committer).date),authors:actor(row.author)?[{login:actor(row.author),...(record(row.author).full_name?{name:text(row.author.full_name)}:{})}]:[],...(row.stats?{additions:row.stats.additions,deletions:row.stats.deletions}:{})})),commitsTruncated:commits.truncated,reactions:reactionRows(rootReactions.items,viewer),bySubject};
  }
  async reviewers(number:number,signal?:AbortSignal){const [pr,users]=await Promise.all([this.connection.json(this.pull(number),{signal}),this.pages(this.repo+'/assignees',signal)]);return {candidates:users.items.filter(row=>actor(row)!==actor(pr.user)&&actor(row)).map((row):ReviewerCandidate=>({id:actor(row),kind:'user',login:actor(row),...(row.full_name?{name:row.full_name}:{}),isRequested:Array.isArray(pr.requested_reviewers)&&pr.requested_reviewers.some((reviewer:any)=>actor(reviewer)===actor(row))})),truncated:users.truncated};}
  async labels(number:number,signal?:AbortSignal){const [pr,labels]=await Promise.all([this.connection.json(this.pull(number),{signal}),this.pages(this.repo+'/labels',signal)]);return {candidates:labels.items.map((row):LabelCandidate=>({name:text(row.name),...(row.color?{color:row.color}:{}),...(row.description?{description:row.description}:{}),isApplied:Array.isArray(pr.labels)&&pr.labels.some((applied:any)=>applied.id===row.id)})),truncated:labels.truncated};}
  async collaborationEffects(detail:AdditionalChangeRequestDetail,input:CollaborationInput,signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    if(detail.pullRequest.host!==this.identity.host||detail.pullRequest.repository!==this.identity.path)throw new Error('Forgejo 操作归属已改变');
    const number=detail.pullRequest.number,path=this.pull(number),management=detail.management;
    if(input.action==='reply'||input.action==='resolve')throw new Error('Forgejo API 不支持线程回复或解决状态');
    if(input.action==='edit_request'){if(!management?.canEdit)throw new Error('当前账号不能编辑此 PR');return [this.write('edit-request',path,'PATCH',{...(input.title===undefined?{}:{title:input.title}),...(input.body===undefined?{}:{body:input.body})})];}
    if(input.action==='edit_comment'){const activity=await this.activity(number,signal),comment=activity.items.find(row=>row.id===input.commentId&&row.commentKind===input.commentKind);if(!comment?.canEdit)throw new Error('评论已改变或不属于当前账号');return [this.write('edit-comment',this.repo+'/issues/comments/'+id(input.commentId),'PATCH',{body:input.body})];}
    if(input.action==='reviewers'){if(!management?.canRequestReviewers||input.reviewers?.some(row=>row.kind!=='user'))throw new Error('Forgejo 不支持这些审查者');return [this.write('reviewers',path+'/requested_reviewers',input.requested?'POST':'DELETE',{reviewers:input.reviewers?.map(row=>row.id)??[]})];}
    if(!management?.canSetLabels)throw new Error('当前账号不能修改标签');const labels=await this.pages(this.repo+'/labels',signal),selected=labels.items.filter(row=>input.labels?.includes(row.name));if(selected.length!==input.labels?.length)throw new Error('所选标签已改变，请刷新');
    return input.applied?[this.write('labels',this.issue(number)+'/labels','POST',{labels:selected.map(row=>Number(id(row.id)))})]:selected.map(row=>this.write('label-'+id(row.id),this.issue(number)+'/labels/'+id(row.id),'DELETE'));
  }
  async reactionEffects(number:number,input:ReviewStateInput,signal?:AbortSignal):Promise<ChangeRequestEffect[]>{
    if(input.action!=='reaction'||!input.content||!Object.hasOwn(reactions,input.content))throw new Error('Forgejo reaction 无效');let subject=input.subjectId;
    if(subject){const activity=await this.activity(number,signal);if(!activity.items.some(row=>row.id===subject))throw new Error('reaction 资源不属于此 PR');if(subject.startsWith('review:')){const review=await this.connection.json(this.pull(number)+'/reviews/'+id(subject.slice(7)),{signal});subject=/#issuecomment-([1-9]\d*)$/.exec(text(review.html_url))?.[1];if(!subject)throw new Error('Forgejo 未返回审查评论 ID');}else id(subject);}
    return [this.write('reaction',subject?this.repo+'/issues/comments/'+subject+'/reactions':this.issue(number)+'/reactions',input.reacted?'POST':'DELETE',{content:reactions[input.content]})];
  }
  async diff(number:number,expectedHead:string,commit?:string,signal?:AbortSignal){
    const before=await this.connection.json(this.pull(number),{signal});this.normalize(before,number);if(record(before.head).sha!==expectedHead)throw new Error('PR 代码版本已改变，请刷新');
    if(commit){if(!sha(commit))throw new Error('提交版本无效');const commits=await this.pages(this.pull(number)+'/commits?files=false&verification=false',signal);if(!commits.items.some(row=>row.sha===commit))throw new Error('提交不属于此 PR');}
    const patch=await this.connection.text(commit?this.repo+'/git/commits/'+commit+'.diff':this.pull(number)+'.diff',{signal,maxResponseBytes:8*1024*1024}),after=await this.connection.json(this.pull(number),{signal});this.normalize(after,number);if(record(after.head).sha!==expectedHead||record(after.base).sha!==record(before.base).sha||after.merge_base!==before.merge_base)throw new Error('PR 的 Diff 范围已改变，请刷新');
    return {patch,...additionalRawDiffFiles(patch),headSha:expectedHead,baseSha:text(before.merge_base)||text(record(before.base).sha)};
  }
  async fileRevisions(number:number,paths:string[],expectedHead:string,signal?:AbortSignal){const diff=await this.diff(number,expectedHead,undefined,signal),result=new Map(parseDiffFileRevisions(diff.patch));for(const path of paths)if(!result.has(path))result.set(path,'');return result;}
  async fileContents(number:number,input:{path:string;head:string;side:'old'|'new';commit?:string;base?:string},signal?:AbortSignal):Promise<ChangeRequestFileContents>{
    if(!['old','new'].includes(input.side)||!sha(input.head))throw new Error('PR 文件范围无效');
    const path=additionalRepositoryPath(input.path),diff=await this.diff(number,input.head,input.commit,signal),file=diff.files.find(file=>file.path===path);if(!file)throw new Error('文件不属于此 PR Diff');if(input.base&&input.base!==diff.baseSha)throw new Error('PR 的 Diff 基准已改变，请刷新');
    const raw=await this.connection.json(this.pull(number),{signal});this.normalize(raw,number);if(record(raw.head).sha!==input.head||(text(raw.merge_base)||text(record(raw.base).sha))!==diff.baseSha)throw new Error('PR 代码版本已改变，请刷新');let oldRef=diff.baseSha,newRef=input.head;
    if(input.commit){const commit=await this.connection.json(this.repo+'/git/commits/'+input.commit+'?files=false&verification=false',{signal});if(commit.sha!==input.commit||!Array.isArray(commit.parents))throw new Error('提交版本无效');oldRef=text(record(commit.parents[0]).sha);newRef=input.commit;}
    const absent=input.side==='old'&&file.status==='added'||input.side==='new'&&file.status==='removed',revision=absent?null:input.side==='old'?oldRef:newRef;
    const result:ChangeRequestFileContents={path,side:input.side,revision,requestHeadSha:input.head,requestBaseSha:diff.baseSha,scopeCommit:input.commit??null,kind:absent?'absent':'unavailable',mimeType:'text/plain',byteLength:0};if(!revision)return {...result,kind:'absent'};
    if(!sha(revision))throw new Error('文件修订版本无效');const target=input.side==='old'?this.identity.repository:text(record(record(raw.head).repo).full_name)||this.identity.repository,targetPath=input.side==='old'?file.oldPath??path:path;
    const images:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.svg':'image/svg+xml'},mime=images[extname(targetPath).toLowerCase()],limit=mime?4*1024*1024:8*1024*1024;
    const content=await this.connection.json(repoPath(target)+'/contents/'+targetPath.split('/').map(encodeURIComponent).join('/')+'?ref='+revision,{signal,maxResponseBytes:8*1024*1024}),decoded=changeRequestFileBytes(content,limit,targetPath);
    const after=await this.connection.json(this.pull(number),{signal});this.normalize(after,number);if(record(after.head).sha!==input.head||record(after.base).sha!==record(raw.base).sha||after.merge_base!==raw.merge_base)throw new Error('PR 文件范围已改变，请刷新');
    if(!decoded.data)return {...result,byteLength:decoded.size,reason:decoded.reason};if(mime)return {...result,kind:'image',mimeType:mime,byteLength:decoded.size,base64:decoded.data.toString('base64')};
    let value:string;try{value=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(decoded.data);}catch{return {...result,byteLength:decoded.size,reason:'binary'};}if(value.includes('\0'))return {...result,byteLength:decoded.size,reason:'binary'};return {...result,kind:'text',byteLength:decoded.size,text:value};
  }
}
