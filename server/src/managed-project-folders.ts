/* Adapted from T3 Code 8cd9641f project/ManagedProjectFolders and shared/path.
 * MIT, Copyright (c) 2026 T3 Tools Inc.; complete license: task-sidebar-order.ts.
 * Creation receipts use Pi Durable, as do direct file saves. An interrupted
 * external effect is inspected, never resumed by replaying Git or mkdir. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { Project } from './types.js';
import { WorkspaceDoc } from './state.js';
import { projectChanges } from './projects.js';
import { taskGit } from './git-process.js';

export type ManagedProjectFolder = { root: string; device: string; inode: string };
export type NamedProjectCreation = { status: 'created'; requestId: string; project: Project; commitError?: string }
  | { status: 'missing' | 'unconfirmed' | 'cancelled' | 'failed'; requestId: string; error?: string };
type Intent = { digest: string; projectId: string; name: string; folder?: string; identity?: ManagedProjectFolder; stage: 'claiming' | 'scaffolding' | 'registering'; commitError?: string; result?: NamedProjectCreation };
const Receipt = defineDocFamily<{ intent?: Intent; cancelled?: boolean }, { id: string }>({ kind: 'friday.named_project_creation', version: 1, scope: 'session', family: true, initial: () => ({}) });
const Folder = defineDocFamily<{folder?:ManagedProjectFolder},{id:string}>({kind:'friday.managed_project_folder',version:1,scope:'session',family:true,initial:()=>({})});
const key = (value: string) => createHash('sha256').update(value).digest('hex');
const validRequest = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const newProjectFolderName = (name: string) => {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '') || 'project';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? slug + '-project' : slug;
};
const backgrounds = ['#dc2626','#ea580c','#d97706','#16a34a','#059669','#0d9488','#0891b2','#0284c7','#2563eb','#4f46e5','#7c3aed','#9333ea','#c026d3','#db2777','#e11d48'];
export function namedProjectIconSvg(name: string) {
  const initials = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0,2).map(word=>Array.from(word)[0]??'').join('').toUpperCase() || Array.from(name.trim())[0] || '?';
  let hash = 0; for (const char of name) hash = (hash*31+(char.codePointAt(0)??0))>>>0;
  const escaped = initials.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect width="64" height="64" rx="14" fill="${backgrounds[hash%backgrounds.length]}"/>\n  <text x="32" y="32" dy="0.35em" text-anchor="middle" font-family="ui-sans-serif, system-ui, -apple-system, sans-serif" font-size="${initials.length>1?26:32}" font-weight="600" fill="#ffffff">${escaped}</text>\n</svg>\n`;
}
export async function verifyManagedProjectFolder(folder: ManagedProjectFolder, directory?: string) {
  if (directory && dirname(folder.root) !== join(await realpath(directory),'projects')) throw new Error('托管项目的目录范围已改变');
  const info = await lstat(folder.root,{bigint:true});
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(folder.root) !== folder.root || String(info.dev) !== folder.device || String(info.ino) !== folder.inode) throw new Error('托管项目目录已改变，请恢复原目录或重新添加 Workspace');
}
const commitFailure = (stderr: string) => /identity unknown|tell me who you are|no (name|email) was given/i.test(stderr)
  ? 'Git 尚未设置姓名或邮箱；设置 user.name 和 user.email 后即可提交。'
  : stderr.split('\n').map(line=>line.trim()).filter(Boolean).at(-1) || 'Git 未能完成首次提交。';

export class ManagedProjectFolders {
  private readonly requests = new Map<string, Promise<NamedProjectCreation>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly paths = new Map<string,number>();
  private stopping = false;
  private rootValue?: Promise<string>;
  constructor(private readonly engine: Engine, private readonly git: typeof taskGit = taskGit) {}
  root() { return this.rootValue ??= realpath(this.engine.directory).then(directory=>join(directory,'projects')); }
  isCreatingPath(path: string) { return this.paths.has(resolve(path)); }
  async knownFolder(path:string) {
    const saved=await this.engine.harness.snapshot(Folder,key(resolve(path)),context);
    if(!saved?.folder)return undefined;
    await verifyManagedProjectFolder(saved.folder,this.engine.directory);return saved.folder;
  }
  async rememberFolder(tx:Parameters<Parameters<Engine['root']['commit']>[0]>[0],folder:ManagedProjectFolder) {
    if(dirname(folder.root)!==await this.root())return;
    (await tx.doc(Folder,key(folder.root),{id:key(folder.root)})).folder=folder;
  }
  private retainPath(path:string) { this.paths.set(path,(this.paths.get(path)??0)+1); }
  private releasePath(path:string) { const count=this.paths.get(path)??0;if(count>1)this.paths.set(path,count-1);else this.paths.delete(path); }
  async create(raw: unknown): Promise<NamedProjectCreation> {
    if (this.stopping) throw new Error('服务正在停止，请稍后创建项目');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !validRequest((raw as Record<string,unknown>).requestId)) throw new Error('项目创建请求无效');
    const input = raw as Record<string,unknown>, changes = projectChanges(input), requestId = input.requestId as string;
    const predecessor = this.requests.get(requestId);
    const operation = (async()=>{ await predecessor?.catch(()=>{}); return this.perform(requestId,changes); })();
    this.requests.set(requestId,operation);
    try { return await operation; } finally { if (this.requests.get(requestId)===operation) this.requests.delete(requestId); }
  }
  private async inspect(requestId: string, intent: Intent): Promise<NamedProjectCreation> {
    if (intent.result) return intent.result;
    const project = (await this.engine.snapshot()).projects.find(project=>project.id===intent.projectId && project.path===intent.folder);
    if (project && intent.identity) {
      await verifyManagedProjectFolder(intent.identity,this.engine.directory);
      return {status:'created',requestId,project,...(intent.commitError?{commitError:intent.commitError}:{})};
    }
    return {status:'unconfirmed',requestId,error:'项目创建结果待核对；请检查主机目录，同一请求不会重复创建。'};
  }
  private async perform(requestId: string, changes: ReturnType<typeof projectChanges>): Promise<NamedProjectCreation> {
    if(this.stopping)throw new Error('服务正在停止，请稍后创建项目');
    const digest = key(JSON.stringify(changes)), receiptKey = key(requestId); let old: Intent | undefined, cancelled = false;
    await this.engine.root.commit(async tx=>{
      const receipt = await tx.doc(Receipt,receiptKey,{id:receiptKey});
      if (receipt.intent) { if (receipt.intent.digest!==digest) throw new Error('项目创建请求 ID 已用于其他内容'); old=JSON.parse(JSON.stringify(receipt.intent)); return; }
      if (receipt.cancelled) { cancelled=true; return; }
      receipt.intent={digest,projectId:randomUUID(),name:changes.name,stage:'claiming'};
    },context);
    if (old) return this.inspect(requestId,old);
    if (cancelled) return {status:'cancelled',requestId};
    const controller = new AbortController(); this.controllers.set(requestId,controller);
    if(this.stopping)controller.abort();
    let identity: ManagedProjectFolder | undefined, folder: string | undefined;
    const save = async (patch: Partial<Intent>) => { await this.engine.root.commit(async tx=>{const receipt=await tx.doc(Receipt,receiptKey,{id:receiptKey});Object.assign(receipt.intent!,patch);if(receipt.cancelled)controller.abort();},context); controller.signal.throwIfAborted(); };
    try {
      const root = await this.root();
      if (await realpath(dirname(root)) !== dirname(root)) throw new Error('托管项目的主机目录已改变');
      await mkdir(root,{recursive:true,mode:0o700});
      if (!(await lstat(root)).isDirectory() || await realpath(root)!==root) throw new Error('托管项目目录不能指向其他位置');
      const slug = newProjectFolderName(changes.name);
      for (let attempt=1;attempt<=100;attempt++) {
        folder=join(root,attempt===1?slug:slug+'-'+attempt);this.retainPath(folder);
        await save({folder,stage:'claiming'});
        try { await mkdir(folder,{mode:0o700}); break; }
        catch(error) { this.releasePath(folder);folder=undefined;if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error; }
      }
      if (!folder) throw new Error('项目目录名称已被占用，请换一个名称');
      const info = await lstat(folder,{bigint:true}); identity={root:folder,device:String(info.dev),inode:String(info.ino)};
      await verifyManagedProjectFolder(identity,this.engine.directory); await save({identity,stage:'scaffolding'});
      const run = (args:string[],allowFailure=false,timeout=10_000)=>this.git(folder!,args,{signal:controller.signal,allowFailure,timeout});
      const configured = await run(['config','--get','init.defaultBranch'],true).catch(()=>undefined);
      controller.signal.throwIfAborted();
      await run(['init','--initial-branch='+((configured?.code===0&&configured.stdout.trim())||'main')]);
      await writeFile(join(folder,'README.md'),`<img src="assets/icon.svg" width="64" height="64" alt="">\n\n# ${changes.name}\n\nCreated in Friday.\n`,{flag:'wx'});
      await mkdir(join(folder,'assets'));
      await writeFile(join(folder,'assets','icon.svg'),namedProjectIconSvg(changes.name),{flag:'wx'});
      await run(['add','--force','--','README.md','assets/icon.svg']);
      let commitError: string | undefined;
      try { const result=await run(['commit','--message','Initial commit'],true,30_000); if(result.code!==0)commitError=commitFailure(result.stderr); }
      catch(error) { if(controller.signal.aborted)throw error; commitError=(error as Error).message; }
      await save({stage:'registering',...(commitError?{commitError}:{})});
      let project!: Project;
      await this.engine.root.commit(async tx=>{
        const receipt=await tx.doc(Receipt,receiptKey,{id:receiptKey});if(receipt.cancelled)throw new Error('项目创建已取消');
        const state=await tx.doc(WorkspaceDoc);if(state.projects.some(project=>project.path===folder))throw new Error('这个目录已经添加');
        const stamp=new Date().toISOString();project={id:receipt.intent!.projectId,path:folder!,context:'',...changes,managedFolder:identity,createdAt:stamp,updatedAt:stamp};
        state.projects.push(project);state.revision++;
        (await tx.doc(Folder,key(folder!),{id:key(folder!)})).folder=identity;
        receipt.intent!.result={status:'created',requestId,project,...(commitError?{commitError}:{})};
      },context);
      this.engine.emit('change');return {status:'created',requestId,project,...(commitError?{commitError}:{})};
    } catch(error) {
      const owner=folder?(await this.engine.snapshot()).projects.find(project=>project.path===folder):undefined;
      if (owner?.id===(await this.engine.harness.snapshot(Receipt,receiptKey,context))?.intent?.projectId) {
        const receipt=await this.engine.harness.snapshot(Receipt,receiptKey,context);return this.inspect(requestId,receipt!.intent!);
      }
      if (identity&&!owner) { try { await verifyManagedProjectFolder(identity,this.engine.directory);await rm(identity.root,{recursive:true}); } catch {} }
      const result: NamedProjectCreation={status:controller.signal.aborted?'cancelled':'failed',requestId,error:controller.signal.aborted?'项目创建已取消':(error as Error).message};
      await this.engine.root.commit(async tx=>{const receipt=await tx.doc(Receipt,receiptKey,{id:receiptKey});receipt.intent!.result=result;},context);return result;
    } finally { if(folder)this.releasePath(folder);this.controllers.delete(requestId); }
  }
  async status(requestId: string): Promise<NamedProjectCreation> {
    if(!validRequest(requestId))throw new Error('项目创建请求无效');
    const active=this.requests.get(requestId);if(active)return active;
    const receipt=await this.engine.harness.snapshot(Receipt,key(requestId),context);
    return receipt?.intent?this.inspect(requestId,receipt.intent):{status:receipt?.cancelled?'cancelled':'missing',requestId};
  }
  async cancel(requestId: string): Promise<NamedProjectCreation> {
    if(!validRequest(requestId))throw new Error('项目创建请求无效');
    await this.engine.root.commit(async tx=>{(await tx.doc(Receipt,key(requestId),{id:key(requestId)})).cancelled=true;},context);
    this.controllers.get(requestId)?.abort();return this.status(requestId);
  }
  async close() { this.stopping=true;for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.requests.values()]); }
}
