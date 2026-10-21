import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { antigravitySkills } from '../src/antigravity-skills.js';
test('Antigravity Skill roots, names, case handling, user precedence and one-level scanning match its native loader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-antigravity-skills-')), home = join(directory, 'home'), cwd = join(directory, 'repo'); t.after(() => rm(directory, { recursive: true, force: true }));
  const skill = async (path: string, text: string, name = 'SKILL.md') => { await mkdir(path, { recursive: true }); await writeFile(join(path, name), text); };
  await skill(join(home, '.gemini/config/skills/review'), '---\nname: review\ndescription: User config wins\n---\n'); await skill(join(cwd, '.gemini/skills/review'), '---\nname: review\ndescription: Project cannot replace user config\n---\n');
  await skill(join(home, '.gemini/antigravity-cli/skills/cli'), '---\nname: cli\n---\n'); await skill(join(cwd, '.agents/skills/project'), '---\nname: project\n---\n', 'Skill.md'); await skill(join(cwd, '.agent/skills/fallback'), '---\ndescription: Native filename fallback\n---\n');
  await skill(join(home, '.agents/skills/not-native'), '---\nname: must-not-appear\n---\n'); await skill(join(cwd, '.gemini/skills/deep/nested'), '---\nname: too-deep\n---\n'); await skill(join(cwd, '.gemini/skills/bad'), '---\nname: " trailing "\n---\n');
  const values = await antigravitySkills(cwd, home); assert.deepEqual(values.map(value => value.name), ['cli', 'project', 'review', 'SKILL'].sort((a, b) => a.localeCompare(b))); assert.equal(values.find(value => value.name === 'review')?.description, 'User config wins'); assert.equal(values.find(value => value.name === 'project')?.scope, 'project');
});
