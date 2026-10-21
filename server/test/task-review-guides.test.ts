import {DatabaseSync} from 'node:sqlite';
import {Auth} from '../src/auth.js';
import {createAPI} from '../src/api.js';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,stat,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Engine} from '../src/engine.js';
import type {Executor,ExecutionRequest} from '../src/types.js';
import {textGenerationDefaults,resolveTextGenerationSettings,textGenerationSettingsChange} from '../src/text-generation-settings.js';
import {ReviewGuideStore} from '../src/task-review-guide-store.js';
import {normalizeReviewGuide,parseReviewGuideChange} from '../src/vendor/t3-review-guide-normalize.js';
import {decodeReviewGuide} from '../src/task-review-guide-types.js';
import {reviewGuideTool} from '../src/task-review-guide-tools.js';
import {sourceControlRepository} from '../src/task-change-requests.js';
import {ServiceMaintenance} from '../src/maintenance.js';
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}}).trim();
const guideText=()=>JSON.stringify({stops:[{title:'Contract first',summary:'Guide source secret',attention:{kind:'contract',note:'Check the public contract'},excerpts:[{path:'a.ts',side:'new',start:1,end:20,caption:'Main behavior'}],files:[],notes:[{path:'a.ts',line:1,title:'Design',body:'Intent, not a finding'}],questions:['Why this contract?']}]});
async function until<T>(read:()=>Promise<T>,ready:(v:T)=>boolean){const end=Date.now()+15000;while(Date.now()<end){const value=await read();if(ready(value))return value;await new Promise(r=>setTimeout(r,15));}throw Error('Guide fixture timed out');}
async function setup(t:{after(fn:()=>Promise<unknown>):void}){
  const dir=await mkdtemp(join(tmpdir(),'friday-guide-')),cwd=join(dir,'repo'),data=join(dir,'data'),bare=join(dir,'remote.git');await mkdir(cwd);
  git(cwd,'init','-q','-b','main');git(cwd,'config','user.name','Fixture');git(cwd,'config','user.email','fixture@example.test');
  await writeFile(join(cwd,'a.ts'),'old\nunchanged\n');git(cwd,'add','.');git(cwd,'commit','-qm','base');git(cwd,'checkout','-qb','linc/feature');await writeFile(join(cwd,'a.ts'),'new\nunchanged\n');await writeFile(join(cwd,'other.ts'),'other\n');git(cwd,'add','.');git(cwd,'commit','-qm','feature');
  git(dir,'clone','-q','--bare',cwd,bare);git(cwd,'remote','add','origin','https://github.com/fixture/project.git');git(cwd,'config',`url.file://${bare}.insteadOf`,'https://github.com/fixture/project.git');git(cwd,'config','protocol.file.allow','always');
  const url='https://github.com/fixture/project/pull/17',repo=sourceControlRepository('https://github.com/fixture/project.git')!;
  const state={head:git(cwd,'rev-parse','HEAD'),calls:[] as ExecutionRequest[],executions:0,reads:0,hold:false,invalid:false,stack:false};
  const executor:Executor={async run(request){state.executions++;if(request.purpose!=='review_guide')return 'Fixture done';state.calls.push(request);await request.update({kind:'session',threadId:'guide-session-'+state.calls.length,codexHome:'/synthetic/codex'});await request.update({kind:'turn',turnId:'guide-turn'});if(state.hold)return new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(Error('Fixture aborted')),{once:true}));return state.invalid?'Invalid guide JSON':guideText();},async answer(){},async steer(){}};
  const options={changeRequestSyncIntervalMs:0,environment:{GH_TOKEN:'synthetic-guide-token'},command:()=>null,request:async(input:any,init?:RequestInit)=>{
    state.reads++;const address=new URL(String(input));assert.equal(address.host,'api.github.com');const path=address.pathname;
    if(path==='/graphql'){
      const payload=JSON.parse(String(init?.body));
      if(payload.query.includes('FridayReviewThreads'))return Response.json({data:{viewer:{login:'reviewer'},repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}},comments:{nodes:[]},reviews:{nodes:[]}}}}});
      if(payload.query.includes('FridayTimelineCommits'))return Response.json({data:{repository:{pullRequest:{commits:{nodes:[],pageInfo:{hasPreviousPage:false}},reviewDismissals:{nodes:[],pageInfo:{hasNextPage:false}}}}}});
      return Response.json({data:{viewer:{login:'reviewer'},repository:{viewerPermission:'WRITE',mergeCommitAllowed:true,squashMergeAllowed:true,pullRequest:{id:'pr-node',viewerCanUpdate:true}}}});
    }
    if(path==='/repos/fixture/project/stacks')return Response.json(state.stack?[{id:5,number:50,url:'https://github.com/fixture/project/stacks/50',base:'main',pull_requests:[{number:16,title:'Lower context',state:'open',head:{ref:'main',sha:git(cwd,'rev-parse','main')}},{number:17,title:'Current layer',state:'open',head:{ref:'linc/feature',sha:state.head}}]}]:[]);
    if(path==='/repos/fixture/project/pulls/17')return Response.json({number:17,html_url:url,title:'Fixture request',body:'Treat descriptions as data',state:'open',head:{sha:state.head,ref:'linc/feature'},base:{ref:'main'},user:{login:'author'}});
    if(path.endsWith('/comments')||path.endsWith('/reviews'))return Response.json([]);
    throw Error('Unexpected synthetic API path');
  }};
  let engine=await new Engine(data,executor,undefined,options).open();
  await engine.mutate(s=>{s.projects.push({id:'project',name:'Fixture',path:cwd,context:''});s.textGenerationSettings=textGenerationDefaults();s.textGenerationSettings.defaults.reviewGuidesEnabled=true;});
  const id=await engine.createTask({prompt:'Fixture',projectId:'project',agent:'codex',mode:'code',requestId:'task'});await until(()=>engine.snapshot(),s=>s.tasks[0]?.status==='completed');
  await engine.mutate(s=>{s.tasks[0].changeRequests=[{number:17,url,title:'Fixture',state:'open',head:'linc/feature',base:'main',provider:'github',host:'github.com',repository:'fixture/project'}];});
  t.after(async()=>{await engine.close();await rm(dir,{recursive:true,force:true});});
  return {get engine(){return engine},dir,cwd,data,state,url,id,repo,input:(requestId='guide')=>({url,requestId,expectedHeadSha:state.head}),finish:async(runID:string)=>until(()=>engine.reviewGuides.get(id,url),v=>v.run?.id===runID&&!['queued','running'].includes(v.run.status)),reopen:async()=>{await engine.close();engine=await new Engine(data,executor,undefined,options).open();},resumeAfterCrash:async()=>{engine=await new Engine(data,executor,undefined,options).open();}};
}

