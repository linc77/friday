import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planWorkspace, prepareWorkspace, retryWorkspacePlan, workspaceSelection } from '../src/task-workspace.js';
import { prepareWorktreeSubmodules } from '../src/task-workspace-git-preparation.js';
import { resolveSourceControlPreferences, saveSourceControlPreferences } from '../src/source-control-preferences.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { TaskWorkspacePlan } from '../src/types.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c','core.hooksPath=/dev/null','-C',cwd,...args], { encoding:'utf8', stdio:['ignore','pipe','pipe'] }).trim();
const commit = (cwd: string) => { git(cwd,'add','.'); git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','commit','-m','fixture'); return git(cwd,'rev-parse','HEAD'); };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(),'friday-workspace-git-'))), repo=join(root,'repo'); await mkdir(repo); git(repo,'init','-b','main');
  await writeFile(join(repo,'file'),'first'); const first=commit(repo), origin=join(root,'origin.git'); git(repo,'clone','--bare','.',origin); git(repo,'remote','add','origin',origin);
  await writeFile(join(repo,'file'),'second'); const second=commit(repo); git(repo,'push','origin','main'); git(repo,'reset','--hard',first);
  return {root,repo,origin,first,second,close:()=>rm(root,{recursive:true,force:true})};
}
const prepare = (plan: TaskWorkspacePlan) => prepareWorkspace(plan,async()=>{plan.state='preparing';},undefined,async patch=>{Object.assign(plan,patch);});

test('Origin fetch uses the new remote commit, preserves the local branch and dirty files, and pins the receipt before checkout',async t=>{
  const f=await fixture();t.after(f.close);await writeFile(join(f.repo,'file'),'local edit');
  const plan=await planWorkspace({mode:'worktree'},f.repo,f.root,'remote');assert.equal(plan.commit,f.first);
  let acknowledged=false;
  await prepareWorkspace(plan,async()=>{assert(acknowledged);plan.state='preparing';},undefined,async patch=>{
    if(patch.fetch?.status==='done'){assert.equal(patch.commit,f.second);assert.equal(plan.state,'pending');acknowledged=true;}
    Object.assign(plan,patch);
  });
  assert.equal(git(plan.root,'rev-parse','HEAD'),f.second);assert.equal(git(f.repo,'rev-parse','HEAD'),f.first);assert.equal(await readFile(join(f.repo,'file'),'utf8'),'local edit');
  assert.equal(plan.fetch?.status,'done');assert.equal(plan.checkout?.status,'done');assert.equal(plan.submodules?.status,'skipped');
  const local=await planWorkspace({mode:'worktree',startFromOrigin:false},f.repo,f.root,'local');await prepare(local);assert.equal(git(local.root,'rev-parse','HEAD'),f.first);assert.equal(local.fetch?.status,'skipped');
});

test('Local-only branches and absent origin retain the selected commit; interrupted fetch requires explicit retry',async t=>{
  const f=await fixture();t.after(f.close);git(f.repo,'branch','local-only');
  const local=await planWorkspace({mode:'worktree',branch:'refs/heads/local-only'},f.repo,f.root,'local-only');await prepare(local);assert.equal(local.commit,f.first);assert.match(local.fetch!.detail!,/同名分支/);
  const interrupted=await planWorkspace({mode:'worktree'},f.repo,f.root,'interrupted');interrupted.fetch={status:'running',startedAt:'2026-10-20T00:00:00Z'};
  await assert.rejects(prepare(interrupted),/明确重试/);assert.equal(git(f.repo,'rev-parse','refs/remotes/origin/main'),f.second);
  const retry=await retryWorkspacePlan(interrupted);assert.equal(retry.fetch,undefined);await prepare(retry);assert.equal(retry.commit,f.second);
  git(f.repo,'remote','add','upstream',f.origin);git(f.repo,'update-ref','refs/remotes/upstream/feature',f.first);
  const other=await planWorkspace({mode:'worktree',branch:'refs/remotes/upstream/feature'},f.repo,f.root,'other-remote');await prepare(other);assert.equal(other.commit,f.first);assert.equal(other.fetch?.status,'done');
  git(f.repo,'remote','remove','origin');const noRemote=await planWorkspace({mode:'worktree'},f.repo,f.root,'no-origin');await prepare(noRemote);assert.equal(noRemote.fetch?.status,'skipped');assert.equal(noRemote.commit,f.first);
  for(const value of [{mode:'worktree',startFromOrigin:'true'},{mode:'checkout',startFromOrigin:true},{mode:'worktree',preparationId:'00000000-0000-0000-0000-000000000001',startFromOrigin:true}])assert.throws(()=>workspaceSelection(value));
});
test('Cancellation after the fetch intent leaves no checkout and recovery refuses another remote operation',async t=>{
  const f=await fixture();t.after(f.close);const plan=await planWorkspace({mode:'worktree'},f.repo,f.root,'cancelled'),controller=new AbortController();
  await assert.rejects(prepareWorkspace(plan,async()=>assert.fail('no checkout'),controller.signal,async patch=>{Object.assign(plan,patch);if(patch.fetch?.status==='running')controller.abort();}));
  assert.equal(plan.fetch?.status,'running');await assert.rejects(readFile(join(plan.root,'file')));assert.equal(git(f.repo,'rev-parse','HEAD'),f.first);
  await assert.rejects(prepare(plan),/明确重试/);
});

