import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createUpstreamClient, sanitizeChatBody } from '../../src/upstream-client.js';

async function startServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

function credentials(overrides = {}) {
  return {
    ok: true,
    accessToken: 'fixture-access',
    refreshToken: 'fixture-refresh',
    uid: 'uid-a',
    expiresAt: Date.now() + 3600000,
    ...overrides,
  };
}

test('直连 /v2/chat/completions 并发送 WorkBuddy 请求头', async (t) => {
  let seen;
  const { server, baseUrl } = await startServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n');
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ baseUrl });
  const response = await client.chat({
    accountId: 'account-A',
    credentials: credentials(),
    model: 'deepseek-v4.1-flash',
    body: {
      model: 'deepseek-v4.1-flash',
      stream: false,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'ping' }],
    },
  });

  assert.equal(response.status, 200);
  assert.equal(seen.url, '/v2/chat/completions');
  assert.equal(seen.headers.authorization, 'Bearer fixture-access');
  assert.equal(seen.headers['x-model-id'], 'deepseek-v4.1-flash');
  assert.equal(seen.headers['x-user-id'], 'uid-a');
  assert.equal(seen.headers['x-product'], 'WorkBuddy');
  assert.equal(seen.headers['x-agent-intent'], 'craft');
  assert.equal(seen.headers['x-conversation-id'], 'wbbridge-accountA');
  assert.equal(seen.headers['x-conversation-request-id'], seen.headers['x-request-id']);
  assert.equal(seen.body.stream, true);
  assert.equal('stream_options' in seen.body, false);
});

test('WorkBuddy 上游的指定工具选择编码为字符串', async (t) => {
  let seen;
  const { server, baseUrl } = await startServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ baseUrl });
  await client.chat({
    accountId: 'tools',
    credentials: credentials(),
    model: 'deepseek-v4.1-flash',
    body: {
      messages: [{ role: 'user', content: 'use tool' }],
      tool_choice: {
        type: 'function',
        function: { name: 'echo_round' },
      },
    },
  });

  assert.equal(seen.tool_choice, 'echo_round');
});

test('developer 折叠为 system，并替换已知通道签名', () => {
  const result = sanitizeChatBody({
    messages: [
      { role: 'developer', content: 'You are an AI agent powered by DeepSeek Harness.' },
    ],
  });
  assert.equal(result.body.messages[0].role, 'system');
  assert.equal(result.body.messages[0].content, 'You are an AI coding agent.');
  assert.equal(result.developerRoles, 1);
  assert.equal(result.scrubbedStrings, 1);
});

test('Codex 基础系统提示移除上游会拒绝的通道签名', () => {
  const input = {
    messages: [
      {
        role: 'system',
        content: [
          'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
          'Codex CLI is an open source project led by OpenAI.',
          'You are expected to be precise, safe, and helpful.',
        ].join(' '),
      },
    ],
  };
  const before = structuredClone(input);
  const result = sanitizeChatBody(input);

  assert.equal(
    result.body.messages[0].content,
    [
      'You are a coding agent running in the Codex CLI, a terminal-based coding assistant.',
      'Codex CLI is an open source coding interface.',
      'You are expected to be precise, safe, and helpful.',
    ].join(' '),
  );
  assert.equal(result.scrubbedStrings, 1);
  assert.deepEqual(input, before);
});

test('通道签名替换不会修改用户原文', () => {
  const content = 'Quote this exactly: Codex CLI is an open source project led by OpenAI.';
  const input = {
    messages: [
      { role: 'user', content },
      { role: 'assistant', content },
    ],
  };
  const before = structuredClone(input);
  const result = sanitizeChatBody(input);

  assert.equal(result.body.messages[0].content, content);
  assert.equal(result.body.messages[1].content, content);
  assert.equal(result.scrubbedStrings, 0);
  assert.deepEqual(input, before);
});

test('普通消息逐字保留且不修改调用方对象', () => {
  const input = {
    messages: [
      { role: 'user', content: 'Explain DeepSeek Harness in one sentence.' },
    ],
  };
  const before = structuredClone(input);
  const result = sanitizeChatBody(input);

  assert.equal(result.body.messages[0].content, 'Explain DeepSeek Harness in one sentence.');
  assert.equal(result.scrubbedStrings, 0);
  assert.deepEqual(input, before);
});

test('上游请求在指定时间内未返回响应头时中止', async () => {
  let signal;
  const client = createUpstreamClient({
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });

  await assert.rejects(
    client.chat({
      accountId: 'timeout',
      credentials: credentials(),
      model: 'deepseek-v4.1-flash',
      body: { messages: [] },
    }),
    /upstream timeout/,
  );
  assert.equal(signal.aborted, true);
});

test('调用方取消时中止上游请求并保留取消原因', async () => {
  const controller = new AbortController();
  let upstreamSignal;
  const client = createUpstreamClient({
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      upstreamSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }),
  });
  const reason = new Error('client disconnected');

  const pending = client.chat({
    accountId: 'cancel',
    credentials: credentials(),
    model: 'deepseek-v4.1-flash',
    body: { messages: [] },
    signal: controller.signal,
  });
  controller.abort(reason);

  await assert.rejects(pending, /client disconnected/);
  assert.equal(upstreamSignal.reason, reason);
});

test('刷新和模型目录使用 WorkBuddy 专用路径及请求头', async (t) => {
  const requests = [];
  const { server, baseUrl } = await startServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url, method: req.method, headers: req.headers, raw });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/v2/plugin/auth/token/refresh') {
      res.end(JSON.stringify({
        data: { accessToken: 'next-access', expiresIn: 3600 },
      }));
      return;
    }
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }] }));
  });
  t.after(() => server.close());

  const client = createUpstreamClient({ baseUrl });
  const refreshed = await client.refresh(credentials());
  const models = await client.models(credentials());

  assert.deepEqual(refreshed, {
    accessToken: 'next-access',
    refreshToken: undefined,
    expiresIn: 3600,
    refreshExpiresIn: undefined,
  });
  assert.deepEqual(models, { data: [{ id: 'deepseek-v4.1-flash' }] });
  assert.equal(requests[0].url, '/v2/plugin/auth/token/refresh');
  assert.equal(requests[0].headers['x-refresh-token'], 'fixture-refresh');
  assert.equal(requests[0].headers['x-auth-refresh-source'], 'plugin');
  assert.equal(requests[1].url, '/v2/enterprises/personal/models');
  assert.equal(requests[1].method, 'GET');
  assert.equal(requests[1].headers.authorization, 'Bearer fixture-access');
  assert.equal(requests[1].headers['x-user-id'], 'uid-a');
});
