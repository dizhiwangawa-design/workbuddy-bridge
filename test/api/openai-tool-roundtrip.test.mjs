import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import OpenAI from 'openai';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-openai-roundtrip-'));
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
}

function sse(delta, finishReason, usage = { prompt_tokens: 8, completion_tokens: 2 }) {
  return `data: ${JSON.stringify({
    choices: [{ delta, finish_reason: finishReason }],
    usage: finishReason ? usage : undefined,
  })}\n\n`;
}

function toolFrame(round) {
  return sse({
    tool_calls: [{
      index: 0,
      id: `call_round_${round}`,
      function: {
        name: 'echo_round',
        arguments: JSON.stringify({ round }),
      },
    }],
  }, 'tool_calls') + 'data: [DONE]\n\n';
}

async function fixture(t, name, handler) {
  createAccount(name);
  const current = pool.loadPool();
  for (const accountName of Object.keys(current.accounts)) {
    pool.updateAccount(accountName, {
      enabled: accountName === name,
      maxConcurrency: 1,
    });
  }
  const upstream = http.createServer(handler);
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: false,
    tools: true,
    streaming: false,
    requireApiKey: false,
    remoteRequireKey: false,
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
  return {
    client: new OpenAI({
      apiKey: 'loopback',
      baseURL: `http://127.0.0.1:${bridge.port}/v1`,
      maxRetries: 0,
    }),
    account: name,
  };
}

const tools = [{
  type: 'function',
  function: {
    name: 'echo_round',
    description: 'Echo the current round',
    parameters: {
      type: 'object',
      properties: { round: { type: 'integer' } },
      required: ['round'],
    },
  },
}];

test('官方 OpenAI SDK 连续完成 3 次 tool_calls/tool 往返', async (t) => {
  let upstreamRequests = 0;
  const { client, account } = await fixture(t, 'openai-sdk-a', async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    upstreamRequests += 1;
    assert.equal(body.tools[0].function.name, 'echo_round');
    assert.equal(body.stream, true);
    let priorResult = null;
    for (const message of body.messages) {
      if (message.role === 'assistant') {
        assert.equal(message.tool_calls[0].function.name, 'echo_round');
      }
      if (message.role === 'tool') priorResult = message;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (upstreamRequests <= 3) {
      const round = upstreamRequests;
      res.end(
        sse({
          content: `round ${round} starting. `,
          tool_calls: [{
            index: 0,
            id: `call_round_${round}`,
            function: {
              name: 'echo_round',
              arguments: `{"round":${round}}`,
            },
          }],
        }, 'tool_calls') + 'data: [DONE]\n\n',
      );
      return;
    }
    assert.equal(priorResult?.tool_call_id, 'call_round_3');
    assert.equal(priorResult.content, 'round 3 completed');
    res.end(sse({
      content: 'all three rounds completed',
    }, 'stop') + 'data: [DONE]\n\n');
  });

  const messages = [{ role: 'user', content: 'Complete three rounds.' }];
  const seenIds = new Set();
  for (let round = 1; round <= 3; round += 1) {
    const response = await client.chat.completions.create({
      model: 'deepseek-v4-flash',
      messages,
      tools,
    });
    assert.equal(response.choices[0].finish_reason, 'tool_calls');
    const call = response.choices[0].message.tool_calls[0];
    assert.equal(call.id, `call_round_${round}`);
    assert.equal(seenIds.has(call.id), false);
    seenIds.add(call.id);
    assert.deepEqual(JSON.parse(call.function.arguments), { round });
    messages.push(response.choices[0].message);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: `round ${round} completed`,
    });
    assert.equal(pool.poolView().accounts.find((item) => item.name === account)?.inflight, 0);
  }

  const final = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages,
    tools,
  });
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.equal(final.choices[0].message.content, 'all three rounds completed');
  assert.equal(upstreamRequests, 4);
});

test('OpenAI tools 可从文本 DSML 还原，并保留同轮文本', async (t) => {
  const BAR = '\u{FF5C}\u{FF5C}';
  const dsml = [
    `先查询天气。<${BAR}DSML${BAR} calls>`,
    `<${BAR}DSML${BAR} invoke name="get_weather">`,
    `<${BAR}DSML${BAR} parameter name="city" string="true">北京</${BAR}DSML${BAR} parameter>`,
    `</${BAR}DSML${BAR} invoke>`,
    `</${BAR}DSML${BAR} calls>`,
  ].join('\n');
  const { client } = await fixture(t, 'openai-dsml-a', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [dsml.slice(0, 17), dsml.slice(17)]) {
      res.write(sse({ content: chunk }, null));
    }
    res.end(sse({}, 'stop', {
      prompt_tokens: 9,
      completion_tokens: 3,
    }) + 'data: [DONE]\n\n');
  });
  const response = await client.chat.completions.create({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: '北京天气' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: 'required',
  });
  assert.equal(response.choices[0].finish_reason, 'tool_calls');
  assert.equal(response.choices[0].message.content, '先查询天气。');
  assert.equal(response.choices[0].message.tool_calls.length, 1);
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(
    JSON.parse(response.choices[0].message.tool_calls[0].function.arguments),
    { city: '北京' },
  );
  assert.equal(JSON.stringify(response).includes('DSML'), false);
});
