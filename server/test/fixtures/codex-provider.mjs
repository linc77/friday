#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const threadId = 'provider-thread'; const turn = { id: 'provider-turn', status: 'inProgress' };
const finish = text => {
  notify('item/agentMessage/delta', { threadId, itemId: 'answer', delta: text });
  notify('item/completed', { threadId, item: { id: 'answer', type: 'agentMessage', text, phase: 'final_answer' } });
  notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); appendFileSync('wire.jsonl', line + '\n');
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') reply({ userAgent: 'codex_cli_rs/0.160.0' });
  if (message.method === 'account/read') reply({ account: process.env.FRIDAY_TEST_AUTH === 'none' ? null : { type: 'chatgpt', email: 'test@example.com', planType: 'pro' }, requiresOpenaiAuth: true });
  if (message.method === 'model/list') reply({ data: [{ id: message.params.cursor ? 'second' : 'first', model: message.params.cursor ? 'second' : 'first', displayName: message.params.cursor ? 'Second model' : 'First model', isDefault: !message.params.cursor, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: message.params.cursor ? null : 'next' });
  if (message.method === 'account/login/start') { reply({ authUrl: 'https://auth.openai.com/test', loginId: 'test' }); setTimeout(() => notify('account/login/completed', { success: true }), 100); }
  if (['thread/start', 'thread/resume'].includes(message.method)) reply({ thread: { id: threadId } });
  if (message.method === 'turn/start') {
    reply({ turn }); notify('turn/started', { threadId, turn });
    const text = message.params.input[0].text;
    if (text.includes('wait-for-cancel')) return;
    if (text.includes('读取想法并保存笔记')) { send({ id: 91, method: 'item/tool/call', params: { threadId, callId: 'workspace-call', tool: 'friday_workspace', arguments: {} } }); return; }
    if (text.includes('请记住')) { send({ id: 90, method: 'item/tool/call', params: { threadId, callId: 'memory-call', tool: 'friday_remember', arguments: { text: '喜欢中文回答' } } }); return; }
    finish(`Configured ${process.env.RUNTIME_TEST ?? 'default'} at ${process.env.CODEX_HOME}`);
  }
  if (message.id === 90 && !message.method) finish('已记住。');
  if (message.id === 91 && !message.method) {
    const workspace = JSON.parse(message.result.contentItems[0].text);
    send({ id: 92, method: 'item/tool/call', params: { threadId, callId: 'note-call', tool: 'friday_save_note', arguments: { title: '想法整理', content: workspace.ideas[0]?.text ?? '没有想法' } } });
  }
  if (message.id === 92 && !message.method) finish('笔记已保存。');
  if (message.method === 'turn/interrupt') reply({});
});
