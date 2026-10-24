const { randomUUID } = require('node:crypto');
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { spawn } = require('node:child_process');
const trace = value => { if (process.env.CURSOR_TEST_WIRE) appendFileSync(process.env.CURSOR_TEST_WIRE, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...value }) + '\n'); };
class AuthenticationError extends Error {}
class FileCredentialStore {
  constructor(path) { this.path = path; }
  async load() { try { return JSON.parse(readFileSync(this.path)); } catch { return undefined; } }
  async save(value) { mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); writeFileSync(this.path, JSON.stringify(value), { mode: 0o600 }); chmodSync(this.path, 0o600); }
  async clear() { rmSync(this.path, { force: true }); }
}
class SqliteLocalAgentStore {
  static async open(options) { mkdirSync(options.stateRoot, { recursive: true }); trace({ store: options }); return { ...options, async dispose() { trace({ disposed: true }); } }; }
}
const Cursor = {
  async me(options) { trace({ probe: 'me', hasKey: !!options.apiKey }); if (process.env.CURSOR_TEST_AUTH_FAIL === '1') throw new AuthenticationError('Auth failed'); return { apiKeyName: 'Fixture key', userEmail: 'fixture@example.test', createdAt: '2026-01-01' }; },
  models: { async list() { trace({ probe: 'models' }); return [{ id: 'native-model', displayName: 'Native Model', parameters: [...(process.env.CURSOR_TEST_OPTIONS === '1' ? [{ id: 'context', displayName: 'Context', values: [{ value: 'standard' }, { value: 'expanded' }] }, { id: 'fast', displayName: 'Fast', values: [{ value: 'true' }, { value: 'false' }] }] : []), { id: 'effort', values: [{ value: 'low' }, { value: 'high' }] }], variants: [{ displayName: 'High', isDefault: true, params: [{ id: 'effort', value: 'high' }] }] }, { id: 'plain', displayName: 'Plain', parameters: [] }]; } },
  auth: { async login(options) { trace({ login: true, openBrowser: options.openBrowser }); options.onLoginUrl('https://cursor.fixture.test/login'); await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 60); options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new AuthenticationError('Aborted')); }); }); await options.store.save({ version: 1, backendUrl: 'https://cursor.fixture.test', apiKey: 'fixture-stored-key', createdAtMs: Date.now(), apiKeyExpiresAtMs: Date.now() + 60_000 }); return { apiKey: 'fixture-stored-key', apiKeyExpiresAtMs: Date.now() + 60_000 }; } },
};
function open(options, agentId, operation) {
  const file = join(options.local.store.stateRoot, agentId + '.json');
  trace({ operation, agentId, options: { model: options.model, mode: options.mode, fullAccess: options.local.sandboxOptions.enabled === false, autoReview: options.local.autoReview, settingSources: options.local.settingSources }, mcp: !!options.mcpServers?.friday, sdkKeyPresent: !!options.apiKey });
  if (operation === 'resume' && (!existsSync(file) || process.env.CURSOR_TEST_FAIL_RESUME === '1')) throw Error('Native Cursor agent not found');
  if (operation === 'create') writeFileSync(file, JSON.stringify({ agentId, prompts: [] }));
  let current;
  return {
    agentId,
    async send(message, sendOptions) {
      const text = typeof message === 'string' ? message : message.text, prompt = text.match(/^Task: ([^\n]+)/m)?.[1] ?? text, runId = 'run-' + randomUUID();
      trace({ sent: prompt, agentId, runId, sendOptions: { model: sendOptions.model, mode: sendOptions.mode, idempotencyKey: sendOptions.idempotencyKey }, image: typeof message === 'object' ? message.images?.[0] : undefined });
      const saved = JSON.parse(readFileSync(file)); saved.prompts.push(prompt); writeFileSync(file, JSON.stringify(saved));
      if (prompt === 'mcp' && options.mcpServers?.friday) { const config = options.mcpServers.friday; await fetch(config.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...config.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { text: 'cursor-native' } } }) }); }
      let resolve, finished = false; const done = new Promise(yes => { resolve = yes; });
      current = { id: runId, agentId, async wait() { return done; }, async cancel() { trace({ cancelled: runId }); if (!finished) { finished = true; resolve({ id: runId, status: 'cancelled' }); } } };
      const emit = update => sendOptions.onDelta?.({ update });
      await emit({ type: 'text-delta', text: prompt === '/compress' ? 'Native compressed' : 'Cursor reply café\u2028' });
      if (prompt === 'hold') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); trace({ child: child.pid }); return current; }
      setTimeout(async () => {
        if (finished) return;
        if (prompt === 'error') { finished = true; resolve({ id: runId, status: 'error', error: { message: 'Native Cursor failure' } }); return; }
        await emit({ type: 'thinking-delta', text: 'Native reasoning' }); await emit({ type: 'thinking-completed' });
        if (prompt === 'children') {
          const args = { description: 'Native child', prompt: 'Inspect the child fixture', model: 'child-model' };
          await emit({ type: 'tool-call-started', callId: 'native-child', toolCall: { type: 'task', args } });
          await emit({ type: 'partial-tool-call', callId: 'native-child', toolCall: { type: 'task', args: { description: 'Partial arguments must not rename a child' } } });
          await emit({ type: 'tool-call-completed', callId: 'native-child', toolCall: { type: 'task', args, result: { status: 'success', value: { conversationSteps: [{ type: 'assistantMessage', message: { text: 'First child answer' } }, { assistantMessage: { text: 'Final child answer' } }], resultSuffix: 'Child summary' } } } });
          await emit({ type: 'tool-call-started', callId: 'native-child', toolCall: { type: 'task', args: { description: 'Late start must not resurrect a completed child' } } });
        }
        await emit({ type: 'tool-call-started', callId: 'shell', toolCall: { type: 'shell', args: { command: 'printf fixture' } } });
        await emit({ type: 'shell-output-delta', event: { data: 'native ' } });
        await emit({ type: 'tool-call-completed', callId: 'shell', toolCall: { type: 'shell', args: { command: 'printf fixture' }, result: { status: 'success', value: { stdout: 'native output', stderr: '', exitCode: 0 } } } });
        if (prompt !== '/compress') await emit({ type: 'text-delta', text: 'line\u2029end' });
        await emit({ type: 'turn-ended' }); finished = true; resolve({ id: runId, status: 'finished', result: prompt === '/compress' ? 'Native compressed' : 'Cursor reply café\u2028line\u2029end' });
      }, 40);
      return current;
    },
    close() {},
    async [Symbol.asyncDispose]() { await current?.cancel(); trace({ agentClosed: agentId }); },
  };
}
const Agent = { async create(options) { return open(options, 'agent-' + randomUUID(), 'create'); }, async resume(agentId, options) { return open(options, agentId, 'resume'); } };
module.exports = { Cursor, Agent, FileCredentialStore, SqliteLocalAgentStore, AuthenticationError };
