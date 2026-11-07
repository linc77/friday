/*! Mermaid rendering policy adapted from T3code (MIT); see T3code-LICENSE.txt. */
import mermaid from 'mermaid';
import createDOMPurify from 'dompurify';

const purifier = createDOMPurify(window);
const remoteCSS = /url\(\s*(?!['"]?#)[^)]*\)/gi;
purifier.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'style' && node.textContent) node.textContent = node.textContent.replace(remoteCSS, 'none');
});
purifier.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName === 'style') data.attrValue = data.attrValue.replace(remoteCSS, 'none');
});
function sanitize(svg) {
  return purifier.sanitize(svg, { ADD_TAGS: ['foreignObject'], HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset'], FORBID_TAGS: ['a', 'img', 'image', 'script'],
    USE_PROFILES: { svg: true, svgFilters: true, html: true } });
}
const send = message => window.webkit?.messageHandlers?.fridayMermaid?.postMessage(message);
let sequence = 0;
let queue = Promise.resolve();
async function render({ id, source, dark }) {
  const name = 'friday-mermaid-' + ++sequence;
  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'themeCSS'],
      htmlLabels: false, flowchart: { htmlLabels: false }, theme: dark ? 'dark' : 'default',
      fontFamily: getComputedStyle(document.body).fontFamily });
    const rendered = await mermaid.render(name, source);
    const svg = sanitize(rendered.svg);
    const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const element = xml.documentElement;
    const box = element.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    if (element.localName !== 'svg' || box?.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('The diagram did not provide valid dimensions.');
    element.setAttribute('width', String(box[2])); element.setAttribute('height', String(box[3]));
    element.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    send({ type: 'rendered', id, svg: new XMLSerializer().serializeToString(element), width: box[2], height: box[3] });
  } catch (error) {
    send({ type: 'error', id, message: String(error?.message ?? 'The diagram could not be rendered.').slice(0, 4000), retryable: /dynamically imported module|importing a module script|failed to fetch/i.test(String(error?.message)) });
  } finally { document.getElementById('d' + name)?.remove(); }
}
// One renderer configuration at a time; this queue performs only local drawing.
globalThis.fridayMermaid = {
  render: input => { const operation = queue.then(() => render(input)); queue = operation.catch(() => {}); return operation; },
  sanitize,
  png: svg => {
    const operation = queue.then(async () => {
      const document = new DOMParser().parseFromString(sanitize(svg), 'image/svg+xml');
      const root = document.documentElement, box = root.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
      if (root.localName !== 'svg' || box?.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) throw new Error('Invalid diagram');
      root.setAttribute('width', String(box[2])); root.setAttribute('height', String(box[3]));
      const scale = Math.min(2, 8192 / Math.max(box[2], box[3]), Math.sqrt(16_777_216 / (box[2] * box[3])));
      const canvas = globalThis.document.createElement('canvas'); canvas.width = Math.max(1, Math.ceil(box[2] * scale)); canvas.height = Math.max(1, Math.ceil(box[3] * scale));
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const context = canvas.getContext('2d'); if (!context) throw new Error('Image renderer unavailable');
        context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png').split(',')[1];
      } finally { URL.revokeObjectURL(url); }
    });
    queue = operation.catch(() => {}); return operation;
  },
};
send({ type: 'ready' });
