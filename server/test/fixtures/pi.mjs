#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('1.0.3'); process.exit(0); }
const home = process.env.PI_CODING_AGENT_DIR;
const ephemeral = process.argv.includes('--no-session');
if (!ephemeral) mkdirSync(join(home, 'sessions'), { recursive: true });
let sessionFile = ephemeral ? undefined : join(home, 'sessions', randomUUID() + '.json');
if (sessionFile) writeFileSync(sessionFile, JSON.stringify({ messages: [] }));
let streaming = false, model = { provider: 'fixture', id: 'small', name: 'Fixture Small', reasoning: true, contextWindow: 8192 }, thinkingLevel = 'medium', pending;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (record, data, error) => emit({ type: 'response', id: record.id, command: record.type, success: !error, ...(error ? { error } : { data }) });
const trace = record => { if (process.env.PI_TEST_WIRE) appendFileSync(process.env.PI_TEST_WIRE, JSON.stringify({ pid: process.pid, ...record }) + '\n'); };
function finish(text) {
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Native reasoning' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text.slice(0, 5) } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text.slice(5) } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Native reasoning' }, { type: 'text', text }], stopReason: 'stop' } });
  if (sessionFile) { const data = JSON.parse(readFileSync(sessionFile)); data.messages.push(text); writeFileSync(sessionFile, JSON.stringify(data)); }
  // agent_end is deliberately earlier than settlement, as with native extensions.
  emit({ type: 'agent_end' });
  setTimeout(() => { streaming = false; emit({ type: 'agent_settled', aborted: false }); }, 15);
}
async function command(record) {
  const message = typeof record.message === 'string' ? record.message.match(/^Task: ([^\n]+)/m)?.[1] ?? record.message : undefined;
  trace({ ...record, fixturePrompt: message, sessionFile, argv: process.argv.slice(2), permission: process.env.FRIDAY_PI_RUNTIME_MODE });
  if (record.type === 'get_state') return response(record, { model, thinkingLevel, sessionFile, isStreaming: streaming, pendingMessageCount: 0 });
  if (record.type === 'get_available_models') return response(record, { models: [model, { provider: 'fixture', id: 'max', name: 'Fixture Max', reasoning: true, thinkingLevelMap: { high: null, xhigh: 'high', max: 9999 } }, { provider: 'fixture', id: 'plain', reasoning: false }] });
  if (record.type === 'get_commands') return response(record, { commands: [{ name: 'native-command', source: 'extension', description: 'Native command' }, { name: 'skill:fixture', source: 'skill', sourceInfo: { path: '/fixture/SKILL.md', scope: 'project' } }] });
  if (record.type === 'get_session_stats') return response(record, { contextUsage: { tokens: 123, contextWindow: 8192 } });
  if (record.type === 'switch_session') {
    if (!existsSync(record.sessionPath)) return response(record, null, 'Unknown session');
    sessionFile = record.sessionPath; return response(record, { cancelled: false });
  }
  if (record.type === 'set_model') { model = { ...model, provider: record.provider, id: record.modelId }; return response(record, model); }
  if (record.type === 'set_thinking_level') { thinkingLevel = record.level; return response(record, { level: thinkingLevel }); }
  if (record.type === 'compact') { response(record, { summary: 'Compacted', tokensBefore: 100 }); return; }
  if (record.type === 'extension_ui_response') {
    if (pending) { const prompt = pending; pending = undefined; finish(record.confirmed === true || typeof record.value === 'string' ? 'Approved native reply' : 'Declined native reply'); trace({ responseFor: prompt, nativeResponse: record }); }
    return;
  }
  if (record.type === 'prompt') {
    if (process.env.PI_TEST_BEFORE_START && !existsSync(process.env.PI_TEST_BEFORE_START)) return response(record, null, 'Prompt preceded persisted external start');
    response(record, {}); streaming = true; emit({ type: 'agent_start' });
    if (message === 'hold') {
      const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); trace({ child: child.pid }); return;
    }
    if (message === 'approval' || message === 'question') {
      pending = randomUUID();
      emit({ type: 'extension_ui_request', id: pending, method: message === 'approval' ? 'confirm' : 'select', title: message === 'approval' ? 'Allow write?' : 'Select target', message: 'fixture action', options: ['One', 'Two'] }); return;
    }
    if (message === 'error') {
      emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'Native model failure', content: [] } });
      streaming = false; emit({ type: 'agent_settled' }); return;
    }
    emit({ type: 'tool_execution_start', toolCallId: 'native-bash', toolName: 'bash', args: { command: 'printf fixture' } });
    emit({ type: 'tool_execution_end', toolCallId: 'native-bash', toolName: 'bash', result: { content: [{ type: 'text', text: 'fixture' }] }, isError: false });
    finish('Pi reply café\u2028line\u2029end'); return;
  }
  return response(record, null, 'Unsupported fixture command');
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) void command(JSON.parse(line)); } });
