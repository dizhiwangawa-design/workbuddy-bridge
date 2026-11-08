import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
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
const { createOpenAIRuntime } = await import('../../src/api-runtime.js');
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

async function startFixture(t, upstreamHandler, overrides = {}) {
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
    streaming: true,
    tools: true,
    requireApiKey: false,
    remoteRequireKey: false,
    trustProxy: false,
    defaultModel: 'deepseek-v4.1-flash',
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
    ...overrides,
  });

  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
  });
  const store = overrides.cancelStore || createResponsesStore({
    directory: path.join(tmp, `openai-cancel-${Date.now()}-${Math.random()}`),
  });
  const apiDeps = { upstreamClient, cancelPersistence: store };
  if (overrides.reasoningCatalogue) {
    apiDeps.reasoningCatalogue = overrides.reasoningCatalogue;
  }
  delete overrides.cancelStore;
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps,
  });

  t.after(async () => {
    await bridge.close();
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  return { baseUrl: `http://127.0.0.1:${bridge.port}`, store, upstreamServer };
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const data = block.split('\n').find((line) => line.startsWith('data: '));
    if (!data) continue;
    try {
      events.push(JSON.parse(data.slice(6)));
    } catch {
      // [DONE] and comments are not JSON events.
    }
  }
  return events;
}

function inflight(name) {
  return pool.poolView().accounts.find((item) => item.name === name)?.inflight;
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function sendKernelRst(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const socket = net.createConnection({
      host: parsed.hostname,
      port: Number(parsed.port),
    });
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

test('OpenAI 请求转换为上游流式请求并保留文本消息', () => {
  const input = {
    model: 'deepseek-v4.1-flash',
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

  assert.equal(prepared.body.model, 'deepseek-v4.1-flash');
  assert.equal(prepared.body.stream, true);
  assert.equal('stream_options' in prepared.body, false);
  assert.equal(prepared.body.messages[0].role, 'developer');
  assert.equal(prepared.body.messages[1].content, 'first\nsecond');
  assert.deepEqual(input, before);
});

test('OpenAI tools、tool_choice 与历史 tool 往返可转换为上游格式', () => {
  const tool = {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  };
  const prepared = prepareOpenAIRequest({
    messages: [
      { role: 'user', content: '读取 README' },
      { role: 'assistant', content: null, tool_calls: [{
        id: 'call_previous',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }] },
      { role: 'tool', tool_call_id: 'call_previous', content: '文件内容' },
      { role: 'user', content: '继续' },
    ],
    tools: [tool],
    tool_choice: { type: 'function', function: { name: 'read_file' } },
  });
  assert.equal(prepared.body.messages[1].tool_calls[0].id, 'call_previous');
  assert.equal(prepared.body.messages[2].role, 'tool');
  assert.equal(prepared.body.messages[2].tool_call_id, 'call_previous');
  assert.equal(prepared.body.tools[0].function.name, 'read_file');
  assert.equal(prepared.body.tool_choice.function.name, 'read_file');
  assert.equal(prepared.toolsDeclared, true);
});

test('OpenAI 请求接受 SSE 与图片，并明确拒绝关闭的工具和 file_id', () => {
  const streaming = prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  assert.equal(streaming.body.stream, true);

  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
  }, { toolsEnabled: false }), (error) => error.status === 400 && error.code === 'tools_disabled');

  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    function_call: 'auto',
  }), (error) => error.status === 400 && error.code === 'tools_not_supported');
  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    parallel_tool_calls: false,
  }), (error) => error.status === 400 && error.code === 'parallel_tool_calls_not_supported');

  const invalidTools = [
    [{ type: 'custom', function: { name: 'x', parameters: {} } }],
    [{ type: 'function', function: { name: '', parameters: {} } }],
    [{ type: 'function', function: { name: 'x', parameters: [] } }],
    [
      { type: 'function', function: { name: 'x', parameters: {} } },
      { type: 'function', function: { name: 'x', parameters: {} } },
    ],
  ];
  for (const tools of invalidTools) {
    assert.throws(() => prepareOpenAIRequest({
      messages: [{ role: 'user', content: 'ping' }],
      tools,
    }), (error) => error.status === 400 && error.code === 'invalid_request');
  }

  const image = prepareOpenAIRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'https://example.test/x.png' } }],
    }],
  });
  assert.equal(image.body.messages[0].content[0].type, 'image_url');
  assert.throws(() => prepareOpenAIRequest({
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', file_id: 'file_1' }],
    }],
  }), (error) => error.code === 'file_id_not_supported');
});

