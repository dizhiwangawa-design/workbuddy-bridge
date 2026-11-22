
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-cc-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');

accounts.ensureAccount('cc-a');
const d = accounts.accountAuthDir('cc-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-cc-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('cc-a', { enabled: true, maxConcurrency: 8 });

let lastUpstreamBody = null;
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  lastUpstreamBody = raw;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1, prompt_cache_hit_tokens: 900 } }) + '\n\n');
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

async function post(body, label) {
  const res = await fetch('http://127.0.0.1:' + bridge.port + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  return { label, status: res.status, bodyStart: text.slice(0, 160), forwardedHadCacheFields: lastUpstreamBody ? /cache/.test(lastUpstreamBody) : null };
}

const base = { model: 'deepseek-v4.1-flash', stream: true, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const withCC = { ...base, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] };
const withSysCC = { ...base, system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] };

const rows = [];
rows.push(await post(base, 'plain'));
rows.push(await post(withCC, 'cache_control on user block'));
rows.push(await post(withSysCC, 'cache_control on system block'));
// 缓存命中是否进入号池记账
const poolAfter = JSON.parse(fs.readFileSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json'), 'utf8'));
const acc = Object.entries(poolAfter.accounts).map(([n, e]) => ({ n, tin: e.today.tokensIn, cacheRead: e.today.cacheRead }));
console.log(JSON.stringify({ rows, poolAccounting: acc }, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
