import { execFileSync } from 'node:child_process';
import { readFile, stat, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const repository = 'linc77/friday';
const build = JSON.parse(await readFile('dist/build.json', 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
if (!build.standalone || build.commit !== git('rev-parse', 'HEAD')) throw new Error('Build this committed version before publishing.');
// Do not include unrelated iOS working changes in a macOS release.
const dirty = git('status', '--porcelain', '--', 'apps/apple', 'server', 'scripts', 'release', 'skills', 'package.json', 'pnpm-lock.yaml', 'tsconfig*.json');
if (dirty) throw new Error('Commit macOS/service/release changes before publishing.');
const tag = 'v' + build.version;
const base = `Friday-${build.version}-macOS-arm64`;
const assets = [base + '.dmg', base + '.zip', 'SHA256SUMS.txt'];
const sums = await readFile('dist/releases/SHA256SUMS.txt', 'utf8');
for (const name of assets.slice(0, 2)) {
  const hash = createHash('sha256').update(await readFile('dist/releases/' + name)).digest('hex');
  if (!sums.includes(hash + '  ' + name + '\n')) throw new Error('Release checksum mismatch: ' + name);
}
let env = { ...process.env };
try { execFileSync('gh', ['api', 'user', '--jq', '.login'], { env, stdio: 'ignore' }); }
catch {
  // Use the normal Git credential helper; never log or persist its credential.
  const result = execFileSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const password = result.split('\n').find(line => line.startsWith('password='))?.slice(9);
  if (!password) throw new Error('Sign into GitHub CLI before publishing.');
  env.GH_TOKEN = password;
}
const gh = (...args) => execFileSync('gh', args, { env, encoding: 'utf8' }).trim();
const repo = JSON.parse(gh('api', `repos/${repository}`));
if (repo.private) throw new Error('The configured public update channel requires a public repository.');
git('fetch', 'origin', 'main');
git('merge-base', '--is-ancestor', 'origin/main', 'HEAD');
git('push', 'origin', 'HEAD:refs/heads/main');
// Never overwrite a released tag or asset. Interrupted drafts can be resumed manually.
const existing = JSON.parse(gh('api', `repos/${repository}/releases`)).find(item => item.tag_name === tag);
if (existing) throw new Error(`${tag} already exists. Inspect that release before retrying.`);
const notes = `release/${build.version}.md`; await stat(notes);
const url = gh('release', 'create', tag, '--repo', repository, '--target', build.commit, '--draft', '--prerelease', '--title', `Friday ${build.version}`, '--notes-file', notes, ...assets.map(name => 'dist/releases/' + name));
const release = JSON.parse(gh('api', `repos/${repository}/releases`)).find(item => item.tag_name === tag);
for (const name of assets) {
  if (release?.assets.find(asset => asset.name === name)?.size !== (await stat('dist/releases/' + name)).size) throw new Error('Uploaded asset verification failed: ' + name);
}
gh('release', 'edit', tag, '--repo', repository, '--draft=false');
// Feed publication is the final step, after the release downloads are available.
const stage = await mkdtemp(join(tmpdir(), 'friday-update-feed-'));
try {
  const branchExists = !!git('ls-remote', '--heads', 'origin', 'updates');
  const remote = git('remote', 'get-url', 'origin');
  if (branchExists) execFileSync('git', ['clone', '--depth', '1', '--branch', 'updates', remote, stage], { stdio: 'inherit' });
  else {
    execFileSync('git', ['init', '-b', 'updates', stage], { stdio: 'inherit' });
    execFileSync('git', ['-C', stage, 'remote', 'add', 'origin', remote]);
  }
  await copyFile('dist/releases/appcast.xml', join(stage, 'appcast.xml'));
  execFileSync('git', ['-C', stage, 'add', 'appcast.xml']);
  execFileSync('git', ['-C', stage, 'commit', '-m', `Publish Friday ${build.version} update feed`], { stdio: 'inherit' });
  execFileSync('git', ['-C', stage, 'push', 'origin', 'updates'], { stdio: 'inherit' });
} finally { await rm(stage, { recursive: true, force: true }); }
console.log(`Published ${url}\nUpdate feed: ${build.feedURL}`);