test('OpenAI SSE 聚合生成标准非流式响应', async () => {
  const aggregate = await aggregateOpenAI([
    '{"id":"up-1","created":123,"choices":[{"delta":{"content":"po"}}]}',
    {
      choices: [{
        delta: { content: 'ng', reasoning_content: 'think' },
      }],
    },
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"completion_tokens_details":{"reasoning_tokens":0}}}',
    '[DONE]',
  ]);
  const response = toOpenAIResponse(aggregate, 'deepseek-v4.1-flash', {
    now: () => 456,
  });

  assert.equal(response.id, 'up-1');
  assert.equal(response.object, 'chat.completion');
  assert.equal(response.created, 123);
  assert.equal(response.model, 'deepseek-v4.1-flash');
  assert.equal(response.choices[0].message.content, 'pong');
  assert.equal(response.choices[0].message.reasoning_content, 'think');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.usage, {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4,
    completion_tokens_details: { reasoning_tokens: 0 },
  });
});

test('OpenAI 响应保留 length 与 refusal 完成原因', async () => {
  const truncated = toOpenAIResponse({
    content: 'partial',
    finishReason: 'length',
  }, 'deepseek-v4.1-flash');
  assert.equal(truncated.choices[0].finish_reason, 'length');

  const refused = toOpenAIResponse({
    content: '',
    refusal: '无法处理',
    finishReason: 'content_filter',
  }, 'deepseek-v4.1-flash');
  assert.equal(refused.choices[0].message.refusal, '无法处理');
  assert.equal(refused.choices[0].finish_reason, 'content_filter');
});

test('模型目录映射成功结果并生成稳定 fallback', () => {
  const mapped = mapModelCatalogue({
    data: {
      models: [
        {
          id: 'model-a',
          name: 'Model A',
          supportsImages: true,
          maxInputTokens: 1000,
          maxOutputTokens: 200,
          reasoning: {
            supportedEfforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            canDisableThinking: false,
          },
        },
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
    input: ['text', 'image'],
    input_modalities: ['text', 'image'],
    architecture: {
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
    },
    wb_reasoning: {
      form: 'supported',
      supported_efforts: ['low', 'high', 'max'],
      declared_effort: null,
      default_effort: 'high',
      can_disable_thinking: false,
    },
  }]);

  const textOnly = mapModelCatalogue({
    data: {
      models: [{ id: 'text-only', supportsImages: false }],
    },
  });
  assert.deepEqual(textOnly[0].input, ['text']);
  assert.deepEqual(textOnly[0].input_modalities, ['text']);
  assert.deepEqual(textOnly[0].architecture, {
    input_modalities: ['text'],
    output_modalities: ['text'],
  });

  const fallback = mapModelCatalogue(null, {
    defaultModel: 'deepseek-v4.1-flash',
  });
  assert.deepEqual(
    fallback.map((model) => model.id),
    ['auto', 'deepseek-v4.1-flash'],
  );
  assert(fallback.every((model) => model.wb_source === 'fallback'));
  assert(fallback.every((model) => model.wb_reasoning === null));
});

test('模型目录在 TTL 内复用同一份缓存', async (t) => {
  let catalogueCalls = 0;
  const { baseUrl } = await startFixture(t, (req, res) => {
    if (req.url === '/v2/enterprises/personal/models') {
      catalogueCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          models: [{
            id: 'deepseek-v4.1-flash',
            reasoning: {
              supportedEfforts: ['low', 'high', 'max'],
              defaultEffort: 'high',
              canDisableThinking: true,
            },
          }],
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const first = await fetch(`${baseUrl}/v1/models`);
  const second = await fetch(`${baseUrl}/v1/models`);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(catalogueCalls, 1);
});

test('模型目录 refresh=true 强制刷新', async (t) => {
  let catalogueCalls = 0;
  const { baseUrl } = await startFixture(t, (req, res) => {
    if (req.url === '/v2/enterprises/personal/models') {
      catalogueCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          models: [{
            id: 'deepseek-v4.1-flash',
            reasoning: { effort: 'medium' },
          }],
        },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await fetch(`${baseUrl}/v1/models`);
  await fetch(`${baseUrl}/v1/models?refresh=true`);
  await fetch(`${baseUrl}/v1/models`);

  assert.equal(catalogueCalls, 2);
});

function declarationCatalogue(declaration) {
  return {
    getDeclaration() {
      return declaration;
    },
  };
}

const CHAT_THREE_RUNG = {
  form: 'supported',
  efforts: ['low', 'high', 'max'],
  declaredEffort: null,
  defaultEffort: 'high',
  canDisableThinking: true,
};

const CHAT_SINGLE_MEDIUM = {
  form: 'single',
  efforts: ['medium'],
  declaredEffort: 'medium',
  defaultEffort: null,
  canDisableThinking: null,
};

const CHAT_NO_REASONING = {
  form: 'none',
  efforts: [],
  declaredEffort: null,
  defaultEffort: null,
  canDisableThinking: null,
};

test('Chat 按模型支持集合归一化 reasoning_effort 并保留 reasoning usage', async (t) => {
  const bodies = [];
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,'
      + '"completion_tokens_details":{"reasoning_tokens":1}}}\n\n'
      + 'data: [DONE]\n\n',
    );
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_THREE_RUNG),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'route' }],
      reasoning_effort: 'medium',
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(body.usage.completion_tokens_details.reasoning_tokens, 1);
});

test('Chat 流式终帧保留 reasoning_tokens', async (t) => {
  const { baseUrl } = await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\n'
      + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
      + '"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,'
      + '"completion_tokens_details":{"reasoning_tokens":2}}}\n\n'
      + 'data: [DONE]\n\n',
    );
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_THREE_RUNG),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'stream' }],
      reasoning_effort: 'high',
      stream: true,
    }),
  });
  const events = parseSse(await response.text());
  const finalUsage = events.find((event) => event.usage)?.usage;

  assert.equal(response.status, 200);
  assert.equal(finalUsage.completion_tokens_details.reasoning_tokens, 2);
});

