#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.MUSE_TEST_HOME;
const trace = value => { if (process.env.MUSE_TEST_WIRE) appendFileSync(process.env.MUSE_TEST_WIRE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args, ...value }) + '\n'); };
if (args.includes('--version')) { trace({ version: true }); console.log('Muse Code 1.4.6'); process.exit(0); }
if (args[0] !== 'serve') process.exit(2);
let input = '', session, turn, holding = false;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (request, result) => send({ id: request.id, result: { ...result, ...(request.params?.commandId ? { commandId: request.params.commandId } : {}) } });
const fail = (request, kind, message) => send({ id: request.id, error: { code: -32000, message, data: { kind } } });
const notice = (method, params) => send({ method, params: { sessionId: session, ...(turn ? { turnId: turn } : {}), ...params } });
const item = value => notice(value.status === 'completed' ? 'item/completed' : 'item/started', { item: { turnId: turn, ...value } });
const complete = () => { item({ itemId: 'answer', revision: 3, status: 'completed', kind: 'agentMessage', text: 'Muse reply café\u2028line\u2029end' }); notice('turn/completed', { turnId: turn, terminal: 'completed' }); };
let mcp, childPermission, afterChildApproval;
const callTaskTools = async phase => {
  const response = await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 'native-reused-id', method: 'tools/call', params: { name: 'list_thread_pull_requests', arguments: {} } }) });
  const body = await response.json(); trace({ phase, mcpStatus: response.status, mcpBody: body });
  if (response.status !== 200 || body.result?.isError !== false) throw new Error('Native task tools did not own the current run');
};
const approvals = [{ choiceId: 'allow', label: 'Allow', decision: 'approved', scope: 'once' }, { choiceId: 'session', label: 'Session', decision: 'approvedForSession', scope: 'session' }, { choiceId: 'persistent', label: 'Always', decision: 'approvedPolicyAmendment', scope: 'localPersistent' }, { choiceId: 'abort', label: 'Reject', decision: 'abort', scope: 'once' }];
async function handle(request) {
  const params = request.params ?? {}; trace({ method: request.method, params, receivedMetaKey: process.env.META_API_KEY !== undefined });
  if (request.method === 'initialize') return reply(request, { schema: { version: 1, fingerprint: 'muse-independent-wire-fixture' }, grantedCapabilities: ['sessionMcp'], serverInfo: { name: 'Muse fixture', version: '1.4.6' } });
  if (request.method === 'initialized') return;
  if (request.method === 'model/list') return reply(request, { providerId: 'meta', models: [{ modelId: 'muse-native', providerId: 'meta', displayLabel: 'Muse Native', isDefault: true, variants: ['low', 'high'], defaultReasoningEffort: 'high' }, { modelId: 'muse-no-thinking', providerId: 'meta', displayLabel: '', isDefault: false, variants: [] }, { modelId: 'wrong-provider', providerId: 'other', displayLabel: 'Wrong' }] });
  if (['session/start', 'session/resume'].includes(request.method)) {
    mcp = params.config?.mcpServers?.friday;
    if (args.includes('--disable-write') && params.approvalMode !== 'denyUnmatched') return fail(request, 'invalidParams', 'Read-only probe attempted to create a session');
    session = params.sessionId; mkdirSync(home, { recursive: true }); const file = join(home, session + '.json');
    if (request.method === 'session/resume') { if (!existsSync(file) || process.env.MUSE_TEST_FAIL_RESUME === '1') return fail(request, 'sessionNotFound', 'Native Muse session not found'); item({ itemId: 'old', revision: 1, status: 'completed', kind: 'agentMessage', text: 'Loaded Muse history must not replay' }); }
    else writeFileSync(file, JSON.stringify({ sessionId: session, modelId: params.modelId, prompts: [] }));
    return reply(request, { session: { sessionId: session, modelId: JSON.parse(readFileSync(file)).modelId } });
  }
  if (['session/setApprovalMode', 'session/setModel'].includes(request.method)) return reply(request, {});
  if (request.method === 'session/compact') { reply(request, { status: 'accepted' }); item({ itemId: 'compact', revision: 1, kind: 'compaction', status: 'completed', outcome: 'compacted', reason: 'Native compacted' }); return; }
  if (request.method === 'turn/interrupt') { trace({ interrupted: params.turnId }); reply(request, {}); notice('turn/completed', { turnId: params.turnId, terminal: 'cancelled' }); return; }
  if (request.method === 'turn/steer') { if (params.expectedTurnId !== turn || 'turnId' in params) return fail(request, 'invalidParams', 'Wrong native steer identity'); trace({ steered: params.input }); reply(request, { turnId: turn }); if (process.env.MUSE_TEST_STEER_SETTLES === '1') complete(); return; }
  if (request.method === 'approval/decide') { if (params.requirementId?.sourceIndex !== 1 || !approvals.some(choice => choice.choiceId === params.choiceId)) return fail(request, 'invalidParams', 'Wrong native permission choice'); reply(request, { approvalId: 'write', terminal: true }); notice('approval/resolved', { approvalId: 'write' }); if (childPermission) { item({ itemId: 'native-child-item', revision: 2, status: 'completed', kind: 'subagent', subagentId: 'native-child', role: 'Native Muse child', objective: 'Inspect the Muse child', result: { text: 'Muse child result' } }); childPermission = false; } if (afterChildApproval) { const next = afterChildApproval; afterChildApproval = undefined; next(); } else complete(); return; }
  if (request.method === 'userInput/answer') { reply(request, {}); notice('userInput/settled', { userInputId: 'question' }); complete(); return; }
  if (request.method !== 'turn/start') return fail(request, 'methodNotFound', 'Unknown fixture method');
  turn = params.commandId; const text = params.input.filter(part => part.type === 'text').map(part => part.text).join('\n'), prompt = text.match(/^Task: ([^\n]+)/m)?.[1] ?? text;
  const file = join(home, session + '.json'), saved = JSON.parse(readFileSync(file)); saved.prompts.push(prompt); writeFileSync(file, JSON.stringify(saved));
  trace({ prompt, turnId: turn, sessionId: session }); reply(request, { turnId: turn });
  if (prompt === 'mcp' && mcp) await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { text: 'muse-native' } } }) });
  if (prompt === 'hold') { holding = true; const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); trace({ child: child.pid }); return; }
  if (prompt === 'approval') { notice('approval/requested', { approvalId: 'write', currentRequirementId: { approvalId: 'write', sourceIndex: 1 }, availableChoices: approvals, toolName: 'write_file', rawArgs: '{"path":"fixture.txt"}', subject: { kind: 'write', path: 'fixture.txt' } }); return; }
  if (prompt === 'question' || prompt === 'question-two') { notice('userInput/requested', { userInputId: 'question', questions: [{ id: 'target', header: 'Target', question: 'Choose a target', options: [{ label: 'One' }, { label: 'Two' }], selection: { mode: 'multiple', minSelections: prompt === 'question-two' ? 2 : 1, maxSelections: 2 } }] }); return; }
  if (prompt === 'error') { notice('turn/completed', { terminal: 'failed', error: { message: 'Native Muse failure' } }); return; }
  if (prompt === 'joined' || prompt === 'joined-hold') {
    const rootTurn = turn, joinedTurn = 'native-joined-' + rootTurn;
    notice('turn/started', { turnId: joinedTurn });
    if (prompt === 'joined-hold') { holding = true; return; }
    complete(); turn = joinedTurn;
    item({ itemId: 'joined-answer', revision: 1, status: 'completed', kind: 'agentMessage', text: 'Joined native response' }); notice('turn/completed', { terminal: 'completed' }); return;
  }
  if (prompt.startsWith('background')) {
    const rootTurn = turn;
    item({ itemId: 'native-workflow', revision: 1, status: 'inProgress', kind: 'workflow', objective: 'Native workflow continues', children: [{ childId: 'workflow-child', attempt: 1, label: 'Workflow reviewer', status: 'scheduled' }] });
    item({ itemId: 'native-child-item', revision: 1, status: 'inProgress', kind: 'subagent', subagentId: 'native-child', role: 'Native Muse child', objective: 'Inspect the Muse child' });
    if (prompt.includes('hold')) { holding = true; const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); trace({ backgroundChild: child.pid }); }
    if (prompt.includes('mcp')) await callTaskTools('foreground');
    const wake = async () => {
      turn = rootTurn;
      if (prompt.includes('retry')) {
        item({ itemId: 'native-workflow', revision: 2, status: 'inProgress', kind: 'workflow', children: [{ childId: 'workflow-child', attempt: 1, status: 'completed', terminal: 'completed', failureKind: 'timeout' }] });
        item({ itemId: 'native-workflow', revision: 3, status: 'inProgress', kind: 'workflow', children: [{ childId: 'workflow-child', attempt: 2, status: 'running' }] });
      }
      item({ itemId: 'native-workflow', revision: prompt.includes('retry') ? 4 : 2, status: 'completed', kind: 'workflow', objective: 'Native workflow continues', finalSummary: 'Workflow complete', children: [{ childId: 'workflow-child', attempt: prompt.includes('retry') ? 2 : 1, status: 'completed', terminal: 'completed' }] });
      item({ itemId: 'native-child-item', revision: 3, status: 'completed', kind: 'subagent', subagentId: 'native-child', childSessionId: 'native-child-session', result: { text: 'Background Muse child result' } });
      turn = 'native-wake-' + rootTurn; trace({ nativeWake: turn }); notice('turn/started', {});
      if (prompt.includes('mcp')) await callTaskTools('wake');
      item({ itemId: 'wake-answer', revision: 1, kind: 'agentMessage', status: 'inProgress', text: 'Native wake' });
      if (!prompt.includes('hold-wake')) {
        item({ itemId: 'wake-answer', revision: 2, kind: 'agentMessage', status: 'completed', text: 'Native wake after background' }); notice('turn/completed', { terminal: 'completed' });
        if (prompt.includes('twice')) { turn = 'second-native-wake-' + rootTurn; notice('turn/started', {}); item({ itemId: 'second-answer', revision: 1, kind: 'agentMessage', status: 'completed', text: 'Second native wake answer' }); notice('turn/completed', { terminal: 'completed' }); }
      }
    };
    const invokeWake = () => { void wake().catch(error => { trace({ wakeError: error.message }); notice('turn/completed', { terminal: 'failed', error: { message: error.message } }); }); };
    const ask = () => { childPermission = true; afterChildApproval = invokeWake; turn = rootTurn; notice('approval/requested', { turnId: 'native-child-run', subagentOrigin: { subagentId: 'native-child' }, approvalId: 'write', currentRequirementId: { approvalId: 'write', sourceIndex: 1 }, availableChoices: approvals, toolName: 'write_file', rawArgs: '{}', subject: { kind: 'write', path: 'late-child.txt' } }); };
    complete();
    if (prompt.includes('early-approval')) { ask(); return; }
    if (prompt.includes('immediate-wake')) invokeWake();
    else { const timer = setInterval(() => { if (existsSync(join(home, 'emit-wake'))) { clearInterval(timer); if (prompt.includes('child-approval')) ask(); else invokeWake(); } }, 10); }
    return;
  }
  if (prompt === 'children-approval') { childPermission = true; item({ itemId: 'native-child-item', revision: 1, status: 'inProgress', kind: 'subagent', subagentId: 'native-child', role: 'Native Muse child', objective: 'Inspect the Muse child' }); notice('approval/requested', { turnId: 'native-child-run', subagentOrigin: { subagentId: 'native-child', childSessionId: 'native-child-session', childRunId: 'native-child-run' }, approvalId: 'write', currentRequirementId: { approvalId: 'write', sourceIndex: 1 }, availableChoices: approvals, toolName: 'write_file', rawArgs: '{}', subject: { kind: 'write', path: 'child.txt' } }); return; }
  if (prompt === 'children') {
    item({ itemId: 'native-child-item', revision: 1, status: 'inProgress', kind: 'subagent', subagentId: 'native-child', role: 'Native Muse child', objective: 'Inspect the Muse child' });
    item({ itemId: 'native-child-item', revision: 2, status: 'completed', kind: 'subagent', subagentId: 'native-child', childSessionId: 'child-session', role: 'Native Muse child', objective: 'Inspect the Muse child', result: { text: 'Muse child result' } });
    item({ itemId: 'native-child-item', revision: 1, status: 'inProgress', kind: 'subagent', role: 'Stale child revision' });
  }
  notice('turn/completed', { turnId: 'foreign-turn', terminal: 'completed' });
  send({ method: 'item/completed', params: { sessionId: 'foreign-session', turnId: turn, item: { itemId: 'foreign', revision: 1, kind: 'agentMessage', status: 'completed', text: 'Foreign Muse text' } } });
  item({ itemId: 'thought', revision: 1, kind: 'reasoning', status: 'inProgress', summary: ['Thinking'] }); notice('item/delta', { itemId: 'thought', field: 'summary.0', delta: ' carefully' });
  item({ itemId: 'command', revision: 1, kind: 'toolCall', tool: 'shell', args: '{"command":"printf fixture"}', status: 'inProgress' }); notice('item/delta', { itemId: 'command', field: 'visibleOutput', delta: 'native output' });
  item({ itemId: 'command', revision: 2, kind: 'toolCall', tool: 'shell', args: '{"command":"printf fixture"}', status: 'completed', visibleOutput: 'native output', exitCode: 0 });
  item({ itemId: 'answer', revision: 1, kind: 'agentMessage', status: 'inProgress', text: '' }); notice('item/delta', { itemId: 'answer', delta: 'Muse reply café\u2028' }); notice('item/delta', { itemId: 'answer', delta: 'line\u2029end' });
  item({ itemId: 'answer', revision: 1, kind: 'agentMessage', status: 'inProgress', text: 'Stale revision must not replace deltas' });
  notice('session/contextUsage', { usedTokens: 321, windowTokens: 8192 }); notice('session/todoListChanged', { items: [{ text: 'Finish fixture', status: 'completed' }] });
  setTimeout(complete, 40);
}
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { input += chunk; let index; while ((index = input.indexOf('\n')) >= 0) { const line = input.slice(0, index); input = input.slice(index + 1); if (line) { const value = JSON.parse(line); void handle(value).catch(error => fail(value, 'internalError', error.message)); } } });
process.stdin.on('end', () => { if (!holding) process.exit(0); });
