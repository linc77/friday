import type { TaskContextScope } from './task-context-types.js';
import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import { openTaskMedia, taskMediaResponse } from './task-media.js';
import { fileContentSecurityPolicy } from './task-file-assets.js';
import { TaskHostEditors } from './task-host-editors.js';

export function installContextAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine, hostEditors = new TaskHostEditors(engine)) {
  app.put('/api/task-files/document', async c => c.json(await engine.fileWrites.save(await c.req.json())));
  app.get('/api/task-files/saves/:id', async c => c.json(await engine.fileWrites.status(c.req.param('id'), source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')))));
  app.on(['GET', 'HEAD'], '/api/tasks/:id/media', async c => {
    const task = (await engine.snapshot()).tasks.find(task => task.id === c.req.param('id') && task.agent !== 'friday');
    if (!task) return c.json({ error: '图片所属的本地任务不存在' }, 404);
    const file = await openTaskMedia(c.req.query('path'), task.cwd, { directory: engine.directory, workspace: task.executionWorkspace });
    return taskMediaResponse(file, { method: c.req.method, range: c.req.header('Range'), ifNoneMatch: c.req.header('If-None-Match'), signal: c.req.raw.signal });
  });
  const source = (taskId?: string, projectId?: string, preparationId?: string) => ({ ...(taskId !== undefined ? { taskId, ...(projectId !== undefined ? { projectId } : {}) } : { projectId }), ...(preparationId !== undefined ? { preparationId } : {}) }) as TaskContextScope;
  app.get('/api/task-files/editors', async c => c.json(await hostEditors.snapshot(source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')), c.req.query('workspaceRoot'))));
  app.post('/api/task-files/open', async c => c.json(await hostEditors.open(await c.req.json())));
  app.post('/api/task-contexts', async c => {
    const body = await c.req.json(); const reference = await engine.contexts.capture(body);
    return c.json({ ...reference, snapshot: await engine.contexts.read(reference.id, body.scope) }, 201);
  });
  app.post('/api/task-contexts/browser-annotation', async c => {
    const body = await c.req.json(), reference = await engine.contexts.capture({ ...body, kind: 'preview-annotation' });
    return c.json({ ...reference, snapshot: await engine.contexts.read(reference.id, body.scope) }, 201);
  });
  app.get('/api/task-contexts/:id', async c => c.json(await engine.contexts.read(c.req.param('id'), source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')))));
  app.get('/api/task-files', async c => {
    const owner = await engine.contexts.owner(source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')));
    if (c.req.query('search') !== undefined) return c.json(await owner.files.search(c.req.query('search')!));
    return c.json(await owner.files.list(c.req.query('path') ?? ''));
  });
  app.get('/api/task-files/preview', async c => {
    const owner = await engine.contexts.owner(source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')));
    const start = c.req.query('lineStart'); const end = c.req.query('lineEnd');
    return c.json(await owner.files.read(c.req.query('path'), start === undefined ? undefined : Number(start), end === undefined ? undefined : Number(end)));
  });
  app.get('/api/task-files/document', async c => {
    const owner = await engine.contexts.owner(source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')));
    return c.json(await owner.files.document(c.req.query('path')));
  });
  app.on(['GET', 'HEAD'], '/api/task-files/content', async c => {
    const owner = await engine.contexts.owner(source(c.req.query('taskId'), c.req.query('projectId'), c.req.query('preparationId')));
    const file = await owner.files.open(c.req.query('path'));
    const contentSecurityPolicy = fileContentSecurityPolicy(file.mimeType);
    return taskMediaResponse(file, { method: c.req.method, range: c.req.header('Range'), signal: c.req.raw.signal, contentSecurityPolicy });
  });
}
