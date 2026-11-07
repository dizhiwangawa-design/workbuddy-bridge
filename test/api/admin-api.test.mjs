import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-admin-api-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ADMIN_TOKEN = 'admin-fixture';

const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');

async function withServer(fn) {
  const server = await startHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close({ graceMs: 500 });
  }
}

function adminFetch(baseUrl, pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      'x-wb-token': 'admin-fixture',
      ...(options.headers || {}),
    },
  });
}

test('管理页包含完整 API 开关、上游配置、Key 与连接测试入口', async () => {
  await withServer(async (baseUrl) => {
    const response = await adminFetch(baseUrl, '/admin');
    assert.equal(response.status, 200);
    const html = await response.text();

    for (const field of [
      'enabled',
      'openai',
      'anthropic',
      'streaming',
      'tools',
      'channelSanitize',
      'requireApiKey',
      'remoteRequireKey',
      'trustProxy',
    ]) {
      assert.match(html, new RegExp(`data-api-config="${field}"`));
    }
    for (const field of ['upstreamBaseUrl', 'defaultModel', 'firstByteTimeoutMs', 'idleTimeoutMs', 'totalTimeoutMs']) {
      assert.match(html, new RegExp(`data-api-field="${field}"`));
    }
    assert.match(html, /测试 OpenAI 文本/);
    assert.match(html, /测试 Anthropic 工具/);
    assert.match(html, /data-act="api-test-openai"/);
    assert.match(html, /data-act="api-test-anthropic"/);
    assert.match(html, /上游地址/);
    assert.match(html, /默认模型/);
    assert.match(html, /API 总开关/);
    assert.doesNotMatch(html, /"hash"/);
  });
});

