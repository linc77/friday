import { providerOptionSelections } from './provider-models.js';
import { providerDrivers, providerInstanceID, taskProviderInstance } from './provider-instances.js';
import { publicProviderState } from './provider-public-state.js';
import { ProjectRepositoryIdentities } from './project-repository-identities.js';
import { usagePoolSnapshot } from './usage-limit-pools.js';
import { isApprovalDecision } from './provider-approvals.js';
import { installProjectScriptAPI } from './project-script-api.js';
import { creationSelection } from './task-change-request-creation.js';
import { installTaskHostBrowserAPI } from './task-host-browser-api.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import type { Engine } from './engine.js';
import { Auth } from './auth.js';
import { discoverAgents } from './agents.js';
import { runningFork, activeGitOperation, activeRewind, activeStatuses, failedWorkspacePreparation, type TaskGitAction, type TaskRewindOperation } from './types.js';
import { IdeaImages, ideaContent, maxImageBytes } from './ideas.js';
import type { Idea } from './types.js';
import { projectChanges } from './projects.js';
import { TaskGitContexts, gitRefreshInterval } from './git-context.js';
import { ServiceMaintenance } from './maintenance.js';
import { TextGenerationSettingsConflict } from './text-generation-settings.js';
import { workspaceOptions, workspaceSelection } from './task-workspace.js';
import { taskMetadataChange } from './task-metadata.js';
import { taskSidebarMove, TaskSidebarOrderConflict } from './task-sidebar-order.js';
import { TaskSettlementSettingsConflict } from './task-settlement.js';
import { ChangeRequestLinksConflict } from './task-change-request-links.js';
import { installSourceControlPreferencesAPI } from './source-control-preferences.js';
import { changeScope, readTaskChanges, readTaskDiff } from './task-changes.js';
import { saveTaskPlan, taskInteractionMode } from './task-plans.js';
import { TaskGitStatuses } from './task-git-status.js';
import { discoverPublishProviders, repositoryPublishInput } from './task-repository-publish.js';
import { SourceControlCredentialConflict } from './source-control-credentials.js';
import { installChangeRequestAPI } from './task-change-request-api.js';
import { sourceControlRateFailure } from './source-control-request-policy.js';
import { branchBlocksTask } from './branch-switch.js';
import { installTerminalAPI } from './terminal-api.js';
import { installContextAPI } from './context-api.js';
import { installTaskFileAssets } from './task-file-assets.js';
import { installGitHubMediaAssets } from './github-media-assets.js';
import { contextIDs } from './task-context-types.js';
import { compactTaskEvent, compactTaskOutputs } from './task-output.js';
import { compactTask } from './task-compaction.js';
import { composerUsageLimits } from './provider-usage-limits.js';
import { composerWorkspace } from './provider-workspace.js';
import { installTaskOutputAPI } from './task-output-api.js';
import { installTaskStreamAPI } from './task-stream-api.js';
import { installTaskSearchAPI } from './task-search-api.js';
import { citationPromptLength } from './assistant-citations.js';
import { installTaskBrowserAPI } from './task-browser-api.js';

