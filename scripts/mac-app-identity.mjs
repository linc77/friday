import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Use the checkout directory, not its mutable branch or commit, as its identity.
export function macAppIdentity(root, { standalone = false } = {}) {
  if (standalone) {
    return { name: 'Friday', executable: 'Friday', bundleIdentifier: 'dev.friday.mac', appPath: join(root, 'dist/Friday.app') };
  }

  const checkout = realpathSync(root);
  const gitPath = flag => resolve(checkout, execFileSync('git', ['rev-parse', flag], {
    cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim());
  const isWorktree = gitPath('--git-dir') !== gitPath('--git-common-dir');
  const workspace = isWorktree
    ? (basename(dirname(dirname(checkout))) === 'worktrees' ? basename(dirname(checkout)) : basename(checkout))
    : 'main';
  const hash = createHash('sha256').update(checkout).digest('hex').slice(0, 12);
  const slug = workspace.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || hash;
  const executable = `Friday-${slug}`;
  return {
    name: `Friday · ${workspace}`,
    executable,
    bundleIdentifier: `dev.friday.mac.workspace.${hash}`,
    appPath: join(root, `dist/${executable}.app`),
    workspace,
  };
}