test('管理 API 保存并回读所有可见配置，不返回 Key 摘要', async () => {
  await withServer(async (baseUrl) => {
    const patch = {
      enabled: true,
      openai: true,
      anthropic: true,
      streaming: false,
      tools: false,
      channelSanitize: false,
      requireApiKey: true,
      remoteRequireKey: false,
      trustProxy: true,
      upstreamBaseUrl: 'http://127.0.0.1:19999/',
      defaultModel: 'deepseek-v4.1-flash',
      firstByteTimeoutMs: 11000,
      idleTimeoutMs: 22000,
      totalTimeoutMs: 33000,
    };
    const updated = await adminFetch(baseUrl, '/api/api-compat', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json();
    for (const [key, value] of Object.entries(patch)) {
      assert.equal(updatedBody[key], key === 'upstreamBaseUrl' ? String(value).replace(/\/+$/, '') : value);
    }
    assert.equal(JSON.stringify(updatedBody).includes('hash'), false);

    const readBack = await adminFetch(baseUrl, '/api/api-compat');
    assert.equal(readBack.status, 200);
    const body = await readBack.json();
    for (const [key, value] of Object.entries(patch)) {
      assert.equal(body[key], key === 'upstreamBaseUrl' ? String(value).replace(/\/+$/, '') : value);
    }
    assert.equal(body.clientKeyConfigured, false);
  });
});

test('Key 明文只在创建响应出现一次，列表与页面不回显', async () => {
  await withServer(async (baseUrl) => {
    const created = await adminFetch(baseUrl, '/api/api-compat/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'management-ui' }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.match(createdBody.key, /^sk-wb_/);
    assert.equal(settings.verifyApiKey(createdBody.key), true);

    const listed = await adminFetch(baseUrl, '/api/api-compat');
    const listedBody = await listed.json();
    assert.equal(JSON.stringify(listedBody).includes(createdBody.key), false);
    assert.equal(JSON.stringify(listedBody).includes('hash'), false);
    assert.equal(listedBody.clientKeyConfigured, true);

    const html = await (await adminFetch(baseUrl, '/admin')).text();
    assert.equal(html.includes(createdBody.key), false);
  });
});

test('连接测试端点不依赖 CLI，且只返回脱敏摘要', async () => {
  const { probeApiConnection } = await import('../../src/api-server.js');
  const calls = [];
  const result = await probeApiConnection({
    protocol: 'openai',
    config: {
      defaultModel: 'deepseek-v4.1-flash',
      upstreamBaseUrl: 'http://127.0.0.1:19999',
      channelSanitize: true,
      tools: true,
    },
    runtime: {
      async chat({ body }) {
        calls.push({ protocol: 'openai', body });
        return {
          ok: true,
          account: 'fixture-account',
          durationMs: 12,
          usage: { prompt_tokens: 3, completion_tokens: 1 },
        };
      },
    },
  });
  assert.deepEqual(result, {
    ok: true,
    protocol: 'openai',
    account: 'fixture-account',
    durationMs: 12,
    code: 'OK',
  });
  assert.deepEqual(calls, [{ protocol: 'openai', body: { prompt: 'Reply with exactly: ok', stream: false } }]);
});

test('Anthropic 连接测试走工具探测路径并显示同一账号', async () => {
  const { probeApiConnection } = await import('../../src/api-server.js');
  const calls = [];
  const result = await probeApiConnection({
    protocol: 'anthropic',
    config: { defaultModel: 'deepseek-v4.1-flash', tools: true },
    runtime: {
      async chat({ body, config }) {
        calls.push({ body, config });
        return {
          ok: true,
          account: 'fixture-anthropic',
          durationMs: 21,
          code: 'OK',
          toolRoundtrip: true,
        };
      },
    },
  });
  assert.deepEqual(result, {
    ok: true,
    protocol: 'anthropic',
    account: 'fixture-anthropic',
    durationMs: 21,
    code: 'OK',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].config.tools, true);
  assert.match(calls[0].body.prompt, /tool/i);
});

test('连接测试失败只暴露 account、耗时与错误码', async () => {
  const { probeApiConnection } = await import('../../src/api-server.js');
  const result = await probeApiConnection({
    protocol: 'anthropic',
    config: { defaultModel: 'deepseek-v4.1-flash', tools: true },
    runtime: {
      async chat() {
        throw Object.assign(new Error('secret prompt token sk-wb_do_not_leak'), {
          code: 'AUTH_REQUIRED',
          account: 'fixture-account',
        });
      },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.protocol, 'anthropic');
  assert.equal(result.account, 'fixture-account');
  assert.equal(result.code, 'AUTH_REQUIRED');
  assert.equal(JSON.stringify(result).includes('secret prompt'), false);
  assert.equal(JSON.stringify(result).includes('sk-wb_'), false);
  assert.equal(Object.hasOwn(result, 'error'), false);
});


test('Anthropic 工具探针走真实 HTTP runtime、号池租约与脱敏结果', async () => {
  const accounts = await import('../../src/accounts.js');
  const pool = await import('../../src/pool.js');
  const http = await import('node:http');
  const { once } = await import('node:events');

  const accountName = 'probe-tool-account';
  for (const account of pool.loadPool().accounts ? Object.keys(pool.loadPool().accounts) : []) {
    if (account !== accountName) pool.updateAccount(account, { enabled: false });
  }
  accounts.ensureAccount(accountName);
  const authDir = accounts.accountAuthDir(accountName);
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-probe-tool' },
    auth: {
      accessToken: 'probe-access',
      refreshToken: 'probe-refresh',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 7200000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount(accountName, { enabled: true, maxConcurrency: 1 });

  const upstreamBodies = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstreamBodies.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_probe",'
      + '"function":{"name":"probe_echo","arguments":"{\\"value\\":7}"}}]},'
      + '"finish_reason":"tool_calls"}]}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  settings.updateApiSettings({
    enabled: true,
    anthropic: true,
    openai: false,
    streaming: true,
    tools: true,
    requireApiKey: false,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    defaultModel: 'deepseek-v4.1-flash',
    firstByteTimeoutMs: 1000,
    idleTimeoutMs: 1500,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
  });

  try {
    await withServer(async (baseUrl) => {
      const response = await adminFetch(baseUrl, '/api/api-compat/test', {
        method: 'POST',
        body: JSON.stringify({ protocol: 'anthropic' }),
      });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.protocol, 'anthropic');
      assert.equal(result.account, accountName);
      assert.equal(result.code, 'OK');
      assert.equal(JSON.stringify(result).includes('probe_echo'), false);
      assert.equal(JSON.stringify(result).includes('probe-access'), false);
    });
  } finally {
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }

  assert.equal(upstreamBodies.length, 2, JSON.stringify(upstreamBodies));
  assert.equal(upstreamBodies[0].tools[0].function.name, 'probe_echo');
  assert.equal(upstreamBodies[0].tool_choice, 'probe_echo');
  assert.equal(upstreamBodies[1].tools[0].function.name, 'probe_echo');
  assert.equal(
    pool.poolView().accounts.find((item) => item.name === accountName).inflight,
    0,
  );
  assert.equal(pool.loadPool().accounts[accountName].today.req, 2);
});
