import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { apply } from '@earendil-works/chord/delta';

// Read-only projection of the pinned Pi Durable 1.0.2 SQLite schema (v1).
// Materialization follows SqliteStorage.materializeDocument: latest base plus
// ordered Chord deltas in ONE read transaction. Fail closed on schema changes;
// never initialize/migrate storage or open a second execution Harness here.
const db = new DatabaseSync(workerData.file, { readOnly: true, timeout: 1000 });
db.exec('PRAGMA query_only = ON');
const cache = new Map();
let cacheBytes = 0;
const sha = text => createHash('sha256').update(text).digest('hex');
const fold = text => text.replace(/[A-Z]/g, character => character.toLowerCase());
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const epoch = task => sha(JSON.stringify([task.id, [...(task.rewindOperations ?? []), ...(task.rewindOperation ? [task.rewindOperation] : [])]
  .filter(op => op.projectedAt).map(op => [op.id, op.projectedAt]), task.forkOperation?.projectedAt ?? null, task.forkOperation?.projectedStrategy ?? null, ...(task.nativeHistory?.epoch ? [task.nativeHistory.epoch] : [])]));
const active = new Set(['queued', 'running', 'waiting', 'needs_project']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

function document(kind, key) {
  const record = db.prepare(`SELECT id FROM documents WHERE kind = ? AND scope_kind = 'session' AND owner_id = 0 AND family = ? AND key_value = ?
    AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(JSON.stringify(kind), key === undefined ? 0 : 1, JSON.stringify(key ?? ''));
  if (!record) return undefined;
  const base = db.prepare("SELECT seq, version, content FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(record.id);
  if (!base || base.version !== 1) throw new Error('Unsupported document version');
  const tip = db.prepare('SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = ?').get(record.id).seq;
  const cached = cache.get(record.id);
  const reusable = cached && cached.base === base.seq && cached.seq <= tip;
  let value = reusable ? cached.value : JSON.parse(base.content);
  let sequence = reusable ? cached.seq : base.seq;
  for (const delta of db.prepare('SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq').iterate(record.id, sequence)) {
    if (delta.kind !== 'delta' || delta.version !== base.version) throw new Error('Unsupported document delta');
    value = apply(value, JSON.parse(delta.content)); sequence = delta.seq;
  }
  if (!reusable || cached.seq !== sequence) {
    if (cached) { cacheBytes -= cached.bytes; cache.delete(record.id); }
    const bytes = kind === 'friday.workspace' ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8');
    if (kind === 'friday.workspace') for (const [id, saved] of cache) if (saved.root && id !== record.id) { cacheBytes -= saved.bytes; cache.delete(id); }
    if (bytes <= 1024 * 1024) { cache.set(record.id, { base: base.seq, seq: sequence, value, bytes, root: kind === 'friday.workspace' }); cacheBytes += bytes; }
  }
  // Keep the root plus a bounded set of small cold pages. Large tool-output
  // pages are never retained by the search reader.
  while (cache.size > 65 || cacheBytes > 8 * 1024 * 1024) {
    const victim = [...cache.keys()].find(id => cache.get(id).bytes > 0);
    if (victim === undefined) break;
    cacheBytes -= cache.get(victim).bytes; cache.delete(victim);
  }
  return value;
}

function snippet(text, query) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 240) return normalized;
  const match = fold(normalized).indexOf(fold(query.replace(/\s+/g, ' ').trim()));
  let start = Math.min(Math.max(0, match - 72), normalized.length - 236);
  if (start > 0 && /[\uDC00-\uDFFF]/.test(normalized[start]) && /[\uD800-\uDBFF]/.test(normalized[start - 1])) start--;
  let end = Math.min(normalized.length, start + 236);
  if (end < normalized.length && /[\uD800-\uDBFF]/.test(normalized[end - 1])) end--;
  return (start ? '…' : '') + normalized.slice(start, end) + (end < normalized.length ? '…' : '');
}

function eventVisible(task, event, runs) {
  const run = runs.get(event.runId);
  if (event.revertedAt || run?.revertedAt || run?.executionExcludedAt) return false;
  for (const op of [...(task.rewindOperations ?? []), ...(task.rewindOperation ? [task.rewindOperation] : [])]) {
    if (!op.projectedAt) continue;
    if (event.runId && [...op.removedRunIds, ...(op.removedExecutionRunIds ?? [])].includes(event.runId) || event.turnId && op.removeTurns.includes(event.turnId)) return false;
    const from = task.messages?.find(message => message.id === op.messageId)?.at;
    if (!event.runId && !event.turnId && from && event.at >= from && event.at <= op.projectedAt) return false;
  }
  return event.status !== 'running' || terminal.has(run?.status);
}

function search(input) {
  if (db.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get()?.version !== 1) throw new Error('Unsupported Durable schema');
  const workspace = document('friday.workspace') ?? { revision: 0, projects: [], tasks: [] };
  const projects = new Set(workspace.projects.map(project => project.id));
  const query = fold(input.query); const matches = [];
  for (const task of workspace.tasks) {
    if (!['codex', 'claude'].includes(task.agent) || task.archivedAt || task.projectId && !projects.has(task.projectId)) continue;
    const runs = new Map((task.runs ?? []).map(run => [run.id, run])); let best;
    const consider = (id, source, text, at) => {
      if (typeof text !== 'string') throw new Error('Invalid searchable message');
      if (!fold(text).includes(query)) return;
      const candidate = { id, source, text, at };
      if (!best || source === 'user' && best.source !== 'user' || source === best.source && (date(at) > date(best.at) || date(at) === date(best.at) && cmp(id, best.id) < 0)) best = candidate;
    };
    for (const message of task.messages ?? []) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      const run = runs.get(message.runId);
      if (message.revertedAt || run?.revertedAt || message.role === 'assistant' && run?.executionExcludedAt) continue;
      consider(message.id, message.role, message.text, message.at);
    }
    if (!Array.isArray(task.messages)) consider('legacy-user', 'user', task.prompt, task.createdAt);
    if (best?.source !== 'user') {
      const live = new Map(task.events.map(event => [event.id, event]));
      const accept = event => {
        if (event.kind === 'message' && eventVisible(task, event, runs)) consider(event.id, 'assistant', event.text, event.at);
      };
      for (let index = 0; index * 128 < (task.eventArchive?.count ?? 0); index++) {
        const page = document('friday.task_history_page', sha(task.id) + ':' + index);
        if (!page || page.taskId !== task.id || page.page !== index) throw new Error('Invalid archived history');
        const count = Math.min(128, task.eventArchive.count - index * 128);
        if (page.events.length < count) throw new Error('Incomplete archived history');
        for (const event of page.events.slice(0, count)) if (!live.has(event.id)) accept(event);
      }
      for (const event of live.values()) accept(event);
      if (!active.has(task.status) && task.result && !(task.messages ?? []).some(message => !message.revertedAt && message.role === 'assistant' && message.text === task.result)) consider('legacy-result', 'assistant', task.result, undefined);
    }
    if (best) matches.push({ taskId: task.id, projectId: task.projectId ?? null, epoch: epoch(task), source: best.source, snippet: snippet(best.text, input.query),
      messageCreatedAt: date(best.at) ? new Date(date(best.at)).toISOString() : null, updated: date(task.updatedAt) });
  }
  matches.sort((a, b) => (a.source === b.source ? 0 : a.source === 'user' ? -1 : 1) || b.updated - a.updated || cmp(a.taskId, b.taskId));
  return { query: input.query, sequence: workspace.revision, matches: matches.slice(0, input.limit).map(({ updated: _, ...match }) => match) };
}

parentPort.on('message', ({ id, input }) => {
  try {
    db.exec('BEGIN'); const result = search(input); db.exec('COMMIT'); parentPort.postMessage({ id, result });
  } catch {
    try { db.exec('ROLLBACK'); } catch {}
    cache.clear(); cacheBytes = 0; parentPort.postMessage({ id, error: true });
  }
});
