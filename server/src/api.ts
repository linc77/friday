import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import type { Engine } from './engine.js';
import { Auth } from './auth.js';
import { discoverAgents } from './agents.js';
import { activeStatuses } from './types.js';

function text(value: unknown, name: string, max = 12_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空，且长度不能超过 ${max}`);
  return value.trim();
}
export function createAPI(engine: Engine, auth: Auth, agents = discoverAgents) {
  const app = new Hono<{ Variables: { device: string } }>();
  app.use('*', bodyLimit({ maxSize: 256 * 1024 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.json({ error: '不允许跨站访问' }, 403);
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && !c.req.header('Content-Type')?.startsWith('application/json')) return c.json({ error: '请求需要使用 JSON' }, 415);
    await next();
  });
  app.onError((error, c) => c.json({ error: error.message || '请求失败' }, 400));
  app.get('/health', c => c.json({ name: 'Friday', version: '0.1.0', status: 'ok' }));
  app.post('/pair', async c => {
    const body = await c.req.json();
    const address = (c.env as any)?.incoming?.socket?.remoteAddress ?? 'local';
    return c.json(auth.pair(text(body.code, '配对码', 6), text(body.name, '设备名称', 80), address));
  });
  app.use('/api/*', async (c, next) => {
    const device = auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''));
    if (!device) return c.json({ error: '请先连接或配对设备' }, 401);
    c.set('device', device); await next();
  });
  app.get('/api/state', async c => c.json({ ...await engine.snapshot(), agents: agents(), devices: auth.devices(), deviceId: c.get('device') }));
  app.get('/api/model', async c => c.json(await engine.modelConnection.status(c.get('device') === 'owner')));
  app.use('/api/model/*', async (c, next) => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机上管理 OpenAI 登录' }, 403);
    await next();
  });
  app.post('/api/model/login', async c => c.json(await engine.modelConnection.startLogin()));
  app.post('/api/model/callback', async c => { const body = await c.req.json(); engine.modelConnection.completeLogin(text(body.url, '回调地址', 8000)); return c.json({ ok: true }); });
  app.post('/api/model/logout', async c => {
    if ((await engine.snapshot()).tasks.some(t => t.agent === 'friday' && activeStatuses.includes(t.status))) throw new Error('请先停止 Friday 正在处理的会话再退出登录');
    await engine.modelConnection.logout(); return c.json({ ok: true });
  });
  app.get('/api/events', c => streamSSE(c, async stream => {
    let dirty = true; let ended = false;
    const changed = () => { dirty = true; };
    engine.on('change', changed); stream.onAbort(() => { ended = true; engine.off('change', changed); });
    try {
      while (!ended) {
        if (!auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''))) break;
        if (dirty) {
          dirty = false; const state = await engine.snapshot();
          await stream.writeSSE({ event: 'snapshot', id: String(state.revision), data: JSON.stringify(state) });
        } else await stream.writeSSE({ event: 'heartbeat', data: '{}' });
        await stream.sleep(800);
      }
    } finally { engine.off('change', changed); }
  }));
  app.post('/api/pairing', c => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机上生成配对码' }, 403);
    return c.json(auth.createPairing());
  });
  app.delete('/api/devices/:id', c => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机上管理设备' }, 403);
    auth.revoke(c.req.param('id')); return c.json({ ok: true });
  });
  app.post('/api/ideas', async c => {
    const body = await c.req.json(); const idea = { id: text(body.id ?? randomUUID(), 'ID', 80), text: text(body.text, '想法'), createdAt: new Date().toISOString(), taskId: null };
    await engine.mutate(s => { if (!s.ideas.some(i => i.id === idea.id)) s.ideas.unshift(idea); }); return c.json(idea, 201);
  });
  app.delete('/api/ideas/:id', async c => { await engine.mutate(s => { s.ideas = s.ideas.filter(i => i.id !== c.req.param('id')); }); return c.json({ ok: true }); });
  app.post('/api/projects', async c => {
    const body = await c.req.json(); const path = text(body.path, '项目目录', 4096);
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('请选择主机上存在的绝对目录');
    const project = { id: randomUUID(), name: text(body.name, '项目名称', 120), path: await realpath(path), context: typeof body.context === 'string' ? body.context.slice(0, 20_000) : '' };
    await engine.mutate(s => { if (s.projects.some(p => p.path === project.path)) throw new Error('这个目录已经添加'); s.projects.push(project); }); return c.json(project, 201);
  });
  app.put('/api/projects/:id', async c => {
    const body = await c.req.json();
    await engine.mutate(s => { const p = s.projects.find(p => p.id === c.req.param('id')); if (!p) throw new Error('项目不存在'); p.name = text(body.name, '名称', 120); p.context = typeof body.context === 'string' ? body.context.slice(0, 20_000) : ''; });
    return c.json({ ok: true });
  });
  app.post('/api/memories', async c => {
    const body = await c.req.json(); const memory = { id: typeof body.id === 'string' ? body.id : randomUUID(), text: text(body.text, '记忆', 4000), updatedAt: new Date().toISOString() };
    await engine.mutate(s => { const index = s.memories.findIndex(m => m.id === memory.id); if (index >= 0) s.memories[index] = memory; else if (s.memories.length < 100) s.memories.push(memory); else throw new Error('第一版最多支持 100 条显式记忆'); }); return c.json(memory);
  });
  app.delete('/api/memories/:id', async c => { await engine.mutate(s => { s.memories = s.memories.filter(m => m.id !== c.req.param('id')); }); return c.json({ ok: true }); });
  app.post('/api/tasks', async c => {
    const body = await c.req.json();
    // Older clients send "codex". New work still belongs to Friday; only old records keep that executor.
    if (body.agent && !['friday', 'codex'].includes(body.agent)) throw new Error('请向 Friday 提交请求，其他 Agent 尚未接入');
    const mode = body.mode ?? 'auto';
    if (!['auto', 'assistant', 'research', 'code'].includes(mode)) throw new Error('任务类型无效');
    const id = await engine.createTask({ prompt: text(body.prompt, '任务要求'), projectId: body.projectId ? text(body.projectId, '项目 ID', 80) : null, mode, requestId: text(body.requestId, '请求 ID', 100), ideaId: typeof body.ideaId === 'string' ? body.ideaId : undefined });
    return c.json({ id }, 201);
  });
  app.post('/api/tasks/:id/workspace', async c => {
    const body = await c.req.json(); const requestId = text(body.requestId, '请求 ID', 100);
    const state = await engine.snapshot(); const id = c.req.param('id');
    if (Object.hasOwn(state.requests, requestId)) {
      if (state.requests[requestId] !== id) throw new Error('请求 ID 已被其他任务使用');
      return c.json({ id });
    }
    if (state.tasks.find(t => t.id === id)?.status !== 'needs_project') throw new Error('当前对话没有等待选择工作目录');
    let projectId: string;
    if (body.projectId) projectId = text(body.projectId, '项目 ID', 80);
    else {
      const path = text(body.path, '工作目录', 4096);
      if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('请选择主机上存在的目录');
      const resolved = await realpath(path); let selectedId = '';
      await engine.mutate(s => {
        let project = s.projects.find(p => p.path === resolved);
        if (!project) { project = { id: randomUUID(), name: basename(resolved) || resolved, path: resolved, context: '' }; s.projects.push(project); }
        selectedId = project.id;
      });
      projectId = selectedId;
    }
    await engine.createTask({ continueId: id, prompt: '就在我选择的这个工作目录里，继续刚才的请求。', projectId, mode: 'auto', requestId });
    return c.json({ id });
  });
  app.post('/api/tasks/:id/cancel', async c => { await engine.cancel(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/tasks/:id/message', async c => {
    const body = await c.req.json(); const prompt = text(body.text, '补充要求'); const requestId = text(body.requestId, '请求 ID', 100);
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task) throw new Error('任务不存在');
    if (activeStatuses.includes(task.status)) await engine.steer(task.id, prompt, requestId);
    else await engine.createTask({ prompt, requestId, projectId: task.projectId, mode: task.mode, continueId: task.id });
    return c.json({ id: task.id });
  });
  app.post('/api/tasks/:id/approvals/:approvalId', async c => {
    const body = await c.req.json(); if (!['accept', 'decline'].includes(body.decision)) throw new Error('无效的授权决定');
    const answers = body.answers ?? {};
    if (typeof answers !== 'object' || Array.isArray(answers) || !Object.values(answers).every(a => Array.isArray(a) && a.every(v => typeof v === 'string' && v.length < 12_000))) throw new Error('回答格式无效');
    await engine.answer(c.req.param('id'), c.req.param('approvalId'), body.decision, answers); return c.json({ ok: true });
  });
  app.get('/api/tasks/:id/artifact', async c => { c.header('Content-Type', 'text/markdown; charset=utf-8'); return c.body(await engine.artifact(c.req.param('id'))); });
  return app;
}
