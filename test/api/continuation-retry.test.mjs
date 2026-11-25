import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-continuation-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
// 本文件所有用例断言的是「续跑开着」时的行为。WB_CONTINUATION_RETRY 是运维应急
// 开关，在 shell 里设成 0 会盖过磁盘配置，让整套用例无意义地变红；显式清掉，
// 让它们只受自己驱动的配置影响。
delete process.env.WB_CONTINUATION_RETRY;
const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
const { encodeSseEvent } = await import('../../src/sse.js');

/**
 * 截停（turn cut）的稳定复现。
 *
 * 客户端规则：**本轮没有工具调用 = 任务结束**。模型在长任务中途常常只说一句
 * 「接下来我会……」或「X 已修好，接着做 Y」，然后停下 —— 这句话语义上完全符合
 * 续跑约束的规则 2，但客户端只看有没有工具调用，于是判定完成、把控制权交还用户。
 *
 * 实测来源：
 *   - codex 会话 `~/.codex/sessions/2026/11/22/…`：270 次请求里 9 次纯文字收尾，
 *     上下文占到 92.6%
 *   - dsh 会话 turn 10 step 19、turn 11 step 24：连续十几步工具调用后突然一步只有文字
 *
 * 同时验证过：把指令放在首个/中途/末尾 system 或末尾 user 都一样被遵守（4/4），
 * 所以问题不是「约束没送到」，而是「提示词管不住客户端的判定规则」。
 */

function createAccount(name) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.info'), JSON.stringify({
    account: { uid: `uid-${name}` },
    auth: {
      accessToken: 'offline-access',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount(name, { enabled: true, maxConcurrency: 1 });
}

async function fixture(t, handler, { config = {}, account = 'continuation-offline' } = {}) {
  createAccount(account);
  for (const name of Object.keys(pool.loadPool().accounts)) {
    pool.updateAccount(name, { enabled: name === account, maxConcurrency: 1 });
  }
  const upstreamServer = http.createServer(handler);
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: false,
    streaming: true,
    tools: true,
    responsesPersistence: false,
    requireApiKey: false,
    remoteRequireKey: false,
    trustProxy: false,
    firstByteTimeoutMs: 500,
    idleTimeoutMs: 2000,
    finishGraceMs: 100,
    totalTimeoutMs: 8000,
    ...config,
  });
  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
  });
  const responsesStore = createResponsesStore({
    directory: path.join(tmp, `responses-${Date.now()}-${Math.random()}`),
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: {
      upstreamClient,
      responsesRuntime: createResponsesRuntime({
        upstreamClient,
        store: responsesStore,
      }),
    },
  });
  t.after(async () => {
    await bridge.close({ graceMs: 500 });
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
    await responsesStore.close?.();
  });
  return { baseUrl: `http://127.0.0.1:${bridge.port}` };
}

function textSse(res, text, finish = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(encodeSseEvent('message', { choices: [{ delta: { content: text } }] }));
  res.end(encodeSseEvent('message', {
    choices: [{ delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }) + 'data: [DONE]\n\n');
}

function toolSse(res, { id = 'call_1', name = 'exec_command', args = '{"cmd":"cargo build"}' } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(encodeSseEvent('message', {
    choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }],
  }));
  res.end(encodeSseEvent('message', {
    choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  }) + 'data: [DONE]\n\n');
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const line = block.split('\n').find((item) => item.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    events.push(JSON.parse(payload));
  }
  return events;
}

/**
 * 取终态响应体。不带 `stream:true` 时桥接返回普通 JSON，流式才是 SSE；
 * 用例统一走非流式，省掉逐个事件拼装的噪声。
 */
