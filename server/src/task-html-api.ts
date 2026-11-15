import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import type { Auth } from './auth.js';
import { htmlContentSecurityPolicy, htmlDocument } from './task-html.js';

type Claims = { v: 1; taskId: string; eventId: string; device: string; expires: number };
export class TaskHtmlAssets {
  constructor(private readonly engine: Engine, private readonly auth: Auth) {}
  private sign(payload: string) { return createHmac('sha256', this.auth.token).update('friday.html.v1\0' + payload).digest(); }
  async issue(device: string, input: unknown, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('HTML 预览请求无效');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !['taskId', 'eventId'].includes(key)) || typeof value.taskId !== 'string' || typeof value.eventId !== 'string' || value.taskId.length > 256 || !/^html-[a-f0-9]{64}$/.test(value.eventId)) throw new Error('HTML 预览请求无效');
    await this.engine.html.read(value.taskId, value.eventId);
    const claims: Claims = { v: 1, taskId: value.taskId, eventId: value.eventId, device, expires: now + 60 * 60 * 1000 };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return { url: '/file-assets/html/' + payload + '.' + this.sign(payload).toString('base64url') + '/index.html', expiresAt: new Date(claims.expires).toISOString() };
  }
  private claims(token: string, now: number): Claims {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
      const [payload, signature] = token.split('.'), bytes = Buffer.from(signature, 'base64url');
      if (bytes.toString('base64url') !== signature || !timingSafeEqual(bytes, this.sign(payload))) throw new Error();
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
      if (value.v !== 1 || typeof value.taskId !== 'string' || typeof value.eventId !== 'string' || typeof value.device !== 'string' || !Number.isSafeInteger(value.expires) || value.expires <= now) throw new Error();
      if (value.device !== 'owner' && !this.auth.devices().some(device => device.id === value.device)) throw new Error();
      return value;
    } catch { throw new Error('HTML 预览链接无效或已过期，请刷新预览'); }
  }
  async resource(token: string, method: string, now = Date.now()) {
    const claims = this.claims(token, now);
    const saved = await this.engine.html.read(claims.taskId, claims.eventId);
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': htmlContentSecurityPolicy, 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' };
    return new Response(method === 'GET' ? htmlDocument(saved.html) : null, { status: method === 'OPTIONS' ? 204 : 200, headers });
  }
}

// Install before the generic workspace-file capability route. Issuing a link is
// authenticated separately; the iframe never receives an application credential.
export function installTaskHtmlAssets(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth) {
  const assets = new TaskHtmlAssets(engine, auth);
  app.on(['GET', 'HEAD', 'OPTIONS'], '/file-assets/html/:token/index.html', async c => {
    try { return await assets.resource(c.req.param('token'), c.req.method); }
    catch { return c.json({ error: 'HTML 预览不可用，请刷新或重新打开会话' }, 403); }
  });
  return assets;
}
