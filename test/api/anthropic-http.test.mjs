import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-anthropic-http-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { createSseParser } = await import('../../src/sse.js');
const { createResponsesStore } = await import('../../src/responses-store.js');

function createAccount(name) {
  accounts.ensureAccount(name);
  const authDir = accounts.accountAuthDir(name);
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
    account: { uid: `uid-${name}` },
    auth: {
      accessToken: `access-${name}`,
      refreshToken: `refresh-${name}`,
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 7200000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount(name, { enabled: true, maxConcurrency: 1 });
}

async function startFixture(t, upstreamHandler, {
  accountNames = ['api-a'],
  config = {},
  store = null,
} = {}) {
  const currentPool = pool.loadPool();
  for (const name of Object.keys(currentPool.accounts)) {
    if (!accountNames.includes(name)) {
      pool.updateAccount(name, { enabled: false });
    }
  }
  for (const name of accountNames) createAccount(name);
  const upstreamServer = http.createServer(upstreamHandler);
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');

  settings.updateApiSettings({
    enabled: true,
    anthropic: true,
    openai: false,
    streaming: true,
    tools: true,
    requireApiKey: false,
    remoteRequireKey: true,
    trustProxy: false,
    defaultModel: 'deepseek-v4.1-flash',
    dsmlMaxBufferBytes: 2 * 1024 * 1024,
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
    ...config,
  });

  const upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
  const upstreamClient = createUpstreamClient({ baseUrl: upstreamBaseUrl });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: store ? { upstreamClient, cancelPersistence: store } : { upstreamClient },
  });

  t.after(async () => {
    await bridge.close();
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${bridge.port}`,
    upstreamBaseUrl,
  };
}

function sendJson(res, data, extra = '') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify(data)}\n\n${extra}`);
}

async function parseResponse(response) {
  const raw = await response.text();
  const parser = createSseParser();
  const events = parser.feed(raw);
  events.push(...parser.finished());
  return { raw, events };
}

function inflight(name) {
  return pool.poolView().accounts.find((item) => item.name === name)?.inflight;
}

function sendKernelRst(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
    const raw = JSON.stringify(body);
    let bytes = '';
    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      resolve(bytes);
    }
    socket.once('connect', () => {
      socket.write(
        `POST ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\n`
        + 'Content-Type: application/json\r\nConnection: keep-alive\r\n'
        + `Content-Length: ${Buffer.byteLength(raw)}\r\n\r\n${raw}`,
      );
    });
    socket.on('data', (chunk) => {
      bytes += chunk.toString('utf8');
      if (bytes.includes('visible partial') && socket.resetAndDestroy) {
        socket.resetAndDestroy();
        finish();
      }
    });
    socket.once('error', (error) => {
      if (!settled) {
        socket.destroy();
        reject(error);
      }
    });
    setTimeout(() => {
      if (!settled) {
        socket.resetAndDestroy?.();
        finish();
      }
    }, 3000).unref();
  });
}

test('POST /v1/messages 实时流式转发文本并在末尾追加结构化 tool_use', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"up-1","choices":[{"delta":{"content":"hello "}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\":"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Beijing\\"}"}}]}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n');
    res.end('data: [DONE]\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'weather?' }],
      stream: true,
      tools: [{
        name: 'get_weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const { events } = await parseResponse(response);

  assert.equal(received.stream, true);
  assert.equal(received.model, 'deepseek-v4.1-flash');
  assert.equal(received.tools[0].function.name, 'get_weather');
  assert.equal(events.filter((event) => event.event === 'message_start').length, 1);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 1);
  assert.equal(
    events
      .filter((event) => event.data?.delta?.type === 'text_delta')
      .map((event) => event.data.delta.text)
      .join(''),
    'hello ',
  );
  const toolStart = events.find((event) => (
    event.event === 'content_block_start'
    && event.data.content_block.type === 'tool_use'
  ));
  assert.equal(toolStart.data.content_block.id, 'call_1');
  assert.equal(toolStart.data.content_block.name, 'get_weather');
  const toolDelta = events.find((event) => event.data?.delta?.type === 'input_json_delta');
  assert.deepEqual(JSON.parse(toolDelta.data.delta.partial_json), { city: 'Beijing' });
  assert.equal(
    events.find((event) => event.event === 'message_delta').data.delta.stop_reason,
    'tool_use',
  );
  assert.equal(inflight('api-a'), 0);
});

