import { constants } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import type { Engine } from './engine.js';

type Editor = { id: string; label: string; commands: string[]; style: 'goto' | 'direct' | 'line'; names?: string[]; args?: string[] };
// Order and launch conventions follow T3code's EDITORS / resolveEditorCommand.
export const taskEditors: readonly Editor[] = [
  { id: 'cursor', label: 'Cursor', commands: ['cursor'], args: ['--classic'], style: 'goto' },
  { id: 'trae', label: 'Trae', commands: ['trae'], style: 'goto' },
  { id: 'kiro', label: 'Kiro', commands: ['kiro'], args: ['ide'], style: 'goto' },
  { id: 'vscode', label: 'VS Code', names: ['Visual Studio Code'], commands: ['code'], style: 'goto' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', names: ['Visual Studio Code - Insiders'], commands: ['code-insiders'], style: 'goto' },
  { id: 'vscodium', label: 'VSCodium', commands: ['codium'], style: 'goto' },
  { id: 'zed', label: 'Zed', commands: ['zed', 'zeditor'], style: 'direct' },
  { id: 'antigravity', label: 'Antigravity', names: ['Antigravity IDE'], commands: ['antigravity-ide', 'agy-ide'], style: 'goto' },
  ...[
    ['idea', 'IntelliJ IDEA', ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate']],
    ['aqua', 'Aqua'], ['clion', 'CLion'], ['datagrip', 'DataGrip'], ['dataspell', 'DataSpell'], ['goland', 'GoLand'],
    ['phpstorm', 'PhpStorm'], ['pycharm', 'PyCharm', ['PyCharm', 'PyCharm CE']], ['rider', 'Rider', ['Rider', 'JetBrains Rider']],
    ['rubymine', 'RubyMine'], ['rustrover', 'RustRover'], ['webstorm', 'WebStorm'],
  ].map(([id, label, names]) => ({ id: id as string, label: label as string, commands: [id as string], style: 'line' as const, ...(names ? { names: names as string[] } : {}) })),
  { id: 'file-manager', label: 'File Manager', commands: [], style: 'direct' },
];
type Launch = { command: string; args: string[] };
type Options = { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; appRoots?: string[]; run?: (launch: Launch, cwd: string) => Promise<void> };
const executable = async (path: string) => { try { await access(path, constants.X_OK); return (await stat(path)).isFile(); } catch { return false; } };

export class TaskHostEditors {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly appRoots: string[];
  private readonly run: NonNullable<Options['run']>;
  constructor(private readonly engine: Engine, options: Options = {}) {
    this.env = { ...(options.env ?? process.env) }; this.platform = options.platform ?? process.platform;
    this.appRoots = options.appRoots ?? [...(this.env.HOME ? [join(this.env.HOME, 'Applications')] : []), '/Applications'];
    this.run = options.run ?? ((launch, cwd) => new Promise<void>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { cwd, env: this.env, detached: true, stdio: 'ignore', shell: false });
      child.once('error', () => reject(new Error('无法在主机上打开文件，请检查应用是否仍可用')));
      child.once('spawn', () => { child.unref(); resolve(); });
    }));
  }
  private async command(editor: Editor): Promise<Launch | undefined> {
    if (editor.id === 'file-manager') {
      if (this.platform === 'darwin' && await executable('/usr/bin/open')) return { command: '/usr/bin/open', args: [] };
      if (this.platform === 'linux') { const command = await this.pathCommand(['xdg-open']); if (command) return { command, args: [] }; }
      return;
    }
    const fromPath = async () => { const command = await this.pathCommand(editor.commands); return command ? { command, args: [...(editor.args ?? [])] } : undefined; };
    // Prefer the editor bundle to an unrelated ZFS `zed` daemon in PATH.
    if (!(this.platform === 'darwin' && editor.id === 'zed')) { const found = await fromPath(); if (found) return found; }
    if (this.platform === 'darwin') {
      const names = editor.names ?? [editor.label];
      for (const root of this.appRoots) {
        const entries = await readdir(root).catch(() => []);
        const bundles = [...names.map(name => name + '.app'), ...entries.filter(entry => names.some(name => entry.startsWith(name + ' ') && entry.endsWith('.app') && /^\d[\d.]*$/.test(entry.slice(name.length + 1, -4))))];
        for (const bundle of bundles) {
          const contents = join(root, bundle, 'Contents');
          const candidates = editor.style === 'line' || editor.id === 'zed'
            ? [join(contents, 'MacOS', editor.id === 'zed' ? 'cli' : editor.commands[0])]
            : [join(contents, 'Resources/app/bin', editor.commands[0]), join(contents, 'Resources/app/bin/code')];
          for (const command of candidates) if (await executable(command)) return { command, args: editor.id === 'kiro' ? [] : [...(editor.args ?? [])] };
        }
      }
      if (editor.style === 'line' && this.env.HOME) {
        const command = join(this.env.HOME, 'Library/Application Support/JetBrains/Toolbox/scripts', editor.commands[0]);
        if (await executable(command)) return { command, args: [] };
      }
      if (editor.id === 'zed') return fromPath();
    }
  }
  private async pathCommand(names: readonly string[]) {
    for (const name of names) for (const directory of (this.env.PATH ?? '').split(this.platform === 'win32' ? ';' : ':')) {
      if (!isAbsolute(directory)) continue;
      const path = join(directory, name); if (await executable(path)) return path;
    }
  }
  private async owner(scope: unknown, workspaceRoot: unknown) {
    const owner = await this.engine.contexts.owner(scope);
    if (typeof workspaceRoot !== 'string' || workspaceRoot !== owner.cwd) throw new Error('文件所属工作区已改变，请重新打开文件');
    return owner;
  }
  async snapshot(scope: unknown, workspaceRoot: unknown) {
    const owner = await this.owner(scope, workspaceRoot);
    await owner.files.externalTarget('');
    const found = await Promise.all(taskEditors.map(async editor => await this.command(editor) ? { id: editor.id, label: editor.id === 'file-manager' && this.platform === 'darwin' ? 'Finder' : editor.label } : undefined));
    return { workspaceRoot: owner.cwd, platform: this.platform, revealSupported: this.platform === 'darwin', editors: found.filter(editor => editor !== undefined) };
  }
  async open(input: { scope: unknown; workspaceRoot: unknown; path: unknown; editor: unknown; reveal?: unknown; line?: unknown; column?: unknown }) {
    const editor = taskEditors.find(editor => editor.id === input.editor);
    if (!editor || input.reveal !== undefined && typeof input.reveal !== 'boolean' || input.reveal === true && editor.id !== 'file-manager') throw new Error('打开方式无效');
    for (const value of [input.line, input.column]) if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000_000)) throw new Error('文件行列位置无效');
    if (input.column !== undefined && input.line === undefined) throw new Error('文件行列位置无效');
    const owner = await this.owner(input.scope, input.workspaceRoot), target = await owner.files.externalTarget(input.path);
    const launch = await this.command(editor); if (!launch) throw new Error('主机上未找到这个编辑器');
    if (input.reveal === true && this.platform !== 'darwin') throw new Error('主机不支持在文件管理器中显示');
    const current = await this.owner(input.scope, input.workspaceRoot), fresh = await current.files.externalTarget(input.path);
    if (fresh.target !== target.target || fresh.workspaceVersion !== target.workspaceVersion) throw new Error('文件所属工作区或路径已改变，请重新打开文件');
    let args = [target.target];
    if (input.line !== undefined && target.kind === 'file' && editor.id !== 'file-manager') {
      const location = `${target.target}:${input.line}${input.column === undefined ? '' : ':' + input.column}`;
      args = editor.style === 'goto' ? ['--goto', location] : editor.style === 'line' ? ['--line', String(input.line), ...(input.column === undefined ? [] : ['--column', String(input.column)]), target.target] : [location];
    }
    if (input.reveal === true) args.unshift('-R');
    // Explicit user action only. No automatic retry or startup replay of a launch.
    await this.run({ command: launch.command, args: [...launch.args, ...args] }, owner.cwd);
    return { opened: true, workspaceRoot: owner.cwd, editor: editor.id };
  }
}
