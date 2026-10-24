#!/usr/bin/env node
// Independent HTTP/SSE fixture. Production uses the pinned official clients.
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
export async function openCodeFixture({ generation = 2, password = '私有密码', port = 0, wire, directory = process.cwd() } = {}) {
  const records = [], clients = new Set(), timers = new Set(), sessions = new Map(), children = new Set(); let mcp;
  const record = value => { records.push(value); if (wire) appendFileSync(wire, JSON.stringify(value) + '\n'); };
  const emit = (type, data) => { const event = generation === 2 ? { type, data } : { type, properties: data }; for (const client of clients) client.write('data: ' + JSON.stringify(event) + '\r\n\r\n'); };
  const later = (fn, delay = 5) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); };
  const complete = (sessionID, nativeId, text = 'OpenCode reply café\u2028line\u2029end') => {
    const session = sessions.get(sessionID);
    if (session) { session.messages.push(generation === 2 ? { id: 'assistant-' + nativeId, type: 'assistant', content: [{ type: 'text', text }] } : { info: { id: 'assistant-' + nativeId, sessionID, role: 'assistant', parentID: nativeId }, parts: [{ type: 'text', text }] }); if (wire) writeFileSync(join(directory, sessionID + '.fixture.json'), JSON.stringify(session)); }
    if (generation === 2) {
      emit('session.text.delta', { sessionID: 'foreign', assistantMessageID: 'foreign', ordinal: 0, delta: 'WRONG' });
      emit('session.execution.succeeded', { sessionID }); // stale completion before our delivery
      emit('session.inbox.delivered', { sessionID, inboxID: nativeId });
      if (session?.lastPrompt === 'children') {
        const id = 'child-tool-' + nativeId, childID = 'child-' + nativeId;
        emit('session.tool.input.started', { sessionID, id, name: 'subagent' });
        emit('session.tool.called', { sessionID, id, input: { prompt: 'Inspect OpenCode child', description: 'Native OpenCode child', model: 'native/child', background: true } });
        emit('session.tool.progress', { sessionID, id, metadata: { sessionID: childID } });
        emit('session.text.delta', { sessionID: childID, assistantMessageID: 'child-answer', ordinal: 0, delta: 'OpenCode child stream' });
        emit('session.tool.success', { sessionID, id, metadata: { sessionID: childID, status: 'running' }, content: [{ type: 'text', text: 'Background child launch ACK' }] });
        emit('session.synthetic', { sessionID, metadata: { source: 'subagent', childID, state: 'completed' }, text: '<subagent>\nOpenCode child result\n</subagent>' });
      }
      emit('session.tool.input.started', { sessionID, id: 'shell-' + nativeId, name: 'shell' });
      emit('session.tool.called', { sessionID, id: 'shell-' + nativeId, input: { command: 'printf fixture' } });
      emit('session.tool.success', { sessionID, id: 'shell-' + nativeId, content: [{ type: 'text', text: 'native command output' }] });
      emit('session.text.started', { sessionID, assistantMessageID: 'assistant-' + nativeId, ordinal: 0 });
      emit('session.text.delta', { sessionID, assistantMessageID: 'assistant-' + nativeId, ordinal: 0, delta: text });
      emit('session.text.ended', { sessionID, assistantMessageID: 'assistant-' + nativeId, ordinal: 0, text });
      emit('session.step.ended', { sessionID, tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } } });
      emit('session.execution.succeeded', { sessionID });
    } else {
      const id = 'assistant-' + nativeId;
      emit('message.updated', { info: { id: nativeId, sessionID, role: 'user' } });
      if (session?.lastPrompt === 'children') {
        const part = { id: 'child-tool-' + nativeId, sessionID, messageID: id, type: 'tool', tool: 'task' }, input = { prompt: 'Inspect OpenCode child', description: 'Native OpenCode child', model: 'native/child' };
        emit('message.part.updated', { part: { ...part, state: { status: 'running', input, metadata: { sessionID: 'child-' + nativeId } } } });
        emit('message.part.updated', { part: { ...part, state: { status: 'completed', input, metadata: { sessionID: 'child-' + nativeId }, output: 'OpenCode child result' } } });
      }
      emit('message.part.updated', { part: { id: 'text-' + nativeId, messageID: id, sessionID, type: 'text', text: text.slice(0, 7), time: { end: 5 } } });
      emit('message.part.delta', { sessionID, messageID: id, partID: 'text-' + nativeId, field: 'text', delta: text.slice(7) });
      emit('message.updated', { info: { id, sessionID, role: 'assistant', parentID: nativeId, time: { completed: 5 }, finish: 'stop', tokens: { input: 10, output: 5, reasoning: 3, cache: { read: 2, write: 1 } } } });
      emit('message.updated', { info: { id: 'foreign', sessionID, role: 'assistant', parentID: 'another-message', time: { completed: 5 } } });
      emit('message.part.updated', { part: { id: 'wrong', sessionID, messageID: 'foreign', type: 'text', text: 'WRONG' } });
      emit('session.idle', { sessionID });
    }
  };
  const pending = new Map();
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname; let body;
    try { let raw = ''; for await (const chunk of req) raw += chunk; body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end(); return; }
    record({ method: req.method, path, body, subscribed: clients.size > 0 });
    const json = (data, code = 200) => { if (generation === 2 && (path.startsWith('/api/experimental/mcp/') || req.method === 'PATCH' || req.method === 'POST' && /\/(model|agent|move|interrupt|commit)$/.test(path) || path.includes('/form/') || path.includes('/permission/') && path.endsWith('/reply'))) code = 204; res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(code === 204 ? '' : JSON.stringify(data)); };
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + password).toString('base64')) { json({ error: 'unauthorized' }, 401); return; }
    if (path === '/api/info') { if (generation === 2) json({ version: '2.0.28', pid: process.pid }); else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>OpenCode</html>'); } return; }
    if (path === '/global/health') { json({ healthy: true, version: '1.14.19' }); return; }
    if (path === '/api/event' || path === '/event') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (path === '/provider') { json({ all: [{ id: 'native', models: { model: { id: 'model', name: 'Native model', variants: { high: {} }, limit: { context: 120000 } } } }, { id: 'unconnected', models: { hidden: { id: 'hidden' } } }], connected: ['native'], default: { native: 'model' } }); return; }
    if (path === '/api/model') { json({ data: [{ id: 'model', providerID: 'native', name: 'Native model', variants: [{ id: 'high' }], limit: { context: 120000 } }] }); return; }
    if (path === '/api/agent') { json({ data: [{ id: 'plan', permissions: [{ action: 'edit', resource: '/plans/*', effect: 'allow' }] }] }); return; }
    if (path === '/api/command' || path === '/api/skill') { json({ data: [] }); return; }
    if (path === '/api/session/active' || path === '/session/status') { json(generation === 2 ? { data: {} } : {}); return; }
    if (path === '/command' || path === '/skill') { json([]); return; }
    if (path.startsWith('/api/experimental/mcp/') || path === '/mcp') { if (req.method === 'POST' || req.method === 'PUT') mcp = body.config; json({}); return; }
    if ((path === '/api/session' || path === '/session') && req.method === 'POST') { const id = 'ses_' + randomUUID().replaceAll('-', ''), session = { id, location: { directory }, permission: body.permission, permissions: body.permissions, messages: [] }; sessions.set(id, session); if (wire) writeFileSync(join(directory, id + '.fixture.json'), JSON.stringify(session)); json(generation === 2 ? { data: session } : session); return; }
    const match = path.match(/^\/(?:api\/)?session\/([^/]+)(.*)$/);
    if (match) {
      const [, sessionID, suffix] = match; let session = sessions.get(sessionID);
      const saved = join(directory, sessionID + '.fixture.json'); if (!session && wire && existsSync(saved)) session = JSON.parse(readFileSync(saved, 'utf8'));
      if (!session) { json({ error: 'Native session not found' }, 404); return; }
      sessions.set(sessionID, session);
      session.messages ??= [];
      if (suffix === '/message' && req.method === 'GET') { const query = new URL(req.url, 'http://fixture').searchParams, offset = Number(query.get('cursor') ?? 0), limit = Math.min(Number(query.get('limit') ?? 10000), 2), data = session.messages.slice(offset, offset + limit); json(generation === 2 ? { data, cursor: { next: offset + limit < session.messages.length ? String(offset + limit) : null } } : session.messages); return; }
      if (suffix === '/fork') {
        const boundary = body.before ?? body.messageID, end = boundary ? session.messages.findIndex(message => (message.info ?? message).id === boundary) : session.messages.length;
        if (end < 0) { json({ error: 'Unknown cut' }, 400); return; }
        const id = 'ses_' + randomUUID().replaceAll('-', ''), copy = JSON.parse(JSON.stringify({ ...session, id, fork: { sessionID }, messages: session.messages.slice(0, end) }));
        // Native copies may assign new IDs; consumers must map verified content.
        for (const message of copy.messages) { const info = message.info ?? message; info.id = 'msg_' + randomUUID().replaceAll('-', ''); if (message.info) info.sessionID = id; }
        sessions.set(id, copy); if (wire) writeFileSync(join(directory, id + '.fixture.json'), JSON.stringify(copy)); json(generation === 2 ? { data: copy } : copy); return;
      }
      if (suffix === '/revert/stage') { session.revert = { messageID: body.messageID }; json({ data: session.revert }); return; }
      if (suffix === '/revert/commit') { const boundary = session.messages.findIndex(message => message.id === session.revert?.messageID); if (boundary < 0) { json({}, 400); return; } session.messages = session.messages.slice(0, boundary); delete session.revert; json({}); return; }
      if (!suffix) { if (req.method === 'PATCH') Object.assign(session, body); json(generation === 2 ? { data: session } : session); return; }
      if (suffix === '/abort' || suffix === '/interrupt') { for (const child of children) child.kill(); json(true); emit('session.execution.interrupted', { sessionID }); return; }
      if (['/model', '/agent', '/move'].includes(suffix)) { json({}); return; }
      if (suffix === '/prompt' || suffix === '/prompt_async' || suffix === '/compact' || suffix === '/summarize') {
        const nativeId = body.id ?? body.messageID ?? 'compact', raw = body.text ?? body.parts?.[0]?.text ?? '/compact', text = raw.match(/^Task: ([^\n]+)/m)?.[1] ?? raw;
        record({ prompt: text, sessionID, nativeId, pid: process.pid, generation });
        session.lastPrompt = text;
        session.messages.push(generation === 2 ? { id: nativeId, type: 'user', content: [{ type: 'text', text: raw }] } : { info: { id: nativeId, sessionID, role: 'user' }, parts: body.parts ?? [] });
        if (body.delivery === 'steer') { json({ data: { id: nativeId } }); later(() => emit('session.inbox.delivered', { sessionID, inboxID: nativeId }), 40); return; }
        if (text === 'hold') { const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); children.add(child); record({ child: child.pid }); json(generation === 2 ? { data: { id: nativeId } } : true); return; }
        if (text === 'disconnect') { json(generation === 2 ? { data: { id: nativeId } } : true); later(() => { for (const client of clients) client.end(); }); return; }
        if (text === 'permission' || text === 'question' || text === 'form') {
          pending.set(sessionID, nativeId); json(generation === 2 ? { data: { id: nativeId } } : true);
          later(() => { if (generation === 2) emit('session.inbox.delivered', { sessionID, inboxID: nativeId }); else emit('message.updated', { info: { id: nativeId, sessionID, role: 'user' } });
            if (text === 'permission') emit('permission.asked', { id: 'perm-fixture', sessionID, permission: 'bash', action: 'shell', patterns: ['echo test'], resources: ['echo test'], save: ['echo *'] });
            else if (text === 'question') emit('question.asked', { id: 'question-fixture', sessionID, questions: [{ header: 'Pick', question: 'Pick one', options: [{ label: 'First', description: 'First value' }], custom: false }] });
            else emit('form.created', { form: { id: 'form-fixture', sessionID, title: 'Choose', fields: [{ key: 'choice', type: 'string', title: 'Pick one', options: [{ label: 'First', value: 'native-first' }], custom: false }] } }); }); return;
        }
        if (text === 'mcp' && mcp) await fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...mcp.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture', arguments: { text: 'native-mcp' } } }) });
        if (generation === 1) { complete(sessionID, nativeId); later(() => json(true), 30); }
        else { json({ data: { id: nativeId } }); later(() => complete(sessionID, nativeId)); } return;
      }
      if (suffix.startsWith('/form/') && (suffix.endsWith('/reply') || req.method === 'DELETE')) { json({}); later(() => complete(sessionID, pending.get(sessionID))); return; }
      if (suffix.startsWith('/permission/') && suffix.endsWith('/reply')) { json({}); later(() => complete(sessionID, pending.get(sessionID))); return; }
    }
    if (/^\/(?:api\/)?permission\//.test(path) || /^\/question\//.test(path)) { json(true); for (const [id, native] of pending) later(() => complete(id, native)); return; }
    json({ error: 'Unhandled fixture path ' + path }, 404);
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve)); const url = 'http://127.0.0.1:' + server.address().port;
  return { url, records, emit, close: async () => { for (const timer of timers) clearTimeout(timer); for (const child of children) child.kill(); for (const client of clients) client.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generation = process.env.OPENCODE_TEST_GENERATION === '1' ? 1 : 2;
  if (process.argv.includes('--version')) { console.log(generation === 1 ? '1.14.19' : '2.0.28'); process.exit(0); }
  const fixture = await openCodeFixture({ generation, password: process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD, port: Number(process.argv.find(value => value.startsWith('--port='))?.split('=')[1]) || 0, wire: process.env.OPENCODE_TEST_WIRE });
  console.log('opencode server listening on ' + fixture.url);
  process.on('SIGTERM', async () => { await fixture.close(); process.exit(0); });
}
