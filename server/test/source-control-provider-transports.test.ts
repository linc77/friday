import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdditionalSourceControlTransports, gitCafeEnvironmentToken } from '../src/source-control-provider-transports.js';
import { forgejoRepositoryIdentity, gitCafeRepositoryIdentity, azureRepositoryIdentity } from '../src/source-control-provider-identity.js';
import { SourceControlHTTPError, SourceControlResponseTooLarge } from '../src/source-control-connections.js';

const output=(stdout:string,stderr='HTTP/2.0 200',code=0)=>({stdout,stderr,code,digest:''});
test('GitCafe environment tokens stay on their configured host and settings override only production',async t=>{
  const token='synthetic-production',setting='synthetic-settings',staging='synthetic-staging';
  assert.equal(gitCafeEnvironmentToken('staging.git.cafe',{CAFE_TOKEN:token}),undefined);
  assert.equal(gitCafeEnvironmentToken('git.cafe',{CAFE_TOKEN:token}),token);
  assert.equal(gitCafeEnvironmentToken('staging.git.cafe',{CAFE_TOKEN:staging,CAFE_HOST:'https://staging.git.cafe/api'}),staging);
  assert.equal(gitCafeEnvironmentToken('foreign.test',{CAFE_TOKEN:token,CAFE_HOST:'foreign.test'}),undefined);
  const cliCalls:{args:string[];input:unknown;env:unknown}[]=[],requests:{url:string;authorization:string|null}[]=[];
  const transport=new AdditionalSourceControlTransports({environment:{CAFE_TOKEN:token},gitCafeToken:async()=>setting,command:name=>name==='cafe'?'/synthetic/cafe':null,
    execute:async(_cwd,_command,args,options)=>{cliCalls.push({args,input:options?.input,env:options?.env});return output('username=fixture\npassword='+staging+'\n');},
    request:async(url,init)=>{requests.push({url:String(url),authorization:new Headers(init?.headers).get('Authorization')});return Response.json({ok:true});}});t.after(()=>transport.close());
  const production=await transport.gitcafe('/synthetic',gitCafeRepositoryIdentity('git@git.cafe:a/b')!),preview=await transport.gitcafe('/synthetic',gitCafeRepositoryIdentity('git@staging.git.cafe:a/b')!);
  await production.json('repos/a/b');await preview.json('repos/a/b');assert.deepEqual(requests.map(r=>r.authorization),['Bearer '+setting,'Bearer '+staging]);
  assert.equal(production.source,'settings');assert.equal(preview.source,'cli');assert.notEqual(production.fingerprint,preview.fingerprint);
  assert.equal(cliCalls.length,1);assert.equal(cliCalls[0].input,'protocol=https\nhost=staging.git.cafe\n\n');assert.deepEqual(cliCalls[0].env,{CAFE_NO_UPDATE_CHECK:'1',CAFE_TOKEN:'',CAFE_HOST:'https://staging.git.cafe/api'});
  assert(!JSON.stringify(cliCalls).includes(staging));assert(!JSON.stringify(production).includes(setting));
});

test('GitCafe invalidates an unauthorized CLI token without replaying a write',async t=>{
  let credentials=0,requests=0;const transport=new AdditionalSourceControlTransports({environment:{},command:()=>'/synthetic/cafe',
    execute:async()=>output('password=synthetic-'+(++credentials)+'\n'),request:async()=>{requests++;return requests===1?new Response('private diagnostics',{status:401}):Response.json({ok:true});}});t.after(()=>transport.close());
  const identity=gitCafeRepositoryIdentity('git@git.cafe:a/b')!,first=await transport.gitcafe('/synthetic',identity);
  await assert.rejects(first.json('repos/a/b/pulls',{method:'POST',body:{title:'fixture'}}),error=>error instanceof SourceControlHTTPError&&error.status===401&&!error.message.includes('private diagnostics'));
  assert.equal(requests,1);const second=await transport.gitcafe('/synthetic',identity);assert.equal(credentials,2);assert.notEqual(first.fingerprint,second.fingerprint);await second.json('repos/a/b');assert.equal(requests,2);
});

