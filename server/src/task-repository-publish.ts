import { sourceControlHost } from './source-control-credentials.js';
import { SourceControlConnections, type PinnedSourceControlConnection } from './source-control-connections.js';
import { isAdditionalSourceControlProvider, sourceControlProviderDefinitions, sourceControlProviders } from './source-control-provider.js';

export type PublishProvider = import('./source-control-provider.js').SourceControlProvider;
export type RepositoryPublishInput = {
  provider: PublishProvider; host?: string; repository: string; visibility: 'private' | 'public';
  remoteName: string; protocol: 'ssh' | 'https'; account: string;
  credentialFingerprint?: string;
  baseURL?: string;
};
export type RepositoryPublication = {
  provider: PublishProvider; nameWithOwner: string; url: string; sshURL: string; httpsURL: string;
  remoteName: string; remoteURL: string; status: 'created' | 'remote_added' | 'pushed';
};
export type PublishProviderStatus = {
  provider: PublishProvider; label: string; host: string; command: string;
  status: 'ready' | 'configured' | 'missing' | 'unauthenticated'; account?: string; hint?: string; credentialFingerprint?: string;
  credentialSource?: 'settings' | 'environment' | 'gh' | 'cli'; baseURL?: string;
};
const hosts = Object.fromEntries(Object.entries(sourceControlProviderDefinitions).map(([key, value]) => [key, value.host])) as Record<PublishProvider, string>;
const segment = (value: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value) && value !== '.' && value !== '..' && !value.endsWith('.git');

export function repositoryPublishInput(raw: unknown): RepositoryPublishInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('仓库发布设置无效');
  const value = raw as Record<string, unknown>;
  if (!(sourceControlProviders as readonly unknown[]).includes(value.provider)) throw new Error('请选择支持的仓库平台');
  const provider = value.provider as PublishProvider;
  const host = value.host === undefined ? undefined : sourceControlHost(value.host);
  if (host && provider !== 'gitlab' && provider !== 'forgejo' && !(provider === 'gitcafe' && host === 'staging.git.cafe') && host !== hosts[provider]) throw new Error('发布主机与所选平台不一致');
  if (typeof value.repository !== 'string' || value.repository.length > 500) throw new Error('仓库名称无效');
  const repository = value.repository.trim(); const parts = repository.split('/');
  if (provider === 'azure-devops') {
    if (parts.length !== 3 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(parts[0]) || parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f\x7f\\]/.test(part))) throw new Error('请填写组织／项目／仓库名称');
  } else if (parts.length < 2 || provider !== 'gitlab' && parts.length !== 2 || !parts.every(segment)) throw new Error('请填写完整的所有者／仓库名称');
  let baseURL: string | undefined;
  if (provider === 'forgejo') {
    try { if (typeof value.baseURL !== 'string') throw new Error(); const url = new URL(value.baseURL); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || host && url.host !== host) throw new Error(); baseURL = url.href.replace(/\/+$/, ''); } catch { throw new Error('请选择已登录的 Forgejo 服务地址'); }
  } else if (value.baseURL !== undefined) throw new Error('此平台不接受自定义服务路径');
  if (value.visibility !== 'private' && value.visibility !== 'public') throw new Error('仓库可见性无效');
  const remoteName = typeof value.remoteName === 'string' ? value.remoteName.trim() || 'origin' : 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(remoteName) || remoteName === 'HEAD' || remoteName.endsWith('.') || remoteName.includes('..')) throw new Error('远端名称无效');
  if (value.protocol !== 'ssh' && value.protocol !== 'https') throw new Error('仓库传输协议无效');
  if (typeof value.account !== 'string' || value.account.length > 256 || !value.account || /[\u0000-\u001f\u007f]/.test(value.account) || (provider === 'github' || provider === 'gitlab') && !segment(value.account)) throw new Error('请刷新仓库平台的登录状态');
  if (value.credentialFingerprint !== undefined && (typeof value.credentialFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.credentialFingerprint))) throw new Error('仓库平台凭据版本无效');
  if ((provider === 'bitbucket' || isAdditionalSourceControlProvider(provider)) && !value.credentialFingerprint) throw new Error('请刷新平台凭据后重新确认');
  return { provider, ...(host ? { host } : {}), ...(baseURL ? { baseURL } : {}), repository, visibility: value.visibility, remoteName, protocol: value.protocol, account: value.account,
    ...(value.credentialFingerprint ? { credentialFingerprint: value.credentialFingerprint as string } : {}) };
}

