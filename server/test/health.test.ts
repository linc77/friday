import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { createAPI } from '../src/api.js';
import { healthUpload, nextDaily } from '../src/health.js';
import { healthConversationId } from '../src/proactive.js';
import type { PushSender } from '../src/notifications.js';

const noLocalAgent = { run: async () => { throw new Error('No local executor expected'); }, answer: async () => {}, steer: async () => {} };
const until = async (predicate: () => Promise<boolean>) => {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Expected health transition did not complete');
};
async function setup(push?: PushSender) {
  const directory = await mkdtemp(join(tmpdir(), 'friday-health-'));
  let clock = Date.parse('2026-10-18T00:29:00Z');
  const faux = fauxProvider({ tokensPerSecond: 100000 }); const models = createModels(); models.setProvider(faux.provider);
  const agent = { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id } };
  const options = { push: push ?? { configured: false, send: async () => ({ status: 'unavailable' as const }) }, now: () => clock, pollMs: 20 };
  let engine = await new Engine(directory, noLocalAgent, agent, options).open();
  const auth = new Auth(directory); const code = auth.createPairing(); const phone = auth.pair(code.code, 'iPhone', 'test');
  const call = async (path: string, body?: object, token = phone.token, method = body ? 'POST' : 'GET') => {
    const result = await createAPI(engine, auth, () => []).request(path, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: result.status, body: await result.json() as any };
  };
  const upload = (steps = 7400) => ({ uploadId: 'upload-1', capturedAt: new Date(clock).toISOString(), timezone: 'Asia/Shanghai', days: [
    { date: '2026-10-17', steps, activeEnergyKcal: 320, sleepMinutes: null, restingHeartRate: 60, workoutMinutes: 30 },
    { date: '2026-10-18', steps: null, activeEnergyKcal: null, sleepMinutes: 420, restingHeartRate: null, workoutMinutes: null },
  ] });
  const enable = async (modelConsent = false) => {
    assert.equal((await call('/api/health/connection', { enabled: true }, phone.token, 'PUT')).status, 200);
    assert.equal((await call('/api/health/snapshot', upload())).status, 200);
    assert.equal((await call('/api/health/settings', { enabled: true, modelConsent, hour: 8, minute: 30, timezone: 'Asia/Shanghai' }, phone.token, 'PUT')).status, 200);
  };
  return { get engine() { return engine; }, directory, auth, phone, call, upload, enable, faux,
    advance: (milliseconds: number) => { clock += milliseconds; },
    reopen: async () => { await engine.close(); engine = await new Engine(directory, noLocalAgent, agent, options).open(); },
    cleanup: async () => { await engine.close(); auth.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('Health sync requires device opt-in, validates dates, and replaces recent data without stale retries overwriting it', async () => {
  const h = await setup();
  try {
    assert.equal((await h.call('/api/health/snapshot', h.upload())).status, 400);
    await h.enable();
    assert.equal((await h.call('/api/health/snapshot', h.upload())).body.accepted, false);
    h.advance(1000);
    const revised = { ...h.upload(100), uploadId: 'revision', days: h.upload(100).days.map(day => ({ ...day, sleepMinutes: null })) };
    assert.equal((await h.call('/api/health/snapshot', revised)).body.accepted, true);
    const old = { ...h.upload(9999), capturedAt: new Date(Date.parse(revised.capturedAt) - 1000).toISOString(), uploadId: 'old' };
    assert.equal((await h.call('/api/health/snapshot', old)).body.accepted, false);
    const state = (await h.call('/api/health')).body;
    assert.equal(state.sources[0].days[0].steps, 100);
    assert.equal(state.sources[0].days[1].sleepMinutes, null);
    assert.throws(() => healthUpload({ ...h.upload(), days: [{ ...h.upload().days[0], date: '2026-02-30' }] }, Date.parse(h.upload().capturedAt)), /日期/);
    assert.equal((await h.call('/api/health/snapshot', { ...h.upload(), days: [{ ...h.upload().days[0], steps: -1 }] })).status, 400);
    const other = h.auth.pair(h.auth.createPairing().code, 'Other', 'other');
    const visible = (await h.call('/api/health', undefined, other.token)).body;
    assert.deepEqual(visible.sources, []); assert.deepEqual(visible.deliveries, []);
    assert.equal((await h.call('/api/health/settings', { enabled: true, modelConsent: true, hour: 8, minute: 30, timezone: 'Asia/Shanghai' }, other.token, 'PUT')).status, 400);
  } finally { await h.cleanup(); }
});

test('A daily background routine shares without model consent, delivers once, and survives reopen', async () => {
  let calls = 0;
  const h = await setup({ configured: true, send: async () => { calls++; return { status: 'accepted' }; } });
  try {
    await h.enable();
    await h.call('/api/notifications/device', { token: 'a'.repeat(64), environment: 'development' }, h.phone.token, 'PUT');
    h.advance(60000);
    await until(async () => (await h.call('/api/health')).body.deliveries[0]?.status === 'accepted');
    const work = (await h.engine.snapshot()).tasks.find(t => t.id === healthConversationId)!;
    assert.equal(work.status, 'completed'); assert.match(work.result, /7400/); assert.match(work.result, /420/);
    assert.equal(work.messages?.filter(m => m.role === 'user').length, 0);
    assert.equal(h.faux.state.callCount, 0); assert.equal(calls, 1);
    await h.reopen(); h.advance(60000);
    await h.engine.harness.waitForIdle((await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
    assert.equal(calls, 1); assert.equal((await h.engine.snapshot()).tasks.length, 1);
    const before = work.messages?.length;
    const response = await h.call('/api/health/share', { requestId: 'manual' }); assert.equal(response.status, 200);
    await until(async () => (await h.engine.snapshot()).tasks[0]?.status === 'completed' && (await h.engine.snapshot()).tasks[0].messages!.length === before! + 1);
    await h.call('/api/health/share', { requestId: 'manual' });
    assert.equal((await h.engine.snapshot()).tasks[0].messages?.length, before! + 1);
    await assert.rejects(h.engine.createTask({ prompt: '分析一下', projectId: null, mode: 'auto', requestId: 'reply', continueId: healthConversationId }), /允许模型分析/);
  } finally { await h.cleanup(); }
});

test('Model analysis uses real synced evidence, hides system triggers, and preserves a replyable health conversation', async () => {
  const h = await setup();
  try {
    h.faux.setResponses([
      ctx => { assert.match(JSON.stringify(ctx), /7400/); return fauxAssistantMessage('昨天活动 7400 步，昨夜记录了 420 分钟睡眠。你这周想先关注哪一项？'); },
      ctx => { assert.match(JSON.stringify(ctx), /先关注睡眠/); return fauxAssistantMessage('好，后续分享先关注睡眠。'); },
    ]);
    await h.enable(true); await h.call('/api/health/share', { requestId: 'model-share' });
    await until(async () => (await h.engine.snapshot()).tasks[0]?.status === 'completed');
    const work = (await h.engine.snapshot()).tasks[0]; assert.equal(h.faux.state.callCount, 1);
    assert.equal(work.messages?.filter(m => m.role === 'user').length, 0);
    await h.engine.createTask({ prompt: '先关注睡眠', projectId: null, mode: 'auto', requestId: 'follow-up', continueId: work.id });
    await until(async () => (await h.engine.snapshot()).tasks[0].status === 'completed');
    assert.equal((await h.engine.snapshot()).tasks[0].conversationId, work.conversationId); assert.equal(h.faux.state.callCount, 2);
    await h.call('/api/health/connection', { enabled: false }, h.phone.token, 'PUT');
    assert.deepEqual((await h.call('/api/health')).body.sources[0].days, []);
    await assert.rejects(h.engine.createTask({ prompt: '继续', projectId: null, mode: 'auto', requestId: 'after-revoke', continueId: work.id }), /允许模型分析/);
  } finally { await h.cleanup(); }
});

test('An uncertain notification after shutdown is not automatically sent a second time', async () => {
  let calls = 0; let started!: () => void; const sending = new Promise<void>(resolve => { started = resolve; });
  const h = await setup({ configured: true, send: async (_device, _id, _taskId, signal) => {
    calls++; started();
    return new Promise(resolve => { signal.addEventListener('abort', () => resolve({ status: 'uncertain' }), { once: true }); });
  } });
  try {
    await h.enable(); await h.call('/api/notifications/device', { token: 'b'.repeat(64), environment: 'development' }, h.phone.token, 'PUT');
    await h.call('/api/health/share', { requestId: 'uncertain' }); await sending;
    await h.reopen();
    await until(async () => (await h.call('/api/health')).body.deliveries[0]?.status === 'uncertain');
    assert.equal(calls, 1);
  } finally { await h.cleanup(); }
});

test('Revoking a phone removes health evidence and push registration and stops future sharing', async () => {
  const h = await setup();
  try {
    await h.enable(); await h.call('/api/notifications/device', { token: 'c'.repeat(64), environment: 'development' }, h.phone.token, 'PUT');
    assert.equal((await h.call(`/api/devices/${h.phone.id}`, undefined, h.auth.token, 'DELETE')).status, 200);
    const state = (await h.call('/api/health', undefined, h.auth.token)).body;
    assert.deepEqual(state.sources, []); assert.equal(state.settings.enabled, false); assert.equal(state.settings.sourceDeviceId, null);
    assert.equal((await h.call('/api/health', undefined, h.phone.token)).status, 401);
  } finally { await h.cleanup(); }
});

test('A provider exception settles notification uncertainty without automatically repeating the external call', async () => {
  let calls = 0;
  const h = await setup({ configured: true, send: async () => { calls++; throw new Error('Provider lost its receipt'); } });
  try {
    await h.enable(); await h.call('/api/notifications/device', { token: 'd'.repeat(64), environment: 'development' }, h.phone.token, 'PUT');
    await h.call('/api/health/share', { requestId: 'provider-exception' });
    await until(async () => (await h.call('/api/health')).body.deliveries[0]?.status === 'uncertain');
    await h.reopen(); assert.equal(calls, 1);
    assert.equal((await h.call('/api/health')).body.deliveries[0].status, 'uncertain');
  } finally { await h.cleanup(); }
});

test('Local daily scheduling handles DST gaps and does not use a fixed 24-hour offset', () => {
  assert.equal(new Date(nextDaily(Date.parse('2026-03-08T06:59:00Z'), 2, 30, 'America/New_York')).toISOString(), '2026-03-09T06:30:00.000Z');
  assert.equal(new Date(nextDaily(Date.parse('2026-10-18T00:29:59Z'), 8, 30, 'Asia/Shanghai')).toISOString(), '2026-10-18T00:30:00.000Z');
});

test('Friday can persist a daily health agreement from chat without granting model access to health data', async () => {
  const h = await setup();
  try {
    await h.enable(false);
    const current = (await h.engine.proactive.state()).settings;
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('health_status', {}), { stopReason: 'toolUse' }),
      ctx => {
        assert.doesNotMatch(JSON.stringify(ctx).replaceAll('\\', ''), /"steps"\s*:\s*7400/);
        return fauxAssistantMessage(fauxToolCall('set_health_routine', { generation: current.generation, enabled: true, hour: 9, minute: 0, focus: '优先关注睡眠' }), { stopReason: 'toolUse' });
      },
      fauxAssistantMessage('已约定每天九点分享，优先关注睡眠。模型分析权限保持关闭。'),
    ]);
    const id = await h.engine.createTask({ prompt: '每天九点跟我分享，优先关注睡眠', projectId: null, mode: 'auto', requestId: 'routine-agreement' });
    await until(async () => (await h.engine.snapshot()).tasks.find(t => t.id === id)?.status === 'completed');
    const saved = (await h.engine.proactive.state()).settings;
    assert.equal(saved.hour, 9); assert.equal(saved.minute, 0); assert.equal(saved.focus, '优先关注睡眠');
    assert.equal(saved.modelConsent, false); assert.equal(saved.generation, current.generation + 1);
    await h.reopen(); assert.equal((await h.engine.proactive.state()).settings.focus, '优先关注睡眠');
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('health_summary', {}), { stopReason: 'toolUse' }),
      ctx => { assert.match(JSON.stringify(ctx), /允许当前模型分析/); assert.doesNotMatch(JSON.stringify(ctx).replaceAll('\\', ''), /"steps"\s*:\s*7400/); return fauxAssistantMessage('请先在设置中允许模型分析健康摘要。'); },
    ]);
    await h.engine.createTask({ prompt: '看看昨晚睡眠', projectId: null, mode: 'auto', requestId: 'health-read', continueId: id });
    await until(async () => (await h.engine.snapshot()).tasks.find(t => t.id === id)?.status === 'completed');
    assert.equal((await h.engine.proactive.state()).settings.modelConsent, false);
    const currentSettings = (await h.engine.proactive.state()).settings;
    await h.call('/api/health/settings', { ...currentSettings, modelConsent: true }, h.phone.token, 'PUT');
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('health_summary', { days: 7 }), { stopReason: 'toolUse' }),
      ctx => { assert.match(JSON.stringify(ctx).replaceAll('\\', ''), /"steps"\s*:\s*7400/); return fauxAssistantMessage('已读取授权后的健康摘要。'); },
    ]);
    await h.engine.createTask({ prompt: '现在已开启授权，再看看健康摘要', projectId: null, mode: 'auto', requestId: 'health-read-consented', continueId: id });
    await until(async () => (await h.engine.snapshot()).tasks.find(t => t.id === id)?.status === 'completed');
    assert.equal((await h.engine.snapshot()).tasks.find(t => t.id === id)?.healthContext, true);
    const afterRead = (await h.engine.proactive.state()).settings;
    await h.call('/api/health/settings', { ...afterRead, modelConsent: false }, h.phone.token, 'PUT');
    await assert.rejects(h.engine.createTask({ prompt: '继续', projectId: null, mode: 'auto', requestId: 'after-read-revoked', continueId: id }), /此对话包含健康数据/);
  } finally { await h.cleanup(); }
});

test('A stale agent tool invocation cannot overwrite a newer daily agreement', async () => {
  const h = await setup();
  try {
    await h.enable(true); const previous = (await h.engine.proactive.state()).settings;
    await h.call('/api/health/settings', { ...previous, hour: 10, focus: '用户刚修改的安排' }, h.phone.token, 'PUT');
    h.faux.setResponses([
      fauxAssistantMessage(fauxToolCall('set_health_routine', { generation: previous.generation, enabled: true, hour: 6, focus: '旧安排' }), { stopReason: 'toolUse' }),
      ctx => { assert.match(JSON.stringify(ctx), /分享约定已变化/); return fauxAssistantMessage('安排已变化，需要重新核对。'); },
    ]);
    const id = await h.engine.createTask({ prompt: '调整健康安排', projectId: null, mode: 'auto', requestId: 'stale-routine' });
    await until(async () => (await h.engine.snapshot()).tasks.find(t => t.id === id)?.status === 'completed');
    const state = (await h.engine.proactive.state()).settings;
    assert.equal(state.hour, 10); assert.equal(state.focus, '用户刚修改的安排');
  } finally { await h.cleanup(); }
});