test('DSML fallback 清洗正文；未声明 tools 时只清洗不生成 tool_use', async (t) => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const dsml = [
    `before<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="search">`,
    `<${BAR}DSML${BAR} parameter name="q" string="true">hello</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>after`,
  ].join('\n');
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of [dsml.slice(0, 31), dsml.slice(31)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'search' }],
      stream: true,
    }),
  });
  const { raw, events } = await parseResponse(response);
  assert.equal(raw.includes(`<${BAR}DSML${BAR}`), false);
  assert.equal(
    events
      .filter((event) => event.data?.delta?.type === 'text_delta')
      .map((event) => event.data.delta.text)
      .join(''),
    'beforeafter',
  );
  assert.equal(
    events.some((event) => event.data?.content_block?.type === 'tool_use'),
    false,
  );
});

test('最终没有工具块时非流式 stop_reason 不使用 tool_use', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'no final tools' }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.stop_reason, 'end_turn');
  assert.deepEqual(body.content, []);
});

test('DSML 缓冲超限后发送 error、不发送 message_stop 并释放 inflight', async (t) => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `x<${BAR}DSML${BAR} calls>` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'y'.repeat(300) } }] })}\n\n`);
  }, {
    config: { dsmlMaxBufferBytes: 128, idleTimeoutMs: 500 },
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'go' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  const { events } = await parseResponse(response);
  assert.equal(events.some((event) => event.event === 'message_stop'), false);
  assert.equal(events.some((event) => event.event === 'message_stop' || event.event === 'error'), true);
  const failure = events.find((event) => event.event === 'error');
  assert.equal(failure.data.error.type, 'api_error');
  assert.equal(inflight('api-a'), 0);
});

test('首字节超时在发送 message_start 前结束并释放账号租约', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }, {
    config: { firstByteTimeoutMs: 40, idleTimeoutMs: 500, totalTimeoutMs: 1000 },
  });

  const started = Date.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hang' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).type, 'error');
  assert.ok(Date.now() - started < 500);
  assert.equal(inflight('api-a'), 0);
});

test('收到 finish_reason 后无需等待 [DONE]，宽限到期即正常结束', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n');
    res.flushHeaders();
  }, {
    config: { firstByteTimeoutMs: 500, idleTimeoutMs: 1000, finishGraceMs: 40 },
  });

  const started = Date.now();
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'finish' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  assert.ok(Date.now() - started < 1000);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 1);
  assert.equal(inflight('api-a'), 0);
});

test('count_tokens 不调用上游并明确返回保守估算标记', async (t) => {
  let upstreamCalls = 0;
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    upstreamCalls += 1;
    sendJson(res, {});
  });

  const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '你好 hello 😀' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-wb-token-estimate'), 'wb-conservative-v1');
  const body = await response.json();
  assert.ok(body.input_tokens >= 1);
  assert.equal(body.estimated, true);
  assert.equal(body.estimator, 'wb-conservative-v1');
  assert.equal(upstreamCalls, 0);
  assert.equal(inflight('api-a'), 0);
});

test('非法 JSON 返回 Anthropic 400，而不是内部错误', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    sendJson(res, {});
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"messages":',
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'invalid_request_error');
});

test('发出 message_start 前的 429 会使首号冷却并自动切换下一账号', async (t) => {
  const seen = [];
  const { baseUrl } = await startFixture(t, async (req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer access-fail-a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"rate limited"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"second account"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  }, {
    accountNames: ['fail-a', 'fail-b'],
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'failover' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  assert.equal(events.some((event) => event.event === 'message_stop'), true);
  assert.deepEqual(seen, ['Bearer access-fail-a', 'Bearer access-fail-b']);
  const rows = pool.poolView().accounts;
  assert.equal(rows.find((item) => item.name === 'fail-a').status, 'cooling');
  assert.equal(rows.find((item) => item.name === 'fail-b').inflight, 0);
});

test('模型级 429 不会阻断 Anthropic 同账号的其他模型', async (t) => {
  const seenModels = [];
  const account = 'model-scope-anthropic';
  const { baseUrl } = await startFixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    seenModels.push(body.model);
    if (body.model === 'deepseek-v4.1-flash') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"model quota exceeded"}}');
      return;
    }
    sendJson(res, {
      choices: [{ delta: { content: 'anthropic fallback model ok' }, finish_reason: 'stop' }],
    });
  }, {
    accountNames: [account],
  });

  const limited = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'limited model' }],
    }),
  });
  assert.equal(limited.status, 429);
  await limited.text();

  const fallback = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'fixture-model-b',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'fallback model' }],
    }),
  });
  assert.equal(fallback.status, 200);
  const body = await fallback.json();
  assert.equal(body.content[0].text, 'anthropic fallback model ok');

  assert.deepEqual(seenModels, ['deepseek-v4.1-flash', 'fixture-model-b']);
  const row = pool.poolView().accounts.find((item) => item.name === account);
  assert.equal(row.inflight, 0);
  assert.deepEqual(row.cooldownModels, ['deepseek-v4.1-flash']);
});

test('上游 401 会刷新 Token、0600 回写凭据后重试同一请求', async (t) => {
  let refreshed = false;
  let chatCalls = 0;
  const seenAuth = [];
  const { baseUrl } = await startFixture(t, async (req, res) => {
    if (req.url === '/v2/plugin/auth/token/refresh') {
      assert.equal(req.headers['x-refresh-token'], 'refresh-refresh-a');
      refreshed = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: { accessToken: 'access-new', expiresIn: 3600 },
      }));
      return;
    }
    chatCalls += 1;
    seenAuth.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer access-new') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"refreshed"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  }, {
    accountNames: ['refresh-a'],
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'refresh' }],
      stream: true,
    }),
  });
  const { raw } = await parseResponse(response);
  assert.equal(refreshed, true);
  assert.equal(chatCalls, 2);
  assert.deepEqual(seenAuth, ['Bearer access-refresh-a', 'Bearer access-new']);
  assert.equal(raw.includes('access-new'), false);
  assert.equal(raw.includes('refresh-refresh-a'), false);

  const file = path.join(accounts.accountAuthDir('refresh-a'), 'auth.info');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.auth.accessToken, 'access-new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('并发 401 只触发一次凭据刷新，两个请求都成功', async (t) => {
  let refreshCalls = 0;
  let chatCalls = 0;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    if (req.url === '/v2/plugin/auth/token/refresh') {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { accessToken: 'shared-access-new', expiresIn: 3600 } }));
      return;
    }
    chatCalls += 1;
    if (req.headers.authorization !== 'Bearer shared-access-new') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, {
    accountNames: ['refresh-shared'],
    config: { totalTimeoutMs: 5000 },
  });
  pool.updateAccount('refresh-shared', { maxConcurrency: 2 });
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'same account' }],
    stream: false,
  });
  const responses = await Promise.all([
    fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }),
    fetch(`${baseUrl}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(refreshCalls, 1);
  assert.ok(chatCalls >= 3 && chatCalls <= 4, `unexpected chat attempts: ${chatCalls}`);
});