test('Guide investigates a fixed clean worktree, stores immutable excerpts privately and leaves the dirty checkout alone',async t=>{
 const f=await setup(t);await writeFile(join(f.cwd,'a.ts'),'USER DIRTY\n');
 const id=await f.engine.reviewGuides.start(f.id,f.input()),result=await f.finish(id);
 assert.equal(result.run?.status,'completed',result.run?.error);assert.equal(result.guide?.headSha,f.state.head);assert(f.state.calls[0].task.cwd.startsWith(join(f.data,'review-guide-checkouts')));assert.notEqual(f.state.calls[0].task.cwd,f.cwd);assert.equal(f.state.calls[0].purpose,'review_guide');assert.match(f.state.calls[0].prompt,/Investigate before you answer, read-only/);
 assert.equal(result.excerpts[0].lines[0].text,'new');assert.deepEqual(result.excerpts[0].lines[0].position,{kind:'added',newLine:1});assert(result.guide?.stops.some(s=>s.files.some(file=>file.path==='other.ts')));
 assert.equal(await readFile(join(f.cwd,'a.ts'),'utf8'),'USER DIRTY\n');assert.equal(git(f.cwd,'for-each-ref','--format=%(refname)','refs/friday/review-guide'),'');assert.deepEqual(await readdir(join(f.data,'review-guide-checkouts')),[]);
 const snapshot=JSON.stringify(await f.engine.snapshot());assert(!snapshot.includes('Guide source secret'));assert(!snapshot.includes('guide-session'));assert(!snapshot.includes('synthetic-guide-token'));assert.equal((await stat(join(f.data,'source-control-guides.sqlite'))).mode&0o777,0o600);
 await f.reopen();assert.equal((await f.engine.reviewGuides.get(f.id,f.url)).excerpts[0].lines[0].text,'new');assert.equal(await f.engine.reviewGuides.start(f.id,f.input()),id);assert.equal(f.state.calls.length,1);
});

