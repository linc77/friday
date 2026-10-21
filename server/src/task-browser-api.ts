import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import { TaskBrowserDiscovery, resolveBrowserAddress } from './task-browser.js';

export function installTaskBrowserAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, discovery = new TaskBrowserDiscovery(undefined, undefined, () => engine.terminals.browserProcessOwners())) {
  async function scope(taskId: unknown) {
    if (typeof taskId !== 'string' || !taskId || taskId.length > 512) throw new Error('任务不存在');
    await engine.contexts.owner({ taskId });
  }
  app.post('/api/task-browser/resolve', async c => { const body = await c.req.json(); await scope(body.taskId); return c.json({ url: resolveBrowserAddress(body.address) }); });
  app.post('/api/task-browser/servers', async c => { const body = await c.req.json(); await scope(body.taskId); return c.json(await discovery.list(body.configuredURLs)); });
}