function finalResponse(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('data:')) {
    const completed = parseSse(trimmed).findLast((event) => event.type === 'response.completed');
    return completed?.response || null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    // SSE 的每一块都是 JSON，但完整响应一定带 object:"response"
    if (parsed && parsed.object === 'response') return parsed;
    const completed = parseSse(trimmed).findLast((event) => event.type === 'response.completed');
    return completed?.response || null;
  } catch {
    const completed = parseSse(trimmed).findLast((event) => event.type === 'response.completed');
    return completed?.response || null;
  }
}

function outputText(response) {
  const message = (response?.output || []).find((item) => item.type === 'message');
  return (message?.content || []).map((part) => part.text || '').join('');
}

const TOOLS = [{
  type: 'function',
  name: 'exec_command',
  description: 'Run a shell command',
  parameters: { type: 'object', properties: { cmd: { type: 'string' } } },
}];

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', tools: TOOLS, ...body }),
  });
  return { status: response.status, raw: await response.text() };
}

test('只宣布下一步的纯文字收尾会触发本轮续跑，而不是交还控制权', async (t) => {
  const bodies = [];
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requests += 1;
    if (requests === 1) {
      // 截图与真实会话里的形态：宣布下一步，但没有工具调用
      textSse(res, '`Store` 已修复并编译通过。接着把 manifest/bucket/看板挂到 Sync 路由，再补集成测试。');
      return;
    }
    toolSse(res);
  });

  const { status, raw } = await post(baseUrl, { input: '把 store 修好，再挂 Sync 路由' });
  const completed = finalResponse(raw);
  const calls = (completed?.output || []).filter((item) => item.type === 'function_call');

  assert.equal(status, 200);
  assert.equal(requests, 2, '宣布下一步之后应该向上游再要一轮，而不是直接结束');
  assert.equal(calls.length, 1, '续跑后的工具调用必须出现在同一份响应里');
  // 续跑请求必须显式要求「别再描述计划」
  const followUp = JSON.stringify(bodies[1].messages);
  assert.match(followUp, /继续|直接执行/, '续跑请求要带一条明确的继续指令');
});

test('续跑会把新一轮的工具调用接在同一份响应里，且不重复上一轮的说明文字', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    // 第二轮开头重复了同样的说明，然后才是工具调用
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }],
    }));
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + 'data: [DONE]\n\n');
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由' });
  const completed = finalResponse(raw);
  const text = outputText(completed);

  assert.equal(requests, 2);
  // 同一句话不应该在终态里出现两次
  const occurrences = text.split('接下来我会补 Sync 路由').length - 1;
  assert.ok(occurrences <= 1, `说明文字重复了 ${occurrences} 次`);
});

test('真正的最终总结不触发续跑', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests += 1;
    textSse(res, '全部完成。`node test/run.mjs` 73 通过 / 0 失败，`node test/api/run.mjs` 全绿。');
  });

  const { raw } = await post(baseUrl, { input: '跑一下测试然后告诉我结果' });
  const completed = finalResponse(raw);

  assert.equal(requests, 1, '已经给出结论的收尾不该再续跑，否则用户永远收不到答复');
  assert.equal(completed?.status, 'completed');
});

test('已完成型收尾不续跑：多种措辞', async (t) => {
  const finals = [
    '任务全部完成，测试通过。',
    'All steps are complete; tests pass.',
    '修好了，共改动 3 个文件，没有遗留问题。',
    '完成。',
  ];
  for (const text of finals) {
    let requests = 0;
    const { baseUrl } = await fixture(t, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests += 1;
      textSse(res, text);
    });
    await post(baseUrl, { input: '做完了吗' });
    assert.equal(requests, 1, `不该为「${text}」续跑`);
  }
});

test('tool_choice 为 none 时不做续跑', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests += 1;
    textSse(res, '接下来我会继续处理。');
  });

  await post(baseUrl, { input: '只解释一下，不要用工具', tool_choice: 'none' });
  assert.equal(requests, 1, '客户端明确禁用工具时，不能强行续跑');
});

