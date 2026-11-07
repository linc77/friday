import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Engine } from './engine.js';
import type { Auth } from './auth.js';
import { TaskGitContexts, gitRefreshInterval } from './git-context.js';
import { compactTaskEvent } from './task-output.js';
import { contentVersion, overviewChange, taskOverview } from './task-stream.js';
import type { AgentInfo, Workspace } from './types.js';
import { ProjectRepositoryIdentities } from './project-repository-identities.js';

export function installTaskStreamAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, auth: Auth, agents: () => AgentInfo[], projectIdentities = new ProjectRepositoryIdentities()) {
  const git = new Map<string, TaskGitContexts>();
  const overviewGit = new TaskGitContexts(); let serial = 0;
  const overview = async () => {
    const order = ++serial;
    const state = await projectIdentities.snapshot(await overviewGit.snapshot(await engine.snapshot()));
    for (const id of git.keys()) if (!state.tasks.some(task => task.id === id)) git.delete(id);
    return { ...taskOverview(state, engine.streamSession), taskStreamSerial: order, agents: agents(), devices: auth.devices(), serviceId: auth.serviceId, notesVersion: 1 };
  };
  app.get('/api/overview', async c => c.json({ ...await overview(), deviceId: c.get('device') }));
  app.get('/api/overview/events', c => streamSSE(c, async stream => {
    let ended = false; let dirty = true; let nextGit = 0; let lastPing = Date.now(); let wake: (() => void) | undefined;
    let previous: Workspace | undefined;
    const changed = () => { dirty = true; wake?.(); };
    const close = () => { ended = true; wake?.(); stream.abort(); };
    engine.on('change', changed); engine.once('closing', close); stream.onAbort(() => { ended = true; wake?.(); });
    const token = c.req.header('Authorization')?.replace(/^Bearer /, '');
    const heartbeat = setInterval(() => { if (!auth.identify(token)) close(); else wake?.(); }, 1000);
    try {
      while (!ended && auth.identify(token)) {
        if (dirty || Date.now() >= nextGit) {
          dirty = false; const state = { ...await overview(), deviceId: c.get('device') }; nextGit = Date.now() + gitRefreshInterval;
          if (ended || !auth.identify(token)) break;
          const change = previous ? overviewChange(previous, state) : { snapshot: true as const };
          if (change.snapshot) await stream.writeSSE({ event: 'snapshot', id: String(state.revision), data: JSON.stringify(state) });
          else if (change.patch) await stream.writeSSE({ event: 'taskSummaries', id: String(state.revision), data: JSON.stringify({ ...change.patch, serial: state.taskStreamSerial }) });
          previous = state;
          await stream.sleep(150);
        } else {
          if (Date.now() - lastPing >= 10_000) { await stream.writeSSE({ event: 'heartbeat', data: '{}' }); lastPing = Date.now(); }
          await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
        }
      }
    } finally { clearInterval(heartbeat); engine.off('change', changed); engine.off('closing', close); }
  }));
  let detailSerial = 0;
  const snapshot = async (id: string, itemHistory: boolean) => {
    const serial = ++detailSerial;
    const state = await engine.snapshot(); const task = state.tasks.find(task => task.id === id && task.agent !== 'friday');
    if (!task) { git.delete(id); return { taskId: id, sessionId: engine.streamSession, sequence: state.revision, serial, removed: true as const }; }
    void engine.subagentHistory.ensure(id).catch(() => {});
    // Only this task's Git and archived turn window are read for a detail viewer.
    if (!git.has(id)) git.set(id, new TaskGitContexts());
    const own = (await git.get(id)!.snapshot({ ...state, tasks: [task] })).tasks[0];
    const version = contentVersion(own);
    const projected = await engine.conversationHistory.project(own, state.revision, true, itemHistory);
    return { taskId: id, sessionId: engine.streamSession, sequence: state.revision, serial, version,
      task: { ...projected, events: projected.events.map(compactTaskEvent), contentVersion: version, contentSequence: state.revision } };
  };
  app.get('/api/tasks/:id/snapshot', async c => {
    const value = await snapshot(c.req.param('id'), c.req.query('itemHistory') === '1');
    return 'removed' in value ? c.json({ ...value, error: '本地任务不存在' }, 404) : c.json(value);
  });
  app.post('/api/tasks/:id/native-history/refresh', async c => {
    const state = await engine.snapshot(); const task = state.tasks.find(task => task.id === c.req.param('id'));
    if (!task) return c.json({ error: '本地任务不存在' }, 404);
    if (!engine.subagentHistory.available(state, task.id)) return c.json({ error: '此对话当前无法补读原生子会话历史' }, 400);
    void engine.subagentHistory.ensure(task.id, true).catch(() => {}); return c.json({ ok: true }, 202);
  });
  app.get('/api/tasks/:id/events', async c => {
    const id = c.req.param('id'); const itemHistory = c.req.query('itemHistory') === '1'; const current = await snapshot(id, itemHistory);
    if ('removed' in current) return c.json({ error: '本地任务不存在' }, 404);
    const requestedVersion = c.req.query('version');
    if (requestedVersion !== undefined && !/^[a-f0-9]{64}$/.test(requestedVersion)) throw new Error('任务订阅版本无效');
    const bearer = c.req.header('Authorization')?.replace(/^Bearer /, '');
    return streamSSE(c, async stream => {
      let ended = false; let dirty = true; let nextGit = 0; let lastPing = Date.now(); let wake: (() => void) | undefined;
      let previous = c.req.query('session') === engine.streamSession ? requestedVersion : undefined;
      const changed = () => { dirty = true; wake?.(); };
      const close = () => { ended = true; wake?.(); stream.abort(); };
      engine.on('change', changed); engine.once('closing', close); stream.onAbort(() => { ended = true; wake?.(); });
      const heartbeat = setInterval(() => { if (!auth.identify(bearer)) close(); else wake?.(); }, 1000);
      try {
        while (!ended && auth.identify(bearer)) {
          if (dirty || Date.now() >= nextGit) {
            dirty = false; const frame = await snapshot(id, itemHistory); nextGit = Date.now() + gitRefreshInterval;
            if (ended || !auth.identify(bearer)) break;
            if ('removed' in frame) { await stream.writeSSE({ event: 'taskRemoved', data: JSON.stringify(frame) }); break; }
            if (frame.version !== previous) { await stream.writeSSE({ event: 'taskSnapshot', id: String(frame.sequence), data: JSON.stringify(frame) }); previous = frame.version; }
            else await stream.writeSSE({ event: 'heartbeat', data: '{}' });
            await stream.sleep(150);
          } else {
            if (Date.now() - lastPing >= 10_000) { await stream.writeSSE({ event: 'heartbeat', data: '{}' }); lastPing = Date.now(); }
            await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
          }
        }
      } finally { clearInterval(heartbeat); engine.off('change', changed); engine.off('closing', close); }
    });
  });
}
