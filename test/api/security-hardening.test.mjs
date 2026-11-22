import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-hardening-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');

function clearEnv() {
  delete process.env.WB_ADMIN_TOKEN;
  delete process.env.WB_ALLOW_PRIVATE_UPSTREAM;
  delete process.env.WB_UPSTREAM_ALLOW_HOSTS;
}

/* ---------------------------------------------------------------- 管理门禁 */

test('非回环监听且未设 WB_ADMIN_TOKEN 时拒绝启动', async () => {
  clearEnv();
  await assert.rejects(
    () => startHttpServer({ port: 0, host: '0.0.0.0', apiDeps: {} }),
    (error) => error.code === 'ADMIN_TOKEN_REQUIRED'
      && /非回环地址必须设置 WB_ADMIN_TOKEN/.test(error.message),
  );
});

test('非回环监听设了 WB_ADMIN_TOKEN 就能启动，且 API 必须带正确令牌', async () => {
  clearEnv();
  process.env.WB_ADMIN_TOKEN = 'listen-token';
  const server = await startHttpServer({ port: 0, host: '0.0.0.0', apiDeps: {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const anonymous = await fetch(`${base}/api/api-compat`);
    assert.equal(anonymous.status, 401, '没带令牌必须被拒');

    const wrong = await fetch(`${base}/api/api-compat`, { headers: { 'x-wb-token': 'nope' } });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/api/api-compat`, { headers: { 'x-wb-token': 'listen-token' } });
    assert.equal(ok.status, 200);

    // 查询串只对管理页开放，API 一律不认
    const queryOnApi = await fetch(`${base}/api/api-compat?token=listen-token`);
    assert.equal(queryOnApi.status, 401, 'API 不得接受 URL 里的令牌');
  } finally {
    await server.close({ graceMs: 500 });
    clearEnv();
  }
});

test('回环监听未设令牌时保持本地开发体验（放行）', async () => {
  clearEnv();
  const server = await startHttpServer({ port: 0, host: '127.0.0.1', apiDeps: {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const response = await fetch(`${base}/api/api-compat`);
    assert.equal(response.status, 200);
  } finally {
    await server.close({ graceMs: 500 });
  }
});

test('写操作（改鉴权开关、建 Key）在门禁生效后必须带令牌', async () => {
  clearEnv();
  process.env.WB_ADMIN_TOKEN = 'write-token';
  const server = await startHttpServer({ port: 0, host: '0.0.0.0', apiDeps: {} });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const patch = await fetch(`${base}/api/api-compat`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remoteRequireKey: false }),
    });
    assert.equal(patch.status, 401, '匿名改配置必须被拒');

    const create = await fetch(`${base}/api/api-compat/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'anonymous' }),
    });
    assert.equal(create.status, 401, '匿名建 Key 必须被拒');

    // 令牌比较走定长比较，长度不同也不能抛
    const long = await fetch(`${base}/api/api-compat`, {
      headers: { 'x-wb-token': 'x'.repeat(4096) },
    });
    assert.equal(long.status, 401);
    assert.equal(settings.getApiSettings().keys.length, 0, '被拒的请求不得留下 Key');
  } finally {
    await server.close({ graceMs: 500 });
    clearEnv();
  }
});

/* ------------------------------------------------------------ 上游地址白名单 */

test('上游地址禁止本机与内网，公网域名放行', () => {
  clearEnv();
  for (const url of [
    'http://127.0.0.1:1234',
    'http://localhost:1234',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.10',
    'http://169.254.169.254',
    'http://[::1]:9000',
    'http://0.0.0.0:80',
  ]) {
    assert.throws(() => settings.updateApiSettings({ upstreamBaseUrl: url }), /本机或内网/);
  }
  settings.updateApiSettings({ upstreamBaseUrl: 'https://copilot.tencent.com' });
  assert.equal(settings.getApiSettings().upstreamBaseUrl, 'https://copilot.tencent.com');
});

test('WB_ALLOW_PRIVATE_UPSTREAM=1 显式放行内网地址', () => {
  clearEnv();
  process.env.WB_ALLOW_PRIVATE_UPSTREAM = '1';
  try {
    settings.updateApiSettings({ upstreamBaseUrl: 'http://127.0.0.1:19999' });
    assert.equal(settings.getApiSettings().upstreamBaseUrl, 'http://127.0.0.1:19999');
  } finally {
    clearEnv();
  }
});

test('WB_UPSTREAM_ALLOW_HOSTS 设了就只认白名单主机（支持通配）', () => {
  clearEnv();
  process.env.WB_UPSTREAM_ALLOW_HOSTS = 'gw.example.com,*.corp.example';
  try {
    settings.updateApiSettings({ upstreamBaseUrl: 'https://gw.example.com' });
    settings.updateApiSettings({ upstreamBaseUrl: 'https://api.corp.example' });
    assert.throws(
      () => settings.updateApiSettings({ upstreamBaseUrl: 'https://attacker.example' }),
      /白名单/,
    );
  } finally {
    clearEnv();
  }
});

/* --------------------------------------------------------------- 热更新 */

test('upstreamBaseUrl 与 timeoutMs 是热更新：改配置即刻影响客户端', () => {
  clearEnv();
  settings.updateApiSettings({ upstreamBaseUrl: 'https://copilot.tencent.com' });
  const client = createUpstreamClient({ fetchImpl: async () => new Response('{}') });
  assert.equal(client.endpoint, 'https://copilot.tencent.com');

  settings.updateApiSettings({ upstreamBaseUrl: 'https://gw-one.example.com/' });
  assert.equal(client.endpoint, 'https://gw-one.example.com', '尾部斜杠应被去掉且立即生效');

  settings.updateApiSettings({ upstreamBaseUrl: 'https://gw-two.example.com' });
  assert.equal(client.endpoint, 'https://gw-two.example.com');
});

test('显式传入 baseUrl 的客户端保持固定（测试夹具不跟随全局配置）', () => {
  clearEnv();
  settings.updateApiSettings({ upstreamBaseUrl: 'https://copilot.tencent.com' });
  const pinned = createUpstreamClient({
    baseUrl: 'http://127.0.0.1:1234',
    fetchImpl: async () => new Response('{}'),
  });
  settings.updateApiSettings({ upstreamBaseUrl: 'https://gw-three.example.com' });
  assert.equal(pinned.endpoint, 'http://127.0.0.1:1234');
});
