
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
    'x-conversation-id': convId, 'x-conversation-request-id': requestId, 'x-conversation-message-id': requestId,
  };
  if (doc.account?.uid) h['x-user-id'] = String(doc.account.uid);
  return h;
}

async function fire(convId, label, delayMs) {
  await new Promise((r) => setTimeout(r, delayMs));
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST', headers: headers(convId),
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 400, messages: [{ role: 'user', content: '用 150 字中文说明' + label }] }),
    });
    const reader = res.body.getReader();
    let bytes = 0; let sawDONE = false;
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      bytes += r.value.length;
      if (Buffer.from(r.value).toString('utf8').includes('[DONE]')) sawDONE = true;
    }
    return { label, ok: true, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), bytes, sawDONE };
  } catch (e) {
    return { label, ok: false, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), error: e?.message, cause: e?.cause?.code || e?.cause?.message };
  }
}

// A 组：同一个 conversation-id 上并发两个请求（模拟桥接的做法）
const sameConv = 'wbbridge-probe-fixed';
const groupA = await Promise.all([fire(sameConv, '拥塞控制', 0), fire(sameConv, '滑动窗口', 300)]);

await new Promise((r) => setTimeout(r, 2000));

// B 组：不同 conversation-id 并发（正常做法）
const groupB = await Promise.all([fire('wbbridge-probe-' + randomUUID().slice(0, 8), '拥塞控制', 0), fire('wbbridge-probe-' + randomUUID().slice(0, 8), '滑动窗口', 300)]);

console.log(JSON.stringify({ sameConversationId: groupA, distinctConversationId: groupB }, null, 1));
