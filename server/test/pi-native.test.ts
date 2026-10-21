import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutable } from '../src/agents.js';
import { defaultPiSettings, PiConnection } from '../src/pi-provider.js';
import { PiExecutor } from '../src/pi.js';
import type { ExecutionUpdate, WorkItem } from '../src/types.js';

// The installed Pi talks only to this test's loopback model and MCP servers.
// Its account directory is empty and no real model credentials are inherited.
test('Installed Pi loads the Friday extension, executes MCP and write tools, requests native approval and resumes its saved session', { timeout: 30_000 }, async t => {
  const binary = findExecutable('pi'); if (!binary) { t.skip('Pi CLI is not installed'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'friday-pi-native-')), home = join(directory, 'account'), cwd = join(directory, 'workspace');
  await mkdir(home); await mkdir(cwd);
  const connection = new PiConnection(directory), executor = new PiExecutor(connection), output = join(cwd, 'native.txt');
  const modelRequests: any[] = [], mcpCalls: string[] = [];
  let modelStep = 0;
  const server = createServer(async (req, res) => {
    try {
      let text = ''; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      if (req.url === '/mcp') {
        assert.equal(req.headers.authorization, 'Bearer fixture-private-mcp');
        if (body.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
        let result: any;
        if (body.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'friday-native-fixture', version: '1' } };
        else if (body.method === 'tools/list') result = { tools: [{ name: 'task_status', description: 'Read fixture status', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, annotations: { readOnlyHint: true } }] };
        else if (body.method === 'tools/call') { mcpCalls.push(body.params.name); result = { content: [{ type: 'text', text: 'Fixture MCP ready' }] }; }
        else throw new Error('Unexpected MCP method ' + body.method);
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })); return;
      }
      assert.equal(req.url, '/v1/chat/completions'); modelRequests.push(body);
      assert.equal(req.headers.authorization, 'Bearer fixture-native-key');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta: unknown, finish_reason: string | null) => res.write('data: ' + JSON.stringify({ id: 'native-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      const step = modelStep++;
      if (step < 2) {
        const name = step === 0 ? 'mcp__friday__task_status' : 'write', args = step === 0 ? { id: 'fixture' } : { path: output, content: 'Written by installed Pi via native tool' };
        assert.ok(body.tools?.some((tool: any) => tool.function?.name === name), 'Native model must receive the real tool schema: ' + name);
        chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, null); chunk({}, 'tool_calls');
      } else { chunk({ role: 'assistant', content: 'Installed Pi native reply' }, null); chunk({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error as Error); }
  });
  server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await executor.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(home, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: base + '/v1', api: 'openai-completions', apiKey: 'fixture-native-key', models: [{ id: 'fixture-model', name: 'Native Fixture', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  // Pi uses the isolated account file above. The values override any inherited
  // provider credentials, and this selected model points only to loopback.
  await connection.save({ ...defaultPiSettings, enabled: true, binaryPath: binary, homePath: home, launchArgs: '--offline --no-extensions', model: 'fixture/fixture-model' });
  const status = await connection.status(true); assert.equal(status.connected, true, status.error ?? 'Pi status');
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20_000), updates: ExecutionUpdate[] = [];
  let threadId = '', approved = 0, persisted = false;
  const update = async (value: ExecutionUpdate) => {
    updates.push(value);
    if (value.kind === 'session') { threadId = value.threadId; persisted = true; }
    if (value.kind === 'approval') { assert.ok(persisted); approved++; await executor.answer('native-pi', value.approval.id, 'accept', {}); }
  };
  const task = { id: 'native-pi', agent: 'pi', cwd, model: 'fixture/fixture-model', interactionMode: 'default', events: [], approvals: [], threadId: null, currentRunId: 'native-1' } as unknown as WorkItem;
  try {
    assert.equal(await executor.run({ task, prompt: 'Read fixture MCP status and write the fixture file.', signal: controller.signal, update, beforeStart: async () => assert.ok(persisted), taskMcp: { url: base + '/mcp', headers: { Authorization: 'Bearer fixture-private-mcp' } } }), 'Installed Pi native reply');
    assert.equal(approved, 1); assert.deepEqual(mcpCalls, ['task_status']); assert.equal(await readFile(output, 'utf8'), 'Written by installed Pi via native tool');
    assert.ok(updates.some(value => value.kind === 'item' && value.item.kind === 'files' && value.item.status === 'completed'));
    const first = threadId, saved = await readFile(first, 'utf8'); assert.ok(saved.includes('Installed Pi native reply')); assert.ok(!saved.includes('fixture-private-mcp'));
    assert.equal(await executor.run({ task: { ...task, threadId: first, piHome: home, currentRunId: 'native-2' }, prompt: 'Continue the same native session.', signal: controller.signal, update, beforeStart: async () => assert.equal(threadId, first) }), 'Installed Pi native reply');
    assert.equal(threadId, first); assert.ok(modelRequests.at(-1).messages.some((value: any) => typeof value.content === 'string' && value.content.includes('Installed Pi native reply')));
  } finally { clearTimeout(timeout); }
});
