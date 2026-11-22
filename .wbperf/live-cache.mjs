
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const credPath = path.join(os.homedir(), '.workbuddy-bridge/profiles/default/home/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info');
const doc = JSON.parse(fs.readFileSync(credPath, 'utf8'));
const token = doc.auth.accessToken;

function headers(conv) {
  const requestId = randomUUID();
  const h = {
    'x-product': 'WorkBuddy', 'x-product-version': '5.5.6', 'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy', 'x-ide-version': '5.5.6',
    'user-agent': 'WorkBuddy/5.5.6 (CLI/2.137.1)',
    authorization: 'Bearer ' + token,
    'content-type': 'application/json', accept: 'text/event-stream',
    'x-requested-with': 'XMLHttpRequest', 'x-model-id': 'deepseek-v4.1-flash',
    'x-request-id': requestId, 'x-agent-intent': 'craft', 'x-agent-type': 'main',
    'x-codebuddy-request': '1', 'x-conversation-id': conv,
    'x-conversation-request-id': requestId, 'x-conversation-message-id': requestId,
  };
  if (doc.account?.uid) h['x-user-id'] = String(doc.account.uid);
  return h;
}

const LONG = '以下是项目规范，请牢记：' + '所有新增函数必须有单元测试，提交前必须跑通全量测试，禁止直接修改主分支。'.repeat(600);
const CONV = 'wb-cache-' + randomUUID().slice(0, 8);

async function fire(conv, prompt, tag) {
  const t0 = process.hrtime.bigint();
  const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
    method: 'POST', headers: headers(conv),
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, max_tokens: 60, messages: [
      { role: 'system', content: LONG },
      { role: 'user', content: prompt },
    ] }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let acc = ''; let ttft = null;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    const s = dec.decode(r.value, { stream: true });
    acc += s;
    if (ttft === null && /"content":"[^"]/.test(s)) ttft = Number(process.hrtime.bigint() - t0) / 1e6;
  }
  const g = (re) => { const m = acc.match(re); return m ? Number(m[1]) : null; };
  return {
    tag,
    ttftMs: ttft && Math.round(ttft),
    totalMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
    promptTokens: g(/"prompt_tokens":(\d+)/),
    cacheHit: g(/"prompt_cache_hit_tokens":(\d+)/),
    cacheMiss: g(/"prompt_cache_miss_tokens":(\d+)/),
    cacheRead: g(/"cache_read_input_tokens":(\d+)/),
  };
}

const rows = [];
rows.push(await fire(CONV, '说一个字：好', 'turn1-cold'));
await new Promise((r) => setTimeout(r, 6000));
rows.push(await fire(CONV, '再说一个字：好', 'turn2-same-prefix'));
await new Promise((r) => setTimeout(r, 6000));
rows.push(await fire(CONV, '第三个字：好', 'turn3-same-prefix'));
console.log(JSON.stringify(rows, null, 1));
