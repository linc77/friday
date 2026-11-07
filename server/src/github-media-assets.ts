import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import type { Auth } from './auth.js';
import type { GitHubMediaRequest } from './github-media-fetch.js';
import { githubMediaFetchUrl, githubMediaFileName } from './vendor/t3-github-media.js';

type Claims={v:1;taskId:string;cwd:string;projectId:string|null;device:string;url:string;fingerprint:string;expires:number};
class GitHubMediaAccessDenied extends Error {}
const ttl=60*60*1000;
export class GitHubMediaAssets {
  constructor(private readonly engine:Engine,private readonly auth:Auth){}
  private sign(payload:string){return createHmac('sha256',this.auth.token).update('friday.github-media.v1\0'+payload).digest();}
  async issue(device:string,input:unknown,now=Date.now(),signal?:AbortSignal){
    signal?.throwIfAborted();
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('GitHub 媒体请求无效');
    const value=input as Record<string,unknown>;
    if(Object.keys(value).some(key=>!['taskId','url'].includes(key))||typeof value.taskId!=='string'||typeof value.url!=='string'||value.url.length>2048)throw new Error('GitHub 媒体请求无效');
    const url=githubMediaFetchUrl(value.url);if(!url||url.length>8192)throw new Error('这个链接不是支持的 GitHub 媒体来源');
    const state=await this.engine.snapshot(),task=state.tasks.find(task=>task.id===value.taskId&&task.agent!=='friday');
    if(!task)throw new Error('本地任务不存在');
    // GitHub account selection is global to the host. PR attachments remain
    // available when the old worktree directory has been removed.
    const identity=await this.engine.sourceControl.githubMediaIdentity(this.engine.directory,signal);signal?.throwIfAborted();
    const claims:Claims={v:1,taskId:task.id,cwd:task.cwd,projectId:task.projectId??null,device,url,fingerprint:identity.fingerprint,expires:now+ttl};
    const payload=Buffer.from(JSON.stringify(claims)).toString('base64url'),token=payload+'.'+this.sign(payload).toString('base64url');
    if(token.length>16000)throw new Error('GitHub 媒体链接过长');
    return {url:'/file-assets/github/'+token+'/'+encodeURIComponent(githubMediaFileName(url)),expiresAt:new Date(claims.expires).toISOString(),source:value.url};
  }
  private claims(token:string,now:number):Claims{
    try{
      if(token.length>16000||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error();
      const [payload,signature]=token.split('.'),signed=Buffer.from(signature,'base64url');
      if(signed.toString('base64url')!==signature||!timingSafeEqual(this.sign(payload),signed))throw new Error();
      const value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as Claims;
      if(value.v!==1||!Number.isSafeInteger(value.expires)||value.expires<=now||typeof value.taskId!=='string'||typeof value.cwd!=='string'||typeof value.device!=='string'||typeof value.url!=='string'||githubMediaFetchUrl(value.url)!==value.url||typeof value.fingerprint!=='string'||value.projectId!==null&&typeof value.projectId!=='string')throw new Error();
      if(value.device!=='owner'&&!this.auth.devices().some(device=>device.id===value.device))throw new Error();return value;
    }catch{throw new GitHubMediaAccessDenied('GitHub 媒体链接无效或已过期，请刷新预览');}
  }
  async resource(token:string,name:string,request:GitHubMediaRequest,now=Date.now()){
    const claims=this.claims(token,now),state=await this.engine.snapshot(),task=state.tasks.find(task=>task.id===claims.taskId&&task.agent!=='friday');
    if(!task||task.cwd!==claims.cwd||(task.projectId??null)!==claims.projectId||name!==githubMediaFileName(claims.url))throw new GitHubMediaAccessDenied('GitHub 媒体所属任务已改变，请刷新预览');
    if(request.method==='OPTIONS')return new Response(null,{status:204});
    try{return await this.engine.sourceControl.githubMedia(this.engine.directory,claims.url,claims.fingerprint,claims.expires,request);}
    catch{request.signal?.throwIfAborted();throw new GitHubMediaAccessDenied('GitHub 媒体来源或账号已改变，请刷新预览');}
  }
}
export function installGitHubMediaAssets(app:Hono<{Variables:{device:string}}>,engine:Engine,auth:Auth){
  const assets=new GitHubMediaAssets(engine,auth);
  // Install ahead of the general /file-assets/:token/* capability route.
  app.on(['GET','HEAD','OPTIONS'],'/file-assets/github/:token/:name',async c=>{
    const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Range, If-Range, Content-Type','Access-Control-Expose-Headers':'Content-Type, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified','Referrer-Policy':'no-referrer'};
    try{
      const response=await assets.resource(c.req.param('token'),c.req.param('name'),{method:c.req.method,range:c.req.header('Range'),ifRange:c.req.header('If-Range'),signal:c.req.raw.signal});
      for(const [name,value] of Object.entries(cors))response.headers.set(name,value);return response;
    }catch(error){for(const [name,value] of Object.entries(cors))c.header(name,value);return c.json({error:'GitHub 媒体暂时无法读取，请刷新预览'},error instanceof GitHubMediaAccessDenied?403:502);}
  });
  return assets;
}
