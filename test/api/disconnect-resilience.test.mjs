import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-disconnect-'));
process.env.WB_BRIDGE_HOME = path.join(temporary, 'bridge');
const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
const { createResponsesStore, createDeadLetter } = await import('../../src/responses-store.js');
const { createAnthropicRuntime, createOpenAIRuntime } = await import('../../src/api-runtime.js');
const { createSseParser, encodeSseEvent } = await import('../../src/sse.js');

function createAccount(name) {
  accounts.ensureAccount(name);
  fs.mkdirSync(accounts.accountAuthDir(name), { recursive: true });
  fs.writeFileSync(path.join(accounts.accountAuthDir(name), 'auth.info'), JSON.stringify({
    account: { uid: `uid-${name}` },
    auth: {
      accessToken: 'offline-token',
      expiresAt: Math.floor((Date.now() + 3600000) / 1000),
    },
  }), { mode: 0o600 });
  pool.updateAccount(name, { enabled: true, maxConcurrency: 1, weight: 1 });
}

async function fixture(t, handler, {
  account = 'disconnect-a',
  store = createResponsesStore({
    directory: path.join(temporary, `store-${Date.now()}-${Math.random()}`),
  }),
  keepaliveMs = 750,
  config = {},
  apiDeps = {},
} = {}) {
  createAccount(account);
  for (const name of Object.keys(pool.loadPool().accounts)) {
    pool.updateAccount(name, {
      enabled: name === account,
      maxConcurrency: 1,
    });
  }
  const upstreamServer = http.createServer(handler);
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  settings.updateApiSettings({
    enabled: true,
    openai: true,
    anthropic: true,
    streaming: true,
    tools: true,
    responsesPersistence: true,
    requireApiKey: false,
    remoteRequireKey: false,
    trustProxy: false,
    defaultModel: 'deepseek-v4.1-flash',
    firstByteTimeoutMs: 3000,
    idleTimeoutMs: 5000,
    finishGraceMs: 100,
    totalTimeoutMs: 10000,
    ...config,
  });
  const upstreamClient = createUpstreamClient({
    baseUrl: `http://127.0.0.1:${upstreamServer.address().port}`,
  });
  const responsesRuntime = createResponsesRuntime({
    upstreamClient,
    store,
    keepaliveMs,
    softBytes: 256 * 1024,
    hardBytes: 1024 * 1024,
  });
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: {
      upstreamClient,
      responsesRuntime,
      anthropicRuntime: createAnthropicRuntime({
        upstreamClient,
        keepaliveMs,
        cancelPersistence: store,
        softBytes: 256 * 1024,
        hardBytes: 1024 * 1024,
      }),
      openaiRuntime: createOpenAIRuntime({
        upstreamClient,
        keepaliveMs,
        softBytes: 256 * 1024,
        hardBytes: 1024 * 1024,
      }),
      ...apiDeps,
    },
  });
  t.after(async () => {
    await bridge.close({ graceMs: 600 });
    upstreamServer.closeAllConnections?.();
    await new Promise((resolve) => upstreamServer.close(resolve));
    await store.close();
  });
  return {
    bridge,
    store,
    baseUrl: `http://127.0.0.1:${bridge.port}`,
    upstreamServer,
    account,
  };
}

function inflight(account) {
  return pool.poolView().accounts.find((item) => item.name === account)?.inflight;
}

