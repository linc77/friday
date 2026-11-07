import { createHmac, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import type { Auth } from './auth.js';
import type { TaskContextScope } from './task-context-types.js';
import { openTaskMedia, taskMediaResponse } from './task-media.js';

type Claims = { version: 1; scope: TaskContextScope; root: string; base: string; entry: string; exact: boolean; device: string; dev: string; ino: string; expires: number; mediaPath?: string; baseDirectory?: { path: string; dev: string; ino: string } };
const ttl = 60 * 60 * 1000; // T3code AssetAccess: one-hour read capability.
const previewExtensions = new Set(['.htm', '.html', '.pdf', '.avif', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.webp', '.css', '.js', '.mjs', '.otf', '.ttf', '.woff', '.woff2']);
export function fileContentSecurityPolicy(mimeType: string): string | null {
  return mimeType === 'text/html' ? 'sandbox allow-scripts allow-forms allow-popups allow-downloads'
    : mimeType === 'image/svg+xml' ? "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    : mimeType === 'application/octet-stream' ? "default-src 'none'; sandbox" : null;
}
class AssetAccessRejected extends Error {}
export class TaskFileAssets {
  constructor(private readonly engine: Engine, private readonly auth: Auth) {}
  private signature(value: string) { return createHmac('sha256', this.auth.token).update('friday.workspace-files.v1\0' + value).digest(); }
  async issue(device: string, input: { scope: unknown; path: unknown; workspaceRoot?: unknown; kind?: unknown }, now = Date.now()) {
    const owner = await this.engine.contexts.owner(input.scope);
    if (input.workspaceRoot !== undefined && input.workspaceRoot !== owner.cwd) throw new Error('文件所属工作区已改变，请重新打开媒体');
    if (input.kind !== undefined && input.kind !== 'media') throw new Error('文件资源类型无效');
    const hostMedia = input.kind === 'media';
    const file = hostMedia ? await openTaskMedia(input.path, owner.cwd, { directory: this.engine.directory, workspace: owner.task?.executionWorkspace, projectFolder:owner.project?.managedFolder }, 'media') : await owner.files.open(input.path);
    await file.handle.close();
    const exact = /^(?:image|audio|video)\//.test(file.mimeType);
    if (file.mimeType !== 'text/html' && file.mimeType !== 'application/pdf' && !exact) throw new Error('这个文件不能创建页面预览链接');
    const root = await stat(owner.cwd, { bigint: true });
    const path = hostMedia ? resolve(owner.cwd, input.path as string) : (file as Awaited<ReturnType<typeof owner.files.open>>).path;
    const claims: Claims = { version: 1, scope: owner.scope, root: owner.cwd, base: hostMedia ? '.' : dirname(path), entry: basename(path), exact, device, dev: String(root.dev), ino: String(root.ino), expires: now + ttl, ...(hostMedia ? { mediaPath: path } : {}) };
    if (!hostMedia) {
      const base = await realpath(resolve(owner.cwd, claims.base)), info = await stat(base, { bigint: true });
      claims.baseDirectory = { path: base, dev: String(info.dev), ino: String(info.ino) };
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url'), token = payload + '.' + this.signature(payload).toString('base64url');
    return { url: '/file-assets/' + token + '/' + encodeURIComponent(claims.entry), expiresAt: new Date(claims.expires).toISOString(), workspaceRoot: owner.cwd };
  }
  private claims(token: string, now: number): Claims {
    try {
      if (token.length > 16_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
      const [payload, signature] = token.split('.'), decoded = Buffer.from(signature, 'base64url');
      if (decoded.toString('base64url') !== signature || !timingSafeEqual(this.signature(payload), decoded)) throw new Error();
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
      if (claims.version !== 1 || !Number.isSafeInteger(claims.expires) || claims.expires <= now || typeof claims.root !== 'string' || typeof claims.device !== 'string' || typeof claims.base !== 'string' || typeof claims.entry !== 'string' || typeof claims.exact !== 'boolean') throw new Error();
      if (claims.mediaPath !== undefined && (typeof claims.mediaPath !== 'string' || !isAbsolute(claims.mediaPath) || claims.exact !== true || basename(claims.mediaPath) !== claims.entry)) throw new Error();
      if (claims.baseDirectory !== undefined && (!claims.baseDirectory || !isAbsolute(claims.baseDirectory.path) || typeof claims.baseDirectory.dev !== 'string' || typeof claims.baseDirectory.ino !== 'string')) throw new Error();
      if (isAbsolute(claims.base) && !claims.baseDirectory) throw new Error();
      if (claims.device !== 'owner' && !this.auth.devices().some(device => device.id === claims.device)) throw new Error();
      return claims;
    } catch { throw new AssetAccessRejected('文件资源链接无效或已过期，请刷新预览'); }
  }
  async resource(token: string, path: string, request: { method: string; range?: string; signal?: AbortSignal }, now = Date.now()) {
    const claims = this.claims(token, now);
    let owner: Awaited<ReturnType<Engine['contexts']['owner']>>;
    try {
      owner = await this.engine.contexts.owner(claims.scope); const root = await stat(owner.cwd, { bigint: true });
      if (owner.cwd !== claims.root || String(root.dev) !== claims.dev || String(root.ino) !== claims.ino) throw new Error();
    } catch { throw new AssetAccessRejected('文件所属工作区已改变，请刷新预览'); }
    if (claims.exact ? path !== claims.entry : !path || path.includes('\0') || path.split(/[\\/]/).some(segment => !segment || segment === '.' || segment === '..' || segment.startsWith('.')) || !previewExtensions.has(extname(path).toLowerCase())) throw new Error('该资源不在页面预览范围内');
    if (claims.baseDirectory) {
      const directory = await realpath(resolve(owner.cwd, claims.base)), info = await stat(directory, { bigint: true });
      if (directory !== claims.baseDirectory.path || String(info.dev) !== claims.baseDirectory.dev || String(info.ino) !== claims.baseDirectory.ino) throw new AssetAccessRejected('文件预览目录已改变，请刷新预览');
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    const file = claims.mediaPath !== undefined
      ? await openTaskMedia(claims.mediaPath, owner.cwd, { directory: this.engine.directory, workspace: owner.task?.executionWorkspace, projectFolder:owner.project?.managedFolder }, 'media')
      : await owner.files.open(claims.base === '.' ? path : join(claims.base, path));
    if (!claims.exact && path !== claims.entry && claims.baseDirectory) {
      const remaining = 'target' in file && typeof file.target === 'string' ? relative(claims.baseDirectory.path, file.target) : '..';
      if (isAbsolute(remaining) || remaining === '..' || remaining.startsWith('..' + sep)) { await file.handle.close(); throw new Error('该资源不在页面预览范围内'); }
    }
    return taskMediaResponse(file, { ...request, contentSecurityPolicy: fileContentSecurityPolicy(file.mimeType) });
  }
}

export function installTaskFileAssets(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth) {
  const assets = new TaskFileAssets(engine, auth);
  // These links grant only workspace file reads, independent of the app's
  // bearer credential. Opaque HTML frames use ordinary HTTP CORS for modules/fetch.
  app.on(['GET', 'HEAD', 'OPTIONS'], '/file-assets/:token/*', async c => {
    c.header('Access-Control-Allow-Origin', '*'); c.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'); c.header('Access-Control-Allow-Headers', 'Range, Content-Type'); c.header('Referrer-Policy', 'no-referrer');
    const token = c.req.param('token'), prefix = '/file-assets/' + token + '/';
    try {
      const encoded = new URL(c.req.url).pathname.slice(prefix.length), path = decodeURIComponent(encoded);
      const response = await assets.resource(token, path, { method: c.req.method, range: c.req.header('Range'), signal: c.req.raw.signal });
      response.headers.set('Access-Control-Allow-Origin', '*'); response.headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS'); response.headers.set('Access-Control-Allow-Headers', 'Range, Content-Type'); response.headers.set('Referrer-Policy', 'no-referrer'); return response;
    } catch (error) { return c.json({ error: (error as Error).message }, error instanceof AssetAccessRejected ? 403 : 404); }
  });
  return assets;
}
