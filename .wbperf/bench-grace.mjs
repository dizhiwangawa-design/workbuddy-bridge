
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-grace-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const pool = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('g-a');
const authDir = accounts.accountAuthDir('g-a');
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-g-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
pool.updateAccount('g-a', { enabled: true, maxConcurrency: 4 });

const HOLD_MS = Number(process.env.WB_HOLD_MS || 3000);
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'world' } }] });
  // finish_reason 到了，但连接保持打开，[DONE] 迟迟不发（模拟上游收尾/keepalive）
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  await new Promise((r) => setTimeout(r, HOLD_MS));
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 30000, idleTimeoutMs: 30000, finishGraceMs: 2000, totalTimeoutMs: 60000,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: upstreamUrl }) } });
const base = 'http://127.0.0.1:' + bridge.port;

async function timed() {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const reader = res.body.getReader();
  let first = null;
  while (true) { const r = await reader.read(); if (r.done) break; if (first === null) first = Number(process.hrtime.bigint() - t0) / 1e6; }
  return { firstByteMs: +first.toFixed(1), totalMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) };
}
const runs = [];
for (let i = 0; i < 3; i++) runs.push(await timed());

// 号池：同一会话连续请求会落到哪个账号（复刻 pickAccount 的排序规则）
const poolData = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const names = Object.keys(poolData.accounts);
const inflight = Object.fromEntries(names.map((n) => [n, 0]));
const pickSeq = [];
for (let turn = 0; turn < 12; turn++) {
  const scored = names.map((n) => {
    const e = poolData.accounts[n];
    const tokens = (e.today?.tokensIn || 0) + (e.today?.tokensOut || 0);
    return { n, inflight: inflight[n], load: tokens / Math.max(1, e.weight || 1), lastUsedAt: e.lastUsedAt || 0 };
  });
  scored.sort((a, b) => a.inflight - b.inflight || a.load - b.load || a.lastUsedAt - b.lastUsedAt);
  const chosen = scored[0];
  pickSeq.push({ turn, chosen: chosen.n, inflight: chosen.inflight, load: Math.round(chosen.load) });
  inflight[chosen.n] += 1;
  // 该请求结束后 inflight 归零
  await new Promise((r) => setTimeout(r, 1));
  inflight[chosen.n] = 0;
}

console.log(JSON.stringify({
  upstreamHoldMs: HOLD_MS,
  bridgeStreamEnd: runs,
  accountPickSequence: pickSeq.map((p) => p.chosen),
  distinctAccountsUsed: new Set(pickSeq.map((p) => p.chosen)).size,
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
