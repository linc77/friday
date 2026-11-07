import { execFileSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macAppIdentity } from './mac-app-identity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });

// Only this temporary mounted image is configured. Never change global Finder settings.
const finderLayout = `on run argv
    set volumeFolder to POSIX file (item 1 of argv) as alias
    set appName to item 2 of argv
    tell application "Finder"
        set volumeFolder to item volumeFolder
        open volumeFolder
        tell container window of volumeFolder
            set current view to icon view
            set toolbar visible to false
            set statusbar visible to false
            set pathbar visible to false
            set bounds to {160, 100, 760, 428}
            tell icon view options of container window of volumeFolder
                set arrangement to not arranged
                set icon size to 128
                set text size to 14
                set label position to bottom
                set shows item info to false
                set shows icon preview to false
                set background color to {65535, 65535, 65535}
            end tell
        end tell
        set position of item appName of volumeFolder to {300, 135}
        set extension hidden of item appName of volumeFolder to true
        update volumeFolder without registering applications
        delay 1
        close container window of volumeFolder
    end tell
end run`;

export async function buildDmg({ appPath, outputPath, volumeName = 'Friday', previewAppPath }) {
  // Validate before creating any packaging work or touching an existing output.
  await access(join(appPath, 'Contents/Info.plist'));
  await mkdir(join(root, 'dist'), { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  const work = await mkdtemp(join(root, 'dist/dmg-work-'));
  const stage = join(work, 'stage');
  const mount = join(work, 'mount');
  const writable = join(work, 'writable.dmg');
  const appName = basename(appPath);
  let mounted = false;
  try {
    await mkdir(stage, { recursive: true });
    await mkdir(mount);
    // Finder supplies only an entry point. The resizable installation UI lives
    // in the native installer, with the original signed app retained as payload.
    const installer = join(stage, appName);
    const contents = join(installer, 'Contents');
    const resources = join(contents, 'Resources');
    await mkdir(join(resources, 'Payload'), { recursive: true });
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    run('/usr/bin/ditto', [appPath, join(resources, 'Payload', appName)]);
    await copyFile(join(root, 'apps/apple/Assets/Friday.icns'), join(resources, 'Friday.icns'));
    const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Contents/Info.plist')], { encoding: 'utf8', stdio: 'pipe' }));
    await writeFile(join(contents, 'Info.plist'), JSON.stringify({
      CFBundleExecutable: 'FridayInstaller', CFBundleIdentifier: info.CFBundleIdentifier + '.installer',
      CFBundleName: info.CFBundleName + ' · 安装', CFBundleDisplayName: info.CFBundleDisplayName + ' · 安装',
      CFBundlePackageType: 'APPL', CFBundleIconFile: 'Friday',
      CFBundleShortVersionString: info.CFBundleShortVersionString, CFBundleVersion: info.CFBundleVersion,
      LSMinimumSystemVersion: '14.0', NSHighResolutionCapable: true,
      FridayPayloadName: appName, FridayProductName: info.CFBundleDisplayName,
    }));
    run('/usr/bin/plutil', ['-convert', 'xml1', join(contents, 'Info.plist')]);
    run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', 'arm64-apple-macosx14.0', join(root, 'scripts/dmg-installer.swift'), join(root, 'scripts/dmg-installer-window.swift'), '-o', join(contents, 'MacOS/FridayInstaller')]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', installer]);
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installer]);
    await copyFile(join(root, 'apps/apple/Assets/Friday.icns'), join(stage, '.VolumeIcon.icns'));
    const kibibytes = Number(run('/usr/bin/du', ['-sk', stage], { encoding: 'utf8', stdio: 'pipe' }).split(/\s/)[0]);
    run('/usr/bin/hdiutil', ['create', '-volname', volumeName, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDRW', '-size', `${kibibytes + 32768}k`, writable]);
    run('/usr/bin/hdiutil', ['attach', writable, '-mountpoint', mount, '-nobrowse', '-noautoopen']);
    mounted = true;
    run('/usr/bin/xcrun', ['SetFile', '-a', 'C', mount]);
    run('/usr/bin/osascript', ['-e', finderLayout, mount, appName]);
    // Finder persists the compact entry window; all artwork is drawn in the app.
    if ((await stat(join(mount, '.DS_Store'))).size === 0) throw new Error('Finder did not save the DMG layout.');
    run('/bin/sync', []);
    run('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
    // Keep an existing artifact intact if rendering, mounting or layout fails.
    const compressed = join(work, 'compressed.dmg');
    run('/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-o', compressed]);
    run('/usr/bin/hdiutil', ['verify', compressed]);
    run('/bin/mv', ['-f', compressed, outputPath]);
    console.log(`Created ${outputPath}`);
    if (previewAppPath) {
      await rm(previewAppPath, { recursive: true, force: true });
      run('/usr/bin/ditto', [installer, previewAppPath]);
      console.log(`Native installer preview: ${previewAppPath}`);
    }
  } finally {
    if (mounted) {
      // Do not force-unmount or delete a directory that may still contain a mounted volume.
      try { run('/usr/bin/hdiutil', ['detach', mount]); mounted = false; }
      catch { console.error(`Could not unmount ${mount}; packaging files remain at ${work}`); }
    }
    if (!mounted) await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--preview')) throw new Error('Use --preview for a workspace DMG; releases are packaged by package-mac.mjs.');
  const identity = macAppIdentity(root);
  const outputPath = join(root, `dist/Friday-${identity.workspace}-install-preview.dmg`);
  const previewAppPath = join(root, `dist/Friday-${identity.workspace}-Installer.app`);
  // Reopening an overwritten DMG can otherwise keep showing its old mounted inode.
  // Detach only a previous preview of this exact workspace; never force an eject.
  const images = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
    input: run('/usr/bin/hdiutil', ['info', '-plist'], { stdio: 'pipe' }),
    encoding: 'utf8', stdio: 'pipe',
  })).images;
  for (const image of images) {
    if (image['image-path'] !== outputPath) continue;
    const volume = image['system-entities'].find(entry => entry['mount-point']);
    if (volume) run('/usr/bin/hdiutil', ['detach', volume['mount-point']]);
  }
  await buildDmg({
    appPath: identity.appPath,
    volumeName: identity.name,
    outputPath,
    previewAppPath,
  });
  // Opening the installer shows its ready state; installation requires a user action.
  run('/usr/bin/open', ['-n', previewAppPath]);
}
