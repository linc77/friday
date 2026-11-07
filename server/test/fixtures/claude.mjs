#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR;
const value = flag => args.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1) ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const session = value('--session-id') || value('--resume');
const wire = message => appendFileSync(join(home, 'claude-wire.jsonl'), JSON.stringify(message) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
wire({ args, configDirectory: home, pid: process.pid });
if (args.includes('--version')) { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args.includes('auth')) { console.log('{"loggedIn":true,"authMethod":"api_key"}'); process.exit(0); }
const pending = new Map(); let first; const consumed = [];
function result(text, uuid, structured) {
  send({ type: 'assistant', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, user_message_uuid: uuid,
    message: { id: 'reply-' + uuid, role: 'assistant', model: value('--model'), type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'private-test-thinking', signature: 'opaque' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', subtype: 'success', session_id: session, uuid: randomUUID(), user_message_uuid: uuid, user_message_uuids: [...consumed], result: text, ...(structured ? { structured_output: structured } : {}), is_error: false, duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); wire(message);
  if (message.type === 'control_request') {
    const initialized = () => send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
      commands: [{ name: 'compact', description: 'Compact context', argumentHint: '', builtin: true }], account: { tokenSource: 'ANTHROPIC_API_KEY' }, models: [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['medium', 'high'] }, { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['high'] }],
    } } });
    if (home.includes('slow-init')) setTimeout(initialized, 1000); else initialized();
  }
  if (message.type === 'user') {
    const text = typeof message.message.content === 'string' ? message.message.content : message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    const uuid = message.uuid; consumed.push(uuid);
    if (value('--resume') && !existsSync(join(home, session + '.session'))) throw new Error('Missing persisted session');
    writeFileSync(join(home, session + '.session'), uuid);
    if (text === '/compact') {
      send({ type: 'system', subtype: 'compact_boundary', session_id: session, uuid: randomUUID(), compact_metadata: { trigger: 'manual', pre_tokens: 8000, post_tokens: 800 } });
      send({ type: 'result', subtype: 'success', session_id: session, uuid: randomUUID(), user_message_uuid: uuid, user_message_uuids: [...consumed], result: '', is_error: false, duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] }); return;
    }
    if (text.includes('wait-for-cancel')) return;
    if (text.includes('structured-title-test')) { result('Explanatory assistant prose is not the structured title', uuid, { title: 'Structured title', needsRefinement: false }); return; }
    if (text.includes('foreground-output-')) {
      const tool = 'bash-' + uuid; const task = 'task-' + uuid;
      const folder = join(process.env.CLAUDE_CODE_TMPDIR, 'claude-' + process.getuid(), 'fixture-project', session, 'tasks');
      const file = join(folder, task + '.output');
      const missing = text.includes('foreground-output-missing');
      if (!missing) { mkdirSync(folder, { recursive: true }); writeFileSync(file, 'first café 🚀\n'); }
      wire({ foregroundOutputFile: file });
      send({ type: 'assistant', session_id: session, uuid: randomUUID(), parent_tool_use_id: null,
        message: { id: 'bash-message-' + uuid, role: 'assistant', model: 'sonnet', content: [{ type: 'tool_use', id: tool, name: 'Bash', input: { command: 'fixture command' } }] } });
      send({ type: 'system', subtype: 'task_started', task_id: task, run_id: 'run-' + uuid, tool_use_id: tool, task_type: 'local_bash', is_backgrounded: false, description: 'Fixture Bash', uuid: randomUUID(), session_id: session });
      if (text.includes('foreground-output-cancel')) return;
      const deadline = Date.now() + (missing ? 0 : 3000);
      const completion = setInterval(() => {
        if (!existsSync(join(home, 'tail-observed')) && Date.now() < deadline) return;
        clearInterval(completion);
        if (!missing) appendFileSync(file, 'last bytes\n');
        send({ type: 'user', session_id: session, uuid: randomUUID(), parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: missing ? 'SDK fallback output\n' : 'first café 🚀\nlast bytes\n' }] } });
        result('Bash finished', uuid);
      }, 15);
      return;
    }
    if (text.includes('wait-for-steer')) {
      first = message;
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, user_message_uuid: uuid, event: { type: 'message_start', message: { id: 'steer-message' } } });
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } }); return;
    }
    if (first) { result('Included: ' + text, uuid); first = undefined; return; }
    if (text.includes('plan-test')) {
      const input = { plan: '# Native Claude plan\n\nInspect, implement and verify.' }; const id = randomUUID();
      pending.set(id, { input, plan: true, uuid });
      send({ type: 'assistant', session_id: session, uuid: randomUUID(), parent_tool_use_id: null,
        message: { id: 'tools-' + uuid, role: 'assistant', model: 'sonnet', content: [{ type: 'tool_use', id: 'tool-' + uuid, name: 'ExitPlanMode', input }] } });
      send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input, tool_use_id: 'tool-' + uuid } }); return;
    }
    if (text.includes('permission-test') || text.includes('question-test')) {
      const question = text.includes('question-test');
      const input = question ? { questions: [{ question: 'Which option?', header: 'Choice', multiSelect: true, options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } : { file_path: join(process.cwd(), 'allowed.txt'), content: 'authorized' };
      const id = randomUUID(); pending.set(id, { input, question, uuid, toolCursor: text.includes('tool-result-cursor') });
      send({ type: 'assistant', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, message: { id: 'tools-' + uuid, role: 'assistant', model: 'sonnet', content: [{ type: 'tool_use', id: 'tool-' + uuid, name: question ? 'AskUserQuestion' : 'Write', input }] } });
      send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: question ? 'AskUserQuestion' : 'Write', input, tool_use_id: 'tool-' + uuid } }); return;
    }
    send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'reply-' + uuid } } });
    send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Verified ' } } });
    send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude' } } });
    result('Verified Claude', uuid);
  }
  if (message.type === 'control_response') {
    const item = pending.get(message.response.request_id); if (!item) return;
    const decision = message.response.response;
    const allow = decision.behavior === 'allow';
    if (allow && !item.question && !item.plan) writeFileSync(item.input.file_path, item.input.content);
    const toolResultUUID = randomUUID();
    send({ type: 'user', session_id: session, uuid: toolResultUUID, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-' + item.uuid, content: allow ? 'done' : 'denied', is_error: !allow }] } });
    if (item.toolCursor) {
      wire({ nativeToolResultUUID: toolResultUUID });
      send({ type: 'result', subtype: 'error_during_execution', session_id: session, uuid: randomUUID(), is_error: true, errors: ['fixture stopped after tool result'], duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
      pending.delete(message.response.request_id); return;
    }
    result(item.plan ? 'Plan captured' : item.question ? JSON.stringify(decision.updatedInput?.answers ?? {}) : allow ? 'Allowed' : 'Declined', item.uuid); pending.delete(message.response.request_id);
  }
});
