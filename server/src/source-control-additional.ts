import { ForgejoSourceControl } from './source-control-forgejo.js';
import { GitCafeSourceControl } from './source-control-gitcafe.js';
import { AzureDevOpsSourceControl } from './source-control-azure-devops.js';
import { additionalRepositoryPath, type AdditionalRepositoryIdentity } from './source-control-provider-identity.js';
import type { AdditionalHTTPConnection, AdditionalSourceControlTransports } from './source-control-provider-transports.js';
import type { AdditionalChangeRequestDetail, AdditionalChangeRequestInput } from './source-control-provider-models.js';
import type { ChangeRequestDetail } from './task-change-request-data.js';
import type { ChangeRequestDiffSlice } from './task-change-request-diff.js';
import type { CollaborationInput } from './task-change-request-collaboration.js';
import type { ReviewStateInput } from './task-change-request-review-state.js';

const oid = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{40,64}$/i.test(v);
const unsupported = (): never => { throw new Error('当前平台不支持这项 PR 操作'); };

/** The existing Durable task lane owns writes; this bridge only dispatches the
 * pinned platform protocol. Legacy HTTP fallbacks never see these providers. */
export class AdditionalSourceControl {
  readonly identity: Readonly<AdditionalRepositoryIdentity>;
  readonly #adapter: ForgejoSourceControl | GitCafeSourceControl | AzureDevOpsSourceControl;
  readonly #cwd: string;
  readonly #transport: AdditionalSourceControlTransports;
  readonly #connection?: AdditionalHTTPConnection;
  constructor(cwd: string, identity: AdditionalRepositoryIdentity, transport: AdditionalSourceControlTransports, connection?: AdditionalHTTPConnection) {
    this.#cwd = cwd; this.#transport = transport; this.#connection = connection;
    this.identity = Object.freeze(structuredClone(identity));
    this.#adapter = identity.provider === 'azure-devops' ? new AzureDevOpsSourceControl(cwd, identity, transport)
      : identity.provider === 'forgejo' && connection ? new ForgejoSourceControl(connection)
      : identity.provider === 'gitcafe' && connection ? new GitCafeSourceControl(connection) : unsupported();
  }
  summary(number: number, signal?: AbortSignal) { return this.#adapter.summary(number, signal); }
  summaryReading(number: number, signal?: AbortSignal) { return this.#adapter.summaryReading(number, signal); }
  checkout(number: number, signal?: AbortSignal) { return this.#adapter.checkout(number, signal); }
  find(branch: string, base?: string, source?: AdditionalRepositoryIdentity, signal?: AbortSignal, includeTerminal = false) {
    this.source(source); return this.#adapter.find(branch, base, source?.repository, signal, includeTerminal);
  }
  create(input: { branch: string; base: string; title: string; body: string }, source?: AdditionalRepositoryIdentity, signal?: AbortSignal) {
    this.source(source); return this.#adapter.create({ ...input, ...(source ? { sourceRepository: source.repository } : {}) }, signal);
  }
  private source(source?: AdditionalRepositoryIdentity) {
    if (source && (source.provider !== this.identity.provider || source.apiBase !== this.identity.apiBase)) throw new Error('PR 源和目标不属于同一平台服务');
  }
  defaultBranch(signal?: AbortSignal) { return this.#adapter.defaultBranch(signal); }
  async account(signal?: AbortSignal): Promise<string> {
    if (this.identity.provider === 'azure-devops') return (await this.#transport.azureAccount(this.#cwd, signal)).account;
    const value = this.identity.provider === 'forgejo' ? await this.#connection!.json('user', { signal }) : (await this.#connection!.command?.(['auth', 'status', '--json'], { signal }))?.data;
    const account = value?.login ?? value?.username;
    if (typeof account !== 'string' || !account || account.length > 256 || /[\x00-\x1f\x7f]/.test(account)) throw new Error('无法确认当前平台登录账号');
    return account;
  }
  createRepository(visibility: 'private' | 'public', signal?: AbortSignal) { return this.#adapter instanceof AzureDevOpsSourceControl ? this.#adapter.createRepository(signal) : this.#adapter.createRepository(visibility, signal); }
  async cloneRepositoryInfo(signal?:AbortSignal):Promise<import('./project-clone.js').CloneRepositoryInfo> {
    if(this.#adapter instanceof GitCafeSourceControl){
      await this.#adapter.defaultBranch(signal);
      return {provider:'gitcafe',nameWithOwner:this.identity.repository,url:this.identity.webURL,httpsURL:this.identity.webURL+'.git',sshURL:`ssh@${this.identity.host}:${this.identity.repository}.git`};
    }
    const raw=await this.#adapter.repository(signal);
    if(this.#adapter instanceof AzureDevOpsSourceControl){
      const {azureRepositoryIdentity}=await import('./source-control-provider-identity.js');
      const httpsURL=String(raw.remoteUrl??''),sshURL=String(raw.sshUrl??'');
      if(azureRepositoryIdentity(httpsURL)?.canonicalKey!==this.identity.canonicalKey||azureRepositoryIdentity(sshURL)?.canonicalKey!==this.identity.canonicalKey)throw new Error('Azure 返回的克隆地址与仓库不一致');
      return {provider:'azure-devops',nameWithOwner:this.identity.repository,url:this.identity.webURL,httpsURL:this.identity.webURL,sshURL};
    }
    const url=this.identity.webURL,httpsURL=String(raw.clone_url??''),sshURL=String(raw.ssh_url??''),web=new URL(String(raw.html_url??'')),http=new URL(httpsURL);
    const match=sshURL.match(/^[^@\s]+@([^:\s]+):(.+)$/),ssh=match?undefined:new URL(sshURL),sshHost=match?.[1]??ssh?.hostname,sshPath=match?.[2]??ssh?.pathname.replace(/^\//,'');
    const allowed=[this.identity.host.split(':')[0],this.identity.sshHost].filter(Boolean);
    if(web.href.replace(/\/$/,'')!==url||http.href!==url+'.git'||web.username||web.password||http.username||http.password||!sshHost||!allowed.includes(sshHost)||sshPath?.replace(/\.git$/,'')!==this.identity.repository||ssh&&(ssh.protocol!=='ssh:'||ssh.password||ssh.search||ssh.hash))throw new Error('Forgejo 返回的克隆地址与仓库不一致');
    return {provider:'forgejo',nameWithOwner:this.identity.repository,url,httpsURL,sshURL};
  }
  detail(number: number, signal?: AbortSignal) { return this.#adapter.detail(number, signal); }
  async activity(number: number, signal?: AbortSignal) {
    const activity = await this.#adapter.activity(number, signal), nested = new Set(activity.threads.flatMap(thread => thread.comments.map(comment => comment.id)));
    return { ...activity, items: activity.items.filter(item => !nested.has(item.sourceID ?? item.id)).map(item => ({ ...item, ...(item.kind === 'review' && Object.hasOwn(activity.bySubject, item.id) ? { sourceID: item.id } : {}), reactions: activity.bySubject[item.sourceID ?? item.id] ?? [] })) };
  }
  private scoped(detail: ChangeRequestDetail): AdditionalChangeRequestDetail {
    const pr = detail.pullRequest;
    if (pr.provider !== this.identity.provider || pr.host !== this.identity.host || pr.repository !== this.identity.path) throw new Error('PR 操作归属已改变');
    return detail as AdditionalChangeRequestDetail;
  }
  async effects(detail: ChangeRequestDetail, input: AdditionalChangeRequestInput, signal?: AbortSignal) {
    const d = this.scoped(detail);
    return this.#adapter instanceof GitCafeSourceControl ? this.#adapter.effects(d, input, signal) : this.#adapter.effects(d, input);
  }
  collaborationEffects(detail: ChangeRequestDetail, input: CollaborationInput, signal?: AbortSignal) { return this.#adapter.collaborationEffects(this.scoped(detail), input, signal); }
  reactionEffects(number: number, input: ReviewStateInput, signal?: AbortSignal) {
    if (this.#adapter instanceof AzureDevOpsSourceControl) return unsupported();
    return this.#adapter.reactionEffects(number, input, signal);
  }
  async diff(number: number, input: { head: unknown; base?: unknown; cursor?: unknown; commit?: unknown }, signal?: AbortSignal): Promise<ChangeRequestDiffSlice> {
    if (!oid(input.head) || input.base !== undefined && !oid(input.base) || input.commit !== undefined && !oid(input.commit)) throw new Error('Diff 版本或提交范围无效');
    if (this.#adapter instanceof ForgejoSourceControl) {
      if (input.cursor !== undefined && input.cursor !== null) throw new Error('Forgejo Diff 不支持分页游标');
      const result = await this.#adapter.diff(number, input.head, input.commit as string | undefined, signal);
      if (input.base !== undefined && input.base !== result.baseSha) throw new Error('PR 的 Diff 基准已改变，请刷新');
      return { ...result, headSha: input.commit as string | undefined ?? input.head, requestHeadSha: input.head, scopeCommit: input.commit as string | undefined ?? null, cursor: null, nextCursor: null, omittedFileStats: [] };
    }
    const result = await this.#adapter.diff(number, { ...input, head: input.head, base: input.base as string | undefined }, signal);
    return { ...result, requestHeadSha: input.head, scopeCommit: null, cursor: typeof input.cursor === 'string' ? input.cursor : null,
      files: result.files.map(file => ({ ...file, ...('fileCursor' in result && typeof result.fileCursor === 'string' ? { diffCursor: result.fileCursor } : typeof input.cursor === 'string' ? { diffCursor: input.cursor } : {}) })), omittedFileStats: 'omittedFileStats' in result && Array.isArray(result.omittedFileStats) ? result.omittedFileStats : [] };
  }
  async files(number: number, head: string, signal?: AbortSignal) {
    const result = await this.diff(number, { head }, signal);
    return { ...result, truncated: result.truncated || result.nextCursor !== null };
  }
  fileContents(number: number, input: { path: unknown; head: unknown; side: unknown; commit?: unknown; cursor?: unknown; base?: unknown; slice?: unknown }, signal?: AbortSignal) {
    if (this.#adapter instanceof GitCafeSourceControl) return unsupported();
    const path = additionalRepositoryPath(input.path);
    if (!oid(input.head) || input.side !== 'old' && input.side !== 'new' || input.base !== undefined && !oid(input.base) || input.commit !== undefined && !oid(input.commit) || input.slice !== undefined && input.slice !== true) throw new Error('文件版本或审查范围无效');
    if (this.#adapter instanceof ForgejoSourceControl && input.cursor !== undefined && input.cursor !== null) throw new Error('Forgejo Diff 不支持分页游标');
    return this.#adapter.fileContents(number, { ...input, path, head: input.head, side: input.side, base: input.base as string | undefined, commit: input.commit as string | undefined }, signal);
  }
  async fileRevisions(number: number, paths: string[], signal?: AbortSignal) {
    if (!paths.length || this.#adapter instanceof GitCafeSourceControl) return new Map<string, string>();
    const detail = await this.detail(number, signal);
    return this.#adapter.fileRevisions(number, paths, detail.headSha, signal);
  }
  reviewers(number: number, signal?: AbortSignal) { return this.#adapter instanceof ForgejoSourceControl ? this.#adapter.reviewers(number, signal) : Promise.resolve({ candidates: [], truncated: false }); }
  labels(number: number, signal?: AbortSignal) { return this.#adapter instanceof ForgejoSourceControl ? this.#adapter.labels(number, signal) : Promise.resolve({ candidates: [], truncated: false }); }
  stack(number: number, signal?: AbortSignal) { return this.#adapter instanceof GitCafeSourceControl ? this.#adapter.stack(number, signal) : Promise.resolve(null); }
  stackEffects(number: number, input: { action: 'merge' | 'update-branch'; stackNumber: number; expectedStackHeads: { number: number; headSha: string }[]; mergeMethod?: string }, signal?: AbortSignal) {
    return this.#adapter instanceof GitCafeSourceControl ? this.#adapter.stackEffects(number, input, signal) : unsupported();
  }
}
