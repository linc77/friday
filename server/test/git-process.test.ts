import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceCommand } from '../src/git-process.js';

test('Binary Git transfers stream through files without text decoding or capture-size limits', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'friday-git-stream-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const inputPath = join(cwd, 'input'); const stdoutPath = join(cwd, 'output');
  const bytes = randomBytes(2 * 1024 * 1024); await writeFile(inputPath, bytes);
  const output = await workspaceCommand(cwd, process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputPath, stdoutPath, limit: 1024 });
  assert.equal(output.stdout, ''); assert.deepEqual(await readFile(stdoutPath), bytes);
  await assert.rejects(workspaceCommand(cwd, process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { inputPath: join(cwd, 'missing'), stdoutPath: join(cwd, 'failed') }), /文件传输失败/);
});

test('Cancelling Git process groups stops hook descendants as well as a parent that ignores termination', { timeout: 8000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'friday-git-process-')); const ready = join(cwd, 'ready'); const late = join(cwd, 'late');
  const controller = new AbortController();
  const child = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'must not run'),1500);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const running = workspaceCommand(cwd, process.execPath, ['-e', parent], { signal: controller.signal });
  void running.catch(() => {});
  try {
    const deadline = Date.now() + 2000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(ready), true, 'The descendant really started before cancellation');
    controller.abort(); await assert.rejects(running, /已中断/); assert.equal(existsSync(late), false);
  } finally { controller.abort(); await rm(cwd, { recursive: true, force: true }); }
});

test('Optional bounded metadata capture drains stdout, preserves UTF-8 boundaries and still rejects excessive stderr', async () => {
  const script = 'process.stdout.write("aaaa😀"+"b".repeat(200000));';
  const result = await workspaceCommand(tmpdir(), process.execPath, ['-e', script], { limit: 5, truncateStdout: true });
  assert.equal(result.stdout, 'aaaa'); assert.equal(result.stdoutTruncated, true); assert.equal(result.code, 0);
  await assert.rejects(workspaceCommand(tmpdir(), process.execPath, ['-e', script], { limit: 5 }), /输出过大/);
  await assert.rejects(workspaceCommand(tmpdir(), process.execPath, ['-e', 'process.stderr.write("x".repeat(20000));'], { limit: 100, truncateStdout: true }), /输出过大/);
});
