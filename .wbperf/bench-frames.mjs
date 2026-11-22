
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-frames-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('f-a');
const d = accounts.accountAuthDir('f-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-f-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('f-a', { enabled: true, maxConcurrency: 8 });

const GAP = 50, N = 20;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (let i = 0; i < N; i++) {
    send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'w' + i + ' ' } }] });
    await new Promise((r) => setTimeout(r, GAP));
  }
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: N } });
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

async function collect(url, body, isDirect) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const arrivals = [];
  let acc = '';
  let prev = 0;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    acc += dec.decode(r.value, { stream: true });
    const now = Number(process.hrtime.bigint() - t0) / 1e6;
    arrivals.push(+(now - prev).toFixed(1));
    prev = now;
  }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;
  const chunks = (acc.match(/"content":"w\d+ "/g) || []).length;
  return { totalMs: +total.toFixed(0), readCount: arrivals.length, firstMs: arrivals.length ? +arrivals[0].toFixed(1) : null, contentChunks: chunks, gaps: arrivals.slice(0, 6) };
}

const reqBody = { model: 'deepseek-v4.1-flash', stream: true, max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] };
const viaBridge = [];
const direct = [];
for (let i = 0; i < 3; i++) {
  viaBridge.push(await collect(base + '/v1/messages', reqBody, false));
  direct.push(await collect('http://127.0.0.1:' + upstream.address().port + '/v2/chat/completions', reqBody, true));
}
const med = (arr, k) => { const v = arr.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

console.log(JSON.stringify({
  upstreamGapMs: GAP, upstreamFrames: N,
  viaBridge: { totalMs: med(viaBridge, 'totalMs'), readCount: med(viaBridge, 'readCount'), firstMs: med(viaBridge, 'firstMs'), contentChunks: med(viaBridge, 'contentChunks'), sampleGaps: viaBridge[2].gaps },
  directUpstream: { totalMs: med(direct, 'totalMs'), readCount: med(direct, 'readCount'), firstMs: med(direct, 'firstMs') },
  bridgeAddedMs: +(med(viaBridge, 'totalMs') - med(direct, 'totalMs')).toFixed(0),
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
