/*
Adapted from T3 Code 8cd9641f packages/shared/src/keybindings.ts (single-chord parser).
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
export type ScriptShortcut = { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; modKey: boolean };
// Same single-chord grammar as T3 shared/keybindings, including mod++, aliases,
// and exact modifiers. These settings never enter the executable script body.
export function parseScriptShortcut(value: string): ScriptShortcut | null {
  const tokens = value.toLowerCase().split('+').map(t => t.trim()); let trailing = 0;
  while (tokens.at(-1) === '') { trailing++; tokens.pop(); }
  if (trailing) tokens.push('+'); if (!tokens.length || tokens.some(t => !t)) return null;
  const result: ScriptShortcut = { key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, modKey: false };
  for (const token of tokens) {
    if (token === 'cmd' || token === 'meta') result.metaKey = true;
    else if (token === 'ctrl' || token === 'control') result.ctrlKey = true;
    else if (token === 'shift') result.shiftKey = true;
    else if (token === 'alt' || token === 'option') result.altKey = true;
    else if (token === 'mod') result.modKey = true;
    else { if (result.key) return null; result.key = token === 'space' ? ' ' : token === 'esc' ? 'escape' : token; }
  }
  return result.key ? result : null;
}
export function normalizeScriptShortcut(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || /[\x00-\x1f]/.test(value)) throw new Error('脚本快捷键无效');
  const parsed = parseScriptShortcut(value); if (!parsed) throw new Error('脚本快捷键无效');
  return [...(parsed.modKey ? ['mod'] : []), ...(parsed.metaKey ? ['meta'] : []), ...(parsed.ctrlKey ? ['ctrl'] : []), ...(parsed.altKey ? ['alt'] : []), ...(parsed.shiftKey ? ['shift'] : []), parsed.key === ' ' ? 'space' : parsed.key].join('+');
}
export function appleScriptShortcutKey(value: string) {
  const s = parseScriptShortcut(value)!; return JSON.stringify([s.key, s.metaKey || s.modKey, s.ctrlKey, s.shiftKey, s.altKey]);
}
