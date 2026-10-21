#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const threadId = 'protocol-thread'; const turn = { id: 'protocol-turn', status: 'inProgress' };
let scenario = '';
if (process.argv.includes('--config')) appendFileSync('launch.jsonl', JSON.stringify(process.argv.slice(2)) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync('wire.jsonl', JSON.stringify(message) + '\n');
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (['thread/read', 'thread/turns/list', 'thread/revert'].includes(message.method) && existsSync('rewind-history.json')) {
    const history = JSON.parse(readFileSync('rewind-history.json', 'utf8'));
    if (message.method === 'thread/read') send({id:message.id,result:{thread:{id:threadId,historyMode:history.mode??'paginated',status:{type:'notLoaded'}}}});
    if (message.method === 'thread/turns/list') {
      const offset=Number(message.params.cursor??0); const data=history.turns.slice(offset,offset+1).map(id=>({id,status:'completed'}));
      send({id:message.id,result:{data,nextCursor:offset+1<history.turns.length?String(offset+1):null}});
    }
    if (message.method === 'thread/revert') {
      history.turns=history.turns.slice(0,history.turns.indexOf(message.params.beforeTurnId)); writeFileSync('rewind-history.json',JSON.stringify(history));
      if(history.loseResponse)process.exit(0);
      send({id:message.id,result:{thread:{id:threadId}}});
    }
  }
  if (message.method === 'config/read') send({ id: message.id, result: { config: { mcp_servers: { 'fixture.server': { enabled: true, command: 'never-launch' } } } } });
  if (['thread/start', 'thread/resume'].includes(message.method)) send({ id: message.id, result: { thread: { id: threadId }, model: message.params.model ?? 'fixture-model', reasoningEffort: 'medium',
    sandbox: message.params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } } });
  if (message.method === 'thread/compact/start') {
    send({ id: message.id, result: {} }); notify('turn/started', { threadId, turn });
    notify('thread/tokenUsage/updated', { threadId: 'foreign-child', turnId: turn.id, tokenUsage: { last: { totalTokens: 999999 } } });
    notify('thread/tokenUsage/updated', { threadId, turnId: 'old-turn', tokenUsage: { last: { totalTokens: 888888 } } });
    notify('thread/tokenUsage/updated', { threadId, turnId: turn.id, tokenUsage: { total: { totalTokens: 999999 }, last: { totalTokens: 1505, inputTokens: 1500, outputTokens: 5 }, modelContextWindow: 200000 } });
    notify('item/completed', { threadId, turnId: turn.id, item: { id: 'compact', type: 'contextCompaction' } });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn } }); notify('turn/started', { threadId, turn });
    scenario = message.params.input[0].text;
    if (scenario === 'git-text-protocol') {
      send({ id: 94, method: 'item/tool/call', params: { threadId, turnId: turn.id, callId: 'background', tool: 'friday_remember', arguments: { text: 'This must not become a memory' } } }); return;
    }
    if (scenario === 'plan-protocol') {
      notify('item/completed', { threadId, turnId: turn.id, item: { id: 'proposal', type: 'plan', text: '# Proposed change\n\n1. Inspect.\n2. Implement.\n3. Verify.' } });
      notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } }); return;
    }
    if (scenario.includes('paused-live-output-protocol')) {
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'reasoning', type: 'reasoning', summary: [] } });
      notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: 'reasoning', summaryIndex: 0, delta: 'Checking' });
      notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: 'reasoning', summaryIndex: 0, delta: ' the project' });
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '' } });
      notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'progress', delta: '正在检查' });
      notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'progress', delta: '项目 🚀' });
      // The test owns this marker and releases completion only after observing
      // both complete token bursts through the live task API. No later model
      // event can accidentally flush a broken trailing timer for the test.
      const release = setInterval(() => {
        if (!existsSync('release-stream-output')) return;
        clearInterval(release);
        notify('item/completed', { threadId, turnId: turn.id, item: { id: 'reasoning', type: 'reasoning', summary: [] } });
        notify('item/completed', { threadId, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '正在检查项目 🚀' } });
        notify('item/completed', { threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Live output verified.' } });
        notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
      }, 10);
      return;
    }
    if (scenario.includes('timeline-protocol')) {
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'reasoning', type: 'reasoning', summary: [] } });
      notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: 'reasoning', summaryIndex: 0, delta: 'Checking the project' });
      notify('item/reasoning/summaryTextDelta', { threadId, turnId: turn.id, itemId: 'reasoning', summaryIndex: 1, delta: 'Choosing relevant checks' });
      notify('item/completed', { threadId, turnId: turn.id, item: { id: 'reasoning', type: 'reasoning', summary: [] } });
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: '' } });
      notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: 'progress', delta: 'Inspecting the project' });
      notify('item/completed', { threadId, turnId: turn.id, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Inspection complete' } });
      notify('item/started', { threadId, turnId: turn.id, item: { id: 'command', type: 'commandExecution', command: 'pwd', status: 'inProgress' } });
      notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: 'command', delta: '/tmp' });
      notify('item/completed', { threadId, turnId: turn.id, item: { id: 'command', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: '/tmp', exitCode: 0, durationMs: 20 } });
      notify('item/completed', { threadId, turnId: turn.id, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '## Final result\n\nVerified.' } });
      notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
      return;
    }
    if (scenario === 'choose-workspace' || scenario === 'capture-idea') {
      send({ id: 93, method: 'item/tool/call', params: { threadId, turnId: turn.id, callId: 'call', tool: scenario === 'choose-workspace' ? 'friday_request_workspace' : 'friday_save_idea', arguments: scenario === 'choose-workspace' ? { reason: '需要一个目录来创建文件。' } : { text: '只记录这条想法' } } });
      return;
    }
    if (message.params.input[0].text === 'wait-for-cancel') return;
    notify('item/started', { threadId, item: { id: 'files', type: 'fileChange', changes: [{ path: 'example.txt', kind: { type: 'add' }, diff: '@@ -0,0 +1 @@\n+example\n' }] } });
    send({ id: 90, method: 'item/fileChange/requestApproval', params: { threadId, itemId: 'files', reason: 'Test preview' } });
  }
  if (message.id === 93 && !message.method) {
    notify('item/completed', { threadId, item: { id: 'answer', type: 'agentMessage', text: scenario === 'choose-workspace' ? '要处理哪个项目？' : '记下了。', phase: 'final_answer' } });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
  }
  if (message.id === 94 && !message.method) {
    send({ id: 95, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: turn.id, command: 'write files' } });
  }
  if (message.id === 95 && !message.method) {
    notify('item/completed', { threadId, turnId: turn.id, item: { id: 'git-text', type: 'agentMessage', phase: 'final_answer', text: '{"subject":"Fixture subject","body":""}' } });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
  }
  if (message.id === 90 && !message.method) {
    send({ id: 91, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'q', header: 'Choice', question: 'Which option?', isOther: true, isSecret: true, options: [{ label: 'A' }] }] } });
  }
  if (message.id === 91 && !message.method) {
    send({ id: 92, method: 'item/permissions/requestApproval', params: { threadId } });
  }
  if (message.id === 92 && !message.method) {
    notify('item/agentMessage/delta', { threadId, itemId: 'answer', delta: 'Protocol verified' });
    notify('item/completed', { threadId, item: { id: 'answer', type: 'agentMessage', text: 'Protocol verified', phase: 'final_answer' } });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
  }
  if (['turn/steer', 'turn/interrupt'].includes(message.method)) send({ id: message.id, result: { turnId: turn.id } });
});
