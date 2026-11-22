
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-lim2-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const { warn } = await import('../src/log.js');
const warnings = [];
const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');
const { createAnthropicRuntime } = await import('../src/api-runtime.js');

accounts.ensureAccount('l2-a');
const d = accounts.accountAuthDir('l2-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-l2-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('l2-a', { enabled: true, maxConcurrency: 8 });

let CURRENT_KB = 300;
let LAST_UPSTREAM_STATUS = null;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'L'.repeat(CURRENT_KB * 1024) } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 1000 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
  res.on('close', () => { LAST_UPSTREAM_STATUS = res.writableFinished ? 'finished' : 'aborted'; });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 30000, idleTimeoutMs: 30000, finishGraceMs: 3000, totalTimeoutMs: 120000,
  dsmlMaxBufferBytes: 8 * 1024 * 1024,
});

const runtime = createAnthropicRuntime({
  upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }),
  logWarn: (m) => warnings.push(String(m)),
  cancelPersistence: { save: async () => ({ ok: true }) },
});
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { anthropicRuntime: runtime } });
const base = 'http://127.0.0.1:' + bridge.port;

const rows = [];
for (const kb of [200, 250, 254, 256, 258, 300, 400, 500, 520]) {
  CURRENT_KB = kb;
  warnings.length = 0;
  LAST_UPSTREAM_STATUS = null;
  const outcome = await (async () => {
    try {
      const res = await fetch(base + '/v1/messages', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] }),
      });
      let bytes = 0;
      const reader = res.body.getReader();
      while (true) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; }
      return { status: res.status, bytes, ok: true };
    } catch (e) { return { ok: false, error: e?.message }; }
  })();
  rows.push({ kb, ...outcome, warnings: warnings.slice(0, 2), upstreamEnd: LAST_UPSTREAM_STATUS });
}
console.log(JSON.stringify(rows, null, 1));

await bridge.close();
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
