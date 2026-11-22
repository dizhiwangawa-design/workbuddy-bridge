
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-lim3-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');
const { createAnthropicRuntime } = await import('../src/api-runtime.js');

accounts.ensureAccount('l3-a');
const d = accounts.accountAuthDir('l3-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-l3-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('l3-a', { enabled: true, maxConcurrency: 8 });

let KB = 300;
const upstream = http.createServer(async (req, res) => {
  for await (const _ of req) { /* drain */ }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'L'.repeat(KB * 1024) } }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 100, completion_tokens: 1000 } }) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

const config = settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 30000, idleTimeoutMs: 30000, finishGraceMs: 3000, totalTimeoutMs: 120000,
  dsmlMaxBufferBytes: 8 * 1024 * 1024,
});

const runtime = createAnthropicRuntime({
  upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }),
  logWarn: (m) => console.error('[warn]', m),
  cancelPersistence: { save: async () => ({ ok: true }) },
});

// 直接驱动 runtime，用内存假 res 记录错误
function fakeRes() {
  const chunks = [];
  const handlers = {};
  return {
    chunks,
    statusCode: 0,
    headersSent: false,
    writableLength: 0,
    writableNeedDrain: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true; return this; },
    flushHeaders() {},
    write(s, cb) { chunks.push(s); if (cb) cb(); return true; },
    end() { this.ended = true; },
    on() { return this; },
    once(e, fn) { handlers[e] = fn; return this; },
    off() { return this; },
    removeListener() { return this; },
    destroy() {},
  };
}

const rows = [];
for (const kb of [300, 400, 480, 500, 510, 520, 600]) {
  KB = kb;
  const res = fakeRes();
  const req = { headers: {}, method: 'POST', once() { return this; }, on() { return this; }, off() { return this; } };
  let outcome;
  try {
    const r = await runtime.messages({
      req, res,
      body: { model: 'deepseek-v4.1-flash', stream: true, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] },
      config: settings.getApiSettings(),
      clientKey: null,
    });
    outcome = { ok: !r?.canceled, kind: r?.kind || (r?.ok ? 'ok' : 'other'), code: r?.error?.code || null, message: r?.error?.message?.slice(0, 90) || null };
  } catch (e) {
    outcome = { threw: true, code: e?.code || null, message: String(e?.message || e).slice(0, 120) };
  }
  rows.push({ kb, bytesWritten: res.chunks.reduce((s, c) => s + (c?.length || 0), 0), ...outcome });
}
console.log(JSON.stringify(rows, null, 1));
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
