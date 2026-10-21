// Adapted from T3code's markdownPipeline.ts and ChatMarkdown.tsx at d9eb2b61.
// Copyright (c) 2026 T3 Tools. MIT; see the bundled T3code-LICENSE.txt.
// This is a data parser: it uses neither a document nor a browser/network runtime.
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { remarkGithubAlerts } from './t3/markdownGithubAlerts.ts';
import { remarkNormalizeListItemIndentation } from './t3/markdownListIndentation.ts';

function visit(node, fn) { fn(node); node.children?.forEach(child => visit(child, fn)); }
function remarkCodeMeta() {
  return tree => visit(tree, node => {
    if (node.type === 'code' && typeof node.meta === 'string') {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataCodeMeta: node.meta.trim() } };
    }
  });
}

function preserveBareAnchors() {
  return tree => {
    const anchors = [];
    let rawTextTag;
    visit(tree, node => {
      if (node.type !== 'raw' || typeof node.value !== 'string') return;
      const tags = /<!--[\s\S]*?(?:-->|$)|<\/?[A-Za-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/g;
      let offset = 0;
      while (rawTextTag !== 'plaintext') {
        const matcher = rawTextTag ? new RegExp(`</${rawTextTag}\\s*>`, 'gi') : tags;
        matcher.lastIndex = offset;
        const match = matcher.exec(node.value);
        if (!match) break;
        const [tag] = match;
        offset = matcher.lastIndex;
        if (rawTextTag) { rawTextTag = undefined; continue; }
        if (tag.startsWith('<!--')) continue;
        const closing = /^<\/([a-z]+)\s*>$/i.exec(tag)?.[1]?.toLowerCase();
        const opening = /^<([a-z]+)(?:\s|\/?>)/i.exec(tag)?.[1]?.toLowerCase();
        if (opening && /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/.test(opening)) rawTextTag = opening;
        else if (opening === 'a') anchors.push(node.value === tag && /^<a\s*\/?>$/i.test(tag) ? node : null);
        else if (closing === 'a') anchors.pop();
      }
    });
    for (const anchor of anchors) if (anchor) anchor.type = 'text';
  };
}
function preserveImageTitles() {
  return tree => visit(tree, node => {
    if (node.type === 'element' && node.tagName === 'img' && typeof node.properties?.title === 'string') {
      node.properties = { ...node.properties, dataMarkdownTitle: node.properties.title };
    }
  });
}
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    '*': (defaultSchema.attributes?.['*'] ?? []).filter(attribute => attribute !== 'title'),
    code: [...(defaultSchema.attributes?.code ?? []), 'dataCodeMeta', 'dataInlineCode'],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), 'dataAlert'],
    a: [...(defaultSchema.attributes?.a ?? []), 'dataPullRequestAutolink'],
    img: [...(defaultSchema.attributes?.img ?? []), 'dataLocalSrc', 'dataMarkdownTitle', 'dataStandalone'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), 'file', 't3-citation', 't3-context', 't3-thread'],
    src: [...(defaultSchema.protocols?.src ?? []), 'file', 't3-context'],
  },
};
function plainText(node) { return node.value ?? (node.children ?? []).map(plainText).join(''); }
function headingIds() {
  return tree => {
    const taken = new Set();
    visit(tree, node => { if (typeof node.properties?.id === 'string') taken.add(node.properties.id); });
    const suffixes = new Map();
    visit(tree, node => {
      if (!/^h[1-6]$/.test(node.tagName ?? '') || node.properties?.id !== undefined) return;
      const slug = plainText(node).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-');
      if (!slug) return;
      let count = suffixes.get(slug) ?? 0, id = `user-content-${slug}`;
      while (taken.has(id)) { count += 1; id = `user-content-${slug}-${count}`; }
      suffixes.set(slug, count); taken.add(id); node.properties = { ...node.properties, id };
    });
  };
}
const parser = unified().use(remarkParse).use(remarkGfm).use(remarkGithubAlerts)
  .use(remarkNormalizeListItemIndentation).use(remarkCodeMeta)
  .use(remarkRehype, { allowDangerousHtml: true }).use(preserveBareAnchors).use(rehypeRaw)
  .use(preserveImageTitles).use(rehypeSanitize, schema).use(headingIds);

globalThis.fridayParseMarkdown = source => {
  const parsed = parser.parse(source), taskMarkers = new Map();
  // remark omits a leading BOM from every source offset, while the editor keeps it.
  const sourceOffset = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  visit(parsed, node => {
    if (node.type !== 'listItem' || typeof node.checked !== 'boolean' || !Number.isSafeInteger(node.position?.start?.offset)) return;
    const parsedStart = node.position.start.offset, start = parsedStart + sourceOffset;
    const marker = /^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(\[[ xX]\])(?=[ \t\r\n]|$)/.exec(source.slice(start));
    if (marker) taskMarkers.set(parsedStart, start + marker[1].length);
  });
  const tree = parser.runSync(parsed, source);
  let imageIndex = 0;
  // Add only our own source markers after sanitization; raw HTML cannot forge them.
  const clean = node => ({ type: node.type, ...(node.tagName ? { tagName: node.tagName } : {}),
    ...(typeof node.value === 'string' ? { value: node.value } : {}),
    ...(node.properties ? { properties: { ...node.properties, ...(node.tagName === 'img' ? { dataFridayImageID: String(imageIndex++) } : {}),
      ...(node.tagName === 'li' && taskMarkers.has(node.position?.start?.offset) ? { dataFridayTaskMarker: taskMarkers.get(node.position.start.offset) } : {}) } } : {}),
    ...(node.children ? { children: node.children.map(clean) } : {}) });
  return JSON.stringify(clean(tree));
};
