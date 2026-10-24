import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTurnObserver } from '../src/native-turn-observer.js';
import type { ExecutionRequest, ExecutionUpdate, WorkItem } from '../src/types.js';

const task: WorkItem = { id: 'task', agent: 'opencode', title: 'Fixture', prompt: 'Original', projectId: 'project', cwd: '/tmp/fixture', mode: 'code', status: 'completed', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z', durableId: 1, threadId: 'session', turnId: 'original', result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'original' };
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
test('Native observations reserve wire order before asynchronous verification and retain that order through Durable finalization', async () => {
  const verification = gate(), finalized = gate(), updates: ExecutionUpdate[] = []; let finalizations = 0;
  const request: ExecutionRequest = { task, prompt: 'Never resend', signal: new AbortController().signal, update: async value => { updates.push(value); }, finalized: Promise.resolve(), nativeTurnFinalized: async () => { if (++finalizations === 1) await finalized.promise; } };
  const observer = new NativeTurnObserver('opencode', () => request, 'owned', 'session');
  try {
    const first = observer.open('first', () => verification.promise), second = observer.open('second', async () => {});
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(updates.length, 0, 'A fast second verification cannot overtake an earlier wire turn');
    verification.release(); const one = await first; await one.update({ kind: 'output', text: 'one' });
    const finish = observer.finish('first', 'completed', 'one');
    await new Promise(resolve => setTimeout(resolve, 5)); assert.deepEqual(updates.filter(value => value.kind === 'nativeTurnStart').map(value => value.turnId), ['first']);
    finalized.release(); await finish; const two = await second; assert.equal(two.prompt, ''); await two.update({ kind: 'output', text: 'two' }); await observer.finish('second', 'completed', 'two');
    assert.deepEqual(updates.filter(value => value.kind === 'nativeTurnStart').map(value => value.turnId), ['first', 'second']);
    assert.deepEqual(updates.filter(value => value.kind === 'nativeTurnFinish').map(value => value.result), ['one', 'two']);
  } finally { verification.release(); finalized.release(); await observer.close(); }
});
test('Rejected verification creates no observation and neither blocks a later admitted turn nor reruns verification for the same native identity', async () => {
  const updates: ExecutionUpdate[] = [], request: ExecutionRequest = { task, prompt: '', signal: new AbortController().signal, update: async value => { updates.push(value); } };
  const observer = new NativeTurnObserver('opencode', () => request, 'owned', 'session');
  try {
    await assert.rejects(observer.open('foreign', async () => { throw new Error('Account changed'); }), /Account changed/);
    await observer.open('accepted', async () => {});
    await observer.open('accepted', async () => { assert.fail('One native identity must have one admission'); });
    await observer.finish('accepted', 'completed', 'answer');
    assert.deepEqual(updates.filter(value => value.kind === 'nativeTurnStart').map(value => value.turnId), ['accepted']);
  } finally { await observer.close(); }
});