async function waitFor(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition did not become true before deadline');
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
    let resetScheduled = false;
    socket.on('data', (chunk) => {
      bytes += chunk.toString('utf8');
      if (!resetScheduled && bytes.includes('data:') && socket.resetAndDestroy) {
        resetScheduled = true;
        setTimeout(() => {
          socket.resetAndDestroy();
          finish();
        }, 30);
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

test('HTTP RST 后取消上游、写入取消片段，不产生虚假死信', async (t) => {
  let upstreamClosed;
  let cancelObserved = false;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const letterFile = path.join(temporary, `rst-dead-${Date.now()}.jsonl`);
  const dead = createDeadLetter({ file: letterFile });
  const store = createResponsesStore({
    directory: path.join(temporary, `rst-store-${Date.now()}`),
    deadLetter: dead,
  });
  const { bridge, baseUrl, account } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'persist this partial' } }],
    }));
    res.flushHeaders();
    res.once('close', () => {
      cancelObserved = true;
      upstreamClosed();
    });
  }, { store });

  const received = await sendKernelRst(`${baseUrl}/v1/responses`, {
    model: 'deepseek-v4.1-flash',
    stream: true,
    store: true,
    input: 'disconnect now',
  });
  assert.match(received, /event: response\./);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await closed;
  assert.equal(cancelObserved, true);
  await waitFor(() => inflight(account) === 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await bridge.waitForConnections((items) => items.length === 0, 1000), true);
  assert.equal(fs.existsSync(letterFile), false);
  const resolved = await store.resolvePersistedCancel('disconnect now');
  assert.ok(resolved);
  assert.equal(resolved?.body?.status, 'incomplete');
  assert.match(JSON.stringify(resolved.body), /persist this partial/);
});

test('WEB_SOCKET 主动 Close 帧释放活动租约', async (t) => {
  const { bridge, account } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'still working' } }],
    }));
    res.flushHeaders();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'close test',
  }));
  await waitFor(() => inflight(account) === 1);
  ws.close(1000, 'client leaves');
  await waitFor(() => inflight(account) === 0, 6000);
  ws.terminate();
  assert.equal(await bridge.waitForConnections((items) => items.length === 0, 1000), true);
});

test('WEB_SOCKET response.interrupt 释放租约并返回合法 incomplete 终态', async (t) => {
  let upstreamClosed = false;
  let requestCount = 0;
  const { bridge, account } = await fixture(t, (_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'visible partial' } }],
    }));
    res.flushHeaders();
    res.once('close', () => {
      upstreamClosed = true;
    });
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'interrupt this',
    store: true,
  }));
  await waitFor(() => inflight(account) === 1);
  await waitFor(() => requestCount === 1);
  ws.send(JSON.stringify({ type: 'response.interrupt' }));
  await waitFor(() => inflight(account) === 0);
  await waitFor(() => events.some((event) => event.type === 'response.incomplete'));
  await waitFor(() => upstreamClosed);
  assert.equal(requestCount, 1);
  const terminal = events.find((event) => event.type === 'response.incomplete');
  assert.equal(terminal.data.response.status, 'incomplete');
  assert.equal(terminal.data.response.incomplete_details.reason, 'canceled');
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  ws.close(1000, 'done');
  await once(ws, 'close');
});

test('WEB_SOCKET 新 response.create 先取消旧响应并释放旧租约', async (t) => {
  let requestCount = 0;
  const closed = [];
  const { bridge, account } = await fixture(t, (_req, res) => {
    requestCount += 1;
    const current = requestCount;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: `partial ${current}` } }],
    }));
    res.flushHeaders();
    if (current === 1) {
      res.once('close', () => closed.push(current));
    } else {
      res.end(encodeSseEvent('message', {
        choices: [{ delta: { content: 'second done' }, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n');
    }
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'first',
  }));
  await waitFor(() => inflight(account) === 1);
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'second',
  }));
  await waitFor(() => requestCount === 2, 6000);
  await waitFor(() => events.some((event) => event.type === 'response.completed'), 6000);
  await waitFor(() => closed.includes(1));
  await waitFor(() => inflight(account) === 0);
  assert.equal(closed.length, 1);
  assert.equal(events.some((event) => event.type === 'response.incomplete'), true);
  assert.equal(JSON.stringify(events.findLast((event) => event.type === 'response.completed'))
    .includes('second done'), true);
  ws.close(1000, 'done');
  await once(ws, 'close');
});

