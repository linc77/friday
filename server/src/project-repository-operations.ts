/* Project publication and tracked cloning follow T3 Code 8cd9641f.
 * MIT, Copyright (c) 2026 T3 Tools Inc.; license: task-sidebar-order.ts.
 * Pi Durable owns the work independently of the requesting client. */
import {createHash,randomUUID} from 'node:crypto';
import {lstat,readdir,realpath} from 'node:fs/promises';
import {lstatSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {defineDocFamily,defineTask,type TaskId} from '@earendil-works/pi-durable';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import type {Engine} from './engine.js';
import {WorkspaceDoc} from './state.js';
import {activeGitOperation,activeStatuses,type Project,type Workspace} from './types.js';
import {directoriesOverlap,branchBlocksTask} from './branch-switch.js';
import {queueRunning} from './task-queue.js';
import {hasRunningBackgroundCommands} from './task-background-commands.js';
import {gitOutputText,taskGit,type workspaceCommand} from './git-process.js';
import {projectChanges} from './projects.js';
import {privateWorkspacePaths} from './workspace-privacy.js';
import {readTaskGitStatus} from './task-git-status.js';
import {verifyManagedProjectFolder} from './managed-project-folders.js';
import {createPublishedRepository,discoverPublishProviders,repositoryPublishInput,validatePublishAccount,type RepositoryPublication,type RepositoryPublishInput} from './task-repository-publish.js';
import {cloneDestination,cloneDirectoryName,discardPartialClone,lookupCloneRepository,normalizeCloneRemote,parseGitCloneProgressLine,prepareCloneDirectory,publicCloneRemote,verifyCloneDirectory,type CloneDirectoryIdentity,type CloneProgress,type CloneRepositoryInfo} from './project-clone.js';

export type ProjectRepositoryOperation={
  id:string;projectId:string;kind:'publish'|'clone';durableId:number;requestId:string;
  status:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted';phase:string;
  cwd:string;createdAt:string;updatedAt:string;error?:string;percent?:number|null;detail?:string|null;
  publication?:RepositoryPublication;publish?:RepositoryPublishInput;branch?:string|null;head?:string|null;
  remoteURL?:string;repository?:CloneRepositoryInfo;identity?:CloneDirectoryIdentity;
  retryOf?:string;
};
export type ProjectCloneSnapshot={operationId:string;phase:'running'|'done'|'failed'|'cancelled';stage:string;percent:number|null;detail:string|null;error:string|null;remoteUrl:string;destinationPath:string;repository?:CloneRepositoryInfo};
const Request=defineDocFamily<{digest?:string;operationId?:string},{id:string}>({kind:'friday.project_repository_request',version:1,scope:'session',family:true,initial:()=>({})});
const CloneInput=defineDocFamily<{remoteURL?:string},{id:string}>({kind:'friday.project_clone_private_input',version:1,scope:'session',family:true,initial:()=>({})});
const stamp=()=>new Date().toISOString(),hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const requestID=(value:unknown):string=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw new Error('项目操作请求无效');return value;};
const active=(operation:ProjectRepositoryOperation)=>operation.status==='queued'||operation.status==='running';
const publicError=(error:unknown)=>gitOutputText(error instanceof Error?error.message:typeof error==='string'?error:'项目操作未完成').replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi,publicCloneRemote).slice(-3000);
const cloneSnapshot=(operation:ProjectRepositoryOperation):ProjectCloneSnapshot=>({operationId:operation.id,phase:active(operation)?'running':'completed'===operation.status?'done':operation.status==='cancelled'?'cancelled':'failed',stage:operation.phase,percent:operation.percent??null,detail:operation.detail??null,error:operation.error??null,remoteUrl:operation.remoteURL??'',destinationPath:operation.cwd,...(operation.repository?{repository:operation.repository}:{})});