test('Chat 单值声明覆盖任意非关闭档位', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_SINGLE_MEDIUM),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deep-model',
      messages: [{ role: 'user', content: 'route' }],
      reasoning_effort: 'max',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.reasoning_effort, 'medium');
});

test('Chat 已知模型缺少 reasoning 时转发 none', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_THREE_RUNG),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'off' }],
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(received.reasoning_effort, 'none');
});

test('Chat 无 reasoning 声明时删除克隆中的字段', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_NO_REASONING),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-4.6',
      messages: [{ role: 'user', content: 'plain' }],
      reasoning_effort: 'high',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal('reasoning_effort' in received, false);
});

test('Chat 未知 reasoning_effort 返回 400 且不请求上游', async (t) => {
  let calls = 0;
  const { baseUrl } = await startFixture(t, (_req, res) => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  }, {
    reasoningCatalogue: declarationCatalogue(CHAT_THREE_RUNG),
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'route' }],
      reasoning_effort: 'hihg',
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'invalid_reasoning_effort');
  assert.equal(calls, 0);
});

test('POST /v1/chat/completions 返回文本、usage 并释放号池租约', async (t) => {
  let received;
  const { baseUrl } = await startFixture(t, async (req, res) => {
    if (req.url === '/v2/enterprises/personal/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        data: {
          models: [{
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4 Flash',
            maxInputTokens: 128000,
            maxOutputTokens: 8192,
          }],
        },
      }));
      return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    await once(req, 'end');
    const raw = Buffer.concat(chunks).toString();
    received = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.write('data: {"id":"cmb-1","created":1,"choices":[{"delta":{"content":"po"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"ng","reasoning_content":"think"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
    res.end('data: [DONE]\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(received.stream, true);
  assert.equal(received.model, 'deepseek-v4.1-flash');
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.id, 'cmb-1');
  assert.equal(json.model, 'deepseek-v4.1-flash');
  assert.equal(json.choices[0].message.role, 'assistant');
  assert.equal(json.choices[0].message.content, 'pong');
  assert.equal(json.choices[0].message.reasoning_content, 'think');
  assert.equal(json.choices[0].finish_reason, 'stop');
  assert.deepEqual(json.usage, {
    prompt_tokens: 3,
    completion_tokens: 1,
    total_tokens: 4,
  });
  assert.equal(inflight('openai-a'), 0);

  const models = await (await fetch(`${baseUrl}/v1/models`)).json();
  assert.equal(models.object, 'list');
  assert.equal(models.data[0].id, 'deepseek-v4.1-flash');
  assert.equal(models.data[0].name, 'DeepSeek V4 Flash');

  const one = await fetch(`${baseUrl}/v1/models/deepseek-v4.1-flash`);
  assert.equal(one.status, 200);
  assert.equal((await one.json()).id, 'deepseek-v4.1-flash');
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
  assert(models.data.some((model) => model.id === 'deepseek-v4.1-flash'));
  assert(models.data.every((model) => model.wb_source === 'fallback'));

  const missing = await fetch(`${baseUrl}/v1/models/not-found`);
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, 'model_not_found');
});

