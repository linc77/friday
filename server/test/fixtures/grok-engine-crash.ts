import { readFile } from 'node:fs/promises';
import { Engine } from '../../src/engine.js';
const directory = process.argv[2]!, wire = process.argv[3]!;
const engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }).open();
await engine.createTask({ prompt: 'hold', title: 'Grok crash fixture', projectId: 'project', mode: 'code', agent: 'grok', model: 'grok-fast', requestId: 'grok-crash' });
while (true) {
  const records = (await readFile(wire, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records.some(value => value.prompt === 'hold') && records.some(value => value.child)) process.exit(93);
  await new Promise(resolve => setTimeout(resolve, 5));
}
