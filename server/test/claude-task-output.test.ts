import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeTaskOutputReaders, ClaudeTaskOutputTail, claudeTaskOutputRoot, type ClaudeOutputChunk } from '../src/claude-task-output.js';
import { ClaudeEvents } from '../src/claude-events.js';
import type { ExecutionUpdate } from '../src/types.js';

const session = '0c91bb28-9e89-4889-bd22-3de9880233d3';
const task = 'foreground-bash';
async function layout(t: { after: (fn: () => Promise<unknown>) => void }) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'friday-claude-output-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'root'); const project = join(root, '-project'); const sessionPath = join(project, session); const tasks = join(sessionPath, 'tasks'); const file = join(tasks, task + '.output');
  await mkdir(tasks, { recursive: true });
  return { base, root, project, sessionPath, tasks, file };
}
function collect() {
  const chunks: ClaudeOutputChunk[] = []; let wake: (() => void) | undefined;
  return { chunks, put: async (chunk: ClaudeOutputChunk) => { chunks.push(chunk); wake?.(); },
    until: async (predicate: () => boolean) => {
      const deadline = Date.now() + 4000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('File output did not arrive');
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 30); wake = () => { clearTimeout(timer); resolve(); }; });
      }
    } };
}

test('Claude output follows a file created after the task event, preserves split UTF-8 and drains bytes written immediately before the result', { timeout: 6000 }, async t => {
  const fixture = await layout(t); await rm(fixture.tasks, { recursive: true }); const output = collect();
  const tail = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }); t.after(() => tail.stop());
  await mkdir(fixture.tasks); const encoded = Buffer.from('café 🚀\n');
  await writeFile(fixture.file, encoded.subarray(0, 4));
  await output.until(() => output.chunks.length > 0); assert.equal(output.chunks[0].text, 'caf');
  await appendFile(fixture.file, encoded.subarray(4)); await tail.stop();
  assert.equal(output.chunks.map(chunk => chunk.text).join(''), 'café 🚀\n');
});

test('Stopping a follower with no output file ends promptly and never creates a file or starts execution', { timeout: 3000 }, async t => {
  const fixture = await layout(t); const output = collect();
  const tail = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put });
  await tail.stop(); assert.deepEqual(output.chunks, []); await assert.rejects(readFile(fixture.file));
});

test('A fast file writer is bounded per read and reports the skipped prefix while retaining its last output', { timeout: 6000 }, async t => {
  const fixture = await layout(t); await writeFile(fixture.file, 'first\n'); const output = collect();
  const tail = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }); t.after(() => tail.stop());
  await output.until(() => output.chunks.length > 0);
  await appendFile(fixture.file, 'line\n'.repeat(400_000) + 'last\n'); await tail.stop();
  const last = output.chunks.at(-1)!; assert.equal(last.truncated, true); assert.ok(last.text.length <= 256 * 1024 + 1); assert.ok(last.text.endsWith('last\n'));
});

test('Truncation and atomic replacement reset the byte cursor and decoder without splicing incomplete characters into a new file', { timeout: 6000 }, async t => {
  const fixture = await layout(t); await writeFile(fixture.file, Buffer.concat([Buffer.from('previous output\n'), Buffer.from([0xe2])])); const output = collect();
  const tail = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }); t.after(() => tail.stop());
  await output.until(() => output.chunks.length > 0);
  await writeFile(fixture.file, 'new\n'); await output.until(() => output.chunks.some(chunk => chunk.reset));
  assert.deepEqual(output.chunks[1], { text: 'new\n', reset: true });
  await writeFile(fixture.file + '.next', 'replacement output\n'); await rename(fixture.file + '.next', fixture.file); await tail.stop();
  assert.deepEqual(output.chunks.at(-1), { text: 'replacement output\n', reset: true });
});

test('Session and task identifiers cannot traverse paths, and an output path from another session is never consumed', { timeout: 3000 }, async t => {
  const fixture = await layout(t); await writeFile(fixture.file, 'private output');
  const output = collect();
  for (const [sessionId, taskId] of [[session, '../foreground-bash'], ['../' + session, task], [session, '/etc/passwd']]) {
    await new ClaudeTaskOutputTail({ root: fixture.root, sessionId, taskId, onChunk: output.put }).done;
  }
  const other = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: '1c91bb28-9e89-4889-bd22-3de9880233d3', taskId: task, onChunk: output.put }); await other.stop();
  assert.deepEqual(output.chunks, []);
});

test('Output followers reject symlinked directories, symlinked files and hard links rather than reading another local file', { timeout: 6000 }, async t => {
  const fixture = await layout(t); const privateFile = join(fixture.base, 'private'); await writeFile(privateFile, 'must never be read'); const output = collect();
  await symlink(privateFile, fixture.file);
  await new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }).stop(); await rm(fixture.file);
  await link(privateFile, fixture.file);
  await new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }).stop(); await rm(fixture.file);
  await writeFile(fixture.file, 'directory target must stay hidden');
  for (const [index, path] of [fixture.tasks, fixture.sessionPath, fixture.project].entries()) {
    const moved = join(fixture.base, 'outside-root-' + index); await rename(path, moved); await symlink(moved, path);
    await new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: output.put }).stop();
    await rm(path); await rename(moved, path);
  }
  assert.deepEqual(output.chunks, []);
  const live = collect(); const tail = new ClaudeTaskOutputTail({ root: fixture.root, sessionId: session, taskId: task, onChunk: live.put }); t.after(() => tail.stop());
  await live.until(() => live.chunks.length === 1);
  await rm(fixture.file); await symlink(privateFile, fixture.file); await tail.stop();
  assert.equal(live.chunks.length, 1); assert.ok(!live.chunks[0].text.includes('must never be read'));
});

