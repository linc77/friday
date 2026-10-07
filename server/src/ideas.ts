import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { IdeaImage } from './types.js';

export const maxIdeaLength = 100_000;
export const maxImageBytes = 8 * 1024 * 1024;
const imageID = /^[a-f0-9]{64}$/;

function imageType(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString())) return 'image/gif';
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片');
}

export function ideaContent(body: Record<string, unknown>) {
  const title = body.title ?? '';
  const text = body.text ?? '';
  if (typeof title !== 'string' || title.length > 200 || typeof text !== 'string' || text.length > maxIdeaLength) throw new Error('标题最多 200 字，笔记最多 100,000 字');
  if (!title.trim() && !text.trim() && !(Array.isArray(body.images) && body.images.length)) throw new Error('请写下内容或添加图片');
  return { title: title.trim(), text: text.trim() };
}

export class IdeaImages {
  constructor(private directory: string) {}
  private path(id: string) {
    if (!imageID.test(id)) throw new Error('图片 ID 无效');
    return join(this.directory, 'idea-images', id);
  }
  async save(body: Record<string, unknown>): Promise<IdeaImage> {
    if (typeof body.data !== 'string' || !body.data.length || body.data.length > Math.ceil(maxImageBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data)) throw new Error('图片不能为空，且不能超过 8 MB');
    const data = Buffer.from(body.data, 'base64');
    if (data.length > maxImageBytes) throw new Error('图片不能超过 8 MB');
    const mediaType = imageType(data);
    const id = createHash('sha256').update(data).digest('hex');
    if (body.id !== undefined && body.id !== id) throw new Error('图片内容与 ID 不一致');
    const name = typeof body.name === 'string' ? body.name.slice(0, 200) : '图片';
    await mkdir(join(this.directory, 'idea-images'), { recursive: true, mode: 0o700 });
    // Immutable content IDs make a retry safe after a lost upload response.
    await writeFile(this.path(id), data, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    return { id, name, mediaType };
  }
  async read(id: string) {
    const data = await readFile(this.path(id));
    return { data, mediaType: imageType(data) };
  }
  async validate(value: unknown): Promise<IdeaImage[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw new Error('一篇笔记最多添加 20 张图片');
    const images: IdeaImage[] = [];
    for (const image of value) {
      if (!image || typeof image.id !== 'string' || typeof image.name !== 'string' || image.name.length > 200 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mediaType)) throw new Error('图片信息无效');
      await access(this.path(image.id)).catch(() => { throw new Error('图片尚未上传，请重试保存'); });
      if (!images.some(i => i.id === image.id)) images.push({ id: image.id, name: image.name, mediaType: image.mediaType });
    }
    return images;
  }
}
