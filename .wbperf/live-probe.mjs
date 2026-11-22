
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-live-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');

const NAMES = ['default', 'awa', 'codex-fresh-mvxgctfk'];
for (const n of NAMES) {
  accounts.ensureAccount(n);
  const src = path.join(realHome, 'profiles', n, 'home/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
  const dstDir = accounts.accountAuthDir(n);
  fs.mkdirSync(dstDir, { recursive: true });
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, 'Tencent-Cloud.coding-copilot.info'));
  poolMod.updateAccount(n, { enabled: true, maxConcurrency: 4 });
}

settings.updateApiSettings({
  enabled: true, anthropic: true, openai: true, streaming: true, tools: true,
  requireApiKey: false, defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 60000, idleTimeoutMs: 120000, finishGraceMs: 5000, totalTimeoutMs: 600000,
});

const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
const base = 'http://127.0.0.1:' + bridge.port;

async function one(label) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash', stream: true, max_tokens: 700,
      messages: [{ role: 'user', content: '用大约 500 字中文说明 TCP 三次握手与四次挥手的过程。' }],
    }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  let firstDeltaMs = null;
  let lastDeltaMs = null;
  let outTokens = null;
  let inTokens = null;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    acc += dec.decode(r.value, { stream: true });
    const at = Number(process.hrtime.bigint() - t0) / 1e6;
    if (/content_block_delta/.test(r.value.toString?.('utf8') || '') || true) {
      if (/\"text_delta\"/.test(acc) && firstDeltaMs === null) firstDeltaMs = at;
      if (/\"text_delta\"/.test(acc)) lastDeltaMs = at;
    }
  }
  for (const line of acc.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const j = JSON.parse(line.slice(5).trim());
      if (j.type === 'message_start') inTokens = j.message?.usage?.input_tokens ?? inTokens;
      if (j.type === 'message_delta') outTokens = j.usage?.output_tokens ?? outTokens;
    } catch { /* ignore */ }
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    label, status: res.status,
    ttftMs: firstDeltaMs === null ? null : Math.round(firstDeltaMs),
    decodeMs: firstDeltaMs === null || lastDeltaMs === null ? null : Math.round(lastDeltaMs - firstDeltaMs),
    inputTokens: inTokens, outputTokens: outTokens,
    totalMs: Math.round(totalMs),
    decodeTokPerSec: (outTokens && lastDeltaMs && firstDeltaMs && lastDeltaMs > firstDeltaMs)
      ? +(outTokens / ((lastDeltaMs - firstDeltaMs) / 1000)).toFixed(1) : null,
    errorHead: res.status === 200 ? null : acc.slice(0, 160),
  };
}

const rows = [];
for (let i = 0; i < 3; i++) {
  rows.push(await one('run' + i));
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(JSON.stringify(rows, null, 1));
await bridge.close();
