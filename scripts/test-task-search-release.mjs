import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = await mkdtemp(join(tmpdir(), 'friday-search-runtime-'));
let engine;
try {
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.release.json', '--outDir', output], { cwd: root, stdio: 'pipe' });
  assert.ok((await readFile(join(output, 'server/src/task-search-worker.mjs'), 'utf8')).includes('readOnly: true'));
  await writeFile(join(output, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(root, 'node_modules'), join(output, 'node_modules'));
  const { Engine } = await import(pathToFileURL(join(output, 'server/src/engine.js')).href);
  const { taskSearchInput } = await import(pathToFileURL(join(output, 'server/src/task-search.js')).href);
  class NoWork { async run() { throw new Error('Compiled search must not start an agent'); } async answer() {} async steer() {} }
  engine = await new Engine(join(output, 'data'), new NoWork()).open();
  await engine.mutate(state => state.tasks.push({ id: 'compiled-search', title: 'Compiled search', prompt: '', projectId: null, cwd: output, agent: 'codex', mode: 'research',
    status: 'completed', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:01:00Z', durableId: null, threadId: null, turnId: null,
    result: '', error: null, events: [], approvals: [], artifact: null, lastRequestId: 'compiled-search',
    messages: [{ id: 'input', role: 'user', text: 'compiled runtime needle', at: '2026-10-18T00:00:00Z' }] }));
  const result = await engine.taskSearch.search(taskSearchInput('runtime needle'));
  assert.equal(result.matches[0]?.taskId, 'compiled-search');
  console.log('Compiled release runtime includes and executes the read-only search worker without a TypeScript loader.');
} finally {
  await engine?.close(); await rm(output, { recursive: true, force: true });
}