test('Concurrent guide requests share a running head; cancellation blocks maintenance and is never automatically replayed',async t=>{
 const f=await setup(t);f.state.hold=true;const [first,second]=await Promise.all([f.engine.reviewGuides.start(f.id,f.input('a')),f.engine.reviewGuides.start(f.id,f.input('b'))]);assert.equal(first,second);await until(async()=>f.state.calls.length,n=>n===1);
 await assert.rejects(new ServiceMaintenance(()=>f.engine.snapshot()).prepare(),/Guide/);
 await f.engine.reviewGuides.cancel(f.id,f.url,first);assert.equal((await f.finish(first)).run?.status,'interrupted');await f.reopen();assert.equal(await f.engine.reviewGuides.start(f.id,f.input('a')),first);assert.equal(f.state.calls.length,1);assert.equal(git(f.cwd,'for-each-ref','--format=%(refname)','refs/friday/review-guide'),'');
});

test('A failed rewrite preserves the old tour and immutable excerpts, and stale heads require a fresh request',async t=>{
 const f=await setup(t);const first=await f.engine.reviewGuides.start(f.id,f.input());const good=await f.finish(first);f.state.invalid=true;
 const second=await f.engine.reviewGuides.start(f.id,f.input('rewrite'));const bad=await f.finish(second);assert.equal(bad.run?.status,'failed');assert.equal(bad.guide?.generatedAt,good.guide?.generatedAt);assert.equal(bad.excerpts[0].lines[0].text,'new');
 f.state.head='c'.repeat(40);const stale=await f.engine.reviewGuides.get(f.id,f.url);assert.notEqual(stale.guide?.headSha,stale.currentHeadSha);await assert.rejects(f.engine.reviewGuides.start(f.id,{...f.input('stale'),expectedHeadSha:good.guide!.headSha}),/代码版本已改变/);assert.equal(f.state.calls.length,2);
});

test('Guide refuses another repository, disabled generation and request ID reuse before launching an agent',async t=>{
 const f=await setup(t);git(f.cwd,'remote','set-url','origin','https://github.com/other/repository.git');await assert.rejects(f.engine.reviewGuides.start(f.id,f.input()),/所属仓库/);assert.equal(f.state.calls.length,0);
 git(f.cwd,'remote','set-url','origin','https://github.com/fixture/project.git');await f.engine.mutate(s=>{s.textGenerationSettings!.defaults.reviewGuidesEnabled=false;});await assert.rejects(f.engine.reviewGuides.start(f.id,f.input()),/启用/);
 await f.engine.mutate(s=>{s.textGenerationSettings!.defaults.reviewGuidesEnabled=true;});const id=await f.engine.reviewGuides.start(f.id,f.input());await f.finish(id);await assert.rejects(f.engine.reviewGuides.start(f.id,{...f.input(),expectedHeadSha:'c'.repeat(40)}),/不同内容/);
});

test('Guide settings inherit writer models, preserve old settings and require a host-owned enable switch',()=>{
 const state:any={projects:[{id:'p'}],textGenerationSettings:{version:4,defaults:{textGenerationModelSelection:{agent:'codex',model:'base',reasoningEffort:''},sourceControlWriterModelSelection:{agent:'claude',model:'writer',reasoningEffort:''}},projects:{}}};
 let view=resolveTextGenerationSettings(state,'p',{codex:true,claude:true});assert.equal(view.effective.reviewGuidesEnabled,false);assert.equal(view.effective.reviewGuideModelSelection.model,'writer');
 state.textGenerationSettings.defaults.reviewGuidesEnabled=true;state.textGenerationSettings.projects.p={reviewGuideModelSelection:{agent:'codex',model:'guide',reasoningEffort:'high'},reviewGuideInstructions:'Reader focus'};view=resolveTextGenerationSettings(state,'p',{codex:true,claude:true});assert.equal(view.effective.reviewGuideModelSelection.model,'guide');assert.equal(view.effective.reviewGuideInstructions,'Reader focus');
 assert.throws(()=>textGenerationSettingsChange({projectId:'p',expectedVersion:4,changes:{reviewGuidesEnabled:true}}),/主机/);assert.equal(textGenerationSettingsChange({projectId:null,expectedVersion:4,changes:{reviewGuideInstructions:'  Focus  '}}).changes.reviewGuideInstructions,'Focus');
});

test('T3 guide shaping clamps changed lines, merges excerpts, limits them to 25 lines and accounts for other files',()=>{
 const change=parseReviewGuideChange('a.ts\0other.ts\0','diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,30 +1,30 @@\n');const raw=JSON.parse(guideText());raw.stops[0].excerpts=[{path:'a.ts',side:'new',start:30,end:1,caption:'Wide'},{path:'foreign',side:'new',start:1,end:5,caption:''}];
 const guide=normalizeReviewGuide(decodeReviewGuide(JSON.stringify(raw)),change);assert.deepEqual(guide.stops[0].excerpts.map(e=>[e.start,e.end]),[[1,25]]);assert.equal(guide.stops.at(-1)?.files[0].path,'other.ts');assert.equal(guide.stops[0].notes.length,1);assert.throws(()=>decodeReviewGuide('{"stops":[]} trailing'),/结构化/);
});