test('流已开始后空闲超时发送 error、无 message_stop 并释放租约', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"started"}}]}\n\n');
    res.flushHeaders();
  }, {
    config: {
      firstByteTimeoutMs: 500,
      idleTimeoutMs: 40,
      totalTimeoutMs: 1000,
    },
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'idle' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  const { events } = await parseResponse(response);
  assert.equal(events.some((event) => event.event === 'message_stop'), false);
  assert.equal(events.some((event) => event.event === 'error'), true);
  assert.equal(inflight('api-a'), 0);
});

test('首字节和空闲都未触发时，总超时仍中止请求并释放租约', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }, {
    config: {
      firstByteTimeoutMs: 1000,
      idleTimeoutMs: 1000,
      totalTimeoutMs: 35,
    },
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'total' }],
    }),
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).type, 'error');
  assert.equal(inflight('api-a'), 0);
});

test('[DONE] 缺少 finish_reason 且工具片段完整时推断正常结束', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"done without finish"}}]}\n\n' +
      'data: [DONE]\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'done' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 1);
  assert.equal(
    events.find((event) => event.event === 'message_delta').data.delta.stop_reason,
    'end_turn',
  );
});

test('有 finish_reason 的干净 EOF 不依赖 [DONE] 也能正常结束', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"clean eof"},"finish_reason":"stop"}]}\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'eof' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  assert.equal(events.filter((event) => event.event === 'message_start').length, 1);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 1);
  assert.equal(inflight('api-a'), 0);
});

