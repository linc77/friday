/*
Adapted from T3 Code 8cd9641f ForgejoCli, GitCafeCredentials, GitCafeApi and AzureDevOpsPullRequestCli.
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
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, win32 } from 'node:path';
import { findExecutable } from './agents.js';
import { workspaceCommand } from './git-process.js';
import type { JsonOptions } from './source-control-connections.js';
import { SourceControlHTTPError, SourceControlResponseTooLarge } from './source-control-http-errors.js';
import { azureRepositoryIdentity, type AdditionalRepositoryIdentity } from './source-control-provider-identity.js';
import { type ForgejoLogin, parseForgejoRemote } from './vendor/t3-forgejo-logins.js';
import { gitCafeHost } from './vendor/t3-gitcafe-hosts.js';
import { SourceControlRequestPolicy, responseRetryAt, sourceControlInteractive } from './source-control-request-policy.js';

export type AdditionalHTTPConnection = {
  identity: AdditionalRepositoryIdentity; source: 'settings' | 'environment' | 'cli'; fingerprint: string;
  json(path: string, options?: JsonOptions): Promise<Record<string, any>>;
  array(path: string, options?: JsonOptions): Promise<any[]>;
  text(path: string, options?: JsonOptions): Promise<string>;
  bytes(path: string, options?: JsonOptions): Promise<Uint8Array>;
  arrayPage(path: string, options?: JsonOptions): Promise<{ values: any[]; hasNext: boolean | null }>;
  command?(args: string[], options?: JsonOptions): Promise<Record<string, any>>;
};
type HTTPResult = { body: string | Uint8Array; hasNext: boolean | null };
const hasNext = (link: string | null | undefined) => link == null ? null : /rel="?next"?/i.test(link);
export type ForgejoAccount = ForgejoLogin & { command: 'fj' | 'tea' };
type FjKeys = { hosts: Record<string, { type: 'Application' | 'OAuth'; token: string }>; aliases?: Record<string,string> };
export type AdditionalTransportOptions = {
  environment?: NodeJS.ProcessEnv; request?: typeof fetch; command?: typeof findExecutable; execute?: typeof workspaceCommand;
  platform?: string; home?: string; readFjKeys?: () => Promise<FjKeys>;
  gitCafeToken?: () => Promise<string | undefined>;
  azureFileConcurrency?: number;
  policy?: SourceControlRequestPolicy;
};
export class AdditionalSourceControlCLIError extends Error {
  constructor(readonly command:string,readonly reason:'missing-tool'|'unauthenticated'|'rate-limited'|'not-found'|'failed'|'invalid-response'){super(command+' 请求未完成，请核对工具、登录和连接');}
}
const secret = (value: unknown): value is string => typeof value==='string' && value.length>0 && value.length<=8192 && /^[\x21-\x7e]+$/.test(value);
const textValue = (value: unknown): value is string => typeof value==='string'&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value);
const fingerprint = (...values: string[]) => createHash('sha256').update('friday.additional-source-control\0'+values.join('\0')).digest('hex');
function apiURL(baseURL: string, path: string) {
  if(!path||path.startsWith('/')||/[\x00-\x20\x7f\\]/.test(path)||path.includes('://')||path.split(/[/?#]/).some(part=>part==='..'))throw new Error('Source Control 请求路径无效');
  const base=new URL(baseURL),url=new URL(path,base);
  if(url.origin!==base.origin||!url.pathname.startsWith(base.pathname)||url.username||url.password||url.hash)throw new Error('Source Control 请求路径无效');
  return url.href;
}
export function gitCafeEnvironmentToken(host: string, environment: NodeJS.ProcessEnv): string | undefined {
  if(!gitCafeHost(host))return;
  const configured=environment.CAFE_HOST?.trim();let target='git.cafe';
  try{if(configured)target=new URL(configured.includes('://')?configured:'https://'+configured).host.toLowerCase();}catch{return;}
  const token=environment.CAFE_TOKEN?.trim();return target===host&&secret(token)?token:undefined;
}
function parseLogins(raw: string): ForgejoLogin[] {
  let value:unknown;try{value=JSON.parse(raw);}catch{return [];}
  if(!Array.isArray(value)||value.length>256)return [];
  return value.flatMap(row=>{
    if(!row||typeof row!=='object'||['name','url','user','default'].some(key=>!textValue(row[key]))||row.ssh_host!==undefined&&!textValue(row.ssh_host)||row.valid!==undefined&&!textValue(row.valid))return [];
    return [{name:row.name,url:row.url,user:row.user,default:row.default,...(row.ssh_host?{ssh_host:row.ssh_host}:{}),...(row.valid?{valid:row.valid}:{})}];
  });
}

/** Provider credentials and transport lifetimes stay below the task projection.
 * Provider operations are dispatched by the existing Pi Durable execution lane. */
