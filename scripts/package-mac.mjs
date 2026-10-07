import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url))); process.chdir(root);
const config = JSON.parse(await readFile('dist/build.json', 'utf8'));
if (!config.standalone) throw new Error('Build with --standalone before packaging.');
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
<description><![CDATA[<p>个人测试版，尚未经过 Developer ID 签名和 Apple 公证。</p><p>包含原生客户端、内置 Node 和后台服务。更新前请完成或停止正在执行的任务。</p>]]></description>
<sparkle:version>${config.build}</sparkle:version><sparkle:shortVersionString>${config.version}</sparkle:shortVersionString>
<sparkle:minimumSystemVersion>${config.minimumSystemVersion}</sparkle:minimumSystemVersion>
<enclosure url="https://github.com/linc77/friday/releases/download/${tag}/${basename}.zip" sparkle:edSignature="${signature}" length="${size}" type="application/octet-stream"/>
</item></channel></rss>\n`;
await writeFile(join(output, 'appcast.xml'), appcast);
const stage = join(root, 'dist/dmg-stage'); await rm(stage, { recursive: true, force: true }); await mkdir(stage, { recursive: true });
run('/usr/bin/ditto', ['dist/Friday.app', join(stage, 'Friday.app')]);
run('/bin/ln', ['-s', '/Applications', join(stage, 'Applications')]);
await writeFile(join(stage, '安装说明.txt'), 'Friday 个人测试版（Apple Silicon，macOS 14+）\n\n将 Friday 拖入 Applications，然后从应用程序目录打开。\n如 macOS 阻止打开此未公证的测试版，请在系统设置 → 隐私与安全性中允许这次打开。\n允许 Friday 在系统登录项中后台运行。\n菜单 Friday → 软件更新与后台服务 可检查更新和管理服务。\n退出窗口不会停止后台服务；停止服务可在上述窗口操作，数据会保留。\n');
const dmg = join(output, basename + '.dmg'); await rm(dmg, { force: true });
run('/usr/bin/hdiutil', ['create', '-volname', 'Friday', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
let checksums = '';
for (const path of [zip, dmg]) checksums += createHash('sha256').update(await readFile(path)).digest('hex') + '  ' + path.split('/').at(-1) + '\n';
await writeFile(join(output, 'SHA256SUMS.txt'), checksums);
console.log(`Packaged ${dmg}\nUpdate feed: ${join(output, 'appcast.xml')}`);
