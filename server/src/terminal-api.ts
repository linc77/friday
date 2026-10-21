import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Auth } from './auth.js';
import type { Engine } from './engine.js';
import { terminalID, terminalRequestID, type TerminalEvent } from './terminal-types.js';

const cursor = (value: string | undefined) => {
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('终端游标无效'); return Number(value);
};

export function installTerminalAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth) {
  const terminals = engine.terminals;
  const path = '/api/tasks/:task/terminals';
  app.use(path + '*', async (c, next) => {
    const state = await engine.snapshot();
    if (!state.tasks.some(task => task.id === c.req.param('task')!) && !engine.projectScripts.ownsTerminal(state, c.req.param('task')!)) return c.json({ error: '任务不存在' }, 404);
    await next();
  });
  app.get(path, c => c.json({ terminals: terminals.summaries(c.req.param('task')!) }));
  app.post(path, async c => {
    const body = await c.req.json();
    if (!['open', 'restart', 'close'].includes(body.action)) throw new Error('终端操作无效');
    if (body.shell !== undefined && (typeof body.shell !== 'string' || !body.shell || body.shell.length > 4096)) throw new Error('Shell 路径无效');
    return c.json({ terminal: await terminals.lifecycle(c.req.param('task')!, { ...body, terminalId: terminalID(body.terminalId), requestId: terminalRequestID(body.requestId) }) });
  });
  app.get(path + '/:terminal', c => c.json(terminals.snapshot(c.req.param('task')!, c.req.param('terminal')!)));
  app.post(path + '/:terminal/input', async c => c.json(await terminals.write(c.req.param('task')!, c.req.param('terminal')!, await c.req.json())));
  app.get(path + '/:terminal/input/:request', c => c.json({ receipt: terminals.receipt(c.req.param('task')!, c.req.param('terminal')!, c.req.param('request')!) }));
  app.post(path + '/:terminal/resize', async c => {
    const body = await c.req.json(); await terminals.resize(c.req.param('task')!, c.req.param('terminal')!, body.generation, body.cols, body.rows); return c.json({ ok: true });
  });
  app.post(path + '/:terminal/clear', async c => {
    const body = await c.req.json(); await terminals.clear(c.req.param('task')!, c.req.param('terminal')!, body.generation); return c.json({ ok: true });
  });
  app.patch(path + '/:terminal', async c => {
    const body = await c.req.json(); if (typeof body.label !== 'string') throw new Error('终端名称无效');
    terminals.rename(c.req.param('task')!, c.req.param('terminal')!, body.label); return c.json({ ok: true });
  });
  app.get(path + '/:terminal/events', c => {
    const task = c.req.param('task')!; const terminal = terminalID(c.req.param('terminal')!);
    const generation = cursor(c.req.query('generation')); const after = cursor(c.req.query('after'));
    terminals.snapshot(task, terminal); // Fail before committing SSE headers.
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '');
    return streamSSE(c, async stream => {
      let ended = false; let bytes = 0; let wake: (() => void) | undefined;
      let initial = true; const queue: { event: TerminalEvent; bytes: number }[] = [];
      const end = () => { ended = true; wake?.(); stream.abort(); };
      const revoked = () => !auth.identify(bearer);
      const heartbeat = setInterval(() => { if (revoked()) end(); else wake?.(); }, 1000);
      const closed = () => end(); engine.once('closing', closed); stream.onAbort(() => { ended = true; wake?.(); });
      let unsubscribe: (() => void) | undefined;
      try {
        unsubscribe = terminals.observe(task, terminal, generation, after, event => {
          if (ended) return;
          const size = event.type === 'output' ? event.data.length : event.type === 'snapshot' ? event.history.length : 2048;
          // One initial snapshot is bounded by the retained 8 MiB transcript.
          // Slow clients detach and resume from a cursor; they never block PTYs.
          if ((!initial || event.type !== 'snapshot') && (bytes + size > 512 * 1024 || queue.length >= 256)) { end(); return; }
          initial = false; bytes += size; queue.push({ event, bytes: size }); wake?.();
        });
        let lastPing = Date.now();
        while (!ended && !revoked()) {
          const frame = queue.shift();
          if (frame) {
            bytes -= frame.bytes;
            await stream.writeSSE({ event: 'terminal', id: `${frame.event.generation}:${frame.event.sequence}`, data: JSON.stringify(frame.event) });
          } else {
            if (Date.now() - lastPing > 10_000) { await stream.writeSSE({ event: 'ping', data: '{}' }); lastPing = Date.now(); }
            await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
          }
        }
      } finally { clearInterval(heartbeat); unsubscribe?.(); engine.off('closing', closed); }
    });
  });
}
