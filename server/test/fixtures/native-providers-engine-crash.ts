import { readFile } from 'node:fs/promises';
import { Engine } from '../../src/engine.js';
import type { NativeProvider } from '../../src/native-provider-config.js';
const [directory, wire, provider, sdkModule] = process.argv.slice(2) as [string, string, NativeProvider, string];
const engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }, { cursor: { sdkModule } }).open();
await engine.createTask({ prompt: 'hold', title: 'Native crash fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'native-crash' });
for (;;) {
  const records = (await readFile(wire, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (records.some(value => value.prompt === 'hold' || value.sent === 'hold') && records.some(value => value.child)) process.exit(93);
  await new Promise(resolve => setTimeout(resolve, 5));
}