test('OpenAI Chat 在流式开关关闭时拒绝 stream:true 且不请求上游', async (t) => {
  let upstreamRequests = 0;
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"choices":[{"message":{"content":"unexpected"}}]}');
  }, { streaming: false });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'streaming_disabled');
  assert.equal(upstreamRequests, 0);
  assert.equal(inflight('openai-a'), 0);
});

test('OpenAI 上游失败在 SSE 开始前使用 OpenAI 错误形状', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{}');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'ping' }],
      stream: false,
    }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.type, 'api_error');
  assert.equal(body.error.code, 'UPSTREAM_ERROR');
});

test('OpenAI SSE 流式文本、思考提示与多轮工具完成', async (t) => {
  let round = 0;
  const upstreamBodies = [];
  const { baseUrl } = await startFixture(t, async (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    await once(req, 'end');
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    if (round === 0) {
      res.write('data: {"id":"chat-round-1","choices":[{"delta":{"reasoning_content":"inspect"}}]}\n\n');
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            content: 'Checking. ',
            tool_calls: [{
              index: 0,
              id: 'call_read',
              type: 'function',
              function: { name: 'read_file', arguments: '' },
            }],
          },
        }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"path":"README.md"}' },
            }],
          },
        }],
      })}\n\n`);
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n');
      res.end('data: [DONE]\n\n');
      round += 1;
    } else {
      res.write('data: {"id":"chat-round-2","choices":[{"delta":{"content":"Read complete."}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":2}}\n\n');
      res.end('data: [DONE]\n\n');
    }
  });
  const tools = [{
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  }];
  const firstResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Read README' }],
      tools,
    }),
  });
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.text();
  assert.ok(first.includes('read_file'), JSON.stringify({
    upstreamBodies,
    first,
    internal: settings.getApiSettings(),
  }));
  assert.match(first, /"reasoning_content":"inspect"/);
  assert.match(first, /data: \[DONE\]/);
  const firstEvents = parseSse(first);
  assert.equal(firstEvents.filter((event) => event.choices?.[0]?.finish_reason).length, 1);
  const call = firstEvents
    .flatMap((event) => event.choices?.[0]?.delta?.tool_calls || [])
    .find((item) => item.function?.name === 'read_file');
  assert.ok(call, JSON.stringify(firstEvents));
  assert.equal(call.function.arguments, '{"path":"README.md"}');

  const secondResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [
        { role: 'user', content: 'Read README' },
        {
          role: 'assistant',
          content: 'Checking. ',
          tool_calls: [{ id: 'call_read', type: 'function', function: call.function }],
        },
        { role: 'tool', tool_call_id: 'call_read', content: '# Bridge' },
      ],
      tools,
    }),
  });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.text();
  assert.match(second, /Read complete\./);
  assert.match(second, /"finish_reason":"stop"/);
  assert.match(second, /data: \[DONE\]/);
  assert.equal(upstreamBodies.length, 2);
  assert.equal(upstreamBodies[1].messages.at(-1).role, 'tool');
  assert.equal(upstreamBodies[1].messages.at(-1).tool_call_id, 'call_read');
});

test('OpenAI 工具结果引用缺失或工具开关关闭时返回明确错误', () => {
  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'tool', content: 'result' }],
  }), (error) => error.status === 400 && /tool_call_id/.test(error.message));

  assert.throws(() => prepareOpenAIRequest({
    messages: [{
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'result',
    }],
  }), (error) => error.status === 400 && error.code === 'invalid_request');

  assert.throws(() => prepareOpenAIRequest({
    messages: [{ role: 'user', content: 'ping' }],
    tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
    tool_choice: 'required',
  }, { toolsEnabled: false }), (error) => error.code === 'tools_disabled');
});

test('管理页提供独立的 OpenAI 开关、Base URL 和接口地址', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":{"models":[]}}');
  });
  const html = await (await fetch(`${baseUrl}/admin`)).text();
  assert.match(html, /data-act="api-openai-toggle"/);
  assert.match(html, /data-act="api-copy-openai-endpoint"/);
  assert.match(html, /Base URL/);
  assert.match(html, /不要带 \/responses/);
  assert.match(html, /\/v1\/models/);
  assert.match(html, /id="api-responses-persistence-switch"/);
  assert.match(html, /id="api-responses-nudge-switch"/);
  assert.match(html, /Responses 持久化/);
  assert.match(html, /api-responses-persistence-switch/);
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

test('未声明 tools 时清洗 WorkBuddy DSML，不泄漏工具调用', async (t) => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const dsml = [
    `先读取文件。<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="read_file">`,
    `<${BAR}DSML${BAR} parameter name="path" string="true">README.md</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [dsml.slice(0, 23), dsml.slice(23)]) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
    }
    res.end('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '读取 README' }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.choices[0].message.content, '先读取文件。');
  assert.equal(JSON.stringify(body).includes('DSML'), false);
  assert.equal(inflight('openai-a'), 0);
});