test('fj account selection preserves aliases, refreshes OAuth once and reads the renewed credential privately',async t=>{
  let token='synthetic-old',refreshes=0;const headers:string[]=[],cli:{command:string;args:string[]}[]=[];
  const transport=new AdditionalSourceControlTransports({environment:{},command:name=>name==='fj'?'/synthetic/fj':null,
    readFjKeys:async()=>({hosts:{'forge.test:3443':{type:'OAuth',token}},aliases:{'ssh.forge.test':'forge.test:3443'}}),
    execute:async(_cwd,command,args)=>{cli.push({command,args});refreshes++;token='synthetic-renewed';return output('fixture');},
    request:async(_url,init)=>{headers.push(new Headers(init?.headers).get('Authorization')!);return Response.json({login:'fixture',id:1});}});t.after(()=>transport.close());
  const accounts=await transport.forgejoAccounts('/synthetic','git@ssh.forge.test:a/b.git'),identity=forgejoRepositoryIdentity('git@ssh.forge.test:a/b.git',accounts)!;
  const [first,second]=await Promise.all([transport.forgejo('/synthetic',identity),transport.forgejo('/synthetic',identity)]);assert.equal(refreshes,1);assert.equal(first.fingerprint,second.fingerprint);
  await first.json('user');assert.deepEqual(headers,['token synthetic-renewed']);assert.deepEqual(cli[0].args,['--host','https://forge.test:3443','whoami']);assert(!JSON.stringify(cli).includes(token));assert(!JSON.stringify(first).includes(token));
  token='synthetic-changed';const third=await transport.forgejo('/synthetic',identity);assert.equal(refreshes,2);assert.equal(third.fingerprint,first.fingerprint,'fj renews to the selected account before returning a pinned session');
});

