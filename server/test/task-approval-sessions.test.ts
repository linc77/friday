import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { CodexExecutor } from '../src/codex.js';
import { ClaudeExecutor } from '../src/claude.js';
import { ClaudeConnection, defaultClaudeSettings } from '../src/claude-provider.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { CodexSessionApprovals, claudePermissionResult, permissionDecisions } from '../src/provider-approvals.js';
import type { ExecutionUpdate, WorkItem } from '../src/types.js';
const command=fileURLToPath(new URL('./fixtures/codex-session-approvals.mjs',import.meta.url));
const work=(cwd:string):WorkItem=>({id:'test',title:'test',prompt:'test',projectId:'project',cwd,agent:'codex',mode:'code',status:'running',createdAt:'',updatedAt:'',durableId:1,threadId:null,turnId:null,result:'',error:null,events:[],approvals:[],artifact:null,lastRequestId:'request'});
test('Session grants stay within one native thread and permission kind, end at a policy generation change, and cannot be restored by a late answer',()=>{
  const store=new CodexSessionApprovals(),first=store.capture('task','thread','default');first.grant('command');assert.ok(first.allows('command'));assert.ok(!first.allows('file-change'));
  assert.ok(!store.capture('other','thread','default').allows('command'));assert.ok(!store.capture('task','child','default').allows('command'));
  const changed=store.capture('task','thread','read-only');first.grant('file-change');assert.ok(!changed.allows('command'));assert.ok(!changed.allows('file-change'));
  assert.ok(!store.capture('task','thread','default').allows('command'));store.clearTask('task');assert.ok(!store.capture('task','thread','default').allows('command'));
});
test('Claude session permission updates only affect the SDK session, with exact tool fallback, request identity, and cancel interrupt semantics',()=>{
  const input={toolName:'Bash',toolUseID:'use-1',toolInput:{command:'echo fixture'}};
  assert.deepEqual(claudePermissionResult({...input,decision:'acceptForSession',suggestions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo *'}],behavior:'allow',destination:'projectSettings'}]}),{behavior:'allow',updatedInput:input.toolInput,toolUseID:'use-1',decisionClassification:'user_permanent',updatedPermissions:[{type:'addRules',rules:[{toolName:'Bash',ruleContent:'echo *'}],behavior:'allow',destination:'session'}]});
  const fallback=claudePermissionResult({...input,decision:'acceptForSession'});assert.ok(fallback.behavior==='allow');assert.deepEqual(fallback.updatedPermissions,[{type:'addRules',rules:[{toolName:'Bash'}],behavior:'allow',destination:'session'}]);
  const once=claudePermissionResult({...input,decision:'accept'});assert.ok(once.behavior==='allow');assert.equal(once.updatedPermissions,undefined);
  assert.deepEqual(claudePermissionResult({...input,decision:'cancel'}),{behavior:'deny',message:'User cancelled tool execution.',toolUseID:'use-1',decisionClassification:'user_reject',interrupt:true});
});
test('The Codex wire auto-answers subsequent commands and file changes only after their separate session grants, and resets on a policy change',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-session-permissions-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);const executor=new CodexExecutor(command);t.after(()=>executor.close());let manual=0;
  const run=async(task:WorkItem)=>executor.run({task,prompt:'fixture',signal:AbortSignal.timeout(5000),update:async(value:ExecutionUpdate)=>{if(value.kind==='approval'){manual++;assert.deepEqual(value.approval.decisions,permissionDecisions);await executor.answer(task.id,value.approval.id,'acceptForSession',{});}}});
  assert.equal(await run(work(directory)),'Approved sequence');assert.equal(manual,2);
  await run({...work(directory),threadId:'approval-thread'});assert.equal(manual,2);
  await run({...work(directory),threadId:'approval-thread',mode:'research'});assert.equal(manual,4);
  const wire=(await readFile(join(directory,'approval-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(wire.filter(value=>value.id>=100&&!value.method).length,15);assert.ok(wire.filter(value=>value.id>=100&&!value.method).every(value=>value.result.decision==='acceptForSession'));
});
test('Cancelling an actual Codex approval produces an interrupted native turn and a cancellation result',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-permission-cancel-'));await chmod(command,0o755);const executor=new CodexExecutor(command);t.after(async()=>{await executor.close();await rm(directory,{recursive:true,force:true});});
  await assert.rejects(executor.run({task:work(directory),prompt:'fixture',signal:AbortSignal.timeout(5000),update:async value=>{if(value.kind==='approval')await executor.answer('test',value.approval.id,'cancel',{});}}),error=>error instanceof Error&&error.name==='TaskExecutionCancelled');
  const rows=(await readFile(join(directory,'approval-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(rows.find(value=>value.id===100&&!value.method).result.decision,'cancel');
});
test('Structured permissions return only the shown scope, legacy approvals share session kinds, and MCP consent follows native persistence options',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-permission-variants-')),binary=fileURLToPath(new URL('./fixtures/codex-permission-variants.mjs',import.meta.url));await chmod(binary,0o755);const executor=new CodexExecutor(binary);t.after(async()=>{await executor.close();await rm(directory,{recursive:true,force:true});});let permissions=0,manual=0;
  const result=await executor.run({task:work(directory),prompt:'fixture',signal:AbortSignal.timeout(5000),update:async value=>{
    if(value.kind!=='approval')return;manual++;let decision:import('../src/provider-approvals.js').ApprovalDecision='decline';
    if(value.approval.method==='item/permissions/requestApproval'){permissions++;decision=permissions===1?'acceptForSession':'decline';assert.match(value.approval.detail,/only-read/);assert.match(value.approval.detail,/only-write/);}
    if(value.approval.method==='execCommandApproval')decision='acceptForSession';
    if(value.approval.method==='mcpServer/elicitation/request'){decision='acceptAlways';assert.equal(value.approval.appName,'Safari');assert.ok(value.approval.options?.some(option=>option.decision==='acceptAlways'));}
    await executor.answer('test',value.approval.id,decision,{});
  }});assert.equal(result,'Permission variants complete');assert.equal(manual,5);
  const responses=(await readFile(join(directory,'permission-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(value=>value.id>=100&&!value.method),reply=(id:number)=>responses.find(value=>value.id===id).result;
  assert.deepEqual(reply(100),{permissions:{fileSystem:{read:['/only-read'],write:['/only-write']},network:{enabled:true}},scope:'session'});assert.deepEqual(reply(101),{permissions:{},scope:'turn'});
  assert.equal(reply(102).decision,'approved_for_session');assert.equal(reply(103).decision,'acceptForSession');assert.deepEqual(reply(104).decision,{denied:{rejection:'User declined the request.'}});
  assert.deepEqual(reply(105),{action:'accept',_meta:{persist:'always'},content:{approval:'always'}});for(const id of [106,107,108])assert.deepEqual(reply(id),{action:'decline'});
});
test('The installed Claude SDK forwards session rules and cancellation classifications on its real control protocol without writing user settings',async t=>{
  const binaryPath=fileURLToPath(new URL('./fixtures/claude.mjs',import.meta.url));await chmod(binaryPath,0o755);
  for(const decision of ['acceptForSession','cancel'] as const){
    const directory=await mkdtemp(join(tmpdir(),'friday-claude-permission-scope-')),connection=new ClaudeConnection(directory),executor=new ClaudeExecutor(connection);t.after(async()=>{await connection.close();await rm(directory,{recursive:true,force:true});});
    await connection.save({...defaultClaudeSettings,binaryPath,homePath:directory,permissionMode:'default'});
    const running=executor.run({task:{...work(directory),agent:'claude',model:'sonnet'},prompt:'permission-test',signal:AbortSignal.timeout(5000),update:async value=>{if(value.kind==='approval'){assert.deepEqual(value.approval.decisions,permissionDecisions);await executor.answer('test',value.approval.id,decision,{});}}});
    if(decision==='cancel')await assert.rejects(running,error=>error instanceof Error&&error.name==='TaskExecutionCancelled');else await running;
    const rows=(await readFile(join(directory,'claude-wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const response=rows.find(value=>value.type==='control_response'&&value.response?.response?.decisionClassification)?.response.response;assert.ok(response,'SDK did not forward the native permission result');
    if(decision==='cancel'){assert.equal(response.interrupt,true);assert.equal(response.behavior,'deny');await assert.rejects(readFile(join(directory,'allowed.txt')));}
    else{assert.equal(response.behavior,'allow');assert.deepEqual(response.updatedPermissions,[{type:'addRules',rules:[{toolName:'Write'}],behavior:'allow',destination:'session'}]);assert.equal(await readFile(join(directory,'allowed.txt'),'utf8'),'authorized');}
  }
});
test('Approval intent precedes the native response, repeated acknowledgements cannot grant twice, and private receipts stay out of snapshots',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-approval-receipt-'));let calls=0;let release:()=>void=()=>{};let engine!:Engine;
  const executor={run:async({update,signal}:import('../src/types.js').ExecutionRequest)=>{await update({kind:'approval',approval:{id:'permit',method:'claude/tool/requestApproval',title:'fixture',detail:'fixture',questions:[],state:'pending',decisions:permissionDecisions}});await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return 'done';},answer:async()=>{calls++;const state=await engine.snapshot();assert.equal(Object.values(state.approvalResponses!)[0].status,'sending');assert.equal(state.tasks[0].approvals[0].responseStatus,'sending');},steer:async()=>{}};
  engine=await new Engine(directory,executor,undefined,{changeRequestSyncIntervalMs:0}).open();const auth=new Auth(directory);t.after(async()=>{release();await engine.close();auth.close();await rm(directory,{recursive:true,force:true});});
  const id=await engine.createTask({agent:'codex',projectId:null,mode:'research',prompt:'fixture',requestId:'start'});const deadline=Date.now()+5000;while((await engine.snapshot()).tasks[0].status!=='waiting'){if(Date.now()>deadline)throw new Error('Approval fixture did not wait');await new Promise(resolve=>setTimeout(resolve,5));}
  await assert.rejects(engine.answer(id,'permit','acceptAlways',{},'unsupported'),/不支持/);assert.equal(calls,0);assert.equal(Object.keys((await engine.snapshot()).approvalResponses??{}).length,0);
  await engine.answer(id,'permit','acceptForSession',{},'answer-1');await engine.answer(id,'permit','acceptForSession',{},'answer-1');assert.equal(calls,1);assert.equal((await engine.snapshot()).tasks[0].approvals[0].decision,'acceptForSession');await assert.rejects(engine.answer(id,'permit','decline',{},'answer-1'),/其他决定/);
  release();await engine.close();engine=await new Engine(directory,executor,undefined,{changeRequestSyncIntervalMs:0}).open();await engine.answer(id,'permit','acceptForSession',{},'answer-1');assert.equal(calls,1);
  const app=createAPI(engine,auth,()=>[]);for(const path of ['/api/state','/api/overview']){const value=await(await app.request(path,{headers:{Authorization:'Bearer '+auth.token}})).json();assert.equal(value.approvalResponses,undefined);}
});
test('A lost approval forwarding answer keeps the request pending and uncertain; retrying with either the old or a new ID never repeats the grant',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-approval-unknown-'));let calls=0,release:()=>void=()=>{};
  const executor={run:async({update,signal}:import('../src/types.js').ExecutionRequest)=>{await update({kind:'approval',approval:{id:'permit',method:'claude/tool/requestApproval',title:'fixture',detail:'fixture',questions:[],state:'pending',decisions:permissionDecisions}});await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return 'done';},answer:async()=>{calls++;throw new Error('fixture lost response');},steer:async()=>{}};
  const engine=await new Engine(directory,executor,undefined,{changeRequestSyncIntervalMs:0}).open();t.after(async()=>{release();await engine.close();await rm(directory,{recursive:true,force:true});});
  const id=await engine.createTask({agent:'codex',projectId:null,mode:'research',prompt:'fixture',requestId:'start'});const deadline=Date.now()+5000;while((await engine.snapshot()).tasks[0].status!=='waiting'){if(Date.now()>deadline)throw new Error('Approval fixture did not wait');await new Promise(resolve=>setTimeout(resolve,5));}
  await assert.rejects(engine.answer(id,'permit','accept',{},'uncertain'),/lost response/);await assert.rejects(engine.answer(id,'permit','accept',{},'uncertain'),/尚未确认/);await assert.rejects(engine.answer(id,'permit','acceptForSession',{},'new-id'),/已过期/);assert.equal(calls,1);assert.equal((await engine.snapshot()).tasks[0].approvals[0].responseStatus,'uncertain');
});
test('MCP persistent consent is allowed only when advertised and records the selected decision without classifying it as a refusal',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-mcp-consent-receipt-'));let calls=0,release:()=>void=()=>{};
  const executor={run:async({update,signal}:import('../src/types.js').ExecutionRequest)=>{await update({kind:'approval',approval:{id:'app',method:'mcpServer/elicitation/request',title:'Safari',detail:'Allow Safari',questions:[],state:'pending',options:[{decision:'decline',label:'Decline'},{decision:'acceptAlways',label:'Always allow'}]}});await new Promise<void>(resolve=>{release=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});return 'done';},answer:async(_id:string,_approval:string,decision:string)=>{calls++;assert.equal(decision,'acceptAlways');},steer:async()=>{}};
  const engine=await new Engine(directory,executor,undefined,{changeRequestSyncIntervalMs:0}).open();t.after(async()=>{release();await engine.close();await rm(directory,{recursive:true,force:true});});
  const id=await engine.createTask({agent:'codex',projectId:null,mode:'research',prompt:'fixture',requestId:'start'}),deadline=Date.now()+5000;
  while((await engine.snapshot()).tasks[0].status!=='waiting'){if(Date.now()>deadline)throw new Error('MCP consent fixture did not wait');await new Promise(resolve=>setTimeout(resolve,5));}
  await assert.rejects(engine.answer(id,'app','acceptForSession',{},'unsupported-session'),/不支持/);assert.equal(calls,0);
  await engine.answer(id,'app','acceptAlways',{},'app-consent');await engine.answer(id,'app','acceptAlways',{},'app-consent');assert.equal(calls,1);
  const task=(await engine.snapshot()).tasks[0];assert.equal(task.approvals[0].decision,'acceptAlways');assert.ok(task.events.some(event=>event.text==='已允许并保留授权'));assert.ok(!task.events.some(event=>event.text==='已拒绝本次操作'));
});
