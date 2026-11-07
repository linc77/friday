import { access, chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { HostBrowserError, browserProfileID } from './task-host-browser-protocol.js';

export interface HostBrowserContextLease { context: BrowserContext; release(): Promise<void> }
export interface HostBrowserPlatform { acquire(profile: string, incognito: boolean, task: string): Promise<HostBrowserContextLease>; clearProfile?(profile: string): Promise<void>; close(): Promise<void> }
export async function hostBrowserExecutable(environment = process.env): Promise<string> {
  const candidates = environment.FRIDAY_BROWSER_EXECUTABLE ? [environment.FRIDAY_BROWSER_EXECUTABLE] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'] : process.platform === 'win32' ? [join(environment.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe')] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const path of candidates) { if (!isAbsolute(path)) continue; try { await access(path, constants.X_OK); return path; } catch {} }
  throw new HostBrowserError('主机未找到 Chrome 或 Chromium。请在主机安装浏览器，或设置 FRIDAY_BROWSER_EXECUTABLE。', 503);
}
export async function privateBrowserDirectory(path: string) {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = await lstat(path); if (info.isSymbolicLink() || !info.isDirectory()) throw new HostBrowserError('浏览器私有目录无效');
  await chmod(path, 0o700); return path;
}
type Entry = { count: number; context: Promise<BrowserContext>; closing?: Promise<void> };
export class HostChromeContexts implements HostBrowserPlatform {
  private entries = new Map<string, Entry>();
  private browser?: Promise<Browser>;
  private stopped = false;
  private clearing = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}
  private async options() {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key]!;
    return { executablePath: await hostBrowserExecutable(), headless: true, chromiumSandbox: true, env, timeout: 20000, args: ['--disable-gpu', '--force-device-scale-factor=2', '--disable-session-crashed-bubble'] };
  }
  private async create(profile: string, incognito: boolean) {
    const options = await this.options();
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true };
    if (incognito) {
      if (!this.browser) {
        const pending = chromium.launch(options); this.browser = pending;
        void pending.then(browser => browser.on('disconnected', () => { if (this.browser === pending) this.browser = undefined; })).catch(() => {});
        void pending.catch(() => { if (this.browser === pending) this.browser = undefined; });
      }
      const context = await (await this.browser).newContext(contextOptions);
      await context.grantPermissions(['clipboard-write']); return context;
    }
    const root = await privateBrowserDirectory(join(this.directory, 'browser'));
    const profiles = await privateBrowserDirectory(join(root, 'profiles'));
    const path = await privateBrowserDirectory(join(profiles, createHash('sha256').update(profile).digest('hex')));
    const context = await chromium.launchPersistentContext(path, { ...options, ...contextOptions });
    await context.grantPermissions(['clipboard-write']);
    for (const page of context.pages()) await page.close();
    return context;
  }
  async acquire(profile: string, incognito: boolean, task: string): Promise<HostBrowserContextLease> {
    if (this.stopped) throw new HostBrowserError('主机浏览器已停止', 503);
    browserProfileID(profile);
    const key = JSON.stringify([profile, incognito ? task : null]);
    if (!incognito && this.clearing.has(profile)) { await this.clearing.get(profile); return this.acquire(profile, incognito, task); }
    let entry = this.entries.get(key);
    if (entry?.closing) { await entry.closing; return this.acquire(profile, incognito, task); }
    if (!entry) {
      if (this.entries.size >= 8) throw new HostBrowserError('最多同时使用 8 个主机浏览配置，请先关闭未使用的标签', 429);
      entry = { count: 0, context: this.create(profile, incognito) }; this.entries.set(key, entry);
      const own = entry; void entry.context.catch(() => { if (this.entries.get(key) === own) this.entries.delete(key); });
    }
    entry.count++;
    let released = false; const own = entry;
    const release = async () => {
      if (released) return; released = true; own.count--;
      if (own.count === 0 && !own.closing) {
        own.closing = own.context.then(context => context.close()).catch(() => {}).finally(() => { if (this.entries.get(key) === own) this.entries.delete(key); });
        await own.closing;
      }
    };
    try { const context = await own.context; if (this.stopped) throw new HostBrowserError('主机浏览器已停止', 503); return { context, release }; }
    catch (error) { await release(); throw error; }
  }
  async clearProfile(profile: string) {
    browserProfileID(profile); if (profile === 'incognito') return;
    if (this.stopped) throw new HostBrowserError('主机浏览器已停止', 503);
    const prior = this.clearing.get(profile); if (prior) return prior;
    const key = JSON.stringify([profile, null]);
    const clearing = (async () => {
      const entry = this.entries.get(key);
      if (entry) { await (await entry.context.catch(() => undefined))?.close(); if (this.entries.get(key) === entry) this.entries.delete(key); }
      const root = join(this.directory, 'browser'), profiles = join(root, 'profiles'), path = join(profiles, createHash('sha256').update(profile).digest('hex'));
      for (const directory of [root, profiles, path]) {
        let info; try { info = await lstat(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
        if (info.isSymbolicLink() || !info.isDirectory()) throw new HostBrowserError('浏览器私有目录无效');
      }
      await rm(path, { recursive: true, force: true });
    })();
    this.clearing.set(profile, clearing);
    try { await clearing; } finally { if (this.clearing.get(profile) === clearing) this.clearing.delete(profile); }
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.entries.values()].map(async entry => { if (entry.closing) await entry.closing; else await (await entry.context).close(); }));
    await this.browser?.then(browser => browser.close()).catch(() => {}); this.entries.clear();
    await Promise.allSettled(this.clearing.values());
  }
}
