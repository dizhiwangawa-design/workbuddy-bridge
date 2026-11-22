
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-probe-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { createUpstreamClient } = await import('../src/upstream-client.js');
const { createAnthropicRuntime } = await import('../src/api-runtime.js');

accounts.ensureAccount('pr-a');
const d = accounts.accountAuthDir('pr-a');
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'auth.info'), JSON.stringify({
  account: { uid: 'uid-pr-a' },
  auth: { accessToken: 'a', refreshToken: 'r', expiresAt: Math.floor((Date.now() + 3600e3) / 1000), refreshExpiresAt: Math.floor((Date.now() + 7200e3) / 1000) },
}), { mode: 0o600 });
poolMod.updateAccount('pr-a', { enabled: true, maxConcurrency: 8 });

let KB = 515;
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

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 30000, idleTimeoutMs: 30000, finishGraceMs: 3000, totalTimeoutMs: 120000,
  dsmlMaxBufferBytes: 8 * 1024 * 1024,
});

// 真实 http.ServerResponse 语义的假 res：记录每次 write 后的可写队列
class FakeRes extends EventEmitter {
  constructor() { super(); this.writable = true; this.destroyed = false; this.writableEnded = false;
    this.writableLength = 0; this.writableNeedDrain = false; this.headersSent = false;
    this.bytes = 0; this.destroyedWith = null; this.peakWritable = 0; }
  writeHead() { this.headersSent = true; return this; }
  flushHeaders() {}
  write(chunk, cb) {
    const len = Buffer.byteLength(chunk);
    this.bytes += len;
    this.writableLength += len;
    this.peakWritable = Math.max(this.peakWritable, this.writableLength);
    // 模拟「客户端读得慢」：10ms 后才回调排空
    setTimeout(() => { this.writableLength = Math.max(0, this.writableLength - len); if (cb) cb(); }, 10);
    return true;
  }
  end() { this.writableEnded = true; this.writeEndCalled = true; }
  destroy(err) { this.destroyed = true; this.writable = false; this.destroyedWith = err?.message || err?.code || 'destroy()'; }
}

const warnings = [];
const runtime = createAnthropicRuntime({
  upstreamClient: createUpstreamClient({ baseUrl: 'http://127.0.0.1:' + upstream.address().port }),
  logWarn: (m) => warnings.push(String(m)),
  cancelPersistence: { save: async () => ({ ok: true }) },
});

for (const kb of [200, 400, 500, 515, 520]) {
  KB = kb;
  warnings.length = 0;
  const res = new FakeRes();
  const req = new EventEmitter(); req.headers = {}; req.method = 'POST';
  const result = await runtime.messages({
    req, res,
    body: { model: 'deepseek-v4.1-flash', stream: true, max_tokens: 4096, messages: [{ role: 'user', content: 'hi' }] },
    config: settings.getApiSettings(),
    clientKey: null,
  });
  console.log(JSON.stringify({
    kb, ok: result?.ok, kind: result?.kind,
    errorCode: result?.error?.code || null, errorMsg: String(result?.error?.message || '').slice(0, 80),
    bytesWritten: res.bytes, peakWritableLength: res.peakWritable,
    endCalled: Boolean(res.writeEndCalled), destroyed: res.destroyed, destroyedWith: res.destroyedWith,
    warnings,
  }));
}
upstream.closeAllConnections?.();
await new Promise((r) => upstream.close(r));
