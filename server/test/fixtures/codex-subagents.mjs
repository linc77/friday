#!/usr/bin/env node
// An owned app-server protocol peer. It never starts a model or real tools.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
const root = 'native-root', child = 'native-child'; let turns = existsSync('subagent-root-turn-count') ? Number(readFileSync('subagent-root-turn-count', 'utf8')) : 0, childLive = false, childStatus = 'inProgress', second = false, backgroundLive = false;
let childTurnId = 'child-turn-1', selectionRequest, pendingChildStart;
const nested = 'nested-native'; let nestedLive = false, nestedTurnId = 'nested-turn-1';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (threadId, method, params) => send({ method, params: { threadId, ...params } });
const take = name => { if (!existsSync(name)) return false; unlinkSync(name); return true; };
const nativeHistory = () => existsSync('subagent-native-history.json') ? JSON.parse(readFileSync('subagent-native-history.json', 'utf8')) : { source: [{ id: 'inherited-parent-1', status: 'inProgress' }], forks: {}, origins: {} };
const saveNative = value => writeFileSync('subagent-native-history.json', JSON.stringify(value));
const sourceTurn = (id, status) => { const state = nativeHistory(), found = state.source.find(turn => turn.id === id); if (found) found.status = status; else state.source.push({ id, status }); saveNative(state); };
appendFileSync('subagent-launches', String(process.pid) + '\n');
const answer = (threadId, turnId, text) => {
  notify(threadId, 'item/completed', { turnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text } });
  notify(threadId, 'turn/completed', { turn: { id: turnId, status: 'completed' } });
};
const finishChild = (status = 'completed') => {
  if (!childLive) return; childLive = false; childStatus = status;
  sourceTurn(childTurnId, status);
  notify(child, 'item/completed', { turnId: childTurnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: childTurnId === 'child-turn-1' ? 'Actual child answer' : 'Resumed child answer' } });
  notify(child, 'turn/completed', { turn: { id: childTurnId, status } });
};
const finishNested = (status = 'completed') => {
  if (!nestedLive) return; nestedLive = false;
  notify(nested, 'item/completed', { turnId: nestedTurnId, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: nestedTurnId === 'nested-turn-1' ? 'Original nested answer' : 'Resumed nested answer' } });
  notify(nested, 'turn/completed', { turn: { id: nestedTurnId, status } });
};
const timer = setInterval(() => {
  if (take('release-child-history') && existsSync('held-child-history')) { send(JSON.parse(readFileSync('held-child-history', 'utf8'))); unlinkSync('held-child-history'); }
  if (take('history-only-child-complete')) {
    childLive = false; sourceTurn(childTurnId, 'completed');
    const state = nativeHistory(), turn = state.source.find(turn => turn.id === childTurnId);
    turn.items = [{ type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'Inspect only owned code' }] },
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Recovered native child answer' }]; saveNative(state);
    notify(root, 'item/completed', { turnId: 'root-turn-1', item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed', receiverThreadIds: [child],
      agentsStates: { [child]: { status: 'completed', message: 'Native completion preview' } } } });
  }
  if (take('child-output')) notify(child, 'item/agentMessage/delta', { turnId: 'child-turn-1', itemId: 'answer', delta: 'live output café 🚀' });
  if (take('child-finish')) finishChild();
  if (take('release-child-start') && pendingChildStart) { pendingChildStart(); pendingChildStart = undefined; }
  if (take('finish-nested-child')) finishNested();
  if (take('spawn-nested-child')) {
    nestedLive = true;
    notify(nested, 'thread/started', { thread: { id: nested, parentThreadId: child, model: 'actual-nested-model' } });
    notify(nested, 'turn/started', { turn: { id: nestedTurnId, status: 'inProgress' } });
    notify(child, 'item/completed', { turnId: childTurnId, item: { type: 'collabAgentToolCall', id: 'nested-spawn', tool: 'spawnAgent', senderThreadId: child,
      receiverThreadIds: [nested], prompt: 'Original nested prompt', agentsStates: { [nested]: { status: 'running', message: null } } } });
  }
  if (take('child-background')) {
    backgroundLive = true;
    notify(child, 'item/started', { turnId: 'child-turn-1', item: { type: 'commandExecution', id: 'child-background', processId: 'child-process', command: 'owned child background command', status: 'inProgress' } });
    notify(child, 'item/commandExecution/outputDelta', { turnId: 'child-turn-1', itemId: 'child-background', delta: 'first child output\n' });
  }
  if (take('child-background-output')) notify(child, 'item/commandExecution/outputDelta', { turnId: 'child-turn-1', itemId: 'child-background', delta: 'late child output 🚀\n' });
  if (take('child-approval')) send({ id: 'child-approval-request', method: 'item/commandExecution/requestApproval', params: { threadId: child, turnId: 'child-turn-1', itemId: 'child-command', reason: 'Owned native child permission', command: 'Owned write', cwd: process.cwd() } });
  if (take('second-finish') && second) { second = false; answer(root, 'root-turn-2', 'Second parent answer'); }
  if (take('late-child-launch')) notify(root, 'item/completed', { turnId: 'root-turn-2', item: { type: 'collabAgentToolCall', id: 'late-spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: root,
    receiverThreadIds: ['late-child'], prompt: 'Late native child prompt', agentsStates: { 'late-child': { status: 'completed', message: 'Native result preview' } } } });
  if (take('late-child-frames')) {
    notify('late-child', 'turn/started', { turn: { id: 'late-child-turn', status: 'inProgress' } });
    notify('late-child', 'item/started', { turnId: 'late-child-turn', item: { type: 'agentMessage', id: 'late-answer', phase: 'final_answer', text: '' } });
    notify('late-child', 'item/agentMessage/delta', { turnId: 'late-child-turn', itemId: 'late-answer', delta: 'Actual late child output' });
    notify('late-child', 'item/completed', { turnId: 'late-child-turn', item: { type: 'agentMessage', id: 'late-answer', phase: 'final_answer', text: 'Actual late child output' } });
    notify('late-child', 'turn/completed', { turn: { id: 'late-child-turn', status: 'completed' } });
  }
  if (take('disconnect-subagents')) process.exit(2);
  if (take('child-settings')) notify(child, 'thread/settings/updated', { threadSettings: { model: 'fresh-child-model', effort: 'high' } });
  if (take('release-child-selection') && selectionRequest !== undefined) { send({ id: selectionRequest, result: { thread: { id: child, model: 'stale-child-model', reasoningEffort: 'low' } } }); selectionRequest = undefined; }
}, 10);
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); appendFileSync('subagent-wire', line + '\n'); const p = request.params ?? {};
  if (request.method === 'initialize') send({ id: request.id, result: { userAgent: 'owned-native-subagent-fixture' } });
  if (['thread/start', 'thread/resume'].includes(request.method)) {
    if (nativeHistory().forks[p.threadId]) { send({ id: request.id, result: { thread: { id: p.threadId }, model: 'independent-fork-model' } }); return; }
    if (p.threadId && p.threadId !== root) { writeFileSync('unexpected-child-resume', ''); send({ id: request.id, error: { message: 'Do not resume native children' } }); }
    else send({ id: request.id, result: { thread: { id: root }, model: 'parent-model' } });
  }
  if (request.method === 'turn/start') {
    const state = nativeHistory(), fork = state.forks[p.threadId];
    if (fork) {
      const turnId = 'fork-turn-' + (fork.filter(turn => turn.id.startsWith('fork-turn-')).length + 1); fork.push({ id: turnId, status: 'completed' }); saveNative(state);
      send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } }); notify(p.threadId, 'turn/started', { turn: { id: turnId, status: 'inProgress' } }); answer(p.threadId, turnId, 'Fork independent answer'); return;
    }
    if (p.threadId !== root) { writeFileSync('unexpected-child-input', ''); return; }
    const turnId = 'root-turn-' + ++turns; writeFileSync('subagent-root-turn-count', String(turns)); send({ id: request.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    notify(root, 'turn/started', { turn: { id: turnId, status: 'inProgress' } });
    if (turns > 1) {
      second = true; notify(root, 'item/started', { turnId, item: { type: 'agentMessage', id: 'pending', phase: 'commentary', text: 'Second parent pending' } });
      const resumeNested = take('resume-known-nested');
      if (take('resume-known-child') || resumeNested) {
        if (resumeNested) { nestedLive = true; nestedTurnId = 'nested-turn-2'; } else { childLive = true; childTurnId = 'child-turn-2'; sourceTurn(childTurnId, 'inProgress'); }
        const receiver = resumeNested ? nested : child, nativeTurn = resumeNested ? nestedTurnId : childTurnId;
        const start = () => {
          notify(receiver, 'turn/started', { turn: { id: nativeTurn, status: 'inProgress' } });
          notify(receiver, 'item/started', { turnId: nativeTurn, item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: resumeNested ? 'Resumed nested ' : 'Resumed child ' } });
        };
        if (take('defer-child-start')) pendingChildStart = start; else start();
        notify(root, 'item/completed', { turnId, item: { type: 'collabAgentToolCall', id: 'send-again', tool: 'sendInput', status: 'completed', senderThreadId: root, receiverThreadIds: [receiver], prompt: 'Continue the original native child', agentsStates: { [receiver]: { status: 'running', message: null } } } });
      }
      return;
    }
    childLive = true;
    sourceTurn(childTurnId, 'inProgress');
    // Child frames precede the owning spawn result on purpose.
    notify(child, 'thread/started', { thread: { id: child, parentThreadId: root, model: existsSync('defer-child-selection') ? null : 'actual-child-model', reasoningEffort: 'low' } });
    if (!take('omit-child-turn-start')) {
      notify(child, 'turn/started', { turn: { id: 'child-turn-1', status: 'inProgress' } });
      notify(child, 'item/started', { turnId: 'child-turn-1', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Child ' } });
    }
    notify(root, 'item/completed', { turnId, item: { type: 'collabAgentToolCall', id: 'spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: root, receiverThreadIds: [child], prompt: 'Inspect without changing files', model: null, reasoningEffort: null, agentsStates: { [child]: { status: 'running', message: null } } } });
    answer(root, turnId, 'Parent answer');
  }
  if (request.method === 'thread/read') {
    const state = nativeHistory(), fork = state.forks[p.threadId];
    if (fork) {
      if (take('fail-child-fork-inspection')) { send({ id: request.id, error: { code: -1, message: 'Owned candidate inspection interrupted' } }); return; }
      send({ id: request.id, result: { thread: { id: p.threadId, historyMode: 'paginated', forkedFromId: state.origins[p.threadId], model: 'independent-fork-model', turns: p.includeTurns ? fork : [] } } }); return;
    }
    if (existsSync('defer-child-selection') && p.threadId === child) selectionRequest = request.id;
    else send({ id: request.id, result: { thread: { id: p.threadId, parentThreadId: p.threadId === nested ? child : root, model: p.threadId === 'late-child' ? null : p.threadId === nested ? 'resumed-nested-model' : childTurnId === 'child-turn-2' ? 'resumed-child-model' : 'actual-child-model', reasoningEffort: 'low', status: { type: childLive ? 'active' : 'idle', activeFlags: [] }, turns: p.includeTurns ? [{ id: childTurnId, status: childStatus, items: [] }] : [] } } });
  }
  if (request.method === 'thread/turns/list') {
    const state = nativeHistory(), turns = p.threadId === child ? state.source : p.threadId === root ? state.source.filter(turn => turn.id === 'inherited-parent-1') : state.forks[p.threadId];
    if (!turns) { send({ id: request.id, error: { code: -1, message: 'Unknown owned history' } }); return; }
    const offset = Number(p.cursor ?? 0); send({ id: request.id, result: { data: turns.slice(offset, offset + 1), nextCursor: offset + 1 < turns.length ? String(offset + 1) : null } }); return;
  }
  if (request.method === 'thread/items/list') {
    const state = nativeHistory(), turn = state.source.find(turn => turn.id === p.turnId);
    const values = turn?.items ?? (turn ? [
      { type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: p.turnId === 'child-turn-1' ? 'Inspect only owned code' : 'Continue the original native child' }] },
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: turn.status === 'inProgress' ? 'Stored child partial' : p.turnId === 'child-turn-1' ? 'Actual child answer' : 'Resumed child answer' },
    ] : []);
    const offset = Number(p.cursor ?? 0), size = Math.min(p.limit ?? 100, 25); const page = { data: values.slice(offset, offset + size).map(item => ({ turnId: p.turnId, item, startedAtMs: null, completedAtMs: null })), nextCursor: offset + size < values.length ? String(offset + size) : null };
    if (take('hold-child-history')) { writeFileSync('held-child-history', JSON.stringify({ id: request.id, result: page })); return; }
    send({ id: request.id, result: page }); return;
  }
  if (request.method === 'thread/fork') {
    const state = nativeHistory(), turns = p.threadId === child ? state.source : state.forks[p.threadId], end = turns?.findIndex(turn => turn.id === p.lastTurnId) ?? -1;
    if (end < 0) { send({ id: request.id, error: { code: -1, message: 'Unknown native boundary' } }); return; }
    const id = 'native-fork-' + (Object.keys(state.forks).length + 1); state.forks[id] = turns.slice(0, end + 1); state.origins[id] = p.threadId; saveNative(state);
    if (take('drop-inherited-child-fork-prefix')) { state.forks[id] = state.forks[id].slice(1); saveNative(state); }
    if (take('lose-child-fork-receipt')) process.exit(2);
    send({ id: request.id, result: { thread: { id } } }); return;
  }
  if (request.method === 'turn/interrupt') {
    if (existsSync('lose-child-stop-receipt')) process.exit(2);
    send({ id: request.id, result: {} }); if (p.threadId === child && p.turnId === childTurnId) finishChild('interrupted');
    if (p.threadId === nested && p.turnId === nestedTurnId) finishNested('interrupted');
  }
  if (request.method === 'thread/backgroundTerminals/list') send({ id: request.id, result: { data: backgroundLive && p.threadId === child ? [{ processId: 'child-process', itemId: 'child-background', command: 'owned child background command', cwd: process.cwd() }] : [], nextCursor: null } });
  if (request.method === 'thread/backgroundTerminals/terminate') {
    if (p.threadId !== child || p.processId !== 'child-process') { send({ id: request.id, error: { message: 'Foreign background scope' } }); return; }
    backgroundLive = false;
    notify(child, 'item/completed', { turnId: 'child-turn-1', item: { type: 'commandExecution', id: 'child-background', processId: 'child-process', command: 'owned child background command', status: 'failed', exitCode: 130, aggregatedOutput: 'first child output\nlate child output 🚀\nlast child output\n' } });
    send({ id: request.id, result: { terminated: true } });
  }
  if (request.id === 'child-approval-request' && !request.method) {
    if (request.result?.decision === 'accept') writeFileSync('child-approved', 'approved');
    send({ method: 'serverRequest/resolved', params: { requestId: 'child-approval-request' } });
  }
}).on('close', () => { clearInterval(timer); process.exit(0); });
