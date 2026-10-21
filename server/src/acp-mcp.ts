import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskMcpConnection } from './types.js';

/** A stdio fallback for ACP agents without native HTTP MCP transport. Tokens
 * travel in the child's environment, never in argv or the public task state. */
export const acpMcpRelaySource = String.raw`
const endpoint = process.env.FRIDAY_ACP_MCP_URL;
const headers = JSON.parse(process.env.FRIDAY_ACP_MCP_HEADERS || '{}');
if (!endpoint) process.exit(1);
const controller = new AbortController();
process.on('SIGTERM', () => { controller.abort(); process.exit(0); });
let session, buffer = '', dropped = false;
const max = 64 * 1024 * 1024;
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
async function dispatch(record) {
  const notification = record.id === undefined;
  try {
    const response = await fetch(endpoint, { method: 'POST', signal: controller.signal,
      headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Protocol-Version': '2025-06-18', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(record) });
    if (notification) { await response.body?.cancel(); return; }
    if (!response.ok) throw Error('Friday MCP HTTP ' + response.status);
    session = response.headers.get('Mcp-Session-Id') || session;
    const reader = response.body?.getReader(); if (!reader) throw Error('Empty Friday MCP response');
    const decoder = new TextDecoder(); let text = '', bytes = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > max) { await reader.cancel(); throw Error('Friday MCP response exceeds limit'); } text += decoder.decode(part.value, { stream: true }); }
    text += decoder.decode();
    const values = response.headers.get('Content-Type')?.includes('text/event-stream')
      ? text.split(/\r?\n\r?\n/).flatMap(frame => { const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'); try { return data ? [JSON.parse(data)] : []; } catch { return []; } })
      : [JSON.parse(text)];
    const result = values.find(value => value.id === record.id && ('result' in value || 'error' in value));
    if (!result) throw Error('Friday MCP returned no matching response'); emit(result);
  } catch (error) { if (!notification) emit({ jsonrpc: '2.0', id: record.id, error: { code: -32603, message: error.message || 'Friday MCP unavailable' } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  for (let start = 0; start < chunk.length;) {
    const index = chunk.indexOf('\n', start), end = index < 0 ? chunk.length : index;
    if (!dropped) { if (buffer.length + end - start > max) { buffer = ''; dropped = true; } else buffer += chunk.slice(start, end); }
    if (index < 0) break;
    if (!dropped && buffer) { try { const value = JSON.parse(buffer); if (value && value.jsonrpc === '2.0' && typeof value.method === 'string') void dispatch(value); } catch {} }
    buffer = ''; dropped = false; start = index + 1;
  }
});
process.stdin.on('end', () => { controller.abort(); process.exit(0); });
`;
export async function acpMcpServer(directory: string, connection: TaskMcpConnection, nativeHTTP: boolean) {
  if (nativeHTTP) return { type: 'http', name: 'friday', url: connection.url, headers: Object.entries(connection.headers).map(([name, value]) => ({ name, value })) };
  const runtime = join(directory, 'acp-runtime'); await mkdir(runtime, { recursive: true, mode: 0o700 });
  const path = join(runtime, `mcp-relay-${createHash('sha256').update(acpMcpRelaySource).digest('hex').slice(0, 16)}.mjs`);
  if (await readFile(path, 'utf8').catch(() => undefined) !== acpMcpRelaySource) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, acpMcpRelaySource, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  return { name: 'friday', command: process.execPath, args: [path], env: [{ name: 'FRIDAY_ACP_MCP_URL', value: connection.url }, { name: 'FRIDAY_ACP_MCP_HEADERS', value: JSON.stringify(connection.headers) }] };
}
