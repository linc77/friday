import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../apps/apple/Sources/FridayKit/Resources/MarkdownParser.js', import.meta.url), 'utf8'), context, { timeout: 5000 });
const parse = source => JSON.parse(context.fridayParseMarkdown(source));
const all = node => [node, ...(node.children ?? []).flatMap(all)];
const source = '<details open><summary>Read <strong>more</strong></summary>\n\n## 中文 & Unicode 🚀\n\n- [x] **Done**\n\n```ts title="src/main.ts"\nconst text = `<script>data</script>`;\n```\n\n</details>';
const nodes = all(parse(source));
assert.equal(nodes.find(node => node.tagName === 'details').properties.open, true);
assert.equal(nodes.find(node => node.tagName === 'code').properties.dataCodeMeta, 'title="src/main.ts"');
assert.ok(nodes.find(node => node.tagName === 'input').properties.checked);
assert.equal(nodes.find(node => node.tagName === 'h2').properties.id, 'user-content-中文--unicode-');
assert.ok(nodes.some(node => node.value?.includes('<script>data</script>')));
const unsafe = all(parse('<div id="location" style="color:red" onclick="bad()"><script>globalThis.neverRun=true</script><a href="jav&#x61;script:bad()">Read</a><img src="javascript:bad()" onerror="bad()" alt="Safe"></div>'));
assert.equal(unsafe.find(node => node.tagName === 'div').properties.id, 'user-content-location');
assert.equal(unsafe.find(node => node.tagName === 'a').properties.href, undefined);
assert.equal(unsafe.find(node => node.tagName === 'img').properties.src, undefined);
assert.ok(!unsafe.some(node => node.tagName === 'script' || node.value?.includes('neverRun')));
for (const node of unsafe) for (const key of Object.keys(node.properties ?? {})) assert.ok(!/^on|^style$/i.test(key));
const ids = all(parse('<span id="same"></span>\n\n# Same\n\n# Same')).filter(node => node.properties?.id).map(node => node.properties.id);
assert.deepEqual(ids, ['user-content-same', 'user-content-same-1', 'user-content-same-2']);
const tasks = '🚀 中文\r\n\r\n- [ ] first\r\n  - [X] nested\r\n\r\n```md\n- [ ] code\n```\n\n<ul><li data-friday-task-marker="0"><input type="checkbox">HTML</li></ul>';
const taskItems = all(parse(tasks)).filter(node => node.tagName === 'li');
assert.deepEqual(taskItems.filter(node => node.properties?.dataFridayTaskMarker !== undefined).map(node => node.properties.dataFridayTaskMarker), [tasks.indexOf('[ ] first'), tasks.indexOf('[X] nested')]);
assert.equal(taskItems.at(-1).properties.dataFridayTaskMarker, undefined);
assert.ok(all(parse('1. [x] ordered\n\n> - [ ] quote')).filter(node => node.properties?.dataFridayTaskMarker !== undefined).length === 2);
for (const value of ['\ufeff- [ ] first\r\n- [x] second', '\ufeff中文 🚀\r\n\r\n> - [X] quoted\r\n>   - [ ] nested']) {
  const markers = all(parse(value)).filter(node => node.properties?.dataFridayTaskMarker !== undefined).map(node => node.properties.dataFridayTaskMarker);
  assert.deepEqual(markers, [...value.matchAll(/\[[ xX]\]/g)].map(match => match.index));
}
for (const name of ['document', 'window', 'fetch', 'require', 'process', 'neverRun']) assert.equal(typeof context[name], 'undefined', name);
console.log('Offline Markdown/HTML parsing, nested content, code metadata, scoped IDs and sanitization checks passed');
