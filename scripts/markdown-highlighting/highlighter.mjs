import './polyfills.mjs';
import { createHighlighterCore } from 'shiki/core';
import { createOnigurumaEngine } from 'shiki/engine/oniguruma';
import { wasmBinary } from 'shiki/wasm';
import { bundledLanguages } from 'shiki/langs';
import dark from '@pierre/theme/pierre-dark';
import light from '@pierre/theme/pierre-light';

const engine = createOnigurumaEngine({ instantiator: imports => new WebAssembly.Instance(new WebAssembly.Module(wasmBinary), imports) });
const highlighter = createHighlighterCore({ engine, themes: [dark, light], langs: [] });
const loads = new Map();
globalThis.fridayHighlight = async (source, requested, isDark, completed) => {
  try {
    const value = await highlighter;
    const name = String(requested).trim().toLowerCase();
    const language = name === 'gitignore' ? 'ini' : name === 'terminal' ? 'bash' : name;
    const loader = Object.hasOwn(bundledLanguages, language) ? bundledLanguages[language] : undefined;
    if (loader && !loads.has(language)) loads.set(language, value.loadLanguage(loader));
    if (loads.has(language)) await loads.get(language);
    const result = value.codeToTokens(source, { lang: loader ? language : 'text', theme: isDark ? dark.name : light.name,
      tokenizeTimeLimit: 500, tokenizeMaxLineLength: 20_000 });
    completed(JSON.stringify({ foreground: result.fg, background: result.bg, language: loader ? language : 'text',
      lines: result.tokens.map(line => line.map(token => ({ text: token.content, color: token.color ?? result.fg, style: token.fontStyle ?? 0 }))) }));
  } catch { completed(''); }
};
// Initialization may fail on a runtime without WASM; the native text stays visible.
void highlighter.catch(() => {});
