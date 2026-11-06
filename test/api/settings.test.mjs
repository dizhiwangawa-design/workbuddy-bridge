import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-settings-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_ADMIN_TOKEN = 'admin-fixture';

const settings = await import('../../src/api-settings.js');
const paths = await import('../../src/paths.js');
const { startHttpServer } = await import('../../src/http.js');

async function withServer(fn) {
  const server = await startHttpServer({ port: 0, host: '127.0.0.1' });
  try {
    return await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

test('API 兼容默认关闭', async () => {
  const config = settings.getApiSettings();
  assert.equal(config.enabled, false);
  assert.equal(config.openai, false);
  assert.equal(config.anthropic, false);
  assert.equal(config.streaming, false);
  assert.equal(config.tools, false);
  assert.equal(config.requireApiKey, true);

  await withServer(async (baseUrl) => {
    const openai = await fetch(`${baseUrl}/v1/models`);
    assert.equal(openai.status, 404);
    const openaiBody = await openai.json();
    assert.equal(openaiBody.error.type, 'invalid_request_error');
    assert.match(openaiBody.error.message, /disabled/i);

    const anthropic = await fetch(`${baseUrl}/v1/messages`);
    assert.equal(anthropic.status, 404);
    const anthropicBody = await anthropic.json();
    assert.equal(anthropicBody.type, 'error');
    assert.equal(anthropicBody.error.type, 'invalid_request_error');
    assert.match(anthropicBody.error.message, /disabled/i);
  });
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
  assert.equal(JSON.stringify(settings.publicApiSettings()).includes('"hash"'), false);
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
        streaming: true,
        tools: true,
        timeoutMs: 12345,
        keys: [{ id: 'injected' }],
        unknownField: 'ignored',
      }),
    });
    assert.equal(patched.status, 200);
    const body = await patched.json();
    assert.equal(body.enabled, true);
    assert.equal(body.openai, true);
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
  });
});

test('Bearer 与 x-api-key 共用同一套客户端 Key', async () => {
  settings.updateApiSettings({ enabled: true, openai: true, anthropic: true });
  const created = settings.createApiKey('route-check');

  await withServer(async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/v1/models`);
    assert.equal(missing.status, 401);
    assert.equal((await missing.json()).error.code, 'invalid_api_key');

    const bearer = await fetch(`${baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    assert.equal(bearer.status, 501);

    const xApiKey = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'x-api-key': created.key },
    });
    assert.equal(xApiKey.status, 501);

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
    assert.equal(anthropicAuthorized.status, 501);
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
