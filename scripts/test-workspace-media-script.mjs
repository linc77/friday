// Functional bridge unit test; no browser, native window, or UI automation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(process.argv[2], 'utf8'), script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
assert.ok(script); const handlers = new Map(), messages = [];
const media = { tagName: 'VIDEO', autoplay: false, paused: true, seeking: false, currentTime: 0, played: { length: 0 }, duration: 2, src: 'https://host.test/file-assets/private-token/a.mp4',
  addEventListener: (name, fn) => handlers.set(name, fn), getBoundingClientRect: () => ({ left: 16, bottom: 300 }) };
const context = vm.createContext({ document: { getElementById: () => media, addEventListener() {} }, window: { webkit: { messageHandlers: { fridayMedia: { postMessage: value => messages.push(JSON.parse(JSON.stringify(value))) } } } }, URLSearchParams });
new vm.Script(script).runInContext(context, { timeout: 1000 });
let prevented = 0; const event = { defaultPrevented: false, preventDefault: () => prevented++, stopPropagation() {} };
handlers.get('contextmenu')({ ...event, clientX: 20, clientY: 40 });
assert.deepEqual(messages.pop(), { id: 'bridge-test', event: 'context', x: 20, y: 40 });
handlers.get('keydown')({ ...event, key: 'F10', shiftKey: true });
assert.deepEqual(messages.pop(), { id: 'bridge-test', event: 'context', x: 16, y: 300 });
handlers.get('contextmenu')({ ...event, clientX: 0, clientY: 0 });
assert.deepEqual(messages.pop(), { id: 'bridge-test', event: 'context', x: 16, y: 300 });
handlers.get('keydown')({ ...event, key: 'F10', shiftKey: false });
handlers.get('contextmenu')({ ...event, defaultPrevented: true }); assert.equal(messages.length, 0); assert.equal(prevented, 3);
handlers.get('loadedmetadata')(); assert.equal(media.currentTime, 0.1);
console.log('Pointer/keyboard context requests, source isolation and first-frame bridge passed');