test('续跑最多一次，避免无限循环', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests += 1;
    // 上游一直只肯说计划
    textSse(res, '接下来我会继续下一步。');
  });

  const { raw } = await post(baseUrl, { input: '继续做' });
  const completed = finalResponse(raw);
  assert.ok(requests <= 2, `续跑只能重试一次，实际请求了 ${requests} 次`);
  assert.ok(completed, '无论如何都要给出终态，不能挂住');
});


// ---------------------------------------------------------------- 交接文档要求的补充用例
//
// 上面 6 个用例覆盖了判定与合并的主干，但交接文档（docs/handoff-2026-11-26-turn-cut.md
// 第六节）点名要求补三类：流式、客户端取消、call_id 配对。它们守的是「续跑不破坏
// 已有协议不变量」，不是判定本身，所以单独成组。

test('流式续跑：SSE 事件序列合法、sequence_number 单调、工具调用出现在终态', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    toolSse(res, { id: 'call_1', name: 'exec_command', args: '{"cmd":"ls"}' });
  });

  const { status, raw } = await post(baseUrl, { input: '补 Sync 路由', stream: true });
  assert.equal(status, 200);
  assert.equal(requests, 2, '流式路径也要续跑');

  // 响应体是 SSE：每一块都要能解析，不能夹带裸 JSON。
  const events = parseSse(raw);
  assert.ok(events.length > 0, '流式响应必须是 SSE 事件');

  const sequences = events.map((event) => event.sequence_number);
  assert.ok(
    sequences.every((value) => Number.isInteger(value) && value >= 0),
    'sequence_number 必须是整数',
  );
  for (let index = 1; index < sequences.length; index += 1) {
    assert.ok(
      sequences[index] > sequences[index - 1],
      `sequence_number 必须单调递增：${sequences[index - 1]} -> ${sequences[index]}`,
    );
  }

  const completed = events.findLast((event) => event.type === 'response.completed');
  assert.ok(completed, '流式必须以 response.completed 收尾');
  assert.equal(completed.response.status, 'completed');
  const calls = completed.response.output.filter((item) => item.type === 'function_call');
  assert.equal(calls.length, 1, '续跑后的工具调用必须出现在终态里');

  // 终态里的 output_index 必须等于 item 在 output 里的下标——这是流式的不变量。
  for (const event of events) {
    if (typeof event.output_index !== 'number') continue;
    const item = event.data?.item || event.item;
    if (!item || !event.type.endsWith('output_item.done')) continue;
    const at = completed.response.output[event.output_index];
    assert.equal(at?.id, item.id, `output_index ${event.output_index} 与终态不对齐`);
  }
});

test('续跑期间客户端取消：立刻放弃续跑，不留悬挂请求，租约释放', async (t) => {
  let requests = 0;
  let secondAborted = false;
  // 必须走流式：非流式请求在 SSE 结束前不写响应头，`res.on('close')` 分不清
  // 「请求体读完」和「客户端断开」，桥接也就无从感知取消（基线同样如此）。
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    // 第二轮故意挂住：客户端取消时这里必须被关闭，否则就是悬挂的上游请求。
    // 用 res 'close' 而不是 req 'aborted'——请求体早已读完，只有响应侧的关闭
    // 才代表桥接真的中止了这条上游连接。
    res.on('close', () => { secondAborted = true; });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', { choices: [{ delta: { content: '继续处理' } }] }));
    // 不再写任何东西，等到超时或取消。
  });

  const controller = new AbortController();
  const pending = fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      tools: TOOLS,
      input: '补 Sync 路由',
      stream: true,
    }),
    signal: controller.signal,
  });

  // 等到真的发出了续跑请求，再取消——否则取消的是第一轮，测不到续跑路径。
  for (let waited = 0; waited < 400 && requests < 2; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(requests, 2, '取消前应该已经进入续跑');

  controller.abort();
  await pending.catch(() => {});

  // 上游的第二轮必须被中止：桥接不能把悬挂的请求留在那里。
  for (let waited = 0; waited < 400 && !secondAborted; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(secondAborted, '取消后第二轮上游请求必须被中止，不能悬挂');

  // 租约必须释放：并发槽位空出来，后面的请求才排得上。
  const pool = (await import('../../src/pool.js')).loadPool();
  const inflight = Object.values(pool.accounts)
    .filter((entry) => entry.enabled)
    .reduce((sum, entry) => sum + (entry.inflight || 0), 0);
  assert.equal(inflight, 0, `取消后并发槽位必须释放，实际 inflight=${inflight}`);
});

