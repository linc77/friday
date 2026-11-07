#!/usr/bin/env node
// Owned protocol fixture. No model, shell, account, or external service is used.
import { appendFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2), home = process.env.CLAUDE_CONFIG_DIR;
const flag = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const thread = flag('--session-id') || flag('--resume');
const wire = value => appendFileSync(join(home, 'native-wire'), JSON.stringify(value) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const system = (subtype, value) => send({ type: 'system', subtype, uuid: randomUUID(), session_id: thread, ...value });
wire({ args, pid: process.pid });
if (args.includes('--version')) { console.log('2.1.285 (Claude Code)'); process.exit(0); }
if (args.includes('auth')) { console.log('{"loggedIn":true,"authMethod":"api_key"}'); process.exit(0); }
const models = [{ value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['medium', 'high'] }];
const assistant = (text, uuid, tool) => send({ type: 'assistant', session_id: thread, uuid: randomUUID(), parent_tool_use_id: null,
  ...(uuid ? { user_message_uuid: uuid } : {}), message: { id: randomUUID(), role: 'assistant', model: 'sonnet', usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }, content: tool ? [tool] : [{ type: 'text', text }] } });
const child = (text, tool = 'tool-owned', blocks) => send({ type: 'assistant', session_id: thread, uuid: randomUUID(), parent_tool_use_id: tool,
  message: { id: randomUUID(), role: 'assistant', model: 'haiku', content: blocks ?? [{ type: 'text', text }] } });
const result = (text, uuid, error) => send({ type: 'result', subtype: error ? 'error_during_execution' : 'success', session_id: thread, uuid: randomUUID(),
  ...(uuid ? { user_message_uuid: uuid, user_message_uuids: [uuid] } : { origin: { kind: 'background_task', taskId: 'task-owned', runId: 'run-1' } }),
  ...(error ? { errors: [error] } : { result: text }), is_error: !!error, num_turns: 1, duration_ms: 1, duration_api_ms: 1, total_cost_usd: 0, usage: {}, modelUsage: { sonnet: { contextWindow: 200000 } }, permission_denials: [] });
