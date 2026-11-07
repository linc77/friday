/* T3 Code 8cd9641f ProjectCloneTracker / gitCloneProgress / repository service.
 * MIT, Copyright (c) 2026 T3 Tools Inc.; full license: task-sidebar-order.ts. */
import {lstat,mkdir,readdir,realpath,rm} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {canonicalWorkspacePath,privateWorkspacePaths} from './workspace-privacy.js';
import type {SourceControlConnections} from './source-control-connections.js';
import {sourceControlHost} from './source-control-credentials.js';
import {sourceControlProviderDefinitions,sourceControlProviders,type SourceControlProvider} from './source-control-provider.js';
import type {ManagedProjectFolder} from './managed-project-folders.js';

export type CloneStage='connecting'|'counting'|'receiving'|'resolving'|'checkout';
export type CloneProgress={stage:CloneStage;percent:number|null;detail:string|null};
export function parseGitCloneProgressLine(line:string):CloneProgress|null {
  const text=line.trim(),stages:[RegExp,CloneStage][]=[[/^remote: (Enumerating|Counting|Compressing) objects/,'counting'],[/^Receiving objects/,'receiving'],[/^Resolving deltas/,'resolving'],[/^(Updating|Checking out) files/,'checkout']];
  const stage=stages.find(([pattern])=>pattern.test(text))?.[1];if(!stage)return null;
  const match=/:\s+(\d+)%\s+\((\d+)\/(\d+)\)(?:,\s*(.*?))?\s*(?:,\s*done\.)?\s*$/.exec(text);
  const detail=match?.[4]?.trim(),percent=match?Number(match[1]):NaN;return {stage,percent:Number.isFinite(percent)?Math.max(0,Math.min(100,percent)):null,detail:detail&&detail!=='done.'?detail:null};
}
export function publicCloneRemote(remote:string) {
  try {const url=new URL(remote);if(!url.username&&!url.password&&!url.search)return remote;url.username='';url.password='';url.search='';return url.toString();}catch{return remote;}
}
export function normalizeCloneRemote(raw:unknown):string {
  if(typeof raw!=='string'||!raw.trim()||raw.length>8192||/[\x00-\x1f\x7f]/.test(raw))throw new Error('请输入仓库地址');
  const remote=raw.trim();return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+(?:\.git)?$/.test(remote)?'https://github.com/'+remote+(remote.endsWith('.git')?'':'.git'):remote;
}
export function cloneDirectoryName(remote:string) {
  const value=remote.split(/[?#]/)[0]?.trim()??'',scheme=value.indexOf('://'),hasHost=scheme>=0||/^[^/\\:]+@[^/\\:]+:/.test(value),parts=(scheme>=0?value.slice(scheme+3):value).split(/[/\\:]+/).filter(Boolean);
  if(hasHost&&(parts.length<2||parts.length===2&&/^\d+$/.test(parts.at(-1)!)))return '';
  const name=parts.at(-1)??'';return name.endsWith('.git')?name.slice(0,-4):name;
}
export type CloneRepositoryInfo={provider:SourceControlProvider;nameWithOwner:string;url:string;httpsURL:string;sshURL:string};
export async function lookupCloneRepository(raw:unknown,cwd:string,connections:SourceControlConnections,signal?:AbortSignal):Promise<CloneRepositoryInfo> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('仓库查询参数无效');const value=raw as Record<string,unknown>;
  if(!(sourceControlProviders as readonly unknown[]).includes(value.provider)||typeof value.repository!=='string'||!value.repository.trim()||value.repository.length>500||/[\x00-\x1f\x7f]/.test(value.repository))throw new Error('仓库查询参数无效');
  const provider=value.provider as SourceControlProvider,host=sourceControlHost(value.host??sourceControlProviderDefinitions[provider].host),repository=value.repository.trim().replace(/\.git$/,'');
  if(repository.split('/').length<2||repository.split('/').some(part=>!part||part==='.'||part==='..'||part.includes('\\')))throw new Error('请填写完整的所有者／仓库名称');
  const base=provider==='forgejo'&&typeof value.baseURL==='string'?value.baseURL.replace(/\/+$/,''):'https://'+host;
  const webURL=provider==='azure-devops'?base+'/'+repository.split('/').slice(0,2).map(encodeURIComponent).join('/')+'/_git/'+encodeURIComponent(repository.split('/').slice(2).join('/')):base+'/'+repository.split('/').map(encodeURIComponent).join('/');
  let rawRepo:Record<string,any>;
  if(provider==='forgejo'||provider==='gitcafe'||provider==='azure-devops') {
    const identity=await connections.repository(cwd,webURL,signal);if(!identity?.additional||identity.provider!==provider)throw new Error('请检查仓库平台的主机与服务路径');
    const pinned=await connections.pinRepository(cwd,identity,signal);return pinned.additional!.cloneRepositoryInfo(signal);
  }
  const pinned=await connections.pin(cwd,provider,host,signal);
  rawRepo=await pinned.json(provider==='github'?'repos/'+repository:provider==='gitlab'?'projects/'+encodeURIComponent(repository):'repositories/'+repository,{signal});
  const actual=provider==='gitlab'?rawRepo.path_with_namespace:rawRepo.full_name;
  if(typeof actual!=='string'||actual.toLowerCase()!==repository.toLowerCase())throw new Error('平台返回的仓库归属不一致');
  const urls=provider==='bitbucket'&&Array.isArray(rawRepo.links?.clone)?rawRepo.links.clone:[];
  const http=provider==='github'?rawRepo.clone_url:provider==='gitlab'?rawRepo.http_url_to_repo:urls.find((value:any)=>value.name==='https')?.href;
  const ssh=provider==='github'?rawRepo.ssh_url:provider==='gitlab'?rawRepo.ssh_url_to_repo:urls.find((value:any)=>value.name==='ssh')?.href;
  const web=provider==='github'?rawRepo.html_url:provider==='gitlab'?rawRepo.web_url:rawRepo.links?.html?.href;
  return verifiedCloneURLs({provider,nameWithOwner:actual,url:web,httpsURL:http,sshURL:ssh},host,repository);
}
export function verifiedCloneURLs(value:CloneRepositoryInfo,host:string,repository:string):CloneRepositoryInfo {
  if(typeof value.url!=='string'||typeof value.httpsURL!=='string'||typeof value.sshURL!=='string')throw new Error('平台没有返回可用的克隆地址');
  const web=new URL(value.url),http=new URL(value.httpsURL);http.username='';http.password='';http.search='';http.hash='';
  if(!['http:','https:'].includes(web.protocol)||web.host!==host||web.username||web.password||web.search||web.hash||http.host!==host||!['http:','https:'].includes(http.protocol)||web.pathname.replace(/\/+$/,'').toLowerCase()!=='/'+repository.toLowerCase()||http.pathname.replace(/\.git$/,'').toLowerCase()!=='/'+repository.toLowerCase())throw new Error('平台返回的克隆地址与仓库不一致');
  const match=value.sshURL.match(/^[^@\s]+@([^:\s]+):(.+)$/);let sshHost=match?.[1],sshPath=match?.[2];
  if(!match){const ssh=new URL(value.sshURL);if(ssh.protocol!=='ssh:'||ssh.password||ssh.search||ssh.hash)throw new Error('平台返回的 SSH 地址无效');sshHost=ssh.hostname;sshPath=ssh.pathname.replace(/^\//,'');}
  if(sshHost!==web.hostname||sshPath?.replace(/\.git$/,'').toLowerCase()!==repository.toLowerCase())throw new Error('平台返回的 SSH 仓库不一致');
  return {...value,httpsURL:http.toString()};
}
export type CloneDirectoryIdentity=ManagedProjectFolder;
export async function verifyCloneDirectory(identity:CloneDirectoryIdentity) {
  const info=await lstat(identity.root,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||await realpath(identity.root)!==identity.root||String(info.dev)!==identity.device||String(info.ino)!==identity.inode)throw new Error('克隆目录已改变，请在主机核对后重新选择');
}
export async function cloneDestination(raw:unknown,directory:string):Promise<string> {
  if(typeof raw!=='string'||!raw.trim()||raw.length>4096||/[\x00-\x1f\x7f]/.test(raw))throw new Error('请选择克隆目标目录');
  const expanded=raw.trim()==='~'?homedir():raw.trim().startsWith('~/')?join(homedir(),raw.trim().slice(2)):raw.trim();
  const path=await canonicalWorkspacePath(resolve(expanded)),data=await realpath(directory);
  if((await privateWorkspacePaths(path,directory)).includes('')&&dirname(path)!==join(data,'projects'))throw new Error('不能克隆到 Friday 私有运行目录');
  try {const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw new Error('克隆目标不是普通目录');if((await readdir(path)).length)throw new Error('克隆目标目录已存在且不为空');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return path;
}
export async function prepareCloneDirectory(path:string,directory:string,signal:AbortSignal):Promise<CloneDirectoryIdentity> {
  await cloneDestination(path,directory);signal.throwIfAborted();await mkdir(dirname(path),{recursive:true});
  if(await realpath(dirname(path))!==dirname(path))throw new Error('克隆目标的父目录已改变');
  try{await mkdir(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(path,{bigint:true}),identity={root:path,device:String(info.dev),inode:String(info.ino)};await verifyCloneDirectory(identity);if((await readdir(path)).length)throw new Error('克隆目标目录已存在且不为空');return identity;
}
export async function discardPartialClone(identity:CloneDirectoryIdentity) {
  await verifyCloneDirectory(identity);const entries=await readdir(identity.root);
  if(entries.length&&!entries.includes('.git'))throw new Error('目录包含不属于克隆的文件，请在主机核对后重试');
  // Preserve the workspace root and its inode. Only the partial checkout goes.
  for(const entry of entries){await verifyCloneDirectory(identity);await rm(join(identity.root,entry),{recursive:true,force:true,maxRetries:5,retryDelay:200});}
}
