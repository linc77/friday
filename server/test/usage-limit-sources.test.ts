import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliproxyUsage, creditRedeemRequestId } from '../src/cliproxy-usage.js';
import { collectLimitAccounts, collectLimitPools, usagePoolSnapshot } from '../src/usage-limit-pools.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Workspace } from '../src/types.js';
const accounts=[{id:'a.json',auth_index:'route-a',provider:'codex',email:'a@example.test',id_token:{chatgpt_account_id:'workspace-a',chatgpt_plan_type:'plus'}},{id:'b.json',auth_index:'route-b',provider:'codex',email:'b@example.test',id_token:{chatgpt_account_id:'workspace-b'}},{id:'claude.json',auth_index:'route-c',provider:'claude',email:'c@example.test'},{id:'off',auth_index:'off',provider:'codex',disabled:true},{id:'other',auth_index:'other',provider:'unsupported'}];
function hub() {
  const calls:{path:string;body:any;authorization:string|undefined}[]=[];const redeemed=new Set<string>();let refuseCooldown=false,dropConsume=false,refuseUsage=false;
  const handle=(path:string,body:any)=>{
    if(path.endsWith('/auth-files'))return {files:accounts};
    if(path.endsWith('/reset-quota'))return {};
    if(path.endsWith('/api-call')) {
      if(body.url.endsWith('/rate-limit-reset-credits/consume')) {const data=JSON.parse(body.data);const code=redeemed.has(data.redeem_request_id)?'already_redeemed':'reset';redeemed.add(data.redeem_request_id);return {status_code:200,body:JSON.stringify({code})};}
      if(body.url.endsWith('/rate-limit-reset-credits'))return {status_code:200,body:JSON.stringify({credits:[{id:'credit-a',status:'available',reset_type:'codex_rate_limits',expires_at:'2099-01-01T00:00:00Z'},{id:'expired',status:'available',reset_type:'codex_rate_limits',expires_at:'2000-01-01T00:00:00Z'}]})};
      if(body.url.includes('anthropic'))return {status_code:200,body:JSON.stringify({five_hour:{utilization:5,resets_at:null},limits:[{kind:'weekly_scoped',percent:60,resets_at:null,scope:{model:{display_name:'Opus'}}}]})};
      if(refuseUsage)return {status_code:401,body:'sensitive-provider-token'};
      return {status_code:200,body:JSON.stringify({plan_type:'plus',rate_limit:{primary_window:{used_percent:body.auth_index==='route-a'?20:60,limit_window_seconds:18000,reset_at:2_000_000_000},secondary_window:{used_percent:70,limit_window_seconds:604800}}})};
    }
    throw new Error('Unexpected fixture request');
  };
  const fetcher:typeof fetch=async(input,init)=>{
    const path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({path,body,authorization:new Headers(init?.headers).get('authorization')??undefined});
    const value=handle(path,body);if(path.endsWith('/reset-quota')&&refuseCooldown)return new Response('sensitive-management-key',{status:500});if(body?.url?.endsWith('/consume')&&dropConsume)throw new Error('sensitive-transport-token');return Response.json(value);
  };
  return {calls,redeemed,fetcher,handle,get refuseCooldown(){return refuseCooldown;},set refuseCooldown(value:boolean){refuseCooldown=value;},get dropConsume(){return dropConsume;},set dropConsume(value:boolean){dropConsume=value;},set refuseUsage(value:boolean){refuseUsage=value;}};
}
test('CLIProxy probes use only selected routes and fixed provider URLs, filter credits, preserve Claude scoped limits and pin UUIDv5 redemption through cooldown failures',async()=>{
  const h=hub(),api=new CliproxyUsage(h.fetcher),config={kind:'cliproxy' as const,url:'https://hub.test/prefix/',managementKey:'private-management-key',enabled:true};
  const result=await api.readAccounts(config);assert.equal(result.length,3);assert.equal(result[0].usageLimits.windows[0].usedPercent,20);assert.equal(result[0].usageLimits.resetCredits?.availableCount,1);assert.equal(result[0].usageLimits.resetCredits?.nextCreditId,'credit-a');assert.ok(result[2].usageLimits.windows.some(window=>window.label==='Weekly · Opus'));
  assert.ok(h.calls.every(call=>call.authorization==='Bearer private-management-key'));assert.ok(h.calls.every(call=>call.path.startsWith('/prefix/v0/management/')));
  assert.equal(h.calls.find(call=>call.body?.auth_index==='route-a')!.body.header.Authorization,'Bearer $TOKEN$');
  assert.equal(creditRedeemRequestId('workspace-a','credit-a'),'bb8bb489-f580-508a-b07e-fb11270db808');
  h.refuseCooldown=true;const first=await api.consume(config,'a.json','credit-a',result[0].credentialFingerprint);assert.equal(first.outcome,'reset');assert.match(first.warning!,/冷却/);assert.ok(!first.warning?.includes('sensitive'));
  h.refuseCooldown=false;assert.equal((await api.consume(config,'a.json','credit-a',result[0].credentialFingerprint)).outcome,'alreadyRedeemed');assert.equal(h.redeemed.size,1);
  const consumes=h.calls.filter(call=>call.body?.url?.endsWith('/consume'));assert.deepEqual(consumes.map(call=>JSON.parse(call.body.data)),[{redeem_request_id:'bb8bb489-f580-508a-b07e-fb11270db808',credit_id:'credit-a'},{redeem_request_id:'bb8bb489-f580-508a-b07e-fb11270db808',credit_id:'credit-a'}]);
  await assert.rejects(api.consume(config,'a.json','credit-a','0'.repeat(64)),/账号已改变/);assert.equal(h.redeemed.size,1);
  h.refuseUsage=true;const unavailable=await api.readAccounts(config);assert.equal(unavailable[0].usageLimits.unavailable?.reason,'probeFailed');assert.ok(!JSON.stringify(unavailable).includes('sensitive'));
});
test('Quota pools match 80 independently generated pinned T3 vectors, including missing reset clocks and different Codex window slots',async()=>{
  const golden=JSON.parse(await readFile(new URL('./fixtures/t3-usage-pools.json',import.meta.url),'utf8'));
  for(const [index,entry] of golden.cases.entries()) {const actual=collectLimitPools(entry.accounts,entry.now).map(pool=>({...pool,accounts:pool.accounts.map(account=>account.key)}));assert.deepEqual(actual,entry.expected,'source vector '+index);}
});
test('The same account merges across sources using the freshest balance and hub redemption, while distinct or ambiguous workspaces stay separate',()=>{
  const limits=(usedPercent:number,checkedAt:string)=>({checkedAt,credentialFingerprint:'a'.repeat(64),windows:[{id:'primary',kind:'session' as const,label:'Session',usedPercent,windowDurationMins:300}],resetCredits:{availableCount:2}});
  const native=limits(10,'2030-01-02T00:00:00Z'),sourceLimits={...limits(80,'2030-01-01T00:00:00Z'),resetCredits:{availableCount:1,nextCreditId:'credit-a'}};
  const state={providerUsageSnapshots:{codex:native},providerUsageIdentities:{codex:{fingerprint:'a'.repeat(64),email:'User@example.test'}},usageLimitSources:[{id:'hub',kind:'cliproxy',label:'Hub',checkedAt:'2030-01-01T00:00:00Z',accounts:[{id:'one',driver:'codex',email:'user@example.test',workspaceId:'one',credentialFingerprint:'b'.repeat(64),usageLimits:sourceLimits}]}]} as unknown as Workspace;
  let merged=collectLimitAccounts(state);assert.equal(merged.length,1);assert.equal(merged[0].limits.windows[0].usedPercent,10);assert.equal(merged[0].limits.resetCredits?.availableCount,2);assert.ok(merged[0].redeem&&'sourceId'in merged[0].redeem);
  state.usageLimitSources![0].accounts.push({...state.usageLimitSources![0].accounts[0],id:'two',workspaceId:'two'});merged=collectLimitAccounts(state);assert.equal(merged.length,3);
  assert.ok(!JSON.stringify(usagePoolSnapshot(state,false)).includes('example.test'));assert.ok(!JSON.stringify(usagePoolSnapshot(state,false)).includes('User'));
});
test('Owner-only source settings retain private keys and versions; durable resets pin scope, hide private receipts, and cannot repeat after restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-usage-sources-')),h=hub();
  const server=createServer(async(req,res)=>{const parts=[];for await(const part of req)parts.push(part);const body=parts.length?JSON.parse(Buffer.concat(parts).toString()):undefined;h.calls.push({path:req.url!,body,authorization:req.headers.authorization});const value=h.handle(req.url!,body);if(h.dropConsume&&body?.url?.endsWith('/consume')){res.destroy();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as import('node:net').AddressInfo).port;
  let engine=await new Engine(directory,{run:async()=>'',answer:async()=>{},steer:async()=>{}},undefined,{changeRequestSyncIntervalMs:0}).open();const auth=new Auth(directory);let app=createAPI(engine,auth,()=>[]);
  t.after(async()=>{await engine.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  const post=(path:string,body:object,token=auth.token)=>app.request(path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const path='/api/usage-limit-sources/settings',source={kind:'cliproxy',url:`http://127.0.0.1:${port}/`,managementKey:'private-management-key',enabled:true,label:'Hub'};
  const paired=auth.pair(auth.createPairing().code,'Phone','fixture');assert.equal((await post(path,{version:0,id:'hub',source},paired.token)).status,403);
  let response=await post(path,{version:0,id:'hub',source});assert.equal(response.status,200);assert.ok(!JSON.stringify(await response.json()).includes('private-management-key'));assert.equal((await stat(join(directory,'usage-limit-sources.json'))).mode&0o777,0o600);
  response=await post(path,{version:0,id:'hub',source});assert.equal(response.status,400);assert.match(JSON.stringify(await response.json()),/其他窗口/);
  const {managementKey:_,...unchanged}=source;response=await post(path,{version:1,id:'hub',source:unchanged});assert.equal(response.status,200);assert.ok((await readFile(join(directory,'usage-limit-sources.json'),'utf8')).includes('private-management-key'));
  const snapshot=await engine.snapshot(),account=snapshot.usageLimitSources![0].accounts[0];const input={sourceId:'hub',accountId:account.id,creditId:'credit-a',fingerprint:account.credentialFingerprint,requestId:'consume-a',confirmed:true};
  assert.equal((await post('/api/usage-limit-sources/reset-credit',{...input,confirmed:false})).status,400);
  h.dropConsume=true;response=await post('/api/usage-limit-sources/reset-credit',input);const result=await response.json();assert.equal(result.status,'uncertain',JSON.stringify(result));assert.equal(h.redeemed.size,1);h.dropConsume=false;
  await engine.close();engine=await new Engine(directory,{run:async()=>'',answer:async()=>{},steer:async()=>{}},undefined,{changeRequestSyncIntervalMs:0}).open();app=createAPI(engine,auth,()=>[]);
  const count=h.calls.filter(call=>call.body?.url?.endsWith('/consume')).length;response=await post('/api/usage-limit-sources/reset-credit',input);const replay=await response.json();assert.equal(replay.status,'uncertain',JSON.stringify(replay));assert.equal(h.calls.filter(call=>call.body?.url?.endsWith('/consume')).length,count);
  response=await post('/api/usage-limit-sources/reset-credit',{...input,requestId:'explicit-retry'});assert.equal((await response.json()).outcome,'alreadyRedeemed');assert.equal(h.redeemed.size,1);
  const overview=await(await app.request('/api/overview',{headers:{Authorization:'Bearer '+auth.token}})).json(),legacy=await(await app.request('/api/state',{headers:{Authorization:'Bearer '+auth.token}})).json();
  for(const value of [overview,legacy]){assert.equal(value.usageSourceResetRequests,undefined);assert.equal(value.usageSourceResetTail,undefined);assert.ok(!JSON.stringify(value).includes('private-management-key'));}
  response=await post(path,{version:2,id:'hub',remove:true});assert.equal(response.status,200);assert.equal((await engine.snapshot()).usageLimitSources?.length,0);
});