test('续跑后的 call_id 能跟上一次响应回传的 function_call_output 配对', async (t) => {
  let requests = 0;
  const bodies = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    // 第二轮的 call_id 与第一轮不同，合并后两个都必须保持唯一且可用。
    toolSse(res, { id: 'call_first', name: 'exec_command', args: '{"cmd":"a"}' });
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由' });
  const completed = finalResponse(raw);
  const calls = (completed?.output || []).filter((item) => item.type === 'function_call');
  assert.equal(calls.length, 1);
  const callId = calls[0].call_id;
  assert.ok(callId, '工具调用必须有 call_id');

  // 把这一轮的工具结果作为 function_call_output 回传：配对必须成立且不 400。
  const { status, raw: followUp } = await post(baseUrl, {
    input: [
      { type: 'function_call', call_id: callId, name: 'exec_command', arguments: '{"cmd":"a"}' },
      { type: 'function_call_output', call_id: callId, output: 'ok' },
    ],
  });
  assert.equal(status, 200, 'function_call_output 必须能按 call_id 配对成功');

  // 上游收到的那一轮里，tool 消息的 tool_call_id 必须是同一个 call_id。
  const replayed = bodies[bodies.length - 1].messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.tool_call_id);
  assert.deepEqual(replayed, [callId], 'tool_call_id 必须与 function_call 的 call_id 一致');
  assert.ok(finalResponse(followUp), '后续轮次仍要给出终态');
});

test('两轮 call_id 撞车时续跑合并会改名，保持唯一', async (t) => {
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    if (requests === 1) {
      // 第一轮只宣布，没有调用；第二轮用了一个会跟历史撞车的 id。
      textSse(res, '接下来我会把两个调用都发出去。');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call_same', function: { name: 'exec_command', arguments: '{"cmd":"a"}' } },
            { index: 1, id: 'call_same', function: { name: 'exec_command', arguments: '{"cmd":"b"}' } },
          ],
        },
      }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }) + 'data: [DONE]\n\n');
  });

  const { raw } = await post(baseUrl, { input: '跑两个命令' });
  const completed = finalResponse(raw);
  const calls = (completed?.output || []).filter((item) => item.type === 'function_call');
  assert.ok(calls.length >= 1, '必须至少留下一个工具调用');
  const ids = calls.map((item) => item.call_id);
  assert.equal(new Set(ids).size, ids.length, `call_id 必须唯一，实际 ${JSON.stringify(ids)}`);
});


// ---------------------------------------------------------------- 第二轮修复的回归用例
//
// 这一组守的是同一件容易被「各测一半」漏掉的事：判定/合并主干有测试，流式有测试，
// 但「两个功能同时生效」的交集没人测。每条都能在修复前失败，失败原因是缺陷本身。

/** 轮询等待条件成立，超时即断言失败（不用 sleep 假装等待）。 */
async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

const occur = (text, needle) => String(text ?? '').split(needle).length - 1;

