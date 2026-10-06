import { serve } from '@hono/node-server';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './engine.js';
import { Auth } from './auth.js';
import { createAPI } from './api.js';
import { configureNetwork } from './network.js';

process.umask(0o077);
const network = configureNetwork();
const directory = process.env.FRIDAY_DATA_DIR ?? join(homedir(), 'Library/Application Support/Friday');
const port = Number(process.env.FRIDAY_PORT ?? 4317);
const hostname = process.env.FRIDAY_HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('FRIDAY_PORT 无效');
const engine = await new Engine(directory).open();
const auth = new Auth(directory);
const server = serve({ fetch: createAPI(engine, auth).fetch, port, hostname }, info => {
  console.log(`Friday is ready at http://${hostname}:${info.port}`);
  console.log(`Private data: ${directory}`);
  console.log(`Outbound network: ${network.source}`);
});
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close(); if ('closeAllConnections' in server) server.closeAllConnections();
  await engine.close(); auth.close(); await network.close(); process.exit(0);
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
server.on('error', async error => { console.error(error.message); await engine.close(); auth.close(); process.exit(1); });
