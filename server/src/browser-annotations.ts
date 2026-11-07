/** T3 preview records; page markup is captured reference material, never executed here. */
export type BrowserElementSource = { functionName: string | null; fileName: string | null; lineNumber: number | null; columnNumber: number | null };
export type BrowserElementDetails = {
  pageUrl: string; pageTitle: string | null; tagName: string; selector: string | null;
  htmlPreview: string; componentName: string | null; source: BrowserElementSource | null; styles: string;
};
export type BrowserStyleChange = { targetId: string; selector: string | null; property: string; previousValue: string; value: string };
export type BrowserAnnotationRecord = {
  version: 1; annotationId: string; pageUrl: string; pageTitle: string | null; comment: string;
  elements: BrowserElementDetails[]; elementIds: string[]; styleChangeDetails: BrowserStyleChange[];
  regionCount: number; strokeCount: number; screenshotImageId?: string;
};
const object = (value: unknown): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('网页批注格式无效'); return value as Record<string, unknown>; };
function string(value: unknown, max = 2048): string { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error('网页批注文字无效或过长'); return value; }
const nullable = (value: unknown) => value === null || value === undefined ? null : string(value);
const count = (value: unknown) => { if (value === undefined) return 0; if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error('网页批注计数无效'); return Number(value); };
const array = (value: unknown, limit: number) => { if (!Array.isArray(value) || value.length > limit) throw new Error('网页批注项目过多'); return value; };
const normalizedText = (value: string) => value.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
const truncate = (value: string, length: number) => value.length <= length ? value : value.slice(0, length - 1) + '…';
export function normalizeBrowserAnnotation(input: unknown): BrowserAnnotationRecord {
  const value = object(input), annotationId = string(value.annotationId).trim(), pageUrl = string(value.pageUrl).trim();
  if (value.version !== 1 || !annotationId || !pageUrl) throw new Error('网页批注来源无效');
  const elements = array(value.elements, 50).map(raw => {
    const e = object(raw), tagName = string(e.tagName, 255).trim().toLowerCase(); if (!tagName || !string(e.pageUrl).trim()) throw new Error('网页元素来源无效');
    let source: BrowserElementSource | null = null;
    if (e.source !== null && e.source !== undefined) {
      const s = object(e.source), position = (v: unknown) => v === null || v === undefined ? null : count(v);
      source = { functionName: nullable(s.functionName)?.trim() || null, fileName: nullable(s.fileName)?.trim() || null, lineNumber: position(s.lineNumber), columnNumber: position(s.columnNumber) };
    }
    return { pageUrl: string(e.pageUrl).trim(), pageTitle: nullable(e.pageTitle)?.trim() ?? null, tagName, selector: nullable(e.selector)?.trim() || null,
      htmlPreview: truncate(normalizedText(string(e.htmlPreview, 8000)), 4000), componentName: nullable(e.componentName)?.trim() || null, source,
      styles: truncate(normalizedText(string(e.styles, 8000)), 4000) };
  });
  const elementIds = array(value.elementIds, 50).map(v => string(v));
  if (elementIds.length !== elements.length || new Set(elementIds).size !== elementIds.length || elementIds.some(id => !id)) throw new Error('网页元素标识无效');
  const styleChangeDetails = array(value.styleChangeDetails, 200).map(raw => { const c = object(raw); return { targetId: string(c.targetId), selector: nullable(c.selector), property: string(c.property), previousValue: string(c.previousValue, 8000), value: string(c.value, 8000) }; });
  const result: BrowserAnnotationRecord = { version: 1, annotationId, pageUrl, pageTitle: nullable(value.pageTitle), comment: string(value.comment, 8000).trim(), elements, elementIds, styleChangeDetails, regionCount: count(value.regionCount), strokeCount: count(value.strokeCount) };
  if (!elements.length && !result.regionCount && !result.strokeCount) throw new Error('请先选择元素或标记区域');
  if (value.screenshotImageId !== undefined && value.screenshotImageId !== null) { const id = string(value.screenshotImageId, 128); if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error('网页截图标识无效'); result.screenshotImageId = id; }
  return result;
}
export function browserAnnotationLabel(record: BrowserAnnotationRecord) {
  const comment = record.comment.trim().replace(/\s+/g, ' '); return comment ? truncate(comment, 48) : truncate(record.pageTitle?.trim() || 'Preview annotation', 200);
}
export function browserAnnotationSummary(record: BrowserAnnotationRecord) {
  return [[record.elements.length, 'selected element'], [record.regionCount, 'marked region'], [record.strokeCount, 'drawing']].filter(([n]) => Number(n) > 0).map(([n, noun]) => `${n} ${noun}${n === 1 ? '' : 's'}`).join(', ');
}
const indent = (value: string) => value.split('\n').map(line => '  ' + line).join('\n');
/** Same provider body as T3's preview-annotation context, with Friday attachment IDs. */
export function renderBrowserAnnotation(record: BrowserAnnotationRecord, screenshotContextId?: string): string {
  const lines = [`page: ${record.pageTitle?.trim() || record.pageUrl}`, `url: ${record.pageUrl}`];
  if (record.comment.trim()) lines.push(`comment: ${record.comment.trim()}`);
  const summary = browserAnnotationSummary(record); if (summary) lines.push(`targets: ${summary}`);
  if (record.styleChangeDetails.length) lines.push('requested visual changes:', ...record.styleChangeDetails.map(c => `- ${c.property}: ${c.previousValue || '(unset)'} → ${c.value}`));
  if (screenshotContextId) lines.push(`screenshot: ref=${screenshotContextId}`);
  for (const [index, e] of record.elements.entries()) {
    const detail = [`url: ${e.pageUrl}`, `tag: ${e.tagName}`];
    if (e.pageTitle) detail.push(`title: ${e.pageTitle}`); if (e.selector) detail.push(`selector: ${e.selector}`); if (e.componentName) detail.push(`component: ${e.componentName}`);
    if (e.source?.fileName) detail.push(`source: ${e.source.fileName}${e.source.lineNumber === null ? '' : ':' + e.source.lineNumber + (e.source.columnNumber === null ? '' : ':' + e.source.columnNumber)}`);
    if (e.htmlPreview.trim()) detail.push('html:', indent(e.htmlPreview.trim())); if (e.styles.trim()) detail.push('styles:', indent(e.styles.trim()));
    lines.push(`element ${index + 1}:`, indent(detail.join('\n')));
  }
  return lines.join('\n');
}