test('流式续跑：上一轮的说明文字在增量与终态里都只出现一次', async (t) => {
  // 与 :203 的非流式用例是同一构造，唯一差别是 stream:true。两条用例各覆盖一半
  // （:203 只管终态，:309 的第二轮不发正文），交集正是缺陷所在：第二轮正文原样
  // 再流一遍，settleRound 又用更长的 live 覆盖掉去重后的终态。
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }],
    }));
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + 'data: [DONE]\n\n');
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由', stream: true });
  const events = parseSse(raw);
  const streamed = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('');
  const completed = events.findLast((event) => event.type === 'response.completed');
  const terminal = outputText(completed?.response);

  assert.equal(requests, 2, '流式路径必须续跑，否则这条用例测不到东西');
  assert.equal(occur(streamed, '接下来我会补 Sync 路由'), 1,
    `增量拼接里出现了 ${occur(streamed, '接下来我会补 Sync 路由')} 次：${JSON.stringify(streamed)}`);
  assert.equal(occur(terminal, '接下来我会补 Sync 路由'), 1,
    `终态里出现了 ${occur(terminal, '接下来我会补 Sync 路由')} 次：${JSON.stringify(terminal)}`);

  // 顺带守住不变量：续跑不能把 output_index 流坏（每个 index 只 added 一次）。
  const addedIndexes = events
    .filter((event) => event.type === 'response.output_item.added')
    .map((event) => event.output_index);
  assert.equal(new Set(addedIndexes).size, addedIndexes.length,
    `同一个 output_index 不能 added 两次：${JSON.stringify(addedIndexes)}`);
});

test('续跑上报的 input_tokens 取两轮较大值，不把重发的上下文数两遍', async (t) => {
  // 第一轮 prompt_tokens=1000；第二轮重发了全部上下文（含第一轮输出）→ 1200。
  // 真实终态上下文占用是 1200；相加得到的 2200 会让客户端以为窗口用掉近一倍。
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(encodeSseEvent('message', { choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }] }));
      res.end(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 },
      }) + 'data: [DONE]\n\n');
      return;
    }
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1200, completion_tokens: 8, total_tokens: 1208 },
    }) + 'data: [DONE]\n\n');
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由' });
  const completed = finalResponse(raw);

  assert.equal(requests, 2, '必须真的续跑，否则没有两轮 usage 可合并');
  assert.equal(completed.usage.input_tokens, 1200,
    `输入侧必须取较大值 1200（真实终态上下文），实际 ${completed.usage.input_tokens}`);
  assert.equal(completed.usage.output_tokens, 28, '输出侧仍然相加：两轮都真的生成了 token');
});

test('流式错误收尾不重放 added 帧：每个 output_index 只出现一次 added', async (t) => {
  // 上游先发一个正文增量（live 已经发出 output_item.added / content_part.added），
  // 然后直接断流、不给 finish_reason → 桥接走 catch 分支收尾。旧代码在这里整段
  // 重放 protocolEvents，于是同一个 output_index 出现两次 added。
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', { choices: [{ delta: { content: '半截正文' } }] }));
    // 不发 finish_reason、不发 [DONE]，直接结束响应
    res.end();
  });

  const { raw } = await post(baseUrl, { input: '断流', stream: true });
  const events = parseSse(raw);
  const addedEvents = events.filter((event) => event.type === 'response.output_item.added');
  const indexes = addedEvents.map((event) => event.output_index);
  const contentAdded = events.filter((event) => event.type === 'response.content_part.added');
  const terminal = events.findLast((event) => [
    'response.completed', 'response.incomplete', 'response.failed',
].includes(event.type));

  assert.equal(terminal?.type, 'response.failed', '错误流仍必须以 response.failed 收尾');
  assert.equal(new Set(indexes).size, indexes.length,
    `同一 output_index 出现了两次 added：${JSON.stringify(indexes)}`);
  assert.equal(addedEvents.length, 1,
    `错误流只该有 1 个 output_item.added，实际 ${JSON.stringify(indexes)}`);
  assert.equal(contentAdded.length, 1,
    `每个 item 只该有 1 次 content_part.added，实际 ${contentAdded.length}`);
});

