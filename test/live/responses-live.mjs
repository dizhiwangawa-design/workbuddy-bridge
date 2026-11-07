#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const model = process.env.WB_LIVE_MODEL?.trim() || 'deepseek-v4.1-flash';
const account = process.env.WB_LIVE_ACCOUNT?.trim() || 'default';
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-live-'));
process.env.WB_COMMAND = path.join(
  os.tmpdir(),
  `wb-live-missing-codebuddy-${process.pid}`,
);

const settings = await import('../../src/api-settings.js');
const pool = await import('../../src/pool.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
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
let ws = null;

function responseText(response) {
  return (response?.output || [])
    .filter((item) => item.type === 'message')
    .map((item) => item.content?.map((part) => part.text || '').join('') || '')
    .join('');
}

function parseSse(raw) {
  return raw.split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

try {
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    streaming: true,
    tools: true,
    responsesPersistence: true,
    requireApiKey: false,
    remoteRequireKey: false,
  });
  for (const name of Object.keys(originalEnabled)) {
    pool.updateAccount(name, { enabled: name === account });
  }

  bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    mcp: false,
    apiDeps: { responsesRuntime: createResponsesRuntime({ store }) },
  });
  const base = `http://127.0.0.1:${bridge.port}`;
  async function create(body) {
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Responses HTTP ${response.status}: ${await response.text()}`);
    }
    return response.json();
  }

  const first = await create({
    model,
    input: 'The secret code is 47. Reply only OK.',
    store: true,
  });
  if (first.status !== 'completed') throw new Error(`initial status ${first.status}`);
  const fetchedResponse = await fetch(`${base}/v1/responses/${first.id}`);
  if (!fetchedResponse.ok) throw new Error(`GET response ${fetchedResponse.status}`);
  const fetched = await fetchedResponse.json();
  if (fetched.id !== first.id || Object.hasOwn(fetched, '_bridgeInput')) {
    throw new Error('GET response shape is not public-safe');
  }

  const continued = await create({
    model,
    input: 'What is the secret code? Reply only the two digits.',
    previous_response_id: first.id,
    store: true,
  });
  if (continued.status !== 'completed') {
    throw new Error(`continuation status ${continued.status}`);
  }
  const currentText = responseText(continued).split('\n').at(-1).trim();
  if (!currentText.includes('47')) {
    throw new Error(`continuation did not use prior history: ${currentText}`);
  }

  const streamResponse = await fetch(`${base}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: '只回答两个字：收到',
      stream: true,
      store: false,
    }),
  });
  if (!streamResponse.ok) throw new Error(`Responses SSE ${streamResponse.status}`);
  const streamEvents = parseSse(await streamResponse.text());
  const streamCompleted = streamEvents.findLast((event) => event.type === 'response.completed');
  const streamText = streamEvents
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('');
  if (!streamCompleted || !streamText.trim()) {
    throw new Error('Responses SSE did not complete with text deltas');
  }

  ws = new WebSocket(`${base.replace(/^http/, 'ws')}/v1/responses`);
  const wsEvents = [];
  const wsTerminalPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Responses WS timed out')), 60000);
    ws.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      wsEvents.push(event);
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(event.type)) {
        clearTimeout(timer);
        resolve(event);
      }
    });
    ws.on('error', reject);
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model,
    input: '只回答两个字：收到',
    store: false,
  }));
  const wsTerminal = await wsTerminalPromise;
  if (wsTerminal.type !== 'response.completed') {
    throw new Error(`Responses WS terminal ${wsTerminal.type}`);
  }
  const wsText = wsEvents
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.data.delta)
    .join('');
  if (!wsText.trim()) throw new Error('Responses WS returned no text deltas');
  ws.close(1000, 'done');
  await once(ws, 'close');

  console.log(JSON.stringify({
    ok: true,
    model,
    account,
    http: { status: first.status, text_chars: responseText(first).length },
    continuation: { status: continued.status, current_text_chars: currentText.length },
    sse: {
      terminal: streamCompleted.type,
      delta_chars: streamText.length,
    },
    ws: {
      terminal: wsTerminal.type,
      delta_chars: wsText.length,
    },
  }));
} catch (error) {
  console.error(`Responses live test failed: ${error?.code || error?.message || error}`);
  process.exitCode = 1;
} finally {
  ws?.terminate();
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
    responsesPersistence: originalSettings.responsesPersistence,
    requireApiKey: originalSettings.requireApiKey,
    remoteRequireKey: originalSettings.remoteRequireKey,
  });
  fs.rmSync(temporary, { recursive: true, force: true });
}
