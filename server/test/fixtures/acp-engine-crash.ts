import { readFile } from 'node:fs/promises';
import { Engine } from '../../src/engine.js';
import type { AcpProviderID } from '../../src/acp-provider-settings.js';
import { AcpRegistryCatalog } from '../../src/acp-registry-catalog.js';
const [directory, wire, provider] = process.argv.slice(2) as [string, string, AcpProviderID];
const registry = new AcpRegistryCatalog(directory, { fetch: (async () => { throw new Error('Fixture uses its validated offline registry'); }) as typeof fetch });
const engine = await new Engine(directory, undefined, undefined, { changeRequestSyncIntervalMs: 0 }, { acpRegistry: { registry } }).open();
await engine.createTask({ prompt: 'hold', title: 'ACP crash fixture', projectId: 'project', mode: 'code', agent: provider, requestId: 'crash' });
for (;;) { const records = (await readFile(wire, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)); if (records.some(value => value.prompt === 'hold') && records.some(value => value.child)) process.exit(93); await new Promise(resolve => setTimeout(resolve, 5)); }
