import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, lstat, realpath, chmod, readdir, stat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';
import { workspaceCommand } from './git-process.js';

// Managed-tool archive boundaries follow T3 8cd9641f AcpRegistrySupport and
// AntigravityInstallation. MIT Copyright (c) 2026 T3 Tools Inc.; vendor/t3code/LICENSE.
export function nativeToolHTTPS(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || value.length > 2048) throw new Error('工具下载地址需要使用不含账号的 HTTPS 地址');
  return url;
}
export function nativeToolPath(name: string) {
  const clean = name.replace(/^\.\//, '').replace(/\/$/, ''), parts = clean.split('/');
  if (!clean || /[\\:\x00-\x1f\x7f]/.test(clean) || isAbsolute(clean) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('工具归档包含无效路径');
  return parts;
}
export async function nativeToolDownload(url: string, destination: string, options: { sha256?: string; expectedBytes?: number; maximumBytes?: number; signal: AbortSignal; progress?: (bytes: number, total: number | null) => void; fetch?: typeof fetch }) {
  let target = nativeToolHTTPS(url), response: Response | undefined;
  for (let index = 0; index < 6; index++) {
    response = await (options.fetch ?? fetch)(target, { redirect: 'manual', signal: options.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('Location'); await response.body?.cancel(); if (!location || index === 5) throw new Error('工具下载重定向无效'); target = nativeToolHTTPS(new URL(location, target).href);
  }
  if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error('工具下载失败'); }
  const maximum = options.maximumBytes ?? 1024 * 1024 * 1024, length = Number(response.headers.get('Content-Length')), total = length > 0 && Number.isSafeInteger(length) ? length : null;
  if (total !== null && total > maximum) { await response.body.cancel(); throw new Error('工具归档超过下载预算'); }
  const hash = createHash('sha256'); let bytes = 0;
  await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > maximum) { callback(new Error('工具归档超过下载预算')); return; } hash.update(chunk); options.progress?.(bytes, total); callback(null, chunk); } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
  const digest = hash.digest('hex'); if (options.expectedBytes !== undefined && bytes !== options.expectedBytes || options.sha256 && digest !== options.sha256.toLowerCase()) throw new Error('工具归档的大小或 SHA-256 校验不匹配');
  return { bytes, sha256: digest };
}
async function zipArchive(archive: string, directory: string, signal: AbortSignal) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, value) => error || !value ? reject(new Error('无法读取工具 ZIP 归档')) : resolve(value)));
  let failure: Error | undefined; zip.on('error', error => { failure ??= error; });
  try {
    if (zip.entryCount > 10000) throw new Error('工具归档条目超过预算'); let total = 0;
    for (;;) {
      signal.throwIfAborted(); if (failure) throw failure;
      const entry = await new Promise<yauzl.Entry | undefined>((resolve, reject) => {
        const cleanup = () => { zip.removeListener('entry', found); zip.removeListener('end', ended); zip.removeListener('error', failed); };
        const found = (entry: yauzl.Entry) => { cleanup(); resolve(entry); }, ended = () => { cleanup(); resolve(undefined); }, failed = (error: Error) => { cleanup(); reject(error); };
        zip.once('entry', found); zip.once('end', ended); zip.once('error', failed); zip.readEntry();
      }); if (!entry) break;
      if (entry.fileName === './' || entry.fileName === '.') continue;
      const parts = nativeToolPath(entry.fileName), mode = entry.externalFileAttributes >>> 16, type = mode & 0o170000;
      if (type && type !== 0o100000 && type !== 0o040000) throw new Error('工具 ZIP 包含非普通文件');
      const target = join(directory, ...parts); if (entry.fileName.endsWith('/')) { await mkdir(target, { recursive: true, mode: 0o700 }); continue; }
      total += entry.uncompressedSize; if (!Number.isSafeInteger(total) || total > 4 * 1024 * 1024 * 1024) throw new Error('工具归档展开超过预算');
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      const stream = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, value) => error || !value ? reject(new Error('无法读取工具归档文件')) : resolve(value)));
      await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: mode & 0o111 ? 0o755 : 0o600 }), { signal });
    }
  } finally { zip.close(); }
}
export async function extractNativeToolArchive(archive: string, directory: string, sourceURL: string, signal: AbortSignal) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error('工具暂存目录需要为空');
  if (new URL(sourceURL).pathname.toLowerCase().endsWith('.zip')) { await zipArchive(archive, directory, signal); return; }
  const listing = await workspaceCommand(directory, 'tar', ['-tf', archive], { timeout: 30000, limit: 16 * 1024 * 1024, signal });
  if (listing.code !== 0 || listing.stdoutTruncated) throw new Error('无法读取工具 tar 归档');
  const names = listing.stdout.split('\n').filter(Boolean); if (names.length > 10000) throw new Error('工具归档条目超过预算'); for (const name of names) if (name !== './' && name !== '.') nativeToolPath(name);
  const details = await workspaceCommand(directory, 'tar', ['-tvf', archive], { timeout: 30000, limit: 16 * 1024 * 1024, signal });
  if (details.code !== 0 || details.stdoutTruncated || details.stdout.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0]!))) throw new Error('工具 tar 包含链接或特殊文件');
  const result = await workspaceCommand(directory, 'tar', ['-xf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions'], { timeout: 120000, limit: 1024 * 1024, signal });
  if (result.code !== 0) throw new Error('无法展开工具 tar 归档');
}
export async function nativeToolExecutable(root: string, command: string, makeExecutable = true) {
  const candidate = join(root, ...nativeToolPath(command)), info = await lstat(candidate), canonical = await realpath(candidate), base = await realpath(root), path = relative(base, canonical);
  if (!(info.isSymbolicLink() ? await stat(canonical) : info).isFile() || path === '..' || path.startsWith('..' + '/') || isAbsolute(path)) throw new Error('托管工具没有返回目录内的普通可执行文件');
  if (makeExecutable) await chmod(candidate, 0o755); return candidate;
}