export async function discoverPublishProviders(cwd: string, _signal?: AbortSignal, connections = new SourceControlConnections()): Promise<PublishProviderStatus[]> {
  const [providers, labHosts] = await Promise.all([connections.discover(cwd), connections.gitlabHosts(cwd)]);
  return [...providers, ...await Promise.all(labHosts.filter(host => host !== 'gitlab.com').map(host => connections.probe(cwd, 'gitlab', host)))];
}

async function validatePinnedAccount(pinned: PinnedSourceControlConnection, input: RepositoryPublishInput, signal?: AbortSignal) {
  if (input.credentialFingerprint && input.credentialFingerprint !== pinned.fingerprint) throw new Error('仓库平台凭据已经改变，请刷新后重新确认');
  if (pinned.additional) { if ((await pinned.additional.account(signal)).toLowerCase() !== input.account.toLowerCase()) throw new Error('仓库平台的登录账号已经改变，请刷新后重新确认'); return; }
  if (input.provider === 'bitbucket') {
    if (!input.credentialFingerprint || !pinned.fingerprint) throw new Error('请刷新 Bitbucket 凭据后重新确认');
    return; // A workspace token can publish without access to /user.
  }
  let user: Record<string, unknown>;
  try { user = await pinned.json('user', { signal }); }
  catch { throw new Error('无法确认仓库平台的登录状态，请刷新后重试'); }
  const account = input.provider === 'github' ? user.login : user.username;
  if (typeof account !== 'string' || account.toLowerCase() !== input.account.toLowerCase()) throw new Error('仓库平台的登录账号已经改变，请刷新后重新确认');
}

export async function validatePublishAccount(cwd: string, input: RepositoryPublishInput, signal?: AbortSignal, connections = new SourceControlConnections()) {
  try { await validatePinnedAccount(await publicationConnection(cwd, input, connections, signal), input, signal); }
  catch (error) { if (error instanceof Error && /已经改变|重新确认/.test(error.message)) throw error; throw new Error('无法确认仓库平台的登录状态，请刷新后重试'); }
}

