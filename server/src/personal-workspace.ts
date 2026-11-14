import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { personalWorkspaceDefault } from './friday-paths.mjs';
import type { Engine } from './engine.js';

export type PersonalWorkspaceSettings = { path: string; version: number };
export function expandHome(path: string) {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/** A base directory for personal files, never a filesystem sandbox. */
export class PersonalWorkspace {
  constructor(private readonly engine: Engine) {}
  async settings(): Promise<PersonalWorkspaceSettings> {
    return (await this.engine.snapshot()).personalWorkspace ?? { path: personalWorkspaceDefault(this.engine.directory), version: 0 };
  }
  async ensure() {
    const { path } = await this.settings();
    await mkdir(path, { recursive: true, mode: 0o700 });
    return realpath(path);
  }
  async save(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Workspace 设置无效');
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !['path', 'expectedVersion'].includes(key)) || typeof body.path !== 'string' || !body.path.trim() || body.path.length > 4096 || /[\x00-\x1f]/.test(body.path) || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) throw new Error('Workspace 设置无效');
    const path = expandHome(body.path.trim());
    if (!isAbsolute(path)) throw new Error('请填写主机上的绝对路径或 ~/ 路径');
    // Custom locations must already exist; a typo must not create a directory tree.
    const resolved = await realpath(path);
    if (!(await stat(resolved)).isDirectory()) throw new Error('Workspace 必须是目录');
    await this.engine.mutate(state => {
      if ((state.personalWorkspace?.version ?? 0) !== body.expectedVersion) throw new Error('Workspace 已在其他窗口修改，请重新加载后重试');
      state.personalWorkspace = { path: resolved, version: Number(body.expectedVersion) + 1 };
    });
    return this.settings();
  }
}
