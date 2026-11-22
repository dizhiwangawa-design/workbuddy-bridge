
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-live2-'));
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

async function one(prompt, maxTokens, label) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const arrivals = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    arrivals.push({ ms: Number(process.hrtime.bigint() - t0) / 1e6, text: dec.decode(r.value, { stream: true }) });
  }
  const full = arrivals.map((a) => a.text).join('');
  let firstDelta = null, lastDelta = null, inTok = null, outTok = null, textChars = 0;
  for (const a of arrivals) {
    for (const line of a.text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
      if (j.type === 'message_start') inTok = j.message?.usage?.input_tokens ?? inTok;
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') {
        if (firstDelta === null) firstDelta = a.ms;
        lastDelta = a.ms;
        textChars += (j.delta.text || '').length;
      }
      if (j.type === 'message_delta') outTok = j.usage?.output_tokens ?? outTok;
    }
  }
  const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    label, status: res.status, chunks: arrivals.length,
    ttftMs: firstDelta === null ? null : Math.round(firstDelta),
    decodeMs: firstDelta === null ? null : Math.round(lastDelta - firstDelta),
    totalMs: Math.round(totalMs),
    inputTokens: inTok, outputTokens: outTok, textChars,
    decodeTokPerSec: (outTok && lastDelta > firstDelta) ? +(outTok / ((lastDelta - firstDelta) / 1000)).toFixed(1) : null,
    errorHead: res.status === 200 ? null : full.slice(0, 200),
  };
}

const rows = [];
rows.push(await one('用大约 800 字中文说明 TCP 三次握手与四次挥手的过程，并各给一个例子。', 1200, 'short-prompt'));
await new Promise((r) => setTimeout(r, 3000));
// 大上下文：塞一段长文本，看 TTFT 是否随输入增长
const bigContext = '下面是参考资料（仅供理解，不要复述）：\n' + 'TCP 是面向连接的传输层协议，它通过序号、确认与重传保证可靠性。'.repeat(1200);
rows.push(await one(bigContext + '\n\n基于以上资料，用大约 800 字中文说明三次握手。', 1200, 'huge-prompt'));
console.log(JSON.stringify(rows, null, 1));
await bridge.close();