test('续跑第二轮会重新武装 finishGrace，不会挂到 idleTimeout', async (t) => {
  // 上游两轮都发满正文和 finish_reason，但都不关 socket：正常路径靠 finishGrace
  // 主动收尾。finishGraceTimer 若没被置空，第二轮看到残留对象 → 永不武装 →
  // 只能等 idleTimeout，用户感知的延迟就差一个数量级。
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(encodeSseEvent('message', { choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }] }));
      res.write(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
      return; // 故意不 end()
    }
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }],
    }));
    res.write(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }));
    // 同样不 end()
  }, { config: { finishGraceMs: 200, idleTimeoutMs: 2000, totalTimeoutMs: 8000 } });

  const startedAt = Date.now();
  const { raw } = await post(baseUrl, { input: '补 Sync 路由' });
  const elapsed = Date.now() - startedAt;
  const completed = finalResponse(raw);

  assert.equal(requests, 2, '必须进入续跑，否则测不到第二轮的 finishGrace');
  assert.ok(elapsed < 2000,
    `续跑应靠 finishGrace 收尾，实际用了 ${elapsed}ms（疑似挂到 idleTimeout）`);
  assert.equal(completed?.status, 'completed', 'finishGrace 正常收尾应产出 completed 终态');
});

test('续跑丢弃第一轮 reader 时会把它真正关掉，不泄漏上游连接', async (t) => {
  // consumeSse 在 [DONE] 处退出时**不设** readerDone，唯一的兜底是 finally 里
  // 针对「当前 reader」的 cancelReader。resetRound 一旦先把引用置空，第一轮的
  // 上游 socket 就再没有任何代码能关。
  const closedRounds = [];
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    const round = requests;
    res.once('close', () => closedRounds.push(round));
    if (round === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(encodeSseEvent('message', { choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }] }));
      // 发完 [DONE] 但故意不关 socket：基线靠 finally 的 cancelReader 兜住，
      // 续跑路径必须靠 resetRound 自己关。
      res.write(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }) + 'data: [DONE]\n\n');
      return;
    }
    toolSse(res, { id: 'call_1', name: 'exec_command', args: '{"cmd":"ls"}' });
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由' });
  assert.equal(requests, 2);
  assert.ok(finalResponse(raw), '两轮都要有终态');

  await waitUntil(
    () => closedRounds.includes(1),
    `第一轮的上游连接没有被关闭（已关闭的轮次：${JSON.stringify(closedRounds)}）`,
  );
});

test('续跑仍受同一个 totalTimeoutMs 约束，不另给一份预算', async (t) => {
  // handoff §4.2：续跑计入现有 totalTimeoutMs，不是独立超时预算。
  // 第二轮每 150ms 滴一个 chunk 共约 2.4s，总预算 600ms → 必须在预算内失败。
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    if (requests === 1) {
      textSse(res, '接下来我会补 Sync 路由。');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let tick = 0; tick < 16; tick += 1) {
      if (res.writableEnded || res.destroyed) return;
      res.write(encodeSseEvent('message', { choices: [{ delta: { content: '滴' } }] }));
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }) + 'data: [DONE]\n\n');
  }, { config: { totalTimeoutMs: 600, idleTimeoutMs: 1500, finishGraceMs: 50 } });

  const startedAt = Date.now();
  const { raw } = await post(baseUrl, { input: '补 Sync 路由', stream: true });
  const elapsed = Date.now() - startedAt;
  const terminal = parseSse(raw).findLast((event) => [
    'response.completed', 'response.incomplete', 'response.failed',
].includes(event.type));

  assert.equal(requests, 2, '必须进入续跑');
  assert.ok(elapsed < 2000, `续跑绕过了总预算，实际跑了 ${elapsed}ms`);
  assert.equal(terminal?.type, 'response.failed', `总预算到期必须失败收尾，实际 ${terminal?.type}`);
  assert.equal(terminal.response.error.code, 'UPSTREAM_TIMEOUT');
});

