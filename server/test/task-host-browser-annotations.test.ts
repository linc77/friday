import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext, type Context } from 'node:vm';
import { JSDOM } from 'jsdom';
import type { CDPSession } from 'playwright-core';
import { HostBrowserAnnotations } from '../src/task-host-browser-annotations.js';
import { hostAnnotationContextSource, hostAnnotationElementSource, hostAnnotationPickerSource } from '../src/task-host-browser-annotation-source.js';

class PickerProtocol {
  dom = new JSDOM('<!doctype html><title>Private fixture</title><body><button id="target" style="color:red!important;padding:1px 2px">Inspect me</button></body>', { url: 'http://localhost:3000/', runScripts: 'outside-only' });
  calls: { method: string; params: any }[] = [];
  worlds = new Map<number, Context>();
  names = new Map<string, number>();
  listeners = new Map<string, Set<(event: any) => void>>();
  waitForWorld?: Promise<void>;
  mainReply: unknown = null;
  async send(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') {
      await this.waitForWorld;
      const existing = this.names.get(params.worldName); if (existing) return { executionContextId: existing };
      const w = this.dom.window;
      w.Element.prototype.getBoundingClientRect = () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, toJSON() {} });
      w.document.elementsFromPoint = () => [w.document.getElementById('target')!];
      const context = createContext({ document: w.document, location: w.location, Element: w.Element, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, innerWidth: 640, innerHeight: 480, CSS: { escape: (s: string) => s }, getComputedStyle: w.getComputedStyle.bind(w), setTimeout, clearTimeout,
        addEventListener: (name: string, handler: (event: any) => void) => { const handlers = this.listeners.get(name) ?? new Set(); handlers.add(handler); this.listeners.set(name, handlers); },
        removeEventListener: (name: string, handler: (event: any) => void) => this.listeners.get(name)?.delete(handler) });
      runInContext('window=globalThis;top=globalThis;', context);
      const id = this.worlds.size + 1; this.worlds.set(id, context); this.names.set(params.worldName, id); return { executionContextId: id };
    }
    if (method === 'Runtime.evaluate') {
      if (!params.contextId) return { result: { value: await this.mainReply } };
      return { result: { value: await runInContext(params.expression, this.worlds.get(params.contextId)!) } };
    }
    return {};
  }
  click(trusted = true) {
    for (const name of ['pointerdown', 'pointerup']) for (const fn of this.listeners.get(name) ?? []) fn({ isTrusted: trusted, button: 0, clientX: 30, clientY: 30, target: this.dom.window.document.getElementById('target'), preventDefault() {}, stopImmediatePropagation() {} });
  }
  session() { return this as unknown as CDPSession; }
  close() { this.dom.window.close(); }
}
const scope = () => ({ id: 'picker', viewer: 'viewer', device: 'owner', document: 'document', control: 1, current: () => true });