test('Submodule modes use settings before t3.json, initialize nested repositories, and preserve warnings without replay',async t=>{
  const f=await fixture();t.after(f.close);const previousHome=process.env.HOME,home=join(f.root,'home');await mkdir(home);await writeFile(join(home,'.gitconfig'),'[protocol "file"]\n\tallow = always\n');process.env.HOME=home;
  t.after(()=>{if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;});
  const leaf=join(f.root,'leaf'),child=join(f.root,'child');for(const repo of [leaf,child]){await mkdir(repo);git(repo,'init','-b','main');await writeFile(join(repo,'file'),'submodule');commit(repo);}
  git(child,'submodule','add',leaf,'nested');commit(child);git(f.repo,'submodule','add',child,'child');await writeFile(join(f.repo,'t3.json'),'{"worktreeSubmodules":"none"}');commit(f.repo);
  const fileMode=await planWorkspace({mode:'worktree',startFromOrigin:false},f.repo,f.root,'file-mode');await prepare(fileMode);assert.equal(fileMode.submodules?.status,'skipped');assert.equal(fileMode.submodules?.mode,'none');await assert.rejects(readFile(join(fileMode.root,'child','file')));
  const top=await planWorkspace({mode:'worktree',startFromOrigin:false},f.repo,f.root,'top');top.submoduleMode='top-level';await prepare(top);assert.equal(await readFile(join(top.root,'child','file'),'utf8'),'submodule');await assert.rejects(readFile(join(top.root,'child','nested','file')));
  const recursive=await planWorkspace({mode:'worktree',startFromOrigin:false},f.repo,f.root,'recursive');recursive.submoduleMode='recursive';await prepare(recursive);assert.equal(recursive.submodules?.status,'done');assert.equal(await readFile(join(recursive.root,'child','nested','file'),'utf8'),'submodule');
  const failed=await planWorkspace({mode:'worktree',startFromOrigin:false},f.repo,f.root,'warning');failed.submoduleMode='recursive';git(f.repo,'config','submodule.child.url',join(f.root,'missing.git'));await prepare(failed);assert.equal(failed.submodules?.status,'warning');assert.equal(git(failed.root,'rev-parse','HEAD'),failed.commit);
  // Recovery acknowledges an unknown result rather than repeating submodule update.
  recursive.submodules={status:'running',mode:'recursive',startedAt:'2026-10-20T00:00:00Z'};await writeFile(join(recursive.root,'child','file'),'keep');await prepareWorktreeSubmodules(recursive);assert.equal(recursive.submodules.status,'warning');assert.equal(await readFile(join(recursive.root,'child','file'),'utf8'),'keep');
});

