import { matchForgejoLogin, parseForgejoRemote, type ForgejoLogin } from './vendor/t3-forgejo-logins.js';
import { parseGitCafeRemote } from './vendor/t3-gitcafe-hosts.js';

export type AdditionalSourceControlKind = 'forgejo' | 'gitcafe' | 'azure-devops';
export type AdditionalRepositoryIdentity = {
  provider: AdditionalSourceControlKind; host: string; repository: string; path: string;
  webURL: string; canonicalKey: string; apiBase: string;
  login?: string; account?: string; sshHost?: string; organization?: string; project?: string; name: string;
};
const safeText = (value: string) => !!value && value.length <= 2048 && !/[\x00-\x1f\x7f\\]/.test(value);
function segments(path: string): string[] | undefined {
  try {
    const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/').map(decodeURIComponent);
    return parts.every(part => safeText(part) && part !== '.' && part !== '..' && !part.includes('/')) ? parts : undefined;
  } catch { return; }
}
const encoded = (parts: string[]) => parts.map(encodeURIComponent).join('/');
/** Remote Git paths are data, including tabs/newlines and literal backslashes.
 * They are encoded per URL segment and never used as a host filesystem path. */
export function additionalRepositoryPath(raw: unknown): string {
  if(typeof raw!=='string'||!raw||raw.length>4096||raw.includes('\0')||raw.startsWith('/')||raw.split('/').some(part=>!part||part==='.'||part==='..')||Buffer.from(raw).toString('utf8')!==raw)throw new Error('远端仓库文件路径无效');
  return raw;
}
function remoteURL(remote: string): URL | undefined {
  if (!safeText(remote) || remote.length > 8192) return;
  try {
    const url = new URL(remote);
    if (!['https:','http:','ssh:'].includes(url.protocol) || url.search || url.hash) return;
    return url;
  } catch { return; }
}

/** A server mount and SSH aliases come from the signed-in Forgejo account,
 * rather than from an arbitrary /pulls/ link in a message. */
export function forgejoRepositoryIdentity(remote: string, logins: ForgejoLogin[], requestedHost?: string): AdditionalRepositoryIdentity | undefined {
  if (!safeText(remote) || remote.length > 8192) return;
  const parsed = parseForgejoRemote(remote); if (!parsed) return;
  const login = matchForgejoLogin(logins, parsed, requestedHost); if (!login) return;
  const base = remoteURL(login.url); if (!base || !['https:','http:'].includes(base.protocol) || base.username || base.password) return;
  const mount = base.pathname === '/' ? [] : segments(base.pathname); if (!mount) return;
  let parts = segments(parsed.path); if (!parts) return;
  if (!parsed.ssh || parts.length > 2) {
    if (parts.length !== mount.length + 2 || mount.some((part,index) => part !== parts![index])) return;
    parts = parts.slice(mount.length);
  }
  if (parts.length !== 2) return;
  const repository = parts.join('/'), path = encoded([...mount,...parts]);
  return { provider:'forgejo', host:base.host.toLowerCase(), repository, path,
    webURL:base.origin+'/'+path, canonicalKey:(base.host+'/'+path).toLowerCase(),
    apiBase:base.origin+'/'+(mount.length ? encoded(mount)+'/' : '')+'api/v1/',
    login:login.name, ...(login.user ? {account:login.user} : {}), ...(login.ssh_host ? {sshHost:login.ssh_host} : {}), name:parts[1] };
}

export function gitCafeRepositoryIdentity(remote: string): AdditionalRepositoryIdentity | undefined {
  const parsed = parseGitCafeRemote(remote); if (!parsed) return;
  const parts = segments(parsed.repository); if (!parts || parts.length !== 2) return;
  const path = encoded(parts);
  return { provider:'gitcafe',host:parsed.host,repository:parsed.repository,path,webURL:`https://${parsed.host}/${path}`,
    canonicalKey:(parsed.host+'/'+path).toLowerCase(),apiBase:`https://${parsed.host}/api/`,name:parts[1] };
}

