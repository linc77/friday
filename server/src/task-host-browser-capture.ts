import type { CDPSession } from 'playwright-core';
import { HostBrowserError, browserID, type HostBrowserSettings } from './task-host-browser-protocol.js';
import { hostRecordingInputSource } from './task-host-browser-recording-input.js';

export function hostBrowserLayout(settings: HostBrowserSettings) {
  return { width: Math.max(1, Math.round(settings.width / settings.zoom)), height: Math.max(1, Math.round(settings.height / settings.zoom)) };
}
export interface HostRecordingInput { nonce: string; document: string; type: string; width: number; height: number; x?: number; y?: number; phase?: string; label?: string | null; held?: boolean }
type Lease = { id: string; viewer: string; device: string; keys: boolean; world: string; script?: string; prepared: Promise<void>; baseline: number };
/** Isolated, bounded input queues belong only to explicitly started recording leases. */
export class HostBrowserCaptures {
  private leases = new Map<string, Lease>();
  private stopped = new Set<string>();
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private pauses = 0;
  get recording() { return this.leases.size > 0; }
  get paused() { return this.pauses > 0; }
  constructor(private readonly cdp: CDPSession, private readonly refreshStream: () => Promise<void>, private readonly document: () => string, private readonly sequence = () => 0) {}
  async start(idValue: unknown, viewer: string, device: string, keys: unknown) {
    const id = browserID(idValue, '录屏');
    if (this.closed || this.stopped.has(id)) throw new HostBrowserError('这次录屏已结束，请重新开始', 409);
    if (typeof keys !== 'boolean') throw new HostBrowserError('录屏设置无效');
    const previous = this.leases.get(id);
    if (previous) { if (previous.viewer !== viewer || previous.device !== device || previous.keys !== keys) throw new HostBrowserError('录屏标识已用于其他内容', 409); await previous.prepared; return previous.baseline; }
    if ([...this.leases.values()].some(lease => lease.viewer === viewer)) throw new HostBrowserError('这个页面已在录屏', 409);
    const lease: Lease = { id, viewer, device, keys, world: 'friday-recording-' + id, prepared: Promise.resolve(), baseline: this.sequence() };
    this.leases.set(id, lease);
    lease.prepared = (async () => {
      const bridge = `if(window===top){globalThis.FridayHostRecordingQueue=[];globalThis.FridayHostRecordingDrain=()=>globalThis.FridayHostRecordingQueue.splice(0);` + hostRecordingInputSource + `\nFridayBrowserRecordingInput.start(${JSON.stringify(id)},'page',${JSON.stringify(keys)},input=>{const q=globalThis.FridayHostRecordingQueue;if(input.type==='pointer'&&input.phase==='move'&&q.at(-1)?.type==='pointer'&&q.at(-1)?.phase==='move')q[q.length-1]=input;else{q.push(input);if(q.length>128)q.shift();}});}`;
      const result = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bridge, worldName: lease.world, runImmediately: true });
      lease.script = result.identifier;
      await this.refreshStream();
    })();
    try { await lease.prepared; }
    catch (error) { this.leases.delete(id); this.stopped.add(id); if (lease.script) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: lease.script }).catch(() => {}); await this.refreshStream(); throw error; }
    return lease.baseline;
  }
  async stop(idValue: unknown, viewer: string, device: string) {
    const id = browserID(idValue, '录屏'), lease = this.leases.get(id);
    if (lease && (lease.viewer !== viewer || lease.device !== device)) throw new HostBrowserError('录屏不属于这个查看连接', 409);
    this.stopped.add(id);
    if (this.stopped.size > 2048) this.stopped.delete(this.stopped.values().next().value!);
    if (!lease) return;
    await lease.prepared.catch(() => {}); if (this.leases.get(id) !== lease) return; this.leases.delete(id);
    if (lease.script) await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: lease.script }).catch(() => {});
    try {
      const tree = await this.cdp.send('Page.getFrameTree');
      const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: lease.world });
      await this.cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: `globalThis.FridayBrowserRecordingInput?.stop(${JSON.stringify(id)});globalThis.FridayHostRecordingQueue=[];` });
    } catch {}
    await this.refreshStream();
  }
  async inputs(viewer: string, device: string): Promise<HostRecordingInput[]> {
    const doc = this.document(), values: HostRecordingInput[] = [];
    for (const lease of this.leases.values()) {
      if (lease.viewer !== viewer || lease.device !== device) continue;
      try {
        const tree = await this.cdp.send('Page.getFrameTree');
        const { executionContextId } = await this.cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: lease.world });
        const { result } = await this.cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: 'globalThis.FridayHostRecordingDrain?.() ?? []', returnByValue: true });
        if (this.closed || this.document() !== doc || !this.leases.has(lease.id) || !Array.isArray(result.value)) continue;
        for (const raw of result.value.slice(-128)) {
          if (!raw || raw.nonce !== lease.id || !['pointer', 'key', 'clear'].includes(raw.type) || JSON.stringify(raw).length > 8192) continue;
          if (raw.type === 'clear') { values.push({ nonce: lease.id, document: doc, type: 'clear', width: 0, height: 0 }); continue; }
          if (typeof raw.width !== 'number' || typeof raw.height !== 'number' || !Number.isFinite(raw.width) || !Number.isFinite(raw.height) || raw.width <= 0 || raw.height <= 0 || raw.width > 100000 || raw.height > 100000) continue;
          const base = { nonce: lease.id, document: doc, type: raw.type, width: raw.width, height: raw.height };
          if (raw.type === 'pointer') {
            if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y) || Math.abs(raw.x) > 100000 || Math.abs(raw.y) > 100000 || !['move', 'down', 'up'].includes(raw.phase)) continue;
            values.push({ ...base, x: raw.x, y: raw.y, phase: raw.phase });
          } else if (lease.keys && (raw.label === null || typeof raw.label === 'string' && raw.label.length <= 160) && typeof raw.held === 'boolean') values.push({ ...base, label: raw.label, held: raw.held });
        }
      } catch {}
    }
    return values;
  }
  async screenshot(expected: string): Promise<Buffer<ArrayBuffer>> {
    const operation = this.tail.catch(() => {}).then(async () => {
      if (this.closed || this.document() !== expected) throw new HostBrowserError('网页已变化，请重新截图', 409);
      this.pauses++;
      try {
        await this.refreshStream();
        const result = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
        if (this.closed || this.document() !== expected) throw new HostBrowserError('网页已变化，请重新截图', 409);
        if (typeof result.data !== 'string' || result.data.length > Math.ceil(64 * 1024 * 1024 / 3) * 4) throw new HostBrowserError('网页截图过大');
        const data = Buffer.from(result.data, 'base64'); if (data.length < 8 || !data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new HostBrowserError('主机未返回有效的 PNG 截图');
        return data;
      } finally { this.pauses--; await this.refreshStream(); }
    });
    this.tail = operation; return operation;
  }
  async detach(viewer: string, device: string) { await Promise.allSettled([...this.leases.values()].filter(lease => lease.viewer === viewer && lease.device === device).map(lease => this.stop(lease.id, viewer, device))); }
  async close() { this.closed = true; await Promise.allSettled([...this.leases.values()].map(lease => this.stop(lease.id, lease.viewer, lease.device))); await this.tail.catch(() => {}); }
}