test('Scoped defaults survive old settings, reset independently, validate types and reach new task plans and native options',async t=>{
  const f=await fixture();const data=join(f.root,'data'),engine=await new Engine(data,{async run(request){await request.update({kind:'session',threadId:'fixture'});return 'done';},async answer(){},async steer(){}}).open();
  t.after(async()=>{await engine.close();await f.close();});await engine.mutate(s=>{s.projects.push({id:'p',name:'Fixture',path:f.repo,context:''});s.sourceControlPreferences={version:2,defaults:{removeAgentCreditsOnMerge:true},projects:{}};});
  assert.equal(resolveSourceControlPreferences(await engine.snapshot(),'p').effective.newWorktreesStartFromOrigin,true);
  await saveSourceControlPreferences(engine,{projectId:null,expectedVersion:2,changes:{newWorktreesStartFromOrigin:false,worktreeSubmodules:'none'}});
  let value=await saveSourceControlPreferences(engine,{projectId:'p',expectedVersion:3,changes:{newWorktreesStartFromOrigin:true,worktreeSubmodules:null}});assert.equal(value.effective.worktreeSubmodules,null);assert.equal(value.sources.worktreeSubmodules,'workspace');
  value=await saveSourceControlPreferences(engine,{projectId:'p',expectedVersion:4,reset:['newWorktreesStartFromOrigin','worktreeSubmodules']});assert.equal(value.effective.newWorktreesStartFromOrigin,false);assert.equal(value.effective.worktreeSubmodules,'none');assert.equal(value.effective.removeAgentCreditsOnMerge,true);
  for(const changes of [{worktreeSubmodules:'shallow'},{newWorktreesStartFromOrigin:null},{worktreeSubmodules:{toString:'recursive'}},{unknown:true}])await assert.rejects(saveSourceControlPreferences(engine,{projectId:'p',expectedVersion:5,changes}),/字段/);
  const auth=new Auth(data);t.after(()=>auth.close());const app=createAPI(engine,auth,()=>[]),headers={Authorization:'Bearer '+auth.token};const options=await(await app.request('/api/projects/p/git',{headers})).json();assert.equal(options.preparationDefaults.newWorktreesStartFromOrigin,false);
  const id=await engine.createTask({projectId:'p',prompt:'fixture',mode:'code',agent:'codex',requestId:'local',workspace:{mode:'worktree'}});const task=await settled(engine,id);assert.equal(task.executionWorkspace?.startFromOrigin,false);assert.equal(task.executionWorkspace?.submoduleMode,'none');assert.equal(task.executionWorkspace?.commit,f.first);
});

async function settled(engine:Engine,id:string){const deadline=Date.now()+15000;while(Date.now()<deadline){const task=(await engine.snapshot()).tasks.find(t=>t.id===id);if(task&&['completed','failed'].includes(task.status))return task;await new Promise(r=>setTimeout(r,10));}throw new Error('fixture did not settle');}

test('Failed fetch stops before Agent execution; an explicit same-run retry fetches once and resumes on the saved remote commit',async t=>{
  const f=await fixture();let calls=0;const engine=await new Engine(join(f.root,'data'),{async run(){calls++;return 'done';},async answer(){},async steer(){}}).open();t.after(async()=>{await engine.close();await f.close();});
  await engine.mutate(s=>s.projects.push({id:'p',name:'Fixture',path:f.repo,context:''}));git(f.repo,'remote','set-url','origin',join(f.root,'missing.git'));
  const id=await engine.createTask({projectId:'p',prompt:'fixture',mode:'code',agent:'codex',requestId:'fetch-fail',workspace:{mode:'worktree'}}),failed=await settled(engine,id);
  assert.equal(failed.status,'failed');assert.equal(calls,0);assert.equal(failed.executionWorkspace?.fetch?.status,'failed');assert.equal(failed.executionWorkspace?.state,'pending');
  git(f.repo,'remote','set-url','origin',f.origin);await engine.taskPreparations.retry(id,failed.currentRunId!,'retry-fetch');const ready=await settled(engine,id);assert.equal(ready.status,'completed');assert.equal(calls,1);assert.equal(ready.executionWorkspace?.commit,f.second);assert.equal(ready.runs![0].workspacePreparation?.attempt,2);
  await engine.taskPreparations.retry(id,failed.currentRunId!,'retry-fetch');assert.equal(calls,1);
});
