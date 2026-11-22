import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-concurrency-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ALLOW_PRIVATE_UPSTREAM = '1';

const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');

function writeCredential(name) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fixture.info'), JSON.stringify({
    account: { uid: `uid-${name}`, nickname: name },
    auth: {
      accessToken: `token-${name}`,
      refreshToken: `token-${name}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 7_200_000,
    },
    accounts: [],
  }), { mode: 0o600 });
}

/** 只留一个号，并发槽位按参数设。单号最能看清「槽位到底有没有生效」。 */
function soloAccount(name, maxConcurrency) {
  for (const account of accounts.listAccounts()) accounts.removeAccount(account.name);
  const current = pool.loadPool();
  current.accounts = {};
  pool.savePool(current);
  writeCredential(name);
  pool.updateAccount(name, { enabled: true, maxConcurrency });
}

async function startUpstream(holdMs) {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls += 1;
    inflight += 1;
    peak = Math.max(peak, inflight);
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    inflight -= 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    get calls() { return calls; },
    get peak() { return peak; },
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
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 10000,
  });
  const bridge = await startHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(`http://127.0.0.1:${bridge.port}`);
  } finally {
    await bridge.close({ graceMs: 500 });
  }
}

function chat(baseUrl) {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'concurrency-fixture' }],
    }),
  });
}

test('maxConcurrency=3：3 个并发真的并行，第 4 个明确返回「忙」', async (t) => {
  soloAccount('conc-a', 3);
  const upstream = await startUpstream(400);
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const first = await Promise.all([chat(baseUrl), chat(baseUrl), chat(baseUrl)]);
    for (const response of first) {
      assert.equal(response.status, 200);
      await response.text();
    }

    // 前 3 个已经跑完，槽位应该全部释放
    const row = pool.poolView().accounts.find((item) => item.name === 'conc-a');
    assert.equal(row.inflight, 0, '请求结束后并发占位必须归零');

    // 并发打满时第 4 个必须给出明确原因，而不是 500
    const running = [chat(baseUrl), chat(baseUrl), chat(baseUrl)];
    const rejected = await chat(baseUrl);
    assert.equal(rejected.status, 503, '第 4 个并发应为 503');
    const body = await rejected.json();
    assert.equal(body.error.code, 'POOL_EMPTY');
    assert.match(body.error.message, /并发已满/);

    for (const response of await Promise.all(running)) {
      assert.equal(response.status, 200);
      await response.text();
    }
  }, upstream.url);

  assert.equal(upstream.peak, 3, '上游侧同一时刻最多 3 个在途');
  const row = pool.poolView().accounts.find((item) => item.name === 'conc-a');
  assert.equal(row.today.peakInflight, 3, '峰值并发要有记录');
  assert.equal(row.inflight, 0);
});

test('改回 1 立刻生效，不需要重启', async (t) => {
  soloAccount('conc-b', 3);
  const upstream = await startUpstream(50);
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const ok = await chat(baseUrl);
    assert.equal(ok.status, 200);
    await ok.text();

    pool.updateAccount('conc-b', { maxConcurrency: 1 });
    assert.equal(
      pool.poolView().accounts.find((item) => item.name === 'conc-b').maxConcurrency,
      1,
      '面板读到的就是新值（配置写同步落盘）',
    );
  }, upstream.url);
});

test('客户端中断后 inflight 归零，后续请求照常选号', async (t) => {
  soloAccount('conc-c', 1);
  const upstream = await startUpstream(2000);
  t.after(() => upstream.close());

  await withBridge(async (baseUrl) => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4.1-flash',
        stream: true,
        messages: [{ role: 'user', content: 'drop-me' }],
      }),
      signal: controller.signal,
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 250));
    controller.abort();
    await pending;

    const deadline = Date.now() + 4000;
    let row = pool.poolView().accounts.find((item) => item.name === 'conc-c');
    while (row.inflight !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = pool.poolView().accounts.find((item) => item.name === 'conc-c');
    }
    assert.equal(row.inflight, 0, '中断后并发占位应归零');
  }, upstream.url);
});
