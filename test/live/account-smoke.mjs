#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4.1-flash';
const account = process.env.WB_LIVE_ACCOUNT?.trim() || 'default';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-account-live-'));
process.env.WB_COMMAND = path.join(
  os.tmpdir(),
  `wb-account-live-missing-codebuddy-${process.pid}`,
);

const settings = await import('../../src/api-settings.js');
const pool = await import('../../src/pool.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { startHttpServer } = await import('../../src/http.js');

const originalSettings = settings.getApiSettings();
const originalEnabled = Object.fromEntries(
  Object.entries(pool.loadPool().accounts).map(([name, entry]) => [
    name,
    Boolean(entry.enabled),
  ]),
);
if (!Object.hasOwn(originalEnabled, account)) {
  throw new Error(`live account not found: ${account}`);
}

const store = createResponsesStore({
  directory: path.join(temporary, 'responses'),
});
let bridge = null;

function visibleText(message) {
  return String(message?.content || '').trim();
}

function failureDetails(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const code = String(error?.code || error?.error?.code || '');
  const message = String(
    error?.message
      || error?.error?.message
      || error?.response?.data?.error?.message
      || '',
  );
  const reset = message.match(
    /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\s*(?:UTC|GMT)?[+-]\d{2}:?\d{2}|Z)?/,
  )?.[0];
  return {
    status,
    code,
    resetAt: reset || null,
    blocked: status === 429 || code === 'RATE_LIMITED',
  };
}

try {
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    streaming: true,
    tools: true,
    requireApiKey: false,
    remoteRequireKey: false,
  });
  for (const name of Object.keys(originalEnabled)) {
    pool.updateAccount(name, { enabled: name === account });
  }

  const before = pool.poolView().accounts.find((item) => item.name === account);
  bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    mcp: false,
    apiDeps: { cancelPersistence: store },
  });
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: 'wb-live-loopback',
    baseURL: `http://127.0.0.1:${bridge.port}/v1`,
    maxRetries: 0,
  });

  const textResponse = await client.chat.completions.create({
    model,
    stream: false,
    messages: [{ role: 'user', content: '只回答两个字：收到' }],
  });
  const text = visibleText(textResponse.choices[0]?.message);
  if (!text) throw new Error('Chat text smoke returned no visible text');

  let streamText = '';
  let streamFinish = '';
  const stream = await client.chat.completions.create({
    model,
    stream: true,
    messages: [{ role: 'user', content: '数到 1，只回答数字。' }],
  });
  for await (const chunk of stream) {
    streamText += String(chunk.choices[0]?.delta?.content || '');
    streamFinish = chunk.choices[0]?.finish_reason || streamFinish;
  }
  if (!streamText.trim() || !streamFinish) {
    throw new Error('Chat stream smoke did not finish with visible text');
  }

  const tools = [{
    type: 'function',
    function: {
      name: 'record_value',
      description: 'Record a value supplied by the caller.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    },
  }];
  const prompt = 'Call record_value exactly once with value 391. Do not answer in prose.';
  const first = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    tools,
    tool_choice: { type: 'function', function: { name: 'record_value' } },
  });
  const message = first.choices[0]?.message;
  const call = message?.tool_calls?.[0];
  if (first.choices[0]?.finish_reason !== 'tool_calls' || !call) {
    throw new Error('Chat tools smoke returned no tool_calls');
  }
  let argumentsValue;
  try {
    argumentsValue = JSON.parse(call.function.arguments);
  } catch {
    throw new Error('Chat tools smoke returned invalid arguments');
  }
  if (call.function.name !== 'record_value' || argumentsValue.value !== 391) {
    throw new Error('Chat tools smoke returned an unexpected call');
  }
  const second = await client.chat.completions.create({
    model,
    messages: [
      { role: 'user', content: prompt },
      message,
      {
        role: 'tool',
        tool_call_id: call.id,
        content: 'The value 391 was accepted. Confirm with exactly 391.',
      },
    ],
    tools,
    tool_choice: 'none',
  });
  const continuation = visibleText(second.choices[0]?.message);
  if (!continuation.includes('391')) {
    throw new Error('Chat tools smoke did not use the tool result');
  }

  const rows = pool.poolView().accounts;
  const after = rows.find((item) => item.name === account);
  if (!after || after.inflight !== 0) {
    throw new Error('Chat smoke left an account lease active');
  }
  if (after.today.req < before.today.req + 4) {
    throw new Error('Chat smoke did not account for every live request');
  }

  console.log(JSON.stringify({
    ok: true,
    account,
    model,
    text: { chars: text.length },
    stream: { chars: streamText.trim().length, finish_reason: streamFinish },
    tools: { name: call.function.name, continuation: 'text' },
    pool: {
      inflight: after.inflight,
      requests_added: after.today.req - before.today.req,
      status: after.status,
      cooldown_left_ms: after.cooldownLeftMs,
    },
  }));
} catch (error) {
  const failure = failureDetails(error);
  console.error(JSON.stringify({
    ok: false,
    account,
    model,
    http_status: failure.status || null,
    code: failure.code || 'LIVE_SMOKE_FAILED',
    reset_at: failure.resetAt,
    blocked: failure.blocked,
  }));
  process.exitCode = failure.blocked ? 2 : 1;
} finally {
  await bridge?.close({ graceMs: 2000 });
  await store.close();
  for (const [name, enabled] of Object.entries(originalEnabled)) {
    pool.updateAccount(name, { enabled });
  }
  settings.updateApiSettings({
    enabled: originalSettings.enabled,
    openai: originalSettings.openai,
    streaming: originalSettings.streaming,
    tools: originalSettings.tools,
    requireApiKey: originalSettings.requireApiKey,
    remoteRequireKey: originalSettings.remoteRequireKey,
  });
  fs.rmSync(temporary, { recursive: true, force: true });
}
