import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-server-close-'));
process.env.WB_BRIDGE_HOME = path.join(temporary, 'bridge');
delete process.env.WB_ADMIN_TOKEN;

const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createResponsesStore } = await import('../../src/responses-store.js');

function configureApi() {
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
  });
}

async function fixture(t, { heldSse = false } = {}) {
  configureApi();
  const store = createResponsesStore({
    directory: path.join(temporary, `store-${Date.now()}-${Math.random()}`),
  });
  const responsesRuntime = {
    store,
    async create({ res }) {
      if (!heldSse) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      res.flushHeaders?.();
      await new Promise((resolve) => res.once('close', resolve));
    },
    async retrieve() {
      return { status: 'completed' };
    },
    wsSession() {
      return {
        create() {},
        interrupt() {},
        close() {},
      };
    },
  };
  const bridge = await startHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiDeps: { responsesRuntime },
  });
  t.after(async () => {
    if (bridge.server.listening) await bridge.close({ graceMs: 50 });
    await store.close();
  });
  return { bridge, store, baseUrl: `http://127.0.0.1:${bridge.port}` };
}

test('close 在正常请求完成后立即清空连接', async (t) => {
  const { bridge, baseUrl } = await fixture(t);
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  await response.text();
  await bridge.close({ graceMs: 300 });
  assert.equal(bridge.sockets.size, 0);
});

test('close 能清理已经被客户端 RST 的连接', async (t) => {
  const { bridge } = await fixture(t);
  const socket = net.createConnection({
    host: '127.0.0.1',
    port: bridge.port,
  });
  await once(socket, 'connect');
  socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
  await once(socket, 'data');
  socket.resetAndDestroy();
  await once(socket, 'close');
  await bridge.close({ graceMs: 300 });
  assert.equal(bridge.sockets.size, 0);
});

test('close 对未读取的 SSE 连接在测试上限后兜底销毁', async (t) => {
  const { bridge, baseUrl } = await fixture(t, { heldSse: true });
  const parsed = new URL(baseUrl);
  const body = JSON.stringify({
    model: 'deepseek-v4.1-flash',
    stream: true,
    input: 'hold open',
  });
  const socket = net.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port),
  });
  await once(socket, 'connect');
  socket.write(
    'POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n'
    + 'Content-Type: application/json\r\nContent-Length: '
    + `${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`,
  );
  const received = await new Promise((resolve, reject) => {
    let raw = '';
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8');
      if (raw.includes('event: response.created')) resolve(raw);
    });
    socket.once('error', reject);
  });
  assert.match(received, /HTTP\/1\.1 200/);
  socket.pause();
  const startedAt = Date.now();
  await bridge.close({ graceMs: 75 });
  assert.ok(Date.now() - startedAt >= 50, 'held SSE should reach the configured close limit');
  assert.equal(bridge.sockets.size, 0);
});

test('close 对无请求的残留 keepalive 连接执行兜底销毁', async (t) => {
  const { bridge } = await fixture(t);
  const socket = net.createConnection({
    host: '127.0.0.1',
    port: bridge.port,
  });
  await once(socket, 'connect');
  assert.equal(bridge.sockets.size, 1);
  const startedAt = Date.now();
  await bridge.close({ graceMs: 75 });
  assert.ok(Date.now() - startedAt >= 50, 'idle socket should reach the configured close limit');
  assert.equal(bridge.sockets.size, 0);
});

test('close 在兜底 destroy 后仍有残留时抛出错误', async (t) => {
  const { bridge } = await fixture(t);
  const stubbornSocket = {
    destroy() {},
  };
  bridge.sockets.add(stubbornSocket);
  try {
    await assert.rejects(
      bridge.close({ graceMs: 20 }),
      /server connections did not close/,
    );
  } finally {
    bridge.sockets.delete(stubbornSocket);
  }
});
