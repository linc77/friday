import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Download } from 'playwright-core';
import { HostBrowserError } from './task-host-browser-protocol.js';
import { privateBrowserDirectory } from './task-host-browser-chrome.js';
import type { OpenTaskMedia } from './task-media.js';

export const hostUploadMaxBytes = 100 * 1024 * 1024;
export const hostUploadMaxFiles = 20;
export const hostDownloadMaxBytes = 1024 * 1024 * 1024;
export const hostDownloadLimit = 20;
export interface HostUploadFile { name: string; mimeType: string; buffer: Buffer }
export interface HostDownload { id: string; fileName: string; sizeBytes: number; status: 'receiving' | 'ready' | 'failed'; completedAt: string | null; error: string | null; offeredTo: string | null }
export function hostTransferName(value: string): string {
  const last = value.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const clean = last.replace(/[\x00-\x1f\x7f]/g, '').trim();
  return !clean || clean === '.' || clean === '..' ? 'download' : [...clean].reduce((value, c) => Buffer.byteLength(value + c) <= 240 ? value + c : value, '');
}
export function hostUploadManifest(files: readonly HostUploadFile[]): string {
  return createHash('sha256').update(JSON.stringify(files.map(file => [Buffer.from(file.name).toString('base64'), Buffer.from(file.mimeType).toString('base64'), file.buffer.length, createHash('sha256').update(file.buffer).digest('hex')]))).digest('hex');
}
export function validateHostUploads(files: readonly HostUploadFile[], multiple: boolean, digest: unknown): void {
  if (files.length > hostUploadMaxFiles || !multiple && files.length > 1) throw new HostBrowserError('所选文件数量超过网页允许的范围');
  let bytes = 0;
  for (const file of files) {
    if (!file.name || file.name !== hostTransferName(file.name) || file.name.includes('/') || file.name.includes('\\') || typeof file.mimeType !== 'string' || file.mimeType.length > 255 || /[\x00-\x1f\x7f]/.test(file.mimeType) || !Buffer.isBuffer(file.buffer)) throw new HostBrowserError('上传文件信息无效');
    bytes += file.buffer.length; if (bytes > hostUploadMaxBytes) throw new HostBrowserError('上传文件合计不能超过 100 MiB');
  }
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || hostUploadManifest(files) !== digest) throw new HostBrowserError('上传文件内容与请求不一致');
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('Download cancelled'));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(new Error('Download cancelled')); }; signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
/** Private task-tab cache. Only checked descriptors, never client-supplied paths, leave this class. */
export class HostBrowserTransfers {
  readonly downloads: HostDownload[] = [];
  private live = new Map<string, { abort: AbortController; download: Download; done: Promise<void> }>();
  private files = new Map<string, { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }>();
  private closed = false;
  private directory?: Promise<string>;
  constructor(private readonly root: string, private readonly generation: string, private readonly changed: () => void, private readonly controller: () => string | null, private readonly limitBytes = hostDownloadMaxBytes) {}
  private folder() {
    if (!this.directory) this.directory = (async () => {
      const browser = await privateBrowserDirectory(join(this.root, 'browser'));
      const parent = await privateBrowserDirectory(join(browser, 'transfers'));
      return privateBrowserDirectory(join(parent, this.generation));
    })();
    return this.directory;
  }
  receive(download: Download) {
    if (this.closed) { void download.cancel().catch(() => {}); return; }
    const item: HostDownload = { id: randomUUID(), fileName: hostTransferName(download.suggestedFilename()), sizeBytes: 0, status: 'receiving', completedAt: null, error: null, offeredTo: null };
    this.downloads.push(item); this.changed();
    const abort = new AbortController();
    const done = this.save(item, download, abort.signal).finally(() => { this.live.delete(item.id); });
    this.live.set(item.id, { abort, download, done });
  }
  private async save(item: HostDownload, download: Download, signal: AbortSignal) {
    let path: string | undefined, handle: FileHandle | undefined;
    try {
      const folder = await this.folder(); if (this.closed || signal.aborted) throw new Error('closed');
      path = join(folder, item.id); handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const source = await abortable(download.createReadStream(), signal); let lastProgress = 0;
      const limiter = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
        item.sizeBytes += chunk.length;
        if (item.sizeBytes > this.limitBytes) { callback(new Error('下载文件超过 1 GiB')); return; }
        if (Date.now() - lastProgress >= 200) { lastProgress = Date.now(); this.changed(); }
        callback(null, chunk);
      } });
      const destination = handle;
      const output = new Writable({ write(chunk: Buffer, _encoding, callback) { void destination.writeFile(chunk).then(() => callback(), callback); } });
      await pipeline(source, limiter, output, { signal });
      await handle.sync(); const info = await handle.stat(); await handle.close(); handle = undefined;
      if (this.closed || signal.aborted || !info.isFile() || info.size !== item.sizeBytes) throw new Error('closed');
      this.files.set(item.id, { path, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
      item.status = 'ready'; item.completedAt = new Date().toISOString(); item.offeredTo = this.controller();
    } catch (error) {
      item.status = 'failed'; item.error = error instanceof Error && error.message === '下载文件超过 1 GiB' ? error.message : '主机网页下载未完成';
      void download.cancel().catch(() => {}); await handle?.close().catch(() => {}); if (path) await rm(path, { force: true }).catch(() => {});
    } finally {
      if (item.status !== 'receiving') { const index = this.downloads.indexOf(item); if (index >= 0) { this.downloads.splice(index, 1); this.downloads.push(item); } }
      const ready = this.downloads.filter(item => item.status === 'ready'), failed = this.downloads.filter(item => item.status === 'failed');
      for (const old of [...ready.slice(0, Math.max(0, ready.length - hostDownloadLimit)), ...failed.slice(0, Math.max(0, failed.length - hostDownloadLimit))]) {
        const file = this.files.get(old.id); this.files.delete(old.id); this.downloads.splice(this.downloads.indexOf(old), 1);
        if (file) await rm(file.path, { force: true }).catch(() => {});
      }
      this.changed();
    }
  }
  async open(id: string): Promise<OpenTaskMedia> {
    const file = this.files.get(id), item = this.downloads.find(item => item.id === id && item.status === 'ready');
    if (this.closed || !file || !item) throw new HostBrowserError('下载文件不存在或尚未完成', 404);
    const directory = await this.folder(), folder = await lstat(directory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new HostBrowserError('下载目录已变化', 409);
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(); if (!info.isFile() || info.dev !== file.dev || info.ino !== file.ino || info.size !== file.size || info.mtimeMs !== file.mtimeMs || info.ctimeMs !== file.ctimeMs) throw new HostBrowserError('下载文件已变化', 409);
      return { handle, info, name: item.fileName, mimeType: 'application/octet-stream' };
    } catch (error) { await handle.close(); throw error; }
  }
  async close() {
    if (this.closed) return; this.closed = true;
    const operations = [...this.live.values()];
    for (const operation of operations) { operation.abort.abort(); void operation.download.cancel().catch(() => {}); }
    await Promise.allSettled(operations.map(operation => operation.done));
    const directory = await this.directory?.catch(() => undefined); if (directory) await rm(directory, { recursive: true, force: true });
    this.files.clear(); this.downloads.splice(0);
  }
}

