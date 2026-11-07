import type { Hono, Handler } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Auth } from './auth.js';
import type { Engine } from './engine.js';
import type { TaskHostBrowsers } from './task-host-browser.js';
import { HostBrowserError } from './task-host-browser-protocol.js';
import { hostUploadFiles } from './task-host-browser-transfers.js';
import { taskMediaResponse } from './task-media.js';

export function installTaskHostBrowserAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth, browsers: TaskHostBrowsers = engine.hostBrowsers) {
  app.post('/api/task-browser/profiles/clear', async c => {
    try { const body = await c.req.json(); return c.json(await browsers.clearProfile(body.profile)); }
    catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
  });
  async function scope(taskId: unknown) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 128) throw new HostBrowserError('任务不存在', 404);
    await engine.contexts.owner({ taskId });
  }
  const route = (action: (body: Record<string, unknown>, device: string) => Promise<unknown>): Handler<{ Variables: { device: string } }> => async c => {
    try { const body = await c.req.json(); await scope(body.taskId); return c.json(await action(body, c.get('device'))); }
    catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
  };
  app.post('/api/task-browser/host/open', route(body => browsers.open(body)));
  app.post('/api/task-browser/host/command', route((body, device) => browsers.command(body, device)));
  app.post('/api/task-browser/host/ack', route((body, device) => browsers.ackFrame(body, device)));
  app.post('/api/task-browser/host/annotation', route((body, device) => browsers.annotation(body, device)));
  app.post('/api/task-browser/host/recording', route((body, device) => browsers.recording(body, device)));
  app.post('/api/task-browser/host/capture', async c => {
    try { const body = await c.req.json(); await scope(body.taskId); const capture = await browsers.capture(body, c.get('device')); return new Response(capture.data, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Friday-Capture-Sequence': String(capture.sequence), 'X-Friday-Capture-Document': capture.document } }); }
    catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
  });
  app.post('/api/task-browser/host/close', route(body => browsers.closeTabRequest(body.taskId, body.tabId, body.generation)));
  app.post('/api/task-browser/host/upload', async c => {
    try {
      const query = c.req.query(); await scope(query.taskId);
      const body = { ...query, sequence: Number(query.sequence), controlGeneration: Number(query.controlGeneration) };
      return c.json(await browsers.upload(body, c.get('device'), () => hostUploadFiles(c.req.raw)));
    } catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
  });
  app.on(['GET', 'HEAD'], '/api/task-browser/host/download', async c => {
    try {
      const query = c.req.query(); await scope(query.taskId); const file = await browsers.download(query);
      const response = await taskMediaResponse(file, { method: c.req.method, range: c.req.header('Range'), signal: c.req.raw.signal });
      response.headers.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.name).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())); return response;
    } catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
  });
  app.get('/api/task-browser/host/events', async c => {
    const query = c.req.query();
    let attached: Awaited<ReturnType<TaskHostBrowsers['attach']>>;
    try { await scope(query.taskId); attached = await browsers.attach(query.taskId, query.tabId, query.generation, query.viewer, c.get('device')); }
    catch (error) { if (error instanceof HostBrowserError) return c.json({ error: error.message }, error.status); throw error; }
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '');
    return streamSSE(c, async stream => {
      let ended = false;
      const close = () => { if (ended) return; ended = true; stream.abort(); void attached.detach(); };
      stream.onAbort(close); engine.once('closing', close);
      let lastPing = Date.now();
      const heartbeat = setInterval(() => { if (!auth.identify(bearer)) close(); else if (Date.now() - lastPing >= 10000) { lastPing = Date.now(); attached.mailbox.offer({ type: 'heartbeat' }); } }, 1000);
      try {
        while (!ended && auth.identify(bearer)) {
          const value = await attached.mailbox.next(); if (!value || ended) break;
          // Hono closes the stream if the downstream cannot accept one bounded frame in time.
          const timeout = setTimeout(close, 5000);
          try { await stream.writeSSE({ event: value.type, data: JSON.stringify(value) }); } finally { clearTimeout(timeout); }
          if (value.type === 'gone') break;
        }
      } finally { clearInterval(heartbeat); engine.off('closing', close); await attached.detach(); }
    }, async () => { await attached.detach(); });
  });
}