test('OpenAI 上游未给出完成原因时拒绝返回不完整文本', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'ping' }],
    }),
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'UPSTREAM_TRUNCATED');
  assert.equal(inflight('openai-a'), 0);
});

test('OpenAI 缺少 finish_reason 但工具片段完整时可恢复调用', async (t) => {
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_clean_eof",'
      + '"function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}]}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '读取 README' }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(
    JSON.parse(body.choices[0].message.tool_calls[0].function.arguments),
    { path: 'README.md' },
  );
  assert.equal(inflight('openai-a'), 0);
});

test('OpenAI 工具响应聚合为 tool_calls，未声明 tools 时失败关闭', async (t) => {
  let requestCount = 0;
  const { baseUrl } = await startFixture(t, async (_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      'data: {"id":"tool-round-1","choices":[{"delta":{"tool_calls":[{"index":0,'
      + '"id":"call_read","function":{"name":"read_file","arguments":"{\\"path\\":\\"READ"}}]}}]}\n\n',
    );
    res.end(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
      + '"function":{"arguments":"ME.md\\"}"}}]},"finish_reason":"tool_calls"}],'
      + '"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  const payload = {
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: '读取 README' }],
    tools: [{
      type: 'function',
      function: {
        name: 'read_file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    }],
  };
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].message.tool_calls[0].id, 'call_read');
  assert.deepEqual(
    JSON.parse(body.choices[0].message.tool_calls[0].function.arguments),
    { path: 'README.md' },
  );
  assert.equal(inflight('openai-a'), 0);

  delete payload.tools;
  const unrequested = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(unrequested.status, 200);
  const plain = await unrequested.json();
  assert.equal(plain.choices[0].finish_reason, 'stop');
  assert.equal(JSON.stringify(plain).includes('tool_calls'), false);
  assert.equal(inflight('openai-a'), 0);
  assert.equal(requestCount, 2);
});

test('OpenAI Chat 网络断开保存可见片段一次', async (t) => {
  let upstreamClosed = false;
  const { store, upstreamServer } = await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"chat-cancel-unique","choices":[{"delta":{"content":"visible partial"}}]}\n\n');
    res.once('close', () => {
      upstreamClosed = true;
    });
  });
  let raw = '';
  const { PassThrough } = await import('node:stream');
  const res = new PassThrough();
  res.on('data', (chunk) => {
    raw += chunk.toString('utf8');
  });
  res.writeHead = () => {};
  const runtime = createOpenAIRuntime({
    upstreamClient: createUpstreamClient({
      baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
    }),
    cancelPersistence: store,
  });
  const run = runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'cancel' }],
    },
    config: settings.getApiSettings(),
  });
  await waitFor(() => raw.includes('visible partial'));
  res.destroy();
  const result = await run;
  assert.equal(result.started, true);
  await waitFor(() => upstreamClosed && inflight('openai-a') === 0 && store.memoryView().length > 0);
  const records = store.memoryView();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'incomplete');
  assert.ok(JSON.stringify(records[0].body).includes('visible partial'));
  assert.equal((await store.get(records[0].id))?.status, 'incomplete');
});

