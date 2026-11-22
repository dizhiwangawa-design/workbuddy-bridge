
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-live3-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');

const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const settings = await import('../src/api-settings.js');
const { startHttpServer } = await import('../src/http.js');

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
const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });

const t0 = process.hrtime.bigint();
const res = await fetch('http://127.0.0.1:' + bridge.port + '/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 600, messages: [{ role: 'user', content: '用 300 字中文解释什么是拥塞控制。' }] }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let acc = '';
const marks = [];
while (true) {
  const r = await reader.read();
  if (r.done) break;
  const at = Number(process.hrtime.bigint() - t0) / 1e6;
  const s = dec.decode(r.value, { stream: true });
  acc += s;
  const events = (s.match(/event: (\w+)/g) || []).map((x) => x.slice(7));
  for (const e of events) marks.push({ at: Math.round(at), event: e });
}
const tail = acc.slice(-700);
console.log(JSON.stringify({
  eventTimeline: marks.slice(0, 4).concat(marks.slice(-6)),
  eventCounts: marks.reduce((m, x) => (m[x.event] = (m[x.event] || 0) + 1, m), {}),
  tail,
}, null, 1));
await bridge.close();
