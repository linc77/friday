import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { AdditionalSourceControlTransports } from '../src/source-control-provider-transports.js';
import { AzureDevOpsSourceControl } from '../src/source-control-azure-devops.js';
import { azureRepositoryIdentity } from '../src/source-control-provider-identity.js';
import { SourceControlHTTPError } from '../src/source-control-http-errors.js';
const head='a'.repeat(40),base='b'.repeat(40),old='c'.repeat(40),next='d'.repeat(40);
const result=(value:unknown)=>({stdout:JSON.stringify(value),stderr:'',code:0,digest:''});
const parameter=(args:string[],key:string)=>args[args.lastIndexOf(key)+1];
async function fixture(t:{after(fn:()=>Promise<unknown>):void}){
  const identity=azureRepositoryIdentity('git@ssh.dev.azure.com:v3/Org/My Project/Repo')!;
  const repo={name:'Repo',project:{name:'My Project'},remoteUrl:'https://Org@dev.azure.com/Org/My%20Project/_git/Repo',webUrl:identity.webURL,sshUrl:'git@ssh.dev.azure.com:v3/Org/My%20Project/Repo',defaultBranch:'refs/heads/main'};
  const state={pr:{pullRequestId:17,title:'Fixture',description:'Body',sourceRefName:'refs/heads/feature',targetRefName:'refs/heads/main',status:'active',isDraft:false,createdBy:{uniqueName:'author@example.test',displayName:'Author'},creationDate:'2026-10-20T00:00:00Z',repository:repo,lastMergeSourceCommit:{commitId:old},mergeStatus:'succeeded',autoCompleteSetBy:null as any,completionOptions:{} as any},
    iterations:[{id:2,sourceRefCommit:{commitId:old},commonRefCommit:{commitId:base}},{id:3,sourceRefCommit:{commitId:head},commonRefCommit:{commitId:base}}],
    changes:[{changeType:'rename, edit',sourceServerItem:'/old.ts',item:{path:'/file.ts',objectId:'1'.repeat(40),originalObjectId:'2'.repeat(40)}}] as any[],binary:false,fileError:undefined as undefined|number,pushOnRead:false,pagedChanges:false,
    calls:[] as string[][],writes:[] as string[][],bodyFile:undefined as undefined|{path:string;content:string;mode:number},createdRepo:repo};
  const transport=new AdditionalSourceControlTransports({environment:{},command:name=>name==='az'?'/synthetic/az':null,execute:async(_cwd,_command,args)=>{
    state.calls.push(args);if(args[0]==='account')return result({name:'viewer@example.test',type:'user'});
    assert.equal(parameter(args,'--organization'),'https://dev.azure.com/Org');
    if(args[0]==='repos'){
      assert.equal(parameter(args,'--project'),'My Project');
      if(args[1]==='show')return result(repo);if(args[1]==='create'){state.writes.push(args);return result(state.createdRepo);}
      if(args[1]==='pr'&&args[2]==='show')return result(state.pr);if(args[1]==='pr'&&args[2]==='list')return result([state.pr]);
      state.writes.push(args);if(args[2]==='create'){const path=parameter(args,'--description').slice(1);state.bodyFile={path,content:await readFile(path,'utf8'),mode:(await stat(path)).mode&0o777};return result(state.pr);}return result(null);
    }
    assert(!args.includes('--project'));const resource=parameter(args,'--resource'),routeAt=args.indexOf('--route-parameters'),queryAt=args.indexOf('--query-parameters');
    const route=Object.fromEntries(args.slice(routeAt+1,queryAt>=0?queryAt:args.indexOf('--organization')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
    const query=Object.fromEntries(queryAt<0?[]:args.slice(queryAt+1,args.indexOf('--organization')).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)];}));
    assert.equal(route.project,'My Project');assert.equal(route.repositoryId,'Repo');
    if(resource==='pullRequestIterations')return result({value:state.iterations});
    if(resource==='pullRequestIterationChanges'){const skip=Number(query.$skip??0);return result(state.pagedChanges&&skip===0?{changeEntries:[{item:{isFolder:true,path:'/folder'}},{item:null}],nextSkip:2000}:{changeEntries:state.changes,nextSkip:0});}
    if(resource==='pullRequestThreads')return result({value:[{id:1,comments:[{id:1,content:'Read me',author:{uniqueName:'viewer@example.test'},publishedDate:'2026-10-20T00:00:00Z'},{id:2,content:'System',commentType:'system',publishedDate:'2026-10-20T00:00:00Z'},{id:3,content:'Deleted',isDeleted:true,publishedDate:'2026-10-20T00:00:00Z'}]},{id:2,isDeleted:true,comments:[{content:'Hidden'}]}]});
    if(resource==='items'){
      assert.equal(route.pullRequestId,undefined);assert.equal(query.$format,'json');assert.equal(query.includeContentMetadata,'true');if(state.fileError)return {stdout:'',stderr:'HTTP '+state.fileError,code:1,digest:''};
      if(state.pushOnRead)state.iterations[1]={...state.iterations[1],sourceRefCommit:{commitId:next}};return result({content:query['versionDescriptor.version']===base?'old\n':'new\n',contentMetadata:{isBinary:state.binary}});
    }
    throw new Error('Unexpected synthetic Azure CLI resource: '+resource);
  }});t.after(()=>transport.close());return {state,provider:new AzureDevOpsSourceControl('/synthetic',identity,transport),transport,identity};
}
test('Azure details use the latest iteration instead of lagging trial-merge metadata and expose only actual provider capabilities',async t=>{
  const {provider,state,transport}=await fixture(t),detail=await provider.detail(17);assert.equal(detail.headSha,head);assert.notEqual(detail.headSha,state.pr.lastMergeSourceCommit.commitId);assert.equal(detail.baseSha,base);assert.equal(detail.changedFiles,1);assert.equal(detail.canComment,false);assert.deepEqual(detail.verdicts,[]);assert.deepEqual(detail.mergeMethods,['merge','squash']);assert.equal(detail.management?.canReact,false);
  state.pr.autoCompleteSetBy={uniqueName:'viewer@example.test'};state.pr.completionOptions={squashMerge:true};assert.equal((await provider.detail(17)).autoMergeMethod,'squash');assert.equal((await transport.azureAccount('/synthetic')).account,'viewer@example.test');
});
test('Azure discussion reads exclude deleted, blank and system entries while keeping existing comments',async t=>{
  const {provider}=await fixture(t),activity=await provider.activity(17);assert.equal(activity.items.length,1);assert.equal(activity.items[0].id,'1:1');assert.equal(activity.items[0].body,'Read me');assert.equal(activity.truncated,false);assert.deepEqual(activity.threads,[]);
});
test('Azure iteration changes advance by the raw server offset even when the first page contains no file rows',async t=>{
  const {provider,state}=await fixture(t);state.pagedChanges=true;const diff=await provider.diff(17,{head});assert.equal(diff.files[0].path,'file.ts');assert.equal(diff.files[0].oldPath,'old.ts');assert(diff.patch.includes('-old'));assert(diff.patch.includes('+new'));assert(state.calls.some(args=>args.includes('$skip=2000')));
});
test('Azure slices retain the selected iteration across a new push and enforce the 300-file budget',async t=>{
  const {provider,state}=await fixture(t);state.binary=true;state.changes=Array.from({length:301},(_,index)=>({changeType:'add',item:{path:'/binary-'+index,objectId:'1'.repeat(40)}}));
  const first=await provider.diff(17,{head});assert.equal(first.files.length,300);assert.equal(first.nextCursor,'3:300');assert(first.truncated);
  state.iterations.push({id:4,sourceRefCommit:{commitId:next},commonRefCommit:{commitId:base}});const second=await provider.diff(17,{head,cursor:first.nextCursor});assert.equal(second.files.length,1);assert.equal(second.files[0].path,'binary-300');assert.equal(second.headSha,head);assert.equal(second.nextCursor,null);
  await assert.rejects(provider.diff(17,{head,cursor:'4:0'}),/版本已改变/);await assert.rejects(provider.diff(17,{head,cursor:'bad'}),/游标无效/);
});
test('Azure distinguishes unreadable files from authentication and quota failures',async t=>{
  const {provider,state}=await fixture(t);state.fileError=404;const missing=await provider.diff(17,{head});assert.equal(missing.files.length,1);assert(missing.truncated);assert(missing.files[0].noHunks);
  for(const status of [401,403,429]){state.fileError=status;await assert.rejects(provider.diff(17,{head}),error=>error instanceof SourceControlHTTPError&&error.status===status);}
});
test('Azure full files use merge-base/iteration revisions and reject a changed revision before returning contents',async t=>{
  const {provider,state}=await fixture(t);const oldFile=await provider.fileContents(17,{path:'file.ts',head,side:'old'});assert.equal(oldFile.text,'old\n');assert.equal(oldFile.revision,base);const newFile=await provider.fileContents(17,{path:'file.ts',head,side:'new'});assert.equal(newFile.text,'new\n');
  state.iterations.push({id:4,sourceRefCommit:{commitId:next},commonRefCommit:{commitId:base}});assert.equal((await provider.fileContents(17,{path:'file.ts',head,side:'new',cursor:'3:0'})).revision,head);state.iterations.pop();
  state.pushOnRead=true;await assert.rejects(provider.fileContents(17,{path:'file.ts',head,side:'new'}),/版本已改变/);
});
test('Azure actions use explicit completion options and argv-equals for a description beginning with a dash',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17),signal=new AbortController().signal;
  await provider.effects(detail,{action:'merge',mergeMethod:'squash'})[0].run(signal);assert(state.writes[0].includes('completed'));assert.equal(parameter(state.writes[0],'--squash'),'true');assert.throws(()=>provider.effects(detail,{action:'merge',mergeMethod:'rebase'}));assert.throws(()=>provider.effects(detail,{action:'review',verdict:'approve'}));
  const edit=await provider.collaborationEffects(detail,{action:'edit_request',body:'- bullet\n$HOME `text`'});await edit[0].run(signal);assert(state.writes[1].includes('--description=- bullet\n$HOME `text`'));
  const reviewers=await provider.collaborationEffects(detail,{action:'reviewers',reviewers:[{id:'one@example.test',kind:'user'},{id:'two@example.test',kind:'user'}],requested:true});await reviewers[0].run(signal);assert.equal(state.writes[2].filter(arg=>arg==='--reviewers').length,1);assert(state.writes[2].includes('two@example.test'));await assert.rejects(provider.collaborationEffects(detail,{action:'reply',threadId:'1',body:'no'}),/不支持/);
});
test('Azure PR creation uses a private body file and repository creation follows project permissions and canonical clone identities',async t=>{
  const {provider,state}=await fixture(t);assert.equal((await provider.create({branch:'feature',base:'main',title:'Fixture',body:'- private draft'})).number,17);assert.equal(state.bodyFile?.content,'- private draft');assert.equal(state.bodyFile?.mode,0o600);await assert.rejects(stat(state.bodyFile!.path));
  const repo=await provider.createRepository();assert.equal(repo.httpsURL,'https://dev.azure.com/Org/My%20Project/_git/Repo');assert(!repo.httpsURL.includes('Org@'));assert(!state.writes.at(-1)!.includes('--visibility'));
  state.pr.repository={...state.pr.repository,name:'Foreign',webUrl:'https://dev.azure.com/Org/My%20Project/_git/Foreign'};await assert.rejects(provider.summary(17),/不一致/);
});
test('Azure file readers share one concurrency limit and cancellation drains queued and running commands',async()=>{
  let active=0,peak=0,started=0;const identity=azureRepositoryIdentity('git@ssh.dev.azure.com:v3/org/project/repo')!;
  const transport=new AdditionalSourceControlTransports({environment:{},azureFileConcurrency:2,command:()=>'/synthetic/az',execute:async(_cwd,_command,_args,options)=>{
    started++;active++;peak=Math.max(peak,active);try{await new Promise<void>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return result({});}finally{active--;}
  }});
  const requests=Array.from({length:6},()=>transport.azureInvoke('/synthetic',identity,'items',{}, {path:'/file'}));const observed=Promise.allSettled(requests);const deadline=Date.now()+1000;while(started<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(peak,2);assert.equal(started,2);await transport.close();assert.equal(active,0);assert((await observed).every(value=>value.status==='rejected'));
});
