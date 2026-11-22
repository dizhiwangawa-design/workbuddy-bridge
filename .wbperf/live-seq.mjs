
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const credPath = path.join(os.homedir(), '.workbuddy-bridge/profiles/default/home/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
const doc = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const token = doc.auth.accessToken;

function headers() {
  const requestId = randomUUID();
  const h = {
    'x-product': 'WorkBuddy', 'x-product-version': '5.5.6', 'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy', 'x-ide-version': '5.5.6',
    'user-agent': 'WorkBuddy/5.5.6 (CLI/2.137.1)',
    authorization: 'Bearer ' + token,
    'content-type': 'application/json', accept: 'text/event-stream',
    'x-requested-with': 'XMLHttpRequest',
    'x-model-id': 'deepseek-v4.1-flash', 'x-request-id': requestId,
    'x-agent-intent': 'craft', 'x-agent-type': 'main', 'x-codebuddy-request': '1',
    'x-conversation-id': 'wbbridge-' + randomUUID().slice(0, 12),
    'x-conversation-request-id': requestId, 'x-conversation-message-id': requestId,
  };
  if (doc.account?.uid) h['x-user-id'] = String(doc.account.uid);
  return h;
}

async function fire(tag) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 500, messages: [{ role: 'user', content: '用 200 字中文说明' + tag }] }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let acc = ''; let sawDONE = false; let firstDeltaMs = null; let lastDeltaMs = null;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      const s = dec.decode(r.value, { stream: true });
      acc += s;
      if (s.includes('[DONE]')) sawDONE = true;
      if (firstDeltaMs === null && /"content":"[^"]/.test(s)) firstDeltaMs = Number(process.hrtime.bigint() - t0) / 1e6;
      if (/"content":"[^"]/.test(s)) lastDeltaMs = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    const usage = (acc.match(/"completion_tokens":(\d+)/) || [])[1];
    return { tag, ok: sawDONE, totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), ttftMs: firstDeltaMs && Math.round(firstDeltaMs), decodeMs: firstDeltaMs && lastDeltaMs && Math.round(lastDeltaMs - firstDeltaMs), completionTokens: usage ? Number(usage) : null, bytes: acc.length };
  } catch (e) {
    return { tag, ok: false, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), error: e?.message, cause: e?.cause?.code || e?.cause?.message };
  }
}

const rows = [];
for (const tag of ['拥塞控制', '滑动窗口', '慢启动']) {
  rows.push(await fire(tag));
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(JSON.stringify(rows, null, 1));
