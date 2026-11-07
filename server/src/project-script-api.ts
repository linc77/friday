import type { Hono } from 'hono';
import type { Engine } from './engine.js';
import { importableProjectScripts, projectScriptSettings, updateProjectScriptSettings } from './project-script-settings.js';
import { projectScriptProgress } from './project-script-progress.js';
import type { ProjectScriptRun } from './project-script-types.js';
import { worktreeSetupSnapshot } from './task-worktree-setup.js';
export function installProjectScriptAPI(app: Hono<{ Variables: { device: string } }>, engine: Engine) {
  const projected = (run: ProjectScriptRun) => {
    const terminal = engine.terminals.store.get(run.terminalOwner, run.terminalId);
    return terminal && terminal.generation === run.generation ? { ...run, progress: projectScriptProgress(engine.terminals.store.historyTail(terminal).toString('utf8'), run.script.command, terminal.shell) } : run;
  };
  app.get('/api/project-scripts/settings', async c => c.json(await projectScriptSettings(engine, c.req.query('projectId'))));
  app.patch('/api/project-scripts/settings', async c => c.json(await updateProjectScriptSettings(engine, await c.req.json())));
  app.get('/api/projects/:id/scripts/import', async c => c.json(await importableProjectScripts(engine, c.req.param('id'))));
  app.get('/api/project-scripts/runs', async c => {
    const state = await engine.snapshot(), projectId = c.req.query('projectId');
    if (projectId && !state.projects.some(p => p.id === projectId)) throw new Error('Workspace 不存在');
    const runs = engine.projectScripts.list(state, undefined, projectId).filter(run => ['queued','running'].includes(run.status) || ['starting','running','closing'].includes(engine.terminals.store.get(run.terminalOwner, run.terminalId)?.status ?? ''));
    return c.json({ runs: runs.map(projected) });
  });
  app.get('/api/tasks/:id/scripts', async c => {
    const state = await engine.snapshot(), task = state.tasks.find(t => t.id === c.req.param('id') && t.agent !== 'friday'); if (!task) throw new Error('本地任务不存在');
    const project = state.projects.find(p => p.id === task.projectId);
    const runs = engine.projectScripts.list(state, task.id);
    const worktreeSetup = worktreeSetupSnapshot(state, task, run => {
      const terminal = engine.terminals.store.get(run.terminalOwner, run.terminalId);
      return terminal && terminal.generation === run.generation ? { text: engine.terminals.store.historyTail(terminal).toString('utf8'), sequence: terminal.sequence, shell: terminal.shell } : undefined;
    });
    return c.json({ ...(project ? await projectScriptSettings(engine, project.id) : { scripts: [] }), runs: runs.map((run, index) => index >= runs.length - 12 || run.status === 'running' ? projected(run) : run), worktreeSetup });
  });
  app.post('/api/tasks/:id/scripts', async c => { const body = await c.req.json(); return c.json({ id: await engine.projectScripts.startTask(c.req.param('id'), body.scriptId, body.requestId) }, 202); });
  app.get('/api/project-scripts/runs/:id', async c => {
    const run = await engine.projectScripts.get(c.req.param('id'));
    const terminal = engine.terminals.store.get(run.terminalOwner, run.terminalId);
    return c.json({ run: projected(run), ...(terminal ? { terminal } : {}) });
  });
  app.post('/api/project-scripts/runs/:id/cancel', async c => { await engine.projectScripts.cancel(c.req.param('id')); return c.json({ ok: true }); });
}
