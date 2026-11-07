import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { OpenTaskMedia } from './task-media.js';
import type { TaskContextReference } from './task-context-types.js';

// Fixed T3 chatAttachment.ts: ordinary files remain path-only in provider input.
export const maxTaskFileBytes = 50 * 1024 * 1024;
export const maxTaskAttachments = 100;
export function taskAttachmentName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value) || ['.', '..'].includes(value)) throw new Error('附件文件名无效');
  return value;
}
export function taskAttachmentMediaType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) throw new Error('附件文件类型无效');
  return value.toLowerCase();
}
export class TaskAttachmentFiles {
  constructor(private readonly directory: string) {}
  private root() { return join(this.directory, 'task-attachments'); }
  private path(digest: string, name: string) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('附件内容标识无效');
    const extension = extname(taskAttachmentName(name));
    return join(this.root(), digest + (/^\.[a-z0-9_-]{1,20}$/i.test(extension) ? extension.toLowerCase() : ''));
  }
  async save(data: Buffer, name: string, mediaType: string) {
    taskAttachmentName(name); taskAttachmentMediaType(mediaType);
    if (!data.length || data.length > maxTaskFileBytes) throw new Error('附件不能为空，且不能超过 50 MB');
    const digest = createHash('sha256').update(data).digest('hex'), path = this.path(digest, name);
    await mkdir(this.root(), { recursive: true, mode: 0o700 });
    // Publish a complete file atomically. Concurrent uploads of identical bytes
    // cannot acknowledge another writer's partially written destination.
    const temporary = join(this.root(), '.upload-' + randomUUID());
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await link(temporary, path).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const file = await this.open({ kind: 'attachment', digest, attachmentName: name, mediaType, byteLength: data.length });
      try {
        const saved = await file.handle.readFile();
        if (createHash('sha256').update(saved).digest('hex') !== digest) throw new Error('已保存的附件内容已改变，请重新添加');
      } finally { await file.handle.close(); }
    } finally { await unlink(temporary).catch(() => {}); }
    return { digest, path, byteLength: data.length };
  }
  async open(reference: Pick<TaskContextReference, 'kind' | 'digest' | 'byteLength' | 'attachmentName' | 'mediaType'>): Promise<OpenTaskMedia> {
    if (reference.kind !== 'attachment' || !reference.attachmentName || !reference.mediaType) throw new Error('这个引用不是文件附件');
    const path = this.path(reference.digest, reference.attachmentName), root = await realpath(this.root());
    if (await realpath(path) !== join(root, basename(path))) throw new Error('附件保存路径已改变');
    const before = await lstat(path), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!before.isFile() || !info.isFile() || before.ino !== info.ino || before.dev !== info.dev || info.size !== reference.byteLength || info.size < 1 || info.size > maxTaskFileBytes) throw new Error('附件内容已改变，请重新添加');
      return { handle, info, name: reference.attachmentName, mimeType: taskAttachmentMediaType(reference.mediaType) };
    } catch (error) { await handle.close(); throw error; }
  }
}
