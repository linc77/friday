import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpProviderConnection } from '../src/acp-provider.js';
import { acpProviderDefaults, loadAcpProviderSettings } from '../src/acp-provider-settings.js';
import { acpAuthMethods } from '../src/acp-auth-flow.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
const fixture = fileURLToPath(new URL('./fixtures/acp-auth.mjs', import.meta.url));
const t3Wire = JSON.parse(await readFile(new URL('./fixtures/t3-acp-auth-methods.json', import.meta.url), 'utf8'));
async function setup(t: { after(fn: () => Promise<unknown>): void }, kind = 'agent', extra: Record<string,string> = {}) {
  const directory = await mkdtemp(join(tmpdir(),'friday-acp-auth-')), wire = join(directory,'wire.jsonl'); await chmod(fixture,0o755);
  const connection = new AcpProviderConnection(directory,'acp-registry');
  t.after(async()=>{await connection.close();await rm(directory,{recursive:true,force:true});});
  const base = acpProviderDefaults('acp-registry');
  await connection.save({...base,enabled:true,binaryPath:fixture,nativeConfig:{...base.nativeConfig,source:'local'},environment:Object.entries({AUTH_FLOW_KIND:kind,AUTH_FLOW_TRACE:wire,AUTH_FLOW_MARKER:join(directory,'credential'),...extra}).map(([name,value])=>({name,value}))});
  return {connection,directory,trace:async()=>(await readFile(wire,'utf8')).trim().split('\n').map(line=>JSON.parse(line))};
}
async function finished(connection: AcpProviderConnection) {
  const deadline=Date.now()+5000;
  while(connection.loginState().pending && Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  const result=connection.loginState();assert.equal(result.pending,false);return result;
}
test('ACP methods preserve opaque IDs, normalize legacy credentials and exclude invalid or duplicate metadata',()=>{
  assert.deepEqual(acpAuthMethods([{id:'opaque id',name:'Native',type:'env_var',vars:[{name:'API_KEY'},{name:'not valid'}],link:'https://example.test/key'},{id:'opaque id',name:'Duplicate'},{id:'bad',type:'unknown'},null]),[{id:'opaque id',name:'Native',type:'env_var',envVarNames:['API_KEY'],link:'https://example.test/key'}]);
});
test('instances sharing native credentials serialize authentication and invalidate every prior binding', async t => {
  const root = await mkdtemp(join(tmpdir(), 'friday-shared-acp-auth-')), firstPath = join(root, 'first'), secondPath = join(root, 'second');
  await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
  const first = new AcpProviderConnection(firstPath, 'acp-registry', { credentialDirectory: root }), second = new AcpProviderConnection(secondPath, 'acp-registry', { credentialDirectory: root });
  t.after(async () => { await first.close(); await second.close(); await rm(root, { recursive: true, force: true }); });
  const defaults = acpProviderDefaults('acp-registry');
  for (const [connection, path] of [[first, firstPath], [second, secondPath]] as const) await connection.save({ ...defaults, enabled: true, binaryPath: fixture, nativeConfig: { ...defaults.nativeConfig, source: 'local' }, environment: [{ name: 'AUTH_FLOW_KIND', value: 'terminal' }, { name: 'AUTH_FLOW_MARKER', value: join(root, 'credential') }, { name: 'AUTH_FLOW_TRACE', value: join(path, 'wire.jsonl') }] });
  const settings = await loadAcpProviderSettings(secondPath, 'acp-registry'), before = await second.accountIdentity(settings);
  const pending = await first.login(); assert.equal(pending.pending, true);
  await assert.rejects(second.login(), /另一个实例正在认证/);
  await first.cancelLogin();
  assert.notEqual(await second.accountIdentity(settings), before);
  const retry = await second.login(); assert.equal(retry.pending, true); await second.cancelLogin();
});
for(const generation of ['1','2'])test(`ACP v${generation} sign-in uses its real wire method and verifies a native session before reporting success`,async t=>{
  const {connection,trace}=await setup(t,'agent',{AUTH_FLOW_GENERATION:generation});
  const methods=await connection.authenticationMethods();assert.equal(methods.methods[0]?.type,'agent');
  const result=await connection.login('native-auth');assert.equal(result.pending,false);assert.equal('phase'in result && result.phase,'complete');
  const rows=await trace(), method=generation==='2'?t3Wire.agent.auth_login:'authenticate';assert.ok(rows.some(value=>value.method===method));assert.ok(!rows.some(value=>value.method==='auth_login'));
  const call=rows.findIndex(value=>value.method===method);assert.ok(rows.slice(call+1).some(value=>value.method==='session/new'));
  const initialized=rows.find(value=>value.method==='initialize' && value.params.capabilities?.auth)?.params;assert.deepEqual(initialized.capabilities.auth,{terminal:{}});assert.equal(initialized.clientCapabilities.auth.terminal,true);
  assert.equal((await connection.logout()).phase,'logged-out');assert.ok((await trace()).some(value=>value.method===(generation==='2'?t3Wire.agent.auth_logout:'logout')));assert.equal((await connection.status(true,true)).connected,false);
});
test('ACP environment authentication only verifies configured credentials and never calls authenticate',async t=>{
  const {connection,trace}=await setup(t,'env_var',{AUTH_TEST_TOKEN:'configured-fixture-key'});
  assert.equal((await connection.authenticationMethods()).methods[0]?.envVarNames?.[0],'AUTH_TEST_TOKEN');
  const result=await connection.login();assert.equal('phase'in result && result.phase,'complete');
  assert.ok(!(await trace()).some(value=>value.method==='authenticate'||value.method==='auth/login'));
});
test('ACP browser requests require explicit consent and reject stale callbacks',async t=>{
  const {connection,trace}=await setup(t,'agent',{AUTH_FLOW_BROWSER:'1'}), state=await connection.login();
  assert.ok('interaction'in state && state.interaction?.type==='browser');if(!('interaction'in state)||!state.interaction)return;
  assert.throws(()=>connection.respondLogin({flowId:'old',interactionId:state.interaction!.id,action:'accept'}),/已改变/);
  assert.ok(!(await trace()).some(value=>value.browserAnswer));
  connection.respondLogin({flowId:state.flowId,interactionId:state.interaction.id,action:'accept'});
  const result=await finished(connection);assert.equal('phase'in result && result.phase,'complete');assert.equal((await trace()).find(value=>value.browserAnswer)?.browserAnswer.action,'accept');
});
test('ACP unsafe browser URLs are declined and successful login ACKs do not replace session verification',async t=>{
  const one=await setup(t,'agent',{AUTH_FLOW_BROWSER:'1',AUTH_FLOW_BROWSER_URL:'file:///private/credential'});
  const denied=await one.connection.login();assert.equal('phase'in denied && denied.phase,'failed');assert.equal((await one.trace()).find(value=>value.browserAnswer)?.browserAnswer.action,'decline');
  const two=await setup(t,'agent',{AUTH_FLOW_FALSE_SUCCESS:'1'}), result=await two.connection.login();assert.equal('phase'in result && result.phase,'failed');assert.ok('error'in result && result.error?.includes('Not authenticated'));
});
test('ACP terminal authentication uses a real PTY, native arguments and environment, then reconnects for verification',async t=>{
  const {connection,trace}=await setup(t,'terminal'), state=await connection.login();
  assert.ok('interaction'in state && state.interaction?.type==='terminal');if(!('interaction'in state)||!state.interaction)return;
  assert.throws(()=>connection.respondLogin({flowId:state.flowId,interactionId:'old',data:'must-not-write'}),/已改变/);
  connection.respondLogin({flowId:state.flowId,interactionId:state.interaction.id,cols:100,rows:36,data:'fixture-answer\r'});
  const result=await finished(connection);assert.equal('phase'in result && result.phase,'complete');const rows=await trace();assert.ok(rows.some(value=>value.terminal&&value.isTTY&&value.envApplied));
  assert.ok(rows.filter(value=>value.method==='initialize').length>=3);assert.ok(!rows.some(value=>value.method==='authenticate'));
});
test('Cancelling an ACP terminal closes its owned process and invalidates an uncertain credential binding',async t=>{
  const {connection,directory,trace}=await setup(t,'terminal'), before=await connection.accountIdentity(await loadAcpProviderSettings(directory,'acp-registry')), state=await connection.login();
  assert.ok('flowId'in state);const pid=(await trace()).find(value=>value.terminal)?.pid;assert.ok(pid);
  await assert.rejects(connection.cancelLogin('stale-flow'),/已改变/);
  await connection.cancelLogin('flowId'in state?state.flowId:undefined);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.notEqual(await connection.accountIdentity(await loadAcpProviderSettings(directory,'acp-registry')),before);
});
test('ACP auth API isolates owner-only interactions, streams live state and keeps duplicate starts on one native flow',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-acp-auth-api-'));await chmod(fixture,0o755);
  const engine=await new Engine(directory,undefined,undefined,{changeRequestSyncIntervalMs:0}).open(),auth=new Auth(directory),api=createAPI(engine,auth,()=>[]);
  t.after(async()=>{await engine.close();auth.close();await rm(directory,{recursive:true,force:true});});
  const base=acpProviderDefaults('acp-registry');await engine.acpRegistryConnection.save({...base,enabled:true,binaryPath:fixture,nativeConfig:{...base.nativeConfig,source:'local'},environment:Object.entries({AUTH_FLOW_KIND:'agent',AUTH_FLOW_BROWSER:'1',AUTH_FLOW_TRACE:join(directory,'wire'),AUTH_FLOW_MARKER:join(directory,'marker')}).map(([name,value])=>({name,value}))});
  const owner={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'},paired={Authorization:'Bearer '+auth.pair(auth.createPairing().code,'paired','127.0.0.1').token,'Content-Type':'application/json'},endpoint='/api/agents/acp-registry';
  for(const path of ['/login/methods','/login/events?flowId=old'])assert.equal((await api.request(endpoint+path,{headers:paired})).status,403);
  for(const path of ['/login/respond','/logout'])assert.equal((await api.request(endpoint+path,{method:'POST',headers:paired,body:'{}'})).status,403);
  assert.equal((await api.request(endpoint+'/login',{method:'POST',headers:owner,body:'null'})).status,400);
  const start=await api.request(endpoint+'/login',{method:'POST',headers:owner,body:'{}'});assert.equal(start.status,200);const state=await start.json();assert.equal(state.interaction.type,'browser');
  const repeated=await(await api.request(endpoint+'/login',{method:'POST',headers:owner,body:'{}'})).json();assert.equal(repeated.flowId,state.flowId);
  assert.equal((await api.request(endpoint+'/login/events?flowId=old',{headers:owner})).status,409);
  const stream=await api.request(endpoint+'/login/events?flowId='+state.flowId,{headers:owner}),reader=stream.body!.getReader(),decoder=new TextDecoder();
  assert.equal(stream.status,200);assert.ok(decoder.decode((await reader.read()).value).includes(state.flowId));
  const cancel=await api.request(endpoint+'/login/cancel',{method:'POST',headers:owner,body:JSON.stringify({flowId:state.flowId})});assert.equal(cancel.status,200);
  let text='';for(;;){const value=await reader.read();if(value.done)break;text+=decoder.decode(value.value);}
  assert.ok(text.includes('"pending":false'));assert.ok(!JSON.stringify(await engine.snapshot()).includes('example.test/login'));
});
