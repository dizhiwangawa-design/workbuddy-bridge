
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-lag2-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

const N = Number(process.env.WB_ACCOUNTS || 20);
for (let i = 0; i < N; i++) {
  const n = 'lg-' + i;
  accounts.ensureAccount(n);
  const d = accounts.accountAuthDir(n);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-' + n },
    auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
  }), { mode: 0o600 });
  poolMod.updateAccount(n, { enabled: true, maxConcurrency: 50 });
}

// 制造大 pool.json：写满 series（events 上限 160，但 hours/days 桶可膨胀）
const pool = poolMod.loadPool();
for (let h = 0; h < 24 * 16; h++) {
  const key = new Date(Date.now() - h * 3600e3).toISOString().slice(0, 13);
  pool.series.hours[key] = {
    req: 100, ok: 100, fail: 0, tin: 1e6, tout: 1e4,
    cacheRead: 0, cacheWrite: 0, ms: 1e6, cost: 0, apis: {}, keys: {},
  };
}
for (let i = 0; i < N; i++) {
  const name = 'lg-' + i;
  if (pool.accounts[name]) pool.accounts[name].days = Object.fromEntries(
    Array.from({ length: 7 }, (_, k) => ['2026-11-0' + (k + 1), { req: 10, ok: 10, fail: 0, tin: 1e5, tout: 1e3, cacheRead: 0, cacheWrite: 0, ms: 1e5, cost: 0 }]),
  );
}
poolMod.savePool(pool);
const poolBytes = fs.statSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json')).size;

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 1 } });
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
await new Promise((r) => setTimeout(r, 300));
const idleLags = lags.slice();

async function one(i) {
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'q' + i }] }),
  });
  await res.text();
  return res.status;
}
lags.length = 0;
const REQS = Number(process.env.WB_REQS || 100);
const statuses = await Promise.all(Array.from({ length: REQS }, (_, i) => one(i)));
probing = false;
await probe;

const pct = (arr, p) => arr.length ? +arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))].toFixed(2) : null;
const poolAfter = fs.statSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json')).size;

console.log(JSON.stringify({
  accounts: N, poolBytes, poolBytesAfter: poolAfter, requests: REQS,
  okCount: statuses.filter((s) => s === 200).length,
  idleLagP99: pct(idleLags, 0.99),
  loadLagP50: pct(lags, 0.5), loadLagP99: pct(lags, 0.99), loadLagMax: pct(lags, 1),
  samples: lags.length,
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
