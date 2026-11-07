import { createHash } from 'node:crypto';
import { normalizeBrowserURL } from './task-browser.js';
import type { HostDownload } from './task-host-browser-transfers.js';

export class HostBrowserError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 | 503 = 400) { super(message); }
}
export function browserID(value: unknown, label = '标签'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new HostBrowserError(`${label}标识无效`);
  return value;
}
export function browserProfileID(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 64 || /\p{Cc}/u.test(value)) throw new HostBrowserError('浏览配置标识无效');
  return value;
}
export interface HostBrowserSettings { width: number; height: number; mobile: boolean; zoom: number; appearance: 'light' | 'dark' | 'system' }
export function hostBrowserSettings(value: Record<string, unknown>): HostBrowserSettings {
  const width = value.width ?? 1280, height = value.height ?? 800, zoom = value.zoom ?? 1;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 240 || (width as number) > 3840 || (height as number) < 240 || (height as number) > 3840 || (width as number) * (height as number) > 3840 * 2160) throw new HostBrowserError('视口尺寸无效');
  if (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0.25 || zoom > 5) throw new HostBrowserError('网页缩放无效');
  const appearance = value.appearance ?? 'system';
  if (!['system', 'light', 'dark'].includes(appearance as string) || value.mobile !== undefined && typeof value.mobile !== 'boolean') throw new HostBrowserError('网页显示设置无效');
  return { width: width as number, height: height as number, mobile: value.mobile === true, zoom, appearance: appearance as HostBrowserSettings['appearance'] };
}
export interface HostBrowserDialog { id: string; type: string; message: string; defaultValue: string }
export interface HostBrowserChooser { id: string; multiple: boolean; accept: string; offeredTo: string | null }
export interface HostBrowserSnapshot {
  taskId: string; tabId: string; generation: string; revision: number; url: string; title: string;
  loading: boolean; back: boolean; forward: boolean; error: string | null;
  settings: HostBrowserSettings; controller: string | null; controlGeneration: number;
  dialog: HostBrowserDialog | null; popups: { tabId: string; url: string; generation?: string }[];
  chooser?: HostBrowserChooser | null; downloads?: HostDownload[];
  documentId?: string;
  /** Transient command reply only; never part of the tab or shared state stream. */
  clipboardText?: string;
}
export type HostBrowserEvent = { type: 'state'; state: HostBrowserSnapshot } | { type: 'frame'; data: string; width: number; height: number; sequence: number } | { type: 'gone' } | { type: 'heartbeat' };
/** At most one state and one newest frame wait behind a bounded in-flight write. */
export class HostBrowserMailbox {
  private state?: HostBrowserEvent;
  private frame?: HostBrowserEvent;
  private wake?: () => void;
  private ended = false;
  offer(value: HostBrowserEvent) {
    if (this.ended) return;
    if (value.type === 'heartbeat') { if (!this.state && !this.frame) this.state = value; }
    else if (value.type === 'gone') { this.ended = true; this.state = value; this.frame = undefined; }
    else if (value.type === 'frame') { if (value.data.length > 8 * 1024 * 1024) return; this.frame = value; }
    else this.state = value;
    this.wake?.();
  }
  async next(): Promise<HostBrowserEvent | null> {
    for (;;) {
      if (this.state) { const value = this.state; this.state = undefined; return value; }
      if (this.frame) { const value = this.frame; this.frame = undefined; return value; }
      if (this.ended) return null;
      await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
    }
  }
  close() { this.offer({ type: 'gone' }); }
}
export type HostBrowserAction =
  | { type: 'claim' | 'release' | 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'navigate'; url: string }
  | { type: 'settings'; value: HostBrowserSettings }
  | { type: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number; button: 'left' | 'right' | 'middle' | 'none'; buttons: number; modifiers: number; clicks: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; modifiers: number }
  | { type: 'touch'; phase: 'start' | 'move' | 'end' | 'cancel'; x: number; y: number }
  | { type: 'key'; phase: 'down' | 'up'; key: string; code: string; modifiers: number; repeat: boolean; keyCode: number }
  | { type: 'text'; text: string }
  | { type: 'edit'; command: 'copy' | 'cut' | 'selectAll' | 'undo' | 'redo' }
  | { type: 'dialog'; id: string; accept: boolean; text: string };