test('OpenAI HTTP 真实内核 RST 只保存一次可见片段且不伪装成成功取消', async (t) => {
  let upstreamClosed = false;
  const { baseUrl, store } = await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"chat-rst-unique","choices":[{"delta":{"content":"visible partial"}}]}\n\n');
    res.once('close', () => {
      upstreamClosed = true;
    });
  });
  const received = await sendKernelRst(`${baseUrl}/v1/chat/completions`, {
    model: 'deepseek-v4.1-flash',
    stream: true,
    messages: [{ role: 'user', content: 'reset' }],
  });
  assert.match(received, /visible partial/);
  assert.doesNotMatch(received, /\[DONE\]/);
  await waitFor(() => upstreamClosed && inflight('openai-a') === 0 && store.memoryView().length > 0);
  const records = store.memoryView();
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'incomplete');
  assert.equal(records[0].body.output[0].content[0].text, 'visible partial');
  assert.equal(records[0].deadLetterWritten, undefined);
  assert.equal((await store.get(records[0].id))?.status, 'incomplete');
  assert.equal(pool.poolView().accounts.find((item) => item.name === 'openai-a').inflight, 0);
});

test('OpenAI chatWithCancellation 接收显式 Signal 并保留合法收尾', async (t) => {
  const { createOpenAIRuntime } = await import('../../src/api-runtime.js');
  let upstreamClosed = false;
  const { store, upstreamServer } = await startFixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"id":"chat-signal","choices":[{"delta":{"content":"visible partial"}}]}\n\n');
    res.once('close', () => {
      upstreamClosed = true;
    });
  });
  const upstreamClient = createUpstreamClient({ baseUrl: `http://127.0.0.1:${upstreamServer.address().port}` });
  const runtime = createOpenAIRuntime({ upstreamClient, cancelPersistence: store });
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
  const run = runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'cancel' }],
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  res.on = (event, listener) => {
    if (event === 'close') {
      process.nextTick(() => {
        if (!writes.join('').includes('visible partial')) return;
        res.destroyed = true;
        listener();
      });
    }
  };
  await waitFor(() => writes.join('').includes('visible partial'));
  controller.abort('client test cancellation');
  const result = await run;
  await waitFor(() => upstreamClosed && inflight('openai-a') === 0);
  const raw = writes.join('');
  const events = parseSse(raw);
  assert.equal(result.canceled, true);
  assert.equal(events.filter((event) => event.choices?.[0]?.finish_reason).length, 1);
  assert.equal(events.find((event) => event.choices?.[0]?.finish_reason)?.choices[0].finish_reason, 'stop');
  assert.equal(raw.match(/data: \[DONE\]/g)?.length, 1);
  assert.equal(raw.match(/^: bridge-chat-canceled$/gm)?.length, 1);
  assert.equal(store.memoryView().length, 1);
  assert.equal(store.memoryView()[0].body.output[0].content[0].text, 'visible partial');
  assert.equal((await store.get(store.memoryView()[0].id))?.status, 'incomplete');
});

test('OpenAI Cancellation catch 路径持久化成功后仍发送合法收尾和独立注释', async () => {
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
                    'data: {"id":"chat-catch","choices":[{"delta":{"content":"visible partial"}}]}\n\n',
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
  const runtime = createOpenAIRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('openai-a');
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
  const run = runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'catch-path cancel' }],
    },
    config: settings.getApiSettings(),
    interruptSignal: controller.signal,
  });
  await waitFor(() => writes.join('').includes('visible partial'));
  assert.equal(typeof pendingReject, 'function');
  controller.abort('catch path interruption');
  setTimeout(() => pendingReject(new Error('forced read failure after cancellation')), 10);
  const result = await run;
  assert.equal(result.canceled, true);
  assert.equal(saved.length, 1);
  const raw = writes.join('');
  assert.equal(raw.match(/^: bridge-chat-canceled$/gm)?.length, 1);
  assert.equal(raw.match(/"finish_reason":"stop"/g)?.length, 1);
  assert.equal(raw.match(/data: \[DONE\]/g)?.length, 1);
});

