import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Engine } from '../src/engine.js';
import { TaskSearch, taskSearchInput } from '../src/task-search.js';

// Produced by the actual 1.0.2 writer, including its Chord deltas, not a v2 DB
// with a rewritten version number. The fixture contains only synthetic data.
test('1.0.2 SQLite migrates without losing tasks or document deltas and remains searchable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'friday-durable-upgrade-'));
  const file = join(directory, 'friday.sqlite');
  const reader = new TaskSearch(directory);
  let engine: Engine | undefined;
  try {
    const db = new DatabaseSync(file);
    db.exec(await readFile(new URL('./fixtures/pi-durable-1.0.2.sql', import.meta.url), 'utf8'));
    const tasks = db.prepare('SELECT * FROM tasks ORDER BY id').all();
    const revisions = db.prepare('SELECT * FROM document_revisions ORDER BY document_id, seq').all();
    assert.ok(revisions.some(row => row.kind === 'delta'));
    assert.equal(db.prepare('SELECT version FROM durable_schema').get()?.version, 1);
    db.close();
    const before = await reader.search(taskSearchInput('migration needle'));
    assert.equal(before.matches[0]?.taskId, 'legacy');
    // Search must never migrate a database itself.
    const old = new DatabaseSync(file, { readOnly: true });
    assert.equal(old.prepare('SELECT version FROM durable_schema').get()?.version, 1); old.close();

    const storage = await openNodeSqliteStorage(file);
    await storage.close(context);
    const migrated = new DatabaseSync(file, { readOnly: true });
    assert.equal(migrated.prepare('SELECT version FROM durable_schema').get()?.version, 2);
    assert.deepEqual(migrated.prepare('SELECT * FROM tasks ORDER BY id').all(), tasks);
    assert.deepEqual(migrated.prepare('SELECT * FROM document_revisions ORDER BY document_id, seq').all(), revisions);
    assert.match(String(migrated.prepare("SELECT sql FROM sqlite_schema WHERE name = 'tasks'").get()?.sql), /sleeping/);
    assert.equal(migrated.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); migrated.close();
    assert.deepEqual(await reader.search(taskSearchInput('migration needle')), before);

    const executor = { run: async () => { throw new Error('Must not replay an external side effect'); }, answer: async () => {}, steer: async () => {} };
    engine = await new Engine(directory, executor).open();
    assert.equal((await engine.snapshot()).memories[0]?.text, 'synthetic persisted delta');
    await engine.mutate(state => { state.tasks[0].messages![0].text = 'migration updated needle'; });
    await engine.close(); engine = undefined;
    engine = await new Engine(directory, executor).open();
    assert.equal((await engine.taskSearch.search(taskSearchInput('updated needle'))).matches[0]?.taskId, 'legacy');
    assert.equal((await engine.snapshot()).tasks[0].status, 'completed');
  } finally {
    await engine?.close(); await reader.close(); await rm(directory, { recursive: true, force: true });
  }
});
