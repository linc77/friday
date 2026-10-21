/* Shared, bounded main-world read of React context. No native bridge is installed. */
globalThis.FridayBrowserAnnotationContext = async (ids, fallback, pageUrl) => {
  if (location.href !== pageUrl) return null;
  const roots = (root = document) => [root, ...Array.from(root.querySelectorAll('*')).flatMap(n => n.shadowRoot ? roots(n.shadowRoot) : [])];
  const all = roots();
  const trim = (s, n) => typeof s === 'string' ? s.slice(0, n) : null;
  const position = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  try {
    const output = await Promise.all(ids.map(async (id, index) => {
      const node = all.map(root => root.querySelector('[data-friday-picked="' + CSS.escape(id) + '"]')).find(Boolean);
      if (!node) return fallback[index];
      try {
        let timer;
        const context = await Promise.race([
          FridayElementContext.getElementContext(node),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 4500); })
        ]).finally(() => clearTimeout(timer));
        const frame = context.stack?.[0];
        return { ...fallback[index], htmlPreview: trim(context.htmlPreview, 8000)?.replace(/\sdata-friday-picked=("[^"]*"|'[^']*')/g, '') ?? fallback[index].htmlPreview,
          selector: context.selector?.includes('data-friday-picked') ? fallback[index].selector : (trim(context.selector, 2048) || fallback[index].selector),
          componentName: trim(context.componentName, 2048), styles: trim(context.styles, 8000) || fallback[index].styles,
          source: frame ? { functionName: trim(frame.functionName, 2048), fileName: trim(frame.fileName, 2048), lineNumber: position(frame.lineNumber), columnNumber: position(frame.columnNumber) } : null };
      } catch { return fallback[index]; }
    }));
    return location.href === pageUrl ? JSON.stringify(output) : null;
  } finally { FridayElementContext.disposeBaselineStyles?.(); }
};