const integer = (value: unknown, min: number, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const finite = (value: unknown, limit: number) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
export function hostBrowserAction(raw: unknown): HostBrowserAction {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HostBrowserError('浏览器操作无效');
  const v = raw as Record<string, unknown>;
  if (['claim', 'release', 'back', 'forward', 'reload', 'stop'].includes(String(v.type))) return { type: v.type } as HostBrowserAction;
  if (v.type === 'navigate') return { type: 'navigate', url: normalizeBrowserURL(v.url) };
  if (v.type === 'settings' && v.value && typeof v.value === 'object') return { type: 'settings', value: hostBrowserSettings(v.value as Record<string, unknown>) };
  if (v.type === 'text' && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 8192 && !v.text.includes('\0')) return { type: 'text', text: v.text };
  if (v.type === 'edit' && ['copy', 'cut', 'selectAll', 'undo', 'redo'].includes(String(v.command))) return { type: 'edit', command: v.command } as HostBrowserAction;
  if (v.type === 'dialog' && typeof v.accept === 'boolean' && typeof v.text === 'string' && v.text.length <= 8192) return { type: 'dialog', id: browserID(v.id, '对话框'), accept: v.accept, text: v.text };
  if (v.type === 'pointer' && ['down', 'up', 'move'].includes(String(v.phase)) && ['left', 'right', 'middle', 'none'].includes(String(v.button)) && finite(v.x, 20000) && finite(v.y, 20000) && integer(v.buttons, 0, 31) && integer(v.modifiers, 0, 15) && integer(v.clicks, 0, 3)) return v as unknown as HostBrowserAction;
  if (v.type === 'wheel' && [v.x, v.y].every(n => finite(n, 20000)) && [v.dx, v.dy].every(n => finite(n, 10000)) && integer(v.modifiers, 0, 15)) return v as unknown as HostBrowserAction;
  if (v.type === 'touch' && ['start', 'move', 'end', 'cancel'].includes(String(v.phase)) && finite(v.x, 20000) && finite(v.y, 20000)) return { type: 'touch', phase: v.phase, x: v.x, y: v.y } as HostBrowserAction;
  if (v.type === 'key' && ['down', 'up'].includes(String(v.phase)) && typeof v.key === 'string' && v.key.length <= 80 && typeof v.code === 'string' && v.code.length <= 80 && integer(v.modifiers, 0, 15) && typeof v.repeat === 'boolean' && integer(v.keyCode, 0, 255)) return v as unknown as HostBrowserAction;
  throw new HostBrowserError('浏览器操作参数无效');
}
/** Receipt cache + monotonic viewer sequence prohibit replay even after receipt eviction. */
export class HostBrowserReceipts {
  private entries = new Map<string, { fingerprint: string; result: Promise<HostBrowserSnapshot> }>();
  private sequences = new Map<string, number>();
  run(viewer: string, sequence: unknown, requestId: unknown, payload: unknown, action: () => Promise<HostBrowserSnapshot>) {
    const id = browserID(requestId, '操作');
    if (!integer(sequence, 1, Number.MAX_SAFE_INTEGER)) throw new HostBrowserError('操作顺序无效');
    const key = viewer + '\n' + id, fingerprint = createHash('sha256').update(JSON.stringify([sequence, payload])).digest('hex');
    const previous = this.entries.get(key);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new HostBrowserError('操作标识已用于不同内容', 409); return previous.result; }
    if ((sequence as number) <= (this.sequences.get(viewer) ?? 0)) throw new HostBrowserError('旧的浏览器操作不会重新执行', 409);
    if (!this.sequences.has(viewer) && this.sequences.size >= 256) throw new HostBrowserError('此标签的连接次数过多，请新建标签', 429);
    this.sequences.set(viewer, sequence as number);
    const result = Promise.resolve().then(action); this.entries.set(key, { fingerprint, result });
    void result.catch(() => {});
    if (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value!);
    return result;
  }
}
