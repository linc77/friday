import type { Hono, Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Engine } from './engine.js';
import type { Auth } from './auth.js';
import { taskEventDetail } from './task-output.js';

export function installTaskOutputAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth) {
  const path = '/api/tasks/:task/history/items/:event';
  const scope = (value: string | undefined) => {
    if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error('任务输出的历史版本无效');
    return value;
  };
  app.get(path, async c => {
    const epoch = scope(c.req.query('epoch'));
    const page = await engine.taskHistory.eventItems(c.req.param('task'), [c.req.param('event')]);
    const event = page.events.find(event => !event.revertedAt);
    if (page.epoch !== epoch || !event) return c.json({ error: '这条输出已不在当前任务历史中' }, 404);
    return c.json({ taskId: page.taskId, epoch, sequence: page.sequence, event: taskEventDetail(event) });
  });
  const output = (native = false) => async (c: Context<{ Variables: { device: string } }>) => {
    const task = c.req.param('task')!; const event = c.req.param('event')!;
    const sessionId = c.req.query('sessionId');
    if (native && (!sessionId || !/^[a-f0-9-]{36}$/.test(sessionId))) throw new Error('后台任务的输出范围无效');
    const epoch = native ? sessionId! : scope(c.req.query('epoch'));
    const frame = () => native ? engine.commandOutputs.nativeFrame(task, event, epoch) : engine.commandOutputs.frame(task, event, epoch);
    await frame(); // Validate before SSE headers.
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '');
    return streamSSE(c, async stream => {
      let dirty = true; let ended = false; let wake: (() => void) | undefined;
      const changed = () => { dirty = true; wake?.(); };
      const closed = () => { ended = true; wake?.(); stream.abort(); };
      const unsubscribe = engine.commandOutputs.observe(task, event, changed);
      engine.on('change', changed); engine.once('closing', closed);
      stream.onAbort(() => { ended = true; wake?.(); });
      const heartbeat = setInterval(() => { if (!auth.identify(bearer)) closed(); else wake?.(); }, 1000);
      let previous = ''; let lastPing = Date.now();
      try {
        while (!ended && auth.identify(bearer)) {
          if (dirty) {
            dirty = false;
            const value = await frame();
            const encoded = JSON.stringify(value);
            if (encoded !== previous) { await stream.writeSSE({ event: 'output', data: encoded }); previous = encoded; }
            if (!value.running) break;
            // Only the latest bounded tail is held. Slow subscribers never
            // queue raw chunks or block provider execution.
            await stream.sleep(100);
          } else {
            if (Date.now() - lastPing > 10_000) { await stream.writeSSE({ event: 'ping', data: '{}' }); lastPing = Date.now(); }
            await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
          }
        }
      } catch (error) {
        if (!ended && auth.identify(bearer)) await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: error instanceof Error ? error.message : '输出不可用' }) });
      } finally { clearInterval(heartbeat); unsubscribe(); engine.off('change', changed); engine.off('closing', closed); }
    });
  };
  app.get(path + '/output', output());
  app.get('/api/tasks/:task/background/:event/output', output(true));
}