test('WEB_SOCKET 重复 Close、Pong 与中断不会重复取消或释放', async (t) => {
  let upstreamRequests = 0;
  let upstreamClosed = 0;
  const { bridge, account } = await fixture(t, (_req, res) => {
    upstreamRequests += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.once('close', () => {
      upstreamClosed += 1;
    });
  }, {
    apiDeps: {
      wsRequirePong: true,
      wsPingMs: 30,
      wsPongGraceMs: 300,
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`, {
    autoPong: false,
  });
  ws.on('ping', () => ws.pong());
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'repeat cancellation',
  }));
  await waitFor(() => inflight(account) === 1);
  ws.send(JSON.stringify({ type: 'response.interrupt' }));
  await waitFor(() => inflight(account) === 0);
  ws.send(JSON.stringify({ type: 'response.interrupt' }));
  ws.close(1000, 'duplicate close');
  await once(ws, 'close');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(upstreamRequests, 1);
  assert.equal(upstreamClosed, 1);
  assert.equal(inflight(account), 0);
});

test('WEB_SOCKET Ping/Pong 发现 TCP 假死并释放租约', async (t) => {
  let requestCount = 0;
  let upstreamClosed;
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve;
  });
  const { bridge, account } = await fixture(t, (_req, res) => {
    requestCount += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    res.once('close', upstreamClosed);
  }, {
    keepaliveMs: 100,
    apiDeps: {
      wsRequirePong: true,
      wsPingMs: 100,
      wsPongGraceMs: 150,
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`, {
    autoPong: false,
  });
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'fake dead connection',
  }));
  await waitFor(() => inflight(account) === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const heartbeatStartedAt = Date.now();
  ws._socket.pause();
  let cancelTimeout;
  try {
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        cancelTimeout = setTimeout(
          () => reject(new Error('server did not cancel the unresponsive websocket')),
          3000,
        );
        cancelTimeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(cancelTimeout);
  }
  await waitFor(() => inflight(account) === 0, 6000);
  assert.ok(Date.now() - heartbeatStartedAt < 2000, 'heartbeat timeout must beat the 5s upstream idle timeout');
  ws._socket.resume();
  await once(ws, 'close');
  await waitFor(() => events.some((event) => event.type === 'response.failed'));
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.data.response.error.code, 'WEB_SOCKET_HEARTBEAT_TIMEOUT');
  assert.equal(requestCount, 1);
  try {
    ws.send(JSON.stringify({
      type: 'response.create',
      model: 'deepseek-v4.1-flash',
      input: 'must not start after heartbeat failure',
    }));
  } catch {
    // A closed transport rejects new work.
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requestCount, 1);
});