test('Host picker, context wrapper and React bundle exactly match the native packaged resources', async () => {
  for (const [source, name] of [[hostAnnotationPickerSource, 'BrowserAnnotationPicker.js'], [hostAnnotationContextSource, 'BrowserAnnotationContext.js'], [hostAnnotationElementSource, 'BrowserElementContext.js']]) assert.equal(source, await readFile(new URL('../../apps/apple/Sources/FridayKit/Resources/' + name, import.meta.url), 'utf8'));
});
test('Private host selection rejects synthetic page input, returns only the owner snapshot and restores exact styles on cancellation', async t => {
  const protocol = new PickerProtocol(), owner = new HostBrowserAnnotations(protocol.session()), context = scope(); t.after(async () => { await owner.close(); protocol.close(); });
  const initial = JSON.parse(await owner.start(context)); assert.equal(initial.nonce, context.id); assert.equal(initial.elements.length, 0);
  assert.equal(protocol.dom.window.FridayBrowserPicker, undefined);
  protocol.click(false); assert.equal(JSON.parse(await owner.call(context, 'read', {})).elements.length, 0);
  protocol.click(); const value = JSON.parse(await owner.call(context, 'read', {})); assert.equal(value.elements[0].element.selector, '#target'); assert.equal(await owner.call(context, 'read', {}), null);
  for (const foreign of [{ device: 'other' }, { viewer: 'other' }, { document: 'other' }, { control: 2 }, { id: 'other' }]) await assert.rejects(owner.call({ ...context, ...foreign }, 'read', {}), /不属于/);
  const target = protocol.dom.window.document.getElementById('target')!, original = target.getAttribute('style');
  await owner.call(context, 'style', { property: 'color', value: 'blue' }); await owner.call(context, 'style', { property: 'padding', value: '20px' });
  assert.equal(target.style.color, 'blue'); await assert.rejects(owner.stop('picker', 'other', 'owner'), /不属于/);
  await owner.stop('picker', 'viewer', 'owner'); assert.equal(target.getAttribute('style'), original); assert.equal(target.hasAttribute('data-friday-picked'), false);
  assert.equal(protocol.dom.window.document.querySelector('[data-friday-annotation-ui]'), null); assert.equal([...protocol.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
  await assert.rejects(owner.start(context), /已结束/);
});
test('Frozen capture uses private selected elements for a bounded main-world read and preserves fallback when source extraction fails', async t => {
  const protocol = new PickerProtocol(), owner = new HostBrowserAnnotations(protocol.session()), context = scope(); t.after(async () => { await owner.close(); protocol.close(); });
  await owner.start(context); protocol.click(); await assert.rejects(owner.call(context, 'elements', {}), /确认/);
  await owner.call(context, 'freeze', { value: true }); protocol.click();
  const fallback = JSON.parse(await owner.call(context, 'elements', { script: 'evil', ids: ['foreign'], fallback: ['evil'] })); assert.equal(fallback.length, 1); assert.equal(fallback[0].selector, '#target');
  const main = protocol.calls.find(call => call.method === 'Runtime.evaluate' && !call.params.contextId)!; assert.ok(main.params.expression.includes('FridayBrowserAnnotationContext')); assert.ok(!main.params.expression.includes('evil')); assert.equal(main.params.timeout, 6500);
  protocol.mainReply = JSON.stringify([{ ...fallback[0], componentName: 'Card', source: { fileName: '/app/Card.tsx', lineNumber: 12, columnNumber: 3 } }]);
  const details = JSON.parse(await owner.call(context, 'elements', {})); assert.equal(details[0].componentName, 'Card');
  await assert.rejects(owner.call(context, 'style', { property: 'color', value: 'blue' }));
  await assert.rejects(owner.call(context, 'evaluate', { script: 'evil' }), /无效/);
});
test('Navigation invalidation and stop during delayed startup clean the original private context before a new picker starts', async t => {
  const protocol = new PickerProtocol(), owner = new HostBrowserAnnotations(protocol.session()); t.after(async () => { await owner.close(); protocol.close(); });
  let release!: () => void; protocol.waitForWorld = new Promise<void>(resolve => { release = resolve; });
  const starting = owner.start(scope()); await new Promise(resolve => setImmediate(resolve)); const stopping = owner.stop('picker', 'viewer', 'owner'); release(); await assert.rejects(starting, /变化/); await stopping;
  protocol.waitForWorld = undefined; const next = { ...scope(), id: 'next' }; await owner.start(next); protocol.click(); await owner.call(next, 'style', { property: 'color', value: 'blue' }); owner.invalidate();
  await assert.rejects(owner.call(next, 'read', {})); await owner.start({ ...scope(), id: 'third' }); assert.equal(protocol.dom.window.document.getElementById('target')!.style.color, 'red');
  assert.equal(protocol.names.size, 1, 'Repeated annotations reuse one private world rather than leaking contexts');
  assert.equal(protocol.calls.some(call => call.method === 'Page.addScriptToEvaluateOnNewDocument'), false);
});
test('A changed document while extraction waits cannot produce an accepted annotation', async t => {
  const protocol = new PickerProtocol(), owner = new HostBrowserAnnotations(protocol.session()); t.after(async () => { await owner.close(); protocol.close(); });
  let current = true; const context = { ...scope(), current: () => current }; await owner.start(context); protocol.click(); await owner.call(context, 'freeze', { value: true });
  let release!: () => void; protocol.mainReply = new Promise(resolve => { release = () => resolve('[]'); });
  const pending = owner.call(context, 'elements', {}); await new Promise(resolve => setImmediate(resolve)); current = false; release(); await assert.rejects(pending, /变化/);
});