test('上游缺少 usage 时按可见输出估算非零 output_tokens', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"output tokens fallback"},' +
      '"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'estimate output usage' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  const messageDelta = events.find((event) => event.event === 'message_delta');
  assert.ok(messageDelta.data.usage.output_tokens > 0);
});

test('TCP 中断在 message_start 后发送 error、不发送 message_stop 并释放租约', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    res.flushHeaders();
    setTimeout(() => res.destroy(), 20);
  }, {
    config: { firstByteTimeoutMs: 500, idleTimeoutMs: 1000, totalTimeoutMs: 2000 },
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'interrupt' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  const { events } = await parseResponse(response);
  assert.equal(events.some((event) => event.event === 'message_stop'), false);
  assert.equal(events.some((event) => event.event === 'error'), true);
  assert.equal(inflight('api-a'), 0);
});

test('客户端断开后取消上游读取并释放 inflight', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"waiting"}}]}\n\n');
    res.flushHeaders();
    res.once('close', upstreamClosed);
  }, {
    config: {
      firstByteTimeoutMs: 500,
      idleTimeoutMs: 2000,
      totalTimeoutMs: 3000,
    },
  });

  const controller = new AbortController();
  const request = fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'cancel' }],
      stream: true,
    }),
    signal: controller.signal,
  });
  const response = await request;
  const reader = response.body.getReader();
  await reader.read();
  controller.abort(new Error('test client disconnected'));

  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('upstream did not close')), 500)),
  ]);
  const deadline = Date.now() + 500;
  while (inflight('api-a') !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(inflight('api-a'), 0);
});

test('Anthropic 主动取消先持久化，再用合法 canceled 收尾', async (t) => {
  const store = createResponsesStore({ directory: path.join(tmp, `anthropic-signal-${Date.now()}`) });
  await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }, { store });
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const upstreamClient = {
    chat: async ({ signal }) => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n',
          ));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    }),
  };
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() {
      this.headersSent = true;
    },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    on() {},
    off() {},
  };
  createAccount('api-a');
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'cancel' }],
      stream: true,
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  const visibleDeadline = Date.now() + 1000;
  while (!writes.join('').includes('visible partial')) {
    assert.ok(Date.now() < visibleDeadline, JSON.stringify({ writes, inflight: inflight('api-a') }));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  controller.abort('test interrupt');
  const result = await run;
  assert.equal(result.canceled, true);
  assert.equal(result.persistence?.ok, true, JSON.stringify(result.persistence));
  const raw = writes.join('');
  assert.equal((raw.match(/event: message_stop/g) || []).length, 1);
  assert.match(raw, /"stop_reason":"canceled"/);
  assert.equal(raw.match(/^: bridge-anthropic-canceled$/gm)?.length, 1);
  const record = store.memoryView()[0];
  assert.equal(record.status, 'incomplete');
  assert.equal(record.body.output[0].content[0].text, 'visible partial');
});

