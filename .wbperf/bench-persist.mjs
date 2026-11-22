
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-persist-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const pool = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('p-a');
const dir = accounts.accountAuthDir('p-a');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-p-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
pool.updateAccount('p-a', { enabled: true, maxConcurrency: 4 });

// 会话越大，持久化记录越大
const HISTORY_KB = Number(process.env.WB_HISTORY_KB || 100);
const bigText = 'z'.repeat(HISTORY_KB * 1024);

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, responsesPersistence: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 10000, idleTimeoutMs: 10000, finishGraceMs: 2000, totalTimeoutMs: 30000,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }) } });
const base = 'http://127.0.0.1:' + bridge.port;

async function one(store) {
  const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: bigText }] }];
  const body = JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, store, input });
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const reader = res.body.getReader();
  let firstEventMs = null;
  let doneEventMs = null;
  const dec = new TextDecoder();
  let acc = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    acc += dec.decode(r.value, { stream: true });
    if (firstEventMs === null) firstEventMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (doneEventMs === null && /response\.completed/.test(acc)) doneEventMs = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  return {
    firstEventMs: +(firstEventMs ?? 0).toFixed(1),
    completedEventMs: +(doneEventMs ?? 0).toFixed(1),
    bodyEndMs: +(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1),
  };
}

const noStore = [];
const withStore = [];
for (let i = 0; i < 4; i++) { noStore.push(await one(false)); withStore.push(await one(true)); }
const med = (arr, k) => { const v = arr.map((x) => x[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };

console.log(JSON.stringify({
  historyKB: HISTORY_KB,
  storeFalse: { firstEventMs: med(noStore, 'firstEventMs'), completedMs: med(noStore, 'completedEventMs'), endMs: med(noStore, 'bodyEndMs') },
  storeTrue: { firstEventMs: med(withStore, 'firstEventMs'), completedMs: med(withStore, 'completedEventMs'), endMs: med(withStore, 'bodyEndMs') },
  persistDeltaMs: +(med(withStore, 'completedEventMs') - med(noStore, 'completedEventMs')).toFixed(1),
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
