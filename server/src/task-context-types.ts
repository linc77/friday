export type TaskContextKind = 'terminal' | 'file' | 'directory' | 'code' | 'review-comment' | 'preview-annotation' | 'review-guide' | 'attachment';
export type TaskContextReference = {
  id: string; kind: TaskContextKind; label: string; capturedAt: string; digest: string;
  path?: string; terminalId?: string; terminalLabel?: string; generation?: number;
  lineStart?: number; lineEnd?: number; truncated?: boolean; byteLength: number;
  attachmentName?: string; mediaType?: string;
};
export type TaskContextScope = { taskId: string; projectId?: never; preparationId?: never } | { projectId: string; taskId?: never; preparationId?: string };
export type TaskContextCapture = { reference: TaskContextReference; scope: TaskContextScope; cwd: string; text: string; intent: string };
export type ContextOccurrence = { id: string; kind: string; label: string; start: number; end: number };
export const contextID = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value)) throw new Error('上下文引用 ID 无效'); return value;
};
export const contextIDs = (value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error('每条消息最多添加 100 个附件或上下文引用');
  const ids = value.map(contextID); if (new Set(ids).size !== ids.length) throw new Error('上下文引用不能重复'); return ids;
};
export const contextLabel = (label: string) => label.replace(/[[\]\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
export const contextLink = (ref: TaskContextReference) => `[${contextLabel(ref.label)}](friday-context://v1/${ref.kind}/${ref.id})`;
export function contextOccurrences(text: string): ContextOccurrence[] {
  return [...text.matchAll(/\[([^\]\n]{0,512})\]\(friday-context:\/\/v1\/([a-z][a-z0-9-]{0,39})\/([a-z0-9_-]{1,128})\)/gi)].map(match => ({ label: match[1], kind: match[2], id: match[3], start: match.index!, end: match.index! + match[0].length }));
}
export function displayContextText(text: string) {
  let result = text; for (const occurrence of contextOccurrences(text).reverse()) result = result.slice(0, occurrence.start) + '@' + occurrence.label + result.slice(occurrence.end); return result;
}
