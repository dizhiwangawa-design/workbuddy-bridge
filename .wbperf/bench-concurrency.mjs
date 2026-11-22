
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-conc-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

const NAMES = ['k-a', 'k-b', 'k-c'];
for (const n of NAMES) {
  accounts.ensureAccount(n);
  const d = accounts.accountAuthDir(n);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-' + n },
    auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
  }), { mode: 0o600 });
  poolMod.updateAccount(n, { enabled: true, maxConcurrency: Number(process.env.WB_MAX_CONCURRENCY || 1) });
}

const HOLD = Number(process.env.WB_UPSTREAM_HOLD_MS || 1500);
let upstreamCalls = 0;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  upstreamCalls += 1;
  await new Promise((r) => setTimeout(r, HOLD));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } });
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

async function call(i) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'q' + i }] }),
  });
  const status = res.status;
  const text = await res.text();
  return {
    i, status,
    ms: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0),
    error: status === 200 ? null : (/号池|POOL|service_unavailable/.test(text) ? 'POOL_EMPTY' : text.slice(0, 120)),
  };
}

const LEVELS = String(process.env.WB_CONCURRENCY_LEVELS || '1,3,6')
  .split(',')
  .map((v) => Number(v))
  .filter((v) => Number.isFinite(v) && v > 0);

for (const N of LEVELS) {
  upstreamCalls = 0;
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => call(i)));
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const ok = results.filter((r) => r.status === 200).length;
  console.log(JSON.stringify({
    concurrency: N,
    okCount: ok,
    failedCount: N - ok,
    wallMs: +wall.toFixed(0),
    upstreamCalls,
    perRequest: results.map((r) => ({ status: r.status, ms: r.ms, error: r.error })),
  }));
  await new Promise((r) => setTimeout(r, 200));
}

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
