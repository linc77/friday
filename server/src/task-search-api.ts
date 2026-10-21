import type { Hono } from 'hono';
import type { Auth } from './auth.js';
import type { Engine } from './engine.js';
import { taskSearchInput } from './task-search.js';

export function installTaskSearchAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth) {
  app.get('/api/tasks/search', async c => {
    const input = taskSearchInput(c.req.query('query'), c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')));
    try {
      const result = await engine.taskSearch.search(input, c.req.raw.signal);
      const visible = await engine.taskSearchVisibility();
      if (!auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''))) return c.json({ error: '请先连接或配对设备' }, 401);
      return c.json({ ...result, sessionId: engine.streamSession, matches: result.matches.filter(match => visible.get(match.taskId) === match.epoch) });
    } catch { return c.json({ error: '任务消息搜索暂时不可用，请稍后重试' }, 503); }
  });
}
