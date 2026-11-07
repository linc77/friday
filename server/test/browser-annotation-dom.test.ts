import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('Pinned browser extraction assets and synthetic DOM selection fixtures are current', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  execFileSync(process.execPath, ['scripts/build-browser-annotation-assets.mjs', '--check'], { cwd: root, timeout: 15_000, stdio: 'pipe' });
  execFileSync(process.execPath, ['scripts/test-browser-annotation-dom.mjs'], { cwd: root, timeout: 15_000, stdio: 'pipe' });
});

test('Browser recording input matches pinned key labels and excludes sensitive fields', () => {
  execFileSync(process.execPath, ['scripts/test-browser-recording-input.mjs'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), timeout: 15_000, stdio: 'pipe' });
});
