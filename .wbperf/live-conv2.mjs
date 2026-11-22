
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const credPath = path.join(os.homedir(), '.workbuddy-bridge/profiles/default/home/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
const doc = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const token = doc.auth.accessToken;

function headers(convId) {
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
    'x-conversation-id': convId,
    'x-conversation-request-id': requestId, 'x-conversation-message-id': requestId,
  };
  if (doc.account?.uid) h['x-user-id'] = String(doc.account.uid);
  return h;
}

async function fire(convId, tag) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST', headers: headers(convId),
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 300, messages: [{ role: 'user', content: '用 100 字中文说明' + tag }] }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let acc = ''; let sawDONE = false; let ttft = null; let last = null;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      const s = dec.decode(r.value, { stream: true });
      acc += s;
      if (s.includes('[DONE]')) sawDONE = true;
      if (ttft === null && /"content":"[^"]/.test(s)) ttft = Number(process.hrtime.bigint() - t0) / 1e6;
      if (/"content":"[^"]/.test(s)) last = Number(process.hrtime.bigint() - t0) / 1e6;
    }
    return { tag, ok: sawDONE, totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), ttftMs: ttft && Math.round(ttft), decodeMs: ttft && last && Math.round(last - ttft) };
  } catch (e) {
    return { tag, ok: false, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), error: e?.message, cause: e?.cause?.code };
  }
}

const FIXED = 'wbbridge-convstability';
const rows = [];
for (const tag of ['拥塞控制', '滑动窗口']) {
  rows.push(await fire(FIXED, 'fixed-' + tag));
  await new Promise((r) => setTimeout(r, 8000));
}
for (const tag of ['拥塞控制', '滑动窗口']) {
  rows.push(await fire('wb-' + randomUUID().slice(0, 10), 'random-' + tag));
  await new Promise((r) => setTimeout(r, 8000));
}
console.log(JSON.stringify(rows, null, 1));
