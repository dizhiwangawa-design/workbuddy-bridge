import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-settings-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ADMIN_TOKEN = 'admin-fixture';

const settings = await import('../../src/api-settings.js');
const paths = await import('../../src/paths.js');
const { startHttpServer } = await import('../../src/http.js');
const { clientKeyRequired } = await import('../../src/api-server.js');

async function withServer(fn) {
  const server = await startHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

test('API 兼容默认开启 Anthropic，并保留 OpenAI 关闭', async () => {
  const config = settings.getApiSettings();
  assert.equal(config.enabled, true);
  assert.equal(config.openai, false);
  assert.equal(config.anthropic, true);
  assert.equal(config.anthropicEnabled, true);
  assert.equal(config.streaming, true);
  assert.equal(config.tools, true);
  assert.equal(config.requireApiKey, false);
  assert.equal(config.remoteRequireKey, true);
  assert.equal(config.trustProxy, false);
  assert.equal(config.dsmlMaxBufferBytes, 2097152);
  assert.equal(config.firstByteTimeoutMs, 60000);
  assert.equal(config.idleTimeoutMs, 120000);
  assert.equal(config.finishGraceMs, 2000);
  assert.equal(config.totalTimeoutMs, 600000);

  await withServer(async (baseUrl) => {
    const openai = await fetch(`${baseUrl}/v1/models`);
    assert.equal(openai.status, 404);
    const openaiBody = await openai.json();
    assert.equal(openaiBody.error.type, 'invalid_request_error');
    assert.match(openaiBody.error.message, /disabled/i);

    const anthropic = await fetch(`${baseUrl}/v1/messages`);
    assert.equal(anthropic.status, 405);
    const anthropicBody = await anthropic.json();
    assert.equal(anthropicBody.type, 'error');
    assert.equal(anthropicBody.error.type, 'invalid_request_error');
  });
});

test('回环免 Key；非回环或可信代理强制 Key', () => {
  const config = {
    requireApiKey: false,
    remoteRequireKey: true,
    trustProxy: false,
  };
  assert.equal(clientKeyRequired({ remoteAddress: '127.0.0.1' }, config), false);
  assert.equal(clientKeyRequired({ remoteAddress: '::1' }, config), false);
  assert.equal(clientKeyRequired({ remoteAddress: '::ffff:127.0.0.1' }, config), false);
  assert.equal(clientKeyRequired({ remoteAddress: '192.0.2.10' }, config), true);
  assert.equal(clientKeyRequired(
    { remoteAddress: '127.0.0.1' },
    { ...config, trustProxy: true },
  ), true);
  assert.equal(clientKeyRequired(
    { remoteAddress: '127.0.0.1' },
    { ...config, requireApiKey: true },
  ), true);
});

test('从旧版全局关闭状态启用 Anthropic 时恢复 API 总开关', () => {
  settings.updateApiSettings({ enabled: false, anthropic: false });
  const enabled = settings.updateApiSettings({ anthropic: true });

  assert.equal(enabled.enabled, true);
  assert.equal(enabled.anthropic, true);
  assert.equal(enabled.anthropicEnabled, true);
});

test('API Key 只返回一次明文，配置只保存摘要', () => {
  const created = settings.createApiKey('test');
  assert.match(created.key, /^sk-wb_/);
  assert.equal(created.record.hash, undefined);
  assert.equal(settings.verifyApiKey(created.key), true);
  assert.equal(settings.verifyApiKey('sk-wb_invalid'), false);

  const saved = settings.getApiSettings();
  const raw = fs.readFileSync(paths.BRIDGE_CONFIG, 'utf8');
  assert.equal(JSON.stringify(saved).includes(created.key), false);
  assert.equal(raw.includes(created.key), false);
  assert.equal(saved.keys[0].hash.length, 64);
  const publicSettings = settings.publicApiSettings();
  assert.equal(JSON.stringify(publicSettings).includes('"hash"'), false);
  assert.equal(publicSettings.clientKeyConfigured, true);
});

test('重置客户端 Key 会撤销全部旧 Key 并只保留一份新摘要', () => {
  const first = settings.createApiKey('before-reset-1');
  const second = settings.createApiKey('before-reset-2');
  assert.equal(settings.verifyApiKey(first.key), true);
  assert.equal(settings.verifyApiKey(second.key), true);

  const reset = settings.resetApiKey('after-reset');
  assert.equal(settings.verifyApiKey(first.key), false);
  assert.equal(settings.verifyApiKey(second.key), false);
  assert.equal(settings.verifyApiKey(reset.key), true);
  assert.equal(settings.getApiSettings().keys.length, 1);
  assert.equal(settings.getApiSettings().keys[0].hash.length, 64);
  assert.equal(JSON.stringify(reset).includes(settings.getApiSettings().keys[0].hash), false);
});

test('管理 API 校验令牌并按白名单更新配置', async () => {
  await withServer(async (baseUrl) => {
    const denied = await fetch(`${baseUrl}/api/api-compat`);
    assert.equal(denied.status, 401);

    const headers = {
      'x-wb-token': 'admin-fixture',
      'content-type': 'application/json',
    };
    const patched = await fetch(`${baseUrl}/api/api-compat`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        enabled: true,
        openai: true,
        anthropic: true,
        anthropicEnabled: true,
        streaming: true,
        tools: true,
        remoteRequireKey: false,
        trustProxy: true,
        dsmlMaxBufferBytes: 1048576,
        firstByteTimeoutMs: 12000,
        idleTimeoutMs: 34000,
        finishGraceMs: 1500,
        totalTimeoutMs: 45000,
        timeoutMs: 12345,
        keys: [{ id: 'injected' }],
        unknownField: 'ignored',
      }),
    });
    assert.equal(patched.status, 200);
    const body = await patched.json();
    assert.equal(body.enabled, true);
    assert.equal(body.openai, true);
    assert.equal(body.anthropicEnabled, true);
    assert.equal(body.remoteRequireKey, false);
    assert.equal(body.trustProxy, true);
    assert.equal(body.dsmlMaxBufferBytes, 1048576);
    assert.equal(body.firstByteTimeoutMs, 12000);
    assert.equal(body.idleTimeoutMs, 34000);
    assert.equal(body.finishGraceMs, 1500);
    assert.equal(body.totalTimeoutMs, 45000);
    assert.equal(body.timeoutMs, 12345);
    assert.equal(body.keys.some((item) => item.id === 'injected'), false);

    const created = await fetch(`${baseUrl}/api/api-compat/keys`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'admin-created' }),
    });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.match(createdBody.key, /^sk-wb_/);

    const removed = await fetch(`${baseUrl}/api/api-compat/keys/${createdBody.record.id}`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).deleted, true);

    const reset = await fetch(`${baseUrl}/api/api-compat/keys/reset`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'admin-reset' }),
    });
    assert.equal(reset.status, 200);
    const resetBody = await reset.json();
    assert.match(resetBody.key, /^sk-wb_/);
    assert.equal(settings.verifyApiKey(resetBody.key), true);
  });
});

