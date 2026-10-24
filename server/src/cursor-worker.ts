import { createRequire } from 'node:module';
import { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { AgentApp, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import type { SDKAgent, Run, AgentOptions, InteractionUpdate } from '@cursor/sdk';
import type { SqliteLocalAgentStore } from '@cursor/sdk/sqlite';
import { acpRecord } from './acp-process.js';

// A process boundary gives each Cursor SDK account its own environment,
// sandbox cache and owned tool process group. The SDK owns agent execution.
const requireSDK = createRequire(import.meta.url), testModule = process.argv.find(value => value.startsWith('--sdk-module='))?.slice(13);
console.log = console.info = console.warn = console.error = () => {};
const sdk = requireSDK(testModule ?? '@cursor/sdk') as typeof import('@cursor/sdk');
const sqlite = (testModule ? sdk : requireSDK('@cursor/sdk/sqlite')) as typeof import('@cursor/sdk/sqlite');
// SDK diagnostics never enter the JSON-RPC output or public task stream.
console.log = console.info = console.warn = console.error = () => {};
let agent: SDKAgent | undefined, run: Run | undefined, store: SqliteLocalAgentStore | undefined, closing: Promise<void> | undefined;
const credentialsPath = process.argv.find(value => value.startsWith('--credentials='))?.slice(14);
if (!credentialsPath) throw new Error('Missing private Cursor credential store');
const credentials = new sdk.FileCredentialStore(credentialsPath);
let login: AbortController | undefined;
let activeKey: string | undefined;
const connection = new AgentApp({ name: 'Friday Cursor SDK host' }).onRequest('*', async context => {
  try {
  const params = acpRecord(context.params) ?? {};
  const stored = await credentials.load(), apiKey = process.env.CURSOR_API_KEY?.trim() || (stored && (!stored.apiKeyExpiresAtMs || stored.apiKeyExpiresAtMs > Date.now()) ? stored.apiKey : undefined);
  activeKey = apiKey;
  if (stored?.backendUrl && !process.env.CURSOR_API_KEY && !process.env.CURSOR_BACKEND_URL) process.env.CURSOR_BACKEND_URL = stored.backendUrl;
  const fingerprint = apiKey ? createHash('sha256').update(JSON.stringify([apiKey, process.env.CURSOR_BACKEND_URL ?? ''])).digest('hex') : '';
  if (context.method === 'cursor/login') {
    if (login || process.env.CURSOR_API_KEY) throw RequestError.invalidRequest('Cursor 登录已在进行或使用配置密钥');
    login = new AbortController(); const controller = login;
    const url = new Promise<string>((resolve, reject) => {
      void sdk.Cursor.auth.login({ store: credentials, openBrowser: false, onLoginUrl: resolve, signal: controller.signal, apiKeyName: 'Friday' }).then(async () => {
        login = undefined; await context.client.notify('cursor/login-complete', { ok: true });
      }, async () => { login = undefined; reject(new Error('Cursor 登录未完成')); await context.client.notify('cursor/login-complete', { ok: false }); });
    });
    return { url: await url };
  }
  if (!apiKey) throw RequestError.authRequired();
  if (context.method === 'cursor/probe') {
    const [user, models] = await Promise.all([sdk.Cursor.me({ apiKey }), sdk.Cursor.models.list({ apiKey })]);
    return { user: { userEmail: user.userEmail ?? null, apiKeyName: user.apiKeyName }, models, fingerprint };
  }
  if (context.method === 'cursor/open') {
    if (agent) throw RequestError.invalidRequest('Cursor SDK 会话已经打开');
    if (params.fingerprint !== fingerprint) throw RequestError.invalidRequest('Cursor 账号已经改变');
    store = await sqlite.SqliteLocalAgentStore.open({ workspaceRef: params.cwd, stateRoot: params.stateRoot });
    const options: AgentOptions = { apiKey, name: params.name, model: params.model, mode: params.mode === 'plan' ? 'plan' : 'agent', local: { cwd: params.cwd, store,
      autoReview: params.readOnly === true ? false : params.fullAccess !== true, sandboxOptions: { enabled: params.fullAccess !== true }, settingSources: params.readOnly === true ? [] : ['project', 'user', 'team', 'mdm', 'plugins'], enableAgentRetries: true }, ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}) };
    agent = typeof params.agentId === 'string' ? await sdk.Agent.resume(params.agentId, options) : await sdk.Agent.create(options);
    return { agentId: agent.agentId };
  }
  if (context.method === 'cursor/send') {
    if (!agent || run) throw RequestError.invalidRequest('Cursor SDK 会话不可用或已有运行');
    const queue: InteractionUpdate[] = []; let started = false, callbacks = Promise.resolve();
    const publish = (update: InteractionUpdate) => { callbacks = callbacks.then(async () => { await context.client.notify('cursor/delta', { agentId: agent!.agentId, runId: run!.id, update }); }); return callbacks; };
    run = await agent.send(params.message, { model: params.model, mode: params.mode === 'plan' ? 'plan' : 'agent', idempotencyKey: params.idempotencyKey,
      onDelta: ({ update }) => { if (!started) { queue.push(update); return; } return publish(update); } });
    started = true; for (const update of queue) await publish(update);
    const current = run;
    void (async () => {
      try { const result = await current.wait(); await callbacks; await context.client.notify('cursor/completed', { agentId: agent!.agentId, runId: current.id, result }); }
      catch (error) { await context.client.notify('cursor/completed', { agentId: agent!.agentId, runId: current.id, error: safeError(error) }); }
    })().catch(() => {});
    return { runId: current.id, agentId: current.agentId };
  }
  if (context.method === 'cursor/cancel') { await run?.cancel(); return {}; }
  throw RequestError.methodNotFound(context.method);
  } catch (error) { if (error instanceof RequestError) throw error; throw RequestError.internalError(undefined, safeError(error)); }
}).connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));

function safeError(error: unknown) {
  const value = acpRecord(error);
  if (error instanceof sdk.AuthenticationError || value?.status === 401) return 'Cursor 认证失败，请重新登录';
  const message = error instanceof Error ? error.message : 'Cursor SDK 执行失败';
  const secret = activeKey;
  return (secret ? message.replaceAll(secret, '[redacted]') : message).replace(/([?&](?:token|key|password)=)[^\s&]+/gi, '$1[redacted]');
}
async function close() {
  return closing ??= (async () => { login?.abort(); try { await run?.cancel(); } catch {} try { await agent?.[Symbol.asyncDispose](); } catch {} await store?.dispose(); connection.close(); })();
}
process.on('SIGTERM', () => { void close().finally(() => process.exit(0)); });
process.stdin.on('end', () => { void close().finally(() => process.exit(0)); });
