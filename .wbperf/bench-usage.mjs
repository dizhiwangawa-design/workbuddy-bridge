
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-usage-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('u-a');
const d = accounts.accountAuthDir('u-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-u-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('u-a', { enabled: true, maxConcurrency: 4 });

const TAIL_MS = Number(process.env.WB_TAIL_MS || 3000);
const GRACE = Number(process.env.WB_GRACE_MS || 2000);
const TEXT = 'The quick brown fox writes a reasonably long answer about files. '.repeat(8);

const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: TEXT } }] });
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  await new Promise((r) => setTimeout(r, TAIL_MS));
  send({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 999, prompt_cache_hit_tokens: 800 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 20000, idleTimeoutMs: 20000, finishGraceMs: GRACE, totalTimeoutMs: 60000,
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }) } });
const base = 'http://127.0.0.1:' + bridge.port;

const t0 = process.hrtime.bigint();
const res = await fetch(base + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }),
});
const raw = await res.text();
const endMs = Number(process.hrtime.bigint() - t0) / 1e6;

const usageLines = raw.split('\n').filter((l) => l.startsWith('data:') && /usage/.test(l));
const parse = (line) => { try { return JSON.parse(line.slice(5).trim()); } catch { return null; } };
const events = usageLines.map(parse).filter(Boolean);
const delta = events.find((e) => e.type === 'message_delta');
const start = events.find((e) => e.type === 'message_start');
const stopReasons = raw.match(/"stop_reason":"[^"]+"/g);

// 号池记账（estimate vs 真实）
const poolAfter = JSON.parse(fs.readFileSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json'), 'utf8'));
const acc = Object.entries(poolAfter.accounts).map(([n, e]) => ({ n, tin: e.today.tokensIn, tout: e.today.tokensOut, cacheRead: e.today.cacheRead }));

console.log(JSON.stringify({
  graceMs: GRACE, upstreamTailMs: TAIL_MS,
  clientStreamEndedAtMs: +endMs.toFixed(0),
  expectedIfWaitedForTailMs: TAIL_MS,
  actualTextBytes: TEXT.length,
  messageStart_usage: start?.message?.usage ?? null,
  messageDelta_usage: delta?.usage ?? null,
  stopReason: stopReasons ? stopReasons.slice(0, 1) : null,
  poolAccounting: acc,
  bridgeNotice: /bridge-.*canceled|content_block_delta/.test(raw) ? 'ok' : 'n/a',
}, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