export class AdditionalSourceControlTransports {
  private readonly environment:NodeJS.ProcessEnv;private readonly request:typeof fetch;
  private readonly command:typeof findExecutable;private readonly execute:typeof workspaceCommand;
  private readonly controllers=new Set<AbortController>();private readonly pending=new Set<Promise<unknown>>();private closed=false;
  private fjAuth:Promise<unknown>=Promise.resolve();private readonly fjTokens=new Map<string,{token:string;at:number}>();
  private readonly cafeTokens=new Map<string,{token:string;at:number;source:'environment'|'cli'}>();
  private azureFiles=0;private readonly azureWaiters:(()=>void)[]=[];
  private readonly forgejoLogins=new Map<string,{at:number;accounts:ForgejoAccount[]}>();
  private readonly forgejoFlights=new Map<string,Promise<ForgejoAccount[]>>();
  private readonly policy:SourceControlRequestPolicy;
  constructor(private readonly options:AdditionalTransportOptions={}){
    if(options.azureFileConcurrency!==undefined&&(!Number.isSafeInteger(options.azureFileConcurrency)||options.azureFileConcurrency<1||options.azureFileConcurrency>32))throw new Error('Azure 文件并发设置无效');
    this.environment=options.environment??process.env;this.request=options.request??fetch;this.command=options.command??findExecutable;this.execute=options.execute??workspaceCommand;
    this.policy=options.policy??new SourceControlRequestPolicy();
  }
  private tracked<T>(signal:AbortSignal|undefined,run:(signal:AbortSignal)=>Promise<T>,timeout=30000):Promise<T>{
    if(this.closed)return Promise.reject(new Error('Source Control 连接已关闭'));
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000)return Promise.reject(new Error('Source Control 请求超时设置无效'));
    const controller=new AbortController();this.controllers.add(controller);const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeout),...(signal?[signal]:[])]);
    const result=Promise.resolve().then(()=>{combined.throwIfAborted();return run(combined);});this.pending.add(result);
    void result.finally(()=>{this.pending.delete(result);this.controllers.delete(controller);}).catch(()=>{});return result;
  }
  private async cli(cwd:string,name:string,args:string[],options:JsonOptions&{input?:string;env?:NodeJS.ProcessEnv}={}){
    const command=this.command(name);if(!command)throw new AdditionalSourceControlCLIError(name,'missing-tool');
    return this.tracked(options.signal,async signal=>{
      let result;try{result=await this.execute(cwd,command,args,{signal,timeout:options.timeoutMs??30000,limit:Math.min(options.maxResponseBytes??8*1024*1024,8*1024*1024),input:options.input,env:options.env,allowFailure:true});}
      catch{if(signal.aborted)throw signal.reason;throw new Error(name+' 请求未完成，请核对登录和连接');}
      if(result.code!==0){const status=/\bHTTP(?:\/\S+)?\s+([1-5]\d{2})\b/i.exec(result.stderr)?.[1];if(status)throw new SourceControlHTTPError(Number(status),name+' 未能完成请求');const reason=/rate.limit|too many requests/i.test(result.stderr)?'rate-limited':/not authenticated|sign in|az login|TF400813|authentication failed|unauthori[sz]ed/i.test(result.stderr)?'unauthenticated':/not found|could not be found|does not exist|TF401019/i.test(result.stderr)?'not-found':'failed';throw new AdditionalSourceControlCLIError(name,reason);}return result;
    },options.timeoutMs);
  }
  private async http(base:string,authorization:string,path:string,options:JsonOptions={}){
    const address=apiURL(base,path);if(options.accept)throw new Error('此平台不支持 GitHub Diff Accept');
    return this.tracked(options.signal,async signal=>{
      const response=await this.request(address,{method:options.method??'GET',redirect:'manual',signal,headers:{Authorization:authorization,Accept:'application/json','Content-Type':'application/json','User-Agent':'Friday'},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
      if(!response.ok){await response.body?.cancel();throw new SourceControlHTTPError(response.status,'Source Control 平台未能完成请求',{rateLimited:response.status===429,retryAt:responseRetryAt(response.headers,this.policy.now())});}
      const next=hasNext(response.headers.get('link'));
      if(response.status===204||response.status===205){await response.body?.cancel();return {body:options.responseType==='bytes'?new Uint8Array():'',hasNext:next};}
      const reader=response.body?.getReader();if(!reader)throw new Error('Source Control 返回空结果');const chunks:Uint8Array[]=[];let count=0;
      const limit=Math.min(options.maxResponseBytes??8*1024*1024,8*1024*1024);
      try{while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.length;if(count>limit){await reader.cancel();throw new SourceControlResponseTooLarge();}chunks.push(chunk.value);}}
      finally{reader.releaseLock();}
      const bytes=Buffer.concat(chunks);if(options.responseType==='bytes')return {body:bytes,hasNext:next};
      try{return {body:new TextDecoder('utf-8',{fatal:true}).decode(bytes),hasNext:next};}catch{throw new Error('Source Control 返回的 UTF-8 无效');}
    },options.timeoutMs);
  }
  private bound(identity:AdditionalRepositoryIdentity,source:AdditionalHTTPConnection['source'],key:string,send:(path:string,options:JsonOptions)=>Promise<HTTPResult>):AdditionalHTTPConnection{
    const request=(path:string,options:JsonOptions={})=>this.policy.request({provider:identity.provider,host:identity.host,scope:key},{signal:options.signal,interactive:options.allowReserve??(sourceControlInteractive()||path==='user'||options.method!==undefined&&options.method!=='GET')},signal=>send(path,{...options,signal}));
    const read=async(path:string,options:JsonOptions={})=>{
      const {body:raw}=await request(path,options);if(options.responseType==='bytes')return raw;
      if(options.responseType==='text')return raw;
      if(options.allowEmpty&&raw==='')return {};
      if(typeof raw!=='string')throw new Error('Source Control 返回结果无效');
      try{return JSON.parse(raw) as unknown;}catch{throw new Error('Source Control 返回结果无效');}
    };
    return {identity:structuredClone(identity),source,fingerprint:key,
      json:async(path,options)=>{const value=await read(path,options);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Source Control 返回对象无效');return value as Record<string,any>;},
      array:async(path,options)=>{const value=await read(path,options);if(!Array.isArray(value))throw new Error('Source Control 返回列表无效');return value;},
      text:async(path,options)=>{const value=await read(path,{...options,responseType:'text'});if(typeof value!=='string')throw new Error('Source Control 返回文本无效');return value;},
      bytes:async(path,options)=>{const value=await read(path,{...options,responseType:'bytes'});if(!(value instanceof Uint8Array))throw new Error('Source Control 返回文件无效');return value;},
      arrayPage:async(path,options={})=>{const response=await request(path,options);let value;try{value=JSON.parse(String(response.body));}catch{throw new Error('Source Control 返回列表无效');}if(value!==null&&!Array.isArray(value))throw new Error('Source Control 返回列表无效');return {values:value??[],hasNext:response.hasNext};}};
  }
  private async keys():Promise<FjKeys>{
    if(this.options.readFjKeys)return this.options.readFjKeys();
    const home=this.options.home??homedir(),platform=this.options.platform??process.platform;
    const paths=platform==='darwin'?['forgejo-cli','Cyborus'].map(org=>join(home,'Library','Application Support',org+'.forgejo-cli','keys.json')):
      platform==='win32'?['forgejo-cli','Cyborus'].map(org=>win32.join(this.environment.APPDATA||win32.join(home,'AppData','Roaming'),org,'forgejo-cli','data','keys.json')):
      [join(this.environment.XDG_DATA_HOME&&isAbsolute(this.environment.XDG_DATA_HOME)?this.environment.XDG_DATA_HOME:join(home,'.local','share'),'forgejo-cli','keys.json')];
    for(const path of paths){
      const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(error=>{if(error.code==='ENOENT')return;throw new Error('无法读取 fj 登录存储，请重新通过 fj 登录');});if(!handle)continue;
      try{
        const info=await handle.stat();if(!info.isFile()||info.size>1024*1024)throw new Error();const bytes=Buffer.alloc(1024*1024+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>1024*1024)throw new Error();
        const value=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')) as FjKeys;
        if(!value||!value.hosts||typeof value.hosts!=='object'||Array.isArray(value.hosts)||Object.keys(value.hosts).length>256||Object.values(value.hosts).some(row=>!row||!['Application','OAuth'].includes(row.type)||!secret(row.token))||value.aliases&&(!value.aliases||typeof value.aliases!=='object'||Array.isArray(value.aliases)||Object.values(value.aliases).some(value=>!textValue(value))))throw new Error();return value;
      }catch{throw new Error('fj 登录存储无效，请重新通过 fj 登录');}finally{await handle.close();}
    }return {hosts:{}};
  }
  async forgejoAccounts(cwd:string,remoteURL?:string,signal?:AbortSignal):Promise<ForgejoAccount[]>{
    if(this.closed)throw new Error('Source Control 连接已关闭');signal?.throwIfAborted();
    const keys=this.command('fj')?await this.keys():undefined;if(this.closed)throw new Error('Source Control 连接已关闭');signal?.throwIfAborted();
    const remote=remoteURL?parseForgejoRemote(remoteURL):null,authority=remote?((remote.ssh?'ssh:':/^http:\/\//.test(remoteURL!)?'http:':'https:')+remote.host):'all',key=authority+(keys?'\0'+fingerprint(JSON.stringify(keys)):''),cached=this.forgejoLogins.get(key);
    if(cached&&Date.now()-cached.at<30000)return structuredClone(cached.accounts);
    const held=this.forgejoFlights.get(key);if(held)return structuredClone(await held);
    const flight=this.readForgejoAccounts(cwd,remoteURL,signal);this.forgejoFlights.set(key,flight);
    try{const accounts=await flight;this.forgejoLogins.set(key,{at:Date.now(),accounts});if(this.forgejoLogins.size>32)this.forgejoLogins.delete(this.forgejoLogins.keys().next().value!);return structuredClone(accounts);}finally{if(this.forgejoFlights.get(key)===flight)this.forgejoFlights.delete(key);}
  }
  private async readForgejoAccounts(cwd:string,remoteURL?:string,signal?:AbortSignal):Promise<ForgejoAccount[]>{
    signal?.throwIfAborted();const accounts:ForgejoAccount[]=[];
    if(this.command('fj')){
      const keys=await this.keys(),remote=remoteURL?parseForgejoRemote(remoteURL):null;
      for(const name of Object.keys(keys.hosts)){
        const parsed=parseForgejoRemote('https://'+name);if(!parsed||parsed.path)continue;
        const scheme=remote&&!remote.ssh&&remote.host===parsed.host&&/^http:\/\//i.test(remoteURL??'')?'http':'https';
        const login:ForgejoAccount={name,url:scheme+'://'+name,user:'',default:'false',command:'fj'};
        const aliases=Object.entries(keys.aliases??{}).filter(([,target])=>target===name).map(([ssh_host])=>({...login,ssh_host}));accounts.push(...(aliases.length?aliases:[login]));
      }
    }
    if(this.command('tea')){
      try{const result=await this.cli(cwd,'tea',['login','list','--output','json'],{signal,maxResponseBytes:256*1024});accounts.push(...parseLogins(result.stdout).filter(login=>!accounts.some(account=>account.url===login.url)).map(login=>({...login,command:'tea' as const})));}
      catch(error){if(signal?.aborted||!accounts.length)throw error;}
    }return accounts;
  }
  async forgejo(cwd:string,identity:AdditionalRepositoryIdentity,signal?:AbortSignal):Promise<AdditionalHTTPConnection>{
    identity=structuredClone(identity);
    if(identity.provider!=='forgejo'||!identity.apiBase.endsWith('/api/v1/'))throw new Error('Forgejo 仓库身份无效');
    const base=identity.apiBase.replace(/\/api\/v1\/$/,'');
    const account=(await this.forgejoAccounts(cwd,identity.webURL,signal)).find(row=>row.name===identity.login&&row.url.replace(/\/+$/,'')===base);
    if(!account)throw new Error('Forgejo 登录归属已改变，请重新确认');
    if(account.command==='fj'){
      const refresh=this.fjAuth.then(async()=>{
        let token=(await this.keys()).hosts[account.name]?.token;const saved=this.fjTokens.get(base);
        if(token&&saved?.token===token&&Date.now()-saved.at<30000)return token;
        await this.cli(cwd,'fj',['--host',base,'whoami'],{signal,maxResponseBytes:16*1024});token=(await this.keys()).hosts[account.name]?.token;
        if(!secret(token))throw new Error('fj 未提供此主机的登录凭据');this.fjTokens.set(base,{token,at:Date.now()});return token;
      });this.fjAuth=refresh.catch(()=>{});const token=await refresh;
      return this.bound(identity,'cli',fingerprint(base,token),(path,options)=>this.http(identity.apiBase,'token '+token,path,options));
    }
    const send=async(path:string,options:JsonOptions={})=>{
      const url=apiURL(identity.apiBase,path);const result=await this.cli(cwd,'tea',['api','--include','--login',account.name,'--repo',identity.repository,'--method',options.method??'GET',...(options.body===undefined?[]:['--data','@-']),url],{...options,input:options.body===undefined?undefined:JSON.stringify(options.body)});
      const status=Number(/^HTTP\/\S+\s+(\d{3})/m.exec(result.stderr)?.[1]);if(!status||status<200||status>=300)throw new SourceControlHTTPError(status||502,'Forgejo 未能完成请求');
      return {body:options.responseType==='bytes'?Buffer.from(result.stdout):result.stdout,hasNext:hasNext(/^link:\s*(.*)$/im.exec(result.stderr)?.[1])};
    };
    const probe=this.bound(identity,'cli',fingerprint(base,account.name,'probe'),send),user=await probe.json('user',{signal});
    if(!textValue(user.login)||!user.login)throw new Error('无法确认 Forgejo 账号');return this.bound(identity,'cli',fingerprint(base,account.name,user.login,String(user.id??'')),send);
  }
  async gitcafe(cwd:string,identity:AdditionalRepositoryIdentity,signal?:AbortSignal):Promise<AdditionalHTTPConnection>{
    identity=structuredClone(identity);
    if(identity.provider!=='gitcafe'||!gitCafeHost(identity.host)||identity.apiBase!==`https://${identity.host}/api/`)throw new Error('GitCafe 仓库身份无效');
    signal?.throwIfAborted();const host=identity.host,saved=host==='git.cafe'?await this.options.gitCafeToken?.():undefined;
    let token:string|undefined,source:AdditionalHTTPConnection['source']='cli';
    if(secret(saved)){token=saved;source='settings';}
    else{
      const environment=gitCafeEnvironmentToken(host,this.environment),cached=this.cafeTokens.get(host);
      if(environment){token=environment;source='environment';}
      else if(cached&&Date.now()-cached.at<300000){token=cached.token;source=cached.source;}
      else{
        const result=await this.cli(cwd,'cafe',['auth','http','credential','--host',`https://${host}/api`,'get'],{signal,input:`protocol=https\nhost=${host}\n\n`,env:{CAFE_NO_UPDATE_CHECK:'1',CAFE_TOKEN:'',CAFE_HOST:`https://${host}/api`},maxResponseBytes:16*1024});
        token=result.stdout.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9).trim();if(!secret(token))throw new Error('cafe 未提供此主机的登录凭据');this.cafeTokens.set(host,{token,at:Date.now(),source:'cli'});
      }
    }
    const key=token,pinned=this.bound(identity,source,fingerprint(host,key),(path,options)=>this.http(identity.apiBase,'Bearer '+key,path,options).catch(error=>{if(error instanceof SourceControlHTTPError&&error.status===401)this.cafeTokens.delete(host);throw error;}));
    pinned.command=async(args,options={})=>{
      const result=await this.policy.request({provider:'gitcafe',host,scope:pinned.fingerprint},{signal:options.signal,interactive:options.allowReserve??(sourceControlInteractive()||args[1]==='create')},signal=>this.cli(cwd,'cafe',['--host',`https://${host}/api`,'--no-input','--no-update-check',...args],{...options,signal,env:{CAFE_TOKEN:key,CAFE_HOST:`https://${host}/api`,CAFE_NO_UPDATE_CHECK:'1'}}));
      let value;try{value=JSON.parse(result.stdout);}catch{throw new Error('GitCafe CLI 返回结果无效');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('GitCafe CLI 返回结果无效');return value;
    };return pinned;
  }
  private azurePermit(signal:AbortSignal):Promise<()=>void>{
    return new Promise((resolve,reject)=>{
      const take=()=>{if(signal.aborted){cancel();return;}if(this.azureFiles>=(this.options.azureFileConcurrency??8)){this.azureWaiters.push(take);return;}
        signal.removeEventListener('abort',cancel);this.azureFiles++;let released=false;resolve(()=>{if(released)return;released=true;this.azureFiles--;this.azureWaiters.shift()?.();});};
      const cancel=()=>{const index=this.azureWaiters.indexOf(take);if(index>=0)this.azureWaiters.splice(index,1);reject(signal.reason);};signal.addEventListener('abort',cancel,{once:true});take();
    });
  }
  async azureAccount(cwd:string,signal?:AbortSignal){
    const response=await this.cli(cwd,'az',['account','show','--query','user','--output','json','--only-show-errors'],{signal,timeoutMs:20000,maxResponseBytes:16*1024});let raw:any;try{raw=JSON.parse(response.stdout);}catch{throw new AdditionalSourceControlCLIError('az','invalid-response');}
    const account=raw?.name;if(!textValue(account)||!account)throw new AdditionalSourceControlCLIError('az','unauthenticated');
    return {account,fingerprint:fingerprint('azure-devops',account,this.environment.AZURE_DEVOPS_EXT_PAT??'cli')};
  }
  async azureCommand(cwd:string,identity:AdditionalRepositoryIdentity,args:string[],options:JsonOptions={}){
    const expected=azureRepositoryIdentity(identity.webURL);
    if(identity.provider!=='azure-devops'||identity.host!=='dev.azure.com'||!identity.organization||!identity.project||!expected||expected.canonicalKey!==identity.canonicalKey||expected.organization!==identity.organization||expected.project!==identity.project||expected.name!==identity.name)throw new Error('Azure DevOps 仓库身份无效');
    const invoke=args[0]==='devops'&&args[1]==='invoke';
    const argv=[...args,'--organization',identity.organization,...(invoke?[]:['--project',identity.project]),'--only-show-errors','--output','json'];
    const read=(signal?:AbortSignal)=>this.cli(cwd,'az',argv,{...options,...(signal?{signal}:{})});
    const item=invoke&&args[args.indexOf('--resource')+1]==='items';
    const write=!invoke&&!(args[0]==='repos'&&args[1]==='show'||args[0]==='repos'&&args[1]==='pr'&&['show','list'].includes(args[2]??''));
    const result=await this.policy.request({provider:'azure-devops',host:identity.host,scope:fingerprint('azure-devops',identity.account??'',this.environment.AZURE_DEVOPS_EXT_PAT??'cli')},{signal:options.signal,interactive:options.allowReserve??(sourceControlInteractive()||write)},signal=>item?this.tracked(signal,async signal=>{const release=await this.azurePermit(signal);try{return await read(signal);}finally{release();}},options.timeoutMs):read(signal));
    if(options.allowEmpty&&!result.stdout.trim())return {};
    try{return JSON.parse(result.stdout) as unknown;}catch{throw new AdditionalSourceControlCLIError('az','invalid-response');}
  }
  azureInvoke(cwd:string,identity:AdditionalRepositoryIdentity,resource:string,route:Record<string,string|number>={},query:Record<string,string|number>={},options:JsonOptions={}){
    if(!/^[A-Za-z][A-Za-z0-9]*$/.test(resource)||Object.entries(route).some(([key,value])=>!/^[A-Za-z][A-Za-z0-9.]*$/.test(key)||!textValue(String(value)))||Object.entries(query).some(([key,value])=>!/^\$?[A-Za-z][A-Za-z0-9.]*$/.test(key)||!textValue(String(value))))throw new Error('Azure DevOps API 路由无效');
    if(options.method&&options.method!=='GET'||options.body)throw new Error('Azure DevOps 写入必须使用明确的平台操作');
    return this.azureCommand(cwd,identity,['devops','invoke','--area','git','--resource',resource,'--api-version','7.1','--route-parameters',...Object.entries({project:identity.project,repositoryId:identity.name,...route}).map(([key,value])=>key+'='+value),...(Object.keys(query).length?['--query-parameters',...Object.entries(query).map(([key,value])=>key+'='+value)]:[])],options);
  }
  invalidate(){this.fjTokens.clear();this.cafeTokens.clear();this.forgejoLogins.clear();}
  async close(){this.closed=true;for(const controller of this.controllers)controller.abort();await Promise.allSettled([...this.pending,...this.forgejoFlights.values(),...(this.options.policy?[]:[this.policy.close()])]);await this.fjAuth.catch(()=>{});this.invalidate();}
}
