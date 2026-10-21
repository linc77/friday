// Dies only after the server has durably saved a known merge UUID and begun a read-only poll.
import { appendFile, writeFile } from 'node:fs/promises';
import { Engine } from '../../src/engine.js';
const [data, id, url, rawStack, marker] = process.argv.slice(2), stack = JSON.parse(rawStack);
const engine = await new Engine(data, { async run() { return 'Fixture'; }, async answer() {}, async steer() {} }, undefined, {
  environment: { GH_TOKEN: 'synthetic-stack-token' }, command: () => null, request: async (input, init) => {
    const address = new URL(String(input)); if (address.host !== 'api.github.com') throw Error('Unexpected fixture host');
    const path = address.pathname;
    if (path === '/graphql') return Response.json({ data: { repository: { viewerPermission: 'WRITE', mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, pullRequest: { id: 'fixture-node', viewerCanUpdate: true } } } });
    if (path.includes('/stacks')) return Response.json(address.search ? [stack] : stack);
    if (path.includes('/merge-async')) {
      if (init?.method === 'PUT') { await appendFile(marker, 'put\n'); return Response.json({ status: 'pending', details: { uuid: 'fixed/merge receipt' } }); }
      await appendFile(marker, 'poll\n'); return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Error('Stopped fixture')), { once: true }));
    }
    const layer = stack.pull_requests.find((l: any) => path.endsWith('/' + l.number)); if (!layer) throw Error('Unexpected fixture API');
    return Response.json({ number: layer.number, html_url: url.replace('/18', '/' + layer.number), title: layer.title, state: 'open', head: layer.head, base: { ref: 'main' }, user: { login: 'author' } });
  },
}).open();
const run = await engine.changeRequestStacks.start(id, { requestId: 'crash-stack', url, action: 'merge', stackNumber: stack.number, targetNumber: 18, mergeMethod: 'squash', expectedStackHeads: stack.pull_requests.map((l: any) => ({ number: l.number, headSha: l.head.sha })) });
await writeFile(marker + '.run', run); setInterval(() => {}, 1000);
