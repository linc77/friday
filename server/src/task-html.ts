import { createHash } from 'node:crypto';
import { defineDocFamily } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import type { Engine } from './engine.js';
import type { TaskHtmlReference } from './types.js';
import { WorkspaceDoc } from './state.js';
import { assertWatchActor, type WatchActor } from './task-change-request-watch.js';
import { nativeSessionActionBusy } from './task-session-actions.js';
import { openTaskMedia } from './task-media.js';

// Like T3's html_render, publication is an explicit tool action. The page is
// immutable app-owned data, not executable Markdown or a mutable workspace file.
const HtmlDoc = defineDocFamily<{ html?: string; reference?: TaskHtmlReference }, { id: string }>({
  kind: 'friday.task_html', version: 1, scope: 'session', checkpointWhen: () => false,
  family: true, initial: () => ({}),
});
export const maxHtmlBytes = 512_000;
export const maxHtmlAssetBytes = 8 * 1024 * 1024;
export const htmlInstructions = 'Use html_render to show a finished interactive HTML page directly in this conversation. Write self-contained HTML with inline CSS and JavaScript. Do not put executable HTML in Markdown fences. Network requests, remote assets and app APIs are unavailable. Embed local images with images:[{name,path}] and friday-image:name URLs. The tool saves a snapshot; later file changes do not change it. Use another html_render call to publish a revised page.';
export const htmlToolDefinitions = [{
  name: 'html_render', description: 'Publish an interactive HTML page, chart or mockup inline in this conversation. Returns a saved reference, not a screenshot or proof of visual correctness. ' + htmlInstructions,
  annotations: { title: 'Render HTML', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['html', 'title'], properties: {
    html: { type: 'string', minLength: 1, maxLength: maxHtmlBytes, description: 'Complete self-contained HTML. Inline styles and scripts; data URLs or friday-image:name for images.' },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    height: { type: 'integer', minimum: 180, maximum: 1200, description: 'Initial height in CSS pixels; default 480. The client fits content up to 900px and offers an expanded view.' },
    images: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['name', 'path'], properties: {
      name: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, path: { type: 'string', description: 'Local image path on the service host, relative to this task workspace or absolute.' },
    } } },
  } },
}];

