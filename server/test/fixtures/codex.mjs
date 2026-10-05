#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({ method, params });
const threadId = 'protocol-thread'; const turn = { id: 'protocol-turn', status: 'inProgress' };
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  appendFileSync('wire.jsonl', JSON.stringify(message) + '\n');
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (['thread/start', 'thread/resume'].includes(message.method)) send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn } }); notify('turn/started', { threadId, turn });
    if (message.params.input[0].text === 'wait-for-cancel') return;
    notify('item/started', { threadId, item: { id: 'files', type: 'fileChange', changes: [{ path: 'example.txt', diff: '+example' }] } });
    send({ id: 90, method: 'item/fileChange/requestApproval', params: { threadId, itemId: 'files', reason: 'Test preview' } });
  }
  if (message.id === 90 && !message.method) {
    send({ id: 91, method: 'item/tool/requestUserInput', params: { threadId, questions: [{ id: 'q', question: 'Which option?', options: [{ label: 'A', description: 'A' }] }] } });
  }
  if (message.id === 91 && !message.method) {
    send({ id: 92, method: 'item/permissions/requestApproval', params: { threadId } });
  }
  if (message.id === 92 && !message.method) {
    notify('item/agentMessage/delta', { threadId, itemId: 'answer', delta: 'Protocol verified' });
    notify('item/completed', { threadId, item: { id: 'answer', type: 'agentMessage', text: 'Protocol verified', phase: 'final_answer' } });
    notify('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
  }
  if (['turn/steer', 'turn/interrupt'].includes(message.method)) send({ id: message.id, result: { turnId: turn.id } });
});
