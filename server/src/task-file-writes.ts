import { createHash } from 'node:crypto';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { TaskContextScope } from './task-context-types.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Saved = { status: 'saved'; requestId: string; path: string; version: string; workspaceVersion: string; byteLength: number };
type Outcome = Saved | { status: 'unconfirmed' | 'superseded' | 'missing'; requestId: string; error?: string };
type Intent = { requestId: string; digest: string; workspaceVersion: string; target: string; path: string; contentsHash: string; editorId: string; revision: number; result?: Saved; error?: string };
const Receipt = defineDocFamily<{ intent?: Intent }, { id: string }>({ kind: 'friday.file_write_receipt', version: 1, scope: 'session', family: true, initial: () => ({}) });
const Stream = defineDocFamily<{ revision: number; requestId?: string }, { id: string }>({ kind: 'friday.file_editor_revision', version: 1, scope: 'session', family: true, initial: () => ({ revision: 0 }) });

/** Direct editor saves use Pi Durable receipts, outside the task transcript.
 * A receipt with no result is inspected against the file; it is never replayed.
 * Fresh user edits preserve T3's last-write semantics, with per-editor ordering.
 */
export class TaskFileWrites {
  private readonly requests = new Map<string, Promise<Outcome>>();
  private readonly files = new Map<string, Promise<unknown>>();
  private readonly active = new Set<Promise<unknown>>();
  private stopping = false;
  constructor(private readonly engine: Engine) {}
  async save(input: { requestId: unknown; scope: unknown; path: unknown; contents: unknown; workspaceVersion: unknown; editorId: unknown; revision: unknown }): Promise<Outcome> {
    if (this.stopping) throw new Error('服务正在停止，请稍后重试保存');
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId) || typeof input.editorId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.editorId) || !Number.isSafeInteger(input.revision) || Number(input.revision) < 1 || typeof input.contents !== 'string' || input.contents.includes('\0') || Buffer.byteLength(input.contents) > 1024 * 1024 || typeof input.workspaceVersion !== 'string' || !/^[a-f0-9]{64}$/.test(input.workspaceVersion)) throw new Error('文件保存参数无效，文件最多 1 MiB');
    const operation = this.saveValidated(input as Parameters<TaskFileWrites['saveValidated']>[0]); this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }
  private async saveValidated(input: { requestId: string; scope: unknown; path: unknown; contents: string; workspaceVersion: string; editorId: string; revision: number }): Promise<Outcome> {
    const id = input.requestId, existing = this.requests.get(id);
    // A duplicate request must still have its own body checked against the receipt.
    if (existing) await existing.catch(() => {});
    const operation = this.perform(input); this.requests.set(id, operation);
    try { return await operation; } finally { if (this.requests.get(id) === operation) this.requests.delete(id); }
  }
  private async perform(input: { requestId: string; scope: unknown; path: unknown; contents: string; workspaceVersion: string; editorId: string; revision: number }): Promise<Outcome> {
    const owner = await this.engine.contexts.owner(input.scope), target = await owner.files.writeTarget(input.path);
    if (target.workspaceVersion !== input.workspaceVersion) throw new Error('文件所属工作区已改变，请重新读取');
    const contentsHash = sha(input.contents), digest = sha(JSON.stringify([target.workspaceVersion, target.target, target.path, contentsHash, input.editorId, input.revision]));
    const key = sha(input.requestId), fileKey = sha(target.workspaceVersion + '\0' + target.target), streamKey = sha(fileKey + '\0' + input.editorId);
    const predecessor = this.files.get(fileKey);
    const operation = (async () => {
      await predecessor?.catch(() => {});
      let receipt: Intent | undefined, superseded = false;
      await this.engine.root.commit(async tx => {
        const record = await tx.doc(Receipt, key, { id: key });
        if (record.intent) { if (record.intent.digest !== digest) throw new Error('保存请求 ID 已用于其他编辑'); receipt = JSON.parse(JSON.stringify(record.intent)); return; }
        const stream = await tx.doc(Stream, streamKey, { id: streamKey });
        if (input.revision <= stream.revision) { superseded = true; return; }
        stream.revision = input.revision; stream.requestId = input.requestId;
        record.intent = { requestId: input.requestId, digest, workspaceVersion: target.workspaceVersion, target: target.target, path: target.path, contentsHash, editorId: input.editorId, revision: input.revision };
      }, context);
      if (superseded) return { status: 'superseded', requestId: input.requestId } as Outcome;
      if (receipt) return this.inspect(owner.files, key, receipt);
      try {
        const saved = await owner.files.writeContents(target.path, input.contents, target);
        const result: Saved = { status: 'saved', requestId: input.requestId, path: target.path, version: saved.version, workspaceVersion: saved.workspaceVersion, byteLength: Buffer.byteLength(input.contents) };
        if (saved.contents === undefined || saved.truncated || sha(saved.contents) !== contentsHash) throw new Error('文件在保存后又发生变化，请核对');
        await this.engine.root.commit(async tx => { const value = await tx.doc(Receipt, key, { id: key }); if (value.intent?.digest === digest) value.intent.result = result; }, context);
        return result;
      } catch (error) {
        await this.engine.root.commit(async tx => { const value = await tx.doc(Receipt, key, { id: key }); if (value.intent?.digest === digest) value.intent.error = (error as Error).message; }, context);
        return { status: 'unconfirmed', requestId: input.requestId, error: '保存结果待确认，编辑内容已保留' } as Outcome;
      }
    })();
    this.files.set(fileKey, operation);
    try { return await operation; } finally { if (this.files.get(fileKey) === operation) this.files.delete(fileKey); }
  }
  private async inspect(files: Awaited<ReturnType<Engine['contexts']['owner']>>['files'], key: string, receipt: Intent): Promise<Outcome> {
    if (receipt.result) return receipt.result;
    try {
      const target = await files.writeTarget(receipt.path);
      if (target.target !== receipt.target || target.workspaceVersion !== receipt.workspaceVersion) throw new Error();
      const document = await files.preview(receipt.path);
      if (document.contents === undefined || document.truncated || sha(document.contents) !== receipt.contentsHash) throw new Error();
      const result: Saved = { status: 'saved', requestId: receipt.requestId, path: receipt.path, version: document.version, workspaceVersion: document.workspaceVersion, byteLength: Buffer.byteLength(document.contents) };
      await this.engine.root.commit(async tx => { const value = await tx.doc(Receipt, key, { id: key }); if (value.intent?.digest === receipt.digest) value.intent.result = result; }, context);
      return result;
    } catch { return { status: 'unconfirmed', requestId: receipt.requestId, error: '保存结果待确认，编辑内容已保留' }; }
  }
  async status(requestId: string, scope: TaskContextScope): Promise<Outcome> {
    if (this.stopping) throw new Error('服务正在停止，请稍后核对保存结果');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) throw new Error('保存请求 ID 无效');
    const operation = this.inspectRequest(requestId, scope); this.active.add(operation);
    try { return await operation; } finally { this.active.delete(operation); }
  }
  private async inspectRequest(requestId: string, scope: TaskContextScope): Promise<Outcome> {
    const owner = await this.engine.contexts.owner(scope), live = this.requests.get(requestId); if (live) await live.catch(() => {});
    const key = sha(requestId), value = await this.engine.harness.snapshot(Receipt, key, context);
    if (!value?.intent) return { status: 'missing', requestId };
    if (await owner.files.workspaceVersion() !== value.intent.workspaceVersion) throw new Error('保存请求不属于当前工作区');
    return this.inspect(owner.files, key, value.intent);
  }
  async close() { this.stopping = true; await Promise.allSettled([...this.active]); }
}
