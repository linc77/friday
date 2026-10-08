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
import { IdeaImages, ideaContent, maxImageBytes } from './ideas.js';
import type { Idea } from './types.js';
import { projectChanges } from './projects.js';
import { TaskGitContexts, gitRefreshInterval } from './git-context.js';
import { workspaceOptions, workspaceSelection } from './task-workspace.js';

function text(value: unknown, name: string, max = 12_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空，且长度不能超过 ${max}`);
  return value.trim();
}
function optionalModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 120 || /[\x00-\x1f]/.test(value)) throw new Error('模型或推理强度无效');
  return value;
}
export function createAPI(engine: Engine, auth: Auth, agents = discoverAgents) {
  const app = new Hono<{ Variables: { device: string } }>();
  const images = new IdeaImages(engine.directory);
  const gitContexts = new TaskGitContexts();
  const normalLimit = bodyLimit({ maxSize: 256 * 1024 });
  const noteLimit = bodyLimit({ maxSize: 1024 * 1024 });
  const imageLimit = bodyLimit({ maxSize: Math.ceil(maxImageBytes / 3) * 4 + 4096 });
  app.use('*', (c, next) => c.req.path === '/api/idea-images' ? imageLimit(c, next) : c.req.path.startsWith('/api/ideas') ? noteLimit(c, next) : normalLimit(c, next));
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
  app.get('/api/state', async c => c.json({ ...await gitContexts.snapshot(await engine.snapshot()), agents: agents(), devices: auth.devices(), deviceId: c.get('device'), notesVersion: 1 }));
  app.get('/api/model', async c => c.json(await engine.modelConnection.status(c.get('device') === 'owner')));
  app.use('/api/model/*', async (c, next) => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机的 Providers 中配置 Friday' }, 403);
    if ((await engine.snapshot()).tasks.some(t => t.agent === 'friday' && activeStatuses.includes(t.status))) return c.json({ error: '请先停止 Friday 正在处理的会话再修改模型连接' }, 409);
    await next();
  });
  app.put('/api/model/key', async c => {
    const body = await c.req.json();
    return c.json(await engine.modelConnection.saveKey(text(body.apiKey, 'API Key', 512)));
  });
  app.delete('/api/model/key', async c => { await engine.modelConnection.clearKey(); return c.json({ ok: true }); });
  app.get('/api/agents/codex', async c => c.json(await engine.codexConnection.status(c.get('device') === 'owner')));
  app.use('/api/agents/codex/*', async (c, next) => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机的 Providers 中配置 Codex' }, 403);
    if (c.req.path !== '/api/agents/codex/check' && (await engine.snapshot()).tasks.some(t => t.agent === 'codex' && activeStatuses.includes(t.status))) return c.json({ error: '请先停止 Codex 正在处理的任务再修改工具配置' }, 409);
    await next();
  });
  app.put('/api/agents/codex/settings', async c => c.json(await engine.codexConnection.save(await c.req.json())));
  app.post('/api/agents/codex/check', async c => c.json(await engine.codexConnection.status(true, true)));
  app.post('/api/agents/codex/login', async c => c.json(await engine.codexConnection.login()));
  app.get('/api/agents/claude', async c => c.json(await engine.claudeConnection.status(c.get('device') === 'owner')));
  app.use('/api/agents/claude/*', async (c, next) => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机的 Providers 中配置 Claude' }, 403);
    if (c.req.path !== '/api/agents/claude/check' && (await engine.snapshot()).tasks.some(t => t.agent === 'claude' && activeStatuses.includes(t.status))) return c.json({ error: '请先停止 Claude 正在处理的任务再修改工具配置' }, 409);
    await next();
  });
  app.put('/api/agents/claude/settings', async c => c.json(await engine.claudeConnection.save(await c.req.json())));
  app.post('/api/agents/claude/check', async c => c.json(await engine.claudeConnection.status(true, true)));
  app.get('/api/events', c => streamSSE(c, async stream => {
    let dirty = true; let ended = false; let nextGitRefresh = 0; let previousGit = '';
    const changed = () => { dirty = true; };
    engine.on('change', changed); stream.onAbort(() => { ended = true; engine.off('change', changed); });
    try {
      while (!ended) {
        if (!auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''))) break;
        if (dirty || Date.now() >= nextGitRefresh) {
          const stateChanged = dirty; dirty = false;
          const state = await gitContexts.snapshot(await engine.snapshot());
          nextGitRefresh = Date.now() + gitRefreshInterval;
          const currentGit = JSON.stringify(state.tasks.map(task => [task.id, task.git]));
          if (stateChanged || currentGit !== previousGit) {
            await stream.writeSSE({ event: 'snapshot', id: String(state.revision), data: JSON.stringify(state) });
            previousGit = currentGit;
          } else await stream.writeSSE({ event: 'heartbeat', data: '{}' });
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
    const body = await c.req.json(); const id = text(body.id ?? randomUUID(), 'ID', 80);
    // Old clients and an offline retry must get the original stored note.
    const existing = (await engine.snapshot()).ideas.find(i => i.id === id);
    if (existing) return c.json(existing);
    const content = ideaContent(body); const attached = await images.validate(body.images);
    const createdAt = typeof body.createdAt === 'string' && Number.isFinite(Date.parse(body.createdAt)) ? new Date(body.createdAt).toISOString() : new Date().toISOString();
    let idea: Idea = { id, ...content, images: attached, createdAt, updatedAt: createdAt, taskId: null };
    await engine.mutate(s => { const previous = s.ideas.find(i => i.id === id); if (previous) idea = JSON.parse(JSON.stringify(previous)); else s.ideas.unshift(idea); });
    return c.json(idea, 201);
  });
  app.put('/api/ideas/:id', async c => {
    const body = await c.req.json(); const content = ideaContent(body); const attached = await images.validate(body.images);
    const editId = text(body.editId, '修改 ID', 80);
    let idea: Idea | undefined; let conflict = false;
    await engine.mutate(s => {
      const stored = s.ideas.find(i => i.id === c.req.param('id'));
      if (!stored) return;
      if (stored.lastEditId !== editId) {
        if (body.expectedUpdatedAt !== (stored.updatedAt ?? stored.createdAt)) conflict = true;
        else {
          const updatedAt = new Date(Math.max(Date.now(), (Date.parse(stored.updatedAt ?? stored.createdAt) || 0) + 1)).toISOString();
          Object.assign(stored, content, { images: attached, updatedAt, lastEditId: editId });
        }
      }
      // Durable document overlays are only valid inside this transaction.
      idea = JSON.parse(JSON.stringify(stored));
    });
    if (!idea) return c.json({ error: '这篇笔记已被删除，请另存为新笔记' }, 404);
    if (conflict) return c.json({ error: '这篇笔记已在另一台设备修改。你的草稿已保留，请重新打开后核对。' }, 409);
    return c.json(idea);
  });
  app.post('/api/idea-images', async c => c.json(await images.save(await c.req.json()), 201));
  app.get('/api/idea-images/:id', async c => {
    const image = await images.read(c.req.param('id'));
    c.header('Content-Type', image.mediaType);
    return c.body(image.data);
  });
  app.delete('/api/ideas/:id', async c => { await engine.mutate(s => { s.ideas = s.ideas.filter(i => i.id !== c.req.param('id')); }); return c.json({ ok: true }); });
  app.post('/api/projects', async c => {
    const body = await c.req.json(); const changes = projectChanges(body); const path = text(body.path, '项目目录', 4096);
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('请选择主机上存在的绝对目录');
    const project = { id: randomUUID(), path: await realpath(path), context: '', ...changes };
    await engine.mutate(s => { if (s.projects.some(p => p.path === project.path)) throw new Error('这个目录已经添加'); s.projects.push(project); }); return c.json(project, 201);
  });
  app.put('/api/projects/:id', async c => {
    const changes = projectChanges(await c.req.json());
    await engine.mutate(s => { const p = s.projects.find(p => p.id === c.req.param('id')); if (!p) throw new Error('项目不存在'); Object.assign(p, changes); });
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/git', async c => {
    const project = (await engine.snapshot()).projects.find(p => p.id === c.req.param('id'));
    if (!project) return c.json({ error: '项目不存在' }, 404);
    return c.json(await workspaceOptions(project.path));
  });
  app.post('/api/memories', async c => {
    const body = await c.req.json(); const memory = { id: typeof body.id === 'string' ? body.id : randomUUID(), text: text(body.text, '记忆', 4000), updatedAt: new Date().toISOString() };
    await engine.mutate(s => { const index = s.memories.findIndex(m => m.id === memory.id); if (index >= 0) s.memories[index] = memory; else if (s.memories.length < 100) s.memories.push(memory); else throw new Error('第一版最多支持 100 条显式记忆'); }); return c.json(memory);
  });
  app.delete('/api/memories/:id', async c => { await engine.mutate(s => { s.memories = s.memories.filter(m => m.id !== c.req.param('id')); }); return c.json({ ok: true }); });
  app.post('/api/tasks', async c => {
    const body = await c.req.json();
    if (body.agent && !['friday', 'codex', 'claude'].includes(body.agent)) throw new Error('当前支持 Claude 和 Codex 本地执行，其他 Agent 尚未接入');
    const mode = body.mode ?? 'auto';
    if (!['auto', 'assistant', 'research', 'code'].includes(mode)) throw new Error('任务类型无效');
    const id = await engine.createTask({ prompt: text(body.prompt, '任务要求'), projectId: body.projectId ? text(body.projectId, '项目 ID', 80) : null, mode, agent: body.agent ?? 'friday', model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), requestId: text(body.requestId, '请求 ID', 100), ideaId: typeof body.ideaId === 'string' ? body.ideaId : undefined, workspace: workspaceSelection(body.workspace) });
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
  app.get('/api/tasks/:id/git', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json(await workspaceOptions(task.cwd));
  });
  app.post('/api/tasks/:id/branch', async c => {
    const body = await c.req.json();
    const branch = workspaceSelection({ mode: 'checkout', branch: text(body.branch, '分支', 1024) })!.branch!;
    const id = await engine.switchTaskBranch(c.req.param('id'), branch, text(body.requestId, '请求 ID', 100));
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/cancel', async c => { await engine.cancel(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/tasks/:id/message', async c => {
    const body = await c.req.json(); const prompt = text(body.text, '补充要求'); const requestId = text(body.requestId, '请求 ID', 100);
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task) throw new Error('任务不存在');
    if (activeStatuses.includes(task.status)) {
      if (body.model !== undefined || body.reasoningEffort !== undefined) throw new Error('请在当前执行结束后切换模型');
      await engine.steer(task.id, prompt, requestId);
    }
    else await engine.createTask({ prompt, requestId, projectId: task.projectId, mode: task.mode, continueId: task.id, model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort) });
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