let work, rootUUID, secondUUID, wakeUUID, approval, childApproval, childCommand;
const level = () => system('background_tasks_changed', { tasks: work?.live && !work.foreground ? [{ task_id: work.task, run_id: 'run-1', task_type: work.type, description: work.name, ambient: work.ambient }] : [] });
const launch = (text, uuid) => {
  const monitor = text.includes('monitor'), agent = text.includes('subagent');
  const tool = 'tool-owned', task = 'task-owned', name = monitor ? 'Monitor' : agent ? 'Agent' : 'Bash';
  const folder = join(process.env.CLAUDE_CODE_TMPDIR, 'claude-' + process.getuid(), 'fixture-project', thread, 'tasks');
  mkdirSync(folder, { recursive: true }); const file = join(folder, task + '.output'); writeFileSync(file, 'first café 🚀\n');
  work = { tool, task, file, name, type: agent ? 'local_agent' : 'local_bash', live: true, ambient: text.includes('ambient'), foreground: text.includes('subagent-foreground') };
  assistant('', uuid, { type: 'tool_use', id: tool, name, input: { command: 'owned command', run_in_background: true, ...(agent ? { description: 'Inspect the project', prompt: 'Read the project and report findings', model: 'haiku' } : {}) } });
  if (text.includes('subagent-detail')) child('Early child answer');
  // Deliberately exercise both valid orderings of native level and edge facts.
  if (text.includes('level-first')) level();
  system('task_started', { task_id: task, run_id: 'run-1', tool_use_id: tool, task_type: work.type, is_backgrounded: !work.foreground, description: name, ambient: work.ambient });
  if (!text.includes('level-first')) level();
  send({ type: 'user', session_id: thread, uuid: randomUUID(), parent_tool_use_id: null, tool_use_result: monitor ? { taskId: task } : { backgroundTaskId: task },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: 'Native background launch receipt' }] } });
};
const finishWork = (status = 'completed', emptyFirst = false) => {
  if (!work?.live) return;
  work.live = false;
  if (emptyFirst) level();
  appendFileSync(work.file, 'last bytes\n');
  system('task_notification', { task_id: work.task, run_id: 'run-1', tool_use_id: work.tool, status, summary: 'Owned work ended', output_file: '/untrusted/do-not-read' });
  if (!emptyFirst) level();
  if (work.foreground) result('First answer', rootUUID);
};
const marker = name => { const path = join(home, name); if (!existsSync(path)) return false; unlinkSync(path); return true; };
let exiting = false;
const shutdown = () => {
  if (exiting) return; exiting = true;
  const exit = () => { if (work?.live) appendFileSync(work.file, 'shutdown final\n'); process.exit(0); };
  if (marker('slow-exit')) setTimeout(exit, 80); else exit();
};
process.on('SIGTERM', shutdown);
setInterval(() => {
  if (marker('emit-output') && work) appendFileSync(work.file, 'late output\n');
  if (marker('child-answer')) child('Actual child answer');
  if (marker('child-command')) {
    const file = join(work.file, '..', 'child-command.output'); writeFileSync(file, 'Child command first café 🚀\n'); childCommand = file;
    child('', 'tool-owned', [{ type: 'tool_use', id: 'child-bash', name: 'Bash', input: { command: 'owned child command' } }]);
    system('task_started', { task_id: 'child-command', run_id: 'command-1', tool_use_id: 'child-bash', task_type: 'local_bash', parent_task_id: 'task-owned', is_backgrounded: false, description: 'Child command' });
  }
  if (marker('child-command-output') && childCommand) appendFileSync(childCommand, 'Child command last bytes\n');
  if (marker('child-command-finish') && childCommand) {
    send({ type: 'user', session_id: thread, uuid: randomUUID(), parent_tool_use_id: 'tool-owned', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'child-bash', content: 'Child command first café 🚀\nChild command last bytes\n' }] } });
    childCommand = undefined;
  }
  if (marker('child-permission')) {
    childApproval = true; approval = randomUUID(); child('', 'tool-owned', [{ type: 'tool_use', id: 'child-write', name: 'Write', input: { file_path: join(home, 'late-approved'), content: 'approved' } }]);
    send({ type: 'control_request', request_id: approval, request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'child-write', agent_id: 'task-owned', input: { file_path: join(home, 'late-approved'), content: 'approved' } } });
  }
  if (marker('child-nested')) {
    child('', 'tool-owned', [{ type: 'tool_use', id: 'nested-launch', name: 'Agent', input: { description: 'Nested inspection', prompt: 'Read one file' } }]);
    system('task_started', { task_id: 'nested-task', run_id: 'nested-1', task_type: 'local_agent', tool_use_id: 'nested-launch', parent_task_id: 'task-owned', description: 'Nested inspection', is_backgrounded: false });
    child('Nested answer', 'nested-launch');
    system('task_notification', { task_id: 'nested-task', run_id: 'nested-1', tool_use_id: 'nested-launch', status: 'completed', summary: 'Nested summary', output_file: '/untrusted/do-not-read' });
  }
  if (marker('finish-work')) finishWork();
  if (marker('finish-empty-first')) finishWork('completed', true);
  if (marker('emit-wake')) { assistant('Background wake'); result('Background wake'); }
  if (marker('start-wake')) { assistant('Background working'); wakeUUID = randomUUID(); }
  if (marker('finish-wake')) { assistant('Background done'); result('Background done'); wakeUUID = undefined; }
  if (marker('finish-second') && secondUUID) { assistant('Second answer', secondUUID); result('Second answer', secondUUID); secondUUID = undefined; }
  if (marker('wake-permission')) {
    approval = randomUUID(); assistant('', undefined, { type: 'tool_use', id: 'late-tool', name: 'Write', input: { file_path: join(home, 'late-approved'), content: 'approved' } });
    send({ type: 'control_request', request_id: approval, request: { subtype: 'can_use_tool', tool_name: 'Write', tool_use_id: 'late-tool', input: { file_path: join(home, 'late-approved'), content: 'approved' } } });
  }
  if (marker('disconnect')) process.exit(2);
}, 10).unref();
const input = createInterface({ input: process.stdin });
input.on('close', shutdown);
input.on('line', line => {
  const message = JSON.parse(line); wire(message);
  if (message.type === 'control_request') {
    const delayedInterrupt = message.request.subtype === 'interrupt' && marker('interrupt-delayed');
    if (delayedInterrupt) { assistant('Late reply after Stop', secondUUID ?? rootUUID); result('Late reply after Stop', secondUUID ?? rootUUID); }
    if (message.request.subtype === 'stop_task') {
      if (marker('lose-stop-receipt')) { process.exit(2); return; }
      finishWork('stopped');
    }
    const response = () => send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
      response: message.request.subtype === 'initialize' ? { commands: [], account: { tokenSource: 'ANTHROPIC_API_KEY' }, models } : {} } });
    if (delayedInterrupt) setTimeout(response, 60); else response();
  }
  if (message.type === 'user') {
    const text = typeof message.message.content === 'string' ? message.message.content : '';
    if (text.includes('second')) {
      secondUUID = message.uuid;
      if (text.includes('wake-before-echo')) { assistant('Foreign background wake'); result('Foreign background wake', rootUUID); }
      assistant('Second pending', secondUUID); return;
    }
    rootUUID = message.uuid; launch(text, rootUUID);
    assistant('First answer', rootUUID); if (!work.foreground) result('First answer', rootUUID, text.includes('root-fails') ? 'Owned root failed' : undefined);
    if (text.includes('immediate-wake')) { assistant('Immediate native answer'); result('Immediate native answer'); }
  }
  if (message.type === 'control_response' && message.response.request_id === approval) {
    const allowed = message.response.response?.behavior === 'allow'; if (allowed) writeFileSync(join(home, 'late-approved'), 'approved');
    if (childApproval) { child(allowed ? 'Child approved' : 'Child declined'); childApproval = false; }
    else { assistant(allowed ? 'Late approved' : 'Late declined'); result(allowed ? 'Late approved' : 'Late declined'); }
    approval = undefined;
  }
});
