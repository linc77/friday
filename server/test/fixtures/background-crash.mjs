import { mkdir, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from '../../src/engine.ts';
import { CodexExecutor } from '../../src/codex.ts';

const directory = process.argv[2]; const cwd = join(directory, 'project'); await mkdir(cwd, { recursive: true });
const command = fileURLToPath(new URL('codex-background.mjs', import.meta.url)); await chmod(command, 0o755);
await writeFile(join(cwd, 'hold-stop-receipt'), '');
const engine = await new Engine(join(directory, 'data'), new CodexExecutor(command)).open();
await engine.mutate(state => { state.projects.push({ id: 'project', name: 'Owned fixture', path: cwd, context: '' }); });
const id = await engine.createTask({ projectId: 'project', title: 'Crash fixture', agent: 'codex', mode: 'research', prompt: 'Owned background task', requestId: 'first' });
while (true) {
  const task = (await engine.snapshot()).tasks.find(task => task.id === id);
  if (task.status === 'completed' && task.backgroundCommands?.[0]?.status === 'running') {
    const command = task.backgroundCommands[0]; await engine.backgroundCommands.stop(id, command.id, command.sessionId, 'crash-stop'); break;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
}
// The test kills this owner only after the fake CLI records the stop wire call.
setInterval(() => {}, 1_000);
