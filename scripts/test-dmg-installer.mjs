import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = await mkdtemp(join(tmpdir(), 'friday-dmg-check-'));
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
try {
  const source = join(root, 'scripts/dmg-installer.swift');
  const installer = join(work, 'installer');
  const checks = join(work, 'checks');
  run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-target', 'arm64-apple-macosx14.0', source, join(root, 'scripts/dmg-installer-window.swift'), '-o', installer]);
  run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-D', 'FRIDAY_INSTALLER_TEST', source, join(root, 'scripts/test-dmg-installer.swift'), '-o', checks]);
  run(checks, [installer]);
} finally { await rm(work, { recursive: true, force: true }); }
