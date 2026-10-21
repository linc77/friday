import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexExecutor } from '../src/codex.js';
import type { WorkItem, ExecutionUpdate, NativeRewindStart } from '../src/types.js';
import { Engine } from '../src/engine.js';

const command = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));
const work = (cwd: string): WorkItem => ({ id: 'test', title: 'test', prompt: 'test', projectId: null, cwd, agent: 'codex', mode: 'research', status: 'running', createdAt: '', updatedAt: '', durableId: 1, threadId: null, turnId: null, result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'request' });

test('Codex rewind reads paginated metadata, loads the stored thread and persists intent before reverting without starting a turn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-rewind-wire-')); t.after(() => rm(directory,{recursive:true,force:true})); await chmod(command,0o755);
  await writeFile(join(directory,'rewind-history.json'),JSON.stringify({turns:['kept','selected','later']}));
  const executor=new CodexExecutor(command); let original:NativeRewindStart|undefined; let candidate='';
  const input={task:{...work(directory),threadId:'protocol-thread'},targetTurnId:'selected',removeTurns:['selected','later'],keepTurns:['kept'],signal:new AbortController().signal,
    started:async(value:NativeRewindStart)=>{original=value;const records=(await readFile(join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(!records.some(entry=>entry.method==='thread/revert'));},candidate:async(id:string)=>{candidate=id;}};
  const result=await executor.rewind(input); assert.equal(result.state,'applied'); assert.deepEqual(result.turns,['kept']); assert.equal(candidate,'protocol-thread');
  assert.deepEqual(original?.turns,['kept','selected','later']);
  const inspected=await executor.rewind({...input,original,inspectOnly:true}); assert.equal(inspected.state,'applied');
  const wire=(await readFile(join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(wire.filter(entry=>entry.method==='thread/revert').length,1);assert.ok(wire.some(entry=>entry.method==='thread/resume'&&entry.params.excludeTurns===true));assert.ok(!wire.some(entry=>entry.method==='turn/start'));
  await writeFile(join(directory,'rewind-history.json'),JSON.stringify({turns:['kept','selected','unknown']}));
  await assert.rejects(executor.rewind(input),/未确认的轮次/);
  await writeFile(join(directory,'rewind-history.json'),JSON.stringify({turns:['kept','unrecorded']}));
  await assert.rejects(executor.rewind({...input,targetTurnId:null,removeTurns:[]}),/回退边界/);
  await writeFile(join(directory,'rewind-history.json'),JSON.stringify({mode:'legacy',turns:['kept','selected','later']}));
  await assert.rejects(executor.rewind(input),/旧历史格式/);
});

test('A lost Codex revert response is reconciled read-only and never emits a second revert request', async t => {
  const directory=await mkdtemp(join(tmpdir(),'friday-rewind-lost-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);
  await writeFile(join(directory,'rewind-history.json'),JSON.stringify({turns:['kept','selected'],loseResponse:true}));
  const executor=new CodexExecutor(command);let original:NativeRewindStart|undefined;
  const input={task:{...work(directory),threadId:'protocol-thread'},targetTurnId:'selected',removeTurns:['selected'],keepTurns:['kept'],signal:new AbortController().signal,started:async(value:NativeRewindStart)=>{original=value;},candidate:async()=>{}};
  await assert.rejects(executor.rewind(input),/连接结束/); assert.ok(original);
  assert.equal((await executor.rewind({...input,original,inspectOnly:true})).state,'applied');
  const wire=(await readFile(join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(wire.filter(entry=>entry.method==='thread/revert').length,1);
});

for (const purpose of ['git_text', 'task_title', 'review_guide'] as const) test(`Codex ${purpose} generation disables named MCP servers, apps, plugins and Friday tools and declines permission requests`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-git-text-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); const updates: ExecutionUpdate[] = [];
  try {
    const result = await executor.run({ task: { ...work(directory), projectId: 'project' }, prompt: 'git-text-protocol', purpose, signal: new AbortController().signal, update: async update => { updates.push(update); } });
    assert.equal(JSON.parse(result).subject, 'Fixture subject');
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const start = wire.find(entry => entry.method === 'thread/start');
    assert.deepEqual(start.params.dynamicTools, []); assert.equal(start.params.config.mcp_servers['fixture.server'].enabled, false);
    assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
    const outputSchema = wire.find(entry => entry.method === 'turn/start').params.outputSchema;
    if (purpose === 'task_title') { assert.equal(outputSchema.properties.title.type, 'string'); assert.equal(outputSchema.additionalProperties, false); }
    else if (purpose === 'review_guide') { assert.equal(outputSchema.properties.stops.type, 'array'); assert.deepEqual(wire.find(entry => entry.method === 'turn/start').params.sandboxPolicy, { type: 'readOnly', networkAccess: false }); assert.match(start.params.developerInstructions, /Investigate.*read-only/); }
    else assert.equal(outputSchema, undefined);
    assert.equal(wire.find(entry => entry.id === 94 && !entry.method).result.success, false);
    assert.equal(wire.find(entry => entry.id === 95 && !entry.method).result.decision, 'decline');
    assert.ok(!updates.some(update => update.kind === 'memory' || update.kind === 'approval'));
    const launch = await readFile(join(directory, 'launch.jsonl'), 'utf8'); assert.match(launch, /features.plugins=false/); assert.match(launch, /features.apps=false/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex plan turns use the native mode and read-only policy; implementation explicitly restores default mode and workspace access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-plan-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command);
  try {
    const updates: ExecutionUpdate[] = [];
    const task = { ...work(directory), mode: 'code' as const, projectId: 'project', interactionMode: 'plan' as const };
    const result = await executor.run({ task, prompt: 'plan-protocol', signal: new AbortController().signal, update: async update => { updates.push(update); } });
    assert.match(result, /Proposed change/); assert.ok(updates.some(update => update.kind === 'item' && update.item.kind === 'proposal'));
    await executor.run({ task: { ...task, interactionMode: 'default', threadId: 'protocol-thread' }, prompt: 'plan-protocol', signal: new AbortController().signal, update: async () => {} });
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const turns = wire.filter(value => value.method === 'turn/start');
    assert.deepEqual(turns.map(value => value.params.collaborationMode.mode), ['plan', 'default']);
    assert.equal(turns[0].params.collaborationMode.settings.model, 'fixture-model');
    assert.equal(turns[0].params.collaborationMode.settings.developer_instructions, null);
    assert.equal(turns[0].params.sandboxPolicy.type, 'readOnly'); assert.equal(turns[1].params.sandboxPolicy.type, 'workspaceWrite');
    assert.equal(wire.find(value => value.method === 'thread/resume').params.sandbox, 'workspace-write');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex wire transcript persists through Durable and reopens without duplicated output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-durable-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); let engine = await new Engine(directory, executor).open();
  try {
    await engine.createTask({ agent: 'codex', prompt: 'timeline-protocol', mode: 'research', projectId: null, requestId: 'timeline' });
    const limit = Date.now() + 5000;
    let task = (await engine.snapshot()).tasks[0];
    while (task.status === 'queued' || task.status === 'running') {
      if (Date.now() > limit) throw new Error('Codex wire execution timed out');
      await new Promise(resolve => setTimeout(resolve, 15)); task = (await engine.snapshot()).tasks[0];
    }
    assert.equal(task.status, 'completed', task.error ?? '');
    assert.equal(task.result, '## Final result\n\nVerified.');
    assert.equal(task.events.filter(e => e.kind === 'command').length, 1);
    assert.equal(task.events.find(e => e.kind === 'command')?.detail, '/tmp');
    assert.equal(task.events.find(e => e.phase === 'commentary')?.text, 'Inspection complete');
    assert.equal(task.events.find(e => e.kind === 'reasoning')?.text, 'Checking the project\n\nChoosing relevant checks');
    assert.equal(task.events.find(e => e.kind === 'turn')?.status, 'completed');
    assert.equal(task.messages?.length, 2);
    assert.equal(task.messages?.[0].turnId, task.turnId);
    const saved = task.events;
    await engine.close(); engine = await new Engine(directory, executor).open();
    assert.deepEqual((await engine.snapshot()).tasks[0].events, saved);
    assert.ok(!(await engine.artifact(task.id)).includes('Inspection complete'));
    assert.ok(!(await engine.artifact(task.id)).includes('Checking the project'));
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Codex wire saves session before turn, presents diffs and questions, declines unsupported permissions, and resumes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); const updates: ExecutionUpdate[] = [];
  try {
    const update = async (u: ExecutionUpdate) => {
      if (u.kind === 'session') {
        const wire = await readFile(join(directory, 'wire.jsonl'), 'utf8');
        assert.ok(!wire.includes('turn/start'), 'session must persist before turn/start');
      }
      updates.push(u);
      if (u.kind === 'approval') {
        if (u.approval.method.includes('requestUserInput')) {
          assert.equal(u.approval.questions[0]?.isOther, true);
          assert.equal(u.approval.questions[0]?.isSecret, true);
          assert.equal(u.approval.questions[0]?.options[0]?.description, '', 'optional peer descriptions remain decodable by native clients');
        }
        if (u.approval.method.includes('fileChange')) {
          assert.ok(updates.some(v => v.kind === 'item' && v.item.detail?.includes('+example')));
          await executor.steer('test', 'Additional instruction', 'steer-1');
        }
        await executor.answer('test', u.approval.id, 'accept', { q: ['A'] });
      }
    };
    assert.equal(await executor.run({ task: work(directory), prompt: 'test', signal: new AbortController().signal, update }), 'Protocol verified');
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(wire.find(m => m.method === 'thread/start').params.sandbox, 'read-only');
    assert.equal(wire.find(m => m.method === 'turn/start').params.summary, 'detailed');
    assert.deepEqual(wire.find(m => m.id === 92 && !m.method).result, { permissions: {}, scope: 'turn' });
    assert.deepEqual(wire.find(m => m.id === 91 && !m.method).result.answers.q.answers, ['A']);
    const abort = new AbortController();
    await assert.rejects(executor.run({ task: { ...work(directory), threadId: 'protocol-thread' }, prompt: 'wait-for-cancel', signal: abort.signal, update: async u => { if (u.kind === 'turn') abort.abort(); } }), /中止/);
    assert.match(await readFile(join(directory, 'wire.jsonl'), 'utf8'), /thread\/resume/);
    const starts = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(m => m.method === 'turn/start');
    assert.equal(starts.length, 2);
    assert.ok(starts.every(m => m.params.summary === 'detailed'), 'resumed turns must also request public summaries');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Conversation tools use read-only access before selection and return structured workspace/capture requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-wire-')); await chmod(command, 0o755);
  const executor = new CodexExecutor(command); const updates: ExecutionUpdate[] = [];
  try {
    const task = { ...work(directory), mode: 'auto' as const };
    await executor.run({ task, prompt: 'choose-workspace', signal: new AbortController().signal, update: async u => { updates.push(u); } });
    assert.ok(updates.some(u => u.kind === 'workspace' && u.reason.includes('目录')));
    await executor.run({ task, prompt: 'capture-idea', signal: new AbortController().signal, update: async u => { updates.push(u); } });
    assert.ok(updates.some(u => u.kind === 'idea' && u.text === '只记录这条想法' && u.id.length <= 80));
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const start = wire.find(m => m.method === 'thread/start');
    assert.equal(start.params.sandbox, 'read-only'); assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.approvalsReviewer, 'user', 'Auto must not broaden an unscoped task');
    assert.deepEqual(start.params.dynamicTools.map((t: any) => t.name), ['friday_request_workspace', 'friday_save_idea', 'friday_remember']);
    assert.equal(wire.find(m => m.id === 93 && !m.method).result.success, true);
    await executor.run({ task: { ...task, projectId: 'chosen-project', threadId: 'protocol-thread' }, prompt: 'test', signal: new AbortController().signal, update: async u => { if (u.kind === 'approval') await executor.answer('test', u.approval.id, 'decline', { q: ['A'] }); } });
    const resumed = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l)).find(m => m.method === 'thread/resume');
    assert.equal(resumed.params.sandbox, 'workspace-write'); assert.equal(resumed.params.cwd, directory);
    assert.equal(resumed.params.approvalsReviewer, 'auto_review');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex sends uploaded images in both initial and live wire inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-codex-images-')); await chmod(command, 0o755);
  const { IdeaImages } = await import('../src/ideas.js');
  const store = new IdeaImages(directory);
  const image = await store.save({ data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', name: 'image.png' });
  const images = await store.resolve([image]); const executor = new CodexExecutor(command);
  try {
    await executor.run({ task: work(directory), prompt: 'test', images, signal: new AbortController().signal, update: async update => {
      if (update.kind === 'approval') {
        if (update.approval.method.includes('fileChange')) await executor.steer('test', 'See image', 'image-steer', images);
        await executor.answer('test', update.approval.id, 'accept', { q: ['A'] });
      }
    } });
    const wire = (await readFile(join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const method of ['turn/start', 'turn/steer']) {
      const input = wire.find(value => value.method === method).params.input;
      assert.deepEqual(input[1], { type: 'localImage', path: images[0]!.path });
      assert.equal(input[0].type, 'text');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('Friday PR task MCP stays scoped on both a new Codex thread and a resumed thread',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'friday-task-mcp-codex-'));t.after(()=>rm(directory,{recursive:true,force:true}));await chmod(command,0o755);const executor=new CodexExecutor(command);t.after(()=>executor.close());
 const first={url:'http://127.0.0.1:14399/mcp',headers:{Authorization:'Bearer synthetic-turn-one'}},second={...first,headers:{Authorization:'Bearer synthetic-turn-two'}};
 await executor.run({task:{...work(directory),projectId:'p',mode:'code'},prompt:'timeline-protocol',taskMcp:first,signal:new AbortController().signal,update:async()=>{}});
 await executor.run({task:{...work(directory),projectId:'p',mode:'code',threadId:'protocol-thread'},prompt:'timeline-protocol',taskMcp:second,signal:new AbortController().signal,update:async()=>{}});
 const records=(await readFile(join(directory,'wire.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));const start=records.find(v=>v.method==='thread/start'),resume=records.find(v=>v.method==='thread/resume');
 assert.deepEqual(start.params.config.mcp_servers.friday_tasks,{url:first.url,http_headers:first.headers});assert.deepEqual(resume.params.config.mcp_servers.friday_tasks,{url:second.url,http_headers:second.headers});assert.match(resume.params.developerInstructions,/watch_pull_request/);assert.match(resume.params.developerInstructions,/unless explicitly requested/);assert(!JSON.stringify(resume).includes('synthetic-turn-one'));
});