function text(value: unknown, name: string, max = 12_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}不能为空，且长度不能超过 ${max}`);
  return value.trim();
}
function optionalModel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 120 || /[\x00-\x1f]/.test(value)) throw new Error('模型或推理强度无效');
  return value;
}
function taskPrompt(value: unknown, images: unknown): string {
  if (typeof value === 'string' && value.length <= 12_000 && !value.trim() && Array.isArray(images) && images.length) return '';
  if (typeof value === 'string' && value.trim() && value.length <= 256 * 1024 && citationPromptLength(value) <= 12_000) return value.trim();
  return text(value, '任务要求');
}
export function createAPI(engine: Engine, auth: Auth, agents = discoverAgents, integrations: { hostEditors?: import('./task-host-editors.js').TaskHostEditors; browserDiscovery?: import('./task-browser.js').TaskBrowserDiscovery; hostBrowsers?: import('./task-host-browser.js').TaskHostBrowsers } = {}) {
  const app = new Hono<{ Variables: { device: string } }>();
  const images = new IdeaImages(engine.directory);
  const gitContexts = new TaskGitContexts();
  const projectIdentities = new ProjectRepositoryIdentities();
  const taskGitStatuses = new TaskGitStatuses(engine.directory, engine.sourceControl);
  engine.once('closing', () => taskGitStatuses.close());
  const maintenance = new ServiceMaintenance(() => engine.snapshot());
  const normalLimit = bodyLimit({ maxSize: 256 * 1024 });
  const changeRequestLimit = bodyLimit({ maxSize: 8 * 1024 * 1024 });
  const browserAnnotationLimit = bodyLimit({ maxSize: 16 * 1024 * 1024 });
  const fileEditLimit = bodyLimit({ maxSize: 6 * 1024 * 1024 + 8192 });
  const noteLimit = bodyLimit({ maxSize: 1024 * 1024 });
  const imageLimit = bodyLimit({ maxSize: Math.ceil(maxImageBytes / 3) * 4 + 4096 });
  app.use('*', (c, next) => c.req.path === '/api/task-browser/host/upload' ? next() : c.req.path === '/api/task-contexts/browser-annotation' ? browserAnnotationLimit(c, next) : c.req.path === '/api/idea-images' ? imageLimit(c, next) : c.req.path === '/api/task-files/document' && c.req.method === 'PUT' ? fileEditLimit(c, next) : c.req.path.startsWith('/api/ideas') ? noteLimit(c, next) : /^\/api\/tasks\/[^/]+\/change-request\/operations$/.test(c.req.path) ? changeRequestLimit(c, next) : normalLimit(c, next));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin && !c.req.path.startsWith('/file-assets/')) return c.json({ error: '不允许跨站访问' }, 403);
    if (['POST', 'PUT', 'PATCH'].includes(c.req.method) && !(c.req.path === '/api/task-browser/host/upload' && c.req.method === 'POST' ? c.req.header('Content-Type')?.startsWith('multipart/form-data;') : c.req.header('Content-Type')?.startsWith('application/json'))) return c.json({ error: c.req.path === '/api/task-browser/host/upload' ? '上传需要使用 multipart/form-data' : '请求需要使用 JSON' }, 415);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ChangeRequestLinksConflict) return c.json({ error: error.message, revision: error.revision }, 409);
    const limited = sourceControlRateFailure(error);
    if (limited) {
      if (limited.retryAt !== undefined) c.header('Retry-After', String(Math.max(0, Math.ceil((limited.retryAt - Date.now()) / 1000))));
      return c.json({ error: error.message || '仓库平台请求暂缓', reason: 'rate-limited', ...(limited.retryAt !== undefined ? { retryAt: limited.retryAt } : {}) }, 429);
    }
    return c.json({ error: error.message || '请求失败' }, 400);
  });
  app.use('*', async (c, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path === '/api/service/update') return next();
    let leave: () => void;
    try { leave = maintenance.enterWrite(); }
    catch (error) { return c.json({ error: (error as Error).message }, 503); }
    try { await next(); } finally { leave(); }
  });
  app.get('/health', c => c.json({ name: 'Friday', version: process.env.FRIDAY_APP_VERSION ?? '0.1.0', build: process.env.FRIDAY_SERVICE_BUILD ?? null, status: 'ok' }));
  app.post('/pair', async c => {
    const body = await c.req.json();
    const address = (c.env as any)?.incoming?.socket?.remoteAddress ?? 'local';
    return c.json(auth.pair(text(body.code, '配对码', 6), text(body.name, '设备名称', 80), address));
  });
  const githubMediaAssets = installGitHubMediaAssets(app, engine, auth);
  const fileAssets = installTaskFileAssets(app, engine, auth);
  app.use('/api/*', async (c, next) => {
    const device = auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''));
    if (!device) return c.json({ error: '请先连接或配对设备' }, 401);
    c.set('device', device); await next();
  });
  installTerminalAPI(app, engine, auth);
  installContextAPI(app, engine, integrations.hostEditors);
  app.post('/api/task-files/asset-url', async c => c.json(await fileAssets.issue(c.get('device'), await c.req.json())));
  app.post('/api/task-media/github/asset-url', async c => c.json(await githubMediaAssets.issue(c.get('device'), await c.req.json(), Date.now(), c.req.raw.signal)));
  installTaskOutputAPI(app, engine, auth);
  installTaskStreamAPI(app, engine, auth, agents, projectIdentities);
  installTaskSearchAPI(app, engine, auth);
  installTaskBrowserAPI(app, engine, integrations.browserDiscovery);
  installTaskHostBrowserAPI(app, engine, auth, integrations.hostBrowsers);
  app.get('/api/state', async c => {
    const state = publicProviderState(await projectIdentities.snapshot(await gitContexts.snapshot(await engine.snapshot())));
    const projected = c.req.query('history') === 'turns' ? await engine.conversationHistory.snapshot(state, c.req.query('compactItems') === '1', c.req.query('itemHistory') === '1') : state;
    return c.json({ ...(c.req.query('compactItems') === '1' ? compactTaskOutputs(projected) : projected), agents: agents(), devices: auth.devices(), deviceId: c.get('device'), serviceId: auth.serviceId, notesVersion: 1 });
  });
  app.post('/api/service/update', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以安装更新' }, 403);
    try { await maintenance.prepare(); return c.json({ ready: true }); }
    catch (error) { return c.json({ error: (error as Error).message }, 409); }
  });
  app.delete('/api/service/update', c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以取消更新' }, 403);
    maintenance.cancel(); return c.json({ ok: true });
  });
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
  app.get('/api/provider-instances', async c => c.json({ instances: await engine.providerInstances.list() }));
  app.put('/api/provider-instances', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '请在主机配置 Provider 实例' }, 403);
    return c.json({ instances: await engine.providerInstances.change(await c.req.json()) });
  });
  for (const provider of providerDrivers) {
    const endpoint = `/api/agents/${provider}`, get = (id?: string) => engine.providerInstances.get(provider, id ?? provider);
    app.get(endpoint, async c => c.json(await engine.providerInstances.status(provider, c.req.query('instanceId') ?? provider, c.get('device') === 'owner')));
    app.use(endpoint + '/*', async (c, next) => {
      if (c.get('device') !== 'owner') return c.json({ error: '请在主机的 Providers 中配置此工具' }, 403);
      const id = providerInstanceID(c.req.query('instanceId') ?? provider);
      await get(id);
      const metadata = c.req.path.endsWith('/check') || c.req.path.endsWith('/registry/search') || c.req.method === 'GET';
      if (!metadata) {
        const state = await engine.snapshot();
        const peers = c.req.path.endsWith('/login') || c.req.path.endsWith('/logout') ? await engine.providerInstances.credentialPeers(provider, id) : [id];
        if (state.tasks.some(task => peers.includes(taskProviderInstance(task)) && (activeStatuses.includes(task.status) || activeGitOperation(task.gitOperation) || activeRewind(task.rewindOperation) || runningFork(task.forkOperation)) || activeGitOperation(task.gitOperation) && (task.gitOperation?.generationModelSelection?.providerInstanceId ?? task.gitOperation?.generationModelSelection?.agent) === id)
          || Object.values(state.titleRequests ?? {}).some(request => request.status === 'pending' && (request.modelSelection?.providerInstanceId ?? request.modelSelection?.agent) === id)
          || state.tasks.some(task => task.changeRequestGuideRuns?.some(run => ['queued', 'running'].includes(run.status) && (run.modelSelection.providerInstanceId ?? run.modelSelection.agent) === id))) return c.json({ error: '请先停止此实例的任务并处理会话操作再修改配置' }, 409);
      }
      await next();
    });
    app.put(endpoint + '/settings', async c => c.json(await (await get(c.req.query('instanceId'))).save(await c.req.json())));
    app.post(endpoint + '/check', async c => c.json(await engine.providerInstances.status(provider, c.req.query('instanceId') ?? provider, true, true)));
    if (provider === 'codex' || provider === 'cursor') app.post(endpoint + '/login', async c => c.json(await (await engine.providerInstances.get(provider, c.req.query('instanceId') ?? provider)).login()));
    if (provider !== 'acp-registry' && provider !== 'antigravity') continue;
    const getAcp = (id?: string) => engine.providerInstances.get(provider, id ?? provider);
    app.get(endpoint + '/login', async c => c.json((await getAcp(c.req.query('instanceId'))).loginState()));
    app.get(endpoint + '/login/events', async c => { const connection = await getAcp(c.req.query('instanceId'));
      const flowId = c.req.query('flowId');
      if (!flowId || flowId.length > 128 || !('flowId' in connection.loginState()) || (connection.loginState() as { flowId?: string }).flowId !== flowId) return c.json({ error: '认证流程已改变，请刷新后重试' }, 409);
      return streamSSE(c, async stream => {
        let dirty = true, wake: (() => void) | undefined;
        const unsubscribe = connection.subscribeLogin(flowId, () => { dirty = true; wake?.(); });
        stream.onAbort(() => wake?.());
        try {
          while (!stream.aborted) {
            if (dirty) {
              dirty = false; const state = connection.loginState();
              if (!('flowId' in state) || state.flowId !== flowId) return;
              await stream.writeSSE({ event: 'auth', data: JSON.stringify(state) });
              if (!state.pending) return;
            }
            let timer: NodeJS.Timeout | undefined;
            await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 15000); if (dirty || stream.aborted) resolve(); });
            clearTimeout(timer); wake = undefined;
            if (!dirty && !stream.aborted) await stream.writeSSE({ event: 'ping', data: '{}' });
          }
        } finally { unsubscribe(); }
      });
    });
    app.get(endpoint + '/login/methods', async c => { const connection = await getAcp(c.req.query('instanceId')); return c.json(await connection.authenticationMethods()); });
    app.post(endpoint + '/login', async c => { const connection = await getAcp(c.req.query('instanceId')); const raw = await c.req.text(), body = raw ? JSON.parse(raw) : {}; if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('认证请求格式无效'); if (body.methodId !== undefined && (typeof body.methodId !== 'string' || body.methodId.length > 128)) throw new Error('认证方式标识无效'); return c.json(await connection.login(body.methodId)); });
    app.post(endpoint + '/login/respond', async c => { const connection = await getAcp(c.req.query('instanceId')); return c.json(connection.respondLogin(await c.req.json())); });
    app.post(endpoint + '/logout', async c => { const connection = await getAcp(c.req.query('instanceId')); return c.json(await connection.logout()); });
    app.post(endpoint + '/login/cancel', async c => { const connection = await getAcp(c.req.query('instanceId')); const raw = await c.req.text(), body = raw ? JSON.parse(raw) : {}; if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('认证请求格式无效'); if (body.flowId !== undefined && (typeof body.flowId !== 'string' || body.flowId.length > 128)) throw new Error('认证流程标识无效'); return c.json(await connection.cancelLogin(body.flowId)); });
    app.get(endpoint + '/install', async c => { const connection = await getAcp(c.req.query('instanceId')); return c.json(await connection.installState()); });
    app.post(endpoint + '/install', async c => { const connection = await getAcp(c.req.query('instanceId')); return c.json(await connection.startInstall()); });
    app.post(endpoint + '/install/cancel', async c => { const connection = await getAcp(c.req.query('instanceId')); const body = await c.req.json(); if (typeof body.operationId !== 'string' || body.operationId.length > 128) throw new Error('工具安装操作标识无效'); return c.json(await connection.cancelInstall(body.operationId)); });
  }
  app.post('/api/agents/acp-registry/registry/search', async c => { const body = await c.req.json(); if (typeof body.query !== 'string') throw new Error('ACP Registry 搜索内容无效'); return c.json(await (await engine.providerInstances.get('acp-registry', c.req.query('instanceId') ?? 'acp-registry')).registry.search(body.query, body.reload === true)); });
  app.get('/api/text-generation/settings', async c => c.json(await engine.textGeneration.snapshot(c.req.query('projectId') ?? null)));
  installSourceControlPreferencesAPI(app, engine);
  app.get('/api/task-settlement/settings', async c => c.json(await engine.taskSettlement.snapshot(c.req.query('projectId') ?? null)));
  app.patch('/api/task-settlement/settings', async c => {
    try { return c.json(await engine.taskSettlement.save(await c.req.json())); }
    catch (error) { if (error instanceof TaskSettlementSettingsConflict) return c.json({ error: error.message, version: error.version }, 409); throw error; }
  });
  app.patch('/api/text-generation/settings', async c => {
    try { return c.json(await engine.textGeneration.save(await c.req.json())); }
    catch (error) { if (error instanceof TextGenerationSettingsConflict) return c.json({ error: error.message, version: error.version }, 409); throw error; }
  });
  app.get('/api/events', c => streamSSE(c, async stream => {
    let dirty = true; let ended = false; let nextGitRefresh = 0; let previousGit = '';
    const changed = () => { dirty = true; };
    engine.on('change', changed); stream.onAbort(() => { ended = true; engine.off('change', changed); });
    try {
      while (!ended) {
        if (!auth.identify(c.req.header('Authorization')?.replace(/^Bearer /, ''))) break;
        if (dirty || Date.now() >= nextGitRefresh) {
          const stateChanged = dirty; dirty = false;
          const state = publicProviderState(await projectIdentities.snapshot(await gitContexts.snapshot(await engine.snapshot())));
          nextGitRefresh = Date.now() + gitRefreshInterval;
          const currentGit = JSON.stringify(state.tasks.map(task => [task.id, task.git]));
          if (stateChanged || currentGit !== previousGit) {
            const transport = c.req.query('history') === 'turns' ? await engine.conversationHistory.snapshot(state, c.req.query('compactItems') === '1', c.req.query('itemHistory') === '1') : state;
            await stream.writeSSE({ event: 'snapshot', id: String(state.revision), data: JSON.stringify({ ...(c.req.query('compactItems') === '1' ? compactTaskOutputs(transport) : transport), serviceId: auth.serviceId }) });
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
  app.post('/api/projects/scratch', async c => c.json(await engine.ensureScratchProject()));
  app.get('/api/project-repositories/providers',async c=>c.json({providers:await engine.projectRepositories.providers()}));
  app.post('/api/project-repositories/lookup',async c=>c.json(await engine.projectRepositories.lookup(await c.req.json(),c.req.raw.signal)));
  app.post('/api/projects/clone',async c=>c.json(await engine.projectRepositories.clone(await c.req.json()),201));
  app.post('/api/projects/:id/publish',async c=>c.json({operationId:await engine.projectRepositories.publish(c.req.param('id'),await c.req.json())},201));
  app.get('/api/project-repository-operations/:operationId',async c=>c.json(await engine.projectRepositories.get(c.req.param('operationId'))));
  app.post('/api/projects/:id/repository-operations/:operationId/cancel',async c=>c.json({cancelled:await engine.projectRepositories.cancel(c.req.param('id'),c.req.param('operationId'))}));
  app.post('/api/projects/:id/clone/:operationId/retry',async c=>{const body=await c.req.json();return c.json({operationId:await engine.projectRepositories.retry(c.req.param('id'),c.req.param('operationId'),body.requestId)},201);});
  app.post('/api/projects/managed', async c => { const result=await engine.managedProjects.create(await c.req.json());return c.json(result,result.status==='created'?201:200); });
  app.get('/api/projects/managed/:requestId', async c => c.json(await engine.managedProjects.status(c.req.param('requestId'))));
  app.post('/api/projects/managed/:requestId/cancel', async c => c.json(await engine.managedProjects.cancel(c.req.param('requestId'))));
  app.post('/api/projects', async c => {
    const body = await c.req.json(); const changes = projectChanges(body); const path = text(body.path, '项目目录', 4096);
    if (!isAbsolute(path) || !(await stat(path)).isDirectory()) throw new Error('请选择主机上存在的绝对目录');
    const createdAt = new Date().toISOString();
    const project = { id: randomUUID(), path: await realpath(path), context: '', ...changes, createdAt, updatedAt: createdAt };
    if (engine.managedProjects.isCreatingPath(project.path)) throw new Error('此目录正在创建项目，请等待完成');
    const managedFolder=await engine.managedProjects.knownFolder(project.path);
    const registered={...project,...(managedFolder?{managedFolder}:{})};
    await engine.mutate(s => { if (s.projects.some(p => p.path === project.path)) throw new Error('这个目录已经添加'); s.projects.push(registered); }); return c.json(registered, 201);
  });
  app.put('/api/projects/:id', async c => {
    const changes = projectChanges(await c.req.json());
    await engine.mutate(s => { const p = s.projects.find(p => p.id === c.req.param('id')); if (!p) throw new Error('项目不存在'); Object.assign(p, changes, { updatedAt: new Date().toISOString() }); });
    return c.json({ ok: true });
  });
  app.delete('/api/projects/:id', async c => {
    const id = c.req.param('id');
    await engine.projectRepositories.discard(id);
    await engine.mutate(s => {
      s.projects = s.projects.filter(p => p.id !== id);
      if (s.textGenerationSettings && Object.hasOwn(s.textGenerationSettings.projects, id)) { delete s.textGenerationSettings.projects[id]; s.textGenerationSettings.version++; }
      if (s.taskSettlementSettings && Object.hasOwn(s.taskSettlementSettings.projects, id)) { delete s.taskSettlementSettings.projects[id]; s.taskSettlementSettings.version++; }
      if (s.sourceControlPreferences && Object.hasOwn(s.sourceControlPreferences.projects, id)) { delete s.sourceControlPreferences.projects[id]; s.sourceControlPreferences.version++; }
    });
    return c.json({ ok: true });
  });
  app.get('/api/projects/:id/git', async c => {
    const state = await engine.snapshot(), project = state.projects.find(p => p.id === c.req.param('id'));
    if (!project) return c.json({ error: '项目不存在' }, 404);
    const { resolveSourceControlPreferences } = await import('./source-control-preferences.js');
    return c.json({ ...await workspaceOptions(project.path), preparationDefaults: resolveSourceControlPreferences(state, project.id).effective });
  });
  app.post('/api/memories', async c => {
    const body = await c.req.json(); const memory = { id: typeof body.id === 'string' ? body.id : randomUUID(), text: text(body.text, '记忆', 4000), updatedAt: new Date().toISOString() };
    await engine.mutate(s => { const index = s.memories.findIndex(m => m.id === memory.id); if (index >= 0) s.memories[index] = memory; else if (s.memories.length < 100) s.memories.push(memory); else throw new Error('第一版最多支持 100 条显式记忆'); }); return c.json(memory);
  });
  app.delete('/api/memories/:id', async c => { await engine.mutate(s => { s.memories = s.memories.filter(m => m.id !== c.req.param('id')); }); return c.json({ ok: true }); });
  app.post('/api/tasks', async c => {
    const body = await c.req.json();
    if (body.agent && !['friday', 'codex', 'claude', 'pi', 'grok', 'cursor', 'muse', 'opencode', 'acp-registry', 'antigravity'].includes(body.agent)) throw new Error('此 Agent 尚未接入任务执行');
    const mode = body.mode ?? 'auto';
    if (!['auto', 'assistant', 'research', 'code'].includes(mode)) throw new Error('任务类型无效');
    const attached = await images.validate(body.images);
    const id = await engine.createTask({ prompt: taskPrompt(body.prompt, attached), images: attached, contextIds: contextIDs(body.contextIds), projectId: body.projectId ? text(body.projectId, '项目 ID', 80) : null, mode, agent: body.agent ?? 'friday', providerInstanceId: body.providerInstanceId === undefined ? undefined : providerInstanceID(body.providerInstanceId), model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions), interactionMode: taskInteractionMode(body.interactionMode), requestId: text(body.requestId, '请求 ID', 100), ideaId: typeof body.ideaId === 'string' ? body.ideaId : undefined, workspace: workspaceSelection(body.workspace) });
    return c.json({ id }, 201);
  });
  app.post('/api/composer/capabilities', async c => {
    const body = await c.req.json();
    if (body.reload !== undefined && typeof body.reload !== 'boolean') throw new Error('刷新参数无效');
    const optional = (key: string) => body[key] === undefined ? undefined : text(body[key], '执行范围', 200);
    return c.json(await composerWorkspace(engine, { provider: text(body.provider, '执行器', 20), providerInstanceId: body.providerInstanceId === undefined ? undefined : providerInstanceID(body.providerInstanceId), taskId: optional('taskId'), projectId: optional('projectId'),
      preparationId: optional('preparationId'), reuseTaskId: optional('reuseTaskId'), reload: body.reload === true }));
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
        if (!project) { const createdAt = new Date().toISOString(); project = { id: randomUUID(), name: basename(resolved) || resolved, path: resolved, context: '', createdAt, updatedAt: createdAt }; s.projects.push(project); }
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
  app.get('/api/tasks/:id/changes', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json(await readTaskChanges(task.cwd, changeScope(c.req.query('scope')), { directory: engine.directory, workspace: task.executionWorkspace }));
  });
  app.get('/api/tasks/:id/runs/:runId/diff', async c => {
    const task = (await engine.snapshot()).tasks.find(task => task.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json(await engine.taskRuns.diff(task, c.req.param('runId'), c.req.query('path') ?? ''));
  });
  app.get('/api/tasks/:id/rewind/options', async c => c.json(await engine.taskRewinds.options(c.req.param('id'), text(c.req.query('messageId'), '消息 ID', 100))));
  app.get('/api/tasks/:id/history', async c => {
    const page = await engine.taskHistory.page(c.req.param('id'), c.req.query('before'), c.req.query('limit') === undefined ? undefined : Number(c.req.query('limit')),
      c.req.query('beforePosition') === undefined ? undefined : { beforePosition: Number(c.req.query('beforePosition')), epoch: text(c.req.query('epoch'), '历史版本', 100) });
    return c.json(c.req.query('compactItems') === '1' ? { ...page, events: page.events.map(compactTaskEvent) } : page);
  });
  app.get('/api/tasks/:id/conversation-history', async c => {
    const page = await engine.conversationHistory.page(c.req.param('id'), text(c.req.query('before'), '历史游标', 4096), c.req.query('through'), c.req.query('compactItems') === '1');
    return c.json(c.req.query('compactItems') === '1' ? { ...page, events: page.events.map(compactTaskEvent) } : page);
  });
  app.post('/api/tasks/:id/history/events', async c => {
    const body = await c.req.json(); const page = await engine.taskHistory.eventItems(c.req.param('id'), body.ids);
    return c.json(body.compactItems === true ? { ...page, events: page.events.map(compactTaskEvent) } : page);
  });
  app.post('/api/tasks/:id/runs/:runId/preparation/retry', async c => {
    const body = await c.req.json();
    return c.json({ id: await engine.taskPreparations.retry(c.req.param('id'), c.req.param('runId'), text(body.requestId, '请求 ID', 100)) }, 202);
  });
  app.post('/api/tasks/:id/fork', async c => {
    const body = await c.req.json();
    const id = await engine.taskForks.start(c.req.param('id'), { requestId: text(body.requestId, '请求 ID', 100), runId: text(body.runId, '轮次 ID', 100), ...(body.title !== undefined ? { title: text(body.title, '分叉名称', 200) } : {}) });
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/compact', async c => {
    const body = await c.req.json();
    const id = await compactTask(engine, c.req.param('id'), { requestId: text(body.requestId, '请求 ID', 100), threadId: text(body.threadId, '原生会话 ID', 200) });
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/feedback', async c => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['threadId','command','requestId'].includes(key))) throw new Error('反馈提交格式无效');
    const { requestId, taskId, threadId, command, status, createdAt, completedAt, feedbackId, error } = await engine.taskFeedback.start(c.req.param('id'), { threadId: text(body.threadId, '原生会话 ID', 200), command: text(body.command, '反馈命令', 12_000), requestId: text(body.requestId, '请求 ID', 100) });
    return c.json({ requestId, taskId, threadId, command, status, createdAt, completedAt, feedbackId, error });
  });
  app.post('/api/composer/usage-limits', async c => {
    const body = await c.req.json();
    if (body.reload !== undefined && typeof body.reload !== 'boolean') throw new Error('刷新参数无效');
    return c.json(await composerUsageLimits(engine, { provider: text(body.provider, '执行器', 20), providerInstanceId: body.providerInstanceId === undefined ? undefined : providerInstanceID(body.providerInstanceId), taskId: body.taskId === undefined ? undefined : text(body.taskId, '任务 ID', 100), reload: body.reload === true }));
  });
  app.post('/api/composer/reset-credit', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以使用账号重置凭证。' }, 403);
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['provider', 'fingerprint', 'requestId', 'confirmed'].includes(key))) throw new Error('配额重置请求无效。');
    return c.json(await engine.providerCreditResets.start({ provider: text(body.provider, '执行器', 20), fingerprint: text(body.fingerprint, '账号标识', 64), requestId: text(body.requestId, '请求 ID', 100), confirmed: body.confirmed === true }));
  });
  app.get('/api/usage-limit-sources/settings', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以管理额度来源。' }, 403);
    return c.json(await engine.usageLimitSources.configuration());
  });
  app.get('/api/usage-limits', async c => c.json(usagePoolSnapshot(await engine.snapshot(), c.get('device') === 'owner')));
  app.post('/api/usage-limit-sources/settings', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以管理额度来源。' }, 403);
    return c.json(await engine.usageLimitSources.save(await c.req.json()));
  });
  app.post('/api/usage-limit-sources/refresh', async c => { await engine.usageLimitSources.refresh(); return c.json({ sources: (await engine.snapshot()).usageLimitSources ?? [] }); });
  app.post('/api/usage-limit-sources/reset-credit', async c => {
    if (c.get('device') !== 'owner') return c.json({ error: '只有主机可以使用账号重置次数。' }, 403);
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sourceId','accountId','creditId','fingerprint','requestId','confirmed'].includes(key))) throw new Error('额度重置请求无效');
    return c.json(await engine.usageLimitSources.consume({ sourceId: text(body.sourceId, '来源 ID', 100), accountId: text(body.accountId, '账号 ID', 512), creditId: text(body.creditId, '重置 ID', 512), fingerprint: text(body.fingerprint, '账号标识', 64), requestId: text(body.requestId, '请求 ID', 100), confirmed: body.confirmed === true }));
  });
  app.post('/api/tasks/:id/fork/resolve', async c => {
    const body = await c.req.json();
    await engine.taskForks.resolve(c.req.param('id'), { requestId: text(body.requestId, '请求 ID', 100), action: text(body.action, '处理方式', 50) as 'inspect' | 'retry' | 'new_session' });
    return c.json({ ok: true }, 202);
  });
  app.post('/api/tasks/:id/rewind', async c => {
    const body = await c.req.json();
    if (typeof body.restoreFiles !== 'boolean') throw new Error('请选择是否恢复文件');
    if (body.newSession !== undefined && typeof body.newSession !== 'boolean') throw new Error('新会话选项无效');
    const id = await engine.taskRewinds.start(c.req.param('id'), { requestId: text(body.requestId, '请求 ID', 100), messageId: text(body.messageId, '消息 ID', 100), fingerprint: text(body.fingerprint, '历史版本', 100), restoreFiles: body.restoreFiles,
      ...(body.fileFingerprint !== undefined ? { fileFingerprint: text(body.fileFingerprint, '文件版本', 100) } : {}), ...(body.newSession ? { newSession: true } : {}) });
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/rewind/:operationId/resolve', async c => {
    const body = await c.req.json();
    await engine.taskRewinds.resolve(c.req.param('id'), c.req.param('operationId'), { requestId: text(body.requestId, '请求 ID', 100), action: text(body.action, '处理方式', 50) as NonNullable<TaskRewindOperation['resolution']>,
      ...(body.fileFingerprint !== undefined ? { fileFingerprint: text(body.fileFingerprint, '文件版本', 100) } : {}) });
    return c.json({ ok: true }, 202);
  });
  app.get('/api/tasks/:id/rewind/:operationId/files', async c => c.json(await engine.taskRewinds.fileReview(c.req.param('id'), c.req.param('operationId'))));
  app.get('/api/tasks/:id/git/status', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json(await taskGitStatuses.read(task.cwd, c.req.query('refresh') === 'true', task.executionWorkspace));
  });
  app.get('/api/source-control/settings', async c => c.json(await engine.sourceControl.credentials!.settings()));
  installChangeRequestAPI(app, engine);
  installProjectScriptAPI(app, engine);
  app.patch('/api/source-control/settings', async c => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new Error('Source Control 设置格式无效'); }
    try { const saved = await engine.sourceControl.credentials!.update(body); await engine.sourceControl.invalidate(); return c.json(saved); }
    catch (error) { if (error instanceof SourceControlCredentialConflict) return c.json({ error: error.message }, 409); throw error; }
  });
  app.get('/api/source-control/discovery', async c => c.json(await engine.sourceControl.discovery(engine.directory)));
  app.get('/api/tasks/:id/git/publish-providers', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json({ providers: await discoverPublishProviders(task.cwd, undefined, engine.sourceControl) });
  });
  app.post('/api/tasks/:id/git/change-request-context', async c => c.json(await engine.gitOperations.creationContext(c.req.param('id'), await c.req.json())));
  app.post('/api/tasks/:id/git/operations', async c => {
    const body = await c.req.json();
    if (!['commit', 'push', 'create_pr', 'commit_push', 'commit_push_pr', 'pull', 'publish_repository'].includes(body.action)) throw new Error('Git 操作类型无效');
    for (const key of ['featureBranch', 'confirmedDefaultBranch']) if (body[key] !== undefined && typeof body[key] !== 'boolean') throw new Error('Git 操作设置无效');
    if (body.filePaths !== undefined && (!Array.isArray(body.filePaths) || body.filePaths.length > 5000 || body.filePaths.some((path: unknown) => typeof path !== 'string'))) throw new Error('Git 文件选择无效');
    if (body.commitMessage !== undefined && (typeof body.commitMessage !== 'string' || body.commitMessage.length > 10_000 || body.commitMessage.includes('\0'))) throw new Error('提交说明无效');
    const operationId = await engine.gitOperations.start(c.req.param('id'), {
      requestId: text(body.requestId, 'Git 请求 ID', 100), action: body.action as TaskGitAction,
      fingerprint: text(body.fingerprint, '改动版本', 100), filePaths: body.filePaths,
      commitMessage: body.commitMessage, featureBranch: body.featureBranch,
      ...(body.branchName !== undefined ? { branchName: text(body.branchName, '分支名称', 200) } : {}), confirmedDefaultBranch: body.confirmedDefaultBranch,
      ...(body.creation !== undefined ? {creation:creationSelection(body.creation)} : {}),
      ...(body.action === 'publish_repository' ? { repositoryPublish: repositoryPublishInput(body.repositoryPublish) } : {}),
    });
    return c.json({ id: operationId }, 202);
  });
  app.get('/api/tasks/:id/git/operations/:operationId', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    const id = c.req.param('operationId');
    const operation = task?.gitOperation?.id === id ? task.gitOperation : task?.gitOperations?.find(operation => operation.id === id);
    if (!operation) return c.json({ error: 'Git 操作记录不存在' }, 404);
    return c.json(operation);
  });
  app.get('/api/tasks/:id/diff', async c => {
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    return c.json(await readTaskDiff(task.cwd, c.req.query('path') ?? '', changeScope(c.req.query('scope')), { directory: engine.directory, workspace: task.executionWorkspace }));
  });
  app.post('/api/tasks/:id/plan/save', async c => {
    const state = await engine.snapshot(); const task = state.tasks.find(t => t.id === c.req.param('id'));
    if (!task || task.agent === 'friday') return c.json({ error: '本地任务不存在' }, 404);
    if (branchBlocksTask(state, task.cwd)) throw new Error('工作区有 Git 操作正在进行，请完成后再保存方案');
    const body = await c.req.json();
    return c.json(await saveTaskPlan({ ...task, events: await engine.taskHistory.events(task) }, body.eventId, body.path));
  });
  app.post('/api/tasks/:id/plan/follow-up', async c => {
    const body = await c.req.json(); const attached = await images.validate(body.images);
    if (body.newThread !== undefined && typeof body.newThread !== 'boolean') throw new Error('实施位置无效');
    const refinement = body.text === undefined || body.text === '' ? '' : taskPrompt(body.text, attached);
    const id = await engine.followUpPlan(c.req.param('id'), text(body.eventId, '方案 ID', 300), {
      text: refinement, newThread: body.newThread === true, requestId: text(body.requestId, '请求 ID', 100), images: attached,
      contextIds: contextIDs(body.contextIds),
      model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions),
    });
    return c.json({ id }, 201);
  });
  app.post('/api/tasks/:id/branch', async c => {
    const body = await c.req.json();
    const branch = workspaceSelection({ mode: 'checkout', branch: text(body.branch, '分支', 1024) })!.branch!;
    const id = await engine.switchTaskBranch(c.req.param('id'), branch, text(body.requestId, '请求 ID', 100));
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/cancel', async c => {
    const raw = await c.req.text(); const body = raw ? JSON.parse(raw) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['runId', 'sessionId'].includes(key))) throw new Error('停止请求无效');
    const scope = { ...(body.runId !== undefined ? { runId: text(body.runId, '轮次', 100) } : {}), ...(body.sessionId !== undefined ? { sessionId: text(body.sessionId, '执行会话', 100) } : {}) };
    await engine.cancel(c.req.param('id'), scope); return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/preparation/cancel', async c => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['runId', 'attempt'].includes(key))) throw new Error('停止准备请求无效');
    return c.json(await engine.taskPreparations.cancel(c.req.param('id'), body.runId, body.attempt));
  });
  app.post('/api/tasks/:id/background/settle', async c => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sessionId', 'requestId', 'runId'].includes(key))) throw new Error('后台停止请求无效');
    const id = await engine.backgroundStops.start(c.req.param('id'), body.sessionId, body.requestId, text(body.runId, '轮次', 100));
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/subagents/:subagentId/stop', async c => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['sessionId', 'childTurnId', 'requestId'].includes(key))) throw new Error('子 Agent 停止请求无效');
    const id = await engine.subagents.stop(c.req.param('id'), c.req.param('subagentId'), text(body.sessionId, '执行会话', 100), text(body.childTurnId, '子 Agent 轮次', 100), text(body.requestId, '请求 ID', 100));
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/background/stop', async c => {
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['eventId', 'sessionId', 'requestId'].includes(key))) throw new Error('后台命令停止请求无效');
    const id = typeof body.eventId === 'string' && body.eventId.startsWith('claude-bg:')
      ? await engine.nativeBackground.stop(c.req.param('id'), body.eventId, body.sessionId, body.requestId)
      : await engine.backgroundCommands.stop(c.req.param('id'), body.eventId, body.sessionId, body.requestId);
    return c.json({ id }, 202);
  });
  app.post('/api/tasks/:id/title/regenerate', async c => {
    const body = await c.req.json();
    const id = await engine.taskTitles.start(c.req.param('id'), text(body.requestId, '标题请求 ID', 100));
    return c.json({ id }, 202);
  });
  app.patch('/api/tasks/:id', async c => {
    const applied = await engine.updateTaskMetadata(c.req.param('id'), taskMetadataChange(await c.req.json()));
    return c.json({ ok: true, applied });
  });
  app.post('/api/tasks/:id/sidebar/move', async c => {
    try { const applied = await engine.moveTaskInSidebar(c.req.param('id'), taskSidebarMove(await c.req.json())); return c.json({ ok: true, applied }); }
    catch (error) { if (error instanceof TaskSidebarOrderConflict) return c.json({ error: error.message }, 409); throw error; }
  });
  app.delete('/api/tasks/:id', async c => {
    await engine.deleteTask(c.req.param('id')); return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/message', async c => {
    const body = await c.req.json(); const attached = await images.validate(body.images); const prompt = taskPrompt(body.text, attached); const requestId = text(body.requestId, '请求 ID', 100);
    const task = (await engine.snapshot()).tasks.find(t => t.id === c.req.param('id'));
    if (!task) throw new Error('任务不存在');
    if (body.providerInstanceId !== undefined && providerInstanceID(body.providerInstanceId) !== taskProviderInstance(task)) throw new Error('不能切换会话所属 Provider 实例');
    const interactionMode = taskInteractionMode(body.interactionMode);
    const dispatch = body.dispatchMode ?? 'auto';
    if (!['auto', 'steer', 'queue'].includes(dispatch)) throw new Error('消息发送方式无效');
    if (body.compactBeforeSend !== undefined && typeof body.compactBeforeSend !== 'boolean') throw new Error('压缩后发送参数无效');
    if (body.compactBeforeSend === true) {
      const threadId = text(body.threadId, '原生会话 ID', 200);
      return c.json({ id: await compactTask(engine, task.id, { requestId, threadId, nextMessage: {
        text: prompt, images: attached, contextIds: contextIDs(body.contextIds), model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions), interactionMode,
      } }) });
    }
    if (task.agent !== 'friday' && prompt.trim().toLowerCase() === '/compact' && attached.length === 0 && contextIDs(body.contextIds).length === 0) {
      if (!task.threadId) throw new Error('这条任务还没有可压缩的原生会话');
      return c.json({ id: await compactTask(engine, task.id, { requestId, threadId: task.threadId }) });
    }
    if (task.messages?.some(message => message.id === requestId && message.delivery)) {
      await engine.steer(task.id, prompt, requestId, attached, contextIDs(body.contextIds));
    } else if (dispatch === 'queue' || (task.agent !== 'friday' && (
      failedWorkspacePreparation(task) ||
      (activeStatuses.includes(task.status) && (task.status === 'queued' || task.canSteer === false || (interactionMode !== undefined && interactionMode !== (task.interactionMode ?? 'default')))) ||
      (!activeStatuses.includes(task.status) && (task.queue?.dispatcherId != null || task.queue?.messages.some(item => item.status === 'queued')))
    ))) {
      await engine.taskQueue.enqueue(task.id, { text: prompt, images: attached, contextIds: contextIDs(body.contextIds), model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions), interactionMode }, requestId);
    } else if (activeStatuses.includes(task.status)) {
      if (body.model !== undefined || body.reasoningEffort !== undefined || body.modelOptions !== undefined) throw new Error('请在当前执行结束后切换模型');
      await engine.steer(task.id, prompt, requestId, attached, contextIDs(body.contextIds));
    }
    else await engine.createTask({ prompt, images: attached, contextIds: contextIDs(body.contextIds), requestId, projectId: task.projectId, mode: task.mode, continueId: task.id, model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions), interactionMode });
    return c.json({ id: task.id });
  });
  app.patch('/api/tasks/:id/queue/:messageId', async c => {
    const body = await c.req.json();
    const attached = body.images === undefined ? undefined : await images.validate(body.images);
    const existing = (await engine.snapshot()).tasks.find(task => task.id === c.req.param('id'))?.queue?.messages.find(message => message.id === c.req.param('messageId'));
    const prompt = taskPrompt(body.text, attached ?? existing?.images);
    await engine.taskQueue.edit(c.req.param('id'), c.req.param('messageId'), { text: prompt, images: attached, ...(body.contextIds !== undefined ? { contextIds: contextIDs(body.contextIds) } : {}), model: optionalModel(body.model), reasoningEffort: optionalModel(body.reasoningEffort), modelOptions: providerOptionSelections(body.modelOptions), interactionMode: taskInteractionMode(body.interactionMode) });
    return c.json({ ok: true });
  });
  app.delete('/api/tasks/:id/queue/:messageId', async c => {
    await engine.taskQueue.remove(c.req.param('id'), c.req.param('messageId')); return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/queue/:messageId/move', async c => {
    const body = await c.req.json();
    const before = body.beforeId === null ? null : text(body.beforeId, '目标消息 ID', 100);
    await engine.taskQueue.move(c.req.param('id'), c.req.param('messageId'), before); return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/queue/:messageId/promote', async c => {
    await engine.taskQueue.promote(c.req.param('id'), c.req.param('messageId')); return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/queue/resume', async c => {
    const body = await c.req.json(); await engine.taskQueue.resume(c.req.param('id'), text(body.requestId, '请求 ID', 100));
    return c.json({ id: c.req.param('id') }, 202);
  });
  app.post('/api/tasks/:id/approvals/:approvalId', async c => {
    const body = await c.req.json(); if (!isApprovalDecision(body.decision)) throw new Error('无效的授权决定');
    const answers = body.answers ?? {};
    if (typeof answers !== 'object' || Array.isArray(answers) || !Object.values(answers).every(a => Array.isArray(a) && a.every(v => typeof v === 'string' && v.length < 12_000))) throw new Error('回答格式无效');
    await engine.answer(c.req.param('id'), c.req.param('approvalId'), body.decision, answers, body.requestId === undefined ? undefined : text(body.requestId, '回应请求 ID', 100)); return c.json({ ok: true });
  });
  app.get('/api/tasks/:id/artifact', async c => { c.header('Content-Type', 'text/markdown; charset=utf-8'); return c.body(await engine.artifact(c.req.param('id'))); });
  return app;
}
