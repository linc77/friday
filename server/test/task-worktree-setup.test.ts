import test from 'node:test';
import assert from 'node:assert/strict';
import { worktreeSetupSnapshot } from '../src/task-worktree-setup.js';
import type { WorkItem, Workspace } from '../src/types.js';
import type { ProjectScriptRun } from '../src/project-script-types.js';
const at = '2026-10-20T01:00:00.000Z', next = '2026-10-20T01:00:01.000Z';
function fixture() {
  const task = { id:'task', agent:'codex', status:'running', currentRunId:'run', createdAt:at, updatedAt:next, error:null,
    executionWorkspace:{ mode:'worktree', root:'/synthetic/tree', targetBranch:'feature', branch:'refs/heads/main', commit:'a'.repeat(40), state:'ready' },
    runs:[{id:'run',status:'running',at,workspacePreparation:{status:'ready',attempt:1,startedAt:at,completedAt:next,checkoutCompletedAt:next,setupRunId:'script',setupResolvedAt:next}}] } as unknown as WorkItem;
  const script = {id:'script',taskId:'task',trigger:'setup',requestId:'setup-task-run',createdAt:next,updatedAt:next,status:'running',startedAt:next,terminalId:'term',script:{name:'Initialize',command:'literal',async:false}} as ProjectScriptRun;
  const state = {revision:7, projectScriptRuns:[script]} as Workspace;
  return {task,script,state,read:()=>worktreeSetupSnapshot(state,task,()=>({text:'\x1b[31mfirst\x1b[0m\rsecond\nthird\nfourth\nfifth\n',sequence:3}))};
}
test('A synchronous setup owns the working slot and projects four short output lines without persisting output', () => {
  const f=fixture(), snapshot=f.read()!; assert.equal(snapshot.phase,'running'); assert.equal(snapshot.runId,'run'); assert.equal(snapshot.sequence,10);
  assert.deepEqual(snapshot.stages.map(s=>s.status),['done','running','pending']); assert.deepEqual(snapshot.stages[1].tail,['second','third','fourth','fifth']);
  assert.equal(snapshot.baseRef,'main'); assert.equal(snapshot.branch,'feature'); assert.equal(JSON.stringify(f.state).includes('fifth'),false);
});
test('Async setup continues after handoff, hides on success and retains failed setup until a follow-up', () => {
  const f=fixture(); f.script.script.async=true; f.task.runs![0].startedAt=next;
  assert.equal(f.read()!.phase,'running'); assert.equal(f.read()!.stages[2].status,'done');
  f.script.status='completed';f.script.exitCode=0;f.script.completedAt=next;assert.equal(f.read(),null);
  f.script.status='failed';f.script.exitCode=3;assert.equal(f.read()!.phase,'done');assert.equal(f.read()!.stages[1].status,'failed');
  f.task.currentRunId='follow-up';assert.equal(f.read(),null);
  f.script.status='running';assert.equal(f.read()!.phase,'running');
});
test('Sync failure and cancellation do not claim that checkout or the Agent failed', () => {
  const f=fixture();f.script.status='failed';f.script.exitCode=3;f.task.status='failed';f.task.runs![0].status='failed';f.task.runs![0].workspacePreparation!.status='failed';
  assert.deepEqual(f.read()!.stages.map(s=>s.status),['done','failed','pending']);assert.equal(f.read()!.phase,'failed');
  f.script.status='cancelled';f.task.status='cancelled';f.task.runs![0].status='cancelled';f.task.runs![0].workspacePreparation!.status='cancelled';
  assert.equal(f.read()!.phase,'cancelled');assert.deepEqual(f.read()!.stages.map(s=>s.status),['done','skipped','skipped']);
});
test('A retry cannot attach the previous attempt, a foreign task, or a reverted preparation', () => {
  const f=fixture(), preparation=f.task.runs![0].workspacePreparation!;delete preparation.setupRunId;delete preparation.setupResolvedAt;preparation.attempt=2;
  assert.equal(f.read()!.setupScript,null);assert.equal(f.read()!.stages[1].status,'pending');
  preparation.setupRunId=f.script.id;f.script.taskId='foreign';assert.equal(f.read()!.setupScript,null);
  f.task.runs![0].revertedAt=next;assert.equal(f.read(),null);
});
test('Output is bounded, cancellation claims render immediately, and successful ordinary checkout has no invented script', () => {
  const f=fixture();
  const huge=worktreeSetupSnapshot(f.state,f.task,()=>({text:'x'.repeat(2000)+'\n',sequence:4}))!;
  assert.equal(huge.stages[1].tail[0].length,400);f.task.runs![0].workspacePreparation!.cancelRequestedAt=next;assert.equal(f.read()!.phase,'cancelled');
  delete f.task.runs![0].workspacePreparation!.cancelRequestedAt;f.state.projectScriptRuns=[];f.task.executionWorkspace!.mode='checkout';
  assert.deepEqual(f.read()!.stages.map(s=>s.status),['done','skipped','running']);assert.equal(f.read()!.setupScript,null);
});
test('Setup output waits for complete lines, removes only the active shell wrapper and remains valid Unicode', () => {
  const f=fixture();f.script.script.command='printf literal';
  const snapshot=worktreeSetupSnapshot(f.state,f.task,()=>({text:'prompt> ( printf literal\r\ncomplete\rpartial',sequence:1,shell:'/bin/sh'}))!;
  assert.deepEqual(snapshot.stages[1].tail,['complete']);
  const fish=worktreeSetupSnapshot(f.state,f.task,()=>({text:'begin\rprintf literal\rdone\rpartial',sequence:1,shell:'/opt/fish'}))!;
  assert.deepEqual(fish.stages[1].tail,['done']);
  const unicode=worktreeSetupSnapshot(f.state,f.task,()=>({text:'x'.repeat(399)+'😀\n',sequence:1}))!.stages[1].tail[0];
  assert.equal(unicode.length,400);assert.equal(unicode.charCodeAt(399),0xfffd);
});
test('Truncated stage errors cannot introduce an unpaired surrogate into the native snapshot', () => {
  const f=fixture();f.script.status='failed';f.script.error='x'.repeat(198)+'😀'+'tail';f.task.runs![0].workspacePreparation!.status='failed';
  const snapshot=f.read()!;assert.equal(snapshot.stages[1].detail?.length,200);assert.equal(snapshot.stages[1].detail?.charCodeAt(198),0xfffd);
});
test('Fetch failure leaves checkout pending; submodule warnings retain their own stage after Agent handoff', () => {
  const f=fixture(),plan=f.task.executionWorkspace!,preparation=f.task.runs![0].workspacePreparation!;
  plan.startFromOrigin=true;plan.state='pending';plan.fetch={status:'failed',startedAt:at,completedAt:next,detail:'fetch failed'};preparation.status='failed';delete preparation.checkoutCompletedAt;f.task.runs![0].status='failed';
  assert.deepEqual(f.read()!.stages.map(s=>[s.id,s.status]),[['fetch','failed'],['checkout','pending'],['setup-script','running'],['agent','pending']]);
  f.state.projectScriptRuns=[];plan.state='ready';plan.fetch.status='done';plan.checkout={status:'done',startedAt:at,completedAt:next};plan.submodules={status:'warning',startedAt:next,completedAt:next,detail:'module failed'};preparation.status='ready';preparation.setupResolvedAt=next;f.task.runs![0].startedAt=next;
  assert.deepEqual(f.read()!.stages.map(s=>[s.id,s.status]),[['fetch','done'],['checkout','done'],['submodules','warning'],['setup-script','skipped'],['agent','done']]);
  plan.submodules.status='done';assert.equal(f.read(),null);
});
