import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderReleaseNotesHTML } from './release-notes.mjs';
import { buildDmg } from './build-dmg.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))); process.chdir(root);
const config = JSON.parse(await readFile('dist/build.json', 'utf8'));
if (!config.standalone) throw new Error('Build with --standalone before packaging.');
const releaseNotes = JSON.parse(await readFile('dist/Friday.app/Contents/Resources/ReleaseNotes.json', 'utf8'));
if (releaseNotes[0]?.build !== config.build || releaseNotes[0]?.version !== config.version) throw new Error('Bundled release notes do not match this build.');
const announcement = renderReleaseNotesHTML(releaseNotes);
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const tools = process.env.FRIDAY_SPARKLE_TOOLS ?? 'apps/apple/.build/artifacts/sparkle/Sparkle/bin';
const output = join(root, 'dist/releases'); await mkdir(output, { recursive: true });
const basename = `Friday-${config.version}-macOS-arm64`;
const zip = join(output, basename + '.zip');
await rm(zip, { force: true });
run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', 'dist/Friday.app', zip]);
const publicKey = execFileSync(join(tools, 'generate_keys'), ['--account', config.sparkleKeyAccount, '-p'], { encoding: 'utf8' }).trim();
if (publicKey !== config.publicKey) throw new Error('The signing key does not match the public key embedded in this app.');
const signature = execFileSync(join(tools, 'sign_update'), ['--account', config.sparkleKeyAccount, '-p', zip], { encoding: 'utf8' }).trim();
run(join(tools, 'sign_update'), ['--account', config.sparkleKeyAccount, '--verify', zip, signature]);
const size = (await stat(zip)).size;
const tag = `v${config.version}`;
const appcast = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>
<title>Friday Personal Preview</title><link>https://github.com/linc77/friday</link><description>Friday macOS updates</description><language>zh-CN</language>
<item><title>Friday ${config.version}</title><pubDate>${new Date().toUTCString()}</pubDate>
<description><![CDATA[${announcement}]]></description>
<sparkle:version>${config.build}</sparkle:version><sparkle:shortVersionString>${config.version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>${config.minimumSystemVersion}</sparkle:minimumSystemVersion>
<enclosure url="https://github.com/linc77/friday/releases/download/${tag}/${basename}.zip" sparkle:edSignature="${signature}" length="${size}" type="application/octet-stream"/>
</item></channel></rss>\n`;
await writeFile(join(output, 'appcast.xml'), appcast);
const dmg = join(output, basename + '.dmg');
await buildDmg({ appPath: join(root, 'dist/Friday.app'), outputPath: dmg });
let checksums = '';
for (const path of [zip, dmg]) checksums += createHash('sha256').update(await readFile(path)).digest('hex') + '  ' + path.split('/').at(-1) + '\n';
await writeFile(join(output, 'SHA256SUMS.txt'), checksums);
console.log(`Packaged ${dmg}\nUpdate feed: ${join(output, 'appcast.xml')}`);
