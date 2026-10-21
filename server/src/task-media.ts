import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { privateWorkspacePaths, type WorkspacePrivacy } from './workspace-privacy.js';
import { taskFileMimeType } from './task-file-preview.js';

// T3code shared/filePreview.ts image types. A host path is resolved on the
// service, never interpreted as a file on a paired client's computer.
const imageTypes: Record<string, string> = {
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp',
};
export type OpenTaskMedia = { handle: FileHandle; info: Stats; mimeType: string; name: string };

export async function openTaskMedia(path: unknown, cwd: string, privacy: WorkspacePrivacy, kind: 'image' | 'media' = 'image'): Promise<OpenTaskMedia> {
  const label = kind === 'media' ? '媒体' : '图片';
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('~')) throw new Error(`${label}文件路径无效`);
  const requested = isAbsolute(path) ? resolve(path) : resolve(await realpath(cwd), path);
  let target: string;
  try { target = await realpath(requested); } catch { throw new Error(`${label}文件不存在或无法读取`); }
  if ([target, requested].some(path => path.split(sep).some(part => part.toLowerCase() === '.git'))) throw new Error('不能读取 Git 内部数据');
  if ((await privateWorkspacePaths(dirname(target), privacy)).includes('') || (await privateWorkspacePaths(dirname(requested), privacy)).includes('')) throw new Error('不能读取 Friday 的私有运行数据');
  const mimeType = kind === 'image' ? imageTypes[extname(target).toLowerCase()] : /^(?:image|audio|video)\//.test(taskFileMimeType(target)) ? taskFileMimeType(target) : undefined;
  if (!mimeType) throw new Error(`这个文件不是支持的${label}类型`);
  const before = await lstat(target);
  if (!before.isFile()) throw new Error(`请选择普通${label}文件`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat(), current = await lstat(target);
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0 || info.ino !== before.ino || info.dev !== before.dev || current.ino !== info.ino || current.dev !== info.dev || await realpath(requested) !== target || await realpath(target) !== target) throw new Error(`${label}文件路径已改变，请重新加载`);
    return { handle, info, mimeType, name: basename(target) };
  } catch (error) { await handle.close(); throw error; }
}

function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (header === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) return null;
  const first = match[1] ? Number(match[1]) : undefined, last = match[2] ? Number(match[2]) : undefined;
  if (first !== undefined && (!Number.isSafeInteger(first) || first >= size) || last !== undefined && !Number.isSafeInteger(last)) return null;
  if (first === undefined) return last! > 0 ? { start: Math.max(0, size - last!), end: size - 1 } : null;
  if (last !== undefined && last < first) return null;
  return { start: first, end: Math.min(size - 1, last ?? size - 1) };
}

/** Keep the checked descriptor for the response, including ranges and aborts. */
export async function taskMediaResponse(file: OpenTaskMedia, request: { method: string; range?: string; ifNoneMatch?: string; signal?: AbortSignal; contentSecurityPolicy?: string | null }): Promise<Response> {
  const etag = '"' + createHash('sha256').update([file.info.dev, file.info.ino, file.info.size, file.info.mtimeMs, file.info.ctimeMs].join(':')).digest('hex') + '"';
  const headers = new Headers({ 'Content-Type': file.mimeType === 'text/html' ? 'text/html; charset=utf-8' : file.mimeType, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', ETag: etag,
    'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase()),
    'Content-Security-Policy': "default-src 'none'; sandbox; base-uri 'none'; form-action 'none'" });
  if (request.contentSecurityPolicy === null) headers.delete('Content-Security-Policy');
  else if (request.contentSecurityPolicy !== undefined) headers.set('Content-Security-Policy', request.contentSecurityPolicy);
  if (request.ifNoneMatch?.split(',').some(value => value.trim() === etag || value.trim() === '*')) { await file.handle.close(); return new Response(null, { status: 304, headers }); }
  const range = byteRange(request.range, file.info.size);
  if (!range) { await file.handle.close(); headers.set('Content-Range', 'bytes */' + file.info.size); return new Response(null, { status: 416, headers }); }
  const length = Math.max(0, range.end - range.start + 1); headers.set('Content-Length', String(length));
  if (request.range !== undefined) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.info.size}`);
  const status = request.range === undefined ? 200 : 206;
  if (request.method === 'HEAD' || !length || request.signal?.aborted) { await file.handle.close(); return new Response(null, { status, headers }); }
  let closed = false, position = range.start;
  const close = async () => { if (closed) return; closed = true; request.signal?.removeEventListener('abort', abort); await file.handle.close(); };
  const abort = () => { void close().catch(() => {}); };
  request.signal?.addEventListener('abort', abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) { controller.close(); return; }
      try {
        const buffer = Buffer.alloc(Math.min(64 * 1024, range.end - position + 1));
        const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, position);
        if (!bytesRead) throw new Error('图片文件在读取期间发生变化');
        position += bytesRead; controller.enqueue(buffer.subarray(0, bytesRead));
        if (position > range.end) { controller.close(); await close(); }
      } catch (error) { controller.error(error); await close(); }
    },
    cancel: close,
  });
  return new Response(body, { status, headers });
}