test('Anthropic 取消顺序为停止上游、释放租约、持久化、合法收尾', async (t) => {
  const events = [];
  let releaseLease;
  const leaseReleased = new Promise((resolve) => {
    releaseLease = resolve;
  });
  let releaseSave;
  const saveStarted = new Promise((resolve) => {
    releaseSave = resolve;
  });
  const store = {
    async save() {
      events.push(`save:${inflight('api-a')}`);
      releaseSave();
      await leaseReleased;
      return { ok: true, deadLetterWritten: false };
    },
  };
  const upstreamClient = {
    chat: async ({ signal }) => {
      events.push('upstream:start');
      return {
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n',
            ));
            signal.addEventListener('abort', () => {
              events.push('upstream:abort');
              controller.error(signal.reason);
            }, { once: true });
          },
        }),
      };
    },
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  createAccount('api-a');
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'cancel ordering' }],
      stream: true,
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  const abort = setInterval(() => {
    if (writes.join('').includes('visible partial')) {
      clearInterval(abort);
      controller.abort('ordering test');
    }
  }, 5);
  await saveStarted;
  assert.equal(inflight('api-a'), 0);
  assert.equal(writes.join('').includes('"stop_reason":"canceled"'), false);
  releaseLease();
  const result = await run;
  assert.equal(result.canceled, true);
  assert.match(writes.join(''), /"stop_reason":"canceled"/);
  assert.equal(writes.join('').match(/^: bridge-anthropic-canceled$/gm)?.length, 1);
});

test('Anthropic 下游 SSE 写失败按网络断连持久化并释放租约', async () => {
  const saved = [];
  const store = {
    async save(entry, options) {
      saved.push({ entry, options });
      return { ok: true, deadLetterWritten: false };
    },
  };
  const upstreamClient = {
    chat: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            'data: {"id":"anthropic-write-error","choices":[{"delta":{"content":"visible partial"}}]}\n\n',
          ));
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
            + 'data: [DONE]\n\n',
          ));
          controller.close();
        },
      }),
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('api-a');
  let writes = 0;
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(_chunk, callback) {
      writes += 1;
      if (writes >= 3) {
        throw Object.assign(new Error('write after end'), {
          code: 'ERR_STREAM_WRITE_AFTER_END',
        });
      }
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const result = await runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'write fails' }],
    },
    config: settings.getApiSettings(),
  });
  assert.equal(result.canceled, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.status, 'incomplete');
  assert.match(JSON.stringify(saved[0].entry.body), /visible partial/);
  assert.equal(inflight('api-a'), 0);
});