/** Read only after authentication, current viewer and chooser checks have reserved the operation. */
export async function hostUploadFiles(request: Request, maxBodyBytes = hostUploadMaxBytes + 256 * 1024): Promise<HostUploadFile[]> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!/^multipart\/form-data;/i.test(type)) throw new HostBrowserError('上传需要使用 multipart/form-data');
  if (!request.body) throw new HostBrowserError('上传请求为空');
  const declared = request.headers.get('Content-Length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBodyBytes)) throw new HostBrowserError('上传文件合计不能超过 100 MiB');
  let bytes = 0; const reader = request.body.getReader();
  const bounded = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read(); if (chunk.done) { controller.close(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > maxBodyBytes) { await reader.cancel(); throw new HostBrowserError('上传文件合计不能超过 100 MiB'); }
        controller.enqueue(chunk.value);
      } catch (error) { controller.error(error); }
    }, cancel: () => reader.cancel(),
  });
  const form = await new Response(bounded, { headers: { 'Content-Type': type } }).formData();
  const files: File[] = []; let total = 0;
  for (const [name, value] of form) {
    if (name !== 'files' || !(value instanceof File)) throw new HostBrowserError('上传请求包含无效字段');
    files.push(value); total += value.size;
    if (files.length > hostUploadMaxFiles || total > hostUploadMaxBytes) throw new HostBrowserError('最多上传 20 个文件，合计不超过 100 MiB');
  }
  return Promise.all(files.map(async file => ({ name: file.name, mimeType: file.type || 'application/octet-stream', buffer: Buffer.from(await file.arrayBuffer()) })));
}