/** Azure HTTPS, legacy collection URLs and the v3 SSH spelling name one
 * organization/project/repository. CLI arguments retain decoded names. */
export function azureRepositoryIdentity(remote: string): AdditionalRepositoryIdentity | undefined {
  if (!safeText(remote) || remote.length > 8192) return;
  let host: string, path: string, ssh: boolean;
  const url = remoteURL(remote);
  if (url) {
    host=url.hostname.toLowerCase();path=url.pathname;ssh=url.protocol==='ssh:';
    if (!ssh && url.protocol!=='https:') return;
  } else {
    const match=/^(?:[^\s@/]+@)?(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):(.+)$/i.exec(remote);
    if (!match) return;host=match[1].toLowerCase();path=match[2];ssh=true;
  }
  const parts=segments(path);if(!parts)return;
  let organization: string, project: string, name: string;
  if(ssh){
    if(!['ssh.dev.azure.com','vs-ssh.visualstudio.com'].includes(host)||parts.length!==4||parts[0]!=='v3')return;
    [,organization,project,name]=parts;
  } else if(host==='dev.azure.com'){
    if(parts.length!==4||parts[2]!=='_git')return;
    [organization,project,,name]=parts;
  } else {
    const legacy=/^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);if(!legacy)return;
    organization=legacy[1];if(parts[0]?.toLowerCase()==='defaultcollection')parts.shift();
    if(parts.length!==3||parts[1]!=='_git')return;
    [project,,name]=parts;
  }
  const repository=project+'/'+name, canonicalPath=encoded([organization,project])+'/_git/'+encodeURIComponent(name);
  return {provider:'azure-devops',host:'dev.azure.com',repository,path:canonicalPath,webURL:'https://dev.azure.com/'+canonicalPath,
    canonicalKey:('dev.azure.com/'+canonicalPath).toLowerCase(),apiBase:'https://dev.azure.com/'+encoded([organization,project])+'/_apis/git/',
    organization:'https://dev.azure.com/'+encodeURIComponent(organization),project,name};
}

export function additionalChangeRequestURL(identity: AdditionalRepositoryIdentity, number: number): string {
  if(!Number.isSafeInteger(number)||number<1)throw new Error('PR 编号无效');
  return identity.webURL+(identity.provider==='azure-devops'?'/pullrequest/':'/pulls/')+number;
}

/** Command-looking references are parsed as data. They never select another
 * host, organization or repository, and are never passed to a shell. */
export function additionalChangeRequestNumber(identity: AdditionalRepositoryIdentity, raw: unknown): number {
  if(typeof raw!=='string'||!safeText(raw)||raw.length>4096)throw new Error('PR 引用无效');
  const text=raw.trim();let number:string|undefined;
  if(/^#?[1-9]\d*$/.test(text))number=text.replace(/^#/,'');
  else if(/^https?:\/\//i.test(text)){
    let url:URL;try{url=new URL(text);}catch{throw new Error('PR 地址无效');}
    const base=new URL(identity.webURL),marker=identity.provider==='azure-devops'?'/pullrequest/':'/pulls/';
    const prefix=base.pathname.replace(/\/$/,'')+marker;
    if(url.origin!==base.origin||url.username||url.password||!url.pathname.toLowerCase().startsWith(prefix.toLowerCase()))throw new Error('PR 地址与所选仓库不一致');
    const tail=url.pathname.slice(prefix.length);if(!/^[1-9]\d*\/?$/.test(tail))throw new Error('PR 地址无效');number=tail.replace(/\/$/,'');
  } else if(identity.provider==='forgejo')number=/^tea\s+(?:pr|pulls)\s+checkout\s+#?([1-9]\d*)$/i.exec(text)?.[1];
  else if(identity.provider==='azure-devops')number=/^az\s+repos\s+pr\s+checkout\s+(?:(?:--id(?:=|\s+)|-i\s+))?([1-9]\d*)$/i.exec(text)?.[1];
  const value=Number(number);if(!Number.isSafeInteger(value)||value<1)throw new Error('PR 引用无效');return value;
}
