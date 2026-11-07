import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { macSwiftBuildArguments } from './mac-swift-build.mjs';

// Exercise the real generated Bundle.module accessor without opening Friday,
// starting its service, or compiling the full application.
const directory = await mkdtemp(join(tmpdir(), 'friday-resource-test-'));
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  const source = join(directory, 'Sources/ResourceProbe');
  await mkdir(join(source, 'Resources'), { recursive: true });
  await writeFile(join(directory, 'Package.swift'), `// swift-tools-version: 5.10
import PackageDescription
let package = Package(name: "ResourceProbe", defaultLocalization: "en", targets: [
    .executableTarget(name: "ResourceProbe", resources: [.process("Resources")])
])
`);
  await writeFile(join(source, 'Resources/sentinel.txt'), 'Friday packaged resources');
  await writeFile(join(source, 'main.swift'), `import Foundation
let bundle = Bundle.module
let url = bundle.url(forResource: "sentinel", withExtension: "txt")!
let text = try String(contentsOf: url, encoding: .utf8)
precondition(text == "Friday packaged resources")
print(bundle.bundleURL.path)
`);
  // Both development previews and releases use the same packaging code.
  for (const configuration of ['debug', 'release']) {
    const buildArguments = macSwiftBuildArguments(directory, configuration);
    run('swift', buildArguments);
    const bin = run('swift', [...buildArguments, '--show-bin-path']);
    const app = join(directory, `${configuration}.app`);
    const contents = join(app, 'Contents');
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await mkdir(join(contents, 'Resources'), { recursive: true });
    await cp(join(bin, 'ResourceProbe'), join(contents, 'MacOS/ResourceProbe'));
    await cp(join(bin, 'ResourceProbe_ResourceProbe.bundle'), join(contents, 'Resources/ResourceProbe_ResourceProbe.bundle'), { recursive: true });
    await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>ResourceProbe</string>
<key>CFBundleIdentifier</key><string>dev.friday.resource-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
    run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    const archive = join(directory, `${configuration}.zip`);
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
    await rm(app, { recursive: true });
    // Prevent a checkout resource fallback from making the test pass falsely.
    await rm(join(directory, '.build'), { recursive: true });
    const installed = join(directory, 'installed');
    run('/usr/bin/ditto', ['-x', '-k', archive, installed]);
    const installedApp = join(installed, `${configuration}.app`);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installedApp]);
    const loadedPath = run(join(installedApp, 'Contents/MacOS/ResourceProbe'), []);
    assert.equal(loadedPath, join(installedApp, 'Contents/Resources/ResourceProbe_ResourceProbe.bundle'));
  }
  console.log('Debug and Release apps load Bundle.module from signed, relocated ZIPs with the build directory removed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
