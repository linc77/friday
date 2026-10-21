/*
Adapted from T3 Code 8cd9641f PullRequestReadCache.ts.
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SourceControlRepository } from './task-change-requests.js';

export const changeRequestReadScope = (r: Pick<SourceControlRepository, 'provider' | 'host' | 'path'>, number: number) => JSON.stringify([r.provider, r.host.toLowerCase(), r.path.toLowerCase(), number]);

type Revision = { revision: string; expiresAt: number };
export type SourceControlStoredRead = { payload: string; revision: string; expiresAt: number; writtenAt: number };
export interface SourceControlReadStorage {
  get(key: string): SourceControlStoredRead | undefined;
  set(key: string, value: SourceControlStoredRead): void;
  revision(scope: string): Revision | undefined;
  invalidate(scope: string, value: Revision): void;
  prune(cutoff: number): void;
  close(): void;
}
export class SQLiteSourceControlReadStorage implements SourceControlReadStorage {
  #database?: DatabaseSync;
  #closed = false;
  constructor(readonly directory: string) {}
  private db() {
    if (this.#closed) throw new Error('PR 读取缓存已关闭'); if (this.#database) return this.#database;
    const file = join(this.directory, 'source-control-reads.sqlite');
    try { const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('PR 缓存文件无效'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); db.exec('CREATE TABLE IF NOT EXISTS pr_reads (key TEXT PRIMARY KEY,payload TEXT NOT NULL,revision TEXT NOT NULL,expires_at INTEGER NOT NULL,written_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS pr_read_revisions (scope TEXT PRIMARY KEY,revision TEXT NOT NULL,expires_at INTEGER NOT NULL)'); }
    catch (error) { db.close(); throw error; }
    this.#database = db; return db;
  }
  get(key: string) { return this.db().prepare('SELECT payload,revision,expires_at AS expiresAt,written_at AS writtenAt FROM pr_reads WHERE key=?').get(key) as SourceControlStoredRead | undefined; }
  set(key: string, value: SourceControlStoredRead) { this.db().prepare('INSERT OR REPLACE INTO pr_reads VALUES(?,?,?,?,?)').run(key, value.payload, value.revision, value.expiresAt, value.writtenAt); }
  revision(scope: string) { return this.db().prepare('SELECT revision,expires_at AS expiresAt FROM pr_read_revisions WHERE scope=?').get(scope) as Revision | undefined; }
  invalidate(scope: string, value: Revision) { const db = this.db(); db.prepare('DELETE FROM pr_read_revisions WHERE expires_at<=?').run(value.expiresAt - 60_000); db.prepare('INSERT OR REPLACE INTO pr_read_revisions VALUES(?,?,?)').run(scope, value.revision, value.expiresAt); }
  prune(cutoff: number) { this.db().prepare('DELETE FROM pr_reads WHERE written_at<?').run(cutoff); this.db().prepare('DELETE FROM pr_read_revisions WHERE expires_at<?').run(cutoff); }
  close() { this.#closed = true; this.#database?.close(); this.#database = undefined; }
}
type Entry = { value: unknown; revision: string; expiresAt: number; scopes: string[]; bucket: string };
type Flight = { controller: AbortController; promise: Promise<unknown>; users: number };
type ReadOptions<T> = { scopes?: string[]; signal?: AbortSignal; ttl?: number | ((value: T) => number); cacheable?: (value: T) => boolean; bucket?: string; capacity?: number; persist?: boolean; decode?: (value: unknown) => T | undefined };
const digest = (key: string) => createHash('sha256').update(key).digest('hex');
const sameRevision = (current: string, stored: string) => current.split(':').every((value, index) => !value || stored.split(':')[index] === value);

class ReadGate {
  #available = 512;
  readonly #queue: { count: number; start: () => void }[] = [];
  take(count: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const job = { count, start: () => {
        signal.removeEventListener('abort', abort); this.#available -= count; let released = false;
        resolve(() => { if (released) return; released = true; this.#available += count; this.drain(); });
      } };
      const abort = () => { const index = this.#queue.indexOf(job); if (index >= 0) this.#queue.splice(index, 1); signal.removeEventListener('abort', abort); reject(signal.reason); this.drain(); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); return; }
      this.#queue.push(job); this.drain();
    });
  }
  private drain() { while (this.#queue[0] && this.#queue[0].count <= this.#available) this.#queue.shift()!.start(); }
}

/** Response data stays out of the workspace projection. Private disk entries
 * contain only explicitly decoded read models; errors are never cached. */
