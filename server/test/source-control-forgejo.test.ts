import test from 'node:test';
import assert from 'node:assert/strict';
import { AdditionalSourceControlTransports } from '../src/source-control-provider-transports.js';
import { forgejoRepositoryIdentity } from '../src/source-control-provider-identity.js';
import { ForgejoSourceControl } from '../src/source-control-forgejo.js';
const head='a'.repeat(40),base='b'.repeat(40),target='c'.repeat(40);
const patch=`diff --git a/old.ts b/file.ts\nsimilarity index 60%\nrename from old.ts\nrename to file.ts\nindex ${'1'.repeat(40)}..${'2'.repeat(40)} 100644\n--- a/old.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n`;
const at='2026-10-20T00:00:00Z';
async function fixture(t:{after(run:()=>Promise<unknown>):void}){
  const state={pr:{number:17,title:'Fixture',body:'Description',html_url:'https://forge.test/team/repo/pulls/17',state:'open',merged:false,draft:false,mergeable:true,is_locked:false,
    head:{ref:'feature',sha:head,repo:{full_name:'contrib/repo'}},base:{ref:'main',sha:target,repo:{full_name:'team/repo'}},merge_base:base,user:{login:'author'},created_at:at,updated_at:at,closed_at:null,merged_at:null,labels:[{id:4,name:'bug'}],requested_reviewers:[{login:'reviewer'}]},
    repo:{full_name:'team/repo',default_branch:'main',permissions:{push:true,admin:false},archived:false,allow_merge_commits:true,allow_squash_merge:true,allow_rebase:false,allow_rebase_update:true},
    viewer:'reviewer',writes:[] as {path:string;method:string;body:any}[],calls:[] as string[],statusPages:undefined as undefined|any[][],
    override:undefined as undefined|((url:URL,init:RequestInit)=>Response|undefined)};
  const review={id:7,body:'Review',user:{login:'reviewer'},state:'APPROVED',submitted_at:at,html_url:'https://forge.test/team/repo/pulls/17#issuecomment-77',comments_count:1};
  const inline={id:9,body:'Inline',user:{login:'reviewer'},created_at:at,path:'old.ts',position:0,original_position:4,resolver:null};
  const rows=(value:any[],more=false)=>Response.json(value,{headers:{Link:'</synthetic>; rel="'+(more?'next':'prev')+'"'}});
  const transport=new AdditionalSourceControlTransports({environment:{},command:name=>name==='fj'?'/synthetic/fj':null,
    readFjKeys:async()=>({hosts:{'forge.test':{type:'Application',token:'synthetic-forgejo'}}}),execute:async()=>({stdout:'fixture',stderr:'',code:0,digest:''}),
    request:async(input,init={})=>{
      const url=new URL(String(input));assert.equal(url.origin,'https://forge.test');assert.equal(new Headers(init.headers).get('Authorization'),'token synthetic-forgejo');const path=url.pathname.replace(/^\/api\/v1\//,'');state.calls.push(path+url.search);
      const overridden=state.override?.(url,init);if(overridden)return overridden;
      const method=init.method??'GET';if(method!=='GET'){const body=init.body?JSON.parse(String(init.body)):undefined;state.writes.push({path:path+url.search,method,body});if(path==='repos/team/repo/pulls')return Response.json({...state.pr,number:18,html_url:'https://forge.test/team/repo/pulls/18'});return new Response(null,{status:204});}
      if(path==='user')return Response.json({login:state.viewer,id:2});if(path==='repos/team/repo')return Response.json(state.repo);if(path==='repos/team/repo/pulls/17')return Response.json(state.pr);
      if(path==='repos/team/repo/pulls')return rows([state.pr]);
      if(path.includes('/statuses/')){const page=Number(url.searchParams.get('page')??1),values=state.statusPages?.[page-1]??(page===1?[{context:'lint',status:'success',updated_at:at,target_url:'/checks/lint'}]:[]);return rows(values,!!state.statusPages&&page<state.statusPages.length);}
      if(path==='repos/team/repo/pulls/17/reviews')return rows([review]);if(path==='repos/team/repo/pulls/17/reviews/7')return Response.json(review);if(path==='repos/team/repo/pulls/17/reviews/7/comments')return rows([inline]);
      if(path==='repos/team/repo/issues/17/comments')return rows([{id:6,body:'Comment',user:{login:'reviewer'},created_at:at}]);
      if(path==='repos/team/repo/issues/17/reactions')return rows([{content:'eyes',user:{login:'reviewer'}}]);if(/issues\/comments\/\d+\/reactions$/.test(path))return rows([{content:'+1',user:{login:'reviewer'}},{content:'+1',user:{login:'other'}}]);
      if(path==='repos/team/repo/pulls/17/commits')return rows([{sha:head,author:{login:'author',full_name:'Author'},commit:{message:'First line\nMore',committer:{date:at}},parents:[{sha:base}],stats:{additions:1,deletions:1}}]);
      if(path==='repos/team/repo/assignees')return rows([{login:'author'},{login:'reviewer',full_name:'Reviewer'},{login:'candidate'}]);if(path==='repos/team/repo/labels')return rows([{id:4,name:'bug',color:'ff0000'},{id:5,name:'feature'}]);
      if(path==='repos/team/repo/pulls/17.diff'||path===`repos/team/repo/git/commits/${head}.diff`)return new Response(patch);
      if(path===`repos/team/repo/git/commits/${head}`)return Response.json({sha:head,parents:[{sha:base}]});
      if(path.includes('/contents/')){const name=path.split('/contents/')[1],content=name==='old.ts'?'old\n':'new\n';return Response.json({path:name,size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')});}
      throw new Error('Unexpected synthetic API path: '+path);
    }});t.after(()=>transport.close());
  const accounts=await transport.forgejoAccounts('/synthetic'),identity=forgejoRepositoryIdentity('https://forge.test/team/repo.git',accounts)!,connection=await transport.forgejo('/synthetic',identity);
  return {state,provider:new ForgejoSourceControl(connection)};
}

test('Forgejo repository creation verifies visibility and clone authority before returning a remote',async t=>{
  const f=await fixture(t);
  const created={full_name:'team/repo',private:true,html_url:'https://forge.test/team/repo',clone_url:'https://forge.test/team/repo.git',ssh_url:'git@forge.test:team/repo.git'};
  f.state.override=(url,init)=>url.pathname==='/api/v1/orgs/team/repos'&&init.method==='POST'?Response.json(created):undefined;
  assert.equal((await f.provider.createRepository('private')).sshURL,created.ssh_url);
  f.state.override=(url,init)=>url.pathname==='/api/v1/orgs/team/repos'&&init.method==='POST'?Response.json({...created,ssh_url:'git@foreign.test:team/repo.git'}):undefined;
  await assert.rejects(f.provider.createRepository('private'),/克隆地址/);
});
test('Forgejo details preserve account permissions, WIP drafts, checks and base comparison without inventing a behind count',async t=>{
  const {provider,state}=await fixture(t);let detail=await provider.detail(17);assert.equal(detail.pullRequest.provider,'forgejo');assert.equal(detail.headSha,head);assert.equal(detail.baseSha,base);assert.equal(detail.baseComparison,'behind');assert.equal(detail.behindBy,undefined);assert.deepEqual(detail.mergeMethods,['merge','squash']);assert.deepEqual(detail.verdicts,['comment','approve','request-changes']);assert.equal(detail.checks[0].url,'https://forge.test/checks/lint');
  state.pr.title='[WIP] Fixture';state.pr.draft=undefined as unknown as boolean;state.pr.user.login=state.viewer;detail=await provider.detail(17);assert(detail.isDraft);assert.deepEqual(detail.verdicts,['comment']);
  state.repo.archived=true;detail=await provider.detail(17);assert.deepEqual(detail.actions,[]);assert.deepEqual(detail.verdicts,[]);assert.equal(detail.canComment,false);
});
test('Forgejo capped server pages follow next metadata and deduplicate the newest status for each check',async t=>{
  const {provider,state}=await fixture(t);state.statusPages=[[{context:'lint',status:'failure',updated_at:'2026-10-20T02:00:00Z'}],[{context:'lint',status:'success',updated_at:at}],[{context:'build',status:'pending',updated_at:at}]];
  const detail=await provider.detail(17);assert.deepEqual(detail.checks.map(row=>[row.name,row.state]),[['lint','failure'],['build','pending']]);assert.equal(state.calls.filter(path=>path.includes('/statuses/')).length,3);
});
test('Forgejo PR lookup binds the fork and create uses the target repository with an owner-qualified head',async t=>{
  const {provider,state}=await fixture(t);assert.equal(await provider.find('feature','main'),null);assert.equal((await provider.find('feature','main','contrib/repo'))?.number,17);
  const created=await provider.create({branch:'feature',base:'main',title:'Fixture',body:'literal $HOME\n`command`',sourceRepository:'contrib/repo'});assert.equal(created.number,18);assert.equal(state.writes[0].body.head,'contrib:feature');assert.equal(state.writes[0].path,'repos/team/repo/pulls');
  state.pr.html_url='https://foreign.test/team/repo/pulls/17';await assert.rejects(provider.summary(17),/地址与仓库不一致/);
});
test('Forgejo action plans use its review events, line positions and update methods; unsupported actions stay unavailable',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17),signal=new AbortController().signal;
  const review=provider.effects(detail,{action:'review',verdict:'request-changes',body:'Please fix',comments:[{path:'file.ts',oldPath:'old.ts',body:'old side',position:{kind:'context',side:'left',oldLine:4,newLine:6}}]});assert.equal(state.writes.length,0);await review[0].run(signal);
  assert.deepEqual(state.writes[0].body,{event:'REQUEST_CHANGES',body:'Please fix',commit_id:head,comments:[{path:'old.ts',body:'old side',old_position:4,new_position:0}]});
  await provider.effects(detail,{action:'review',verdict:'approve'})[0].run(signal);assert.equal(state.writes[1].body.event,'APPROVED');await provider.effects(detail,{action:'update-branch',updateMethod:'rebase'})[0].run(signal);assert.equal(state.writes[2].path,'repos/team/repo/pulls/17/update?style=rebase');
  for(const action of ['draft','ready','enable-auto-merge'])assert.throws(()=>provider.effects(detail,{action}));assert.throws(()=>provider.effects(detail,{action:'review',verdict:'request-changes',body:''}));assert.throws(()=>provider.effects(detail,{action:'merge',mergeMethod:'rebase'}));
});
test('Forgejo discussion preserves review IDs, old-side inline threads, commits and reaction ownership',async t=>{
  const {provider}=await fixture(t),activity=await provider.activity(17);assert.deepEqual(activity.items.map(row=>row.id),['6','review:7','9']);assert.equal(activity.threads[0].path,'old.ts');assert.equal(activity.threads[0].side,'left');assert.equal(activity.threads[0].line,4);assert.equal(activity.threads[0].canResolve,false);assert.equal(activity.commits[0].messageHeadline,'First line');assert.equal(activity.commitsTruncated,false);assert.equal(activity.reactions[0].viewerHasReacted,true);assert.deepEqual(activity.bySubject['review:7'][0].actors,['other']);
});
test('Forgejo collaboration verifies comment membership, excludes authors and resolves label names to durable individual effects',async t=>{
  const {provider,state}=await fixture(t),detail=await provider.detail(17),signal=new AbortController().signal;
  const candidates=await provider.reviewers(17);assert(!candidates.candidates.some(person=>person.login==='author'));assert(candidates.candidates.find(person=>person.login==='reviewer')?.isRequested);
  await assert.rejects(provider.collaborationEffects(detail,{action:'edit_comment',commentKind:'issue-comment',commentId:'999',body:'foreign'}),/不属于当前账号/);assert.equal(state.writes.length,0);
  const edit=await provider.collaborationEffects(detail,{action:'edit_comment',commentKind:'issue-comment',commentId:'6',body:'Edited'});await edit[0].run(signal);assert.equal(state.writes[0].path,'repos/team/repo/issues/comments/6');
  const labels=await provider.labels(17);assert(labels.candidates[0].isApplied);const remove=await provider.collaborationEffects(detail,{action:'labels',labels:['bug','feature'],applied:false});assert.deepEqual(remove.map(effect=>effect.key),['label-4','label-5']);for(const effect of remove)await effect.run(signal);
  assert.deepEqual(state.writes.slice(1).map(row=>[row.path,row.method]),[['repos/team/repo/issues/17/labels/4','DELETE'],['repos/team/repo/issues/17/labels/5','DELETE']]);
  await assert.rejects(provider.collaborationEffects(detail,{action:'resolve',threadId:'9',resolved:true}),/不支持/);
});
test('Forgejo reactions map review IDs to issue-comment IDs and reject resources outside the PR',async t=>{
  const {provider,state}=await fixture(t);await assert.rejects(provider.reactionEffects(17,{action:'reaction',subjectId:'999',content:'eyes',reacted:true}),/不属于此 PR/);
  const effects=await provider.reactionEffects(17,{action:'reaction',subjectId:'review:7',content:'thumbs-up',reacted:true});await effects[0].run(new AbortController().signal);assert.deepEqual(state.writes[0],{path:'repos/team/repo/issues/comments/77/reactions',method:'POST',body:{content:'+1'}});
});
test('Forgejo full files bind renamed paths and fork revisions, and detect a changed head before returning data',async t=>{
  const {provider,state}=await fixture(t);let value=await provider.fileContents(17,{path:'file.ts',head,side:'old',base});assert.equal(value.text,'old\n');assert.equal(value.revision,base);assert(state.calls.some(path=>path.startsWith('repos/team/repo/contents/old.ts?ref='+base)));
  value=await provider.fileContents(17,{path:'file.ts',head,side:'new'});assert.equal(value.text,'new\n');assert(state.calls.some(path=>path.startsWith('repos/contrib/repo/contents/file.ts?ref='+head)));
  await assert.rejects(provider.fileContents(17,{path:'other.ts',head,side:'new'}),/不属于此 PR Diff/);await assert.rejects(provider.fileContents(17,{path:'file.ts',head,side:'new',base:target}),/基准已改变/);
  state.override=(url)=>{if(url.pathname.includes('/contents/')){state.pr.head.sha='d'.repeat(40);}return undefined;};await assert.rejects(provider.fileContents(17,{path:'file.ts',head,side:'new'}),/文件范围已改变/);
});
test('Forgejo commit diff validates membership and returned PR IDs; file revision marks follow parsed blob identities',async t=>{
  const {provider,state}=await fixture(t);assert.equal((await provider.diff(17,head,head)).files[0].path,'file.ts');await assert.rejects(provider.diff(17,head,'f'.repeat(40)),/不属于此 PR/);
  const revisions=await provider.fileRevisions(17,['file.ts','deleted.ts'],head);assert.equal(revisions.get('file.ts'),'2'.repeat(40));assert.equal(revisions.get('deleted.ts'),'');
  state.pr.number=18;state.pr.html_url='https://forge.test/team/repo/pulls/18';await assert.rejects(provider.summary(17),/信息无效/);
});
test('Forgejo complete text retains a BOM and content beyond the old text ceiling within the provider response limit',async t=>{
  const {provider,state}=await fixture(t),content='\uFEFF'+'x'.repeat(2*1024*1024);
  state.override=url=>url.pathname.includes('/contents/')?Response.json({path:'file.ts',size:Buffer.byteLength(content),encoding:'base64',content:Buffer.from(content).toString('base64')}):undefined;
  const result=await provider.fileContents(17,{path:'file.ts',head,side:'new'});assert.equal(result.kind,'text');assert.equal(result.text,content);assert.equal(result.byteLength,Buffer.byteLength(content));
});
