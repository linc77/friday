/*
Adapted from T3 Code 8cd9641f AzureDevOpsSourceControlProvider, AzureDevOpsPullRequestProvider and AzureDevOpsPullRequestCli.
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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { AdditionalSourceControlTransports, AdditionalSourceControlCLIError } from './source-control-provider-transports.js';
import { SourceControlHTTPError } from './source-control-http-errors.js';
import { additionalChangeRequestURL, additionalRepositoryPath, azureRepositoryIdentity, type AdditionalRepositoryIdentity } from './source-control-provider-identity.js';
import type { AdditionalPullRequest, AdditionalChangeRequestDetail, AdditionalChangeRequestActivity, AdditionalChangeRequestInput } from './source-control-provider-models.js';
import type { ChangeRequestEffect } from './task-change-request-data.js';
import type { CollaborationInput } from './task-change-request-collaboration.js';
import type { ChangeRequestFileContents } from './task-change-request-file-contents.js';
import { additionalRawDiffFiles } from './source-control-provider-diff.js';
import { azureDevOpsFilePatch, azureDevOpsUnreadableFilePatch, formatAzureDevOpsDiffCursor, parseAzureDevOpsDiffCursor, byteLength, MAX_DIFF_SLICE_FILES, MAX_DIFF_SLICE_BYTES, MAX_DIFF_SLICE_EDITS, MAX_FILE_DIFF_EDITS } from './vendor/t3-azure-devops-diff.js';
import type { AzureDevOpsChangeEntry } from './vendor/t3-azure-devops-types.js';
const object=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new AdditionalSourceControlCLIError('az','invalid-response');return v as Record<string,any>;};
const record=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const actor=(v:unknown)=>text(record(v).uniqueName)||text(record(v).displayName);
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f\d]{40,64}$/i.test(v);
const number=(v:unknown):number=>{if(!Number.isSafeInteger(v)||Number(v)<1)throw new Error('Azure PR 编号无效');return Number(v);};
const branch=(v:unknown)=>text(v).replace(/^refs\/heads\//,'');
type Iteration={id:number;headCommit:string;mergeBaseCommit:string};
async function parallel<A,B>(items:A[],run:(value:A)=>Promise<B>,limit=4){let next=0;const result:B[]=Array(items.length);await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;result[i]=await run(items[i]);}}));return result;}

export class AzureDevOpsSourceControl {
  readonly identity:Readonly<AdditionalRepositoryIdentity>;
  constructor(private readonly cwd:string,identity:AdditionalRepositoryIdentity,private readonly transport:AdditionalSourceControlTransports){if(identity.provider!=='azure-devops')throw new Error('Azure 连接归属无效');this.identity=Object.freeze(structuredClone(identity));}
  private command(args:string[],signal?:AbortSignal,allowEmpty=false){return this.transport.azureCommand(this.cwd,this.identity,args,{signal,allowEmpty});}
  private invoke(resource:string,n:number,route:Record<string,string|number>={},query:Record<string,string|number>={},signal?:AbortSignal,maxResponseBytes=8*1024*1024){return this.transport.azureInvoke(this.cwd,this.identity,resource,resource==='items'?route:{pullRequestId:number(n),...route},query,{signal,maxResponseBytes});}
  private normalize(raw:Record<string,any>,expected?:number):AdditionalPullRequest{
    const n=number(raw.pullRequestId),head=branch(raw.sourceRefName),base=branch(raw.targetRefName);if(expected!==undefined&&n!==expected||typeof raw.title!=='string'||!head||!base)throw new Error('Azure 返回的 PR 信息无效');
    const repo=record(raw.repository),project=record(repo.project),link=text(record(record(raw._links).web).href),repoURL=text(repo.webUrl)||text(repo.remoteUrl);
    if(link||repoURL){const address=link?link.replace(/\/pullrequest\/\d+(?:[/?#].*)?$/i,''):repoURL,identity=azureRepositoryIdentity(address);if(!identity||identity.canonicalKey!==this.identity.canonicalKey)throw new Error('Azure PR 与所选仓库不一致');}
    else if(text(repo.name).toLowerCase()!==this.identity.name.toLowerCase()||text(project.name).toLowerCase()!==this.identity.project?.toLowerCase())throw new Error('Azure 未返回可确认的仓库身份');
    return {number:n,title:raw.title,url:additionalChangeRequestURL(this.identity,n),state:text(raw.status).toLowerCase()==='completed'?'merged':text(raw.status).toLowerCase()==='abandoned'?'closed':'open',head,base,provider:'azure-devops',host:this.identity.host,repository:this.identity.path};
  }
  private async readPull(n:number,signal?:AbortSignal){const raw=object(await this.command(['repos','pr','show','--id',String(number(n))],signal));this.normalize(raw,n);return raw;}
  async summary(n:number,signal?:AbortSignal){return this.normalize(await this.readPull(n,signal),n);}
  async summaryReading(n:number,signal?:AbortSignal){const observedAt=Date.now(),raw=await this.readPull(n,signal);return summaryFromRaw(this.normalize(raw,n),raw,observedAt);}
  async checkout(n:number,signal?:AbortSignal){const raw=await this.readPull(n,signal),latest=(await this.iterations(n,signal)).at(-1),fork=record(raw.forkSource).repository,source=fork?azureRepositoryIdentity(text(record(fork).remoteUrl)):this.identity;if(!latest||!source)throw new Error('Azure 未返回可确认的源仓库和提交');return {pullRequest:this.normalize(raw,n),headSha:latest.headCommit,source};}
  async repository(signal?:AbortSignal){const raw=object(await this.command(['repos','show','--repository',this.identity.name],signal)),identity=azureRepositoryIdentity(text(raw.remoteUrl)||text(raw.webUrl));if(!identity||identity.canonicalKey!==this.identity.canonicalKey)throw new Error('Azure 仓库归属已改变');return raw;}
  async defaultBranch(signal?:AbortSignal){return branch((await this.repository(signal)).defaultBranch)||undefined;}
  async find(head:string,base?:string,sourceRepository=this.identity.repository,signal?:AbortSignal,includeTerminal=false):Promise<AdditionalPullRequest|null>{
    if(sourceRepository.toLowerCase()!==this.identity.repository.toLowerCase())throw new Error('Azure CLI 无法确认跨仓库源分支');
    const raw=await this.command(['repos','pr','list','--repository',this.identity.name,'--source-branch',head,'--status',includeTerminal?'all':'active','--top','100'],signal);if(!Array.isArray(raw))throw new AdditionalSourceControlCLIError('az','invalid-response');
    const candidates:AdditionalPullRequest[]=[];for(const item of raw){const pr=this.normalize(object(item));if((includeTerminal||pr.state==='open')&&pr.head===head&&(!base||pr.base===base)){if(includeTerminal)candidates.push(taskPullRequestReading(pr,item));else return pr;}}return selectBranchPullRequest(candidates);
  }
  async create(input:{branch:string;base:string;title:string;body:string;sourceRepository?:string},signal?:AbortSignal){
    if(input.sourceRepository&&input.sourceRepository.toLowerCase()!==this.identity.repository.toLowerCase())throw new Error('Azure CLI 无法确认跨仓库源分支');
    const folder=await mkdtemp(join(tmpdir(),'friday-azure-pr-')),file=join(folder,'body.txt');let result:unknown;
    try{await writeFile(file,input.body,{flag:'wx',mode:0o600});result=await this.command(['repos','pr','create','--repository',this.identity.name,'--target-branch',input.base,'--source-branch',input.branch,'--title='+input.title,'--description','@'+file],signal,true);}
    finally{await rm(folder,{recursive:true,force:true});}
    const raw=record(result);if(raw.pullRequestId){const pr=this.normalize(raw);if(pr.head!==input.branch||pr.base!==input.base)throw new Error('Azure PR 创建结果与请求不一致');return pr;}
    const found=await this.find(input.branch,input.base,undefined,signal);if(!found)throw new Error('Azure PR 创建结果尚未确认，请在平台核对');return found;
  }
  async createRepository(signal?:AbortSignal){const raw=object(await this.command(['repos','create','--name',this.identity.name],signal)),identity=azureRepositoryIdentity(text(raw.remoteUrl)),ssh=azureRepositoryIdentity(text(raw.sshUrl));if(!identity||identity.canonicalKey!==this.identity.canonicalKey||!ssh||ssh.canonicalKey!==this.identity.canonicalKey)throw new Error('Azure 仓库创建结果与请求不一致，请在平台核对');let sshURL=text(raw.sshUrl);if(sshURL.startsWith('ssh://')){const url=new URL(sshURL);if(url.password||url.search||url.hash)throw new Error('Azure 返回的 SSH 地址无效');}return {repository:this.identity.repository,url:this.identity.webURL,httpsURL:this.identity.webURL,sshURL};}
  private async iterations(n:number,signal?:AbortSignal):Promise<Iteration[]>{const raw=object(await this.invoke('pullRequestIterations',n,{}, {},signal));if(!Array.isArray(raw.value))throw new AdditionalSourceControlCLIError('az','invalid-response');return raw.value.flatMap(value=>{const item=record(value),head=text(record(item.sourceRefCommit).commitId),base=text(record(item.commonRefCommit).commitId);return Number.isSafeInteger(item.id)&&item.id>0&&sha(head)&&sha(base)?[{id:item.id,headCommit:head,mergeBaseCommit:base}]:[];}).sort((a,b)=>a.id-b.id);}
  private async changes(n:number,iteration:Iteration,signal?:AbortSignal){
    const changes:AzureDevOpsChangeEntry[]=[];let skip=0,truncated=false;
    for(;;){const raw=object(await this.invoke('pullRequestIterationChanges',n,{iterationId:iteration.id},{'$top':2000,'$skip':skip},signal));if(!Array.isArray(raw.changeEntries))throw new AdditionalSourceControlCLIError('az','invalid-response');
      for(const value of raw.changeEntries){const row=record(value),item=record(row.item);if(typeof item.path!=='string'||item.isFolder===true||text(item.gitObjectType||'blob').toLowerCase()!=='blob')continue;const path=item.path.replace(/^\/+/,''),oldPath=(typeof row.sourceServerItem==='string'?row.sourceServerItem.replace(/^\/+/,''):'')||(typeof row.originalPath==='string'?row.originalPath.replace(/^\/+/,''):'')||path;
        try{additionalRepositoryPath(path);additionalRepositoryPath(oldPath);}catch{continue;}const kinds=text(row.changeType).toLowerCase().split(',').map(s=>s.trim()),renamed=oldPath!==path||kinds.includes('rename');
        changes.push({path,oldPath,changeKind:kinds.includes('delete')?'deleted':renamed?kinds.includes('edit')?'rename-changed':'rename-pure':kinds.includes('add')?'new':'change',objectId:text(item.objectId)||null,originalObjectId:text(item.originalObjectId)||null});}
      const next=raw.nextSkip;if(!Number.isSafeInteger(next)||next<=0)break;if(next<=skip||next>=10000){truncated=true;break;}skip=next;
    }return {changes,truncated};
  }
  async detail(n:number,signal?:AbortSignal):Promise<AdditionalChangeRequestDetail>{
    const raw=await this.readPull(n,signal),pr=this.normalize(raw,n),iterations=await this.iterations(n,signal).catch(error=>{if(signal?.aborted)throw error;return [];}),latest=iterations.at(-1);
    const changes=latest?await this.changes(n,latest,signal).catch(error=>{if(signal?.aborted)throw error;return {changes:[],truncated:true};}):{changes:[],truncated:false};
    const merge=text(raw.mergeStatus).toLowerCase(),auto=raw.autoCompleteSetBy!=null,options=record(raw.completionOptions),method=text(options.mergeStrategy).toLowerCase(),autoMethod=method==='squash'?'squash':['rebase','rebasemerge'].includes(method)?'rebase':method==='nofastforward'?'merge':options.squashMerge===true?'squash':undefined;
    const actions:AdditionalChangeRequestDetail['actions']=pr.state==='open'?['merge',raw.isDraft?'ready':'draft','close',auto?'disable-auto-merge':'enable-auto-merge']:pr.state==='closed'?['reopen']:[];
    return {pullRequest:pr,body:typeof raw.description==='string'?raw.description:'',author:actor(raw.createdBy),...(text(record(raw.createdBy).imageUrl)?{authorAvatarURL:raw.createdBy.imageUrl}:{}),createdAt:text(raw.creationDate),updatedAt:text(raw.closedDate)||text(raw.creationDate),...(pr.state==='merged'&&raw.closedDate?{mergedAt:raw.closedDate}:{}),...(pr.state==='closed'&&raw.closedDate?{closedAt:raw.closedDate}:{}),
      isDraft:raw.isDraft===true,headSha:latest?.headCommit??'',...(latest?{baseSha:latest.mergeBaseCommit}:{}),mergeability:merge==='succeeded'?'mergeable':['conflicts','failure','rejectedbypolicy'].includes(merge)?'conflicting':'unknown',autoMergeEnabled:auto,...(auto&&autoMethod?{autoMergeMethod:autoMethod}:{}),
      actions,mergeMethods:['merge','squash'],verdicts:[],canComment:false,changedFiles:changes.changes.length,reviewers:Array.isArray(raw.reviewers)?raw.reviewers.map(actor).filter(Boolean):[],labels:[],checks:[],management:{canEdit:true,canResolve:false,canRequestReviewers:true,canSetLabels:false,canReact:false,viewedFiles:'environment'}};
  }
  async activity(n:number,signal?:AbortSignal):Promise<AdditionalChangeRequestActivity>{
    await this.readPull(n,signal);try{const raw=object(await this.invoke('pullRequestThreads',n,{}, {},signal));if(!Array.isArray(raw.value))throw new AdditionalSourceControlCLIError('az','invalid-response');
      const items=raw.value.flatMap(value=>{const thread=record(value);if(thread.isDeleted===true||!Number.isInteger(thread.id))return [];const path=text(record(thread.threadContext).filePath);
        return (Array.isArray(thread.comments)?thread.comments:[]).flatMap((comment:any)=>comment.isDeleted||text(comment.commentType).toLowerCase()==='system'||!text(comment.content)||!text(comment.publishedDate)?[]:[{id:thread.id+':'+(comment.id??0),kind:path?'review-comment':'issue-comment',author:actor(comment.author),...(text(record(comment.author).imageUrl)?{authorAvatarURL:comment.author.imageUrl}:{}),body:comment.content,createdAt:comment.publishedDate,...(path?{path}:{}),canEdit:false}]);});
      return {items:items.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),truncated:false,threads:[],commits:[],commitsTruncated:false,reactions:[],bySubject:{}};
    }catch(error){if(signal?.aborted)throw error;return {items:[],truncated:true,threads:[],commits:[],commitsTruncated:false,reactions:[],bySubject:{}};}
  }
  private async item(n:number,path:string,commit:string,signal?:AbortSignal){additionalRepositoryPath(path);if(!sha(commit))throw new Error('Azure 文件修订无效');const raw=object(await this.invoke('items',n,{}, {path:'/'+path,'versionDescriptor.versionType':'commit','versionDescriptor.version':commit,includeContent:'true',includeContentMetadata:'true','$format':'json'},signal,4*1024*1024));
    if(raw.content!==undefined&&raw.content!==null&&typeof raw.content!=='string'||record(raw.contentMetadata).isBinary!=null&&typeof raw.contentMetadata.isBinary!=='boolean')throw new AdditionalSourceControlCLIError('az','invalid-response');return {contents:raw.content??'',isBinary:record(raw.contentMetadata).isBinary===true};
  }
  private async texts(n:number,iteration:Iteration,change:AzureDevOpsChangeEntry,signal?:AbortSignal){const empty={contents:'',isBinary:false},controller=new AbortController(),combined=AbortSignal.any([controller.signal,...(signal?[signal]:[])]),protect=async(run:Promise<typeof empty>)=>{try{return await run;}catch(error){controller.abort(error);throw error;}};
    const results=await Promise.allSettled([change.changeKind==='new'?Promise.resolve(empty):protect(this.item(n,change.oldPath,iteration.mergeBaseCommit,combined)),change.changeKind==='deleted'?Promise.resolve(empty):protect(this.item(n,change.path,iteration.headCommit,combined))]);
    const failed=results.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;const old=(results[0] as PromiseFulfilledResult<typeof empty>).value,next=(results[1] as PromiseFulfilledResult<typeof empty>).value;return {oldContents:old.contents,newContents:next.contents,binary:old.isBinary||next.isBinary};}
  private fileFailure(error:unknown){return error instanceof AdditionalSourceControlCLIError&&['failed','invalid-response','not-found'].includes(error.reason)||error instanceof SourceControlHTTPError&&error.status===404;}
  async diff(n:number,input:{head:string;base?:string;cursor?:unknown;commit?:unknown},signal?:AbortSignal){
    await this.readPull(n,signal);const iterations=await this.iterations(n,signal),cursor=typeof input.cursor==='string'?parseAzureDevOpsDiffCursor(input.cursor):null;if(input.cursor!==undefined&&input.cursor!==null&&!cursor)throw new Error('Azure Diff 游标无效');
    const iteration=cursor?iterations.find(value=>value.id===cursor.iterationId):iterations.at(-1);if(!iteration)return {headSha:input.head,baseSha:input.base,patch:'',files:[],truncated:false,nextCursor:null};
    if(iteration.headCommit!==input.head||input.base&&iteration.mergeBaseCommit!==input.base)throw new Error('Azure Diff 版本已改变，请刷新');
    const listed=await this.changes(n,iteration,signal),sections:string[]=[];let index=cursor?.fileIndex??0,bytes=0,edits=0,truncated=listed.truncated,full=false;
    const width=()=>{if(!sections.length)return 4;const admits=(left:number,spent:number)=>Math.ceil(left/Math.max(1,spent/sections.length));return Math.max(1,Math.min(4,MAX_DIFF_SLICE_FILES-sections.length,admits(MAX_DIFF_SLICE_BYTES-bytes,bytes),admits(MAX_DIFF_SLICE_EDITS-MAX_FILE_DIFF_EDITS-edits,edits)));};
    while(!full&&index<listed.changes.length){const batch=listed.changes.slice(index,index+width()),read=await parallel(batch,async change=>{try{return {change,texts:await this.texts(n,iteration,change,signal)};}catch(error){if(signal?.aborted||!this.fileFailure(error))throw error;return {change,texts:null};}});
      for(const row of read){await yieldNow();const file=row.texts===null?azureDevOpsUnreadableFilePatch(row.change):azureDevOpsFilePatch({change:row.change,texts:row.texts});sections.push(file.section);bytes+=byteLength(file.section);edits+=file.edits;truncated||=file.truncated;index++;if(bytes>=MAX_DIFF_SLICE_BYTES||edits+MAX_FILE_DIFF_EDITS>MAX_DIFF_SLICE_EDITS||sections.length>=MAX_DIFF_SLICE_FILES||file.abandoned){full=true;break;}}}
    const patch=sections.join(''),parsed=additionalRawDiffFiles(patch);return {headSha:iteration.headCommit,baseSha:iteration.mergeBaseCommit,patch,files:parsed.files,truncated:truncated||parsed.truncated,fileCursor:formatAzureDevOpsDiffCursor({iterationId:iteration.id,fileIndex:cursor?.fileIndex??0}),nextCursor:index>=listed.changes.length?null:formatAzureDevOpsDiffCursor({iterationId:iteration.id,fileIndex:index})};
  }
  async fileContents(n:number,input:{path:string;head:string;base?:string;side:'old'|'new';cursor?:unknown;commit?:unknown},signal?:AbortSignal):Promise<ChangeRequestFileContents>{
    const path=additionalRepositoryPath(input.path);if(!['old','new'].includes(input.side))throw new Error('Azure 文件范围无效');await this.readPull(n,signal);const iterations=await this.iterations(n,signal),cursor=typeof input.cursor==='string'?parseAzureDevOpsDiffCursor(input.cursor):null;if(input.cursor!==undefined&&input.cursor!==null&&!cursor)throw new Error('Azure Diff 游标无效');const iteration=cursor?iterations.find(value=>value.id===cursor.iterationId):iterations.at(-1);if(!iteration||iteration.headCommit!==input.head||input.base&&iteration.mergeBaseCommit!==input.base)throw new Error('Azure 文件版本已改变');
    const listed=await this.changes(n,iteration,signal),change=listed.changes.find(change=>change.path===path);if(!change)throw new Error('文件不属于此 Azure Diff');const absent=input.side==='old'&&change.changeKind==='new'||input.side==='new'&&change.changeKind==='deleted',revision=absent?null:input.side==='old'?iteration.mergeBaseCommit:iteration.headCommit;
    const result:ChangeRequestFileContents={path,side:input.side,revision,requestHeadSha:input.head,requestBaseSha:iteration.mergeBaseCommit,scopeCommit:null,kind:absent?'absent':'unavailable',mimeType:'text/plain',byteLength:0};if(!revision)return result;
    const value=await this.item(n,input.side==='old'?change.oldPath:change.path,revision,signal),after=(await this.iterations(n,signal)).find(value=>value.id===iteration.id);if(after?.headCommit!==iteration.headCommit||after.mergeBaseCommit!==iteration.mergeBaseCommit)throw new Error('Azure 文件版本已改变');return {...result,byteLength:Buffer.byteLength(value.contents),...(value.isBinary?{reason:'binary' as const}:{kind:'text' as const,text:value.contents})};
  }
  async fileRevisions(n:number,paths:string[],expectedHead:string,signal?:AbortSignal){await this.readPull(n,signal);const latest=(await this.iterations(n,signal)).at(-1);if(!latest||latest.headCommit!==expectedHead)throw new Error('Azure 文件版本已改变');const listed=await this.changes(n,latest,signal),wanted=new Set(paths),revisions=new Map<string,string>();for(const change of listed.changes)if(wanted.has(change.path)&&change.objectId)revisions.set(change.path,change.objectId);if(!listed.truncated)for(const path of paths)if(!revisions.has(path))revisions.set(path,'');return revisions;}
  effects(detail:AdditionalChangeRequestDetail,input:AdditionalChangeRequestInput):ChangeRequestEffect[]{
    this.assertDetail(detail);if(!detail.actions.includes(input.action as any))throw new Error('Azure 暂不支持此操作');const args:string[]=[];
    switch(input.action){case 'merge':if(input.mergeMethod&&!['merge','squash'].includes(input.mergeMethod))throw new Error('Azure 不支持此合并方式');args.push('--status','completed','--squash',input.mergeMethod==='squash'?'true':'false');break;
      case 'enable-auto-merge':args.push('--auto-complete','true');if(input.mergeMethod){if(!['merge','squash'].includes(input.mergeMethod))throw new Error('Azure 不支持此合并方式');args.push('--squash',input.mergeMethod==='squash'?'true':'false');}break;
      case 'disable-auto-merge':args.push('--auto-complete','false');break;case 'ready':case 'draft':args.push('--draft',input.action==='draft'?'true':'false');break;case 'close':case 'reopen':args.push('--status',input.action==='close'?'abandoned':'active');break;default:throw new Error('Azure 暂不支持此操作');}
    return [{key:input.action,run:async signal=>{await this.command(['repos','pr','update','--id',String(detail.pullRequest.number),...args],signal,true);}}];
  }
  private assertDetail(detail:AdditionalChangeRequestDetail){if(detail.pullRequest.provider!=='azure-devops'||detail.pullRequest.host!==this.identity.host||detail.pullRequest.repository!==this.identity.path)throw new Error('Azure 操作归属已改变');}
  async collaborationEffects(detail:AdditionalChangeRequestDetail,input:CollaborationInput):Promise<ChangeRequestEffect[]>{
    this.assertDetail(detail);const n=detail.pullRequest.number;
    if(input.action==='edit_request')return [{key:'edit-request',run:async signal=>{await this.command(['repos','pr','update','--id',String(n),...(input.title===undefined?[]:['--title='+input.title]),...(input.body===undefined?[]:['--description='+input.body])],signal,true);}}];
    if(input.action==='reviewers'){const reviewers=input.reviewers??[];if(!reviewers.length||reviewers.some(value=>value.kind!=='user'||!value.id.trim()||value.id.startsWith('-')))throw new Error('Azure 审查者名称无效');return [{key:'reviewers',run:async signal=>{await this.command(['repos','pr','reviewer',input.requested?'add':'remove','--id',String(n),'--reviewers',...reviewers.map(value=>value.id)],signal,true);}}];}
    throw new Error('此 Azure 版本不支持评论或审查写入');
  }
}
