import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Engine} from '../src/engine.js';
import {Auth} from '../src/auth.js';
import {createAPI} from '../src/api.js';
import {GitHubMediaAssets} from '../src/github-media-assets.js';
const media='https://github.com/fixture/private/blob/'+'a'.repeat(40)+'/clip.mp4#t=2';
async function fixture(t:{after(callback:()=>Promise<unknown>):void}){
 const root=await mkdtemp(join(tmpdir(),'friday-github-media-')),data=join(root,'data'),cwd=join(root,'repo');await mkdir(cwd);
 const environment={GH_TOKEN:'synthetic-github-token'},calls:{url:string;headers:Headers}[]=[];
 const engine=await new Engine(data,{async run(){return 'Synthetic result';},async answer(){},async steer(){}},undefined,{environment,command:()=>null,request:async(url,init)=>{calls.push({url:String(url),headers:new Headers(init?.headers)});return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4','content-length':'3','accept-ranges':'bytes'}});}}).open();
 await engine.mutate(s=>s.projects.push({id:'p',name:'Synthetic',path:cwd,context:''}));
 const id=await engine.createTask({prompt:'Synthetic',projectId:'p',agent:'codex',mode:'code',requestId:'media-task'});
 const end=Date.now()+10000;while((await engine.snapshot()).tasks[0]?.status!=='completed'){if(Date.now()>end)throw new Error('Media fixture task timed out');await new Promise(r=>setTimeout(r,10));}
 const auth=new Auth(data),assets=new GitHubMediaAssets(engine,auth),api=createAPI(engine,auth);
 t.after(async()=>{auth.close();await engine.close();await rm(root,{recursive:true,force:true});});
 const issue=async(device='owner',now=Date.now())=>assets.issue(device,{taskId:id,url:media},now);
 const parts=(url:string)=>({token:url.split('/')[3],name:decodeURIComponent(url.split('/')[4])});
 return {engine,auth,assets,api,id,cwd,calls,environment,issue,parts};
}
test('GitHub media issue authenticates and refuses foreign URLs or missing tasks before contacting a provider',async t=>{
 const f=await fixture(t),path='/api/task-media/github/asset-url',headers={'Content-Type':'application/json',Authorization:'Bearer '+f.auth.token};
 assert.equal((await f.api.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({taskId:f.id,url:media})})).status,401);
 for(const value of [{taskId:'missing',url:media},{taskId:f.id,url:'https://foreign.test/a.mp4'},{taskId:f.id,url:media,token:'not-accepted'}])assert.equal((await f.api.request(path,{method:'POST',headers,body:JSON.stringify(value)})).status,400);
 assert.equal(f.calls.length,0);
 const result=await f.api.request(path,{method:'POST',headers,body:JSON.stringify({taskId:f.id,url:media})});assert.equal(result.status,200);const receipt=await result.json();
 assert.equal(receipt.source,media);assert(receipt.url.startsWith('/file-assets/github/'));assert.equal(JSON.stringify(receipt).includes(f.environment.GH_TOKEN),false);assert.equal(f.calls.length,0);
 const response=await f.api.request(receipt.url,{headers:{Origin:'null'}});assert.equal(response.status,200);assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.match(response.headers.get('cache-control')!,/^private, max-age=/);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([1,2,3]));
 assert.equal(f.calls[0].url,'https://raw.githubusercontent.com/fixture/private/'+'a'.repeat(40)+'/clip.mp4');assert.equal(f.calls[0].headers.get('authorization'),'Bearer synthetic-github-token');
 assert.equal(JSON.stringify(await f.engine.snapshot()).includes('synthetic-github-token'),false);
});
test('Private media survives a removed worktree, but expires and revokes with the device, account, task scope or resource path',async t=>{
 const f=await fixture(t),paired=f.auth.pair(f.auth.createPairing().code,'Synthetic','local');await rm(f.cwd,{recursive:true});
 const receipt=await f.issue(paired.id),parts=f.parts(receipt.url),request={method:'GET'};
 assert.equal((await f.assets.resource(parts.token,parts.name,request)).status,200);
 await assert.rejects(f.assets.resource(parts.token,'different.mp4',request),/任务已改变/);
 await assert.rejects(f.assets.resource(parts.token,parts.name,request,Date.parse(receipt.expiresAt)+1),/过期/);
 f.auth.revoke(paired.id);await assert.rejects(f.assets.resource(parts.token,parts.name,request),/无效/);
 const owned=f.parts((await f.issue()).url);f.environment.GH_TOKEN='rotated-synthetic-token';const before=f.calls.length;
 await assert.rejects(f.assets.resource(owned.token,owned.name,request),/账号已改变/);assert.equal(f.calls.length,before);
 const refreshed=f.parts((await f.issue()).url);const response=await f.assets.resource(refreshed.token,refreshed.name,request);await response.arrayBuffer();assert.equal(f.calls.at(-1)?.headers.get('authorization'),'Bearer rotated-synthetic-token');
 await f.engine.mutate(s=>{s.tasks[0].cwd='/different-workspace';});await assert.rejects(f.assets.resource(refreshed.token,refreshed.name,request),/任务已改变/);
});
test('Capabilities cannot be modified, outlive a removed task, or reach arbitrary API paths',async t=>{
 const f=await fixture(t),receipt=await f.issue(),parts=f.parts(receipt.url),before=f.calls.length;
 await assert.rejects(f.assets.resource(parts.token.slice(0,-1)+(parts.token.endsWith('A')?'B':'A'),parts.name,{method:'GET'}),/无效/);
 await f.engine.mutate(s=>{s.tasks=[];});await assert.rejects(f.assets.resource(parts.token,parts.name,{method:'GET'}),/任务已改变/);assert.equal(f.calls.length,before);
 assert.equal((await f.api.request('/api/state')).status,401);
});
