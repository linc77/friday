import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveTaskPlan } from '../src/task-plans.js';
import type { TaskEvent } from '../src/types.js';

const event: TaskEvent = { id: 'proposal', kind: 'proposal', text: '<proposed_plan>\n# Plan\n\nA deliberate change.\n</proposed_plan>', at: new Date(0).toISOString(), status: 'completed' };
async function workspace(t: { after: (fn: () => Promise<unknown>) => void }) {
  const cwd = await mkdtemp(join(tmpdir(), 'friday-plan-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, events: [event] };
}

test('Saving a completed plan is create-only and a retry or concurrent identical save confirms the original content', async t => {
  const task = await workspace(t);
  const values = await Promise.all([saveTaskPlan(task, 'proposal', 'plans/plan.md'), saveTaskPlan(task, 'proposal', 'plans/plan.md')]);
  assert.equal(values.filter(value => value.created).length, 1);
  assert.equal(await readFile(join(task.cwd, 'plans/plan.md'), 'utf8'), '# Plan\n\nA deliberate change.\n');
  assert.deepEqual(await saveTaskPlan(task, 'proposal', 'plans/plan.md'), { relativePath: 'plans/plan.md', created: false });
  await writeFile(join(task.cwd, 'plans/plan.md'), 'User changed this after saving.');
  await assert.rejects(saveTaskPlan(task, 'proposal', 'plans/plan.md'), /已经存在其他内容/);
  assert.equal(await readFile(join(task.cwd, 'plans/plan.md'), 'utf8'), 'User changed this after saving.');
});

test('Plans reject traversal, Git internals, symlink parents and incomplete or unrelated events', async t => {
  const task = await workspace(t); const outside = await workspace(t);
  await symlink(outside.cwd, join(task.cwd, 'outside'));
  await writeFile(join(outside.cwd, 'file.md'), 'Outside content'); await symlink(join(outside.cwd, 'file.md'), join(task.cwd, 'link.md'));
  for (const path of ['../plan.md', '/tmp/plan.md', '.git/config', 'plans/../../outside']) await assert.rejects(saveTaskPlan(task, 'proposal', path), /相对文件路径/);
  await assert.rejects(saveTaskPlan(task, 'proposal', 'outside/plan.md'), /符号链接/);
  await assert.rejects(saveTaskPlan(task, 'proposal', 'link.md'), /已经存在其他内容/);
  await mkdir(join(task.cwd, 'directory.md'));
  await assert.rejects(saveTaskPlan(task, 'proposal', 'directory.md'), /已经存在其他内容/);
  await assert.rejects(saveTaskPlan({ ...task, events: [{ ...event, status: 'running' }] }, 'proposal', 'running.md'), /尚未完成/);
  await assert.rejects(saveTaskPlan({ ...task, events: [{ ...event, kind: 'plan', itemId: 'plan', plan: [] }] }, 'proposal', 'steps.md'), /尚未完成/);
  assert.equal(await readFile(join(outside.cwd, 'file.md'), 'utf8'), 'Outside content');
});

test('An interrupted partial file is never silently overwritten, and old structured plan events remain exportable', async t => {
  const task = await workspace(t);
  await mkdir(join(task.cwd, 'plans')); await writeFile(join(task.cwd, 'plans/partial.md'), '# Pl');
  await assert.rejects(saveTaskPlan(task, 'proposal', 'plans/partial.md'), /已经存在其他内容/);
  const legacy = { ...task, events: [{ ...event, kind: 'plan', itemId: 'old-plan-item' }] };
  assert.equal((await saveTaskPlan(legacy, 'proposal', 'plans/legacy.md')).created, true);
});
