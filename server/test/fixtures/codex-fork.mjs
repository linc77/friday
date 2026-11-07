#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line); appendFileSync('fork-wire.jsonl', line + '\n');
  if (request.method === 'initialize') return send({ id: request.id, result: { userAgent: 'fixture' } });
  if (!request.method || request.method === 'initialized') return;
  const state = JSON.parse(readFileSync('fork-history.json', 'utf8')); const id = request.params.threadId;
  if (request.method === 'thread/read') {
    if (id !== 'source-native' && state.failVerifyOnce) { delete state.failVerifyOnce; writeFileSync('fork-history.json', JSON.stringify(state)); return send({ id: request.id, error: { code: -1, message: 'verification connection lost' } }); }
    const turns = id === 'source-native' ? state.source : state.forks?.[id];
    if (!turns) return send({ id: request.id, error: { code: -1, message: 'missing thread' } });
    return send({ id: request.id, result: { thread: { id, historyMode: state.mode ?? 'paginated', ...(id !== 'source-native' ? { forkedFromId: 'source-native' } : {}), ...(request.params.includeTurns ? { turns: turns.map(id => ({ id, status: 'completed' })) } : {}), status: { type: 'notLoaded' } } } });
  }
  if (request.method === 'thread/turns/list') {
    const turns = id === 'source-native' ? state.source : state.forks?.[id]; const offset = Number(request.params.cursor ?? 0);
    return send({ id: request.id, result: { data: turns.slice(offset, offset + 1).map(id => ({ id, status: id === state.activeTurn ? 'inProgress' : 'completed' })), nextCursor: offset + 1 < turns.length ? String(offset + 1) : null } });
  }
  if (request.method === 'thread/fork') {
    state.forks ??= {}; const target = 'fork-native-' + (Object.keys(state.forks).length + 1);
    state.forks[target] = state.source.slice(0, state.source.indexOf(request.params.lastTurnId) + 1);
    writeFileSync('fork-history.json', JSON.stringify(state));
    if (state.loseReceipt) process.exit(0);
    return send({ id: request.id, result: { thread: { id: target, forkedFromId: 'source-native' } } });
  }
  send({ id: request.id, error: { code: -32601, message: 'Fork fixture must not execute or revert turns' } });
});
