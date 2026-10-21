// Loopback-only fixture for native URLSession contract tests. Never app code.
import http from 'node:http';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const counts = {}, captured = [], github = [];
const foreign = http.createServer((req, res) => { captured.push(req.headers.authorization ?? null); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname; counts[path] = (counts[path] ?? 0) + 1;
  if (path === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ counts, captured, github })); return; }
  if (path === '/github-issue') {
    void (async () => {
      const pieces = []; for await (const piece of req) pieces.push(piece);
      const input = JSON.parse(Buffer.concat(pieces).toString()), mode = new URL(req.url, 'http://fixture').searchParams.get('mode');
      github.push({ authorization: req.headers.authorization ?? null, input });
      if (mode === 'redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + foreign.address().port + '/capture' }); res.end(); return; }
      const version = github.length, token = mode === 'expired-image' && version === 1 ? 'expired' : 'cap-' + version;
      const local = '/file-assets/github/' + token + '/image.png';
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({
        url: mode === 'foreign' ? 'https://foreign.test' + local : local,
        source: mode === 'wrong-source' ? 'https://github.com/foreign/repo/raw/main/image.png' : input.url,
        expiresAt: new Date(Date.now() + (mode === 'near-expiry' ? 1000 : 3600000)).toISOString(),
      }));
    })().catch(() => { res.writeHead(400); res.end(); }); return;
  }
  if (path.startsWith('/file-assets/github/')) {
    captured.push(req.headers.authorization ?? null);
    if (path.includes('/expired/')) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); return;
  }
  if (path === '/public-redirect' || path === '/private-redirect') { res.writeHead(302, { Location: 'http://127.0.0.1:' + foreign.address().port + '/capture' }); res.end(); return; }
  if (path === '/private.png' && req.headers.authorization !== 'Bearer fixture-device') { res.writeHead(401); res.end(); return; }
  if (path === '/oversize') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': 64 * 1024 * 1024 + 1 }); res.end('x'); return; }
  if (path === '/bad') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<script>never execute</script>'); return; }
  if (path === '/not-found') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'image/png' });
  if (path === '/slow') { res.flushHeaders(); const timer = setTimeout(() => res.end(png), 10_000); res.on('close', () => clearTimeout(timer)); return; }
  if (path === '/delayed.png') { setTimeout(() => res.end(png), 80); return; }
  res.end(png);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ port: server.address().port }));
process.on('SIGTERM', () => { server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); process.exit(0); });
