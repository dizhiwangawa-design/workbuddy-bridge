import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  aggregateOpenAI,
  mapModelCatalogue,
  prepareOpenAIRequest,
  toOpenAIResponse,
} from '../../src/protocols/openai.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-openai-http-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
process.env.WB_COMMAND = path.join(tmp, 'missing-codebuddy');

const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');

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

async function startFixture(t, upstreamHandler) {
  const currentPool = pool.loadPool();
  for (const name of Object.keys(currentPool.accounts)) {
    if (name !== 'openai-a') pool.updateAccount(name, { enabled: false });
  }
  createAccount('openai-a');

  const upstreamServer = http.createServer(upstreamHandler);
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');

  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: false,
    streaming: false,
    tools: false,
    requireApiKey: false,
    remoteRequireKey: false,
    trustProxy: false,
    defaultModel: 'deepseek-v4-flash',
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
  });

  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: { upstreamClient },
  });

  t.after(async () => {
    await bridge.close();
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${bridge.port}` };
}

function inflight(name) {
  return pool.poolView().accounts.find((item) => item.name === name)?.inflight;
}

test('OpenAI 请求转换为上游流式请求并保留文本消息', () => {
  const input = {
    model: 'deepseek-v4-flash',
    stream: false,
    stream_options: { include_usage: true },
    messages: [
      { role: 'developer', content: 'Be concise.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' },
        ],
      },
    ],
  };
  const before = structuredClone(input);
  const prepared = prepareOpenAIRequest(input, {
    defaultModel: 'fallback-model',
  });

  assert.equal(prepared.body.model, 'deepseek-v4-flash');
  assert.equal(prepared.body.stream, true);
  assert.equal('stream_options' in prepared.body, false);
  assert.equal(prepared.body.messages[0].role, 'developer');
  assert.equal(prepared.body.messages[1].content, 'first\nsecond');
  assert.deepEqual(input, before);
});

test('OpenAI 最小适配明确拒绝流式、tools 和非文本内容', () => {
  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  }), (error) => error.status === 400 && error.code === 'stream_not_supported');

  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
  }), (error) => error.status === 400 && error.code === 'tools_not_supported');

  assert.throws(() => prepareOpenAIRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.test/x.png' } }],
    }],
  }), (error) => error.status === 400 && /text/.test(error.message));
});

test('OpenAI SSE 聚合生成标准非流式响应', async () => {
  const aggregate = await aggregateOpenAI([
    '{"id":"up-1","created":123,"choices":[{"delta":{"content":"po"}}]}',
    {
      choices: [{
        delta: { content: 'ng', reasoning_content: 'think' },
      }],
    },
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
    '[DONE]',
  ]);
  const response = toOpenAIResponse(aggregate, 'deepseek-v4-flash', {
    now: () => 456,
  });

  assert.equal(response.id, 'up-1');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.created, 123);
  assert.equal(response.model, 'deepseek-v4-flash');
  assert.equal(response.choices[0].message.content, 'pong');
  assert.equal(response.choices[0].message.reasoning_content, 'think');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.usage, {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4,
  });
});

test('模型目录映射成功结果并生成稳定 fallback', () => {
  const mapped = mapModelCatalogue({
    data: {
      models: [
        { id: 'model-a', name: 'Model A', maxInputTokens: 1000, maxOutputTokens: 200 },
      ],
    },
  });
  assert.deepEqual(mapped, [{
    id: 'model-a',
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    name: 'Model A',
    context_window: 1000,
    max_output_tokens: 200,
  }]);

  const fallback = mapModelCatalogue(null, {
    defaultModel: 'deepseek-v4-flash',
  });
  assert(fallback.some((model) => model.id === 'deepseek-v4-flash'));
  assert(fallback.every((model) => model.wb_source === 'fallback'));
});

test('POST /v1/chat/completions 返回文本、usage 并释放号池租约', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    if (req.url === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          models: [{
            id: 'deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
          }],
        },
      }));
      return;
    }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    received = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"cmb-1","created":1,"choices":[{"delta":{"content":"po"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"ng"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
    res.end('data: [DONE]\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(received.stream, true);
  assert.equal(received.model, 'deepseek-v4-flash');
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.id, 'cmb-1');
  assert.equal(json.model, 'deepseek-v4-flash');
  assert.equal(json.choices[0].message.role, 'assistant');
  assert.equal(json.choices[0].message.content, 'pong');
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.deepEqual(json.usage, {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4,
  });
  assert.equal(inflight('openai-a'), 0);

  const models = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.equal(models.object, 'list');
  assert.equal(models.data[0].id, 'deepseek-v4-flash');
  assert.equal(models.data[0].name, 'DeepSeek V4 Flash');

  const one = await fetch(`${baseUrl}/v1/models/deepseek-v4-flash`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).id, 'deepseek-v4-flash');
  assert.equal(inflight('openai-a'), 0);
});

test('模型目录不可用时返回 fallback，未知模型返回 OpenAI 404', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"not available"}}');
  });

  const modelsResponse = await fetch(`${baseUrl}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  assert(models.data.some((model) => model.id === 'deepseek-v4-flash'));
  assert(models.data.every((model) => model.wb_source === 'fallback'));

  const missing = await fetch(`${baseUrl}/v1/models/not-found`);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, 'model_not_found');
});

test('OpenAI 不支持项使用 OpenAI 错误形状', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'stream_not_supported');
  assert.match(body.error.message, /streaming/i);
});

test('管理页提供独立的 OpenAI 开关和接口地址', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":{"models":[]}}');
  });
  const html = await (await fetch(`${baseUrl}/admin`)).text();
  assert.match(html, /data-act="api-openai-toggle"/);
  assert.match(html, /data-act="api-copy-openai-endpoint"/);
  const updated = await fetch(`${baseUrl}/api/api-compat`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ openai: false }),
  });
  assert.equal(updated.status, 200);
  const config = await updated.json();
  assert.equal(config.openai, false);
  assert.equal(config.anthropic, false);
});
