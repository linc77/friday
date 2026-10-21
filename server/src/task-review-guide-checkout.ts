import type { ChangeRequestStack } from './task-change-request-stack-types.js';
import {createHash} from 'node:crypto';
import {parseDiffFilePaths} from './vendor/t3-diff-file-revisions.js';
import type {ReviewGuideExcerptSnapshot, ReviewGuideStop} from './task-review-guide-types.js';
import {lstat, mkdir, realpath, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {workspaceCommand} from './git-process.js';
import {privateWorkspacePaths, type WorkspacePrivacy} from './workspace-privacy.js';
import {sourceControlRepositoryOnHost, type SourceControlRepository} from './task-change-requests.js';
import {parseReviewGuideChange} from './vendor/t3-review-guide-normalize.js';
export type GuideCheckout = { root: string; path: string; remote: string; remoteDigest: string; paths: {oldPath:string|null;newPath:string|null}[]; baseRef: string; baseCommit: string; headCommit: string; stack?: {number:number;title:string|null;state:string;headSha:string|null}[]; files: string[]; hunks: [string, {new:{start:number;end:number}[];old:{start:number;end:number}[]}][] };
const run = (cwd:string,args:string[],signal?:AbortSignal,limit=1024*1024,extraEnv:Record<string,string>={}) => workspaceCommand(cwd,'git',['-c','core.hooksPath=/dev/null','-c','submodule.recurse=false',...args],{signal,timeout:300_000,limit,env:{GIT_LFS_SKIP_SMUDGE:'1',...extraEnv}});
export async function guideRepository(cwd:string, repository:SourceControlRepository, privacy:WorkspacePrivacy, signal?:AbortSignal) {
  if((await privateWorkspacePaths(cwd,privacy)).includes(''))throw new Error('Guide 不能读取 Friday 私有数据目录');
  const root=await realpath((await run(cwd,['rev-parse','--show-toplevel'],signal)).stdout.trim());
  const names=(await run(root,['remote'],signal)).stdout.trim().split('\n').filter(Boolean),remote=names.includes('origin')?'origin':names[0];
  if(!remote)throw new Error('Guide 需要这个仓库的主远端');
  const url=(await run(root,['config','--get',`remote.${remote}.url`],signal)).stdout.trim(),own=sourceControlRepositoryOnHost(url,repository);
  if(!own||own.provider!==repository.provider||own.host!==repository.host||own.path!==repository.path)throw new Error('请在该 PR／MR 所属仓库的工作区生成 Guide');
  return {root,remote,remoteDigest:createHash('sha256').update(url).digest('hex')};
}
export async function prepareGuideCheckout(directory:string,runID:string,source:{root:string;remote:string;remoteDigest:string},detail:{headSha:string;headBranch:string;baseBranch:string;number:number;stack?:ChangeRequestStack['layers']},signal:AbortSignal):Promise<GuideCheckout> {
  if(!/^[\w-]{1,100}$/.test(runID)||!/^[a-f\d]{7,64}$/i.test(detail.headSha))throw new Error('Guide 检出版本无效');
  const parent=join(directory,'review-guide-checkouts');await mkdir(parent,{recursive:true,mode:0o700});
  const info=await lstat(parent);if(info.isSymbolicLink()||!info.isDirectory()||await realpath(parent)!==join(await realpath(directory),'review-guide-checkouts'))throw new Error('Guide 检出目录无效');
  const owned=join(parent,runID);await mkdir(owned,{recursive:true,mode:0o700});if((await lstat(owned)).isSymbolicLink())throw new Error('Guide 检出目录无效');
  const path=join(owned,'checkout'),baseRef=`refs/friday/review-guide/${runID}/base`;
  await run(source.root,['check-ref-format','--branch',detail.baseBranch],signal);
  if(detail.baseBranch.startsWith('+')||detail.baseBranch.includes(':'))throw new Error('Guide 目标分支名称无效');
  const remoteURL=(await run(source.root,['config','--get',`remote.${source.remote}.url`],signal)).stdout.trim();
  if(createHash('sha256').update(remoteURL).digest('hex')!==source.remoteDigest)throw new Error('Guide 的工作区或远端已改变');
  const pinnedRemote='friday-guide-'+runID,remoteEnv={GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`remote.${pinnedRemote}.url`,GIT_CONFIG_VALUE_0:remoteURL};
  const fetch=(ref:string)=>run(source.root,['fetch','--quiet','--no-tags','--',pinnedRemote,ref],signal,1024*1024,remoteEnv);
  await fetch(`+refs/heads/${detail.baseBranch}:${baseRef}`);
  const baseTip=(await run(source.root,['rev-parse','--verify',baseRef+'^{commit}'],signal)).stdout.trim();
  const fetchHead=async(number:number,reportedSha:string,branch:string)=>{
    if(!/^[a-f\d]{7,64}$/i.test(reportedSha))throw new Error('Guide 堆叠版本无效');
  const resolveHead=async()=>{const value=(await run(source.root,['rev-parse','--verify',reportedSha+'^{commit}'],signal)).stdout.trim();if(!value.startsWith(reportedSha.toLowerCase()))throw new Error('Guide 的提交名称指向其他版本');return value;};
  let headCommit:string|undefined;try{headCommit=await resolveHead();}catch{signal.throwIfAborted();}
  const candidates=[...([40,64].includes(reportedSha.length)?[reportedSha]:[]),`refs/heads/${branch}`,`refs/pull/${number}/head`,`refs/merge-requests/${number}/head`];
  for(const ref of candidates){if(headCommit)break;try{if(ref.startsWith('refs/'))await run(source.root,['check-ref-format',ref],signal);await fetch(ref);headCommit=await resolveHead();}catch{signal.throwIfAborted();}}
  if(!headCommit)throw new Error('无法检出平台报告的 Guide 版本');
  return headCommit;
  };
  const headCommit=await fetchHead(detail.number,detail.headSha,detail.headBranch);
  const stack:NonNullable<GuideCheckout['stack']>=[];
  for(const layer of detail.stack??[]){
    let sha:string|null=null;
    if(layer.number===detail.number)sha=headCommit;
    else if(layer.headSha){try{sha=await fetchHead(layer.number,layer.headSha,layer.headBranch);}catch{signal.throwIfAborted();}}
    stack.push({number:layer.number,title:layer.title??null,state:layer.state,headSha:sha});
  }
  try {
    const existing=await lstat(path);if(existing.isSymbolicLink()||!existing.isDirectory())throw new Error('Guide 检出路径已被占用');
    const [head,common,original]=await Promise.all([run(path,['rev-parse','HEAD'],signal),run(path,['rev-parse','--path-format=absolute','--git-common-dir'],signal),run(source.root,['rev-parse','--path-format=absolute','--git-common-dir'],signal)]);
    if(head.stdout.trim()!==headCommit||common.stdout.trim()!==original.stdout.trim())throw new Error('Guide 检出路径已被其他版本占用');
  } catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await run(source.root,['worktree','add','--detach','--quiet',path,headCommit],signal);}
  const baseCommit=(await run(path,['merge-base',baseTip,'HEAD'],signal)).stdout.trim();if(!/^[a-f\d]{40,64}$/.test(baseCommit))throw new Error('无法确认 Guide 比较基线');
  const diff=(args:string[])=>run(path,['-c','core.quotePath=false','diff','--src-prefix=a/','--dst-prefix=b/','--no-ext-diff','--no-textconv','--no-color',...args,baseCommit+'...HEAD'],signal,64*1024*1024);
  const [names,patch]=await Promise.all([diff(['--name-only','-z']),diff(['--unified=0'])]);
  const change=parseReviewGuideChange(names.stdout,patch.stdout);
  return {...source,path,baseRef,baseCommit,headCommit,stack,files:[...change.files],hunks:[...change.hunks],paths:[...parseDiffFilePaths(patch.stdout)]};
}
export async function cleanupGuideCheckout(directory:string,runID:string,root:string) {
  if(!/^[\w-]{1,100}$/.test(runID))return;
  const parent=join(directory,'review-guide-checkouts'),owned=join(parent,runID),path=join(owned,'checkout');
  try{if((await lstat(parent)).isSymbolicLink()||(await lstat(owned)).isSymbolicLink()||await realpath(parent)!==join(await realpath(directory),'review-guide-checkouts'))return;}catch{return;}
  try{if(!(await lstat(path)).isSymbolicLink())await run(root,['worktree','remove','--force',path],AbortSignal.timeout(15000));}catch{}
  try{await run(root,['update-ref','-d',`refs/friday/review-guide/${runID}/base`],AbortSignal.timeout(15000));}catch{}
  await rm(owned,{recursive:true,force:true}).catch(()=>{});
}

