import { createRequire } from 'node:module';
import { chmod, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// pnpm's --ignore-scripts intentionally skips node-pty's chmod postinstall.
// Fix the packaged helper before signing, not on first launch of the app.
export async function preparePtyRuntime(directory) {
  const require = createRequire(join(directory, 'package.json'));
  const root = dirname(require.resolve('node-pty/package.json'));
  const native = join(root, 'prebuilds', process.platform + '-' + process.arch);
  const helper = join(native, 'spawn-helper'); const addon = join(native, 'pty.node');
  await stat(addon); const info = await stat(helper); await chmod(helper, info.mode | 0o111);
  return { helper, addon, license: join(root, 'LICENSE') };
}
