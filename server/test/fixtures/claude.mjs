#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR;
const value = flag => args.find(arg => arg.startsWith(flag + '='))?.slice(flag.length + 1) ?? (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const session = value('--session-id') || value('--resume');
const wire = message => appendFileSync(join(home, 'claude-wire.jsonl'), JSON.stringify(message) + '\n');
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
wire({ args, configDirectory: home });
if (args.includes('--version')) { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args.includes('auth')) { console.log('{"loggedIn":true,"authMethod":"api_key"}'); process.exit(0); }
const pending = new Map(); let first; const consumed = [];
function result(text, uuid) {
  send({ type: 'assistant', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, user_message_uuid: uuid,
    message: { id: 'reply-' + uuid, role: 'assistant', model: value('--model'), type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }, { type: 'thinking', thinking: 'private-test-thinking', signature: 'opaque' }], usage: { input_tokens: 1, output_tokens: 1 } } });
  send({ type: 'result', subtype: 'success', session_id: session, uuid: randomUUID(), user_message_uuid: uuid, user_message_uuids: [...consumed], result: text, is_error: false, duration_ms: 10, duration_api_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [] });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); wire(message);
  if (message.type === 'control_request') {
    send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
      commands: [], account: { tokenSource: 'ANTHROPIC_API_KEY' }, models: [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['medium', 'high'] }, { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['high'] }],
    } } });
  }
  if (message.type === 'user') {
    const text = message.message.content;
    const uuid = message.uuid; consumed.push(uuid);
    if (value('--resume') && !existsSync(join(home, session + '.session'))) throw new Error('Missing persisted session');
    writeFileSync(join(home, session + '.session'), uuid);
    if (text.includes('wait-for-cancel')) return;
    if (text.includes('wait-for-steer')) {
      first = message;
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, user_message_uuid: uuid, event: { type: 'message_start', message: { id: 'steer-message' } } });
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      send({ type: 'stream_event', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working' } } }); return;
    }
    if (first) { result('Included: ' + text, uuid); first = undefined; return; }
    if (text.includes('permission-test') || text.includes('question-test')) {
      const question = text.includes('question-test');
      const input = question ? { questions: [{ question: 'Which option?', header: 'Choice', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } : { file_path: join(process.cwd(), 'allowed.txt'), content: 'authorized' };
      const id = randomUUID(); pending.set(id, { input, question, uuid });
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
    if (allow && !item.question) writeFileSync(item.input.file_path, item.input.content);
    send({ type: 'user', session_id: session, uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-' + item.uuid, content: allow ? 'done' : 'denied', is_error: !allow }] } });
    result(item.question ? JSON.stringify(decision.updatedInput?.answers ?? {}) : allow ? 'Allowed' : 'Declined', item.uuid); pending.delete(message.response.request_id);
  }
});