export class ProjectRepositoryOperations {
  readonly definition;
  private readonly cloneFinished=new Map<string,Partial<ProjectRepositoryOperation>>();
  private readonly git:typeof taskGit;
  constructor(private readonly engine:Engine,execute?:typeof workspaceCommand){
    this.git=execute?(cwd,args,options={})=>execute(cwd,'git',['--no-pager','-c','core.fsmonitor=false',...(options.hooks?[]:['-c','core.hooksPath=/dev/null']),...args],options):taskGit;
    this.definition=defineTask<{id:string},{phase:'run';index:number},{status:string},{}>({
      name:'friday.project_repository_operation',version:1,initial:()=>({phase:'run',index:0}),
      phases:{run:async(task,runtime,ctx)=>{
        const operation=await this.get(task.input.id),steps=operation.kind==='clone'?[...(operation.retryOf?['discard_clone']:[]),'prepare_clone','clone']:['create_repository','add_remote','publish_push'];
        const index=task.state.checkpoint.index,step=steps[index];
        const finish=async(status:ProjectRepositoryOperation['status'],error?:string)=>{
          await this.patch(operation.id,{status,...(error?{error}:{})});
          await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status}}}),ctx);
        };
        if(!step){await finish('completed');return;}
        const key='step-'+index,completed=await runtime.memo<Partial<ProjectRepositoryOperation>>(key+'-completed',ctx);
        if(completed!==undefined){await this.patch(operation.id,completed);await runtime.commit(()=>({status:'running',checkpoint:{phase:'run',index:index+1}}),ctx);return;}
        if(await runtime.memo<boolean>(key+'-started',ctx)){await finish('interrupted','项目操作的外部结果待核对；不会自动重复克隆、创建仓库或推送。');return;}
        try {
          await this.available(operation);
          await this.patch(operation.id,{status:'running',phase:operation.kind==='clone'?'connecting':step});
          await runtime.memo(key+'-started',true,ctx);
          const result=await this.step(operation,step,runtime.signal);
          await runtime.memo(key+'-completed',result,ctx);await this.patch(operation.id,result);
          await runtime.commit(()=>({status:'running',checkpoint:{phase:'run',index:index+1}}),ctx);
        }catch(error){
          if(runtime.signal.aborted)throw error;
          await finish('failed',publicError(error));
        }
      }},
      abort:async(task,runtime,ctx)=>{
        const operation=await this.get(task.input.id),done=this.cloneFinished.get(operation.id);
        if(done||operation.status==='completed')await this.patch(operation.id,{...done,status:'completed',percent:operation.kind==='clone'?100:operation.percent});
        else{
          let error:string|undefined=operation.kind==='publish'?'发布已停止，请先核对平台和远端；不会自动重复创建仓库。':undefined;
          if(operation.kind==='clone'&&operation.identity){try{await discardPartialClone(operation.identity);}catch(cause){if((cause as NodeJS.ErrnoException).code!=='ENOENT')error=publicError(cause);}}
          await this.patch(operation.id,{status:'cancelled',...(error?{error}:{})});
        }
        await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:{status:done?'completed':'cancelled'}}}),ctx);
      }
    });
  }
  async providers(){return discoverPublishProviders(this.engine.directory,undefined,this.engine.sourceControl);}
  async lookup(raw:unknown,signal?:AbortSignal){return lookupCloneRepository(raw,this.engine.directory,this.engine.sourceControl,signal);}
  private async prior(id:string,digest:string){
    const receipt=await this.engine.harness.snapshot(Request,hash(id),context);
    if(receipt?.digest&&receipt.digest!==digest)throw new Error('项目操作请求 ID 已用于其他内容');
    return receipt?.operationId;
  }
  private idle(state:Workspace,cwd:string,operationId?:string){
    if(branchBlocksTask(state,cwd,operationId)||state.tasks.some(task=>directoriesOverlap(cwd,task.cwd)&&(activeStatuses.includes(task.status)||queueRunning(task)||activeGitOperation(task.gitOperation)||hasRunningBackgroundCommands(task))))throw new Error('此目录有正在执行的任务或 Git 操作，请完成后重试');
  }
  async publish(projectId:string,raw:unknown):Promise<string>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('仓库发布设置无效');const body=raw as Record<string,unknown>,requestId=requestID(body.requestId),input=repositoryPublishInput(body);
    if(input.visibility!=='private')throw new Error('新建项目只支持发布为私有仓库');
    const digest=hash(JSON.stringify(['publish',projectId,input])),old=await this.prior(requestId,digest);if(old)return old;
    const state=await this.engine.snapshot(),project=state.projects.find(project=>project.id===projectId);if(!project)throw new Error('Workspace 不存在');
    this.idle(state,project.path);const privacy={directory:this.engine.directory,projectFolder:project.managedFolder};
    if(project.managedFolder)await verifyManagedProjectFolder(project.managedFolder,this.engine.directory);
    const review=await readTaskGitStatus(project.path,privacy,this.engine.sourceControl);
    if(review.status!=='repository'||!review.root||review.root!==await realpath(project.path)||!review.branch||review.remote||review.upstream)throw new Error('只有尚未配置远端的本地项目分支才能发布');
    const excluded=await privateWorkspacePaths(review.root,privacy);
    if(excluded.includes(''))throw new Error('Friday 私有数据不能作为发布项目');
    if(review.head&&excluded.length&&(await this.git(review.root,['log','-1','--format=%H','HEAD','--',...excluded.map(path=>':(literal)'+path)])).stdout.trim())throw new Error('提交历史包含 Friday 私有数据，已停止发布');
    await validatePublishAccount(project.path,input,undefined,this.engine.sourceControl);
    const id=randomUUID();
    await this.engine.root.commit(async tx=>{
      const receipt=await tx.doc(Request,hash(requestId),{id:hash(requestId)});if(receipt.operationId){if(receipt.digest!==digest)throw new Error('项目操作请求 ID 已用于其他内容');return;}
      const current=await tx.doc(WorkspaceDoc);if(current.projects.find(project=>project.id===projectId)?.path!==project.path)throw new Error('Workspace 已改变');this.idle(current,project.path);
      const durableId=await tx.createTask(this.definition,{id},{ownership:{kind:'conversation'}});
      current.projectRepositoryOperations??=[];current.projectRepositoryOperations.push({id,projectId,kind:'publish',durableId,requestId,status:'queued',phase:'queued',cwd:review.cwd,branch:review.branch,head:review.head,publish:input,createdAt:stamp(),updatedAt:stamp()});
      receipt.operationId=id;receipt.digest=digest;current.revision++;
    },context);
    this.engine.harness.resume();return (await this.prior(requestId,digest))!;
  }
  async clone(raw:unknown):Promise<{projectId:string;operationId:string}>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('克隆参数无效');const body=raw as Record<string,unknown>,requestId=requestID(body.requestId);
    if(body.protocol!==undefined&&!['auto','ssh','https'].includes(String(body.protocol)))throw new Error('克隆传输协议无效');
    const digest=hash(JSON.stringify(['clone',body.remoteURL,body.provider,body.host,body.baseURL,body.repository,body.protocol,body.path,body.name])),old=await this.prior(requestId,digest);if(old){const saved=await this.get(old);return {projectId:saved.projectId,operationId:old};}
    const repository=body.provider?await this.lookup(body):undefined;
    const remote=normalizeCloneRemote(repository?(body.protocol==='https'?repository.httpsURL:repository.sshURL):body.remoteURL),changes=projectChanges({name:body.name??cloneDirectoryName(publicCloneRemote(remote))});
    const cwd=await cloneDestination(body.path,this.engine.directory),projectId=randomUUID(),id=randomUUID();
    await this.engine.root.commit(async tx=>{
      const receipt=await tx.doc(Request,hash(requestId),{id:hash(requestId)});if(receipt.operationId){if(receipt.digest!==digest)throw new Error('项目操作请求 ID 已用于其他内容');return;}
      const state=await tx.doc(WorkspaceDoc);if(state.projects.some(project=>project.path===cwd))throw new Error('这个目录已经添加');this.idle(state,cwd);
      const durableId=await tx.createTask(this.definition,{id},{ownership:{kind:'conversation'}}),at=stamp();
      const operation:ProjectRepositoryOperation={id,projectId,kind:'clone',durableId,requestId,status:'queued',phase:'connecting',percent:null,detail:null,cwd,remoteURL:publicCloneRemote(remote),...(repository?{repository}:{}),createdAt:at,updatedAt:at};
      state.projects.push({id:projectId,path:cwd,context:'',...changes,clone:cloneSnapshot(operation),createdAt:at,updatedAt:at});
      state.projectRepositoryOperations??=[];state.projectRepositoryOperations.push(operation);
      (await tx.doc(CloneInput,id,{id})).remoteURL=remote;receipt.operationId=id;receipt.digest=digest;state.revision++;
    },context);
    this.engine.harness.resume();const saved=await this.get((await this.prior(requestId,digest))!);return {projectId:saved.projectId,operationId:saved.id};
  }
  async retry(projectId:string,id:string,rawRequest:unknown){
    const requestId=requestID(rawRequest),saved=await this.get(id);if(saved.kind!=='clone'||saved.projectId!==projectId||active(saved)||saved.status==='completed')throw new Error('此克隆不能重试');
    const digest=hash(JSON.stringify(['retry',projectId,id])),old=await this.prior(requestId,digest);if(old)return old;
    const source=await this.engine.harness.snapshot(CloneInput,id,context);if(!source?.remoteURL)throw new Error('克隆来源已失效，请重新选择仓库');
    const cwd=saved.cwd,next=randomUUID();
    await this.engine.root.commit(async tx=>{
      const receipt=await tx.doc(Request,hash(requestId),{id:hash(requestId)});if(receipt.operationId)return;
      const state=await tx.doc(WorkspaceDoc),project=state.projects.find(project=>project.id===projectId);if(!project||project.clone?.operationId!==id)throw new Error('Workspace 或克隆记录已改变');this.idle(state,cwd);
      const durableId=await tx.createTask(this.definition,{id:next},{ownership:{kind:'conversation'}}),operation:ProjectRepositoryOperation={id:next,projectId,kind:'clone',durableId,requestId,status:'queued',phase:'connecting',percent:null,detail:null,cwd,remoteURL:saved.remoteURL,...(saved.repository?{repository:saved.repository}:{}),retryOf:id,...(saved.identity?{identity:saved.identity}:{}),createdAt:stamp(),updatedAt:stamp()};
      state.projectRepositoryOperations!.push(operation);project.clone=cloneSnapshot(operation);(await tx.doc(CloneInput,next,{id:next})).remoteURL=source.remoteURL;receipt.digest=digest;receipt.operationId=next;state.revision++;
    },context);
    this.engine.harness.resume();return (await this.prior(requestId,digest))!;
  }
  async get(id:string){const operation=(await this.engine.snapshot()).projectRepositoryOperations?.find(operation=>operation.id===id);if(!operation)throw new Error('项目操作记录不存在');return operation;}
  async cancel(projectId:string,id:string){
    const operation=await this.get(id);if(operation.projectId!==projectId)throw new Error('项目操作不属于此 Workspace');
    if(!active(operation)||this.cloneFinished.has(id))return false;
    await this.engine.harness.abortTask(operation.durableId as TaskId,context);await this.engine.harness.waitForTask(operation.durableId as TaskId,context);return true;
  }
  async discard(projectId:string){
    const operations=(await this.engine.snapshot()).projectRepositoryOperations?.filter(operation=>operation.projectId===projectId)??[];
    for(const operation of operations.filter(active))await this.cancel(projectId,operation.id);
    const latest=operations.filter(operation=>operation.kind==='clone').at(-1);
    if(latest&&latest.status!=='completed'&&!this.cloneFinished.has(latest.id)&&latest.identity){try{await discardPartialClone(latest.identity);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  }
  private async patch(id:string,patch:Partial<ProjectRepositoryOperation>){
    await this.engine.root.commit(async tx=>{
      const state=await tx.doc(WorkspaceDoc),operation=state.projectRepositoryOperations?.find(operation=>operation.id===id);if(!operation)return;
      Object.assign(operation,patch,{updatedAt:stamp()});const project=state.projects.find(project=>project.id===operation.projectId);
      if(operation.kind==='clone'&&project&&(!project.clone||project.clone.operationId===id)){
        project.clone=cloneSnapshot(operation);
        if(operation.identity&&dirname(operation.cwd)===await this.engine.managedProjects.root()){
          project.managedFolder=JSON.parse(JSON.stringify(operation.identity));await this.engine.managedProjects.rememberFolder(tx,project.managedFolder!);
        }
        if(operation.status==='completed')project.updatedAt=stamp();
      }
      state.revision++;
    },context);this.engine.emit('change');
  }
  private async available(operation:ProjectRepositoryOperation){
    const state=await this.engine.snapshot(),project=state.projects.find(project=>project.id===operation.projectId);
    if(!project||project.path!==operation.cwd)throw new Error('Workspace 已删除或目录已改变');
    this.idle(state,operation.cwd,operation.id);
    if(operation.kind==='clone'){if(project.clone?.operationId!==operation.id)throw new Error('克隆记录已改变');return;}
    if(project.managedFolder)await verifyManagedProjectFolder(project.managedFolder,this.engine.directory);
    const review=await readTaskGitStatus(operation.cwd,{directory:this.engine.directory,projectFolder:project.managedFolder},this.engine.sourceControl);
    if(review.status!=='repository'||review.branch!==operation.branch||review.head!==operation.head)throw new Error('项目分支或提交已改变，请核对仓库后继续');
    const remotes=(await this.git(operation.cwd,['remote'])).stdout.trim().split('\n').filter(Boolean);
    if(!operation.publication){if(remotes.length)throw new Error('项目已配置远端，请使用 Git 菜单继续');}
    else if(operation.publication.status!=='created'&&(await this.git(operation.cwd,['remote','get-url',operation.publication.remoteName])).stdout.trim()!==operation.publication.remoteURL)throw new Error('项目远端已改变，请核对后继续');
  }
  private async step(operation:ProjectRepositoryOperation,step:string,signal:AbortSignal):Promise<Partial<ProjectRepositoryOperation>>{
    if(step==='discard_clone'){if(operation.identity){try{await discardPartialClone(operation.identity);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return {};}
    if(step==='prepare_clone')return {identity:await prepareCloneDirectory(operation.cwd,this.engine.directory,signal)};
    if(step==='clone'){
      if(!operation.identity)throw new Error('克隆目录的归属记录不存在');await verifyCloneDirectory(operation.identity);if((await readdir(operation.cwd)).length)throw new Error('克隆目标目录已存在且不为空');
      const input=await this.engine.harness.snapshot(CloneInput,operation.id,context);if(!input?.remoteURL)throw new Error('克隆来源已失效');
      let pending:CloneProgress|undefined,timer:NodeJS.Timeout|undefined,writes=Promise.resolve();
      const errors:string[]=[];
      const flush=()=>{clearTimeout(timer);timer=undefined;const update=pending;pending=undefined;if(update)writes=writes.then(()=>this.patch(operation.id,{phase:update.stage,percent:update.percent,detail:update.detail}));return writes;};
      try {
        await this.git(dirname(operation.cwd),['clone','--progress','--',input.remoteURL,basename(operation.cwd)],{signal,timeout:null,limit:256*1024,truncateStdout:true,streamStderr:true,env:{GIT_PROGRESS_DELAY:'0'},onLine:line=>{
          const text=publicError(line).trim(),value=parseGitCloneProgressLine(text);
          if(value){pending=value;if(!timer)timer=setTimeout(()=>{void flush().catch(()=>{});},150);}
          else if(text&&!text.startsWith('Cloning into')){errors.push(text);if(errors.length>4)errors.shift();}
        }}).catch(error=>{if(!signal.aborted&&errors.length)throw new Error(errors.join(' '));throw error;});
        // Check and record completion in the same JS continuation: a late
        // Cancel must not remove a checkout whose Git process already finished.
        const info=lstatSync(operation.cwd,{bigint:true});
        if(!info.isDirectory()||realpathSync(operation.cwd)!==operation.cwd||String(info.dev)!==operation.identity.device||String(info.ino)!==operation.identity.inode)throw new Error('克隆目录已改变，请在主机核对后重新选择');
        const result={status:'completed' as const,phase:'done',percent:100,error:undefined,detail:null};this.cloneFinished.set(operation.id,result);
        await flush();return result;
      }finally{await flush();}
    }
    if(!operation.publish)throw new Error('仓库发布设置已失效');
    if(step==='create_repository')return {publication:await createPublishedRepository(operation.cwd,operation.publish,signal,this.engine.sourceControl)};
    const publication=operation.publication;if(!publication)throw new Error('仓库发布记录不完整');
    if(step==='add_remote'){
      const remotes=(await this.git(operation.cwd,['remote'])).stdout.trim();if(remotes)throw new Error('远端仓库已创建，请核对当前远端，不要重复发布');
      await this.git(operation.cwd,['remote','add','--',publication.remoteName,publication.remoteURL],{signal});return {publication:{...publication,status:'remote_added'}};
    }
    if(step==='publish_push'){
      if(!operation.head)return {};
      try{await this.git(operation.cwd,['push','--porcelain','--set-upstream','--',publication.remoteName,'refs/heads/'+operation.branch+':refs/heads/'+operation.branch],{signal,timeout:120000,hooks:true});}
      catch{throw new Error('私有仓库已创建并添加远端，首次推送未完成；请在 Git 菜单继续推送，不要重复创建仓库。');}
      return {publication:{...publication,status:'pushed'}};
    }
    throw new Error('项目操作步骤无效');
  }
}
