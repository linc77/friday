import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const releaseNoteCategories = [
  { id: 'features', title: '新功能' },
  { id: 'improvements', title: '改进' },
  { id: 'fixes', title: '修复' },
  { id: 'updates', title: '更新' },
];

// A deliberately small format: plain-text bullets under the documented headings.
// Installation instructions and caveats stay in GitHub's full release notes.
export function parseReleaseNotes(markdown, version) {
  const build = Number(markdown.match(/^<!-- friday-build: ([1-9]\d*) -->$/m)?.[1]);
  if (!Number.isSafeInteger(build) || build < 1) throw new Error(`${version}: missing valid friday-build metadata.`);
  const sections = new Map(releaseNoteCategories.map(category => [category.id, []]));
  let category = 'updates';
  let lastItem = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      category = releaseNoteCategories.find(value => value.title === heading[1])?.id ?? null;
      lastItem = null;
    } else if (line.startsWith('- ') && category) {
      const items = sections.get(category);
      items.push(line.slice(2).trim());
      lastItem = items;
    } else if (/^\s+\S/.test(line) && lastItem) {
      lastItem[lastItem.length - 1] += ' ' + line.trim();
    } else {
      lastItem = null;
    }
  }
  const result = { version, build, sections: [...sections].filter(([, items]) => items.length).map(([category, items]) => ({ category, items })) };
  if (!result.sections.length || result.sections.some(section => section.items.some(item => !item))) {
    throw new Error(`${version}: add announcement bullets under 新功能 / 改进 / 修复.`);
  }
  return result;
}

export async function loadReleaseNotes(root, config) {
  const directory = join(root, 'release');
  const releases = [];
  for (const name of (await readdir(directory)).filter(name => /^\d+\.\d+\.\d+(?:-[\w.-]+)?\.md$/.test(name))) {
    releases.push(parseReleaseNotes(await readFile(join(directory, name), 'utf8'), name.slice(0, -3)));
  }
  if (new Set(releases.map(release => release.build)).size !== releases.length) throw new Error('Release announcement builds must be unique.');
  if (!releases.some(release => release.version === config.version && release.build === config.build)) {
    throw new Error(`Add release/${config.version}.md with friday-build: ${config.build} before building.`);
  }
  return releases.filter(release => release.build <= config.build).sort((a, b) => b.build - a.build);
}

const html = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function renderReleaseNotesHTML(releases) {
  const content = releases.map(release => `<section class="release" data-sparkle-version="${release.build}">
<h2>v${html(release.version)}</h2>
${release.sections.map(section => `<h3>${releaseNoteCategories.find(category => category.id === section.category).title} <span>${section.items.length}</span></h3>
<ul>${section.items.map(item => `<li>${html(item)}</li>`).join('')}</ul>`).join('\n')}
</section>`).join('\n');
  // Sparkle 2.10 marks the installed CFBundleVersion on matching elements.
  // Newest-first siblings let CSS hide that release and every older release,
  // including when the user skips several updates. No page scripts are needed.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<style>
body { font: 14px/1.7 -apple-system, BlinkMacSystemFont, sans-serif; margin: 20px 24px; color: #303038; }
h2 { font-size: 17px; margin: 0 0 18px; } h3 { font-size: 14px; margin: 22px 0 8px; }
span { font-weight: normal; opacity: .55; margin-left: 6px; } ul { padding-left: 22px; margin: 0; } li { margin: 8px 0; }
.release + .release { border-top: 1px solid #e7e7eb; margin-top: 28px; padding-top: 24px; }
.notice { font-size: 12px; opacity: .65; margin-top: 28px; }
.sparkle-installed-version, .sparkle-installed-version ~ .release { display: none; }
@media (prefers-color-scheme: dark) { body { color: #e7e7eb; } .release + .release { border-color: #3b3b42; } }
</style></head><body>${content}<p class="notice">个人测试版，尚未经过 Developer ID 签名和 Apple 公证。更新前请完成或停止正在执行的任务。</p></body></html>`;
}
