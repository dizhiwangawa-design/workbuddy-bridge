
import http from 'node:http';
import { once } from 'node:events';
import { createHttpEventWriter } from '../src/stream-control.js';
import { createTextCache } from '../src/stream-control.js';

// 直接用真实 http 响应驱动 writer，测单帧能写多大
const server = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  const size = Number(new URL(req.url, 'http://x').searchParams.get('size'));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [];
  const w = createHttpEventWriter(res, { protocol: 'anthropic', onOverflow: (e) => events.push('overflow:' + e.message), onWriteFailure: (e) => events.push('fail:' + (e?.code || e?.message)) });
  const ok = w.writeRaw('data: ' + 'L'.repeat(size) + '\n\n');
  const statsAfter = w.stats();
  const ended = w.end();
  res.on?.('close', () => {});
  if (req.headers['x-report'] === '1') {
    // 报告走另一个响应头不够，只能写日志
  }
  process.stderr.write(JSON.stringify({ size, ok, ended, statsAfter, events }) + '\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;

function client(size) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/?size=' + size, method: 'GET' }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ size, bytes, complete: true }));
      res.on('aborted', () => resolve({ size, bytes, complete: false }));
    });
    req.on('error', (e) => resolve({ size, error: e.message }));
    req.end();
  });
}

const rows = [];
for (const size of [200e3, 400e3, 500e3, 520e3, 600e3, 1000e3, 1030e3]) {
  rows.push(await client(size));
}
console.log(JSON.stringify(rows));
server.closeAllConnections?.();
await new Promise((r) => server.close(r));
