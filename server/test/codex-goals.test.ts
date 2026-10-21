import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor } from '../src/codex.js';
import { parseCodexGoalCommand, parseCodexFeedbackCommand } from '../src/codex-goals.js';
import type { ExecutionUpdate, WorkItem } from '../src/types.js';
import { Engine } from '../src/engine.js';
const command=fileURLToPath(new URL('./fixtures/codex-goals.mjs',import.meta.url));
const work=(cwd:string):WorkItem=>({id:'test',title:'test',prompt:'test',projectId:'project',cwd,agent:'codex',mode:'code',status:'running',createdAt:'',updatedAt:'',durableId:1,threadId:null,turnId:null,result:'',error:null,events:[],approvals:[],artifact:null,lastRequestId:'request'});
const wire=async(directory:string)=>(await readFile(join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
test('Goal and feedback parsers preserve pinned command boundaries, case, arguments and ECMAScript whitespace',()=>{
  for(const text of ['/goal',' /goal edit ','/goal EDIT','\ufeff/goal\ufeff'])assert.deepEqual(parseCodexGoalCommand(text),{type:'show'});
  for(const type of ['pause','resume','clear'] as const)assert.deepEqual(parseCodexGoalCommand('/goal '+type.toUpperCase()),{type});
  assert.deepEqual(parseCodexGoalCommand('/goal Build\nall changes'),{type:'set',objective:'Build\nall changes'});
  for(const text of ['/Goal foo','/goals','x /goal','\u0085/goal'])assert.equal(parseCodexGoalCommand(text),null);
  assert.deepEqual(parseCodexFeedbackCommand('/Feedback problem\nwith output'),{reason:'problem\nwith output'});
  assert.deepEqual(parseCodexFeedbackCommand(' /feedback '),{});assert.equal(parseCodexFeedbackCommand('/feedback-status'),null);
});
test('A native goal starts paused, uses the selected turn configuration, holds automatic continuations and publishes terminal usage',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-goals-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);
  const updates:ExecutionUpdate[]=[];const executor=new CodexExecutor(command);
  const result=await executor.run({task:{...work(directory),interactionMode:'plan'},prompt:'Friday wrapper must not become the objective',userText:'/goal Build all changes',signal:AbortSignal.timeout(5000),update:async value=>{updates.push(value);await new Promise(resolve=>setTimeout(resolve,8));}});
  assert.equal(result,'Result goal-turn-2');const calls=await wire(directory);
  assert.deepEqual(calls.filter(call=>call.method==='thread/goal/set').map(call=>call.params.status),['paused','active']);
  const turn=calls.find(call=>call.method==='turn/start').params;assert.equal(turn.input[0].text,'Build all changes');assert.equal(turn.collaborationMode.mode,'plan');assert.equal(turn.sandboxPolicy.type,'readOnly');
  assert.deepEqual(updates.filter(value=>value.kind==='turn').map(value=>value.turnId),['goal-turn-1','goal-turn-2']);
  assert.ok(updates.some(value=>value.kind==='goal'&&value.goal?.status==='complete'&&value.goal.tokensUsed===1250));await executor.close();
});
test('Read, pause and clear goal commands never create a native turn; resume starts with empty input',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-goal-controls-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);
  const executor=new CodexExecutor(command);const task={...work(directory),threadId:'goal-thread'};const run=(text:string)=>executor.run({task,prompt:text,userText:text,signal:AbortSignal.timeout(5000),update:async()=>{}});
  assert.equal(await run('/goal'),'No goal is set.');
  await writeFile(join(directory,'goal.json'),JSON.stringify({objective:'Saved objective',status:'paused',tokensUsed:10,timeUsedSeconds:1}));
  assert.match(await run('/goal edit'),/Saved objective/);assert.match(await run('/goal pause'),/paused/);
  assert.equal((await wire(directory)).filter(call=>call.method==='turn/start').length,0);
  assert.equal(await run('/goal resume'),'Result goal-turn-2');assert.deepEqual((await wire(directory)).find(call=>call.method==='turn/start').params.input,[]);
  assert.equal(await run('/goal clear'),'Goal cleared.');await executor.close();
});
test('Stop during goal activation pauses again after a racing activation response and cannot authorize a later turn',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-goal-stop-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);
  await writeFile(join(directory,'hold-activation'),'');const executor=new CodexExecutor(command),abort=new AbortController();
  const running=executor.run({task:work(directory),prompt:'/goal Build all changes',signal:abort.signal,update:async value=>{if(value.kind==='goal'&&value.goal?.status==='active'){abort.abort();await writeFile(join(directory,'release-activation'),'');}}});
  await assert.rejects(running,/中止|abort|closed|结束|关闭/);const calls=await wire(directory);const active=calls.findIndex(call=>call.method==='thread/goal/set'&&call.params.status==='active');
  assert.ok(calls.slice(active+1).some(call=>call.method==='thread/goal/set'&&call.params.status==='paused'));assert.equal(calls.filter(call=>call.method==='turn/start').length,1);await executor.close();
});
test('Durable goal history survives restart with every automatic turn, and rewind removes the complete native suffix from the original user message',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'friday-goal-history-'));await chmod(command,0o755);
  let engine=await new Engine(directory,new CodexExecutor(command),undefined,{changeRequestSyncIntervalMs:0}).open();t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const id=await engine.createTask({agent:'codex',projectId:null,mode:'research',prompt:'/goal Finish the checked task',requestId:'goal-history'});
  const wait=async(check:(value:WorkItem)=>boolean)=>{const limit=Date.now()+5000;while(true){const value=(await engine.snapshot()).tasks.find(value=>value.id===id)!;if(check(value))return value;if(Date.now()>limit)throw new Error('Goal history did not settle: '+value.status+' '+value.error);await new Promise(resolve=>setTimeout(resolve,10));}};
  const completed=await wait(value=>value.status==='completed');assert.equal(completed.goal?.status,'complete');assert.deepEqual(completed.runs?.[0].nativeTurnIds,['goal-turn-1','goal-turn-2']);assert.equal(completed.runs?.[0].turnId,'goal-turn-2');assert.equal(completed.messages?.[0].turnId,'goal-turn-1');
  await engine.close();engine=await new Engine(directory,new CodexExecutor(command),undefined,{changeRequestSyncIntervalMs:0}).open();
  const messageId=completed.messages![0].id,options=await engine.taskRewinds.options(id,messageId);
  await engine.taskRewinds.start(id,{requestId:'rewind-goal',messageId,fingerprint:options.fingerprint,restoreFiles:false});
  const reverted=await wait(value=>value.rewindOperation?.status==='completed');assert.deepEqual(reverted.rewindOperation?.removeTurns,['goal-turn-1','goal-turn-2']);assert.deepEqual(JSON.parse(await readFile(join(directory,'artifacts','native-turns.json'),'utf8')),[]);
});