export class SourceControlReadCache {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Flight>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #requests = new Set<Promise<unknown>>();
  readonly #gate = new ReadGate();
  readonly #lifetime = new AbortController();
  readonly #revisions = new Map<string, Revision>();
  #storage?: SourceControlReadStorage;
  #enabled = true;
  #closed = false;
  #prune?: NodeJS.Timeout;
  constructor(storage?: SourceControlReadStorage, readonly now: () => number = Date.now) { this.#storage = storage; }
  private revision(scopes: string[]): string {
    return scopes.map(scope => { const value = this.#storage?.revision(scope) ?? this.#revisions.get(scope); return value && value.expiresAt > this.now() ? value.revision : ''; }).join(':');
  }
  private disableStorage() { try { this.#storage?.close(); } catch {} this.#storage = undefined; }
  start() { if (!this.#storage || this.#closed || this.#prune) return; this.prune(); this.#prune = setInterval(() => this.prune(), 60 * 60_000); this.#prune.unref(); }
  private remember(key: string, value: Entry, capacity: number) {
    this.#entries.delete(key); this.#entries.set(key, value);
    let count = [...this.#entries.values()].filter(entry => entry.bucket === value.bucket).length;
    for (const [entryKey, entry] of this.#entries) if (entry.bucket === value.bucket && count > capacity) { this.#entries.delete(entryKey); count--; }
    while (this.#entries.size > 512) this.#entries.delete(this.#entries.keys().next().value!);
  }
  private store<T>(key: string, value: T, revision: string, scopes: string[], options: ReadOptions<T>) {
    if (!this.#enabled || this.#closed || options.cacheable?.(value) === false) return;
    const ttl = typeof options.ttl === 'function' ? options.ttl(value) : options.ttl ?? 60_000;
    if (!Number.isFinite(ttl) || ttl < 0) return;
    const expiresAt = this.now() + ttl, bucket = options.bucket ?? 'reads';
    this.remember(key, { value: structuredClone(value), revision, expiresAt, scopes, bucket }, options.capacity ?? 128);
    if (options.persist && options.decode && this.#storage) {
      try {
        const payload = JSON.stringify(value);
        if (Buffer.byteLength(payload) <= 2 * 1024 * 1024) this.#storage.set(key, { payload, revision, expiresAt: this.now() + 60_000, writtenAt: this.now() });
        this.start();
      } catch { this.disableStorage(); }
    }
  }
  private join<T>(flight: Flight, signal?: AbortSignal): Promise<T> {
    flight.users++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const leave = () => { if (finished) return false; finished = true; signal?.removeEventListener('abort', abort); flight.users--; return true; };
      const abort = () => { if (!leave()) return; if (!flight.users) flight.controller.abort(signal?.reason); reject(signal?.reason); };
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) { abort(); return; }
      void flight.promise.then(value => { if (leave()) resolve(structuredClone(value) as T); }, error => { if (leave()) reject(error); });
    });
  }
  get<T>(key: string, lookup: (signal: AbortSignal) => Promise<T>, options: ReadOptions<T> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('PR 读取缓存已关闭'));
    const signal = AbortSignal.any([this.#lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    const run = (async () => { const release = await this.#gate.take(1, signal); try { return await this.getLocked(key, lookup, { ...options, signal }); } finally { release(); } })();
    this.#requests.add(run); void run.finally(() => this.#requests.delete(run)).catch(() => {}); return run;
  }
  private getLocked<T>(key: string, lookup: (signal: AbortSignal) => Promise<T>, options: ReadOptions<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('PR 读取缓存已关闭')); if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const hash = digest(key), scopes = ['global', ...(options.scopes ?? [])].map(digest); let revision = '';
    if (this.#enabled) {
      try { revision = this.revision(scopes); } catch { this.disableStorage(); revision = this.revision(scopes); }
      const held = this.#entries.get(hash);
      if (held && held.expiresAt > this.now() && sameRevision(revision, held.revision)) return Promise.resolve(structuredClone(held.value) as T);
      if (options.persist && options.decode && this.#storage) {
        try {
          const stored = this.#storage.get(hash);
          if (stored && stored.expiresAt > this.now() && sameRevision(revision, stored.revision)) {
            const value = options.decode(JSON.parse(stored.payload));
            if (value !== undefined) { this.remember(hash, { value, expiresAt: stored.expiresAt, revision: stored.revision, scopes, bucket: options.bucket ?? 'reads' }, options.capacity ?? 128); this.start(); return Promise.resolve(structuredClone(value)); }
          }
        } catch { this.disableStorage(); }
      }
    }
    const flightKey = this.#enabled ? hash + '\0' + revision : randomUUID(), previous = this.#flights.get(flightKey);
    if (previous && !previous.controller.signal.aborted) return this.join<T>(previous, options.signal);
    const controller = new AbortController(), flight: Flight = { controller, users: 0, promise: Promise.resolve() };
    flight.promise = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted(); const result = await lookup(controller.signal); controller.signal.throwIfAborted();
      try { if (this.#enabled && sameRevision(this.revision(scopes), revision)) this.store(hash, result, revision, scopes, options); } catch { this.disableStorage(); }
      return result;
    });
    this.#flights.set(flightKey, flight); this.#pending.add(flight.promise);
    void flight.promise.finally(() => { if (this.#flights.get(flightKey) === flight) this.#flights.delete(flightKey); this.#pending.delete(flight.promise); }).catch(() => {});
    return this.join<T>(flight, options.signal);
  }
  async invalidate(scope: string) {
    if (this.#closed) return;
    let release: (() => void) | undefined;
    try {
      release = await this.#gate.take(512, this.#lifetime.signal);
      const hash = digest(scope), now = this.now(), value = { revision: randomUUID(), expiresAt: now + 60_000 };
      for (const [key, held] of this.#revisions) if (held.expiresAt <= now) this.#revisions.delete(key);
      this.#revisions.set(hash, value);
      for (const [key, entry] of this.#entries) if (entry.scopes.includes(hash)) this.#entries.delete(key);
      this.#storage?.invalidate(hash, value);
    } catch { if (!this.#closed) { this.#enabled = false; this.#entries.clear(); this.disableStorage(); } }
    finally { release?.(); }
  }
  prune() { try { this.#storage?.prune(this.now() - 24 * 60 * 60_000); } catch {} }
  async close() { this.#closed = true; clearInterval(this.#prune); this.#lifetime.abort(new Error('PR 读取缓存已关闭')); for (const flight of this.#flights.values()) flight.controller.abort(this.#lifetime.signal.reason); await Promise.allSettled([...this.#pending, ...this.#requests]); this.#entries.clear(); this.#revisions.clear(); this.disableStorage(); }
}
