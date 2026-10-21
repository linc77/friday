import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityPermission, normalizeAntigravityUpdate } from '../src/antigravity-protocol.js';
test('Antigravity questions preserve opaque native IDs even when human labels are duplicated and never become a blanket tool approval', () => {
  const request = { toolCall: { toolCallId: 'interaction_native', title: 'Choose' }, options: [{ optionId: 'native-a', name: 'Same', kind: 'allow_once' }, { optionId: 'native-b', name: 'Same', kind: 'allow_once' }] }, mapped = antigravityPermission(request);
  assert.deepEqual(mapped.decisions, ['cancel', 'decline', 'accept']); assert.equal(mapped.questions?.[0]?.isOther, false); assert.equal(mapped.questions?.[0]?.options[1]?.value, 'native-b'); assert.deepEqual(mapped.respond('accept', { interaction_native: ['native-b'] }), { outcome: { outcome: 'selected', optionId: 'native-b' } }); assert.throws(() => mapped.respond('accept', { interaction_native: ['Same'] })); assert.deepEqual(mapped.respond('cancel', {}), { outcome: { outcome: 'cancelled' } });
});
test('Antigravity session grants retain the native security warning and only use the offered option IDs', () => {
  const request = { toolCall: { toolCallId: 'shell' }, options: [{ optionId: 'native-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'native-session', name: 'Allow always', kind: 'allow_always', _meta: { 'agy.security.warning': { message: 'Native tool warning' } } }, { optionId: 'native-deny', name: 'Deny', kind: 'reject_once' }] }, mapped = antigravityPermission(request);
  assert.equal(mapped.options?.find(value => value.decision === 'acceptForSession')?.warning, 'Native tool warning'); assert.equal(mapped.respond('acceptForSession', {}).outcome.optionId, 'native-session'); assert.throws(() => mapped.respond('acceptAlways', {}));
});
test('Antigravity native command aliases and real output are projected without retaining unbounded payloads', () => {
  const value = normalizeAntigravityUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'native', rawInput: { CommandLine: 'printf native', Cwd: '/workspace' }, rawOutput: { combined_output: 'native output', exit_code: 3, oversized: Array(1000).fill('x'.repeat(20000)) } });
  assert.equal(value.kind, 'execute'); assert.equal(value.rawInput.command, 'printf native'); assert.equal(value.rawOutput.text, 'native output'); assert.equal(value.nativeExitCode, 3); assert.ok(JSON.stringify(value.rawOutput).length < 100000);
});
