
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const credPath = path.join(realHome, 'profiles/default/home/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
const doc = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const token = doc.auth.accessToken;
const uid = doc.account?.uid;

const requestId = randomUUID();
const headers = {
  'x-product': 'WorkBuddy', 'x-product-version': '5.5.6', 'x-ide-type': 'WorkBuddy',
  'x-ide-name': 'WorkBuddy', 'x-ide-version': '5.5.6',
  'user-agent': 'WorkBuddy/5.5.6 (CLI/2.137.1)',
  authorization: 'Bearer ' + token,
  'content-type': 'application/json', accept: 'text/event-stream',
  'x-requested-with': 'XMLHttpRequest',
  'x-model-id': 'deepseek-v4.1-flash', 'x-request-id': requestId,
  'x-agent-intent': 'craft', 'x-agent-type': 'main', 'x-codebuddy-request': '1',
  'x-conversation-id': 'direct-probe', 'x-conversation-request-id': requestId, 'x-conversation-message-id': requestId,
};
if (uid) headers['x-user-id'] = String(uid);

const t0 = process.hrtime.bigint();
const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
  method: 'POST', headers,
  body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 600, messages: [{ role: 'user', content: '用 200 字中文说明拥塞控制。' }] }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let acc = '';
let done = false;
let sawDONE = false;
let rawErr = null;
try {
  while (true) {
    const r = await reader.read();
    if (r.done) { done = true; break; }
    const s = dec.decode(r.value, { stream: true });
    acc += s;
    if (s.includes('[DONE]')) sawDONE = true;
  }
} catch (e) {
  rawErr = { message: e?.message, cause: e?.cause?.code || e?.cause?.message };
}
const endMs = Number(process.hrtime.bigint() - t0) / 1e6;
const lastFrames = acc.split('\n').filter((l) => l.startsWith('data:')).slice(-3);
console.log(JSON.stringify({
  directUpstreamStatus: res.status,
  endMs: Math.round(endMs),
  cleanDone: done,
  sawDONE,
  readError: rawErr,
  bytes: acc.length,
  lastFrames,
  hasUsageFrame: /"usage"/.test(acc),
}, null, 1));
