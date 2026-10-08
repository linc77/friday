import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { TaskGitContext, Workspace } from './types.js';

const exec = promisify(execFile);
export const gitRefreshInterval = 5_000;

export async function readGitContext(cwd: string): Promise<TaskGitContext> {
  // Always inspect the task directory, even when Friday was launched from a
  // different repository or with Git's environment overrides set.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = async (...args: string[]) => (await exec('git', ['-C', cwd, ...args], {
    env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }, timeout: 1_500, maxBuffer: 64 * 1024,
  })).stdout.trim();
  try {
    const [inside, gitDir, commonDir] = (await git('rev-parse', '--is-inside-work-tree', '--path-format=absolute', '--git-dir', '--git-common-dir')).split('\n');
    if (inside !== 'true') return { status: 'not_repository' };
    const [directory, common] = await Promise.all([realpath(gitDir), realpath(commonDir)]);
    let branch: string | null;
    try { branch = await git('symbolic-ref', '--quiet', '--short', 'HEAD'); }
    catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error;
      branch = null; // Detached HEAD; an unborn branch still has a symbolic ref.
    }
    const head = branch ? null : await git('rev-parse', '--short=8', '--verify', 'HEAD');
    return { status: 'repository', branch, head, isWorktree: directory !== common };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    return { status: stderr.startsWith('fatal: not a git repository') ? 'not_repository' : 'unavailable' };
  }
}

// Live presentation metadata, never written to the durable task record. Cache
// and share in-flight reads across tasks/clients, and bound process concurrency.
export class TaskGitContexts {
  private cache = new Map<string, { expires: number; version: string; value: Promise<TaskGitContext> }>();
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private read = readGitContext, private now = Date.now) {}

  private async inspect(cwd: string): Promise<TaskGitContext> {
    if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await this.read(cwd); }
    catch { return { status: 'unavailable' }; }
    finally {
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    }
  }

  async snapshot(state: Workspace): Promise<Workspace> {
    const paths = new Set(state.tasks.map(task => task.cwd));
    for (const path of this.cache.keys()) if (!paths.has(path)) this.cache.delete(path);
    const contexts = new Map(await Promise.all([...paths].map(async path => {
      const version = state.tasks.filter(task => task.cwd === path && task.branchChange).map(task => `${task.branchChange!.requestId}:${task.branchChange!.status}`).join('|');
      let cached = this.cache.get(path);
      if (!cached || cached.version !== version || cached.expires <= this.now()) {
        const entry = { expires: Infinity, version, value: this.inspect(path) };
        entry.value = entry.value.then(value => { entry.expires = this.now() + gitRefreshInterval; return value; });
        this.cache.set(path, entry); cached = entry;
      }
      return [path, await cached.value] as const;
    })));
    return { ...state, tasks: state.tasks.map(task => ({ ...task, git: contexts.get(task.cwd)! })) };
  }
}