test('Anthropic 结构化工具参数超限失败关闭且不输出 tool_use', async () => {
  const upstreamClient = {
    chat: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(
            'data: {"choices":[{"delta":{"content":"started"}}]}\n\n',
          ));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_large',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ input: 'x'.repeat(128) }),
                  },
                }],
              },
            }],
          })}\n\n`));
          controller.close();
        },
      }),
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient });
  createAccount('api-a');
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const result = await runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'large tool arg' }],
      tools: [{
        name: 'write_file',
        input_schema: { type: 'object', properties: { input: { type: 'string' } } },
      }],
    },
    config: {
      ...settings.getApiSettings(),
      dsmlMaxBufferBytes: 32,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TOOL_ARGUMENT_LIMIT');
  const { events } = await parseResponse({
    text: async () => writes.join(''),
  });
  assert.equal(events.some((event) => (
    event.data?.content_block?.type === 'tool_use'
  )), false);
  assert.match(writes.join(''), /structured tool arguments exceeded/);
  assert.equal(inflight('api-a'), 0);
});

test('Anthropic 背压取消持久化后销毁挂起连接', async () => {
  const saved = [];
  const store = {
    async save(entry, options) {
      saved.push({ entry, options });
      return { ok: true, deadLetterWritten: false };
    },
  };
  const upstreamClient = {
    chat: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"started"}}]}\n\n',
          ));
        },
      }),
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({
    upstreamClient,
    cancelPersistence: store,
    softBytes: 32,
    hardBytes: 64,
  });
  createAccount('api-a');
  let destroyError = null;
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 128,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    flushHeaders() {},
    write() {
      throw new Error('overflowed stream must not enqueue another chunk');
    },
    end() { this.writableEnded = true; },
    destroy(error) {
      this.destroyed = true;
      this.writable = false;
      destroyError = error;
    },
    on() {},
    off() {},
  };
  const result = await runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'force backpressure' }],
    },
    config: settings.getApiSettings(),
  });
  assert.equal(result.canceled, true);
  assert.equal(result.kind, 'backpressure');
  assert.equal(res.destroyed, true);
  assert.equal(destroyError?.code, 'BACKPRESSURE_OVERFLOW');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.status, 'incomplete');
  assert.equal(inflight('api-a'), 0);
});

test('Anthropic 取消片段持久化失败时不发送成功收尾', async () => {
  const store = {
    async save() {
      return {
        ok: false,
        error: Object.assign(new Error('injected database failure'), { code: 'DB_FAILED' }),
        deadLetterWritten: true,
      };
    },
  };
  const upstreamClient = {
    chat: async ({ signal }) => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n',
          ));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('api-a');
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'failed cancel persistence' }],
      stream: true,
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  const abort = setInterval(() => {
    if (writes.join('').includes('visible partial')) {
      clearInterval(abort);
      controller.abort('ordering test');
    }
  }, 5);
  const result = await run;
  assert.equal(result.canceled, true);
  assert.equal(result.persistence.ok, false);
  assert.doesNotMatch(writes.join(''), /"stop_reason":"canceled"/);
  assert.doesNotMatch(writes.join(''), /event: message_stop/);
});

test('Anthropic 异常取消路径持久化失败时也不发送成功收尾', async () => {
  const store = {
    async save() {
      return {
        ok: false,
        error: Object.assign(new Error('injected catch-path database failure'), {
          code: 'DB_FAILED',
        }),
        deadLetterWritten: true,
      };
    },
  };
  let pendingReject;
  let firstRead = true;
  const upstreamClient = {
    chat: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader() {
          return {
            read() {
              if (firstRead) {
                firstRead = false;
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n',
                  ),
                });
              }
              return new Promise((_, reject) => {
                pendingReject = reject;
              });
            },
            cancel() {
              return new Promise((resolve) => setTimeout(resolve, 20));
            },
          };
        },
      },
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('api-a');
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'catch path cancel' }],
      stream: true,
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  const visibleDeadline = Date.now() + 1000;
  while (!writes.join('').includes('visible partial')) {
    assert.ok(Date.now() < visibleDeadline, writes.join(''));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof pendingReject, 'function');
  controller.abort('catch path interruption');
  setTimeout(() => pendingReject(new Error('forced read failure after cancellation')), 10);
  const result = await run;
  assert.equal(result.canceled, true);
  assert.equal(result.persistence.ok, false);
  assert.doesNotMatch(writes.join(''), /"stop_reason":"canceled"/);
  assert.doesNotMatch(writes.join(''), /event: message_stop/);
});

test('Anthropic 异常取消路径持久化成功后发送独立注释与合法收尾', async () => {
  const saved = [];
  const store = {
    async save(entry, options) {
      saved.push({ entry, options });
      return { ok: true, deadLetterWritten: false };
    },
  };
  let pendingReject;
  let firstRead = true;
  const upstreamClient = {
    chat: async () => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: {
        getReader() {
          return {
            read() {
              if (firstRead) {
                firstRead = false;
                return Promise.resolve({
                  done: false,
                  value: new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n',
                  ),
                });
              }
              return new Promise((_, reject) => {
                pendingReject = reject;
              });
            },
            cancel() {
              return new Promise((resolve) => setTimeout(resolve, 20));
            },
          };
        },
      },
    }),
  };
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('api-a');
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'catch path success' }],
      stream: true,
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  const visibleDeadline = Date.now() + 1000;
  while (!writes.join('').includes('visible partial')) {
    assert.ok(Date.now() < visibleDeadline, writes.join(''));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(typeof pendingReject, 'function');
  controller.abort('catch path interruption');
  setTimeout(() => pendingReject(new Error('forced read failure after cancellation')), 10);
  const result = await run;
  assert.equal(result.canceled, true);
  assert.equal(result.persistence.ok, true);
  assert.equal(saved.length, 1);
  const raw = writes.join('');
  assert.equal(raw.match(/^: bridge-anthropic-canceled$/gm)?.length, 1);
  assert.equal(raw.match(/"stop_reason":"canceled"/g)?.length, 1);
  assert.equal(raw.match(/event: message_stop/g)?.length, 1);
});

test('Anthropic 真实内核 RST 保存片段且不伪造 message_stop', async (t) => {
  const store = createResponsesStore({
    directory: path.join(tmp, `anthropic-rst-store-${Date.now()}`),
  });
  let upstreamClosed = false;
  const { baseUrl } = await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"visible partial"}}]}\n\n');
    res.flushHeaders();
    res.once('close', () => {
      upstreamClosed = true;
    });
  }, { store });
  const received = await sendKernelRst(`${baseUrl}/v1/messages`, {
    model: 'deepseek-v4.1-flash',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'reset' }],
    stream: true,
  });
  assert.match(received, /visible partial/);
  assert.doesNotMatch(received, /event: message_stop/);
  const deadline = Date.now() + 1500;
  while ((!upstreamClosed || inflight('api-a') !== 0 || store.memoryView().length === 0)
    && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstreamClosed, true);
  assert.equal(inflight('api-a'), 0);
  assert.equal(store.memoryView().length, 1);
  const record = store.memoryView()[0];
  assert.equal(record.status, 'incomplete');
  assert.equal(record.body.output[0].content[0].text, 'visible partial');
  assert.equal((await store.get(record.id))?.status, 'incomplete');
});

test('Anthropic 主动取消时半截工具参数不可执行', async (t) => {
  const store = createResponsesStore({ directory: path.join(tmp, `anthropic-tool-cancel-${Date.now()}`) });
  await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }, { store });
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const upstreamClient = {
    chat: async ({ signal }) => ({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_partial",'
            + '"function":{"name":"write_file","arguments":"{\\"path\\":\\"/tmp/x\\","}}]}}]}\n\n',
          ));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    }),
  };
  const runtime = createAnthropicRuntime({ upstreamClient, cancelPersistence: store });
  const controller = new AbortController();
  const writes = [];
  const res = {
    writable: true,
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    headersSent: false,
    writeHead() { this.headersSent = true; },
    write(chunk, callback) {
      writes.push(Buffer.from(chunk).toString('utf8'));
      callback?.();
      return true;
    },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };
  const run = runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'partial tool' }],
      stream: true,
      tools: [{ name: 'write_file', input_schema: { type: 'object', properties: {} } }],
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  controller.abort('interrupt at partial tool');
  const result = await run;
  assert.equal(result.canceled, true);
  assert.doesNotMatch(writes.join(''), /"type":"tool_use"/);
  assert.equal(store.memoryView().length, 1);
  assert.equal(JSON.stringify(store.memoryView()[0].body).includes('call_partial'), false);
});

test('不存在 codebuddy 命令时 Anthropic API 仍可完成请求', async (t) => {
  const previousCommand = process.env.WB_COMMAND;
  process.env.WB_COMMAND = path.join(tmp, 'definitely-missing-codebuddy');
  t.after(() => {
    if (previousCommand === undefined) delete process.env.WB_COMMAND;
    else process.env.WB_COMMAND = previousCommand;
  });

  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"no cli"},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  }, {
    accountNames: ['no-cli-a'],
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'no cli' }],
      stream: true,
    }),
  });
  const { events } = await parseResponse(response);
  assert.equal(response.status, 200);
  assert.equal(events.filter((event) => event.event === 'message_stop').length, 1);
  assert.equal(inflight('no-cli-a'), 0);
});

test('并发流不会突破账号 maxConcurrency，第二个请求在租约满时拒绝', async (t) => {
  let releaseFirst;
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let upstreamCalls = 0;
  let active = 0;
  let maxActive = 0;
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    upstreamCalls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    res.once('close', () => {
      active -= 1;
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"held"}}]}\n\n');
    res.flushHeaders();
    await firstHeld;
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  });
  pool.updateAccount('api-a', { maxConcurrency: 1 });

  const first = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'first' }],
      stream: true,
    }),
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'second' }],
      stream: true,
    }),
  });
  assert.equal(second.status, 503);
  assert.equal((await second.json()).type, 'error');
  assert.equal(upstreamCalls, 1);
  assert.equal(maxActive, 1);

  releaseFirst();
  const { events } = await parseResponse(first);
  assert.equal(events.some((event) => event.event === 'message_stop'), true);
  assert.equal(inflight('api-a'), 0);
});

test('结构化工具参数截断且无 DSML fallback 时失败关闭', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"broken",' +
      '"function":{"name":"write_file","arguments":"{\\"path\\":"}}]},' +
      '"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'broken tool' }],
      stream: true,
      tools: [{
        name: 'write_file',
        input_schema: { type: 'object', properties: {} },
      }],
    }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.type, 'error');
  assert.equal(inflight('api-a'), 0);
});

test('结构化调用全无效但文本中含完整 DSML 时使用 DSML fallback', async (t) => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const rawDsml = [
    `<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="read_file">`,
    `<${BAR}DSML${BAR} parameter name="path" string="true">/tmp/x</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify({
        choices: [{
          delta: {
            content: rawDsml,
            tool_calls: [{
              index: 0,
              id: 'broken',
              function: { name: 'read_file', arguments: '{"path":' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}\n\n` +
      'data: [DONE]\n\n',
    );
  });

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'fallback' }],
      stream: true,
      tools: [{
        name: 'read_file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      }],
    }),
  });
  const { raw, events } = await parseResponse(response);
  assert.equal(response.status, 200);
  assert.equal(raw.includes(`<${BAR}DSML${BAR}`), false);
  const toolDelta = events.find((event) => event.data?.delta?.type === 'input_json_delta');
  assert.ok(toolDelta, raw);
  assert.deepEqual(JSON.parse(toolDelta.data.delta.partial_json), { path: '/tmp/x' });
  assert.equal(
    events.find((event) => event.event === 'message_delta').data.delta.stop_reason,
    'tool_use',
  );
});

test('Anthropic 租约释放保留客户端 Key 归因', async () => {
  const { createAnthropicRuntime } = await import('../../src/api-runtime.js');
  const released = [];
  const runtime = createAnthropicRuntime({
    pick: () => ({ name: 'attributed-anthropic' }),
    begin: () => {},
    end: (account, result) => released.push({ account, result }),
    readCredentials: () => ({
      ok: true,
      accessToken: 'test-access',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    }),
    upstreamClient: {
      chat: async () => ({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],'
              + '"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n'
              + 'data: [DONE]\n\n',
            ));
            controller.close();
          },
        }),
      }),
    },
  });
  const res = {
    headersSent: false,
    writable: true,
    writableEnded: false,
    destroyed: false,
    writeHead() { this.headersSent = true; },
    end() { this.writableEnded = true; },
    on() {},
    off() {},
  };

  const result = await runtime.messages({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'attribute this' }],
    },
    config: settings.getApiSettings(),
    clientKey: { id: 'key-anthropic', name: 'laptop' },
  });

  assert.equal(result.ok, true);
  assert.equal(released.length, 1);
  assert.equal(released[0].result.meta.apiProtocol, 'anthropic');
  assert.equal(released[0].result.meta.clientKeyId, 'key-anthropic');
  assert.equal(released[0].result.meta.clientKeyName, 'laptop');
});
