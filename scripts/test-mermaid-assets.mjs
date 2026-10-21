import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

// Functional SVG tests only. Synthetic text metrics are not a review of the
// native window or its actual diagram layout, which remains user acceptance.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
const window = dom.window; const messages = []; let requests = 0;
window.webkit = { messageHandlers: { fridayMermaid: { postMessage: value => messages.push(value) } } };
window.fetch = () => { requests++; throw new Error('Diagram rendering must be offline'); };
window.XMLHttpRequest = class { constructor() { requests++; throw new Error('Diagram rendering must be offline'); } };
window.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: Math.max(10, this.textContent.length * 8), height: 20 }; };
window.SVGElement.prototype.getComputedTextLength = function () { return Math.max(10, this.textContent.length * 8); };
window.eval(await readFile(new URL('../apps/apple/Sources/FridayKit/Resources/MermaidRenderer.js', import.meta.url), 'utf8'));
assert.equal(messages[0]?.type, 'ready');
for (const [id, source, dark] of [
  ['flow', 'flowchart LR\n  A[中文 🚀] --> B[Done]', false],
  ['dark', 'flowchart LR\n  A[中文 🚀] --> B[Done]', true],
  ['sequence', 'sequenceDiagram\n  Alice->>Bob: Hello', false],
  ['class', 'classDiagram\n  A --> B', false],
]) {
  await window.fridayMermaid.render({ id, source, dark }); const result = messages.findLast(value => value.id === id);
  assert.equal(result?.type, 'rendered', result?.message); assert.ok(result.width > 0 && result.height > 0);
  const document = new window.DOMParser().parseFromString(result.svg, 'image/svg+xml');
  assert.equal(document.documentElement.localName, 'svg'); assert.equal(document.querySelectorAll('script,a,img,image,[href],[src],[srcset]').length, 0);
}
assert.notEqual(messages.find(value => value.id === 'flow').svg, messages.find(value => value.id === 'dark').svg);
const dirty = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><script>window.bad = true</script><a href="https://example.invalid"><text>Label</text></a><image href="https://example.invalid/pixel"/><style>.a{fill:url(https://example.invalid/fill)} .b{filter:url(#shadow)}</style><rect style="fill:url(https://example.invalid/paint)" onload="window.bad=true"/></svg>';
const clean = window.fridayMermaid.sanitize(dirty); const document = new window.DOMParser().parseFromString(clean, 'image/svg+xml');
assert.equal(document.querySelectorAll('script,a,img,image,[href],[src],[srcset],[onload]').length, 0);
assert.ok(!clean.includes('example.invalid')); assert.ok(clean.includes('url(#shadow)')); assert.ok(clean.includes('Label'));
await window.fridayMermaid.render({ id: 'bad', source: 'not a valid diagram', dark: false });
const error = messages.findLast(value => value.id === 'bad'); assert.equal(error.type, 'error'); assert.equal(error.retryable, false); assert.ok(error.message);
await window.fridayMermaid.render({ id: 'after-error', source: 'flowchart LR\n A --> B', dark: false });
assert.equal(messages.findLast(value => value.id === 'after-error')?.type, 'rendered');
assert.equal(window.bad, undefined); assert.equal(requests, 0);
window.close();
console.log('Mermaid SVG structure, themes, Unicode, sanitization, syntax-error recovery and offline checks passed (synthetic DOM metrics)');
