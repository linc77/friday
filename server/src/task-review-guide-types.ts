import type { TextGenerationModelSelection } from './text-generation-settings.js';
export type ReviewGuideExcerpt = { path: string; side: 'new' | 'old'; start: number; end: number; caption: string };
export type ReviewGuideStop = { title: string; summary: string; attention: { kind: 'tradeoff' | 'contract' | 'product' | 'risk' | 'accessibility'; note: string } | null; excerpts: ReviewGuideExcerpt[]; files: { path: string; note?: string }[]; notes: { path: string; line: number; title: string; body: string }[]; questions: string[] };
export type ReviewGuide = { headSha: string; generatedAt: string; modelSelection: TextGenerationModelSelection; stops: ReviewGuideStop[] };
export type ReviewGuideRun = { id: string; durableId: number; url: string; headSha: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'; createdAt: string; updatedAt: string; modelSelection: TextGenerationModelSelection; error?: string };
const string = { type: 'string' }, integer = { type: 'integer' };
const struct = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const array = (items: unknown) => ({ type: 'array', items });
export const REVIEW_GUIDE_OUTPUT_SCHEMA = struct({ stops: array(struct({ title: string, summary: string,
  attention: { anyOf: [{ type: 'null' }, struct({ kind: { type: 'string', enum: ['tradeoff', 'contract', 'product', 'risk', 'accessibility'] }, note: string })] },
  excerpts: array(struct({ path: string, side: { type: 'string', enum: ['new', 'old'] }, start: integer, end: integer, caption: string })),
  files: array(struct({ path: string, note: string })), notes: array(struct({ path: string, line: integer, title: string, body: string })), questions: array(string),
})) });
export function decodeReviewGuide(text: string): { stops: ReviewGuideStop[] } {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Guide 生成结果过大');
  let value: unknown; try { const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1'); value = JSON.parse(clean); } catch { throw new Error('Guide 未返回有效的结构化内容'); }
  const obj = (v: any) => v && typeof v === 'object' && !Array.isArray(v), str = (v: any) => typeof v === 'string' && !v.includes('\0') && Buffer.from(v, 'utf8').toString('utf8') === v;
  const strings = (v: any) => Array.isArray(v) && v.every(str), pos = (v: any) => Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;
  const v = value as any;
  if (!obj(v) || !Array.isArray(v.stops) || v.stops.length > 100 || !v.stops.every((stop: any) => obj(stop) && str(stop.title) && str(stop.summary)
    && (stop.attention === null || obj(stop.attention) && ['tradeoff', 'contract', 'product', 'risk', 'accessibility'].includes(stop.attention.kind) && str(stop.attention.note))
    && Array.isArray(stop.excerpts) && stop.excerpts.length <= 100 && stop.excerpts.every((e: any) => obj(e) && str(e.path) && ['old', 'new'].includes(e.side) && pos(e.start) && pos(e.end) && str(e.caption))
    && Array.isArray(stop.files) && stop.files.length <= 10000 && stop.files.every((f: any) => obj(f) && str(f.path) && (f.note === undefined || str(f.note)))
    && Array.isArray(stop.notes) && stop.notes.length <= 100 && stop.notes.every((n: any) => obj(n) && str(n.path) && pos(n.line) && str(n.title) && str(n.body)) && strings(stop.questions) && stop.questions.length <= 100)) throw new Error('Guide 结构或代码位置无效');
  return { stops: v.stops };
}

export type ReviewGuideExcerptSnapshot = ReviewGuideExcerpt & { oldPath?: string; lines: { number: number; text: string; position?: { kind: 'added'; newLine: number } | { kind: 'deleted'; oldLine: number } }[]; unavailable?: boolean };
