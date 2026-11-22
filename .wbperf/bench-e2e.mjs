
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-e2e-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const pool = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('perf-a');
const authDir = accounts.accountAuthDir('perf-a');
fs.mkdirSync(authDir, { recursive: true });
fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-perf-a' },
  auth: {
    accessToken: 'access-perf-a',
    refreshToken: 'refresh-perf-a',
    expiresAt: Math.floor((Date.now() + 3600000) / 1000),
    refreshExpiresAt: Math.floor((Date.now() + 7200000) / 1000),
  },
}), { mode: 0o600 });
pool.updateAccount('perf-a', { enabled: true, maxConcurrency: 4 });

const CHUNKS = Number(process.env.WB_CHUNKS || 40);
const GAP_MS = Number(process.env.WB_GAP_MS || 0);
const TOOLCALL = process.env.WB_TOOLCALL === '1';

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  if (TOOLCALL) {
    const argBody = JSON.stringify({ command: 'ls -la' });
    const frames = 10;
    const step = Math.ceil(argBody.length / frames);
    send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] } }] });
    for (let i = 0; i < frames; i++) {
      send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argBody.slice(i * step, (i + 1) * step) } }] } }] });
      if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    for (let i = 0; i < CHUNKS; i++) {
      send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'tok' + i + ' ' } }] });
      if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
    }
    send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: CHUNKS, total_tokens: 100 + CHUNKS } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 5000, idleTimeoutMs: 5000, finishGraceMs: 100, totalTimeoutMs: 30000,
});

const bridge = await startHttpServer({
  port: 0, host: '127.0.0.1',
  apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: upstreamUrl }) },
});
const base = 'http://127.0.0.1:' + bridge.port;

async function timedRequest() {
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    max_tokens: 512,
    messages: [{ role: 'user', content: 'hi' }],
  });
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  const reader = res.body.getReader();
  let firstByteMs = null; let firstDeltaMs = null; let bytes = 0;
  const dec = new TextDecoder();
  let acc = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    if (firstByteMs === null) firstByteMs = Number(process.hrtime.bigint() - t0) / 1e6;
    bytes += r.value.length;
    acc += dec.decode(r.value, { stream: true });
    if (firstDeltaMs === null && /content_block_delta/.test(acc)) {
      firstDeltaMs = Number(process.hrtime.bigint() - t0) / 1e6;
    }
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return { firstByteMs, firstDeltaMs, totalMs, bytes, frames: (acc.match(/event:/g) || []).length };
}

const runs = [];
for (let i = 0; i < 7; i++) runs.push(await timedRequest());
const med = (k) => { const v = runs.map((r) => r[k]).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? +v[Math.floor(v.length / 2)].toFixed(2) : null; };

console.log(JSON.stringify({
  mode: TOOLCALL ? 'toolcall' : 'text',
  chunks: CHUNKS, gapMs: GAP_MS,
  firstByteMs: med('firstByteMs'),
  firstDeltaMs: med('firstDeltaMs'),
  totalMs: med('totalMs'),
  sseFrames: runs[0].frames,
  bytes: runs[0].bytes,
  samples: runs.map((r) => ({ fb: +r.firstByteMs.toFixed(1), fd: r.firstDeltaMs && +r.firstDeltaMs.toFixed(1), tot: +r.totalMs.toFixed(1) })),
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
