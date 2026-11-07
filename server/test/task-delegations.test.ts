import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Engine } from '../src/engine.js';
import type { ExecutionRequest, Executor, Workspace } from '../src/types.js';
import type { WatchActor } from '../src/task-change-request-watch.js';
import { taskSidebarActivity } from '../src/task-sidebar-activity.js';
import { taskOverview } from '../src/task-stream.js';
import { taskGit } from '../src/git-process.js';
import { callOrchestrationTool } from '../src/task-orchestration-tools.js';
class ControlledExecutor implements Executor {
  requests: ExecutionRequest[] = [];
  waiting = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  answers: unknown[][] = [];
  supportsTaskTools() { return true; }
  async answer(...args: [string,string,any,Record<string,string[]>]) { this.answers.push(args); }
  async steer() {}
  async run(request: ExecutionRequest) {
    this.requests.push(request);
    await request.update({ kind: 'session', threadId: request.task.threadId ?? 'thread-' + request.task.id, executionSessionId: 'transport-' + request.task.id });
    await request.update({ kind: 'turn', turnId: 'turn-' + this.requests.length });
    if (request.task.delegationOrigin || !request.task.messages?.some(value => value.creationSource === 'delegated')) {
      return new Promise<string>((resolve, reject) => {
        this.waiting.set(request.task.id, { resolve, reject });
        request.signal.addEventListener('abort', () => { this.waiting.delete(request.task.id); reject(new Error('Cancelled')); }, { once: true });
        if (request.signal.aborted) reject(new Error('Cancelled'));
      });
    }
    return 'Parent reconciled child result';
  }
  finish(id: string, result = 'Finished') { const pending = this.waiting.get(id); assert.ok(pending, 'Fixture execution must already be waiting'); this.waiting.delete(id); pending.resolve(result); }
  async close() { for (const pending of this.waiting.values()) pending.reject(new Error('Transport closed')); this.waiting.clear(); }
}
async function until(engine: Engine, match: (state: Workspace) => boolean) {
  const deadline = Date.now() + 10000;
  for (;;) { const state = await engine.snapshot(); if (match(state)) return state; assert.ok(Date.now() < deadline, 'Delegation fixture timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'friday-delegation-')), cwd = join(root, 'checkout'), data = join(root, 'data'); await mkdir(cwd);
  const executor = new ControlledExecutor(); let engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open();
  t.after(async () => { await engine.close(); await rm(root, { recursive: true, force: true }); });
  await engine.mutate(state => { state.projects = [{ id: 'project', name: 'Fixture', path: cwd, context: '' }]; });
  const parentId = await engine.createTask({ agent: 'codex', projectId: 'project', mode: 'code', title: 'Parent', prompt: 'Delegate the requested review', requestId: 'parent' });
  await until(engine, () => executor.waiting.has(parentId));
  const parent = (await engine.snapshot()).tasks.find(task => task.id === parentId)!;
  const actor: WatchActor = { runId: parent.currentRunId!, cwd: parent.cwd, projectId: parent.projectId };
  const signal = new AbortController().signal;
  return { get engine() { return engine; }, parentId, actor, executor, signal, cwd, data,
    start: (input: Record<string,unknown>) => engine.delegations.start(parentId, actor, input, 'fallback', signal),
    reopen: async () => { await engine.close(); engine = await new Engine(data, executor, undefined, { changeRequestSyncIntervalMs: 0 }).open(); } };
}
test('App-owned cross-provider delegation keeps one child, delivers immutable context once, and never becomes a human-authored message', async t => {
  const f = await fixture(t), parentBefore = (await f.engine.snapshot()).tasks.find(task => task.id === f.parentId)!;
  const input = { task: 'Review the change without editing', target: { providerInstanceId: 'claude', model: 'review-model' }, clientRequestId: 'review-round-1' };
  const result = await f.start(input); await until(f.engine, () => f.executor.waiting.has(result.childThreadId));
  const again = await f.start(input); assert.equal(again.taskId, result.taskId); assert.equal(f.executor.requests.length, 2);
  await assert.rejects(f.start({ ...input, task: 'A different review' }), /请求 ID/);
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === result.childThreadId)!;
  assert.equal(child.agent, 'claude'); assert.equal(child.model, 'review-model'); assert.equal(await realpath(child.cwd), await realpath(parentBefore.cwd)); assert.equal(child.subagentOrigin, undefined);
  await assert.rejects(f.engine.createTask({ continueId: child.id, projectId: 'project', mode: 'code', prompt: 'New review', requestId: 'illegal-child-send' }), /重新委派/);
  f.executor.finish(child.id, 'Reviewed: preserve the native ordering barrier');
  await until(f.engine, state => state.taskDelegations?.[result.taskId]?.delivered === true);
  assert.equal(f.executor.requests.length, 2, 'Delivery queues behind the active parent instead of starting an overlapping turn');
  f.executor.finish(f.parentId, 'Parent first turn');
  const state = await until(f.engine, state => state.tasks.find(task => task.id === f.parentId)?.result === 'Parent reconciled child result');
  const parent = state.tasks.find(task => task.id === f.parentId)!;
  assert.equal(parent.messages!.filter(value => value.creationSource === 'delegated').length, 1);
  assert.equal(taskSidebarActivity(parent).latestUserAuthoredMessageAt, taskSidebarActivity(parentBefore).latestUserAuthoredMessageAt);
  assert.match(f.executor.requests[2].prompt, /preserve the native ordering barrier/);
  assert.equal(taskOverview(state, 'test').taskDelegations, undefined);
  assert.equal(parent.delegatedTasks?.[0].summary, undefined, 'Sidebar metadata must not publish child result text');
  await f.reopen(); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(f.executor.requests.length, 3, 'A restart cannot redeliver the same child result');
});
test('Wait returns a terminal child result without a second parent turn; timeout leaves it running and later wakes its settled parent', async t => {
  const f = await fixture(t);
  const waiting = f.start({ task: 'First review', mode: 'wait', clientRequestId: 'wait-review' });
  const one = await until(f.engine, state => Object.values(state.taskDelegations ?? {}).length === 1 && f.executor.waiting.size === 2);
  const child = Object.values(one.taskDelegations!)[0]; f.executor.finish(child.childTaskId, 'Waited review result');
  const result = await waiting; assert.equal(result.waitTimedOut, false); assert.equal(result.summary, 'Waited review result');
  await until(f.engine, state => state.taskDelegations?.[child.id]?.delivered === true);
  assert.equal((await f.engine.snapshot()).tasks.find(task => task.id === f.parentId)!.queue?.messages.length ?? 0, 0);
  const timed = await f.start({ task: 'Second review', mode: 'wait', timeoutMs: 0, clientRequestId: 'timed-review' });
  assert.equal(timed.waitTimedOut, true); await until(f.engine, () => f.executor.waiting.has(timed.childThreadId));
  f.executor.finish(f.parentId, 'Waiting for child'); f.executor.finish(timed.childThreadId, 'Late review');
  await until(f.engine, state => state.tasks.find(task => task.id === f.parentId)?.result === 'Parent reconciled child result');
  assert.equal(f.executor.requests.filter(request => request.task.id === f.parentId).length, 2);
});
test('Parent Stop cancels owned children, revokes new delegation admission and does not wake the stopped parent', async t => {
  const f = await fixture(t), child = await f.start({ task: 'Long child', clientRequestId: 'stop-child' });
  await until(f.engine, () => f.executor.waiting.has(child.childThreadId));
  const other = await f.engine.createTask({ prompt: 'Unrelated', title: 'Unrelated', requestId: 'other', agent: 'codex', mode: 'code', projectId: 'project' });
  await assert.rejects(f.engine.delegations.status(other, child.taskId), /不属于/);
  await f.engine.cancel(f.parentId);
  const state = await until(f.engine, state => !active(state.tasks.find(task => task.id === child.childThreadId)!.status));
  assert.equal(state.taskDelegations![child.taskId].suppressed, true);
  assert.equal(f.executor.requests.filter(request => request.task.id === f.parentId).length, 1);
  await assert.rejects(f.start({ task: 'Late child', clientRequestId: 'after-stop' }), /结束|范围/);
});
test('An otherwise settled parent cannot finish follow-up while its app-owned child still runs', async t => {
  const f = await fixture(t), result = await f.start({task:'Still running child',clientRequestId:'settlement'});
  await until(f.engine, () => f.executor.waiting.has(result.childThreadId));
  f.executor.finish(f.parentId,'Parent is waiting for child');
  await until(f.engine,state=>state.tasks.find(task=>task.id===f.parentId)?.status==='completed');
  await assert.rejects(f.engine.settles.start(f.parentId,{requestId:'settle-children',settled:true}),/委派子任务/);
  assert.equal(f.executor.requests.length,2);
});
const active = (status: string) => ['queued','running','waiting'].includes(status);
test('A service restart observes interrupted owned children without replaying execution or auto-dispatching a parent wake during shutdown', async t => {
  const f = await fixture(t), result = await f.start({ task: 'Interrupted child', clientRequestId: 'restart' });
  await until(f.engine, () => f.executor.waiting.has(result.childThreadId));
  assert.equal(f.executor.requests.length, 2);
  await f.reopen();
  await until(f.engine, state => state.taskDelegations?.[result.taskId]?.delivered === true || state.taskDelegations?.[result.taskId]?.suppressed === true);
  assert.equal(f.executor.requests.length, 2, 'Neither the child nor the parent is sent again during recovery');
  const state = await f.engine.snapshot(), child = state.tasks.find(task => task.id === result.childThreadId)!;
  assert.ok(['failed','interrupted','cancelled'].includes(child.status));
  const parent = state.tasks.find(task => task.id === f.parentId)!;
  assert.ok(!parent.queue || parent.queue.paused || parent.queue.messages.every(value => value.status === 'cancelled'));
});
test('Concurrent retries create one child, changed input cannot reuse its request ID, and a blocking child question returns from wait', async t => {
  const f = await fixture(t), input = { task: 'Concurrent child', clientRequestId: 'concurrent' };
  const [left,right] = await Promise.all([f.start(input),f.start(input)]); assert.equal(left.childThreadId,right.childThreadId);
  await until(f.engine, () => f.executor.waiting.has(left.childThreadId)); assert.equal(f.executor.requests.length,2);
  const waiting = f.start({ task: 'Question child', clientRequestId: 'question', mode: 'wait' });
  await until(f.engine, state => Object.values(state.taskDelegations ?? {}).length === 2 && f.executor.requests.length === 3);
  const childRequest = f.executor.requests[2];
  await childRequest.update({kind:'approval',approval:{id:'question-1',method:'item/tool/requestUserInput',title:'Pick scope',detail:'',state:'pending',questions:[{id:'scope',header:'Scope',question:'Which module?',options:[]}]}});
  const result = await waiting; assert.equal(result.hasPendingQuestion,true); assert.equal(result.waitTimedOut,false); assert.equal(result.childThreadId,childRequest.task.id);
});
test('Worktree isolation uses the parent local commit and excludes dirty edits; invalid targets and privilege requests create no child', async t => {
  const f = await fixture(t);
  await taskGit(f.cwd, ['init','-b','main']); await taskGit(f.cwd, ['config','user.email','fixture@example.invalid']); await taskGit(f.cwd, ['config','user.name','Fixture']);
  await writeFile(join(f.cwd, 'file.txt'), 'committed'); await taskGit(f.cwd, ['add','.']); await taskGit(f.cwd, ['commit','-m','fixture']); await writeFile(join(f.cwd, 'file.txt'), 'dirty');
  await assert.rejects(f.start({ task: 'Bad target', target: { providerInstanceId: 'missing' } }), /不可用/);
  await assert.rejects(f.start({ task: 'Privilege escalation', runtimeMode: 'full-access' }), /继承/);
  const result = await f.start({ task: 'Isolated test', isolation: 'worktree', clientRequestId: 'isolated' });
  await until(f.engine, () => f.executor.waiting.has(result.childThreadId));
  const child = (await f.engine.snapshot()).tasks.find(task => task.id === result.childThreadId)!;
  assert.notEqual(child.cwd, f.cwd); assert.equal(await readFile(join(child.cwd, 'file.txt'),'utf8'), 'committed'); assert.equal(await readFile(join(f.cwd,'file.txt'),'utf8'), 'dirty');
});
test('Real loopback MCP catalog and tokens scope delegation to the current run; cancelling a child cannot select another parent', async t => {
  const f = await fixture(t), request = f.executor.requests.find(value => value.task.id === f.parentId)!; assert.ok(request.taskMcp);
  const call = async (method: string, params: unknown, id: string) => {
    const response = await fetch(request.taskMcp!.url, { method: 'POST', headers: { ...request.taskMcp!.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({jsonrpc:'2.0',id,method,params}) });
    return { status: response.status, body: response.status === 200 ? await response.json() as any : null };
  };
  const catalog = await call('tools/list',{},'catalog'); assert.ok(catalog.body.result.tools.some((tool: any) => tool.name === 'delegate_task'));
  const created = await call('tools/call',{name:'delegate_task',arguments:{task:'MCP child',clientRequestId:'mcp-child'}},'create'); assert.equal(created.body.result.isError,false);
  const child = JSON.parse(created.body.result.content[0].text); await until(f.engine, () => f.executor.waiting.has(child.childThreadId));
  const cancelled = await call('tools/call',{name:'task_cancel',arguments:{taskId:child.taskId}},'cancel'); assert.equal(cancelled.body.result.isError,false);
  await f.engine.cancel(f.parentId);
  const stale = await call('tools/call',{name:'task_status',arguments:{taskId:child.taskId}},'late'); assert.ok(stale.status === 401 || stale.body?.result.isError === true);
});
test('Child context pages and questions preserve scope, omit secrets and permissions, and answer through the existing live response receipt', async t => {
  const f = await fixture(t), result = await f.start({task:'Read-only child context and question',clientRequestId:'context'});
  await until(f.engine, () => f.executor.waiting.has(result.childThreadId));
  const request = f.executor.requests.find(value => value.task.id === result.childThreadId)!;
  for (const [id,method,secret] of [['ordinary','item/tool/requestUserInput',false],['permission','item/commandExecution/requestApproval',false],['secret','item/tool/requestUserInput',true]] as const) {
    await request.update({kind:'approval',approval:{id,method,state:'pending',title:id,detail:'',questions:[{id:'scope',header:'Scope',question:'Which module?',options:[],isSecret:secret}]}});
  }
  const owner = (await f.engine.snapshot()).tasks.find(task => task.id === f.parentId)!;
  const call = (name: string, input: Record<string,unknown>, key = 'context-tool') => callOrchestrationTool(f.engine,name,input,owner,f.actor,key,f.signal) as Promise<any>;
  const list = await call('t3_pending_request_list',{threadId:result.childThreadId}); assert.deepEqual(list.requestIds,['ordinary']);
  const page = await call('t3_thread_read',{threadId:result.childThreadId,limit:1,maxCharsPerItem:5}); assert.equal(page.items.length,1); assert.equal(page.items[0].text.length,5); assert.equal(page.items[0].textTruncated,true);
  const rest = await call('t3_thread_read',{threadId:result.childThreadId,itemId:page.items[0].itemId,textOffset:5,maxCharsPerItem:10}); assert.equal(rest.items[0].text,request.task.prompt.slice(5,15));
  await f.engine.mutate(state => {
    const child = state.tasks.find(task => task.id === result.childThreadId)!;
    child.messages!.push({id:'removed',role:'assistant',text:'Old visible row',revertedAt:new Date().toISOString()},{id:'later',role:'assistant',text:'New visible row'});
  });
  const later = await call('t3_thread_read',{threadId:result.childThreadId,afterPosition:2}); assert.deepEqual(later.items.map((item: any) => item.itemId),['later']); assert.equal(later.items[0].position,3,'Reverted rows cannot reuse already-read cursor positions');
  await assert.rejects(call('t3_thread_read',{threadId:'another-task'}),/只能读取/);
  await assert.rejects(call('t3_pending_request_respond',{threadId:result.childThreadId,requestId:'permission',answers:{scope:['allow']}}),/批准权限/);
  await assert.rejects(call('t3_pending_request_read',{threadId:result.childThreadId,requestId:'secret'}),/批准权限/);
  const answered = await call('t3_pending_request_respond',{threadId:result.childThreadId,requestId:'ordinary',answers:{scope:['server']}}); assert.equal(answered.responded,true); assert.equal(f.executor.answers.length,1);
  assert.equal((await f.engine.snapshot()).approvalResponses?.['context-tool'].status,'sent');
});
