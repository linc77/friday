import { cp, mkdir, readFile, rm, writeFile, readdir, readlink, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { macAppIdentity } from './mac-app-identity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);
const config = JSON.parse(await readFile('release/macos.json', 'utf8'));
const standalone = process.argv.includes('--standalone');
const identity = macAppIdentity(root, { standalone });
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const output = (command, args) => execFileSync(command, args, { encoding: 'utf8' }).trim();
if (process.platform !== 'darwin' || process.arch !== config.architecture) throw new Error('This release targets Apple Silicon macOS.');
if (standalone && !config.publicKey) throw new Error('Configure the Sparkle public key in release/macos.json first.');
run('swift', ['build', '--package-path', 'apps/apple', '-c', 'release']);
const bin = output('swift', ['build', '--package-path', 'apps/apple', '-c', 'release', '--show-bin-path']);
const app = identity.appPath;
await rm(app, { recursive: true, force: true });
const contents = join(app, 'Contents');
await mkdir(join(contents, 'MacOS'), { recursive: true });
await mkdir(join(contents, 'Resources'), { recursive: true });
await mkdir(join(contents, 'Frameworks'), { recursive: true });
await cp(join(bin, 'Friday'), join(contents, 'MacOS', identity.executable));
await cp('apps/apple/Info-mac.plist', join(contents, 'Info.plist'));
await cp('apps/apple/Assets/Friday.icns', join(contents, 'Resources/Friday.icns'));
await cp(join(bin, 'Friday_FridayKit.bundle'), join(contents, 'Resources/Friday_FridayKit.bundle'), { recursive: true });
const framework = join(root, 'apps/apple/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework');
run('/usr/bin/ditto', [framework, join(contents, 'Frameworks/Sparkle.framework')]);
const plist = (key, type, value) => run('/usr/bin/plutil', ['-replace', key, '-' + type, String(value), join(contents, 'Info.plist')]);
plist('CFBundleName', 'string', identity.name);
plist('CFBundleDisplayName', 'string', identity.name);
plist('CFBundleExecutable', 'string', identity.executable);
plist('CFBundleIdentifier', 'string', identity.bundleIdentifier);
plist('CFBundleShortVersionString', 'string', config.version);
plist('CFBundleVersion', 'string', config.build);
if (standalone) {
  const vendor = join(root, 'dist/vendor');
  await mkdir(vendor, { recursive: true });
  const archive = `node-v${config.nodeVersion}-darwin-arm64.tar.xz`;
  const archivePath = join(vendor, archive);
  try { await stat(archivePath); } catch { run('curl', ['--fail', '--location', '--retry', '3', `https://nodejs.org/dist/v${config.nodeVersion}/${archive}`, '-o', archivePath]); }
  const hash = createHash('sha256').update(await readFile(archivePath)).digest('hex');
  if (hash !== config.nodeSHA256) throw new Error('Node archive checksum mismatch.');
  run('tar', ['-xf', archivePath, '-C', vendor]);
  await cp(join(vendor, `node-v${config.nodeVersion}-darwin-arm64/bin/node`), join(contents, 'MacOS/node'));
  await cp(join(bin, 'FridayService'), join(contents, 'MacOS/FridayService'));
  await rm('dist/runtime', { recursive: true, force: true });
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.release.json']);
  await cp('skills', 'dist/runtime/skills', { recursive: true });
  await cp('package.json', 'dist/runtime/package.json');
  await cp('pnpm-lock.yaml', 'dist/runtime/pnpm-lock.yaml');
  run('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--dir', 'dist/runtime']);
  await rm('dist/runtime/pnpm-lock.yaml');
  await cp('dist/runtime', join(contents, 'Resources/runtime'), { recursive: true, verbatimSymlinks: true });
  await cp(join(vendor, `node-v${config.nodeVersion}-darwin-arm64/LICENSE`), join(contents, 'Resources/Node-LICENSE'));
  const sparkleLicense = join(root, 'apps/apple/.build/checkouts/Sparkle/LICENSE');
  await cp(sparkleLicense, join(contents, 'Resources/Sparkle-LICENSE'));
  plist('SUFeedURL', 'string', config.feedURL);
  plist('SUPublicEDKey', 'string', config.publicKey);
  plist('SUEnableAutomaticChecks', 'bool', true);
  plist('SUAutomaticallyUpdate', 'bool', false);
  plist('SUAllowsAutomaticUpdates', 'bool', false);
  plist('SUVerifyUpdateBeforeExtraction', 'bool', true);
}
// Reject symlinks that would make the installed bundle depend on the checkout.
async function verifyLinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const destination = resolve(dirname(path), await readlink(path));
      if (!destination.startsWith(app + '/')) throw new Error(`External bundle symlink: ${path}`);
      await stat(path);
    } else if (entry.isDirectory()) await verifyLinks(path);
  }
}
await verifyLinks(app);
// Personal preview only. A Developer ID release needs the notarized signing pipeline.
run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
await writeFile('dist/build.json', JSON.stringify({ ...config, standalone, appName: identity.name, bundleIdentifier: identity.bundleIdentifier, workspace: identity.workspace, commit: output('git', ['rev-parse', 'HEAD']) }, null, 2) + '\n');
console.log(`Built ${app}${standalone ? ' (self-contained personal preview)' : ' (development client)'}`);
