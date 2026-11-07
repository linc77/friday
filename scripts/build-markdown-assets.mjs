import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resources = join(root, 'apps/apple/Sources/FridayKit/Resources');
async function licenses(metafile) {
  const packages = new Map();
  for (const path of Object.keys(metafile.inputs)) {
    if (!path.includes('node_modules/')) continue;
    let directory = dirname(resolve(root, path));
    while (directory !== dirname(directory)) {
      try {
        const value = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
        if (value.name && value.version) { packages.set(value.name + '@' + value.version, { directory, value }); break; }
      } catch {}
      directory = dirname(directory);
    }
  }
  const notices = [];
  for (const [name, { directory, value }] of [...packages].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const documents = [];
    for (const file of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'license', 'license.md', 'COPYING', 'NOTICE', 'NOTICE.md', 'NOTICE.txt']) {
      try { documents.push(await readFile(join(directory, file), 'utf8')); } catch {}
    }
    if (!documents.length) {
      for (const file of ['README.md', 'readme.md']) {
        try { const text = await readFile(join(directory, file), 'utf8'); const found = text.match(/^#{1,2}\s+Licen[cs]e\b[^\n]*\n[\s\S]*/im); if (found) { documents.push(found[0]); break; } } catch {}
      }
    }
    if (!documents.length) throw new Error('Missing bundled library license: ' + name + ' (' + value.license + ')');
    notices.push(name + '\n' + documents.join('\n'));
  }
  return notices.join('\n\n--------------------\n\n').trimEnd() + '\n';
}
for (const [entry, name, notice] of [
  ['highlighter.mjs', 'CodeHighlighter.js', 'CodeHighlightingLicenses.txt'],
  ['mermaid.mjs', 'MermaidRenderer.js', 'MermaidLicenses.txt'],
  ['markdown.mjs', 'MarkdownParser.js', 'MarkdownParserLicenses.txt'],
]) {
  const result = await build({ absWorkingDir: root, entryPoints: [join(root, 'scripts/markdown-highlighting', entry)], bundle: true,
    write: false, minify: true, metafile: true, platform: entry === 'markdown.mjs' ? 'neutral' : 'browser',
    ...(entry === 'markdown.mjs' ? { mainFields: ['module', 'main'] } : {}),
    format: 'iife', target: 'safari17', supported: { 'template-literal': false }, legalComments: 'inline' });
  if (Object.values(result.metafile.outputs).some(output => output.imports.some(value => value.external))) throw new Error('Native Markdown rendering must remain offline');
  const outputs = { [name]: result.outputFiles[0].text.trimEnd() + '\n', [notice]: await licenses(result.metafile) };
  for (const [file, source] of Object.entries(outputs)) {
    const path = join(resources, file);
    if (process.argv.includes('--check')) { if (await readFile(path, 'utf8').catch(() => '') !== source) throw new Error('Outdated Markdown asset: ' + file); }
    else if (await readFile(path, 'utf8').catch(() => '') !== source) await writeFile(path, source);
  }
  console.log('Native Markdown asset verified: ' + name + ' (' + Buffer.byteLength(outputs[name]) + ' bytes)');
}
