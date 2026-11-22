
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-load-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

const NAMES = [];
for (let i = 0; i < 20; i++) {
  const n = 'load-' + i;
  NAMES.push(n);
  accounts.ensureAccount(n);
  const d = accounts.accountAuthDir(n);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-' + n },
    auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
  }), { mode: 0o600 });
  poolMod.updateAccount(n, { enabled: true, maxConcurrency: 4 });
}

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (let i = 0; i < 10; i++) { send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'w' + i } }] }); await new Promise((r) => setTimeout(r, 20)); }
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 20000, idleTimeoutMs: 20000, finishGraceMs: 2000, totalTimeoutMs: 60000,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }) } });
const base = 'http://127.0.0.1:' + bridge.port;

// 事件循环抖动探针
const lags = [];
let probing = true;
const probe = (async () => {
  let last = process.hrtime.bigint();
  while (probing) {
    await new Promise((r) => setTimeout(r, 1));
    const now = process.hrtime.bigint();
    lags.push(Number(now - last) / 1e6 - 1);
    last = now;
  }
})();

async function one(i) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'q' + i }] }),
  });
  const text = await res.text();
  return { status: res.status, ms: Number(process.hrtime.bigint() - t0) / 1e6, text };
}

const baselineLags = lags.slice();
const results = await Promise.all(Array.from({ length: 80 }, (_, i) => one(i)));
probing = false;
await probe;

const ok = results.filter((r) => r.status === 200);
const failed = results.filter((r) => r.status !== 200);
const sorted = (a) => a.slice().sort((x, y) => x - y);
const pct = (arr, p) => arr.length ? +arr[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : null;
const lagSorted = sorted(lags);

console.log(JSON.stringify({
  concurrentRequests: 80,
  accounts: NAMES.length, maxConcurrencyEach: 4,
  okCount: ok.length,
  failedCount: failed.length,
  failureCodes: [...new Set(failed.map((f) => (/POOL_EMPTY|号池/.test(f.text) ? 'POOL_EMPTY(503)' : 'other')))],
  latencyP50Ms: pct(sorted(ok.map((r) => r.ms)), 0.5),
  latencyP99Ms: pct(sorted(ok.map((r) => r.ms)), 0.99),
  latencyMaxMs: pct(sorted(ok.map((r) => r.ms)), 1),
  eventLoopLagP50Ms: pct(lagSorted, 0.5),
  eventLoopLagP99Ms: pct(lagSorted, 0.99),
  eventLoopLagMaxMs: pct(lagSorted, 1),
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