// A response-header policy cannot be weakened by authored markup. Opaque origin,
// no resource network access, nested frames or forms. The client also rejects
// navigation and accepts native height messages only from its trusted wrapper.
export const htmlContentSecurityPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
export function htmlDocument(source: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>button,a[href],select,[role=button],input[type=button],input[type=submit]{cursor:pointer}button:disabled,select:disabled,input:disabled{cursor:default}</style><script>(()=>{let queued=false,last=0;function report(){queued=false;const h=Math.ceil(Math.max(document.body?.scrollHeight||0,document.body?.getBoundingClientRect().height||0));if(h>0&&h!==last){last=h;parent.postMessage({type:'friday-html-height',height:h},'*')}}function schedule(){if(!queued){queued=true;requestAnimationFrame(report)}}addEventListener('DOMContentLoaded',()=>{new ResizeObserver(schedule).observe(document.body);schedule()});addEventListener('load',schedule);addEventListener('resize',schedule)})();</script>` + source.replace(/^\uFEFF/, '');
}

function inputPage(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['html', 'title', 'height', 'images'].includes(key)) || typeof input.html !== 'string' || !input.html.trim() || Buffer.byteLength(input.html) > maxHtmlBytes
    || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || /[\x00-\x1f\x7f]/.test(input.title)
    || input.height !== undefined && (!Number.isSafeInteger(input.height) || Number(input.height) < 180 || Number(input.height) > 1200)
    || input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 8)) throw new Error('HTML 页面参数无效或超过大小限制');
  const images = (input.images ?? []) as Record<string, unknown>[];
  const names = new Set<string>();
  for (const image of images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).some(key => !['name', 'path'].includes(key)) || typeof image.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(image.name) || names.has(image.name) || typeof image.path !== 'string') throw new Error('HTML 图片参数无效');
    names.add(image.name);
  }
  return { html: input.html, title: input.title.trim(), height: Number(input.height ?? 480), images: images as { name: string; path: string }[] };
}

export class TaskHtml {
  constructor(private readonly engine: Engine) {}
  async publish(taskId: string, actor: WatchActor, input: Record<string, unknown>, signal: AbortSignal) {
    const page = inputPage(input), images = new Map<string, string>();
    signal.throwIfAborted();
    const snapshot = await this.engine.snapshot(), task = snapshot.tasks.find(value => value.id === taskId);
    if (!task) throw new Error('任务不存在');
    assertWatchActor(task, actor);
    let total = Buffer.byteLength(page.html);
    for (const image of page.images) {
      signal.throwIfAborted();
      const file = await openTaskMedia(image.path, task.cwd, { directory: this.engine.directory, workspace: task.executionWorkspace, projectFolder: snapshot.projects.find(project => project.id === task.projectId)?.managedFolder });
      try {
        if (file.info.size > 2 * 1024 * 1024) throw new Error('HTML 单张图片不能超过 2 MB');
        const buffer = Buffer.alloc(file.info.size + 1);
        let offset = 0;
        while (offset < buffer.length) { signal.throwIfAborted(); const read = await file.handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
        if (offset !== file.info.size) throw new Error('HTML 图片在读取期间发生变化');
        const value = `data:${file.mimeType};base64,${buffer.subarray(0, offset).toString('base64')}`;
        total += value.length;
        if (total > maxHtmlAssetBytes) throw new Error('HTML 页面和图片合计不能超过 8 MB');
        images.set(image.name, value);
      } finally { await file.handle.close(); }
    }
    let expandedBytes = Buffer.byteLength(page.html);
    for (const match of page.html.matchAll(/friday-image:([A-Za-z0-9_-]+)/g)) {
      const image = images.get(match[1]); if (!image) throw new Error('HTML 引用了未提供的图片：' + match[1]);
      expandedBytes += image.length - match[0].length;
      if (expandedBytes > maxHtmlAssetBytes) throw new Error('HTML 页面和图片合计不能超过 8 MB');
    }
    const html = page.html.replace(/friday-image:([A-Za-z0-9_-]+)/g, (_, name: string) => {
      return images.get(name)!;
    });
    if (Buffer.byteLength(html) > maxHtmlAssetBytes) throw new Error('HTML 页面和图片合计不能超过 8 MB');
    // Content-addressed within a run: a retried MCP call (even after reconnect)
    // cannot publish duplicate cards. A revised page is a separate immutable item.
    const id = createHash('sha256').update(JSON.stringify([taskId, actor.runId, page.title, page.height, html])).digest('hex');
    const reference: TaskHtmlReference = { id, title: page.title, height: page.height };
    await this.engine.root.commit(async tx => {
      signal.throwIfAborted();
      const state = await tx.doc(WorkspaceDoc), current = state.tasks.find(value => value.id === taskId);
      if (!current || current.agent === 'friday' || current.subagentOrigin || current.archivedAt || current.settledAt || current.settledOverride === 'settled' || current.archiveCleanup?.status === 'pending' || current.settleCleanup?.status === 'pending' || nativeSessionActionBusy(current)) throw new Error('任务工具所属任务不可用');
      assertWatchActor(current, actor);
      const saved = await tx.doc(HtmlDoc, id, { id });
      signal.throwIfAborted();
      if (saved.reference) return;
      const at = new Date().toISOString();
      saved.html = html; saved.reference = reference;
      current.events.push({ id: 'html-' + id, kind: 'html', text: page.title, at, completedAt: at, status: 'completed', runId: actor.runId, ...(current.turnId ? { turnId: current.turnId } : {}), html: reference });
      current.updatedAt = at;
      await this.engine.taskHistory.persist(tx, current);
      state.revision++;
    }, context);
    return { htmlRender: reference, message: 'Saved and shown inline in this conversation. This does not verify the page visually.' };
  }
  async read(taskId: string, eventId: string) {
    const page = await this.engine.taskHistory.eventItems(taskId, [eventId]);
    const event = page.events.find(value => value.id === eventId && value.kind === 'html' && !value.revertedAt);
    if (!event?.html || !/^[a-f0-9]{64}$/.test(event.html.id)) throw new Error('这个 HTML 产物已不在当前会话中');
    const saved = await this.engine.harness.snapshot(HtmlDoc, event.html.id, context);
    if (!saved?.html || saved.reference?.id !== event.html.id) throw new Error('HTML 产物暂时不可用');
    return { html: saved.html, reference: saved.reference };
  }
}
