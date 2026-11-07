import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../src/engine.js';
import { CodexExecutor } from '../src/codex.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
const command=fileURLToPath(new URL('./fixtures/codex-goals.mjs',import.meta.url));
async function setup(t: import('node:test').TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'friday-feedback-'));await chmod(command,0o755);
  let engine=await new Engine(directory,new CodexExecutor(command),undefined,{changeRequestSyncIntervalMs:0}).open();
  t.after(async()=>{await engine.close();await rm(directory,{recursive:true,force:true});});
  const id=await engine.createTask({prompt:'Begin a thread',agent:'codex',projectId:null,mode:'research',requestId:'begin'});
  const limit=Date.now()+5000;while((await engine.snapshot()).tasks[0].status!=='completed'){if(Date.now()>limit)throw new Error('fixture did not complete');await new Promise(resolve=>setTimeout(resolve,10));}
  const auth=new Auth(directory);
  return {directory:join(directory,'artifacts'),id,auth,get engine(){return engine;},get app(){return createAPI(engine,auth,()=>[]);},async reopen(){await engine.close();engine=await new Engine(directory,new CodexExecutor(command),undefined,{changeRequestSyncIntervalMs:0}).open();},async calls(){return (await readFile(join(directory,'artifacts','wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}};
}
test('Explicit feedback uploads use the original native thread and logs, never start or resume model work, and repeated requests return the saved receipt',async t=>{
  const f=await setup(t),input={threadId:'goal-thread',command:'/feedback Output stopped early',requestId:'feedback-1'};
  const post=(body:object,token:string|null=f.auth.token)=>f.app.request(`/api/tasks/${f.id}/feedback`,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  assert.equal((await post(input,null)).status,401);
  const before=await f.calls();let response=await post(input);assert.equal(response.status,200);const result=await response.json();assert.equal(result.status,'sent');assert.equal(result.feedbackId,'feedback-fixture-id');
  const after=await f.calls(),uploaded=after.slice(before.length);assert.deepEqual(uploaded.find(call=>call.method==='feedback/upload').params,{classification:'bug',includeLogs:true,reason:'Output stopped early',threadId:'goal-thread'});
  assert.ok(!uploaded.some(call=>['thread/start','thread/resume','turn/start'].includes(call.method)));
  await f.reopen();response=await post(input);assert.equal((await response.json()).feedbackId,result.feedbackId);assert.equal((await f.calls()).filter(call=>call.method==='feedback/upload').length,1);
  assert.equal((await post({...input,command:'/feedback different'})).status,400);
  const snapshot=await f.engine.snapshot();assert.equal(snapshot.tasks[0].feedback?.at(-1)?.status,'sent');assert.equal(snapshot.tasks[0].runs?.length,1);
  const overview=await (await f.app.request('/api/overview',{headers:{Authorization:'Bearer '+f.auth.token}})).json();assert.equal(overview.taskFeedbackRequests,undefined);assert.equal(overview.tasks[0].feedback,undefined);
});
test('A lost feedback upload answer is recorded as uncertain and neither restart nor an identical retry uploads again',async t=>{
  const f=await setup(t);await writeFile(join(f.directory,'drop-feedback'),'');const input={threadId:'goal-thread',command:'/feedback',requestId:'uncertain'};
  assert.equal((await f.engine.taskFeedback.start(f.id,input)).status,'uncertain');await f.reopen();assert.equal((await f.engine.taskFeedback.start(f.id,input)).status,'uncertain');
  assert.equal((await f.calls()).filter(call=>call.method==='feedback/upload').length,1);
  await assert.rejects(f.engine.taskFeedback.start(f.id,{...input,threadId:'other',requestId:'stale'}),/会话/);
});
