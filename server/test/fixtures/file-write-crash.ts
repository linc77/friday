import { Engine } from '../../src/engine.js';
import { TaskFiles } from '../../src/task-files.js';
import type { ExecutionRequest } from '../../src/types.js';

const [directory, serialized, phase] = process.argv.slice(2);
const engine = await new Engine(directory, { run: async (_request: ExecutionRequest) => 'fixture', steer: async () => {}, answer: async () => {} }).open();
const original = TaskFiles.prototype.writeContents;
TaskFiles.prototype.writeContents = async function (...args) {
  if (phase === 'before') process.exit(70);
  await original.apply(this, args); process.exit(71);
};
await engine.fileWrites.save(JSON.parse(serialized));
throw new Error('The crash boundary was not reached');
