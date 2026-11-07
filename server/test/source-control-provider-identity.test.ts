import test from 'node:test';
import assert from 'node:assert/strict';
import { additionalChangeRequestNumber, additionalChangeRequestURL, azureRepositoryIdentity, forgejoRepositoryIdentity, gitCafeRepositoryIdentity } from '../src/source-control-provider-identity.js';
import { matchForgejoLogin, parseForgejoRemote, type ForgejoLogin } from '../src/vendor/t3-forgejo-logins.js';

const login=(name:string,url:string,extra:Partial<ForgejoLogin>={}):ForgejoLogin=>({name,url,user:'fixture',default:'false',...extra});
test('Forgejo uses the matching signed-in mount, port and SSH alias without accepting unrelated hosts',()=>{
  const logins=[login('main','https://forge.test:3443/git',{ssh_host:'ssh.forge.test'}),login('other','https://elsewhere.test')];
  const https=forgejoRepositoryIdentity('https://forge.test:3443/git/team/r%C3%A9po.git',logins)!;
  assert.equal(https.repository,'team/répo');assert.equal(https.path,'git/team/r%C3%A9po');assert.equal(https.apiBase,'https://forge.test:3443/git/api/v1/');
  const ssh=forgejoRepositoryIdentity('git@ssh.forge.test:team/répo.git',logins)!;assert.equal(ssh.canonicalKey,https.canonicalKey);assert.equal(ssh.login,'main');
  assert.equal(forgejoRepositoryIdentity('https://forge.test:3443/other/team/repo.git',logins),undefined);
  assert.equal(forgejoRepositoryIdentity('https://unknown.test/team/repo.git',logins),undefined);
  assert.equal(forgejoRepositoryIdentity('git@forge.test:team/repo.git',logins,'elsewhere.test'),undefined);
  assert.equal(forgejoRepositoryIdentity('https://forge.test:3443/git/team/%2Fsecret.git',logins),undefined);
});
test('Forgejo ambiguity follows T3 account defaults; overlapping mounts do not silently choose an account',()=>{
  const remote=parseForgejoRemote('git@forge.test:team/repo.git')!;
  const entries=[login('one','https://forge.test'),login('two','https://forge.test')];
  assert.equal(matchForgejoLogin(entries,remote),undefined);entries[1].default='true';assert.equal(matchForgejoLogin(entries,remote)?.name,'two');
  entries.push(login('nested','https://forge.test/git',{default:'true'}));assert.equal(matchForgejoLogin(entries,remote),undefined);
});
test('GitCafe owns production and staging only, with a canonical API authority independent of clone spelling',()=>{
  for(const remote of ['https://git.cafe/team/repo.git','ssh://git@git.cafe:2222/team/repo.git','git@git.cafe:team/repo.git']){
    const value=gitCafeRepositoryIdentity(remote)!;assert.equal(value.apiBase,'https://git.cafe/api/');assert.equal(value.webURL,'https://git.cafe/team/repo');
  }
  assert.equal(gitCafeRepositoryIdentity('https://staging.git.cafe/team/repo')!.host,'staging.git.cafe');
  for(const remote of ['https://git.cafe.foreign.test/team/repo','https://git.cafe/a/b/c','https://unknown.test/a/b'])assert.equal(gitCafeRepositoryIdentity(remote),undefined);
});
test('Azure organization and project survive all supported HTTPS, legacy and SSH clone spellings',()=>{
  const remotes=['https://dev.azure.com/Org/My%20Project/_git/Repo.git','https://Org.visualstudio.com/DefaultCollection/My%20Project/_git/Repo','git@ssh.dev.azure.com:v3/Org/My Project/Repo','ssh://git@vs-ssh.visualstudio.com/v3/Org/My%20Project/Repo'];
  const values=remotes.map(remote=>azureRepositoryIdentity(remote)!);assert(values.every(Boolean));assert(values.every(value=>value.canonicalKey===values[0].canonicalKey));
  assert(values.every(value=>value.project==='My Project'&&value.repository==='My Project/Repo'&&value.name==='Repo'));
  assert.equal(values[0].organization,'https://dev.azure.com/Org');assert.equal(values[0].apiBase,'https://dev.azure.com/Org/My%20Project/_apis/git/');
  for(const remote of ['https://dev.azure.com.foreign.test/Org/P/_git/R','https://dev.azure.com/Org/P/_git/../R','git@ssh.dev.azure.com:v3/Org/P/R/extra','https://dev.azure.com/Org/P/_git/%2Fsecret'])assert.equal(azureRepositoryIdentity(remote),undefined);
});
test('PR numbers and URL/CLI references remain bound to the selected provider and repository',()=>{
  const forge=forgejoRepositoryIdentity('https://forge.test/git/team/repo',[login('main','https://forge.test/git')])!,cafe=gitCafeRepositoryIdentity('git@git.cafe:team/repo.git')!,azure=azureRepositoryIdentity('git@ssh.dev.azure.com:v3/org/project/repo')!;
  for(const identity of [forge,cafe,azure]){
    const url=additionalChangeRequestURL(identity,17);assert.equal(additionalChangeRequestNumber(identity,url+'?view=files#discussion'),17);assert.equal(additionalChangeRequestNumber(identity,'#17'),17);assert.equal(additionalChangeRequestNumber(identity,url.replace('/team/repo/','/TEAM/REPO/').replace('/org/project/','/ORG/PROJECT/')),17);
    for(const raw of [url.replace('repo/','other/'),url.replace(identity.host,'foreign.test'),'17; touch /tmp/no','$(echo 17)','#0','9007199254740992'])assert.throws(()=>additionalChangeRequestNumber(identity,raw));
  }
  assert.equal(additionalChangeRequestNumber(forge,'tea pulls checkout 17'),17);assert.equal(additionalChangeRequestNumber(azure,'az repos pr checkout --id=17'),17);
  assert.throws(()=>additionalChangeRequestNumber(cafe,'cafe pr checkout 17'));
  assert.throws(()=>additionalChangeRequestNumber(azure,'az repos pr checkout --id 17 --organization https://foreign.test'));
});
