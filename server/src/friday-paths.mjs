import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, lstat, mkdir, realpath, stat, symlink } from 'node:fs/promises';

export function fridayPaths({ home = homedir(), env = process.env } = {}) {
  const root = resolve(env.FRIDAY_HOME ?? join(home, '.friday'));
  const customData = env.FRIDAY_DATA_DIR !== undefined;
  const data = customData ? resolve(env.FRIDAY_DATA_DIR) : join(root, 'data');
  return { root, data, workspace: join(customData ? data : root, 'workspace'),
    logs: join(customData ? data : root, 'logs'), legacy: join(home, 'Library/Application Support/Friday'),
    adoptLegacy: !customData && env.FRIDAY_HOME === undefined };
}

/** Read-only tools must find an existing installation without creating a new one. */
export function existingFridayData(options) {
  const paths = fridayPaths(options);
  if (paths.adoptLegacy && !existsSync(paths.data) && existsSync(paths.legacy)) return paths.legacy;
  return paths.data;
}

/** Preserve saved absolute paths and the original SQLite ownership lease. No
 * live database copying, renaming, or rewriting persisted task/checkpoint data. */
async function directoryLink(source, destination) {
  const sourceInfo = await lstat(source).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!sourceInfo) return false;
  const sourcePath = await realpath(source);
  if (!(await stat(sourcePath)).isDirectory()) throw new Error(`Friday 路径不是目录：${source}`);
  let target = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!target) {
    try { await symlink(sourcePath, destination, 'dir'); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    target = await lstat(destination);
  }
  if (await realpath(destination) !== sourcePath) throw new Error(`Friday 目录冲突，未移动或覆盖任何数据：${destination} 与 ${source}`);
  return true;
}

export async function prepareFridayPaths(options) {
  const paths = fridayPaths(options);
  // An explicit data override is an isolated legacy-style installation.
  if ((options?.env ?? process.env).FRIDAY_DATA_DIR === undefined) {
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    await chmod(paths.root, 0o700);
  }
  if (paths.adoptLegacy) await directoryLink(paths.legacy, paths.data);
  await mkdir(paths.data, { recursive: true, mode: 0o700 });
  // Existing personal files remain at their original paths too.
  if (paths.workspace !== join(paths.data, 'workspace')) await directoryLink(join(paths.data, 'workspace'), paths.workspace);
  await mkdir(paths.workspace, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  return paths;
}

export function personalWorkspaceDefault(directory, options) {
  const paths = fridayPaths(options);
  const canonical = value => { try { return realpathSync(value); } catch { return resolve(value); } };
  return canonical(directory) === canonical(paths.data) ? paths.workspace : join(directory, 'workspace');
}
