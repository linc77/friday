import type { Hono } from 'hono';
import type { Engine } from './engine.js';

export function installChangeRequestAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine) {
  app.get('/api/tasks/:id/change-request/links', async c => c.json(await engine.changeRequestLinks.list(c.req.param('id'))));
  app.post('/api/tasks/:id/change-request/watch', async c => c.json(await engine.changeRequestWatch.change(c.req.param('id'), await c.req.json())));
  app.post('/api/tasks/:id/change-request/open', async c => c.json(await engine.changeRequestLinks.open(c.req.param('id'), await c.req.json(), c.req.raw.signal)));
  app.post('/api/tasks/:id/change-request/link', async c => c.json(await engine.changeRequestLinks.change(c.req.param('id'), await c.req.json(), true, c.req.raw.signal)));
  app.post('/api/tasks/:id/change-request/unlink', async c => c.json(await engine.changeRequestLinks.change(c.req.param('id'), await c.req.json(), false, c.req.raw.signal)));
  app.post('/api/projects/:id/change-request/resolve', async c => c.json(await engine.changeRequestCheckouts.resolve(c.req.param('id'), await c.req.json(), c.req.raw.signal)));
  app.post('/api/projects/:id/change-request/prepare', async c => c.json({ id: await engine.changeRequestCheckouts.start(c.req.param('id'), await c.req.json()) }, 202));
  app.get('/api/projects/:id/change-request/preparations/:preparationId', async c => c.json(await engine.changeRequestCheckouts.get(c.req.param('id'), c.req.param('preparationId'))));
  app.post('/api/projects/:id/change-request/preparations/:preparationId/cancel', async c => { await engine.changeRequestCheckouts.cancel(c.req.param('id'), c.req.param('preparationId')); return c.json({ ok: true }); });
  app.get('/api/tasks/:id/change-request/stack', async c => c.json(await engine.changeRequestStacks.get(c.req.param('id'), c.req.query('url'), c.req.raw.signal, true)));
  app.post('/api/tasks/:id/change-request/stack/open', async c => c.json(await engine.changeRequestStacks.open(c.req.param('id'), await c.req.json())));
  app.post('/api/tasks/:id/change-request/stack/operations', async c => c.json({ id: await engine.changeRequestStacks.start(c.req.param('id'), await c.req.json()) }, 202));
  app.get('/api/tasks/:id/change-request/guide/status', async c => c.json(await engine.reviewGuides.status(c.req.param('id'), c.req.query('url'))));
  app.get('/api/tasks/:id/change-request/guide', async c => c.json(await engine.reviewGuides.get(c.req.param('id'), c.req.query('url'), c.req.raw.signal)));
  app.post('/api/tasks/:id/change-request/guide', async c => c.json({ id: await engine.reviewGuides.start(c.req.param('id'), await c.req.json()) }, 202));
  app.post('/api/tasks/:id/change-request/guide/context', async c => c.json(await engine.reviewGuides.context(c.req.param('id'), await c.req.json())));
  app.post('/api/tasks/:id/change-request/guide/cancel', async c => { const body = await c.req.json(); await engine.reviewGuides.cancel(c.req.param('id'), body.url, body.id); return c.json({ ok: true }); });
  app.get('/api/tasks/:id/change-request', async c => c.json(await engine.changeRequests.detail(c.req.param('id'), c.req.query('url'), c.req.raw.signal, c.req.query('refresh') === 'true' ? 'refresh' : 'cache')));
  app.get('/api/tasks/:id/change-request/checks', async c => c.json(await engine.changeRequests.checks(c.req.param('id'), c.req.query('url'), c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/file-contents', async c => c.json(await engine.changeRequests.fileContents(c.req.param('id'), c.req.query('url'), { path: c.req.query('path'), head: c.req.query('head'), side: c.req.query('side'), ...(c.req.query('slice') !== undefined ? { slice: c.req.query('slice') === 'true' ? true : c.req.query('slice') } : {}), ...(c.req.query('cursor') !== undefined ? { cursor: c.req.query('cursor') } : {}), ...(c.req.query('base') !== undefined ? { base: c.req.query('base') } : {}), ...(c.req.query('commit') ? { commit: c.req.query('commit') } : {}) }, c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/commit', async c => c.json(await engine.changeRequests.commit(c.req.param('id'), c.req.query('url'), c.req.query('sha'), c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/activity', async c => c.json(await engine.changeRequests.activity(c.req.param('id'), c.req.query('url'), c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/files', async c => c.json(await engine.changeRequests.files(c.req.param('id'), c.req.query('url'), c.req.query('head'), c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/diff', async c => c.json(await engine.changeRequests.diff(c.req.param('id'), c.req.query('url'), { head: c.req.query('head'), ...(c.req.query('base') !== undefined ? { base: c.req.query('base') } : {}), ...(c.req.query('cursor') !== undefined ? { cursor: c.req.query('cursor') } : {}), ...(c.req.query('commit') !== undefined ? { commit: c.req.query('commit') } : {}) }, c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/thread-comments', async c => c.json(await engine.changeRequests.threadComments(c.req.param('id'), c.req.query('url'), c.req.query('threadId'), c.req.query('cursor'), c.req.raw.signal)));
  app.get('/api/tasks/:id/change-request/reviewers', async c => c.json(await engine.changeRequests.reviewers(c.req.param('id'), c.req.query('url'), c.req.raw.signal)));
  app.get('/api/tasks/:id/change-request/labels', async c => c.json(await engine.changeRequests.labels(c.req.param('id'), c.req.query('url'), c.req.raw.signal)));
  app.get('/api/tasks/:id/change-request/viewed-files', async c => c.json(await engine.changeRequests.viewed(c.req.param('id'), c.req.query('url'), c.req.raw.signal, 'cache')));
  app.get('/api/tasks/:id/change-request/reactions', async c => c.json(await engine.changeRequests.reactions(c.req.param('id'), c.req.query('url'), c.req.raw.signal, 'cache')));
  app.post('/api/tasks/:id/change-request/operations', async c => {
    let body: unknown; try { body = await c.req.json(); } catch { throw new Error('PR／MR 操作格式无效'); }
    return c.json({ id: await engine.changeRequests.start(c.req.param('id'), body) }, 202);
  });
  app.get('/api/tasks/:id/change-request/operations', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json({ operations: (task.changeRequestOperations ?? []).filter(v => (v.stackURLs ? v.stackURLs.some(url => url.toLowerCase() === c.req.query('url')?.toLowerCase()) : v.url === c.req.query('url'))) });
  });
  app.get('/api/tasks/:id/change-request/operations/:operationId', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    const op = task?.changeRequestOperations?.find(v => v.id === c.req.param('operationId'));
    if (!op) return c.json({ error: 'PR／MR 操作记录不存在' }, 404);
    return c.json(op);
  });
}
