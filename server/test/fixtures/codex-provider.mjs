#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  if (message.method === 'account/read') reply({ account: process.env.FRIDAY_TEST_AUTH === 'none' ? null : { type: 'chatgpt', email: process.env.FRIDAY_TEST_ACCOUNT ?? 'test@example.com', planType: 'pro' }, requiresOpenaiAuth: true });
  if (message.method === 'account/rateLimits/read') {
    const response = { rateLimits: { limitId: 'spark', primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { limitId: 'codex', planType: 'pro', primary: { usedPercent: 11, resetsAt: 2000000000, windowDurationMins: 300 }, secondary: { usedPercent: 55, windowDurationMins: 10080 } } } };
    if (process.env.FRIDAY_TEST_RESET) {
      const spent = existsSync('reset-spends') && readFileSync('reset-spends', 'utf8').includes(process.env.FRIDAY_TEST_ACCOUNT ?? 'test@example.com');
      response.rateLimitsByLimitId.codex.primary.usedPercent = spent ? 0 : 100;
      response.resetCredits = { availableCount: spent ? 1 : 2, credits: [{ status: 'available', expiresAt: 2000000000 }] };
    }
    reply(response);
  }
  if (message.method === 'account/rateLimitResetCredit/consume') {
    const key = message.params.idempotencyKey, account = process.env.FRIDAY_TEST_ACCOUNT ?? 'test@example.com';
    const ledger = existsSync('reset-ledger.json') ? JSON.parse(readFileSync('reset-ledger.json', 'utf8')) : {};
    const spent = existsSync('reset-spends') && readFileSync('reset-spends', 'utf8').includes(account);
    const outcome = Object.hasOwn(ledger, key) ? 'alreadyRedeemed' : spent ? 'nothingToReset' : 'reset';
    appendFileSync('reset-wire.jsonl', JSON.stringify({ key, outcome }) + '\n');
    if (!Object.hasOwn(ledger, key)) { ledger[key] = outcome; writeFileSync('reset-ledger.json', JSON.stringify(ledger)); if (outcome === 'reset') appendFileSync('reset-spends', account + '\n'); }
    if (process.env.FRIDAY_TEST_RESET === 'drop-first' && !existsSync('reset-dropped')) { writeFileSync('reset-dropped', ''); process.exit(0); }
    if (process.env.FRIDAY_TEST_RESET === 'hold' && !existsSync('release-reset')) {
      writeFileSync('reset-entered', ''); const wait = setInterval(() => { if (existsSync('release-reset')) { clearInterval(wait); reply({ outcome }); } }, 10);
    } else reply({ outcome });
  }
  if (message.method === 'skills/list') reply({ data: message.params.cwds.map(cwd => ({ cwd, errors: [], skills: [{ name: 'review', path: cwd + '/.agents/skills/review/SKILL.md', enabled: true, scope: 'repo', description: 'Review this workspace', interface: { displayName: 'Review Changes' } }] })) });
  if (message.method === 'model/list') reply(process.env.FRIDAY_TEST_EMPTY_MODELS === '1' ? { data: [], nextCursor: null } : { data: [{ id: message.params.cursor ? 'second' : 'first', model: message.params.cursor ? 'second' : 'first', displayName: message.params.cursor ? 'Second model' : 'First model', isDefault: !message.params.cursor, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }], nextCursor: message.params.cursor ? null : 'next' });
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
