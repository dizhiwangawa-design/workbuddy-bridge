import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import Anthropic from '@anthropic-ai/sdk';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sdk-roundtrip-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');

function sseToolCall(round) {
  return `data: ${JSON.stringify({
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: `call_round_${round}`,
          function: {
            name: 'echo_round',
            arguments: JSON.stringify({ round }),
          },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3 },
  })}\n\ndata: [DONE]\n\n`;
}

test('官方 Anthropic SDK 连续完成 3 次 tool_use/tool_result 往返', async (t) => {
  accounts.ensureAccount('sdk-a');
  const authDir = accounts.accountAuthDir('sdk-a');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-sdk-a' },
    auth: {
      accessToken: 'sdk-access',
      refreshToken: 'sdk-refresh',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 7200000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount('sdk-a', { enabled: true, maxConcurrency: 1 });

  let upstreamRequests = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const toolMessages = body.messages.filter((message) => message.role === 'tool').length;
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });

    if (toolMessages < 3) {
      res.end(sseToolCall(toolMessages + 1));
      return;
    }
    res.end(
      'data: {"choices":[{"delta":{"content":"all rounds complete"},"finish_reason":"stop"}],' +
      '"usage":{"prompt_tokens":20,"completion_tokens":4}}\n\n' +
      'data: [DONE]\n\n',
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  settings.updateApiSettings({
    enabled: true,
    anthropic: true,
    tools: true,
    requireApiKey: false,
    remoteRequireKey: true,
    trustProxy: false,
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
  });
  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: { upstreamClient },
  });
  t.after(async () => {
    await bridge.close();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const client = new Anthropic({
    apiKey: 'sdk-client-key',
    baseURL: `http://127.0.0.1:${bridge.port}`,
    maxRetries: 0,
  });
  const tools = [{
    name: 'echo_round',
    description: 'Echo the current round',
    input_schema: {
      type: 'object',
      properties: { round: { type: 'number' } },
      required: ['round'],
    },
  }];
  const messages = [{ role: 'user', content: 'Start the three-round tool loop.' }];
  const seenIds = new Set();

  for (let round = 1; round <= 3; round += 1) {
    const response = await client.messages.create({
      model: 'deepseek-v4.1-flash',
      max_tokens: 128,
      messages,
      tools,
    });
    assert.equal(response.stop_reason, 'tool_use');
    const toolUse = response.content.find((block) => block.type === 'tool_use');
    assert.ok(toolUse);
    assert.deepEqual(toolUse.input, { round });
    assert.equal(seenIds.has(toolUse.id), false);
    seenIds.add(toolUse.id);

    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `round ${round} completed`,
      }],
    });
  }

  const final = await client.messages.create({
    model: 'deepseek-v4.1-flash',
    max_tokens: 128,
    messages,
    tools,
  });
  assert.equal(final.stop_reason, 'end_turn');
  assert.equal(
    final.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    'all rounds complete',
  );
  assert.equal(upstreamRequests, 4);
});

test('官方 Anthropic SDK 流式重组文本与 tool_use 输入', async (t) => {
  accounts.ensureAccount('sdk-stream');
  const authDir = accounts.accountAuthDir('sdk-stream');
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(path.join(authDir, 'auth.info'), JSON.stringify({
    account: { uid: 'uid-sdk-stream' },
    auth: {
      accessToken: 'sdk-stream-access',
      refreshToken: 'sdk-stream-refresh',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
      refreshExpiresAt: Math.floor((Date.now() + 7200000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount('sdk-a', { enabled: false });
  pool.updateAccount('sdk-stream', { enabled: true, maxConcurrency: 1 });

  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"streaming "}}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_stream",'
      + '"function":{"name":"write_note","arguments":"{\\"text\\":\\"你"}}]}}]}\n\n',
    );
    res.write(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
      + '"function":{"arguments":"好\\\\n😀\\"}"}}]}}]}\n\n',
    );
    res.end(
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],'
      + '"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n'
      + 'data: [DONE]\n\n',
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  settings.updateApiSettings({
    enabled: true,
    anthropic: true,
    tools: true,
    requireApiKey: false,
    remoteRequireKey: true,
    trustProxy: false,
    firstByteTimeoutMs: 2000,
    idleTimeoutMs: 3000,
    finishGraceMs: 100,
    totalTimeoutMs: 5000,
  });
  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstream.address().port}`,
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: { upstreamClient },
  });
  t.after(async () => {
    await bridge.close();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const client = new Anthropic({
    apiKey: 'sdk-stream-key',
    baseURL: `http://127.0.0.1:${bridge.port}`,
    maxRetries: 0,
  });
  const stream = client.messages.stream({
    model: 'deepseek-v4.1-flash',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'write a note' }],
    tools: [{
      name: 'write_note',
      description: 'Write a note',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    }],
  });
  const final = await stream.finalMessage();

  assert.equal(final.stop_reason, 'tool_use');
  assert.equal(
    final.content.filter((block) => block.type === 'text').map((block) => block.text).join(''),
    'streaming ',
  );
  const toolUse = final.content.find((block) => block.type === 'tool_use');
  assert.equal(toolUse.id, 'call_stream');
  assert.equal(toolUse.name, 'write_note');
  assert.deepEqual(toolUse.input, { text: '你好\n😀' });
});