test('Read-only guide tools refuse write commands, shell operators, output flags and reads outside their checkout',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'friday-guide-tools-')),inside=join(dir,'checkout');await mkdir(inside);await writeFile(join(inside,'a.ts'),'a');await writeFile(join(dir,'outside'),'private');await symlink(join(dir,'outside'),join(inside,'link'));t.after(()=>rm(dir,{recursive:true,force:true}));
 assert.equal((await reviewGuideTool('Read',{file_path:'a.ts'},inside)).behavior,'allow');assert.equal((await reviewGuideTool('Read',{file_path:'link'},inside)).behavior,'deny');assert.equal((await reviewGuideTool('Bash',{command:'git diff HEAD~1...HEAD -- a.ts'},inside)).behavior,'allow');
 for(const command of ['git diff --output=/tmp/a','git show HEAD; touch x','git log $(touch x)','git show HEAD > x','git -c alias.x=bad x','npm test'])assert.equal((await reviewGuideTool('Bash',{command},inside)).behavior,'deny');
 assert.equal((await reviewGuideTool('Write',{file_path:'a.ts'},inside)).behavior,'deny');
});


test('A real process death after the durable external-session receipt never repeats the uncertain model request',async t=>{
 const f=await setup(t),marker=join(f.dir,'crash-marker');await f.engine.close();
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/review-guide-crash.ts',import.meta.url)),f.data,f.id,f.url,f.cwd,f.state.head,marker],{stdio:'ignore',env:{PATH:process.env.PATH,LANG:'en_US.UTF-8'}});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill('SIGKILL');await ended;}});
 await until(async()=>({marker:await readFile(marker,'utf8').catch(()=>''),run:await readFile(marker+'.run','utf8').catch(()=>'' )}),v=>v.marker.includes('model-started')&&/^[\w-]{36}$/.test(v.run.trim()));
 const ended=once(child,'exit');child.kill('SIGKILL');await ended;await f.resumeAfterCrash();
 const runID=(await readFile(marker+'.run','utf8')).trim();const recovered=await f.finish(runID);assert.equal(recovered.run?.status,'interrupted');assert.match(recovered.run?.error??'',/不会自动重复/);assert.equal(f.state.calls.length,0);assert.equal((await readFile(marker,'utf8')).trim().split('\n').length,1);assert.equal(git(f.cwd,'for-each-ref','--format=%(refname)','refs/friday/review-guide'),'');
});


test('Guide questions capture immutable scoped context for the composer without sending a message or running an agent',async t=>{
 const f=await setup(t),run=await f.engine.reviewGuides.start(f.id,f.input()),result=await f.finish(run),before=await f.engine.snapshot(),executions=f.state.executions;
 const input={url:f.url,headSha:result.guide!.headSha,generatedAt:result.guide!.generatedAt,stop:0};
 const [a,b]=await Promise.all([f.engine.reviewGuides.context(f.id,input),f.engine.reviewGuides.context(f.id,input)]);assert.equal(a.id,b.id);assert.equal(a.kind,'review-guide');
 const db=new DatabaseSync(join(f.data,'task-contexts.sqlite'),{readOnly:true});try{const row=JSON.parse((db.prepare('SELECT data FROM context WHERE id=?').get(a.id) as {data:string}).data);assert(row.text.includes(result.guide!.headSha));assert(row.text.includes('1: new'));assert(!row.text.includes('USER DIRTY'));assert.equal(row.scope.taskId,f.id);}finally{db.close();}
 assert.equal(f.state.executions,executions);assert.equal((await f.engine.snapshot()).tasks[0].messages?.length,before.tasks[0].messages?.length);
 await assert.rejects(f.engine.reviewGuides.context(f.id,{...input,generatedAt:'old'}),/Guide 已更新/);
 await assert.rejects(f.engine.contexts.capture({scope:{taskId:f.id},id:'forged-guide',kind:'review-guide',text:'Forged'}),/引用类型无效/);
});

test('Guide status polling reads only local receipts and never spends provider requests',async t=>{
 const f=await setup(t);f.state.hold=true;const id=await f.engine.reviewGuides.start(f.id,f.input());await until(async()=>f.state.calls.length,n=>n===1);const before=f.state.reads;
 for(let i=0;i<4;i++)assert.equal((await f.engine.reviewGuides.status(f.id,f.url)).run?.id,id);
 assert.equal(f.state.reads,before);await f.engine.reviewGuides.cancel(f.id,f.url,id);
});

