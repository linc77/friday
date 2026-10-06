import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { configureNetwork, installProxy, proxySettings } from '../src/network.js';

const system = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  ExceptionsList : <array> {
    0 : *.local
    1 : 192.168.0.0/16
  }
}`;

test('Proxy configuration follows explicit environment settings, macOS settings, and local bypasses', async () => {
  const automatic = proxySettings({}, system);
  assert.equal(automatic.source, 'system'); assert.equal(automatic.httpsProxy, 'http://127.0.0.1:7897'); assert.match(automatic.noProxy, /\*\.local/);
  const explicit = proxySettings({ HTTPS_PROXY: 'http://custom:8080', NO_PROXY: 'example.test' }, system);
  assert.equal(explicit.source, 'environment'); assert.equal(explicit.httpsProxy, 'http://custom:8080'); assert.match(explicit.noProxy, /127\.0\.0\.1/);
  assert.equal(proxySettings({ HTTPS_PROXY: '' }, system).source, 'direct');
  assert.equal(proxySettings({ https_proxy: 'http://lower:80', HTTPS_PROXY: 'http://upper:80' }).httpsProxy, 'http://lower:80');
  assert.equal(proxySettings({ ALL_PROXY: 'http://all:80', NO_PROXY: '*' }).noProxy, '*');
  assert.throws(() => proxySettings({ HTTPS_PROXY: 'socks5://user:secret@proxy:1080' }), error => error instanceof Error && !error.message.includes('secret'));
  const direct = configureNetwork({}, 'linux'); assert.equal(direct.source, 'direct'); await direct.close();
});

test('Native fetch uses the configured proxy while loopback callbacks bypass it', async () => {
  const proxy = createServer(); const local = createServer((_req, res) => res.end('callback'));
  const tunnels: string[] = [];
  proxy.on('connect', (request, socket) => {
    tunnels.push(request.url!);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'));
  });
  proxy.listen(0, '127.0.0.1'); local.listen(0, '127.0.0.1');
  await Promise.all([once(proxy, 'listening'), once(local, 'listening')]);
  const proxyURL = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  const network = installProxy(proxySettings({ HTTP_PROXY: proxyURL, HTTPS_PROXY: proxyURL }));
  try {
    // This hostname deliberately cannot resolve directly. The proxy must receive it instead.
    assert.equal(await (await fetch('http://friday.invalid/test', { signal: AbortSignal.timeout(2000) })).text(), 'proxied');
    assert.equal(await (await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/auth/callback`)).text(), 'callback');
    assert.deepEqual(tunnels, ['friday.invalid:80']);
  } finally { await network.close(); proxy.closeAllConnections(); local.closeAllConnections(); await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => local.close(() => resolve()))]); }
});
