import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Engine } from '../../src/engine.ts';
import { IdeaImages } from '../../src/ideas.ts';

const [base, mode] = process.argv.slice(2); const directory = join(base, 'data'); const cwd = join(base, 'project'); await mkdir(cwd);
const pending = () => new Promise(() => {}); let titleStarted = false; let blockProjection = false; let linkedReady = false;
const executor = {
  async run({ update }) { await update({ kind: 'session', threadId: 'user-session' }); await update({ kind: 'turn', turnId: 'user-turn' }); return 'Original answer'; },
  async generateText({ update }) {
    if (mode === 'linked') throw new Error('The linked-context crash boundary must precede model launch');
    await update({ kind: 'session', threadId: 'crash-title-session' }); await update({ kind: 'turn', turnId: 'crash-title-turn' }); titleStarted = true;
    if (mode === 'uncertain') return pending();
    while ((await engine.snapshot()).tasks[0].status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
    blockProjection = true; return '{"title":"Recovered title"}';
  },
  async answer() {}, async steer() {},
};
const engine = await new Engine(directory, executor).open();
if (mode === 'linked') {
  const resolveImages = IdeaImages.prototype.resolve;
  IdeaImages.prototype.resolve = async function(images) {
    if (linkedReady) { await writeFile(join(base, 'ready'), 'linked context saved, model not started'); return pending(); }
    return resolveImages.call(this, images);
  };
  engine.taskTitles.resolveLinks = async () => {
    while ((await engine.snapshot()).tasks[0].status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
    linkedReady = true; return 'https://github.com/linked/project/issues/1\n{"title":"ORIGINAL_LINKED_SUBJECT","body":"Saved subject context"}';
  };
}
const mutate = engine.mutate.bind(engine);
engine.mutate = async (...args) => {
  if (blockProjection) { await writeFile(join(base, 'ready'), 'receipt persisted, projection pending'); return pending(); }
  return mutate(...args);
};
await engine.mutate(state => state.projects.push({ id: 'project', name: 'Project', path: cwd, context: '' }));
await engine.createTask({ prompt: mode === 'linked' ? 'Fix https://github.com/linked/project/issues/1' : 'Crash test task', projectId: 'project', agent: 'codex', mode: 'research', requestId: 'crash' });
if (mode === 'uncertain') {
  while (!titleStarted || (await engine.snapshot()).tasks[0].status !== 'completed') await new Promise(resolve => setTimeout(resolve, 10));
  await writeFile(join(base, 'ready'), 'native generation pending');
}
setInterval(() => {}, 1000);
