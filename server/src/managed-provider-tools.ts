import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, statfs, cp, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { nativeToolDownload, nativeToolExecutable, extractNativeToolArchive, nativeToolPath } from './native-tool-archive.js';
import { findExecutable } from './agents.js';
import { workspaceCommand } from './git-process.js';
import { parseAcpRegistryPackage } from './acp-registry-catalog.js';

export type ManagedToolInstallState = { operationId: string | null; tool: string; phase: 'idle' | 'downloading' | 'extracting' | 'verifying' | 'complete' | 'cancelled' | 'failed'; downloadedBytes: number; totalBytes: number | null; error: string | null };
export type ManagedToolArchive = { tool: string; version: string; url: string; sha256?: string; archiveBytes?: number; files: { name: string; bytes?: number }[] };
export type ManagedToolPackage = { tool: string; version: string; kind: 'npx' | 'uvx'; package: string; candidates: string[] };
type Receipt = { binding: string; command: string; pathDirectories: string[]; files: { name: string; bytes: number }[] };
type InstalledTool = { directory: string; command: string; pathDirectories: string[]; files: Record<string, string> };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeTool = (value: string) => { if (!/^[a-z0-9][a-z0-9._-]{0,159}$/i.test(value)) throw new Error('托管工具标识无效'); return value; };

/** Installation metadata only. Durable remains the owner of task execution.
 * Each explicit prepare owns one staging directory and publishes an atomic
 * receipt only after all required files have been checked. */
