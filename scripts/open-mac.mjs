import { execFileSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macAppIdentity } from './mac-app-identity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = process.argv.includes('--standalone');
const identity = macAppIdentity(root, { standalone });
try {
  await access(join(identity.appPath, 'Contents/MacOS', identity.executable), constants.X_OK);
} catch {
  execFileSync(process.execPath, [join(root, 'scripts/build-mac.mjs'), ...(standalone ? ['--standalone'] : [])], { stdio: 'inherit' });
}
execFileSync('/usr/bin/open', [identity.appPath], { stdio: 'inherit' });
