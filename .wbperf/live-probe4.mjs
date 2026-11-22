
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-live4-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');
const { createAnthropicRuntime } = await import('../src/api-runtime.js');

for (const n of ['default', 'awa']) {
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

const notes = [];
const runtime = createAnthropicRuntime({ logWarn: (m) => notes.push('warn: ' + m) });
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: { anthropicRuntime: runtime } });

const t0 = process.hrtime.bigint();
const res = await fetch('http://127.0.0.1:' + bridge.port + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 600, messages: [{ role: 'user', content: '用 300 字中文解释什么是拥塞控制。' }] }),
});
const text = await res.text();
const endMs = Number(process.hrtime.bigint() - t0) / 1e6;

// 号池记账：看到底记了多少
const poolAfter = JSON.parse(fs.readFileSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json'), 'utf8'));
const recent = (poolAfter.series?.events || []).slice(0, 3);
console.log(JSON.stringify({
  endMs: Math.round(endMs),
  notes,
  hasErrorEvent: /"type":"error"/.test(text),
  errorText: (text.match(/event: error\ndata: (.*)/) || [])[1] || null,
  stopReason: (text.match(/"stop_reason":"([^"]+)"/) || [])[1] || null,
  recentEvents: recent,
}, null, 1));
await bridge.close();
