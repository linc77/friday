import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { install, stop, publicOrigin } from './remote.mjs';

test('remote origin requires a stable HTTPS root without embedded credentials', () => {
  assert.equal(publicOrigin('https://friday.example.com/'), 'https://friday.example.com');
  for (const value of ['http://friday.example.com', 'https://user:secret@friday.example.com',
    'https://friday.example.com/path', 'https://friday.example.com/?token=secret',
    'https://friday.example.com/#token', 'https://test.trycloudflare.com', 'invalid']) {
    assert.throws(() => publicOrigin(value));
  }
});

test('connector lifecycle keeps secrets outside arguments and preserves service data', async () => {
  const home = await mkdtemp(join(tmpdir(), 'friday-remote-'));
  const data = join(home, 'data & private');
  const source = join(home, 'token-input');
  const token = 'test-only-token-'.repeat(5);
  const calls = [];
  let loaded = false;
  const run = (...args) => {
    calls.push(args);
    if (args[0] === 'print') return { status: loaded ? 0 : 1 };
    loaded = args[0] === 'bootstrap';
    return { status: 0 };
  };
  const options = { home, data, url: 'https://friday.example.com/', tokenFile: source, binary: process.execPath, run, uid: 501 };
  try {
    await writeFile(source, token);
    await install(options);
    const plistPath = join(home, 'Library/LaunchAgents/dev.friday.remote.plist');
    const plist = await readFile(plistPath, 'utf8');
    assert.equal(plist.includes(token), false);
    assert.match(plist, /--token-file/);
    assert.match(plist, /data &amp; private/);
    assert.equal(plist.includes('scripts/remote.mjs'), false, 'connector is independent of checkout');
    assert.equal(await readFile(join(data, 'remote/tunnel-token'), 'utf8'), token + '\n');
    for (const path of [plistPath, join(data, 'remote/tunnel-token'), join(data, 'remote/tunnel.log')]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
    if (process.platform === 'darwin') assert.equal(spawnSync('/usr/bin/plutil', ['-lint', plistPath]).status, 0);
    calls.length = 0;
    await install(options);
    assert.deepEqual(calls.map(call => call[0]), ['print', 'bootout', 'bootstrap']);
    await stop(options);
    await assert.rejects(stat(plistPath), { code: 'ENOENT' });
    assert.equal(await readFile(join(data, 'remote/tunnel-token'), 'utf8'), token + '\n');
    await stop(options);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid installation leaves the existing connector alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'friday-remote-invalid-'));
  const source = join(home, 'token-input');
  const calls = [];
  const options = { home, data: join(home, 'data'), url: 'https://friday.example.com',
    tokenFile: source, binary: process.execPath, run: (...args) => { calls.push(args); return { status: 0 }; }, uid: 501 };
  try {
    await writeFile(source, 'invalid');
    await assert.rejects(install(options), /token/);
    assert.deepEqual(calls, []);
    await writeFile(source, 'test-only-valid-token-'.repeat(4));
    await assert.rejects(install({ ...options, binary: '/missing/cloudflared' }));
    assert.deepEqual(calls, []);
    const run = (...args) => ({ status: args[0] === 'bootout' ? 1 : 0 });
    await assert.rejects(install({ ...options, run }), /无法停止/);
    await assert.rejects(stat(join(options.data, 'remote/tunnel-token')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});