export async function createPublishedRepository(cwd: string, input: RepositoryPublishInput, signal?: AbortSignal, connections = new SourceControlConnections()): Promise<RepositoryPublication> {
  const pinned = await publicationConnection(cwd, input, connections, signal);
  await validatePinnedAccount(pinned, input, signal);
  if (pinned.additional) {
    const created = await pinned.additional.createRepository(input.visibility, signal);
    const remoteURL = input.protocol === 'ssh' ? created.sshURL : created.httpsURL;
    return { provider: input.provider, nameWithOwner: input.repository, url: created.url, sshURL: created.sshURL, httpsURL: created.httpsURL, remoteName: input.remoteName, remoteURL, status: 'created' };
  }
  const parts = input.repository.split('/'); const name = parts.at(-1)!; const owner = parts.slice(0, -1).join('/');
  let value: Record<string, unknown>;
  try {
    if (input.provider === 'github') {
      const endpoint = owner.toLowerCase() === input.account.toLowerCase() ? 'user/repos' : `orgs/${encodeURIComponent(owner)}/repos`;
      value = await pinned.json(endpoint, { method: 'POST', signal, body: { name, private: input.visibility === 'private', auto_init: false } });
    } else if (input.provider === 'gitlab') {
      const namespace = await pinned.json(`namespaces/${encodeURIComponent(owner)}`, { signal });
      if (!Number.isSafeInteger(namespace.id) || Number(namespace.id) < 1) throw new Error('Invalid namespace');
      value = await pinned.json('projects', { method: 'POST', signal, body: { path: name, name, visibility: input.visibility, namespace_id: namespace.id } });
    } else value = await pinned.json(`repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { method: 'POST', signal, body: { scm: 'git', is_private: input.visibility === 'private' } });
  } catch {
    throw new Error('仓库创建结果尚未确认。请在平台上核对名称、权限及是否已创建，再决定下一步；同一请求不会重复创建。');
  }
  const host = input.host ?? hosts[input.provider];
  const actual = input.provider === 'gitlab' ? value.path_with_namespace : value.full_name;
  const url = `https://${host}/${input.repository}`;
  let sshURL = `git@${new URL('https://' + host).hostname}:${input.repository}.git`; const httpsURL = url + '.git';
  const links = value.links && typeof value.links === 'object' && !Array.isArray(value.links) ? value.links as Record<string, unknown> : undefined;
  const html = links?.html && typeof links.html === 'object' ? links.html as Record<string, unknown> : undefined;
  const clone = (name: string) => Array.isArray(links?.clone) ? links.clone.find(entry => entry && typeof entry === 'object' && entry.name === name)?.href as unknown : undefined;
  const responseURL = input.provider === 'github' ? value.html_url : input.provider === 'gitlab' ? value.web_url : html?.href;
  const responseSSH = input.provider === 'github' ? value.ssh_url : input.provider === 'gitlab' ? value.ssh_url_to_repo : clone('ssh');
  if (input.provider === 'gitlab' && typeof responseSSH === 'string' && responseSSH.startsWith('ssh://')) {
    try { const ssh = new URL(responseSSH); if (ssh.hostname !== new URL(url).hostname || ssh.username !== 'git' || ssh.password || ssh.search || ssh.hash || ssh.pathname !== '/' + input.repository + '.git') throw new Error(); sshURL = responseSSH; } catch {}
  }
  let responseHTTPS = input.provider === 'github' ? value.clone_url : input.provider === 'gitlab' ? value.http_url_to_repo : clone('https');
  if (input.provider === 'bitbucket' && typeof responseHTTPS === 'string') { try { const clone = new URL(responseHTTPS); if (clone.password || clone.search || clone.hash) throw new Error(); clone.username = ''; responseHTTPS = clone.toString(); } catch { responseHTTPS = undefined; } }
  const visibilityMatches = input.provider === 'github' ? value.private === (input.visibility === 'private') : input.provider === 'gitlab' ? value.visibility === input.visibility : value.is_private === (input.visibility === 'private');
  if (typeof actual !== 'string' || actual.toLowerCase() !== input.repository.toLowerCase() || typeof responseURL !== 'string' || responseURL.toLowerCase() !== url.toLowerCase() || typeof responseSSH !== 'string' || responseSSH.toLowerCase() !== sshURL.toLowerCase() || typeof responseHTTPS !== 'string' || responseHTTPS.toLowerCase() !== httpsURL.toLowerCase() || !visibilityMatches) {
    throw new Error('平台返回的仓库地址或可见性与确认内容不一致。请在平台核对；不会添加远端或重复创建。');
  }
  return { provider: input.provider, nameWithOwner: input.repository, url, sshURL, httpsURL,
    remoteName: input.remoteName, remoteURL: input.protocol === 'ssh' ? sshURL : httpsURL, status: 'created' };
}

async function publicationConnection(cwd: string, input: RepositoryPublishInput, connections: SourceControlConnections, signal?: AbortSignal) {
  if (!isAdditionalSourceControlProvider(input.provider)) return connections.pin(cwd, input.provider, input.host, signal);
  const parts = input.repository.split('/').map(encodeURIComponent);
  const address = input.provider === 'azure-devops' ? `https://dev.azure.com/${parts[0]}/${parts[1]}/_git/${parts[2]}` : `${input.provider === 'forgejo' ? input.baseURL : 'https://' + (input.host ?? 'git.cafe')}/${parts.join('/')}`;
  const repository = await connections.repository(cwd, address, signal);
  if (!repository || repository.provider !== input.provider || input.host && repository.host !== input.host) throw new Error('发布平台身份与已登录服务不一致，请重新扫描');
  return connections.pinRepository(cwd, repository, signal);
}
