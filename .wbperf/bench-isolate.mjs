
import http from 'node:http';
import { once } from 'node:events';

let KB = 520;
// 纯 Node HTTP 服务器，无桥接
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'L'.repeat(KB * 1024) } }] }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

// 客户端 A：undici fetch
async function viaFetch() {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/x', { method: 'POST', body: '{}' });
    const reader = res.body.getReader();
    let bytes = 0;
    while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; }
    return { ok: true, bytes };
  } catch (e) { return { ok: false, error: e?.message, cause: e?.cause?.code }; }
}

// 客户端 B：node:http（不走 undici）
function viaHttp() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/x', method: 'POST' }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ ok: true, bytes }));
      res.on('aborted', () => resolve({ ok: false, error: 'aborted', bytes }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end('{}');
  });
}

const rows = [];
for (const kb of [256, 500, 520, 1024, 4096]) {
  KB = kb;
  rows.push({ kb, undiciFetch: await viaFetch(), nodeHttp: await viaHttp() });
}
console.log(JSON.stringify({ plainServerNoBridge: rows }, null, 1));
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