export async function validateGuideCheckout(prepared:GuideCheckout,signal:AbortSignal){
  if((await lstat(prepared.path)).isSymbolicLink())throw new Error('Guide 检出目录无效');
  const [head,common,source]=await Promise.all([run(prepared.path,['rev-parse','HEAD'],signal),run(prepared.path,['rev-parse','--path-format=absolute','--git-common-dir'],signal),run(prepared.root,['rev-parse','--path-format=absolute','--git-common-dir'],signal)]);
  if(head.stdout.trim()!==prepared.headCommit||common.stdout.trim()!==source.stdout.trim())throw new Error('Guide 检出版本已改变');
}
export async function readGuideExcerpts(prepared:GuideCheckout,stops:ReviewGuideStop[],signal:AbortSignal):Promise<ReviewGuideExcerptSnapshot[]>{
  const snapshots:ReviewGuideExcerptSnapshot[]=[],seen=new Set<string>(),hunks=new Map(prepared.hunks);let bytes=0;
  for(const excerpt of stops.flatMap(stop=>stop.excerpts)){
    const key=JSON.stringify([excerpt.path,excerpt.side,excerpt.start,excerpt.end]);if(seen.has(key))continue;seen.add(key);
    const paths=prepared.paths.find(v=>v.newPath===excerpt.path||v.oldPath===excerpt.path),oldPath=paths?.oldPath??undefined,path=excerpt.side==='old'?oldPath??excerpt.path:excerpt.path;
    const ref=(excerpt.side==='old'?prepared.baseCommit:prepared.headCommit)+':'+path;
    try{
      if(bytes>=8*1024*1024)throw new Error('snapshot budget');
      const size=Number((await run(prepared.path,['cat-file','-s',ref],signal)).stdout.trim());if(!Number.isSafeInteger(size)||size>8*1024*1024)throw new Error('large');
      const contents=(await run(prepared.path,['show',ref],signal,8*1024*1024)).stdout;if(contents.includes('\0'))throw new Error('binary');
      const all=contents.split('\n'),ranges=hunks.get(excerpt.path)?.[excerpt.side]??[];
      const lines=all.slice(excerpt.start-1,excerpt.end).map((text,index)=>{const number=excerpt.start+index;const changed=ranges.some(r=>r.start<=number&&number<=r.end);return {number,text:text.replace(/\r$/,''),...(changed?{position:excerpt.side==='new'?{kind:'added' as const,newLine:number}:{kind:'deleted' as const,oldLine:number}}:{})};});
      const length=lines.reduce((sum,line)=>sum+Buffer.byteLength(line.text),0);if(bytes+length>8*1024*1024)throw new Error('snapshot budget');bytes+=length;
      snapshots.push({...excerpt,...(oldPath&&oldPath!==excerpt.path?{oldPath}:{}),lines});
    }catch{signal.throwIfAborted();snapshots.push({...excerpt,lines:[],unavailable:true});}
  }
  return snapshots;
}