test('fj macOS storage follows both supported layouts and rejects a corrupt primary instead of choosing another login',async t=>{
  const home=await mkdtemp(join(tmpdir(),'friday-forgejo-keys-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const folder=join(home,'Library','Application Support','Cyborus.forgejo-cli');await mkdir(folder,{recursive:true});const file=join(folder,'keys.json');await writeFile(file,JSON.stringify({hosts:{'forge.test':{type:'Application',token:'synthetic-storage'}}}),{mode:0o600});
  const transport=new AdditionalSourceControlTransports({home,platform:'darwin',environment:{},command:name=>name==='fj'?'/synthetic/fj':null});t.after(()=>transport.close());
  assert.equal((await transport.forgejoAccounts('/synthetic'))[0].url,'https://forge.test');assert((await readFile(file,'utf8')).includes('synthetic-storage'));
  const primary=join(home,'Library','Application Support','forgejo-cli.forgejo-cli');await mkdir(primary,{recursive:true});await writeFile(join(primary,'keys.json'),'{invalid');await assert.rejects(transport.forgejoAccounts('/synthetic'),/登录存储无效/);
});

test('tea keeps mounted API routes and JSON stdin; HTTP status wins even when the process exits zero',async t=>{
  const calls:{args:string[];input:unknown}[]=[],login={name:'mounted',url:'https://forge.test/git',user:'fixture',default:'true'};
  const transport=new AdditionalSourceControlTransports({environment:{},command:name=>name==='tea'?'/synthetic/tea':null,
    execute:async(_cwd,_command,args,options)=>{calls.push({args,input:options?.input});if(args[0]==='login')return output(JSON.stringify([login]));if(args.at(-1)?.endsWith('/user'))return output('{"login":"fixture","id":2}');return output('{}','HTTP/2.0 404');},request:async()=>assert.fail('tea owns its credential transport')});t.after(()=>transport.close());
  const identity=forgejoRepositoryIdentity('https://forge.test/git/team/repo',[login])!,connection=await transport.forgejo('/synthetic',identity),body={body:'literal $HOME\n`command`'};
  await assert.rejects(connection.json('repos/team/repo/issues/17',{method:'PATCH',body}),error=>error instanceof SourceControlHTTPError&&error.status===404);
  const call=calls.at(-1)!;assert(call.args.includes('https://forge.test/git/api/v1/repos/team/repo/issues/17'));assert(call.args.includes('team/repo'));assert(!call.args.includes(body.body));assert.equal(call.input,JSON.stringify(body));
  await assert.rejects(connection.json('https://foreign.test/token'));assert.equal(calls.length,3);
});

test('Provider HTTP refuses redirects, oversized bodies, invalid UTF-8 and foreign paths without disclosing upstream diagnostics',async t=>{
  let mode='redirect',calls=0;const transport=new AdditionalSourceControlTransports({environment:{CAFE_TOKEN:'synthetic-http'},command:()=>null,
    request:async(_url,init)=>{calls++;assert.equal(init?.redirect,'manual');if(mode==='redirect')return new Response('secret body',{status:302,headers:{Location:'https://foreign.test/stolen'}});if(mode==='large')return new Response(Buffer.alloc(9*1024*1024));if(mode==='utf8')return new Response(new Uint8Array([0xff]));return new Response(new Uint8Array([0xff]));}});t.after(()=>transport.close());
  const connection=await transport.gitcafe('/synthetic',gitCafeRepositoryIdentity('https://git.cafe/a/b')!);
  await assert.rejects(connection.json('repos/a/b'),error=>error instanceof SourceControlHTTPError&&error.status===302&&!error.message.includes('secret body'));assert.equal(calls,1);
  mode='large';await assert.rejects(connection.text('repos/a/b/diff'),SourceControlResponseTooLarge);mode='utf8';await assert.rejects(connection.text('repos/a/b'),/UTF-8/);assert.deepEqual(Array.from(await connection.bytes('repos/a/b')),[0xff]);
  const count=calls;for(const path of ['https://foreign.test/','/outside','../outside','%2e%2e/outside','repos/a/b#fragment'])await assert.rejects(connection.json(path));assert.equal(calls,count);
});

test('Azure invoke is scoped to the selected organization and repository and uses the extension authentication path',async t=>{
  const calls:{args:string[]}[]=[],transport=new AdditionalSourceControlTransports({environment:{},command:name=>name==='az'?'/synthetic/az':null,execute:async(_cwd,_command,args)=>{calls.push({args});return output('{"value":[]}');}});t.after(()=>transport.close());
  const identity=azureRepositoryIdentity('git@ssh.dev.azure.com:v3/Org/My Project/Repo')!;
  assert.throws(()=>transport.azureInvoke('/synthetic',identity,'pullRequestIterations',{pullRequestId:17},{'--unsafe':10}),/路由无效/);assert.equal(calls.length,0);
  assert.deepEqual(await transport.azureInvoke('/synthetic',identity,'pullRequestIterations',{pullRequestId:17},{includeCommits:'true','$top':10}),{value:[]});
  const args=calls[0].args;assert.deepEqual(args.slice(0,2),['devops','invoke']);assert(args.includes('project=My Project'));assert(args.includes('repositoryId=Repo'));assert(args.includes('https://dev.azure.com/Org'));assert(!args.includes('--project'));assert(!args.includes('rest'));
  assert.throws(()=>transport.azureInvoke('/synthetic',identity,'pullRequests',{}, {},{method:'POST',body:{title:'fixture'}}),/明确的平台操作/);
  await transport.azureCommand('/synthetic',identity,['repos','pr','update','--id','17','--status','completed']);assert(calls[1].args.includes('--project'));
});

test('Pinned HTTP sessions retain their authority when callers mutate identity objects',async t=>{
  const addresses:string[]=[],transport=new AdditionalSourceControlTransports({environment:{CAFE_TOKEN:'synthetic-fixed'},request:async(url)=>{addresses.push(String(url));return Response.json({ok:true});}});t.after(()=>transport.close());
  const identity=gitCafeRepositoryIdentity('git@git.cafe:a/b')!,connection=await transport.gitcafe('/synthetic',identity);identity.apiBase='https://foreign.test/';connection.identity.apiBase='https://foreign.test/';
  await connection.json('repos/a/b');assert.deepEqual(addresses,['https://git.cafe/api/repos/a/b']);
});

test('Service close aborts a pending provider stream and waits for the request to settle',async()=>{
  let opened!:()=>void;const ready=new Promise<void>(resolve=>opened=resolve);let cancelled=false;
  const transport=new AdditionalSourceControlTransports({environment:{CAFE_TOKEN:'synthetic-close'},request:async(_url,init)=>new Response(new ReadableStream({start(controller){init?.signal?.addEventListener('abort',()=>{cancelled=true;controller.error(new Error('aborted'));},{once:true});opened();}}))});
  const connection=await transport.gitcafe('/synthetic',gitCafeRepositoryIdentity('git@git.cafe:a/b')!),pending=connection.text('repos/a/b');const assertion=assert.rejects(pending,/aborted/);await ready;await transport.close();await assertion;assert(cancelled);await assert.rejects(connection.text('repos/a/b'),/已关闭/);
});