test('Chat 下游 SSE 写失败按网络断连持久化并释放租约', async () => {
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
            'data: {"id":"chat-write-error","choices":[{"delta":{"content":"visible partial"}}]}\n\n',
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
  const runtime = createOpenAIRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('openai-a');
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
  const result = await runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'write fails' }],
    },
    config: settings.getApiSettings(),
  });
  assert.equal(result.canceled, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].entry.status, 'incomplete');
  assert.match(JSON.stringify(saved[0].entry.body), /visible partial/);
  assert.equal(inflight('openai-a'), 0);
});

test('Chat 结构化工具参数超限失败关闭且不输出可执行调用', async () => {
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
  const runtime = createOpenAIRuntime({ upstreamClient });
  createAccount('openai-a');
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
  const result = await runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'large tool arg' }],
      tools: [{
        type: 'function',
        function: {
          name: 'write_file',
          parameters: { type: 'object', properties: { input: { type: 'string' } } },
        },
      }],
    },
    config: {
      ...settings.getApiSettings(),
      dsmlMaxBufferBytes: 32,
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TOOL_ARGUMENT_LIMIT');
  const events = parseSse(writes.join(''));
  assert.equal(events.some((event) => (
    event.choices?.[0]?.delta?.tool_calls?.length > 0
  )), false);
  assert.equal(events.some((event) => event.error?.code === 'TOOL_ARGUMENT_LIMIT'), true);
  assert.equal(inflight('openai-a'), 0);
});

test('OpenAI 取消顺序为停止上游、释放租约、持久化、合法收尾', async () => {
  const events = [];
  let releaseLease;
  const leaseReleased = new Promise((resolve) => {
    releaseLease = resolve;
  });
  let markSave;
  const saveStarted = new Promise((resolve) => {
    markSave = resolve;
  });
  const store = {
    async save() {
      events.push(`save:${inflight('openai-a')}`);
      markSave();
      await leaseReleased;
      return { ok: true, deadLetterWritten: false };
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
            'data: {"id":"chat-order","choices":[{"delta":{"content":"visible partial"}}]}\n\n',
          ));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    }),
  };
  const runtime = createOpenAIRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('openai-a');
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
  const run = runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'cancel ordering' }],
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
  assert.equal(inflight('openai-a'), 0);
  assert.equal(writes.join('').includes('finish_reason":"stop'), false);
  releaseLease();
  const result = await run;
  assert.equal(result.canceled, true);
  const raw = writes.join('');
  assert.equal((raw.match(/data: \[DONE\]/g) || []).length, 1);
  assert.match(raw, /"finish_reason":"stop"/);
});

test('OpenAI 取消片段持久化失败时不发送成功收尾', async () => {
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
            'data: {"id":"chat-failed-cancel","choices":[{"delta":{"content":"visible partial"}}]}\n\n',
          ));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
    }),
  };
  const runtime = createOpenAIRuntime({ upstreamClient, cancelPersistence: store });
  createAccount('openai-a');
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
  const run = runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'failed cancel persistence' }],
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
  const raw = writes.join('');
  assert.doesNotMatch(raw, /"finish_reason":"stop"/);
  assert.doesNotMatch(raw, /data: \[DONE\]/);
});

test('OpenAI Chat 租约释放保留客户端 Key 归因', async () => {
  const released = [];
  const runtime = createOpenAIRuntime({
    pick: () => ({ name: 'attributed-openai' }),
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
              'data: {"id":"chat-attribution","choices":[{"delta":{"content":"ok"},'
              + '"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1}}\n\n'
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

  const result = await runtime.chatWithCancellation({
    req: { once() {}, off() {} },
    res,
    body: {
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'attribute this' }],
    },
    config: { ...settings.getApiSettings(), openai: true },
    clientKey: { id: 'key-chat', name: 'desktop' },
  });

  assert.equal(result.ok, true);
  assert.equal(released.length, 1);
  assert.equal(released[0].result.meta.apiProtocol, 'openai_chat');
  assert.equal(released[0].result.meta.clientKeyId, 'key-chat');
  assert.equal(released[0].result.meta.clientKeyName, 'desktop');
});
