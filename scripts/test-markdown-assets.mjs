import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// No browser APIs, Node globals, network, filesystem, or credentials are exposed.
const context = vm.createContext({ WebAssembly });
const source = await readFile(new URL('../apps/apple/Sources/FridayKit/Resources/CodeHighlighter.js', import.meta.url), 'utf8');
vm.runInContext(source, context, { timeout: 5000 });
const highlight = (text, language, dark = true) => new Promise((resolve, reject) => {
  context.fridayHighlight(text, language, dark, value => { try { resolve(JSON.parse(value)); } catch (error) { reject(error); } });
});
const text = 'const café = `hello 🚀`;\n';
const dark = await highlight(text, 'typescript'); const light = await highlight(text, 'typescript', false);
const restored = value => value.lines.map(line => line.map(token => token.text).join('')).join('\n');
assert.equal(restored(dark), text); assert.equal(restored(light), text);
assert.notEqual(dark.foreground, light.foreground); assert.ok(new Set(dark.lines.flatMap(line => line.map(token => token.color))).size > 2);
for (const [language, code] of [['tsx', 'const A = () => <div>Hello</div>;'], ['swift', 'let text = "中文 🚀"'], ['python', 'def hello():\n    return True'], ['gitignore', '# comment\nnode_modules/']]) {
  const value = await highlight(code, language); assert.equal(restored(value), code); assert.notEqual(value.language, 'text');
}
const attack = 'globalThis.fridayAttackMarker = true; </script>\n';
assert.equal(restored(await highlight(attack, 'javascript')), attack); assert.equal(context.fridayAttackMarker, undefined);
const unknown = await highlight(attack, 'unknown-language-for-test'); assert.equal(unknown.language, 'text'); assert.equal(restored(unknown), attack);
assert.equal(typeof context.fetch, 'undefined'); assert.equal(typeof context.require, 'undefined');
console.log('Offline WASM highlighting, theme colors, aliases, Unicode, fallback and source-data isolation checks passed');
