import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { AdditionalSourceControlTransports } from '../src/source-control-provider-transports.js';
import { gitCafeRepositoryIdentity } from '../src/source-control-provider-identity.js';
import { GitCafeSourceControl, gitCafeDiffCursor } from '../src/source-control-gitcafe.js';
const head='a'.repeat(40),base='b'.repeat(40),secondHead='c'.repeat(40),at='2026-10-20T00:00:00.000Z';
const local=(handle:string)=>({kind:'local',actorId:'actor_'+handle,handle,displayName:handle,avatarUrl:null});
async function fixture(t:{after(run:()=>Promise<unknown>):void}){
  const files=[{path:'file.ts',oldPath:'old.ts',status:'renamed' as const,additions:1,deletions:1,oldOid:'1'.repeat(40),newOid:'2'.repeat(40)},
    {path:'large.txt',status:'modified' as const,additions:100,deletions:0,tooLarge:true}];
  const root={id:'thread_1',threadId:'thread_1',version:3,author:local('reviewer'),body:'Root',createdAt:at,path:'file.ts',line:2,side:'right',commitOid:head,resolvedAt:null,capabilities:{edit:true,resolve:true,unresolve:true}};
  const state={version:7,head,base,mergeRoute:'native',mergePermitted:true,sourceRepo:{owner:'contrib',name:'repo'},comments:[root,{...root,id:'reply_2',version:4,body:'Reply',createdAt:'2026-10-20T00:01:00.000Z',commitOid:secondHead}],
    reactions:[{subject:{kind:'pull_request',id:'pr_17'},emoji:{kind:'unicode',value:'❤️'},count:2,viewerReactionId:'reaction_1',reactors:[local('reviewer'),local('other')]}],
    calls:[] as {path:string;method:string;body:any;after:string|null}[],writes:[] as {path:string;method:string;body:any}[],cli:[] as {args:string[];body?:string;mode?:number}[],
    mismatch:false,pages:false,admissionPolls:0,pendingAdmission:false,stackMismatch:false};
  const pull=(n=17)=>({id:'pr_'+n,number:n,title:'Fixture '+n,state:'open',draft:false,sourceBranch:n===17?'feature':'feature-two',targetBranch:'main',headOid:n===17?state.head:secondHead,author:local('author'),createdAt:at,updatedAt:at,version:state.version,description:'Description',closedAt:null,mergedAt:null,sourceRepo:state.sourceRepo,observedBaseOid:base,mergeRoute:state.mergeRoute,lockedAt:null,capabilities:{comment:true,review:true,merge:true,edit:true,moderate:false},reviewers:[{actor:local('reviewer')}],labels:[]});
  const page=(items:any[],next:string|null=null)=>Response.json({items,next});
  const transport=new AdditionalSourceControlTransports({environment:{CAFE_TOKEN:'synthetic-cafe'},command:name=>name==='cafe'?'/synthetic/cafe':null,
    execute:async(_cwd,_command,args,options)=>{assert.equal(options?.env?.CAFE_TOKEN,'synthetic-cafe');assert(!args.includes('synthetic-cafe'));const entry:{args:string[];body?:string;mode?:number}={args};const at=args.indexOf('--body-file');if(at>=0){entry.body=await readFile(args[at+1],'utf8');entry.mode=(await stat(args[at+1])).mode&0o777;}state.cli.push(entry);return {stdout:JSON.stringify({schemaVersion:1,data:{resource:{repoId:'admission_1',state:state.pendingAdmission?'pending':'complete',owner:'team',name:'repo'}}}),stderr:'',code:0,digest:''};},
    request:async(input,init={})=>{
      const url=new URL(String(input));assert.equal(url.origin,'https://git.cafe');assert.equal(new Headers(init.headers).get('Authorization'),'Bearer synthetic-cafe');const path=url.pathname.replace(/^\/api\//,''),method=init.method??'GET',body=init.body?JSON.parse(String(init.body)):undefined;state.calls.push({path,method,body,after:url.searchParams.get('after')});
      if(path.endsWith('/diff-files'))return Response.json({version:state.version+(state.mismatch?1:0),headOid:state.head,comparisonBaseOid:state.base,items:body.paths.map((path:string)=>({...files.find(file=>file.path===path),hunks:[{oldStart:1,oldLines:1,newStart:1,newLines:1,lines:[{origin:'-',content:'old\n'},{origin:'+',content:'new'},{origin:'>',content:''}]}]}))});
      if(method!=='GET'){state.writes.push({path,method,body});if(path.endsWith('/merge'))return Response.json({id:'merge_1',state:'accepted'});if(path.includes('/pulls/stacks/'))return Response.json({id:'stack_op_1',state:'running'});if(method==='PATCH'&&/pulls\/17$/.test(path))return Response.json({version:state.version+1});return Response.json({id:'written_1'});}
      if(path==='repos/team/repo')return Response.json({name:'repo',defaultBranch:'main'});const pr=/^repos\/team\/repo\/pulls\/(17|18)$/.exec(path);if(pr)return Response.json(pull(Number(pr[1])));
      if(path==='repos/team/repo/pulls')return page([pull()]);
      if(path.endsWith('/status'))return Response.json({merge:{conflicts:'unknown',fastForward:false,strategies:['merge','squash','rebase'],permitted:state.mergePermitted,blockers:[{blockedStrategies:['squash']}]},checks:{pending:0,failing:0,total:1}});
      if(path.endsWith('/checks'))return page([{name:'build',status:'completed',conclusion:'success',summary:null,detailsUrl:'https://git.cafe/checks/1'}]);
      if(path.endsWith('/changes')){const second=url.searchParams.has('after');return Response.json({version:state.version,headOid:state.head,comparisonBaseOid:state.base,items:state.pages?[files[second?1:0]]:files,next:state.pages&&!second?'https://foreign.test/opaque?x=1&y=2':null});}
      if(path.endsWith('/comments/thread_1/detail'))return Response.json({id:'thread_1',version:8});
      if(path.endsWith('/comments'))return page(state.comments);if(path.endsWith('/reviews'))return page([{id:'review_1',author:local('reviewer'),body:'Fix',verdict:'request_changes',dismissedAt:null,createdAt:at}]);
      if(path.endsWith('/commits'))return page([{oid:state.head,summary:'Commit',time:1792454400}]);if(path.endsWith('/reactions/'))return page(state.reactions);
      if(path==='repos/team/repo/commit')return Response.json({oid:base});
      if(path.endsWith('/stack'))return Response.json({stack:{id:'stack_1',number:4,revision:3,landingBase:'main',members:[{pullRequestNumber:17,title:'First',state:'open',draft:false,sourceBranch:'feature',position:1},{pullRequestNumber:18,title:'Second',state:'open',draft:false,sourceBranch:'feature-two',position:2,headOid:state.stackMismatch?'d'.repeat(40):undefined}]}});
      if(path==='orgs/team/admissions/admission_1'){state.admissionPolls++;return Response.json({repoId:'admission_1',state:state.admissionPolls>1?'complete':'pending',owner:'team',name:'repo'});}
      throw new Error('Unexpected synthetic API path: '+path);
    }});t.after(()=>transport.close());
  return {state,provider:new GitCafeSourceControl(await transport.gitcafe('/synthetic',gitCafeRepositoryIdentity('git@git.cafe:team/repo.git')!))};
}
test('GitCafe details apply explicit permissions, merge blockers and checked line statistics',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17);assert.equal(detail.pullRequest.provider,'gitcafe');assert.equal(detail.providerVersion,7);assert.equal(detail.baseComparison,'behind');assert.equal(detail.behindBy,undefined);assert.deepEqual(detail.mergeMethods,['merge','rebase']);assert.equal(detail.additions,101);assert.equal(detail.changedFiles,2);assert.equal(detail.updateMethods?.length,0);assert.equal(detail.stackRebase,true);assert.equal(detail.management?.canRequestReviewers,false);
  state.mergePermitted=false;assert(!(await provider.detail(17)).actions.includes('merge'));assert.equal(await provider.defaultBranch(),'main');assert.equal(await provider.find('feature','main'),null);assert.equal((await provider.find('feature','main','contrib/repo'))?.number,17);
});
test('GitCafe Diff uses opaque data cursors, exact version/head/base fences and bounded detail batches',async t=>{
  const {provider,state}=await fixture(t);state.pages=true;const first=await provider.diff(17,{head});assert(first.nextCursor);assert.equal(first.files[0].oldPath,'old.ts');assert(first.patch.includes('\\ No newline at end of file'));const cursor=gitCafeDiffCursor(first.nextCursor)!;assert.equal(cursor.version,7);
  const second=await provider.diff(17,{head,cursor:first.nextCursor,base});assert.equal(second.nextCursor,null);assert.equal(second.files[0].omissionReason,'too_large');assert.equal(second.truncated,true);assert.equal(state.calls.find(row=>row.path.endsWith('/changes')&&row.after!==null)?.after,'https://foreign.test/opaque?x=1&y=2');
  state.mismatch=true;await assert.rejects(provider.diff(17,{head}),/版本已改变/);state.mismatch=false;state.version++;await assert.rejects(provider.diff(17,{head,cursor:first.nextCursor}),/版本已改变/);await assert.rejects(provider.diff(17,{head,commit:head}),/暂不支持提交 Diff/);
  for(const raw of ['1','{}',JSON.stringify({...cursor,version:-1}),JSON.stringify({...cursor,headOid:'bad'})])assert.throws(()=>gitCafeDiffCursor(raw));
});
test('GitCafe review and merge plans freeze revision guards and reject stale or unsupported writes before sending',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17),signal=new AbortController().signal;
  await assert.rejects(provider.effects(detail,{action:'review',verdict:'approve',comments:[{path:'file.ts',body:'inline',position:{kind:'added',newLine:1}}]}),/不支持行批注/);assert.equal(state.writes.length,0);
  const review=await provider.effects(detail,{action:'review',verdict:'request-changes',body:'Fix'});await review[0].run(signal);assert.equal(state.writes[0].body.expectedVersion,7);assert.equal(state.writes[0].body.commitOid,head);assert.equal(state.writes[0].body.verdict,'request_changes');assert.match(state.writes[0].body.requestId,/^[a-f\d-]{36}$/);
  const merge=await provider.effects(detail,{action:'merge',mergeMethod:'merge'});await merge[0].run(signal);assert.deepEqual({...state.writes[1].body,requestId:'nonce'},{requestId:'nonce',expectedVersion:7,headOid:head,baseOid:base,strategy:'merge'});
  state.version++;await assert.rejects(provider.effects(detail,{action:'close'}),/版本已改变/);assert.equal(state.writes.length,2);
});
test('GitCafe activity preserves opaque threads, per-comment permissions and GitHub/local actors',async t=>{
  const {provider}=await fixture(t),activity=await provider.activity(17);assert.equal(activity.threads[0].id,'thread_1');assert.equal(activity.threads[0].commentCount,2);assert.equal(activity.threads[0].isOutdated,true);assert.equal(activity.threads[0].canResolve,true);assert.equal(activity.reactions[0].content,'heart');assert.equal(activity.reactions[0].viewerHasReacted,true);assert(activity.items.some(item=>item.id==='review_1'&&item.state==='CHANGES_REQUESTED'));assert.equal(activity.commits[0].oid,head);
});
test('GitCafe edits, replies, resolution and reactions bind opaque IDs and each resource version',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17),signal=new AbortController().signal;
  await assert.rejects(provider.collaborationEffects(detail,{action:'edit_comment',commentKind:'review-comment',commentId:'other_pr',body:'wrong'}),/不属于此 PR/);
  const edit=await provider.collaborationEffects(detail,{action:'edit_comment',commentKind:'review-comment',commentId:'thread_1',body:'Edited'});await edit[0].run(signal);assert.equal(state.writes[0].body.expectedVersion,8);
  const resolve=await provider.collaborationEffects(detail,{action:'resolve',threadId:'thread_1',resolved:true});await resolve[0].run(signal);assert.equal(state.writes[1].body.expectedVersion,3);assert.equal(state.writes[1].path,'repos/team/repo/pulls/17/comments/thread_1/resolve');
  const reply=await provider.collaborationEffects(detail,{action:'reply',threadId:'thread_1',body:'Reply'});await reply[0].run(signal);assert.equal(state.writes[2].path,'repos/team/repo/pulls/17/comments/thread_1/replies');
  assert.deepEqual(await provider.reactionEffects(17,{action:'reaction',content:'heart',reacted:true}),[]);const remove=await provider.reactionEffects(17,{action:'reaction',content:'heart',reacted:false});await remove[0].run(signal);assert.equal(state.writes[3].path,'repos/team/repo/pulls/17/reactions/reaction_1');
  await assert.rejects(provider.collaborationEffects(detail,{action:'reviewers',reviewers:[{id:'x',kind:'user'}],requested:true}),/不支持/);
});
test('GitCafe Stack actions bind the stack revision and every affected open layer head',async t=>{
  const {provider,state}=await fixture(t);state.stackMismatch=true;const stack=await provider.stack(17);assert.equal(stack?.revision,3);assert.equal(stack?.layers[1].headSha,secondHead);
  await assert.rejects(provider.stackEffects(17,{action:'merge',stackNumber:4,expectedStackHeads:[{number:17,headSha:'d'.repeat(40)}]}),/提交已改变/);assert.equal(state.writes.length,0);
  const effects=await provider.stackEffects(17,{action:'merge',stackNumber:4,expectedStackHeads:[{number:17,headSha:head}],mergeMethod:'squash'});await effects[0].run(new AbortController().signal);assert.equal(state.writes[0].path,'repos/team/repo/pulls/stacks/4/land-through');assert.equal(state.writes[0].body.expectedRevision,3);assert.equal(state.writes[0].body.throughPullRequestNumber,17);
  await assert.rejects(provider.stackEffects(17,{action:'update-branch',stackNumber:4,expectedStackHeads:[{number:17,headSha:head}]}),/提交已改变/);
});
test('GitCafe creation uses a private body file, removes it, and waits for repository admission without repeating create',async t=>{
  const {provider,state}=await fixture(t),body='literal $HOME\n`not a command`';const pr=await provider.create({branch:'feature',base:'main',title:'Fixture',body,sourceRepository:'contrib/repo'});assert.equal(pr.number,17);assert.equal(state.cli[0].body,body);assert.equal(state.cli[0].mode,0o600);const index=state.cli[0].args.indexOf('--body-file');await assert.rejects(stat(state.cli[0].args[index+1]));assert(state.cli[0].args.includes('contrib/repo:feature'));
  state.pendingAdmission=true;const repo=await provider.createRepository('private');assert.equal(repo.sshURL,'ssh@git.cafe:team/repo.git');assert.equal(state.admissionPolls,2);assert.equal(state.cli.filter(call=>call.args.includes('create')&&call.args.includes('repo')).length,1);
});
