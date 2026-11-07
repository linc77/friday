/* Repository grouping follows T3 Code 8cd9641f project/RepositoryIdentityResolver
 * and shared/git.ts. MIT, Copyright (c) 2026 T3 Tools Inc.; complete license in
 * task-sidebar-order.ts. This projection never publishes raw remote URLs. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Workspace } from './types.js';
export type ProjectRepositoryIdentity = { canonicalKey: string; rootPath: string; displayName: string; name: string; origin?: { canonicalKey: string; displayName: string } };
const exec = promisify(execFile);
const localRemote = (url: string) => /^file:/i.test(url) || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && (/^[a-z]:[\\/]/i.test(url) || !url.includes(':') || /[\\/]/.test(url.slice(0,url.indexOf(':'))));
function remoteIdentity(raw: string): { canonicalKey: string; displayName: string } | null {
  const normalized = raw.trim().replace(/\/+$/g,'').replace(/\.git$/i,'').toLowerCase();
  let host: string | undefined, path: string | undefined, display: string | undefined;
  if (/^(?:ssh|https?|git):\/\//i.test(normalized)) {
    try { const url = new URL(normalized); host = url.hostname; path = url.pathname.split('/').filter(Boolean).join('/'); display = new URL(raw).pathname.split('/').filter(Boolean).join('/').replace(/\.git$/i,''); } catch { return null; }
  } else {
    const match = /^[a-zA-Z0-9._-]+@([^:/\s]+):([^/\s]+(?:\/[^/\s]+)+)$/i.exec(normalized);
    host = match?.[1]; path = match?.[2]; display = raw.match(/^[^@]+@[^:]+:(.+)$/)?.[1]?.replace(/\/+$/g,'').replace(/\.git$/i,'');
  }
  if (!host || !path || path.split('/').length < 2 || /[\x00-\x20?#@]/.test(host+path)) return null;
  const parts = path.split('/');
  const azure = ['ssh.dev.azure.com','vs-ssh.visualstudio.com'].includes(host) && parts.length === 4 && parts[0] === 'v3'
    ? host === 'ssh.dev.azure.com' ? `dev.azure.com/${parts[1]}/${parts[2]}/_git/${parts[3]}` : `${parts[1]}.visualstudio.com/${parts[2]}/_git/${parts[3]}` : null;
  const canonicalKey = azure ?? host+'/'+path, canonicalPath = canonicalKey.split('/').slice(1).join('/');
  return { canonicalKey, displayName: display?.toLowerCase() === canonicalPath ? display : canonicalPath };
}
export async function readProjectRepositoryIdentity(cwd: string): Promise<ProjectRepositoryIdentity | null> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (...args: string[]) => (await exec('git',['-c','core.hooksPath=/dev/null','-C',cwd,...args],{ env:{...env,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'},timeout:1500,maxBuffer:64*1024 })).stdout.trim();
  try {
    const rootPath = await git('rev-parse','--show-toplevel'); if (!rootPath) return null;
    const remotes = new Map<string,string>();
    for (const line of (await git('remote','-v')).split('\n')) { const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim()); if (match && !localRemote(match[2])) remotes.set(match[1],match[2]); }
    const primary = remotes.get('upstream') ?? remotes.get('origin') ?? [...remotes].sort(([a],[b])=>a.localeCompare(b))[0]?.[1];
    const identity = primary && remoteIdentity(primary); if (!identity) return null;
    const origin = remotes.get('origin') ? remoteIdentity(remotes.get('origin')!) : null;
    return { ...identity, rootPath, name: identity.displayName.split('/').at(-1)!, ...(origin && origin.canonicalKey !== identity.canonicalKey ? { origin } : {}) };
  } catch { return null; }
}
/** Shared across legacy snapshots and overview/SSE. No durable state writes,
 * model initialization, hooks or remote/network operations. */
export class ProjectRepositoryIdentities {
  private cache = new Map<string,{ version: string; expires: number; value: Promise<ProjectRepositoryIdentity|null> }>();
  private active = 0; private waiting: (()=>void)[] = [];
  constructor(private read = readProjectRepositoryIdentity, private clock = Date.now) {}
  private async inspect(path: string) {
    if (this.active >= 4) await new Promise<void>(resolve=>this.waiting.push(resolve)); else this.active++;
    try { return await this.read(path); } catch { return null; }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  async snapshot(state: Workspace): Promise<Workspace> {
    const paths = new Set(state.projects.map(project=>project.path)); for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    const pathById = new Map(state.projects.map(project=>[project.id,project.path]));
    const versions = new Map<string,string[]>();
    for (const project of state.projects) { const values = versions.get(project.path) ?? []; values.push('project:'+(project.updatedAt ?? '')); versions.set(project.path,values); }
    for (const task of state.tasks) {
      const path = task.projectId && pathById.get(task.projectId);
      if (path && task.gitOperation?.repositoryPublication) versions.get(path)!.push('publication:'+task.gitOperation.id+':'+task.gitOperation.status);
    }
    for(const operation of state.projectRepositoryOperations??[]){const path=pathById.get(operation.projectId);if(path&&operation.publication)versions.get(path)!.push('project-publication:'+operation.id+':'+operation.status+':'+operation.publication.status);}
    const projects = await Promise.all(state.projects.map(async project=>{
      const version = JSON.stringify(versions.get(project.path)!.sort());
      let entry = this.cache.get(project.path);
      if (!entry || entry.version !== version || entry.expires <= this.clock()) {
        const next = { version,expires:Infinity,value:this.inspect(project.path) }; next.value = next.value.then(value=>{ next.expires = this.clock()+(value?15*60_000:60_000); return value; }); this.cache.set(project.path,next); entry = next;
      }
      const identity = await entry.value; const { repositoryIdentity: _, ...base } = project;
      return identity ? { ...base,repositoryIdentity:identity } : base;
    }));
    return { ...state,projects:projects as Project[] };
  }
}
