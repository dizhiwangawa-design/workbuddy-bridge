import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-failover-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createOpenAIRuntime } = await import('../../src/api-runtime.js');

function writeCredential(name, token, uid = `uid-${name}`) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fixture.info'), JSON.stringify({
    account: { uid, nickname: name },
    auth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 7_200_000,
    },
    accounts: [],
  }), { mode: 0o600 });
  pool.updateAccount(name, { enabled: true, maxConcurrency: 2 });
}

function resetAccounts(names) {
  for (const account of accounts.listAccounts()) accounts.removeAccount(account.name);
  pool.savePool({ version: 2, strategy: 'round-robin', maxAttempts: 3, rrCursor: 0, accounts: {}, series: pool.loadPool().series });
  for (const name of names) writeCredential(name, `token-${name}`, `uid-${name}`);
  pool.setStrategy('round-robin');
}

async function startUpstream(onChat) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(raw || '{}') });
    await onChat(req, res, calls.at(-1).body, calls.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    calls,
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withBridge(fn, upstreamUrl) {
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    streaming: true,
    tools: false,
    requireApiKey: false,
    defaultModel: 'deepseek-v4.1-flash',
    upstreamBaseUrl: upstreamUrl,
    firstByteTimeoutMs: 1000,
    idleTimeoutMs: 1500,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
  });
  const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(`http://127.0.0.1:${bridge.port}`);
  } finally {
    await bridge.close({ graceMs: 500 });
  }
}

function chatRequest(baseUrl, {
  stream = false,
  model = 'deepseek-v4.1-flash',
} = {}) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream,
      messages: [{ role: 'user', content: 'failover-fixture' }],
    }),
  });
}

function row(name) {
  return pool.poolView().accounts.find((item) => item.name === name);
}

function tokensFor(name) {
  const entry = pool.loadPool().accounts[name];
  return entry ? { ...entry.today } : null;
}

for (const status of [402, 403, 500, 502, 503, 504]) {
  test(`OpenAI 首帧前 ${status} 会换到下一账号并按失败归账`, async (t) => {
    resetAccounts(['failover-a', 'failover-b']);
    const upstream = await startUpstream((req, res, _body, callIndex) => {
      if (req.headers.authorization === 'Bearer token-failover-a') {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `fixture-${status}` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'data: {"choices":[{"delta":{"content":"recovered"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
        + 'data: [DONE]\n\n',
      );
    });
    t.after(() => upstream.close());

    await withBridge(async (baseUrl) => {
      const response = await chatRequest(baseUrl);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.choices[0].message.content, 'recovered');
    }, upstream.url);

    assert.equal(upstream.calls.length, 2);
    assert.equal(upstream.calls[0].authorization, 'Bearer token-failover-a');
    assert.equal(upstream.calls[1].authorization, 'Bearer token-failover-b');
    assert.equal(row('failover-a').today.req, 1);
    assert.equal(row('failover-a').today.fail, 1);
    assert.equal(row('failover-a').inflight, 0);
    assert.equal(row('failover-b').today.req, 1);
    assert.equal(row('failover-b').today.ok, 1);
    assert.equal(row('failover-b').inflight, 0);
    assert.ok(row('failover-a').lastError.includes(String(status)));
  });
}

test('OpenAI 401 刷新同一账号失败后会换号且不会泄漏 refresh token', async (t) => {
  resetAccounts(['auth-a', 'auth-b']);
  const upstream = await startUpstream(async (req, res, _body, callIndex) => {
    if (req.url === '/v2/plugin/auth/token/refresh') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"invalid refresh"}}');
      return;
    }
    if (req.headers.authorization === 'Bearer token-auth-a') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"after-auth-failover"},"finish_reason":"stop"}]}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const response = await chatRequest(baseUrl, { stream: true });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /after-auth-failover/);
    assert.equal(text.includes('token-auth-a-refresh'), false);
  }, upstream.url);

  const chatCalls = upstream.calls.filter((call) => call.authorization?.startsWith('Bearer token-'));
  assert.equal(chatCalls.length, 2);
  assert.equal(chatCalls[0].authorization, 'Bearer token-auth-a');
  assert.equal(chatCalls[1].authorization, 'Bearer token-auth-b');
  assert.equal(row('auth-a').inflight, 0);
  assert.equal(row('auth-b').inflight, 0);
});

test('OpenAI 429 会冷却首号并换号，成功 token 只记到实际账号', async (t) => {
  resetAccounts(['rate-a', 'rate-b']);
  const upstream = await startUpstream((req, res, _body, callIndex) => {
    if (req.headers.authorization === 'Bearer token-rate-a') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"too many requests"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const response = await chatRequest(baseUrl, { stream: true });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /second/);
  }, upstream.url);

  assert.equal(row('rate-a').status, 'cooling');
  assert.ok(row('rate-a').cooldownLeftMs > 0);
  assert.equal(tokensFor('rate-a').tokensIn, 0);
  assert.equal(tokensFor('rate-a').tokensOut, 0);
  assert.equal(tokensFor('rate-b').tokensIn, 7);
  assert.equal(tokensFor('rate-b').tokensOut, 9);
  assert.equal(row('rate-a').inflight, 0);
  assert.equal(row('rate-b').inflight, 0);
});

test('模型级 429 不会阻断同一账号的其他模型', async (t) => {
  resetAccounts(['model-scope-a']);
  const upstream = await startUpstream((_req, res, body) => {
    if (body.model === 'deepseek-v4.1-flash') {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"model quota exceeded"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"fallback-model-ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const limited = await chatRequest(baseUrl, {
      model: 'deepseek-v4.1-flash',
    });
    assert.equal(limited.status, 429);
    await limited.text();

    const fallback = await chatRequest(baseUrl, {
      model: 'deepseek-v4-flash',
    });
    assert.equal(fallback.status, 200);
    const body = await fallback.json();
    assert.equal(body.choices[0].message.content, 'fallback-model-ok');
  }, upstream.url);

  assert.deepEqual(
    upstream.calls.map((call) => call.body.model),
    ['deepseek-v4.1-flash', 'deepseek-v4-flash'],
  );
  const entry = row('model-scope-a');
  assert.equal(entry.inflight, 0);
  assert.ok(entry.cooldownLeftMs > 0);
  assert.deepEqual(entry.cooldownModels, ['deepseek-v4.1-flash']);
});

test('OpenAI 流式首帧后失败不会换号重放，并释放租约', async (t) => {
  resetAccounts(['post-a', 'post-b']);
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"first-frame"}}]}\n\n');
    setTimeout(() => res.end(), 20);
  });
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const response = await chatRequest(baseUrl, { stream: true });
    const text = await response.text();
    assert.match(text, /first-frame/);
  }, upstream.url);

  assert.equal(upstream.calls.length, 1);
  assert.equal(row('post-a').inflight, 0);
  assert.equal(row('post-b').inflight, 0);
});

test('OpenAI 非流式不可重试 400 原样映射且只尝试一次', async (t) => {
  resetAccounts(['bad-a', 'bad-b']);
  const upstream = await startUpstream((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad request"}}');
  });
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const response = await chatRequest(baseUrl);
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.code, 'UPSTREAM_ERROR');
  }, upstream.url);

  assert.equal(upstream.calls.length, 1);
  assert.equal(row('bad-a').inflight, 0);
  assert.equal(row('bad-b').inflight, 0);
});
