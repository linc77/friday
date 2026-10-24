#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const generation = Number(process.env.ACP_TEST_GENERATION ?? 1), wire = process.env.ACP_TEST_WIRE, home = process.env.ACP_TEST_HOME;
const trace = value => appendFileSync(wire, JSON.stringify({ pid: process.pid, ...value }) + '\n'), send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'), reply = (request, result) => send({ id: request.id, result });
let buffer = '', session, pendingPermission, prompt;
const update = value => send({ method: 'session/update', params: { sessionId: session, update: value } });
const catalog = () => ({ sessionId: session, models: { currentModelId: 'native-model', availableModels: [{ modelId: 'native-model', name: 'Native model' }] }, modes: { currentModeId: JSON.parse(readFileSync(join(home, session), 'utf8')).mode, availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] }, configOptions: [...(process.env.ACP_TEST_EXTRA_OPTIONS === '1' ? [{ configId: 'output_style', name: 'Output style', type: 'select', currentValue: 'terse', options: [{ value: 'terse', name: 'Terse' }, { value: 'verbose', name: 'Verbose' }] }] : []), { id: 'model', configId: 'model', category: 'model', type: 'select', currentValue: 'native-model', options: [{ value: 'native-model', name: 'Native model' }, { value: 'other-model', name: 'Other' }] }, { id: 'reasoning_effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] }] });
const finish = () => {
  send({ method: 'session/update', params: { sessionId: 'foreign', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG' } } } });
  update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Native reasoning' } });
  update({ sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'printf native', kind: 'execute', status: 'in_progress', rawInput: { command: 'printf native' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'native tool output' } }] });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACP reply café\u2028' } }); update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'line\u2029end' } });
  update({ sessionUpdate: 'usage_update', used: 12, size: 120000 });
  if (generation === 2) update({ sessionUpdate: 'state_update', state: 'idle' }); else reply(prompt, { stopReason: 'end_turn' });
};
const options = [{ optionId: 'exact-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'exact-session', name: 'Allow session', kind: 'allow_always' }, { optionId: 'exact-reject', name: 'Reject', kind: 'reject_once' }];
async function handle(request) {
  if (request.id === 'permission-native' && request.result) { trace({ answered: request.result }); if (pendingPermission?.method === 'session/new') reply(pendingPermission, catalog()); else finish(); pendingPermission = undefined; return; }
  trace({ method: request.method, params: request.params, ...(request.method === 'initialize' ? { tempDirectory: process.env.TMPDIR, keyPresent: !!process.env.GEMINI_API_KEY } : {}) }); const params = request.params ?? {};
  if (request.method === 'initialize') return reply(request, generation === 2 ? { protocolVersion: 2, info: { name: 'Native ACP fixture', version: '2' }, capabilities: { session: { prompt: { image: {} }, mcp: { http: {} } } }, authMethods: [{ methodId: 'native-auth', name: 'Native auth', type: 'agent' }] } : { protocolVersion: 2, agentInfo: { name: 'Legacy ACP fixture' }, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, promptCapabilities: { image: true }, mcpCapabilities: { http: true } }, authMethods: [{ id: 'native-auth', name: 'Native auth', type: 'agent' }] });
  if (request.method === 'authenticate' || request.method === 'auth/login') { if (process.env.ACP_TEST_HOLD_AUTH === '1') return; return reply(request, {}); }
  if (request.method === 'session/new') {
    session = 'session-' + randomUUID(); mkdirSync(home, { recursive: true }); writeFileSync(join(home, session), JSON.stringify({ mode: 'default' }));
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compress', description: 'Native compression' }, { name: '$review', description: 'Native review skill' }] });
    if (process.env.ACP_TEST_INIT_PERMISSION === '1') { pendingPermission = request; send({ id: 'permission-native', method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'initial', title: 'Trust workspace', kind: 'execute' }, options } }); return; }
    return reply(request, catalog());
  }
  if (request.method === 'session/load' || request.method === 'session/resume') {
    if (!existsSync(join(home, params.sessionId))) return send({ id: request.id, error: { code: -32001, message: 'Native ACP session not found' } }); session = params.sessionId; update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Loaded history must not replay' } }); return reply(request, catalog());
  }
  if (['session/set_mode', 'session/set_model', 'session/set_config_option'].includes(request.method)) { if (request.method === 'session/set_mode') writeFileSync(join(home, session), JSON.stringify({ mode: params.modeId })); return reply(request, {}); }
  if (request.method === 'session/cancel') { trace({ cancelled: true }); if (prompt && generation === 1) reply(prompt, { stopReason: 'cancelled' }); return; }
  if (request.method === 'session/prompt') {
    prompt = request; const raw = params.prompt.find(value => value.type === 'text')?.text ?? '', text = raw.match(/^Task: ([^\n]+)/m)?.[1] ?? raw; trace({ prompt: text, sessionId: session }); if (generation === 2) reply(request, {});
    if (text === 'hold') { const stubborn = process.env.ACP_TEST_STUBBORN_CHILD === '1', child = spawn(process.execPath, ['-e', stubborn ? 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)' : 'setInterval(()=>{},1000)'], { stdio: stubborn ? ['ignore', 'pipe', 'ignore'] : 'ignore' }); if (stubborn) child.stdout.once('data', () => trace({ child: child.pid })); else trace({ child: child.pid }); return; }
    if (text === 'permission') { pendingPermission = request; send({ id: 'permission-native', method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'write', title: 'Write', kind: 'edit' }, options } }); return; }
    if (text === 'error') { if (generation === 1) reply(request, { stopReason: 'error', _meta: { message: 'Native ACP failure' } }); else update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'error' }); return; }
    finish();
  }
}
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) void handle(JSON.parse(line)); } });
