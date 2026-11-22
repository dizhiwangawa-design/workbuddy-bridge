
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-count-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const pool = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('c-a');
accounts.ensureAccount('c-b');
for (const n of ['c-a', 'c-b']) {
  const dir = accounts.accountAuthDir(n);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-' + n },
    auth: { accessToken: 'a' + n, refreshToken: 'r' + n, expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
  }), { mode: 0o600 });
  pool.updateAccount(n, { enabled: true, maxConcurrency: 4 });
}

const CHUNKS = 30;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (let i = 0; i < CHUNKS; i++) send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'w' + i + ' ' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 50, completion_tokens: CHUNKS, prompt_cache_hit_tokens: 40 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 10000, idleTimeoutMs: 10000, finishGraceMs: 2000, totalTimeoutMs: 30000,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }) } });
const base = 'http://127.0.0.1:' + bridge.port;

// 计数同步 fs 调用
const SYNC = ['readFileSync', 'writeFileSync', 'readdirSync', 'existsSync', 'mkdirSync', 'renameSync', 'statSync', 'chmodSync', 'unlinkSync', 'openSync', 'rmSync', 'copyFileSync'];
const counts = {};
const originals = {};
for (const k of SYNC) {
  if (typeof fs[k] !== 'function') continue;
  originals[k] = fs[k];
  fs[k] = function (...args) { counts[k] = (counts[k] || 0) + 1; return originals[k].apply(this, args); };
}

function reset() { for (const k of Object.keys(counts)) delete counts[k]; }
const pathCounts = {};

await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: false, max_tokens: 64, messages: [{ role: 'user', content: 'warm' }] }) });

reset();
const t0 = process.hrtime.bigint();
const res = await fetch(base + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
});
const reader = res.body.getReader();
while (true) { const r = await reader.read(); if (r.done) break; }
const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
const counted = { ...counts };

for (const k of SYNC) if (originals[k]) fs[k] = originals[k];

// 号池记账结果
const poolAfter = JSON.parse(fs.readFileSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json'), 'utf8'));
const acc = Object.entries(poolAfter.accounts).map(([n, e]) => ({ n, tin: e.today.tokensIn, tout: e.today.tokensOut, cacheRead: e.today.cacheRead, req: e.today.req }));

console.log(JSON.stringify({
  oneRequestTotalMs: +totalMs.toFixed(1),
  syncFsCallsPerRequest: counted,
  syncFsTotalPerRequest: Object.values(counted).reduce((a, b) => a + b, 0),
  poolAccountingAfter: acc,
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
