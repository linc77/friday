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
const forkSource = process.argv[process.argv.indexOf('--fork') + 1];
if (sessionFile) writeFileSync(sessionFile, process.argv.includes('--fork') ? readFileSync(forkSource) : JSON.stringify({ messages: [], entries: [], leafId: null }));
let streaming = false, model = { provider: 'fixture', id: 'small', name: 'Fixture Small', reasoning: true, contextWindow: 8192 }, thinkingLevel = 'medium', pending;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const response = (record, data, error) => emit({ type: 'response', id: record.id, command: record.type, success: !error, ...(error ? { error } : { data }) });
const trace = record => { if (process.env.PI_TEST_WIRE) appendFileSync(process.env.PI_TEST_WIRE, JSON.stringify({ pid: process.pid, ...record }) + '\n'); };
let lastText = '';
const branch = data => { const all = new Map((data.entries ?? []).map(entry => [entry.id, entry])); const result = []; for (let id = data.leafId; id; id = all.get(id).parentId) result.push(all.get(id)); return result.reverse(); };
function appendMessage(message) {
  if (!sessionFile) return;
  const data = JSON.parse(readFileSync(sessionFile)); data.entries ??= [];
  const entry = { id: randomUUID(), parentId: data.leafId ?? null, type: 'message', message };
  data.entries.push(entry); data.leafId = entry.id; writeFileSync(sessionFile, JSON.stringify(data));
}
function finish(text) {
  lastText = text;
  emit({ type: 'message_start', message: { role: 'assistant' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Native reasoning' } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text.slice(0, 5) } });
  emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text.slice(5) } });
  emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Native reasoning' }, { type: 'text', text }], stopReason: 'stop' } });
  if (sessionFile) { const data = JSON.parse(readFileSync(sessionFile)); data.messages.push(text); writeFileSync(sessionFile, JSON.stringify(data)); }
  appendMessage({ role: 'assistant', content: [{ type: 'text', text }] });
  // agent_end is deliberately earlier than settlement, as with native extensions.
  emit({ type: 'agent_end' });
  setTimeout(() => { streaming = false; emit({ type: 'agent_settled', aborted: false }); }, 15);
}
async function command(record) {
  const message = typeof record.message === 'string' ? record.message.match(/^Task: ([^\n]+)/m)?.[1] ?? record.message : undefined;
  trace({ ...record, fixturePrompt: message, sessionFile, argv: process.argv.slice(2), permission: process.env.FRIDAY_PI_RUNTIME_MODE });
  if (record.type === 'get_last_assistant_text') return response(record, { text: lastText });
  if (record.type === 'get_entries') { const data = sessionFile ? JSON.parse(readFileSync(sessionFile)) : {}; return response(record, { entries: data.entries ?? [], leafId: data.leafId ?? null }); }
  if (record.type === 'get_messages') { const data = sessionFile ? JSON.parse(readFileSync(sessionFile)) : {}; return response(record, { messages: branch(data).map(entry => entry.message) }); }
  if (record.type === 'fork') {
    const data = JSON.parse(readFileSync(sessionFile)), active = branch(data), boundary = active.findIndex(entry => entry.id === record.entryId && entry.message?.role === 'user');
    if (boundary < 0) return response(record, null, 'Unknown active user entry');
    const retained = active.slice(0, boundary);
    sessionFile = join(home, 'sessions', randomUUID() + '.json');
    writeFileSync(sessionFile, JSON.stringify({ entries: retained, leafId: retained.at(-1)?.id ?? null, messages: retained.filter(entry => entry.message?.role === 'assistant').map(entry => entry.message.content[0].text) }));
    return response(record, { cancelled: false });
  }
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
    appendMessage({ role: 'user', content: [{ type: 'text', text: record.message }] });
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
    if (!process.argv.includes('--no-tools')) emit({ type: 'tool_execution_start', toolCallId: 'native-bash', toolName: 'bash', args: { command: 'printf fixture' } });
    if (!process.argv.includes('--no-tools')) emit({ type: 'tool_execution_end', toolCallId: 'native-bash', toolName: 'bash', result: { content: [{ type: 'text', text: 'fixture' }] }, isError: false });
    finish('Pi reply café\u2028line\u2029end'); return;
  }
  return response(record, null, 'Unsupported fixture command');
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) void command(JSON.parse(line)); } });