test('Responses 持久化和续跑提示在 OpenAI 关闭时不可开启', () => {
  settings.updateApiSettings({ openai: false, responsesPersistence: false, responsesNudge: false });
  assert.throws(
    () => settings.updateApiSettings({ responsesPersistence: true }),
    /requires OpenAI/,
  );
  settings.updateApiSettings({ openai: true, responsesPersistence: true });
  assert.throws(
    () => settings.updateApiSettings({ openai: false, responsesPersistence: true }),
    /requires OpenAI/,
  );
  const updated = settings.updateApiSettings({ openai: false, responsesPersistence: false });
  assert.equal(updated.openai, false);
  assert.equal(updated.responsesPersistence, false);
  assert.equal(updated.responsesNudge, false);
});

test('Bearer 与 x-api-key 共用同一套客户端 Key', async () => {
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: true,
    requireApiKey: true,
  });
  const created = settings.createApiKey('route-check');

  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/v1/models`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'invalid_api_key');

    const bearer = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    assert.equal(bearer.status, 200);
    assert.equal((await bearer.json()).object, 'list');

    const xApiKey = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'x-api-key': created.key },
    });
    assert.equal(xApiKey.status, 200);
    assert.equal((await xApiKey.json()).object, 'list');

    const anthropicMissing = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(anthropicMissing.status, 401);
    const anthropicError = await anthropicMissing.json();
    assert.equal(anthropicError.type, 'error');
    assert.equal(anthropicError.error.type, 'authentication_error');

    const anthropicAuthorized = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': created.key,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(anthropicAuthorized.status, 400);
    assert.equal((await anthropicAuthorized.json()).type, 'error');
  });
});

test('未知 API 路径和错误方法不会回退到管理页', async () => {
  settings.updateApiSettings({ enabled: true, openai: true, anthropic: true });
  const created = settings.createApiKey('routing');
  const headers = { authorization: `Bearer ${created.key}` };

  await withServer(async (baseUrl) => {
    const unknown = await fetch(`${baseUrl}/v1/unknown`, { headers });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, 'not_found');

    const wrongMethod = await fetch(`${baseUrl}/v1/chat/completions`, { headers });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed');
  });
});

test('/health 只返回状态且现有管理页仍可访问', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"status":"ok"}');

    const admin = await fetch(`${baseUrl}/admin?token=admin-fixture`);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /WorkBuddy/);
  });
});

for (const [name, header, status] of [
  ['缺失', null, 401],
  ['错误', 'Bearer sk-wb_invalid', 401],
]) {
  test(`Responses WS ${name} Key 在握手阶段拒绝`, async () => {
    settings.updateApiSettings({
      enabled: true,
      openai: true,
      requireApiKey: true,
    });
    await withServer(async (baseUrl) => {
      const ws = new WebSocket(
        `${baseUrl.replace(/^http/, 'ws')}/v1/responses`,
        header ? { headers: { authorization: header } } : {},
      );
      const [, response] = await once(ws, 'unexpected-response');
      assert.equal(response.statusCode, status);
      assert.equal(response.headers.connection, 'close');
    });
  });
}
