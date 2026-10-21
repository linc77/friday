#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), home = process.env.GROK_HOME;
const modelState = { currentModelId: 'grok-fast', availableModels: [
  { modelId: 'grok-fast', name: 'Grok Fast', _meta: { supportsReasoningEffort: true, reasoningEffort: 'high', reasoningEfforts: [{ value: 'low', label: 'Low' }, { id: 'high', label: 'High', default: true }, { value: 'native-effort', label: 'Native effort' }, { value: 'bad value' }] } },
  { modelId: 'grok-plain', name: 'Grok Plain', _meta: { supportsReasoningEffort: false, reasoningEfforts: [{ value: 'high' }] } },
] };
const trace = value => { if (process.env.GROK_TEST_WIRE) appendFileSync(process.env.GROK_TEST_WIRE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: args, probe: process.env.GROK_DISABLE_AUTOUPDATER, ...value }) + '\n'); };
if (args.includes('--version')) { trace({ command: 'version' }); console.log('Grok 1.2.3'); process.exit(0); }
if (args[0] === 'models') { trace({ command: 'models' }); console.log((process.env.GROK_TEST_AUTH === 'none' ? 'Not authenticated' : 'You are logged in') + '\n* grok-fast (default)\n- grok-plain'); process.exit(0); }
if (args[0] === 'inspect') { trace({ command: 'inspect' }); console.log(JSON.stringify({ skills: [{ name: 'review', description: 'Review changes', userInvocable: true, source: { path: join(process.cwd(), '.grok/skills/review/SKILL.md'), type: 'project' } }, { name: 'hidden', userInvocable: false, source: { path: '/fixture/hidden/SKILL.md', type: 'plugin' } }], privateKey: 'must-not-be-public' })); process.exit(0); }
if (!args.includes('agent') || !args.includes('stdio')) process.exit(2);
const v2 = process.env.GROK_TEST_PROTOCOL === '2';
const configOptions = [{ configId: 'native-model', name: 'Model', category: 'model', type: 'select', currentValue: 'grok-fast', options: [{ value: 'grok-fast', name: 'Fast' }, { value: 'grok-plain', name: 'Plain' }] }, { configId: 'native-effort', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'native-effort', name: 'Native' }] }];
let sessionId, authenticated = process.env.GROK_TEST_AUTH_REQUIRED !== '1', mcpServers = [], buffer = '', currentPrompt;
const pending = new Map();
const emit = record => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...record }) + '\n');
const notify = (method, params) => emit({ method, params });
const update = (change, meta) => notify('session/update', { sessionId, update: change, ...(meta ? { _meta: meta } : {}) });
const respond = (request, result) => emit({ id: request.id, result });
const error = (request, code, message) => emit({ id: request.id, error: { code, message } });
function requestClient(method, params) { const id = 'native-' + randomUUID(); return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); emit({ id, method, params }); }); }
function save(message) { const path = join(home, 'sessions', sessionId + '.json'); const data = JSON.parse(readFileSync(path)); data.messages.push(message); writeFileSync(path, JSON.stringify(data)); }
async function mcpCall(server) {
  const records = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'grok-fixture', version: '1' } } }, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fixture_write', arguments: { text: 'Written through real Friday MCP transport' } } }];
  if (server.type === 'http') {
    for (const record of records) { const res = await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...Object.fromEntries(server.headers.map(value => [value.name, value.value])) }, body: JSON.stringify(record) }); if (!res.ok) throw Error('MCP HTTP failed'); await res.text(); }
  } else {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map(value => [value.name, value.value])) }, stdio: ['pipe', 'pipe', 'ignore'] }); let input = ''; const waits = new Map();
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { input += chunk; let newline; while ((newline = input.indexOf('\n')) >= 0) { const line = input.slice(0, newline); input = input.slice(newline + 1); if (!line) continue; const value = JSON.parse(line); waits.get(value.id)?.(value); } });
    for (const record of records) { const result = new Promise(resolve => waits.set(record.id, resolve)); child.stdin.write(JSON.stringify(record) + '\n'); const value = await result; if (value.error) throw Error(value.error.message); }
    child.stdin.end(); await new Promise(resolve => child.once('close', resolve));
  }
}
async function handle(record) {
  trace({ method: record.method, id: record.id, params: record.params, nativeResult: record.result, nativeError: record.error });
  if (!record.method) { const current = pending.get(record.id); if (current) { pending.delete(record.id); record.error ? current.reject(Error(record.error.message)) : current.resolve(record.result); } return; }
  const params = record.params ?? {};
  if (record.method === 'initialize') {
    if (!params.info || !params.clientInfo || !params.capabilities || !params.clientCapabilities || params.protocolVersion !== 2) return error(record, -32602, 'Missing negotiating initialization fields');
    const authMethods = [{ [v2 ? 'methodId' : 'id']: 'cached_token', name: 'Grok', type: 'agent' }, { [v2 ? 'methodId' : 'id']: 'xai.api_key', name: 'API key', type: 'agent' }];
    return respond(record, { protocolVersion: process.env.GROK_TEST_PROTOCOL === '1' ? 1 : 2,
      ...(v2 ? { info: { name: 'grok-fixture', version: '1.2.3' }, capabilities: { session: { prompt: { image: {} }, mcp: { stdio: {}, ...(process.env.GROK_TEST_MCP_HTTP === '1' ? { http: {} } : {}) } } } }
        : { agentInfo: { name: 'grok-fixture', version: '1.2.3' }, agentCapabilities: { loadSession: process.env.GROK_TEST_RESUME !== '1', sessionCapabilities: { resume: {} }, promptCapabilities: { image: false }, mcpCapabilities: { http: process.env.GROK_TEST_MCP_HTTP === '1' } } }),
      authMethods, _meta: { modelState, availableCommands: [{ name: 'compact', description: 'Compact history' }, { name: 'native-command', description: 'Native command' }, { name: 'always-approve', description: 'Forbidden permission shortcut' }, { name: 'context', description: 'No ACP output' }] } });
  }
  if (record.method === (v2 ? 'auth/login' : 'authenticate')) { authenticated = true; return respond(record, {}); }
  if (['session/new', 'session/load', 'session/resume'].includes(record.method)) {
    if (v2 && record.method === 'session/load') return error(record, -32601, 'v2 removed session/load');
    if (record.method !== 'session/new' && process.env.GROK_TEST_FAIL_RESUME === '1') return error(record, -32603, 'Native resume failed');
    if (v2 && params.mcpServers?.some(server => !server.type)) return error(record, -32602, 'v2 requires MCP transport discriminant');
    if (!authenticated) return error(record, -32000, 'Authentication required');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    if (record.method === 'session/new') { sessionId = 'fixture-' + randomUUID(); writeFileSync(join(home, 'sessions', sessionId + '.json'), JSON.stringify({ messages: [] })); }
    else { if (!existsSync(join(home, 'sessions', params.sessionId + '.json'))) return error(record, -32602, 'Session not found'); sessionId = params.sessionId; update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Loaded history must not replay into the new run' } }); }
    mcpServers = params.mcpServers ?? [];
    if (process.env.GROK_TEST_EARLY_PERMISSION === '1') {
      const toolCall = { toolCallId: 'trust', title: 'Trust fixture workspace', kind: 'other' };
      await requestClient('session/request_permission', { sessionId, ...(v2 ? { title: toolCall.title, subject: { type: 'tool_call', toolCall } } : { toolCall }), options: [{ kind: 'allow_once', optionId: 'allow-once', name: 'Allow once' }] });
    }
    return respond(record, { sessionId, ...(v2 ? { configOptions } : { models: modelState }) });
  }
  if (record.method === 'session/set_model') return v2 ? error(record, -32601, 'v2 removed session/set_model') : respond(record, {});
  if (record.method === 'session/set_config_option') {
    const option = configOptions.find(option => option.configId === params.configId);
    if (!v2 || params.type !== 'id' || !option?.options.some(value => value.value === params.value)) return error(record, -32602, 'Wrong native config');
    option.currentValue = params.value; return respond(record, { configOptions });
  }
  if (record.method === 'session/cancel') { trace({ cancelTrigger: params._meta?.cancelTrigger }); if (currentPrompt) notify('_x.ai/session/prompt_complete', { sessionId, promptId: currentPrompt, stopReason: 'cancelled' }); return; }
  if (record.method !== 'session/prompt') { if (record.id !== undefined) error(record, -32601, 'Unsupported fixture method'); return; }
  if (params.sessionId !== sessionId) return error(record, -32602, 'Wrong native session');
  if (process.env.GROK_TEST_BEFORE_START && !existsSync(process.env.GROK_TEST_BEFORE_START)) return error(record, -32603, 'Native prompt preceded durable start receipt');
  const text = params.prompt.filter(value => value.type === 'text').map(value => value.text).join('\n'), command = text.match(/^Task: ([^\n]+)/m)?.[1] ?? text, promptId = params._meta.promptId;
  currentPrompt = promptId; trace({ prompt: command, sessionId, promptId });
  if (command === 'hold') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); trace({ child: child.pid }); return; }
  if (command === 'error') { notify('_x.ai/session/prompt_complete', { sessionId, promptId, stopReason: 'error', agentResult: 'Native Grok failure' }); return; }
  if (command === 'compact' || command === '/compact') { update({ sessionUpdate: 'usage_update', used: 120, size: 8192 }); return respond(record, { stopReason: 'end_turn' }); }
  if (command === 'patches') {
    const changes = [{ sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'Draft' } }, { sessionUpdate: 'agent_message', messageId: 'answer', content: null }, { sessionUpdate: 'agent_message_chunk', messageId: 'answer', content: { type: 'text', text: 'Replacement' } }, { sessionUpdate: 'agent_message', messageId: 'answer', _meta: { note: 'Metadata-only upsert' } }, { sessionUpdate: 'agent_thought', messageId: 'thought', content: [{ type: 'text', text: 'Thought snapshot' }] }, { sessionUpdate: 'tool_call_update', toolCallId: 'streamed', title: 'Native streamed tool', kind: 'execute', status: 'in_progress' }, { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'streamed', content: { type: 'content', content: { type: 'text', text: 'first ' } } }, { sessionUpdate: 'tool_call_content_chunk', toolCallId: 'streamed', content: { type: 'content', content: { type: 'text', text: 'second' } } }, { sessionUpdate: 'tool_call_update', toolCallId: 'streamed', status: 'completed' }, { sessionUpdate: 'terminal_update', terminalId: 'term', command: 'printf unicode' }, { sessionUpdate: 'terminal_output_chunk', terminalId: 'term', data: Buffer.from([0xf0, 0x9f]).toString('base64') }, { sessionUpdate: 'terminal_output_chunk', terminalId: 'term', data: Buffer.from([0x99, 0x82]).toString('base64') }, { sessionUpdate: 'terminal_update', terminalId: 'term', exitStatus: { exitCode: 0 } }, { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'native-plan', entries: [{ content: 'Finish fixture', status: 'completed', priority: 'medium' }] } }];
    process.stdout.write(JSON.stringify(changes.map(change => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: change } }))) + '\n');
    respond(record, {}); update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }); return;
  }
  if (command === 'question') await requestClient('_x.ai/ask_user_question', { sessionId, questions: [{ id: 'choice', header: 'Target', question: 'Choose a target', options: [{ label: 'One', description: 'First', preview: 'preview-one' }, { label: 'Two', description: 'Second' }], multiSelect: false }], mode: 'default' });
  if (command === 'approval') {
    const toolCall = { toolCallId: 'write', title: 'Write fixture', kind: 'edit', rawInput: { path: 'fixture.txt' } };
    const result = await requestClient('session/request_permission', { sessionId, ...(v2 ? { title: toolCall.title, subject: { type: 'tool_call', toolCall } } : { toolCall }), options: [{ kind: 'reject_once', optionId: 'reject', name: 'Decline' }, { kind: 'allow_always', optionId: 'project-permanent', name: 'Always allow project' }, { kind: 'allow_always', optionId: 'allow-edits-session', name: 'Allow session edits' }, { kind: 'allow_once', optionId: 'allow', name: 'Approve' }] });
    trace({ permissionOutcome: result });
  }
  if (command === 'proposal') await requestClient('_x.ai/exit_plan_mode', { sessionId, toolCallId: 'plan', planContent: '# Native plan\n\nInspect, then implement.' });
  if (command === 'mcp') { if (!mcpServers.length) throw Error('Missing native MCP configuration'); await mcpCall(mcpServers[0]); }
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Foreign session text' } }, { promptId: 'task-completed-foreign' });
  notify('session/update', { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Another session text' } } });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Native Grok reasoning' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'command', kind: 'execute', title: 'printf fixture', status: 'in_progress', rawInput: { command: 'printf fixture' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'native output' } }] });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Grok reply café\u2028' } });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'line\u2029end' } });
  update({ sessionUpdate: 'usage_update', used: 456, size: 8192 }); save(command);
  if (command === 'fallback') {
    respond(record, {});
    notify('_x.ai/session/prompt_complete', { sessionId, promptId: 'task-completed-foreign', stopReason: 'end_turn' });
    setTimeout(() => { trace({ nativeCompletion: promptId }); notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'turn_completed', prompt_id: promptId, stop_reason: 'end_turn' } }); }, 40);
  } else if (v2) { respond(record, {}); update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }); }
  else respond(record, { stopReason: 'end_turn' });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; let newline; while ((newline = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (line) { const record = JSON.parse(line); void handle(record).catch(failure => { if (record.id !== undefined) error(record, -32603, failure.message); }); } } });
