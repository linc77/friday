import type { CDPSession } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { browserID, HostBrowserError } from './task-host-browser-protocol.js';
import { hostAnnotationContextSource, hostAnnotationElementSource, hostAnnotationPickerSource } from './task-host-browser-annotation-source.js';

type Scope = { id: string; viewer: string; device: string; document: string; control: number; current: () => boolean };
type Lease = Scope & { context?: number; frozen: boolean };
/** One controller owns a transient picker. Its DOM and snapshots never enter shared tab state. */
export class HostBrowserAnnotations {
  private active?: Lease;
  private stopped = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private queued = 0;
  private readonly world = 'friday-annotation-' + randomUUID();
  constructor(private readonly cdp: CDPSession) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.catch(() => {}).then(operation); this.tail = result; return result;
  }
  private check(lease: Lease) {
    if (this.closed || this.active !== lease || !lease.current()) throw new HostBrowserError('网页或批注控制权已变化，请重新选择', 409);
  }
  private async evaluate(lease: Lease, expression: string, main = false) {
    this.check(lease);
    const response = await this.cdp.send('Runtime.evaluate', { ...(main ? {} : { contextId: lease.context }), expression, returnByValue: true, awaitPromise: true, timeout: 6500 });
    this.check(lease);
    if (response.exceptionDetails) throw new HostBrowserError('网页批注暂不可用，请重新选择', 409);
    const value = response.result?.value;
    if (typeof value === 'string' && Buffer.byteLength(value) > 4 * 1024 * 1024) throw new HostBrowserError('网页批注过大');
    return value ?? null;
  }
  async start(scope: Scope) {
    browserID(scope.id, '批注');
    if (this.closed || !scope.current() || this.stopped.has(scope.id)) throw new HostBrowserError('批注已结束，请重新选择', 409);
    const previous = this.active;
    if (previous) {
      if (previous.id === scope.id && previous.viewer === scope.viewer && previous.device === scope.device && previous.document === scope.document && previous.control === scope.control) return this.call(scope, 'read', {});
      throw new HostBrowserError('这个网页已有批注，请先结束本次选择', 409);
    }
    const lease: Lease = { ...scope, frozen: false }; this.active = lease;
    return this.enqueue(async () => {
      try {
        this.check(lease);
        const tree = await this.cdp.send('Page.getFrameTree'); this.check(lease);
        const world = await this.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: this.world });
        lease.context = world.executionContextId; this.check(lease);
        return await this.evaluate(lease, hostAnnotationPickerSource + `\nglobalThis.FridayHostAnnotationMessage=null;FridayBrowserPicker.start(${JSON.stringify(lease.id)},'#5689f5',value=>{globalThis.FridayHostAnnotationMessage=JSON.stringify(value);});globalThis.FridayHostAnnotationMessage;`);
      } catch (error) {
        if (this.active === lease) this.active = undefined;
        this.remember(lease.id); await this.cleanup(lease); throw error;
      }
    });
  }
  async call(scope: Scope, action: string, raw: Record<string, unknown>) {
    if (this.queued >= 128) throw new HostBrowserError('批注操作过多，请等待页面响应', 429);
    const lease = this.active;
    if (!lease || lease.id !== scope.id || lease.viewer !== scope.viewer || lease.device !== scope.device || lease.document !== scope.document || lease.control !== scope.control) throw new HostBrowserError('批注不属于这个查看连接', 409);
    const id = JSON.stringify(lease.id);
    let expression: string;
    if (action === 'read') expression = '(()=>{const value=globalThis.FridayHostAnnotationMessage;globalThis.FridayHostAnnotationMessage=null;return value;})()';
    else if (action === 'tool' && typeof raw.tool === 'string' && ['select', 'marquee', 'draw', 'erase'].includes(raw.tool)) expression = `FridayBrowserPicker.tool(${id},${JSON.stringify(raw.tool)});JSON.stringify(FridayBrowserPicker.snapshot());`;
    else if (action === 'style' && typeof raw.property === 'string' && raw.property.length <= 80 && typeof raw.value === 'string' && raw.value.length <= 2048) expression = `if(!FridayBrowserPicker.style(${id},${JSON.stringify(raw.property)},${JSON.stringify(raw.value)}))throw new Error('style');JSON.stringify(FridayBrowserPicker.snapshot());`;
    else if (action === 'freeze' && typeof raw.value === 'boolean') expression = `JSON.stringify(FridayBrowserPicker.freeze(${id},${JSON.stringify(raw.value)}));`;
    else if (action === 'elements') expression = 'JSON.stringify(FridayBrowserPicker.snapshot());';
    else throw new HostBrowserError('网页批注操作无效');
    this.queued++;
    return this.enqueue(async () => {
      this.check(lease);
      const value = await this.evaluate(lease, expression);
      if (action === 'freeze') lease.frozen = raw.value === true;
      if (action !== 'elements') return value;
      if (!lease.frozen) throw new HostBrowserError('请先确认本次批注', 409);
      let snapshot: any; try { snapshot = typeof value === 'string' ? JSON.parse(value) : null; } catch {}
      if (!snapshot || snapshot.nonce !== lease.id || !Array.isArray(snapshot.elements) || snapshot.elements.length > 50 || typeof snapshot.pageUrl !== 'string') throw new HostBrowserError('所选元素已不可用', 409);
      const fallback = snapshot.elements.map((entry: any) => entry.element);
      if (!fallback.length) return '[]';
      // Only this fixed read enters the main world. The client cannot supply code, selectors or fallback HTML.
      try {
        const details = await this.evaluate(lease, hostAnnotationElementSource + '\n' + hostAnnotationContextSource + `\nFridayBrowserAnnotationContext(${JSON.stringify(snapshot.elements.map((entry: any) => entry.id))},${JSON.stringify(fallback)},${JSON.stringify(snapshot.pageUrl)});`, true);
        if (typeof details === 'string' && Buffer.byteLength(details) <= 2 * 1024 * 1024) { const parsed = JSON.parse(details); if (Array.isArray(parsed) && parsed.length === fallback.length) return details; }
      } catch { this.check(lease); }
      return JSON.stringify(fallback);
    }).finally(() => { this.queued--; });
  }
  private remember(id: string) { this.stopped.add(id); if (this.stopped.size > 2048) this.stopped.delete(this.stopped.values().next().value!); }
  private async cleanup(lease: Lease) {
    if (lease.context === undefined) return;
    await this.cdp.send('Runtime.evaluate', { contextId: lease.context, expression: `globalThis.FridayBrowserPicker?.stop(${JSON.stringify(lease.id)});globalThis.FridayHostAnnotationMessage=null;`, returnByValue: true, timeout: 1500 }).catch(() => {});
  }
  async stop(idValue: unknown, viewer: string, device: string) {
    const id = browserID(idValue, '批注'), lease = this.active;
    if (lease?.id === id && (lease.viewer !== viewer || lease.device !== device)) throw new HostBrowserError('批注不属于这个查看连接', 409);
    this.remember(id);
    if (lease?.id !== id) return;
    this.active = undefined; await this.enqueue(() => this.cleanup(lease));
  }
  invalidate(viewer?: string, device?: string) {
    const lease = this.active;
    if (!lease || viewer !== undefined && (lease.viewer !== viewer || lease.device !== device)) return;
    this.active = undefined; this.remember(lease.id); void this.enqueue(() => this.cleanup(lease)).catch(() => {});
  }
  async close() { this.closed = true; this.invalidate(); await this.tail.catch(() => {}); }
}
