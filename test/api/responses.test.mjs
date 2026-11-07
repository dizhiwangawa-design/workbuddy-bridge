import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-api-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
const responses = await import('../../src/protocols/responses.js');
const { encodeSseEvent } = await import('../../src/sse.js');

function createAccount(name) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.info'), JSON.stringify({
    account: { uid: `uid-${name}` },
    auth: {
      accessToken: 'offline-access',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount(name, { enabled: true, maxConcurrency: 1 });
}

async function fixture(t, handler, {
  config = {},
  apiDeps = {},
  account = 'responses-offline',
  store = null,
} = {}) {
  createAccount(account);
  for (const name of Object.keys(pool.loadPool().accounts)) {
    pool.updateAccount(name, { enabled: name === account, maxConcurrency: 1 });
  }
  const upstreamServer = http.createServer(handler);
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: false,
    streaming: true,
    tools: true,
    responsesPersistence: true,
    requireApiKey: false,
    remoteRequireKey: false,
    trustProxy: false,
    firstByteTimeoutMs: 500,
    idleTimeoutMs: 2000,
    finishGraceMs: 100,
    totalTimeoutMs: 4000,
    ...config,
  });
  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
  });
  const responsesStore = store || createResponsesStore({
    directory: path.join(tmp, `responses-${Date.now()}-${Math.random()}`),
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: {
      upstreamClient,
      responsesRuntime: createResponsesRuntime({
        upstreamClient,
        store: responsesStore,
      }),
      ...apiDeps,
    },
  });
  t.after(async () => {
    await bridge.close({ graceMs: 500 });
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${bridge.port}`,
    bridge,
    account,
    store: responsesStore,
    upstreamPort: upstreamServer.address().port,
  };
}

function upstream(res, content, finish = 'stop') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const part of Array.isArray(content) ? content : [content]) {
    if (part.tools) {
      res.write(encodeSseEvent('message', {
        choices: [{ delta: { tool_calls: part.tools } }],
      }));
    } else {
      res.write(encodeSseEvent('message', {
        choices: [{ delta: { content: part } }],
      }));
    }
  }
  res.end(encodeSseEvent('message', {
    choices: [{ delta: {}, finish_reason: finish }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  }) + 'data: [DONE]\n\n');
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split('\n\n')) {
    const data = block.split('\n').find((line) => line.startsWith('data: '));
    if (data) events.push(JSON.parse(data.slice(6)));
  }
  return events;
}

test('Responses 非流式输出 reasoning 与 message', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { reasoning_content: 'inspect' } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
    }) + 'data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'hello' }),
  });
  assert.equal(response.status, 200, String(response));
  const body = await response.json();
  assert.equal(body.status, 'completed');
  assert.equal(body.output[0].type, 'reasoning');
  assert.equal(body.output[1].content[0].text, 'done');
});

test('Responses 首字节超时发送失败终态且不会二次写响应头', async (t) => {
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const store = createResponsesStore({
    directory: path.join(tmp, `responses-timeout-${Date.now()}-${Math.random()}`),
  });
  const { baseUrl, account } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.once('close', upstreamClosed);
  }, {
    config: {
      firstByteTimeoutMs: 50,
      idleTimeoutMs: 2000,
      totalTimeoutMs: 4000,
    },
    store,
  });
  void account;
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      input: 'timeout',
    }),
  });
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  const terminal = events.find((item) => [
    'response.completed',
    'response.incomplete',
    'response.failed',
  ].includes(item.type));
  assert.equal(terminal?.type, 'response.failed');
  assert.equal(terminal.response.status, 'failed');
  assert.equal(terminal.response.error.code, 'UPSTREAM_FIRST_BYTE_TIMEOUT');
  assert.equal(events.some((item) => item.type === 'response.completed'), false);
  await closed;
  await waitFor(() => pool.poolView().accounts
    .find((item) => item.name === 'responses-offline')?.inflight === 0);
  assert.equal(store.memoryView().length, 0);
  await store.close();
});

test('Responses SSE 序号单调、done 身份与 completed output 一致，支持图片', async (t) => {
  const { baseUrl } = await fixture(t, async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    upstream(res, 'image understood');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        ],
      }],
    }),
  });
  assert.equal(response.status, 200);
  const raw = await response.text();
  const events = parseSse(raw);
  const sequences = events.map((event) => event.sequence_number);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
  assert.ok(events.length, raw);
  const done = events.findLast((event) => event.type === 'response.output_item.done');
  const completed = events.findLast((event) => event.type === 'response.completed');
  assert.equal(completed.type, 'response.completed', raw);
  const finalMessage = completed.response.output.find((item) => item.type === 'message');
  assert.equal(done.item.id, finalMessage.id);
});

test('Responses SSE 仅在上游后续静默时仍发送增量正文，最终不重复 delta', async (t) => {
  let releaseFinish;
  const finishReady = new Promise((resolve) => {
    releaseFinish = resolve;
  });
  const { baseUrl } = await fixture(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'incremental' } }],
    }));
    await finishReady;
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }) + 'data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      input: 'slow upstream',
    }),
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let raw = '';
  const deadline = Date.now() + 1000;
  while (!raw.includes('"delta":"incremental"')) {
    assert.ok(Date.now() < deadline, 'delta was withheld until upstream finish');
    const read = await reader.read();
    raw += read.value;
  }
  releaseFinish();
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    raw += read.value;
  }
  const events = parseSse(raw);
  assert.equal(
    events.filter((item) => item.type === 'response.output_text.delta'
      && item.delta === 'incremental').length,
    1,
  );
  const completed = events.find((item) => item.type === 'response.completed');
  assert.equal(completed.response.output.find((item) => item.type === 'message')
    .content[0].text, 'incremental');
});

test('Responses custom、namespace 与 function 工具往返保留类型', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    upstream(res, [{
      tools: [
        {
          index: 0,
          id: 'call_patch',
          function: { name: 'apply_patch', arguments: JSON.stringify({ input: '*** Begin Patch' }) },
        },
        {
          index: 1,
          id: 'call_ns',
          function: { name: 'repo__read', arguments: JSON.stringify({ path: 'README' }) },
        },
      ],
    }], 'tool_calls');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'edit and read',
      tools: [
        { type: 'custom', name: 'apply_patch' },
        { type: 'namespace', name: 'repo', tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const custom = body.output.find((item) => item.type === 'custom_tool_call');
  assert.ok(custom, JSON.stringify(body));
  assert.equal(custom.input, '*** Begin Patch');
  const namespace = body.output.find((item) => item.name === 'read');
  assert.equal(namespace.type, 'function_call');
  assert.equal(namespace.namespace, 'repo');
  assert.equal(namespace.name, 'read');
});

test('Responses 工具历史按 call_id 配对并修复 output 位于 call 之前', () => {
  const prepared = responses.prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'function_call_output', call_id: 'call_a', output: 'ok' },
      { type: 'function_call', call_id: 'call_a', name: 'read_file', arguments: '{"path":"a"}' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
    ],
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
  });
  assert.equal(prepared.body.messages[1].tool_calls[0].id, 'call_a');
  assert.equal(
    prepared.body.messages.find((item) => item.role === 'tool').tool_call_id,
    'call_a',
  );
  assert.equal(prepared.body.messages.at(-1).content, 'next');
});

test('Responses 命名空间超长名称生成不同且保留原始 namespace 的稳定别名', () => {
  const longNamespace = 'n'.repeat(72);
  const prepared = responses.prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: 'long namespaces',
    tools: [
      { type: 'namespace', name: `${longNamespace}A`, tools: [{ type: 'function', name: 'read' }] },
      { type: 'namespace', name: `${longNamespace}B`, tools: [{ type: 'function', name: 'read' }] },
    ],
  });
  const first = prepared.tools.get(prepared.body.tools[0].function.name);
  const second = prepared.tools.get(prepared.body.tools[1].function.name);
  assert.notEqual(first.flattened, second.flattened);
  assert.equal(first.namespace, `${longNamespace}A`);
  assert.equal(second.namespace, `${longNamespace}B`);
});

test('Responses 历史支持内嵌 custom 调用及对应的 output', () => {
  const prepared = responses.prepareResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'custom_tool_call',
          call_id: 'ctc_embedded',
          name: 'apply_patch',
          input: '*** Begin Patch',
        }],
      },
      {
        type: 'custom_tool_call_output',
        call_id: 'ctc_embedded',
        output: 'completed',
      },
    ],
  });
  const call = prepared.body.messages.find((item) => item.tool_calls);
  assert.equal(call.tool_calls[0].id, 'ctc_embedded');
  assert.deepEqual(JSON.parse(call.tool_calls[0].function.arguments), {
    input: '*** Begin Patch',
  });
  assert.equal(prepared.body.messages.find((item) => item.role === 'tool').tool_call_id,
    'ctc_embedded');
});

test('Responses 截断是 incomplete 且不把上游 length 假装成完成', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => upstream(res, 'truncated', 'length'));
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'cut' }),
  });
  const body = await response.json();
  assert.equal(body.status, 'incomplete');
  assert.equal(body.incomplete_details.reason, 'upstream_length_limit');
});

test('Responses max_output_tokens 截断优先使用 max_output_tokens 原因', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => upstream(res, 'truncated', 'length'));
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'cut',
      max_output_tokens: 2,
    }),
  });
  const body = await response.json();
  assert.equal(body.status, 'incomplete');
  assert.equal(body.incomplete_details.reason, 'max_output_tokens');
});

test('Responses 持久化支持续接、GET 查询和取消片段查询', async (t) => {
  const upstreamBodies = [];
  let call = 0;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    call += 1;
    upstream(res, call === 1 ? 'first' : 'continued');
  });
  const first = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'remember', store: true }),
  });
  assert.equal(first.status, 200);
  const initial = await first.json();
  assert.equal(initial.store, true);
  const fetched = await fetch(`${baseUrl}/v1/responses/${initial.id}`);
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).id, initial.id);
  const continued = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'continue',
      previous_response_id: initial.id,
      store: true,
    }),
  });
  assert.equal(continued.status, 200);
  assert.equal((await continued.json()).previous_response_id, initial.id);
  assert.ok(upstreamBodies[1].messages.some((item) => item.role === 'assistant'));
});

test('Responses 取消片段可通过 HTTP GET 查询并用于续接', async (t) => {
  let requestCount = 0;
  const upstreamBodies = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'persisted partial' } }],
    }));
    if (requestCount > 1) {
      res.end(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n');
    }
  });
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      store: true,
      input: 'cancel me',
    }),
    signal: controller.signal,
  });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let raw = '';
  let created;
  while (!raw.includes('persisted partial')) {
    const read = await reader.read();
    assert.equal(read.done, false, raw);
    raw += read.value;
    created ||= parseSse(raw).find((event) => event.type === 'response.created');
  }
  assert.ok(created?.response?.id, raw);
  const responseId = created.response.id;
  controller.abort();
  let fetched;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    fetched = await fetch(`${baseUrl}/v1/responses/${responseId}`);
    if (fetched.status === 200) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fetched?.status, 200);
  const canceled = await fetched.json();
  assert.equal(canceled.status, 'incomplete');
  assert.equal(canceled.incomplete_details.reason, 'canceled');
  assert.match(JSON.stringify(canceled.output), /persisted partial/);

  const continued = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'continue after cancellation',
      previous_response_id: responseId,
      store: true,
    }),
  });
  assert.equal(continued.status, 200);
  assert.equal((await continued.json()).previous_response_id, responseId);
  assert.ok(upstreamBodies[1].messages.some((item) => (
    JSON.stringify(item).includes('persisted partial')
  )));
});

test('Responses 续跑提示不把上游 length 截断误称为取消', async (t) => {
  let requestCount = 0;
  const upstreamBodies = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requestCount += 1;
    upstream(res, requestCount === 1 ? 'truncated' : 'continued', requestCount === 1 ? 'length' : 'stop');
  }, { config: { responsesNudge: true } });
  const first = await (await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'cut', store: true }),
  })).json();
  assert.equal(first.incomplete_details.reason, 'upstream_length_limit');
  const continued = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'continue',
      previous_response_id: first.id,
      store: true,
    }),
  });
  assert.equal(continued.status, 200);
  assert.equal(upstreamBodies[1].messages.some((item) => (
    String(item.content).includes('[Responses continuation]')
  )), false);
});

test('Responses 持久化关闭时无状态 HTTP 可用，续接明确拒绝', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => upstream(res, 'stateless'), {
    config: { responsesPersistence: false },
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', input: 'hello', store: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.store, false);
  const fetched = await fetch(`${baseUrl}/v1/responses/${body.id}`);
  assert.equal(fetched.status, 404);
  const continued = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'continue',
      previous_response_id: body.id,
    }),
  });
  assert.equal(continued.status, 400);
  assert.equal((await continued.json()).error.code, 'persistence_disabled');
});

test('Responses 支持 URL 图片、parallel_tool_calls=false 和 allowed_tools', async (t) => {
  let received;
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    upstream(res, [{
      tools: [
        { index: 0, id: 'call_a', function: { name: 'read', arguments: '{}' } },
        { index: 1, id: 'call_b', function: { name: 'write', arguments: '{}' } },
      ],
    }], 'tool_calls');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'read and write' },
          { type: 'input_image', image_url: 'https://example.test/a.png' },
        ],
      }],
      tools: [
        { type: 'function', name: 'read', parameters: { type: 'object' } },
        { type: 'function', name: 'write', parameters: { type: 'object' } },
      ],
      allowed_tools: [{ type: 'function', name: 'read' }],
      parallel_tool_calls: false,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(received.tools.length, 1);
  assert.equal(received.tools[0].function.name, 'read');
  assert.equal(received.tool_choice, 'required');
  assert.equal(received.messages[0].content[1].image_url.url, 'https://example.test/a.png');
  assert.equal(body.output.filter((item) => item.type === 'function_call').length, 1);
});

test('Responses 支持 local_shell、shell 与 apply_patch 工具', async (t) => {
  let requestCount = 0;
  const received = [];
  const { baseUrl } = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    requestCount += 1;
    const name = requestCount === 1 ? 'shell' : requestCount === 2 ? 'local_shell' : 'apply_patch';
    const args = name === 'apply_patch'
      ? JSON.stringify({ input: '*** Begin Patch' })
      : JSON.stringify({ command: 'pwd' });
    upstream(res, [{ tools: [{ index: 0, id: `call_${requestCount}`, function: { name, arguments: args } }] }], 'tool_calls');
  });
  const tools = [
    { type: 'local_shell', name: 'local_shell' },
    { type: 'shell', name: 'shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
    { type: 'custom', name: 'apply_patch' },
  ];
  const bodies = [];
  for (const input of ['shell', 'shell again', 'patch']) {
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', input, tools }),
    });
    assert.equal(response.status, 200);
    bodies.push(await response.json());
  }
  assert.equal(received[0].tools.length, 3);
  assert.ok(bodies.every((body) => body.output.some((item) => item.type.includes('call'))));
  assert.equal(bodies[2].output.find((item) => item.type === 'custom_tool_call').input, '*** Begin Patch');
});

test('Responses 不支持工具与 file_id 使用明确 400', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => upstream(res, 'unused'));
  const unsupported = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'hello',
      tools: [{ type: 'web_search' }],
    }),
  });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error.code, 'unsupported_tool_type');
  const fileId = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'f1' }] }],
    }),
  });
  assert.equal(fileId.status, 400);
  assert.equal((await fileId.json()).error.code, 'file_id_not_supported');
});

test('Responses DSML 流只发送完整工具调用，半截参数不成为可执行调用', async (t) => {
  const { baseUrl } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: {
        content: 'Before <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="get_weather">'
          + '<｜｜DSML｜｜ parameter name="city" string="true">北京',
      } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }) + 'data: [DONE]\n\n');
  });
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      input: 'weather',
      tools: [{
        type: 'function',
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    }),
  });
  const raw = await response.text();
  const events = parseSse(raw);
  assert.equal(events.some((item) => [
    'response.function_call_arguments.done',
    'response.output_item.done',
  ].includes(item.type)
    && item.item?.type !== 'message'
    && item.item?.type !== 'reasoning'), false);
  assert.equal(events.some((item) => item.type === 'response.output_text.delta'
    && item.delta.includes('DSML')), false);
  const completed = events.find((item) => [
    'response.completed',
    'response.incomplete',
    'response.failed',
  ].includes(item.type));
  assert.ok(completed);
  assert.equal(completed.type, 'response.incomplete');
  assert.equal(completed.response.output.some((item) => item.type.includes('call')), false);
  await waitFor(() => pool.poolView().accounts.find((item) => item.name === 'responses-offline')?.inflight === 0);
});

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
