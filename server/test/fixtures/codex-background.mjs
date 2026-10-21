#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const threadId = 'background-thread'; let turns = 0; let live = false; let second = false; let emitted = false;
writeFileSync('background-pid', String(process.pid)); appendFileSync('background-launches', String(process.pid) + '\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const answer = (turnId, text) => {
  notify('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text } });
  notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
};
const finish = (status = 'completed', exitCode = 0) => {
  if (!live) return; live = false;
  notify('item/completed', { turnId: 'turn-1', item: { id: 'command', type: 'commandExecution', processId: 'process-1', command: 'owned-background-command',
    status, exitCode, aggregatedOutput: 'first\nlate 🚀\ndone\n' } });
};
const timer = setInterval(() => {
  if (live && existsSync('emit-background') && !emitted) {
    emitted = true; notify('item/commandExecution/outputDelta', { turnId: 'turn-1', itemId: 'command', delta: 'late 🚀\n' });
    send({ method: 'item/commandExecution/outputDelta', params: { threadId: 'foreign-thread', turnId: 'turn-1', itemId: 'command', delta: 'FOREIGN' } });
  }
  if (live && existsSync('finish-background')) finish();
  if (second && existsSync('finish-second')) { second = false; answer('turn-2', 'Second answer'); }
  if (existsSync('exit-background-process')) process.exit(0);
}, 10);
createInterface({ input: process.stdin }).on('line', line => {
  const value = JSON.parse(line); appendFileSync('background-wire', JSON.stringify(value) + '\n');
  if (value.method === 'initialize') send({ id: value.id, result: { userAgent: 'owned-background-fixture' } });
  if (['thread/start', 'thread/resume'].includes(value.method)) send({ id: value.id, result: { thread: { id: threadId }, model: 'owned-fixture' } });
  if (value.method === 'turn/start') {
    const turnId = `turn-${++turns}`;
    send({ id: value.id, result: { turn: { id: turnId, status: 'inProgress' } } }); notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    if (turnId === 'turn-1') {
      live = true;
      notify('item/started', { turnId, item: { id: 'command', type: 'commandExecution', command: 'owned-background-command', processId: 'process-1', status: 'inProgress' } });
      notify('item/commandExecution/outputDelta', { turnId, itemId: 'command', delta: 'first\n' });
      answer(turnId, 'First answer');
    } else {
      second = true;
      notify('item/started', { turnId, item: { id: 'progress', type: 'agentMessage', phase: 'commentary', text: 'Second turn started' } });
    }
  }
  if (value.method === 'thread/backgroundTerminals/list') send({ id: value.id, result: { data: live ? [{ processId: 'process-1', itemId: existsSync('replace-native-item') ? 'different-command' : 'command', command: 'owned-background-command', cwd: process.cwd() }] : [], nextCursor: null } });
  if (value.method === 'thread/backgroundTerminals/terminate') {
    if (existsSync('lose-stop-receipt')) process.exit(0);
    if (existsSync('hold-stop-receipt')) { writeFileSync('stop-sent', ''); return; }
    if (existsSync('omit-stop-event')) live = false; else finish('failed', 130);
    const reply = () => send({ id: value.id, result: { terminated: true } });
    if (existsSync('delay-stop-response')) setTimeout(reply, 100); else reply();
  }
  if (value.method === 'turn/interrupt') send({ id: value.id, result: {} });
}).on('close', () => { clearInterval(timer); process.exit(0); });
