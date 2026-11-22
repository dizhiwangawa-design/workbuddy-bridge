
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-lim4-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');
process.env.WB_DEBUG = '1';

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('l4-a');
const d = accounts.accountAuthDir('l4-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-l4-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('l4-a', { enabled: true, maxConcurrency: 8 });

let KB = 300;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'L'.repeat(KB * 1024) } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 1000 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 30000, idleTimeoutMs: 30000, finishGraceMs: 3000, totalTimeoutMs: 120000,
  dsmlMaxBufferBytes: 8 * 1024 * 1024,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }) } });
const port = bridge.port;

function viaNodeHttp(payload) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ status: res.statusCode, bytes, complete: true }));
      res.on('aborted', () => resolve({ status: res.statusCode, bytes, complete: false, reason: 'aborted' }));
    });
    req.on('error', (e) => resolve({ status: null, bytes: 0, complete: false, reason: e.message }));
    req.end(payload);
  });
}

const rows = [];
for (const kb of [400, 450, 480, 500, 505, 510, 520, 600, 900, 1020, 1030, 1100]) {
  KB = kb;
  const payload = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] });
  rows.push({ contentKB: kb, ...(await viaNodeHttp(payload)) });
}
console.log(JSON.stringify(rows, null, 1));
await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
