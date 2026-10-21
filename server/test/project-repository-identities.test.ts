import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectRepositoryIdentities, readProjectRepositoryIdentity } from '../src/project-repository-identities.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import type { Workspace } from '../src/types.js';
const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
test('Real clones, nested workspaces, linked worktrees and forks retain repository boundaries without publishing remote credentials',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'friday-project-identities-')));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'repo');await mkdir(cwd);git(cwd,'init','-b','main');git(cwd,'remote','add','origin','https://user:fixture-private-token@github.com/Owner/Repo.git');
 const identity=await readProjectRepositoryIdentity(cwd);assert.equal(identity?.canonicalKey,'github.com/owner/repo');assert.equal(identity?.displayName,'Owner/Repo');assert.ok(!JSON.stringify(identity).includes('fixture-private-token'));assert.ok(!JSON.stringify(identity).includes('user:'));
 const nested=join(cwd,'packages','client');await mkdir(nested,{recursive:true});assert.deepEqual(await readProjectRepositoryIdentity(nested),identity);
 git(cwd,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','fixture');const linked=join(root,'linked');git(cwd,'worktree','add','-b','feature',linked);const worktree=await readProjectRepositoryIdentity(linked);assert.equal(worktree?.canonicalKey,identity?.canonicalKey);assert.equal(worktree?.rootPath,linked);
 git(cwd,'remote','add','upstream','git@github.com:Upstream/Repo.git');const fork=await readProjectRepositoryIdentity(cwd);assert.equal(fork?.canonicalKey,'github.com/upstream/repo');assert.deepEqual(fork?.origin,{canonicalKey:'github.com/owner/repo',displayName:'Owner/Repo'});
 git(cwd,'remote','set-url','origin','.');const noOrigin=await readProjectRepositoryIdentity(cwd);assert.equal(noOrigin?.origin,undefined);git(cwd,'remote','remove','upstream');assert.equal(await readProjectRepositoryIdentity(cwd),null);assert.equal(await readProjectRepositoryIdentity(root),null);
});
test('Only actual remote identities group repositories; environment overrides and local remotes cannot redirect the read',async t=>{
 const root=await mkdtemp(join(tmpdir(),'friday-project-identity-env-'));t.after(()=>rm(root,{recursive:true,force:true}));git(root,'init','-b','main');git(root,'remote','add','origin','file:///tmp/shared.git');assert.equal(await readProjectRepositoryIdentity(root),null);
 git(root,'remote','add','another','git@ssh.dev.azure.com:v3/Organization/Project/Repository');const previous=process.env.GIT_DIR;
 try{process.env.GIT_DIR='/does-not-exist';const identity=await readProjectRepositoryIdentity(root);assert.equal(identity?.canonicalKey,'dev.azure.com/organization/project/_git/repository');}finally{if(previous===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previous;}
});
test('Projection shares pending reads, bounds concurrency, follows positive/negative TTL and never mutates durable projects',async()=>{
 let clock=0,reads=0,active=0,peak=0;const projection=new ProjectRepositoryIdentities(async path=>{reads++;active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return path==='/none'?null:{canonicalKey:'github.com/a/'+path.slice(1),rootPath:path,displayName:'a/'+path.slice(1),name:path.slice(1)};},()=>clock);
 const state:Workspace={revision:0,ideas:[],memories:[],requests:{},tasks:[],projects:Array.from({length:9},(_,index)=>({id:String(index),name:'project',path:index===8?'/none':'/repo'+index,context:''}))},before=structuredClone(state);
 const [first,second]=await Promise.all([projection.snapshot(state),projection.snapshot(state)]);assert.equal(reads,9);assert.ok(peak<=4);assert.deepEqual(state,before);assert.deepEqual(first,second);assert.equal(first.projects[8].repositoryIdentity,undefined);
 clock=60_001;await projection.snapshot(state);assert.equal(reads,10);clock=15*60_000+1;await projection.snapshot(state);assert.equal(reads,19);
 state.projects[0].updatedAt='changed';await projection.snapshot(state);assert.equal(reads,20);
});
test('Full and overview snapshots expose the same safe live identity while SQLite retains only the saved project',async t=>{
 const root=await mkdtemp(join(tmpdir(),'friday-project-identity-api-'));t.after(()=>rm(root,{recursive:true,force:true}));git(root,'init','-b','main');git(root,'remote','add','origin','https://user:fixture-secret@github.com/Owner/Repo.git');const data=join(root,'service'),engine=await new Engine(data).open(),auth=new Auth(data);t.after(async()=>{auth.close();await engine.close();});const app=createAPI(engine,auth,()=>[]),headers={Authorization:'Bearer '+auth.token,'Content-Type':'application/json'};
 assert.equal((await app.request('/api/state')).status,401);const response=await app.request('/api/projects',{method:'POST',headers,body:JSON.stringify({name:'Fixture',path:root})});assert.equal(response.status,201);const created=await response.json();assert.ok(created.createdAt&&created.updatedAt);
 const before=await engine.snapshot();let identity:unknown;for(const path of ['/api/state','/api/overview']){const state=await(await app.request(path,{headers})).json();assert.equal(state.projects[0].repositoryIdentity.canonicalKey,'github.com/owner/repo');assert.ok(!JSON.stringify(state).includes('fixture-secret'));if(identity)assert.deepEqual(identity,state.projects[0].repositoryIdentity);identity=state.projects[0].repositoryIdentity;}
 assert.deepEqual(await engine.snapshot(),before);assert.equal(before.projects[0].repositoryIdentity,undefined);
});