export class ManagedProviderTools {
  onChange?: (state: ManagedToolInstallState) => void;
  private installs = new Map<string, { binding: string; state: ManagedToolInstallState; controller: AbortController; promise: Promise<InstalledTool> }>();
  private leases = new Map<string, number>();
  constructor(readonly directory: string, private options: { fetch?: typeof fetch; manager?: (kind: 'npx' | 'uvx') => string | null } = {}) {}
  private root(tool: string, binding: string) { return join(this.directory, 'tools', safeTool(tool), 'versions', binding); }
  state(tool: string): ManagedToolInstallState { return { ...(this.installs.get(tool)?.state ?? { tool, operationId: null, phase: 'idle', downloadedBytes: 0, totalBytes: null, error: null }) }; }
  private publish(state: ManagedToolInstallState, values: Partial<ManagedToolInstallState>) { Object.assign(state, values); this.onChange?.({ ...state }); }
  private async read(tool: string, binding: string): Promise<InstalledTool | undefined> {
    const directory = this.root(tool, binding);
    try {
      const file = join(directory, '.install-complete.json'); if ((await stat(file)).size > 8192) return;
      const receipt = JSON.parse(await readFile(file, 'utf8')) as Receipt;
      if (receipt.binding !== binding || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 64 || !Array.isArray(receipt.pathDirectories)) return;
      const files: Record<string, string> = {};
      for (const item of receipt.files) { const path = await nativeToolExecutable(directory, item.name, false); if ((await stat(path)).size !== item.bytes) return; files[item.name] = path; }
      const command = await nativeToolExecutable(directory, receipt.command, false); await access(command, constants.X_OK);
      const pathDirectories = receipt.pathDirectories.map(path => join(directory, ...nativeToolPath(path)));
      return { directory, command, pathDirectories: [...new Set([...pathDirectories, dirname(command)])], files };
    } catch { return; }
  }
  installedArchive(input: ManagedToolArchive) { return this.read(input.tool, digest(input)); }
  installedPackage(input: ManagedToolPackage) { return this.read(input.tool, digest(input)); }
  async preparedDirectories(tool: string) {
    safeTool(tool); const root = join(this.directory, 'tools', tool, 'versions'), directories: string[] = [];
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const versions = await Promise.all(entries.filter(value => value.isDirectory() && /^[a-f0-9]{64}$/.test(value.name)).map(async value => ({ name: value.name, at: (await stat(join(root, value.name))).mtimeMs })));
    for (const version of versions.sort((a, b) => b.at - a.at)) { const installed = await this.read(tool, version.name); if (installed) directories.push(...installed.pathDirectories); }
    return [...new Set(directories)];
  }
  private start(tool: string, binding: string, install: (stage: string, state: ManagedToolInstallState, signal: AbortSignal) => Promise<Omit<Receipt, 'binding'>>, stablePayload = false) {
    safeTool(tool); const previous = this.installs.get(tool);
    if (previous && ['downloading', 'extracting', 'verifying'].includes(previous.state.phase)) { if (previous.binding !== binding) return Promise.reject(new Error('请先取消正在安装的其他工具版本')); return previous.promise; }
    const controller = new AbortController(), state: ManagedToolInstallState = { tool, operationId: randomUUID(), phase: 'downloading', downloadedBytes: 0, totalBytes: null, error: null };
    const promise = (async () => {
      const existing = await this.read(tool, binding); if (existing) { this.publish(state, { phase: 'complete' }); return existing; }
      const final = this.root(tool, binding); await mkdir(dirname(final), { recursive: true, mode: 0o700 }); const temporary = await mkdtemp(join(dirname(final), '.install-'));
      try {
        if (stablePayload && this.leases.get(final)) throw new Error('工具版本仍被原生会话使用');
        if (stablePayload) await rm(final, { recursive: true, force: true });
        const payload = stablePayload ? final : join(temporary, 'payload'); await mkdir(payload, { mode: 0o700 });
        const receipt = await install(payload, state, controller.signal); controller.signal.throwIfAborted();
        this.publish(state, { phase: 'verifying' });
        const pendingReceipt = join(payload, '.install-complete.tmp'); await writeFile(pendingReceipt, JSON.stringify({ ...receipt, binding }), { flag: 'wx', mode: 0o600 }); await rename(pendingReceipt, join(payload, '.install-complete.json'));
        // An incomplete directory is never leased or accepted as installed.
        if (this.leases.get(final)) throw new Error('工具版本仍被原生会话使用');
        if (!stablePayload) { await rm(final, { recursive: true, force: true }); await rename(payload, final); }
        const value = await this.read(tool, binding); if (!value) throw new Error('托管工具文件校验失败');
        this.publish(state, { phase: 'complete' }); return value;
      } catch (error) { if (stablePayload && !this.leases.get(final)) await rm(final, { recursive: true, force: true }); this.publish(state, { phase: controller.signal.aborted ? 'cancelled' : 'failed', error: controller.signal.aborted ? null : error instanceof Error ? error.message : '工具安装失败' }); throw error; }
      finally { await rm(temporary, { recursive: true, force: true }); }
    })();
    void promise.catch(() => {}); this.installs.set(tool, { binding, state, controller, promise }); this.onChange?.({ ...state }); return promise;
  }
  prepareArchive(input: ManagedToolArchive) {
    return this.start(input.tool, digest(input), async (stage, state, signal) => {
      if (!input.files.length || input.files.length > 64) throw new Error('工具必需文件列表无效');
      const required = (input.archiveBytes ?? 0) + input.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0) + 256 * 1024 * 1024;
      const space = await statfs(stage, { bigint: true }).catch(() => undefined); if (space && space.bavail * space.bsize < BigInt(required)) throw new Error('工具安装所需磁盘空间不足');
      const archive = join(dirname(stage), 'archive'); this.publish(state, { totalBytes: input.archiveBytes ?? null });
      let last = 0;
      await nativeToolDownload(input.url, archive, { sha256: input.sha256, expectedBytes: input.archiveBytes, signal: AbortSignal.any([signal, AbortSignal.timeout(20 * 60000)]), fetch: this.options.fetch, progress: (bytes, total) => { state.downloadedBytes = bytes; state.totalBytes = total ?? input.archiveBytes ?? null; if (Date.now() - last > 100) { last = Date.now(); this.onChange?.({ ...state }); } } });
      this.publish(state, { phase: 'extracting' });
      if (/\.(zip|tar(?:\.(gz|bz2|xz))?|tgz|tbz2)$/i.test(new URL(input.url).pathname)) await extractNativeToolArchive(archive, stage, input.url, signal);
      else { if (input.files.length !== 1) throw new Error('工具归档格式无效'); const destination = join(stage, ...nativeToolPath(input.files[0]!.name)); await mkdir(dirname(destination), { recursive: true, mode: 0o700 }); await cp(archive, destination, { force: false, errorOnExist: true }); }
      const files = [];
      for (const file of input.files) { const path = await nativeToolExecutable(stage, file.name), bytes = (await stat(path)).size; if (file.bytes !== undefined && bytes !== file.bytes) throw new Error('工具文件大小校验失败'); files.push({ name: file.name, bytes }); }
      return { command: input.files[0]!.name, files, pathDirectories: [dirname(input.files[0]!.name)].filter(path => path !== '.') };
    });
  }
  preparePackage(input: ManagedToolPackage) {
    return this.start(input.tool, digest(input), async (stage, state, signal) => {
      const manager = this.options.manager ? this.options.manager(input.kind) : findExecutable(input.kind === 'npx' ? 'npm' : 'uv'); if (!manager) throw new Error(input.kind === 'npx' ? '请先安装 npm' : '请先安装 uv');
      const npm = input.kind === 'npx', { name, version } = parseAcpRegistryPackage(input.package, input.kind), prefix = join(stage, npm ? 'npm' : 'python'), bins = join(stage, 'bin'); await mkdir(prefix, { recursive: true }); await mkdir(bins);
      try { await workspaceCommand(stage, manager, npm ? ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--', input.package] : ['tool', 'install', '--force', '--', name + '==' + version], { env: { ...process.env, CI: 'true', ...(npm ? {} : { UV_TOOL_DIR: prefix, UV_TOOL_BIN_DIR: bins }) }, signal, timeout: 20 * 60000, limit: 2 * 1024 * 1024 }); }
      catch { throw new Error(signal.aborted ? '工具安装已取消' : '固定版本工具包安装失败'); }
      this.publish(state, { phase: 'verifying' }); let command: string | undefined;
      if (npm) {
        const packageRoot = join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', name), manifestPath = join(packageRoot, 'package.json'); if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('工具包清单过大');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); if (manifest.name !== name || manifest.version !== version) throw new Error('工具包实际版本与固定版本不符');
        const bin = typeof manifest.bin === 'string' ? manifest.bin : input.candidates.map(name => manifest.bin?.[name]).find(value => typeof value === 'string');
        if (typeof bin !== 'string') throw new Error('工具包没有可确认的可执行入口'); command = relative(stage, await nativeToolExecutable(packageRoot, bin));
      } else {
        const output = await workspaceCommand(stage, manager, ['tool', 'list'], { env: { ...process.env, UV_TOOL_DIR: prefix, UV_TOOL_BIN_DIR: bins }, signal, timeout: 30000, limit: 1024 * 1024 });
        if (!output.stdout.split(/\r?\n/).some(line => { const match = /^(\S+) v(\S+)(?:\s|$)/.exec(line); return match?.[1]?.replace(/[._-]+/g, '-').toLowerCase() === name.replace(/[._-]+/g, '-').toLowerCase() && match?.[2] === version; })) throw new Error('Python 工具实际版本未确认');
        for (const name of input.candidates) { if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)) continue; try { command = relative(stage, await nativeToolExecutable(stage, 'bin/' + name)); break; } catch {} }
      }
      if (!command) throw new Error('工具没有可确认的启动入口');
      await access(join(stage, command), constants.X_OK); const bytes = (await stat(join(stage, command))).size;
      return { command, files: [{ name: command, bytes }], pathDirectories: [npm ? relative(stage, join(prefix, process.platform === 'win32' ? '' : 'bin')) : 'bin'] };
    }, true);
  }
  async acquire(value: InstalledTool) { this.leases.set(value.directory, (this.leases.get(value.directory) ?? 0) + 1); let released = false; return { ...value, close: async () => { if (released) return; released = true; const count = (this.leases.get(value.directory) ?? 1) - 1; if (count) this.leases.set(value.directory, count); else this.leases.delete(value.directory); } }; }
  async remove(tool: string) { safeTool(tool); const root = join(this.directory, 'tools', tool); if ([...this.leases].some(([path, users]) => users > 0 && path.startsWith(root + '/'))) throw new Error('工具仍被原生会话使用'); const live = this.installs.get(tool); if (live && ['downloading', 'extracting', 'verifying'].includes(live.state.phase)) throw new Error('请先取消工具安装'); await rm(root, { recursive: true, force: true }); this.installs.delete(tool); }
  cancel(tool: string, operationId: string) { const live = this.installs.get(tool); if (!live || live.state.operationId !== operationId) throw new Error('工具安装操作已经改变'); live.controller.abort(); return live.promise.catch(() => undefined); }
  async close() { for (const value of this.installs.values()) if (['downloading', 'extracting', 'verifying'].includes(value.state.phase)) value.controller.abort(); await Promise.allSettled([...this.installs.values()].map(value => value.promise)); }
}
