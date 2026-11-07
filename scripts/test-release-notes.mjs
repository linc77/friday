import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { loadReleaseNotes, parseReleaseNotes, renderReleaseNotesHTML } from './release-notes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await readFile(join(root, 'release/macos.json'), 'utf8'));
const sample = `# Friday\r\n<!-- friday-build: 42 -->\r\n\r\n## 新功能\r\n- New feature <script>alert('x')</script> & ]]>\r\n  Wrapped detail.\r\n## 改进\r\n- Better layout\r\n## 修复\r\n- Fixed issue\r\n## 安装与更新\r\n- This instruction is not a feature\r\n`;
const parsed = parseReleaseNotes(sample, '0.42.0');
assert.equal(parsed.build, 42);
assert.deepEqual(parsed.sections.map(section => section.category), ['features', 'improvements', 'fixes']);
assert.ok(parsed.sections[0].items[0].endsWith('Wrapped detail.'));
assert.equal(parsed.sections.flatMap(section => section.items).length, 3);
assert.throws(() => parseReleaseNotes('# No metadata\n- Item', '1.0.0'), /friday-build/);
assert.throws(() => parseReleaseNotes('<!-- friday-build: 0 -->\n- Item', '1.0.0'), /friday-build/);
assert.throws(() => parseReleaseNotes('<!-- friday-build: 1 -->\n## 安装\n- Install', '1.0.0'), /announcement bullets/);
assert.throws(() => parseReleaseNotes('<!-- friday-build: 1 -->\n- ', '1.0.0'), /announcement bullets/);
assert.equal(parseReleaseNotes('<!-- friday-build: 1 -->\n- Legacy release\n## 安装\n- Install', '1.0.0').sections[0].category, 'updates');

const releases = await loadReleaseNotes(root, config);
assert.equal(releases[0].version, config.version);
assert.equal(releases[0].build, config.build);
assert.ok(releases.length > 1);
const older = await loadReleaseNotes(root, { ...config, ...releases.at(-1) });
assert.equal(older.length, 1, 'Old builds must never bundle future announcements');
await assert.rejects(loadReleaseNotes(root, { ...config, version: '999.0.0' }), /before building/);
const dom = new JSDOM(renderReleaseNotesHTML(releases));
const installed = dom.window.document.querySelector(`[data-sparkle-version="${releases[1].build}"]`);
installed.classList.add('sparkle-installed-version');
const hidden = [...dom.window.document.querySelectorAll('.sparkle-installed-version, .sparkle-installed-version ~ .release')];
assert.deepEqual(hidden.map(element => Number(element.dataset.sparkleVersion)), releases.slice(1).map(release => release.build), 'Sparkle must hide installed and older versions');
const safeHTML = renderReleaseNotesHTML([parsed]);
assert.ok(!safeHTML.includes('<script>') && !safeHTML.includes(']]>'), 'Announcement text must not inject HTML or break appcast CDATA');
const safeDOM = new JSDOM(safeHTML);
assert.equal(safeDOM.window.document.querySelector('li').textContent, parsed.sections[0].items[0]);
assert.equal(safeDOM.window.document.querySelectorAll('script, img, iframe').length, 0);

const temporary = await mkdtemp(join(tmpdir(), 'friday-release-notes-check-'));
try {
  const catalogue = join(temporary, 'ReleaseNotes.json');
  const binary = join(temporary, 'check');
  await writeFile(catalogue, JSON.stringify(releases));
  execFileSync('swiftc', ['-parse-as-library', join(root, 'apps/apple/Sources/FridayMac/ReleaseNotes.swift'),
    join(root, 'apps/apple/Tests/FridayKitTests/ReleaseNotesTests.swift'), '-o', binary], { stdio: 'inherit' });
  execFileSync(binary, [catalogue], { stdio: 'inherit' });
  console.log('Release Markdown parsing, category counts, current version validation, Sparkle version filtering and safe HTML generation passed.');
} finally {
  dom.window.close(); safeDOM.window.close();
  await rm(temporary, { recursive: true, force: true });
}