test('WEB_SOCKET 正常 Pong 不会在后续静默周期误报心跳超时', async (t) => {
  const { bridge, account } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  }, {
    apiDeps: {
      wsRequirePong: true,
      wsPingMs: 40,
      wsPongGraceMs: 80,
    },
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`, {
    autoPong: false,
  });
  ws.on('ping', () => ws.pong());
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'stay alive',
  }));
  await waitFor(() => inflight(account) === 1);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(inflight(account), 1);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close(1000, 'done');
  await once(ws, 'close');
  await waitFor(() => inflight(account) === 0);
});

test('WEB_SOCKET RST 不依赖 Close 帧，仍走统一取消并释放活动租约', async (t) => {
  const { bridge, account } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'reset',
  }));
  await waitFor(() => inflight(account) === 1);
  ws._socket.resetAndDestroy();
  await waitFor(() => inflight(account) === 0, 6000);
});

test('WEB_SOCKET 上游请求失败时发送 failed 终态且释放租约', async (t) => {
  let requestCount = 0;
  const { bridge, account } = await fixture(t, (_req, res) => {
    requestCount += 1;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture upstream failed' } }));
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'fail upstream',
  }));
  await waitFor(() => events.some((event) => event.type === 'response.failed'), 3000);
  await waitFor(() => inflight(account) === 0);
  const failed = events.find((event) => event.type === 'response.failed');
  assert.equal(failed.data.response.status, 'failed');
  assert.equal(requestCount, 1);
  assert.equal(events.some((event) => event.type === 'response.completed'), false);
  ws.close(1000, 'done');
  await once(ws, 'close');
});

test('WEB_SOCKET 原生流发送生命周期事件与实时正文增量', async (t) => {
  const { bridge } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'ws-' } }],
    }));
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'incremental' } }],
    }));
    res.end(encodeSseEvent('message', {
      choices: [{ delta: {}, finish_reason: 'stop' }],
    }) + 'data: [DONE]\n\n');
  });
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/v1/responses`);
  const events = [];
  ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'response.create',
    model: 'deepseek-v4.1-flash',
    input: 'stream over websocket',
  }));
  await waitFor(() => events.some((event) => event.type === 'response.completed'), 3000);
  assert.deepEqual(
    events.slice(0, 2).map((event) => event.type),
    ['response.created', 'response.in_progress'],
  );
  const deltas = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.data.delta);
  assert.equal(deltas.join(''), 'ws-incremental');
  assert.equal(events.filter((event) => event.type === 'response.created').length, 1);
  assert.equal(events.filter((event) => (
    event.type === 'response.output_item.added'
    && event.data.item?.type === 'message'
  )).length, 1);
  assert.ok(events.every((event) => event.data), JSON.stringify(events));
  assert.deepEqual(
    events.map((event) => event.data.sequence_number),
    events.map((_, index) => index),
  );
  ws.close(1000, 'done');
  await once(ws, 'close');
});

test('慢读取 1 秒时真实 keepalive 先于读写循环出现', async (t) => {
  const { bridge } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'first' } }],
    }));
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n');
    }, 1200);
    res.once('close', () => clearTimeout(timer));
  }, { keepaliveMs: 150 });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      input: 'slow',
    }),
  });
  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let content = '';
  const first = await reader.read();
  content += first.value;
  assert.match(content, /response\.created/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    content += read.value;
  }
  assert.match(content, /response.in_progress/);
  assert.match(content, /response.completed/);
});

test('Chat 上游静默 1 秒时 keepalive 可观察且只结束一次', { timeout: 5000 }, async (t) => {
  const { bridge } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'first-chat' } }],
    }));
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n');
    }, 1200);
    res.once('close', () => clearTimeout(timer));
  }, { keepaliveMs: 150 });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      messages: [{ role: 'user', content: 'slow chat' }],
    }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let content = (await reader.read()).value;
  assert.match(content, /first-chat/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    content += read.value;
  }
  assert.match(content, /"choices":\[\],"usage":null/);
  assert.equal(content.match(/"finish_reason":"stop"/g)?.length, 1);
  assert.equal(content.match(/data: \[DONE\]/g)?.length, 1);
  await waitFor(() => inflight('disconnect-a') === 0);
});

test('Anthropic 上游静默 1 秒时 ping keepalive 可观察且只结束一次', { timeout: 5000 }, async (t) => {
  const { bridge } = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(encodeSseEvent('message', {
      choices: [{ delta: { content: 'first-anthropic' } }],
    }));
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end(encodeSseEvent('message', {
        choices: [{ delta: {}, finish_reason: 'stop' }],
      }) + 'data: [DONE]\n\n');
    }, 1200);
    res.once('close', () => clearTimeout(timer));
  }, { keepaliveMs: 150 });
  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'slow anthropic' }],
    }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let content = (await reader.read()).value;
  assert.match(content, /first-anthropic/);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  while (true) {
    const read = await reader.read();
    if (read.done) break;
    content += read.value;
  }
  assert.ok((content.match(/event: ping/g) || []).length >= 1);
  assert.ok((content.match(/"type":"ping"/g) || []).length >= 1);
  assert.equal(content.match(/event: message_stop/g)?.length, 1);
  assert.equal(content.match(/"stop_reason":"end_turn"/g)?.length, 1);
  await waitFor(() => inflight('disconnect-a') === 0);
});
