// Loopback fixture for disk-backed native media exports. No model or product UI.
import http from 'node:http';
import { gzipSync } from 'node:zlib';
const captured = [], requests = [];
const foreign = http.createServer((req, res) => { captured.push({ authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(Buffer.from([1, 2, 3])); });
await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
const chunk = Buffer.alloc(65536, 61);
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://fixture').pathname;
  if (path === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ captured, requests })); return; }
  if (path === '/api/task-files/asset-url') {
    let body = ''; for await (const data of req) body += data;
    requests.push({ authorization: req.headers.authorization, body: JSON.parse(body) });
    const input = JSON.parse(body), workspaceRoot = input.path === 'no-echo.mp4' ? undefined : input.path === 'wrong-root.mp4' ? '/other' : input.workspaceRoot;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: '/file-assets/frozen/clip.mp4', expiresAt: new Date(Date.now() + 60000).toISOString(), workspaceRoot })); return;
  }
  if (path === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${foreign.address().port}/capture` }); res.end(); return; }
  if (path === '/html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not media</html>'); return; }
  if (path === '/missing') { res.writeHead(404); res.end(); return; }
  if (path === '/gzip') { const data = gzipSync(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="5"/>')); res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Encoding': 'gzip', 'Content-Length': data.length }); res.end(data); return; }
  const count = path === '/large' ? 48 * 16 : path === '/slow' ? 128 : 1;
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': count * chunk.length });
  let sent = 0; const send = () => {
    if (res.destroyed) return;
    if (sent++ >= count) { res.end(); return; }
    const more = res.write(chunk);
    if (path === '/slow') { const timer = setTimeout(send, 50); res.once('close', () => clearTimeout(timer)); }
    else if (more) setImmediate(send); else res.once('drain', send);
  }; send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ port: server.address().port }));
process.on('SIGTERM', () => { server.closeAllConnections(); foreign.closeAllConnections(); server.close(); foreign.close(); process.exit(0); });
