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
const environment = standalone ? [] : ['FRIDAY_SERVER_URL', 'FRIDAY_DATA_DIR']
  .filter(key => process.env[key] !== undefined)
  .flatMap(key => ['--env', `${key}=${process.env[key]}`]);
// LaunchServices does not propagate the caller's environment by itself.
execFileSync('/usr/bin/open', [...(environment.length ? ['-n'] : []), identity.appPath, ...environment], { stdio: 'inherit' });
