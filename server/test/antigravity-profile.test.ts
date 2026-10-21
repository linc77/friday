import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readlink, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { prepareAntigravityProfile, antigravityEnvironment, antigravityAuthIssue, antigravityClientFile, antigravityBrowserMarker, type AntigravityAuthConfig } from '../src/antigravity-profile.js';
import { antigravityOutput } from '../src/antigravity-output.js';
const personal: AntigravityAuthConfig = { authMethod: 'oauth-personal', apiKey: '', gcpProject: '', gcpLocation: '' };
async function directory(t: { after(fn: () => Promise<unknown>): void }) { const path = await mkdtemp(join(tmpdir(), 'friday-antigravity-profile-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
test('Antigravity creates isolated private profiles and links only the native user Skill directories, keeping credentials out of settings and inherited auth out of its environment', async t => {
  const directoryPath = await directory(t), home = join(directoryPath, 'home'); await mkdir(join(home, '.gemini'), { recursive: true }); await writeFile(join(home, '.gemini/settings.json'), 'global fixture settings');
  const profile = await prepareAntigravityProfile(directoryPath, 'Instance', personal, { ...process.env, HOME: home, GOOGLE_API_KEY: 'inherited-key', google_application_credentials: 'inherited-file', BROWSER: 'must-not-launch' });
  assert.equal((await stat(profile.geminiHome)).mode & 0o777, 0o700); assert.equal((await stat(join(profile.acpDirectory, 'settings.json'))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(profile.acpDirectory, 'settings.json'), 'utf8')), { auth: { type: 'oauth-personal' } }); assert.equal(await readFile(join(home, '.gemini/settings.json'), 'utf8'), 'global fixture settings');
  assert.equal(await readlink(join(profile.geminiHome, 'config/skills')), join(home, '.gemini/config/skills')); assert.equal(await readlink(join(profile.geminiHome, 'antigravity-cli/skills')), join(home, '.gemini/antigravity-cli/skills'));
  const env = antigravityEnvironment(profile, personal, { GOOGLE_API_KEY: 'inherited-key', google_application_credentials: 'inherited-file', OTHER: 'keep' }); assert.equal(env.GOOGLE_API_KEY, undefined); assert.equal(env.google_application_credentials, undefined); assert.equal(env.OTHER, 'keep'); assert.ok(env.BROWSER?.includes(antigravityBrowserMarker));
  const another = await prepareAntigravityProfile(directoryPath, 'instance', personal, { ...process.env, HOME: home }); assert.notEqual(another.geminiHome, profile.geminiHome);
});
test('Antigravity uses the selected key or native GCP settings without mixing auth methods', async t => {
  const path = await directory(t), auth = { ...personal, authMethod: 'agent-platform' as const, gcpProject: 'fixture-project', gcpLocation: 'fixture-region' }, profile = await prepareAntigravityProfile(path, 'gcp', auth);
  const env = antigravityEnvironment(profile, auth, { GOOGLE_API_KEY: 'inherited-key', GOOGLE_CLOUD_PROJECT: 'wrong-project', GEMINI_API_KEY: 'wrong-key' }); assert.equal(env.GOOGLE_API_KEY, undefined); assert.equal(env.GOOGLE_CLOUD_PROJECT, undefined); assert.equal(env.GEMINI_API_KEY, undefined);
  assert.deepEqual(JSON.parse(await readFile(join(profile.acpDirectory, 'settings.json'), 'utf8')).gcp, { project: 'fixture-project', location: 'fixture-region' });
  assert.equal(antigravityEnvironment(profile, { ...personal, authMethod: 'gemini-api-key', apiKey: 'fixture-selected' }).GEMINI_API_KEY, 'fixture-selected'); assert.equal(antigravityEnvironment(profile, { ...personal, authMethod: 'agent-platform', apiKey: 'fixture-platform' }).GOOGLE_API_KEY, 'fixture-platform'); assert.ok(antigravityAuthIssue({ ...personal, authMethod: 'oauth-business' }));
});
test('Antigravity browser URLs are removed from stdout before SDK framing while split UTF-8 protocol messages are preserved', async () => {
  const urls: string[] = [], filters = antigravityOutput(value => urls.push(value)), protocol = '{"jsonrpc":"2.0","method":"session/update","params":{"text":"café"}}\n', bytes = Buffer.from('Open the following link to authenticate the ACP server: https://accounts.example.test/login?state=fixture\n' + protocol), received: Buffer[] = [];
  filters.stdout.on('data', value => received.push(value)); await pipeline(Readable.from([bytes.subarray(0, 40), bytes.subarray(40, bytes.length - 4), bytes.subarray(bytes.length - 4)]), filters.stdout); assert.equal(Buffer.concat(received).toString(), protocol); assert.deepEqual(urls, ['https://accounts.example.test/login?state=fixture']);
  const stderr = Buffer.from('diagnostic\n' + antigravityBrowserMarker + JSON.stringify('https://accounts.example.test/native') + '\n'); for (const chunk of stderr) filters.stderr(Buffer.from([chunk])); assert.equal(urls[1], 'https://accounts.example.test/native');
});
test('Antigravity client file requests retain native line slicing and cannot follow workspace links outside the task directory', async t => {
  const path = await directory(t), cwd = join(path, 'workspace'), outside = join(path, 'outside'); await mkdir(cwd); await mkdir(outside); await writeFile(join(outside, 'private'), 'outside fixture'); await symlink(outside, join(cwd, 'escape'), 'dir');
  const file = join(cwd, 'nested/new.txt'); await antigravityClientFile(cwd, 'fs/write_text_file', { path: file, content: 'one\ntwo\nthree' }); assert.deepEqual(await antigravityClientFile(cwd, 'fs/read_text_file', { path: file, line: 2, limit: 1 }), { content: 'two' });
  await assert.rejects(antigravityClientFile(cwd, 'fs/read_text_file', { path: join(cwd, 'escape/private') }), /超出/); await assert.rejects(antigravityClientFile(cwd, 'fs/write_text_file', { path: join(cwd, 'escape/missing/new.txt'), content: 'must not write' }), /超出/); await assert.rejects(antigravityClientFile(cwd, 'fs/read_text_file', { path: '../outside' }), /路径/);
  assert.equal(await readFile(join(outside, 'private'), 'utf8'), 'outside fixture');
});