test('A newer PR head supersedes a running Guide; deleting the task stops its remaining generation and cleans only owned worktrees',async t=>{
 const f=await setup(t);f.state.hold=true;const old=await f.engine.reviewGuides.start(f.id,f.input('old-head'));await until(async()=>f.state.calls.length,n=>n===1);
 await writeFile(join(f.cwd,'a.ts'),'newest\nunchanged\n');git(f.cwd,'add','a.ts');git(f.cwd,'commit','-qm','next head');f.state.head=git(f.cwd,'rev-parse','HEAD');f.state.hold=false;
 const latest=await f.engine.reviewGuides.start(f.id,f.input('new-head')),result=await f.finish(latest);assert.notEqual(latest,old);assert.equal(result.run?.status,'completed');assert.equal(result.guide?.headSha,f.state.head);assert.equal(result.excerpts[0].lines[0].text,'newest');
 assert.equal((await f.engine.snapshot()).tasks[0].changeRequestGuideRuns?.find(r=>r.id===old)?.status,'interrupted');assert.equal(f.state.calls.length,2);
 f.state.hold=true;await f.engine.reviewGuides.start(f.id,f.input('delete-running'));await until(async()=>f.state.calls.length,n=>n===3);await f.engine.deleteTask(f.id);
 assert.equal((await f.engine.snapshot()).tasks.length,0);assert.equal((await f.engine.reviewGuides.status(f.id,f.url)).run,null);assert.equal(git(f.cwd,'for-each-ref','--format=%(refname)','refs/friday/review-guide'),'');assert.deepEqual(await readdir(join(f.data,'review-guide-checkouts')),[]);assert.equal(git(f.cwd,'rev-parse','HEAD'),f.state.head);
});

test('Guide and context HTTP endpoints authenticate and reject unassociated tasks without starting generation',async t=>{
 const f=await setup(t),auth=new Auth(f.data),app=createAPI(f.engine,auth);t.after(async()=>auth.close());
 const query='?'+new URLSearchParams({url:f.url}),base='/api/tasks/'+f.id+'/change-request/guide';
 for(const suffix of ['', '/status'])assert.equal((await app.request(base+suffix+query)).status,401);
 assert.equal((await app.request(base+'/context',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
 const headers={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'};
 assert.equal((await app.request('/api/tasks/missing/change-request/guide'+query,{headers})).status,400);
 assert.equal((await app.request(base+'/context',{method:'POST',headers,body:JSON.stringify({url:f.url,headSha:f.state.head,generatedAt:'missing',stop:0})})).status,400);assert.equal(f.state.calls.length,0);
});

test('Guide storage rejects symbolic links before opening the target',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'friday-guide-store-')),target=join(dir,'private-fixture');await writeFile(target,'Private fixture');await symlink(target,join(dir,'source-control-guides.sqlite'));const store=new ReviewGuideStore(dir);t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 assert.throws(()=>store.get(sourceControlRepository('https://github.com/fixture/project.git')!,17),/独立文件/);assert.equal(await readFile(target,'utf8'),'Private fixture');
});


test('A Guide captures stack context and resolves other-layer commits without expanding its reviewed files',async t=>{
 const f=await setup(t);f.state.stack=true;const id=await f.engine.reviewGuides.start(f.id,f.input()),result=await f.finish(id);assert.equal(result.run?.status,'completed',result.run?.error);
 assert.match(f.state.calls[0].prompt,/one layer of a stack/);assert.match(f.state.calls[0].prompt,/#16/);assert.match(f.state.calls[0].prompt,/Never excerpt another layer/);assert.equal(result.guide?.headSha,f.state.head);
});


test('Guide accounts for more than three hundred changed files from the pinned local diff without a host file-list limit',async t=>{
 const f=await setup(t),names=Array.from({length:305},(_,i)=>`scale-${i}.ts`);await Promise.all(names.map(name=>writeFile(join(f.cwd,name),'export const value = 1;\n')));git(f.cwd,'add','.');git(f.cwd,'commit','-qm','large change');f.state.head=git(f.cwd,'rev-parse','HEAD');
 const id=await f.engine.reviewGuides.start(f.id,f.input('scale')),result=await f.finish(id);assert.equal(result.run?.status,'completed',result.run?.error);
 const covered=new Set(result.guide!.stops.flatMap(stop=>[...stop.excerpts.map(e=>e.path),...stop.files.map(e=>e.path)]));assert.equal(covered.size,307);for(const name of names)assert(covered.has(name));assert.equal(f.state.calls.length,1);
});