test('The task router only follows known foreground Bash calls, ignores stale run frames and drains before a tool result', { timeout: 6000 }, async t => {
  const fixture = await layout(t); await writeFile(fixture.file, 'one\n'); const output = collect();
  const readers = new ClaudeTaskOutputReaders({ root: fixture.root, sessionId: session, isCommand: id => id === 'bash', onChunk: async (_, chunk) => output.put(chunk) }); t.after(() => readers.close());
  const start = { type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: task, tool_use_id: 'bash', session_id: session, run_id: 'current', is_backgrounded: false } as const;
  for (const change of [{ tool_use_id: 'unknown' }, { session_id: 'another' }, { is_backgrounded: true }, { task_type: 'local_agent' }, { ambient: true }, { parent_task_id: 'child' }]) await readers.handle({ ...start, ...change } as any);
  assert.equal(output.chunks.length, 0);
  await readers.handle(start as any); await output.until(() => output.chunks.length === 1);
  await readers.handle(start as any);
  await readers.handle({ type: 'system', subtype: 'task_updated', task_id: task, session_id: session, run_id: 'older', patch: { status: 'completed' } } as any);
  await readers.handle({ type: 'system', subtype: 'task_notification', task_id: task, session_id: session, status: 'completed', output_file: '/untrusted/path' } as any);
  await appendFile(fixture.file, 'two\n'); await output.until(() => output.chunks.length === 2);
  await appendFile(fixture.file, 'last\n');
  await readers.handle({ type: 'user', session_id: session, parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'complete' }] } } as any);
  assert.equal(output.chunks.map(chunk => chunk.text).join(''), 'one\ntwo\nlast\n');
  await appendFile(fixture.file, 'after result\n'); await readers.close(); assert.equal(output.chunks.length, 3);
});

test('Backgrounding or ending a known native task closes its file follower; closing a query prevents later starts', { timeout: 6000 }, async t => {
  const fixture = await layout(t); await writeFile(fixture.file, 'one\n'); const output = collect();
  const readers = new ClaudeTaskOutputReaders({ root: fixture.root, sessionId: session, isCommand: () => true, onChunk: async (_, chunk) => output.put(chunk) });
  const start = { type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: task, tool_use_id: 'bash', session_id: session, run_id: 'current' } as const;
  await readers.handle(start as any); await output.until(() => output.chunks.length === 1);
  await appendFile(fixture.file, 'final\n');
  await readers.handle({ type: 'system', subtype: 'task_updated', task_id: task, session_id: session, run_id: 'current', patch: { is_backgrounded: true } } as any);
  await appendFile(fixture.file, 'hidden\n'); await readers.close(); await readers.handle(start as any);
  assert.equal(output.chunks.map(chunk => chunk.text).join(''), 'one\nfinal\n');
});

test('Claude command output uses a view-only channel, has no JSON input masquerading as stdout and saves an interrupted tail', async () => {
  const updates: ExecutionUpdate[] = []; const events = new ClaudeEvents('turn', async value => { updates.push(value); });
  await events.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'assistant', content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'build', timeout: 5000 } }] } } as any);
  const started = updates.find(value => value.kind === 'item'); assert.ok(started?.kind === 'item'); assert.equal(started.item.detail, undefined);
  const count = updates.length; await events.commandOutput('bash', { text: 'first\n' }); await events.commandOutput('bash', { text: 'new\n', reset: true, truncated: true });
  assert.ok(updates.slice(count).every(value => value.kind === 'commandOutput'));
  await events.finish('interrupted');
  const final = updates.findLast(value => value.kind === 'item' && value.item.kind === 'command'); assert.ok(final?.kind === 'item');
  assert.equal(final.item.detail, 'new\n'); assert.equal(final.item.detailTruncated, true); assert.equal(final.item.status, 'interrupted');
  await events.handle({ type: 'assistant', message: { id: 'next', content: [{ type: 'tool_use', id: 'missing-result', name: 'Bash', input: { command: 'unfinished' } }] } } as any);
  await events.commandOutput('missing-result', { text: 'partial\n' }); await events.finish('completed', 'Assistant finished');
  const missing = updates.findLast(value => value.kind === 'item' && value.item.itemId === 'missing-result'); assert.ok(missing?.kind === 'item');
  assert.equal(missing.item.status, 'interrupted'); assert.equal(missing.item.detail, 'partial\n');
});

test('The effective Claude temp environment controls the root without changing process-wide environment', () => {
  const previous = process.env.CLAUDE_CODE_TMPDIR;
  assert.equal(claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: '/custom/temp' }, '/project'), `/custom/temp/claude-${process.getuid!()}`);
  assert.equal(claudeTaskOutputRoot({ CLAUDE_CODE_TMPDIR: 'relative' }, '/project'), `/project/relative/claude-${process.getuid!()}`);
  assert.equal(claudeTaskOutputRoot({}, '/project'), `/tmp/claude-${process.getuid!()}`);
  assert.equal(process.env.CLAUDE_CODE_TMPDIR, previous);
});
