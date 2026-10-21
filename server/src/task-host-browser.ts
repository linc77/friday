import { randomUUID } from 'node:crypto';
import type { Page, CDPSession, Dialog, FileChooser } from 'playwright-core';
import { HostBrowserTransfers, validateHostUploads, type HostUploadFile } from './task-host-browser-transfers.js';
import { HostBrowserClipboard, hostEditingCommand } from './task-host-browser-clipboard.js';
import { HostBrowserAnnotations } from './task-host-browser-annotations.js';
import { HostBrowserCaptures, hostBrowserLayout } from './task-host-browser-capture.js';
import { HostChromeContexts, type HostBrowserPlatform, type HostBrowserContextLease } from './task-host-browser-chrome.js';
import { HostBrowserError, HostBrowserMailbox, HostBrowserReceipts, browserID, browserProfileID, hostBrowserAction, hostBrowserSettings, type HostBrowserAction, type HostBrowserEvent, type HostBrowserSnapshot } from './task-host-browser-protocol.js';
import { normalizeBrowserURL } from './task-browser.js';

type Viewer = { id: string; device: string; mailbox: HostBrowserMailbox; inFlight: number; latest?: Extract<HostBrowserEvent, { type: 'frame' }> };
type Tab = {
  snapshot: HostBrowserSnapshot; page: Page; cdp: CDPSession; lease: HostBrowserContextLease; profile: string; incognito: boolean;
  viewers: Map<string, Viewer>; receipts: HostBrowserReceipts; tail: Promise<unknown>; dialog?: Dialog;
  keys: Map<string, Extract<HostBrowserAction, { type: 'key' }>>; buttons: number; touch: boolean; touchEnabled: boolean;
  stream?: Promise<void>; streaming: boolean; closed: boolean; sequence: number; lastFrame: number; metadata: number; queued: number;
  transfers: HostBrowserTransfers; clipboard: HostBrowserClipboard; chooser?: { id: string; multiple: boolean; accept: string; offeredTo: string | null; chooser: FileChooser }; chooserRequest: number;
  navigationURL: string | null; downloadSerial: number; lastDownload?: { serial: number; url: string }; downloadWaiters: Set<() => void>;
  uploadingChoosers: Set<string>;
  captures: HostBrowserCaptures; annotations: HostBrowserAnnotations; streamQuality: number;
};
const key = (task: string, tab: string) => JSON.stringify([task, tab]);
export class TaskHostBrowsers {
  private tabs = new Map<string, Promise<Tab>>();
  private stopped = false;
  private deleting = new Set<string>();
  private activeUploads = 0;
  private uploadWaiters = new Set<() => void>();
  private cleanups = new Set<Promise<void>>();
  private clearingProfiles = new Map<string, Promise<void>>();
  constructor(private readonly directory: string, private readonly platform: HostBrowserPlatform = new HostChromeContexts(directory)) {}
  private changed(tab: Tab) {
    if (tab.closed) return;
    tab.snapshot.revision++;
    const event: HostBrowserEvent = { type: 'state', state: structuredClone(tab.snapshot) };
    for (const viewer of tab.viewers.values()) viewer.mailbox.offer(event);
  }
  private async metadata(tab: Tab) {
    if (tab.closed) return;
    const request = ++tab.metadata, url = tab.page.url();
    if (url !== 'about:blank' && !/^https?:\/\//i.test(url)) { await tab.page.close().catch(() => {}); return; }
    const title = (await tab.page.title().catch(() => '')).slice(0, 512);
    const history = await tab.cdp.send('Page.getNavigationHistory').catch(() => null);
    if (tab.closed || tab.metadata !== request || tab.page.url() !== url) return;
    tab.snapshot.url = url; tab.snapshot.title = title;
    if (history) { tab.snapshot.back = history.currentIndex > 0; tab.snapshot.forward = history.currentIndex < history.entries.length - 1; }
    this.changed(tab);
  }
  private async create(taskId: string, tabId: string, profile: string, incognito: boolean, url: string, value: Record<string, unknown>): Promise<Tab> {
    const lease = await this.platform.acquire(profile, incognito, taskId);
    let page: Page | undefined;
    try {
      if (this.stopped || this.deleting.has(taskId)) throw new HostBrowserError('任务浏览器已关闭', 404);
      page = await lease.context.newPage();
      return await this.adopt(taskId, tabId, profile, incognito, page, lease, url, value);
    } catch (error) { await page?.close().catch(() => {}); await lease.release(); throw error; }
  }
  private async adopt(taskId: string, tabId: string, profile: string, incognito: boolean, page: Page, lease: HostBrowserContextLease, url: string | null, value: Record<string, unknown>): Promise<Tab> {
    const cdp = await lease.context.newCDPSession(page);
    const settings = hostBrowserSettings(value);
    const generation = randomUUID();
    const transfers = new HostBrowserTransfers(this.directory, generation, () => { tab.snapshot.downloads = structuredClone(transfers.downloads); this.changed(tab); }, () => tab.snapshot.controller);
    const clipboard = new HostBrowserClipboard(page, cdp);
    const annotations = new HostBrowserAnnotations(cdp);
    const captures = new HostBrowserCaptures(cdp, () => this.stream(tab), () => tab.snapshot.documentId!, () => tab.sequence);
    const tab: Tab = { page, cdp, lease, profile, incognito, transfers, clipboard, captures, annotations, streamQuality: 0, chooserRequest: 0, navigationURL: null, downloadSerial: 0, downloadWaiters: new Set(), uploadingChoosers: new Set(), viewers: new Map(), receipts: new HostBrowserReceipts(), tail: Promise.resolve(), keys: new Map(), buttons: 0, touch: false, touchEnabled: false, streaming: false, closed: false, sequence: 0, lastFrame: 0, metadata: 0, queued: 0,
      snapshot: { taskId, tabId, generation, documentId: randomUUID(), revision: 0, url: page.url(), title: '', loading: false, back: false, forward: false, error: null, settings, controller: null, controlGeneration: 0, dialog: null, popups: [], chooser: null, downloads: [] } };
    page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(15000);
    page.on('close', () => { this.dispose(tab); });
    page.on('crash', () => { tab.annotations.invalidate(); tab.snapshot.error = '主机网页进程已退出，请新建标签或明确重新打开'; this.changed(tab); });
    page.on('dialog', dialog => { tab.dialog = dialog; tab.snapshot.dialog = { id: randomUUID(), type: dialog.type(), message: dialog.message().slice(0, 8192), defaultValue: dialog.defaultValue().slice(0, 8192) }; this.changed(tab); });
    page.on('filechooser', chooser => { void this.offerChooser(tab, chooser); });
    page.on('download', download => { tab.lastDownload = { serial: ++tab.downloadSerial, url: download.url() }; for (const wake of tab.downloadWaiters) wake(); transfers.receive(download); });
    page.on('request', request => { try { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) tab.navigationURL = request.url(); } catch {} });
    page.on('popup', popup => { void this.popup(tab, popup); });
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) { tab.annotations.invalidate(); tab.snapshot.documentId = randomUUID(); tab.chooserRequest++; tab.chooser = undefined; tab.snapshot.chooser = null; tab.snapshot.loading = true; void this.metadata(tab); } });
    page.on('domcontentloaded', () => { void this.metadata(tab); });
    page.on('load', () => { tab.snapshot.loading = false; void this.metadata(tab); });
    cdp.on('Page.screencastFrame', event => {
      if (tab.closed) return;
      if (tab.viewers.size && !captures.paused && (captures.recording || Date.now() - tab.lastFrame >= 30) && event.data.length <= 8 * 1024 * 1024) {
        tab.lastFrame = Date.now();
        const layout = hostBrowserLayout(tab.snapshot.settings);
        const frame: Extract<HostBrowserEvent, { type: 'frame' }> = { type: 'frame', data: event.data, width: layout.width, height: layout.height, sequence: ++tab.sequence };
        for (const viewer of tab.viewers.values()) {
          if (viewer.inFlight) viewer.latest = frame;
          else { viewer.inFlight = frame.sequence; viewer.mailbox.offer(frame); }
        }
      }
      // Pacing bounds renderer work even while a slow viewer drops stale frames.
      const sessionId = event.sessionId;
      const timer = setTimeout(() => { if (!tab.closed) void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); }, captures.recording ? 0 : 75); timer.unref();
    });
    await cdp.send('Page.enable');
    await clipboard.install();
    await this.configure(tab, settings);
    if (url !== null) {
      tab.snapshot.loading = true;
      // A failed or uncertain navigation remains visible; creating/attaching a viewer never retries it.
      try { await this.navigate(tab, url, () => page.goto(url, { waitUntil: 'commit' })); }
      catch { tab.snapshot.error = '主机网页导航未完成；请核对页面后重新操作'; tab.snapshot.loading = false; }
    }
    await this.metadata(tab);
    return tab;
  }
  private async popup(parent: Tab, page: Page) {
    if (parent.closed || this.stopped || this.clearingProfiles.has(parent.profile) || this.deleting.has(parent.snapshot.taskId) || this.tabs.size >= 64) { await page.close().catch(() => {}); return; }
    const { taskId } = parent.snapshot, tabId = randomUUID(), mapKey = key(taskId, tabId);
    let lease: HostBrowserContextLease | undefined;
    const pending = (async () => {
      lease = await this.platform.acquire(parent.profile, parent.incognito, taskId);
      if (lease.context !== page.context() || parent.closed || this.clearingProfiles.has(parent.profile)) throw new HostBrowserError('弹出窗口来源已关闭', 404);
      const tab = await this.adopt(taskId, tabId, parent.profile, parent.incognito, page, lease, null, parent.snapshot.settings as unknown as Record<string, unknown>);
      if (parent.closed || this.stopped) { await this.closeTab(tab); throw new HostBrowserError('弹出窗口已关闭', 404); }
      parent.snapshot.popups = [...parent.snapshot.popups, { tabId, url: page.url(), generation: tab.snapshot.generation }].slice(-16); this.changed(parent); return tab;
    })();
    this.tabs.set(mapKey, pending);
    void pending.catch(async () => { if (this.tabs.get(mapKey) === pending) this.tabs.delete(mapKey); await page.close().catch(() => {}); await lease?.release(); });
  }
  async open(raw: Record<string, unknown>): Promise<HostBrowserSnapshot> {
    if (this.stopped) throw new HostBrowserError('主机浏览器已停止', 503);
    const task = browserID(raw.taskId, '任务'), id = browserID(raw.tabId), profile = browserProfileID(raw.profile ?? 'default');
    if (this.clearingProfiles.has(profile)) { await this.clearingProfiles.get(profile); return this.open(raw); }
    if (raw.incognito !== undefined && typeof raw.incognito !== 'boolean') throw new HostBrowserError('浏览配置无效');
    const url = normalizeBrowserURL(raw.url); hostBrowserSettings(raw);
    if (raw.generation !== undefined) {
      const existing = await this.tab(task, id, raw.generation);
      if (existing.profile !== profile || existing.incognito !== (raw.incognito === true)) throw new HostBrowserError('此标签已使用另一浏览配置', 409);
      return structuredClone(existing.snapshot);
    }
    if (this.deleting.has(task)) throw new HostBrowserError('任务已删除', 404);
    const mapKey = key(task, id); let pending = this.tabs.get(mapKey);
    if (!pending) {
      if (this.tabs.size >= 64 || [...this.tabs.keys()].filter(v => JSON.parse(v)[0] === task).length >= 16) throw new HostBrowserError('主机浏览标签数量已达上限，请关闭未使用的标签', 429);
      pending = this.create(task, id, profile, raw.incognito === true, url, raw); this.tabs.set(mapKey, pending);
      const own = pending; void pending.catch(() => { if (this.tabs.get(mapKey) === own) this.tabs.delete(mapKey); });
    }
    const tab = await pending;
    if (tab.profile !== profile || tab.incognito !== (raw.incognito === true)) throw new HostBrowserError('此标签已使用另一浏览配置', 409);
    if (tab.closed) throw new HostBrowserError('主机标签已关闭，请新建标签', 404);
    return structuredClone(tab.snapshot);
  }
  private async tab(task: unknown, id: unknown, generation: unknown): Promise<Tab> {
    const value = this.tabs.get(key(browserID(task, '任务'), browserID(id)));
    if (!value) throw new HostBrowserError('主机标签已关闭，请重新打开', 404);
    const tab = await value;
    if (tab.closed) throw new HostBrowserError('主机标签已关闭', 404);
    if (tab.snapshot.generation !== generation) throw new HostBrowserError('主机浏览器会话已变化，旧操作不会重放', 409);
    return tab;
  }
  private async configure(tab: Tab, settings: HostBrowserSnapshot['settings']) {
    await tab.page.setViewportSize({ width: settings.width, height: settings.height });
    const layout = hostBrowserLayout(settings);
    await tab.cdp.send('Emulation.setDeviceMetricsOverride', { ...layout, deviceScaleFactor: 2 * settings.zoom, mobile: false });
    await tab.cdp.send('Emulation.setEmulatedMedia', { features: settings.appearance === 'system' ? [] : [{ name: 'prefers-color-scheme', value: settings.appearance }] });
    tab.snapshot.settings = settings; this.changed(tab);
  }
  private async stream(tab: Tab) {
    while (tab.stream) await tab.stream;
    const wanted = tab.viewers.size > 0 && !tab.closed && !tab.captures.paused, quality = tab.captures.recording ? 90 : 75;
    if (wanted === tab.streaming && (!wanted || tab.streamQuality === quality)) return;
    let failed = false;
    const operation = (async () => {
      if (tab.streaming) await tab.cdp.send('Page.stopScreencast');
      if (wanted) await tab.cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth: 3840, maxHeight: 2160, everyNthFrame: 1 });
      tab.streaming = wanted; tab.streamQuality = wanted ? quality : 0;
    })().catch(() => { failed = true; tab.snapshot.error = '主机网页画面传输已停止，请重新连接'; this.changed(tab); });
    tab.stream = operation; await operation; if (tab.stream === operation) tab.stream = undefined;
    if (!failed && !tab.closed && ((tab.viewers.size > 0 && !tab.captures.paused) !== tab.streaming || tab.streaming && tab.streamQuality !== (tab.captures.recording ? 90 : 75))) await this.stream(tab);
  }
  async attach(task: unknown, id: unknown, generation: unknown, viewerId: unknown, device: string) {
    const tab = await this.tab(task, id, generation), viewer = browserID(viewerId, '查看者');
    if (tab.viewers.has(viewer)) throw new HostBrowserError('此查看连接仍在使用', 409);
    if (tab.viewers.size >= 8) throw new HostBrowserError('此标签的查看连接过多', 429);
    const mailbox = new HostBrowserMailbox(); tab.viewers.set(viewer, { id: viewer, device, mailbox, inFlight: 0 });
    if (!tab.snapshot.controller) { tab.snapshot.controller = viewer; tab.snapshot.controlGeneration++; this.reofferChooser(tab); }
    mailbox.offer({ type: 'state', state: structuredClone(tab.snapshot) }); this.changed(tab); void this.stream(tab);
    let detached = false;
    return { mailbox, detach: async () => {
      if (detached) return; detached = true; mailbox.close(); tab.viewers.delete(viewer);
      tab.annotations.invalidate(viewer, device);
      await tab.captures.detach(viewer, device);
      if (tab.snapshot.controller === viewer) { tab.snapshot.controller = null; tab.snapshot.controlGeneration++; this.reofferChooser(tab); await this.releaseInputs(tab); this.changed(tab); }
      void this.stream(tab);
    } };
  }
  async ackFrame(raw: Record<string, unknown>, device: string) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = tab.viewers.get(browserID(raw.viewer, '查看者'));
    if (!viewer || viewer.device !== device) throw new HostBrowserError('查看连接已变化', 409);
    if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 || (raw.sequence as number) > viewer.inFlight) throw new HostBrowserError('画面确认无效', 409);
    if (raw.sequence === viewer.inFlight) {
      viewer.inFlight = 0;
      if (viewer.latest) { const frame = viewer.latest; viewer.latest = undefined; viewer.inFlight = frame.sequence; viewer.mailbox.offer(frame); }
    }
    return { ok: true, inputs: await tab.captures.inputs(viewer.id, device) };
  }
  async capture(raw: Record<string, unknown>, device: string) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = browserID(raw.viewer, '查看者');
    if (tab.viewers.get(viewer)?.device !== device) throw new HostBrowserError('查看连接已变化，请重新连接', 409);
    const document = browserID(raw.document, '网页');
    const data = await tab.captures.screenshot(document);
    return { data, sequence: tab.sequence, document };
  }
  async recording(raw: Record<string, unknown>, device: string) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = browserID(raw.viewer, '查看者');
    if (raw.action === 'stop') await tab.captures.stop(raw.id, viewer, device);
    else if (raw.action === 'start') {
      if (tab.viewers.get(viewer)?.device !== device) throw new HostBrowserError('查看连接已变化，请重新连接', 409);
      const sequence = await tab.captures.start(raw.id, viewer, device, raw.keys);
      if (!tab.captures.paused && (!tab.streaming || tab.streamQuality !== 90)) { await tab.captures.stop(raw.id, viewer, device); throw new HostBrowserError('主机录屏画面不可用，请重新连接', 503); }
      return { ok: true, sequence };
    } else throw new HostBrowserError('录屏操作无效');
    return { ok: true, sequence: tab.sequence };
  }
  async annotation(raw: Record<string, unknown>, device: string) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = browserID(raw.viewer, '查看者'), id = browserID(raw.id, '批注');
    if (raw.action === 'stop') { await tab.annotations.stop(id, viewer, device); return { value: null }; }
    const document = browserID(raw.document, '网页'), control = raw.controlGeneration;
    const current = () => !tab.closed && tab.snapshot.documentId === document && tab.viewers.get(viewer)?.device === device && tab.snapshot.controller === viewer && tab.snapshot.controlGeneration === control;
    if (!current()) throw new HostBrowserError('网页或批注控制权已变化，请重新选择', 409);
    const scope = { id, viewer, device, document, control: control as number, current };
    const value = raw.action === 'start' ? await tab.annotations.start(scope) : await tab.annotations.call(scope, String(raw.action), raw);
    return { value };
  }
  private async offerChooser(tab: Tab, chooser: FileChooser) {
    const request = ++tab.chooserRequest;
    const accept = (await chooser.element().getAttribute('accept').catch(() => null) ?? '').slice(0, 1024);
    if (tab.closed || tab.chooserRequest !== request) return;
    tab.chooser = { id: randomUUID(), multiple: chooser.isMultiple(), accept, offeredTo: null, chooser };
    this.reofferChooser(tab); this.changed(tab);
  }
  private reofferChooser(tab: Tab) {
    const open = tab.chooser;
    if (!open) { tab.snapshot.chooser = null; return; }
    if (open.offeredTo !== tab.snapshot.controller) { open.id = randomUUID(); open.offeredTo = tab.snapshot.controller; }
    tab.snapshot.chooser = { id: open.id, multiple: open.multiple, accept: open.accept, offeredTo: open.offeredTo };
  }
  async upload(raw: Record<string, unknown>, device: string, read: () => Promise<HostUploadFile[]>) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = browserID(raw.viewer, '查看者');
    if (tab.viewers.get(viewer)?.device !== device || tab.snapshot.controller !== viewer || tab.snapshot.controlGeneration !== raw.controlGeneration) throw new HostBrowserError('文件选择的控制权已变化', 409);
    const chooserId = browserID(raw.chooser, '文件选择');
    if (typeof raw.digest !== 'string' || !/^[a-f0-9]{64}$/.test(raw.digest)) throw new HostBrowserError('上传文件摘要无效');
    return tab.receipts.run(viewer, raw.sequence, raw.requestId, ['upload', chooserId, raw.controlGeneration, raw.digest], async () => {
      const current = () => {
        if (tab.closed || tab.viewers.get(viewer)?.device !== device || tab.snapshot.controller !== viewer || tab.snapshot.controlGeneration !== raw.controlGeneration || tab.chooser?.id !== chooserId || tab.chooser.offeredTo !== viewer) throw new HostBrowserError('网页文件选择已变化，请重新选择', 409);
        return tab.chooser;
      };
      const open = current(); if (tab.uploadingChoosers.has(chooserId)) throw new HostBrowserError('正在提交这个文件选择，请等待结果', 409);
      tab.uploadingChoosers.add(chooserId); let reserved = false;
      try {
        while (this.activeUploads >= 2) { await new Promise<void>(resolve => this.uploadWaiters.add(resolve)); current(); }
        current(); this.activeUploads++; reserved = true;
        const files = await read(); validateHostUploads(files, open.multiple, raw.digest); current();
        tab.chooser = undefined; tab.snapshot.chooser = null; this.changed(tab);
        if (files.length) {
          try { await open.chooser.setFiles(files); }
          catch { tab.snapshot.error = '文件提交结果尚未确认，请核对网页后重新选择；不会自动重发'; this.changed(tab); throw new HostBrowserError(tab.snapshot.error, 409); }
        }
        return structuredClone(tab.snapshot);
      } finally { tab.uploadingChoosers.delete(chooserId); if (reserved) this.activeUploads--; for (const wake of this.uploadWaiters) wake(); this.uploadWaiters.clear(); }
    });
  }
  async download(raw: Record<string, unknown>) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation);
    return tab.transfers.open(browserID(raw.id, '下载'));
  }
  async command(raw: Record<string, unknown>, device: string) {
    const tab = await this.tab(raw.taskId, raw.tabId, raw.generation), viewer = browserID(raw.viewer, '查看者'), active = tab.viewers.get(viewer);
    if (!active || active.device !== device) throw new HostBrowserError('查看连接已变化，请重新连接', 409);
    const action = hostBrowserAction(raw.action);
    return tab.receipts.run(viewer, raw.sequence, raw.requestId, [raw.controlGeneration, action], async () => {
      if (action.type === 'claim') { tab.annotations.invalidate(); tab.snapshot.controller = viewer; tab.snapshot.controlGeneration++; this.reofferChooser(tab); await this.releaseInputs(tab); this.changed(tab); return structuredClone(tab.snapshot); }
      const operate = () => {
        if (tab.closed || !tab.viewers.has(viewer) || tab.snapshot.controller !== viewer || tab.snapshot.controlGeneration !== raw.controlGeneration) throw new HostBrowserError('浏览器控制权已变化，旧输入不会执行', 409);
      };
      operate();
      // Dialog replies and releasing control must unblock a navigation already waiting in the action queue.
      if (action.type === 'dialog') {
        if (!tab.dialog || tab.snapshot.dialog?.id !== action.id) throw new HostBrowserError('网页对话框已变化', 409);
        const dialog = tab.dialog; tab.dialog = undefined; tab.snapshot.dialog = null;
        if (action.accept) await dialog.accept(action.text); else await dialog.dismiss();
        this.changed(tab); return structuredClone(tab.snapshot);
      }
      if (action.type === 'release') { tab.annotations.invalidate(); tab.snapshot.controller = null; tab.snapshot.controlGeneration++; this.reofferChooser(tab); await this.releaseInputs(tab); this.changed(tab); return structuredClone(tab.snapshot); }
      if (action.type === 'stop') { await tab.cdp.send('Page.stopLoading'); tab.snapshot.loading = false; this.changed(tab); return structuredClone(tab.snapshot); }
      if (tab.queued >= 128) throw new HostBrowserError('网页输入过多，请等待页面响应', 429);
      tab.queued++;
      const pending = tab.tail.catch(() => {}).then(async () => {
        operate(); tab.snapshot.error = null;
        let copied: string | undefined;
        try { copied = await this.perform(tab, action); if (['navigate', 'back', 'forward', 'reload', 'stop'].includes(action.type)) await this.metadata(tab); }
        catch { tab.snapshot.error = '操作结果尚未确认，请检查页面后再操作；不会自动重发'; this.changed(tab); throw new HostBrowserError(tab.snapshot.error, 409); }
        const result = structuredClone(tab.snapshot);
        if (copied && tab.snapshot.controller === viewer && tab.snapshot.controlGeneration === raw.controlGeneration) {
          result.clipboardText = copied;
          const timer = setTimeout(() => { delete result.clipboardText; }, 5000); timer.unref();
        }
        return result;
      }).finally(() => { tab.queued--; });
      tab.tail = pending; return pending;
    });
  }
  private async perform(tab: Tab, action: HostBrowserAction): Promise<string | undefined> {
    if (action.type === 'navigate') await this.navigate(tab, action.url, () => tab.page.goto(action.url, { waitUntil: 'commit' }));
    else if (action.type === 'back') await this.navigate(tab, tab.page.url(), () => tab.page.goBack({ waitUntil: 'commit' }));
    else if (action.type === 'forward') await this.navigate(tab, tab.page.url(), () => tab.page.goForward({ waitUntil: 'commit' }));
    else if (action.type === 'reload') await this.navigate(tab, tab.page.url(), () => tab.page.reload({ waitUntil: 'commit' }));
    else if (action.type === 'stop') { await tab.cdp.send('Page.stopLoading'); tab.snapshot.loading = false; }
    else if (action.type === 'settings') { await this.configure(tab, action.value); }
    else if (action.type === 'text') await tab.cdp.send('Input.insertText', { text: action.text });
    else if (action.type === 'edit') {
      const key = action.command === 'copy' ? 'c' : action.command === 'cut' ? 'x' : action.command === 'selectAll' ? 'a' : 'z';
      const modifiers = action.command === 'redo' ? 12 : 4;
      const copied = await this.perform(tab, { type: 'key', phase: 'down', key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0), modifiers, repeat: false });
      await this.perform(tab, { type: 'key', phase: 'up', key, code: 'Key' + key.toUpperCase(), keyCode: key.toUpperCase().charCodeAt(0), modifiers, repeat: false }); return copied;
    }
    else if (action.type === 'pointer') {
      if (tab.touchEnabled) { await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false }); tab.touchEnabled = false; }
      tab.buttons = action.buttons;
      const layout = hostBrowserLayout(tab.snapshot.settings);
      await tab.cdp.send('Input.dispatchMouseEvent', { type: action.phase === 'down' ? 'mousePressed' : action.phase === 'up' ? 'mouseReleased' : 'mouseMoved', x: Math.max(0, Math.min(layout.width, action.x)), y: Math.max(0, Math.min(layout.height, action.y)), button: action.button, buttons: action.buttons, clickCount: action.clicks, modifiers: action.modifiers });
    } else if (action.type === 'touch') {
      if (!tab.touchEnabled) { await tab.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }); tab.touchEnabled = true; }
      tab.touch = action.phase === 'start' || action.phase === 'move';
      const layout = hostBrowserLayout(tab.snapshot.settings);
      await tab.cdp.send('Input.dispatchTouchEvent', { type: action.phase === 'start' ? 'touchStart' : action.phase === 'move' ? 'touchMove' : action.phase === 'end' ? 'touchEnd' : 'touchCancel', touchPoints: tab.touch ? [{ x: Math.max(0, Math.min(layout.width, action.x)), y: Math.max(0, Math.min(layout.height, action.y)), id: 0 }] : [] });
    } else if (action.type === 'wheel') await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: action.x, y: action.y, deltaX: action.dx, deltaY: action.dy, modifiers: action.modifiers });
    else if (action.type === 'key') {
      const command = action.phase === 'down' ? hostEditingCommand(action.key, action.modifiers) : null;
      const copying = command === 'copy' || command === 'cut'; if (copying) await tab.clipboard.take();
      if (action.phase === 'down') tab.keys.set(action.code, action); else tab.keys.delete(action.code);
      await tab.cdp.send('Input.dispatchKeyEvent', { type: action.phase === 'down' ? 'rawKeyDown' : 'keyUp', key: action.key, code: action.code, modifiers: action.modifiers, windowsVirtualKeyCode: action.keyCode, autoRepeat: action.repeat, ...(command ? { commands: [command] } : {}) });
      if (copying) return tab.clipboard.take();
    }
    return undefined;
  }
  private async navigate(tab: Tab, url: string, action: () => Promise<unknown>) {
    const serial = tab.downloadSerial; tab.navigationURL = url; tab.snapshot.loading = true; this.changed(tab);
    try { await action(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('net::ERR_ABORTED')) throw error;
      const matches = () => tab.lastDownload !== undefined && tab.lastDownload.serial > serial && [url, tab.navigationURL].includes(tab.lastDownload.url);
      if (!matches() && !tab.closed) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); tab.downloadWaiters.delete(wake); resolve(); };
        const wake = () => { if (matches() || tab.closed) finish(); };
        const timer = setTimeout(finish, 5000); timer.unref(); tab.downloadWaiters.add(wake);
      });
      if (!matches()) throw error;
      tab.snapshot.loading = false; this.changed(tab);
    }
  }
  private async releaseInputs(tab: Tab) {
    const keys = [...tab.keys.values()]; tab.keys.clear(); const buttons = tab.buttons; tab.buttons = 0;
    if (tab.touch) { tab.touch = false; await tab.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }).catch(() => {}); }
    await Promise.allSettled(keys.map(key => tab.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: key.key, code: key.code, modifiers: 0, windowsVirtualKeyCode: key.keyCode })));
    for (const [mask, button] of [[1, 'left'], [2, 'right'], [4, 'middle']] as const) if (buttons & mask) await tab.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button, buttons: 0 }).catch(() => {});
  }
  private dispose(tab: Tab) {
    if (tab.closed) return; tab.closed = true;
    for (const wake of this.uploadWaiters) wake(); this.uploadWaiters.clear();
    for (const wake of tab.downloadWaiters) wake(); tab.downloadWaiters.clear();
    tab.clipboard.close();
    const annotationCleanup = tab.annotations.close(); this.cleanups.add(annotationCleanup); void annotationCleanup.finally(() => this.cleanups.delete(annotationCleanup)).catch(() => {});
    const captureCleanup = tab.captures.close(); this.cleanups.add(captureCleanup); void captureCleanup.finally(() => this.cleanups.delete(captureCleanup)).catch(() => {});
    const cleanup = tab.transfers.close(); this.cleanups.add(cleanup); void cleanup.finally(() => { this.cleanups.delete(cleanup); }).catch(() => {});
    for (const viewer of tab.viewers.values()) viewer.mailbox.close(); tab.viewers.clear();
    this.tabs.delete(key(tab.snapshot.taskId, tab.snapshot.tabId)); void tab.lease.release();
  }
  private async closeTab(tab: Tab) { if (!tab.closed) { this.dispose(tab); await tab.dialog?.dismiss().catch(() => {}); await tab.page.close().catch(() => {}); await tab.lease.release(); } }
  async closeTabRequest(task: unknown, id: unknown, generation: unknown) { await this.closeTab(await this.tab(task, id, generation)); return { ok: true }; }
  async clearProfile(value: unknown) {
    const profile = browserProfileID(value); if (profile === 'incognito') return { ok: true };
    if (!this.platform.clearProfile) throw new HostBrowserError('主机不支持清理浏览配置', 503);
    const previous = this.clearingProfiles.get(profile); if (previous) { await previous; return { ok: true }; }
    const clearing = (async () => {
      const selected = (await Promise.allSettled([...this.tabs.values()])).flatMap(value => value.status === 'fulfilled' ? [value.value] : []);
      await this.platform.clearProfile!(profile);
      await Promise.all(selected.filter(tab => tab.profile === profile && !tab.incognito).map(tab => this.closeTab(tab)));
    })();
    this.clearingProfiles.set(profile, clearing);
    try { await clearing; return { ok: true }; } finally { if (this.clearingProfiles.get(profile) === clearing) this.clearingProfiles.delete(profile); }
  }
  async deleteTask(task: string) {
    this.deleting.add(task);
    await Promise.allSettled([...this.tabs.entries()].filter(([k]) => JSON.parse(k)[0] === task).map(async ([, value]) => this.closeTab(await value)));
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([...this.tabs.values()].map(async pending => this.closeTab(await pending)));
    await this.platform.close(); this.tabs.clear();
    await Promise.allSettled(this.cleanups);
    await Promise.allSettled(this.clearingProfiles.values());
  }
}