test('续跑时推理通道的增量拼接与终态一致，第一轮思考不重复', async (t) => {
  // 正文与推理都走 liveEncoder，续跑轮里 live 是「第一轮 + 第二轮」首尾相接的累积。
  // 正文那一侧由 joinContinuationText 去重；推理这一侧若还拿 live 覆盖终态，终态会
  // 变成「甲\n\n甲。乙」——第一轮那段出现两次，且与已经发出去的增量对不上。
  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* 读掉请求体 */ }
    requests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(encodeSseEvent('message', { choices: [{ delta: { reasoning_content: '想一想甲。' } }] }));
      res.write(encodeSseEvent('message', { choices: [{ delta: { content: '接下来我会补 Sync 路由。' } }] }));
      res.end(encodeSseEvent('message', { choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }) + 'data: [DONE]\n\n');
      return;
    }
    res.write(encodeSseEvent('message', { choices: [{ delta: { reasoning_content: '想一想乙。' } }] }));
    res.write(encodeSseEvent('message', { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } }] }));
    res.end(encodeSseEvent('message', { choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }) + 'data: [DONE]\n\n');
  });

  const { raw } = await post(baseUrl, { input: '补 Sync 路由', stream: true, reasoning: { effort: 'high' } });
  const events = parseSse(raw);
  const completed = events.findLast((event) => event.type === 'response.completed');
  const reasoning = completed.response.output
    .filter((item) => item.type === 'reasoning')
    .flatMap((item) => (item.summary || []).map((part) => part.text || ''))
    .join('');
  const reasoningDeltas = events
    .filter((event) => event.type === 'response.reasoning_summary_text.delta')
    .map((event) => event.delta)
    .join('');

  assert.equal(requests, 2, '必须进入续跑');
  assert.equal(occur(reasoning, '想一想甲'), 1, `第一轮思考重复了：${JSON.stringify(reasoning)}`);
  assert.equal(occur(reasoning, '想一想乙'), 1, `第二轮思考重复了：${JSON.stringify(reasoning)}`);
  assert.equal(reasoningDeltas, reasoning,
    `推理增量拼接必须等于终态：增量 ${JSON.stringify(reasoningDeltas)} vs 终态 ${JSON.stringify(reasoning)}`);
});


test('信封写进正文却没写完（DSML_TRUNCATED）必须触发续跑，而不是把控制权交回用户', async (t) => {
  // 真实现场：模型把工具调用信封写进了正文却没写完，上游照样报 finish_reason=stop。
  // 修复前：snapshot() 把截断报成 length ⇒ 续跑判定只认 stop ⇒ 既不续跑、用户又
  // 以为回合正常结束，看到的就是「说一句下一步就停了」。
  // 对外仍要报 incomplete（半截参数不可执行），但内部必须放行一次续跑。
  const BAR = '\u{FF5C}\u{FF5C}';
  const half = [
    '接下来我会补 Sync 路由。',
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="exec_command">`,
    `<${BAR}DSML${BAR} parameter name="cmd" string="true">ls`,
  ].join('\n');

  let requests = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests += 1;
    if (requests === 1) {
      textSse(res, half, 'stop');
      return;
    }
    toolSse(res, { id: 'call_1', name: 'exec_command', args: '{"cmd":"ls"}' });
  });

  const { status, raw } = await post(baseUrl, { input: 'go', stream: true });
  assert.equal(status, 200);
  assert.equal(requests, 2, '信封截断必须再要一轮');

  const events = parseSse(raw);
  const completed = events.findLast((event) => event.type === 'response.completed');
  assert.ok(completed, '续跑拿到工具调用后应当正常收尾');
  const calls = completed.response.output.filter((item) => item.type === 'function_call');
  assert.equal(calls.length, 1, '续跑后的工具调用必须出现在终态里');

  const streamed = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta || '')
    .join('');
  assert.ok(!streamed.includes('DSML'), `半截信封不得泄漏给客户端：${JSON.stringify(streamed)}`);
});

