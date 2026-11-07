/*
 * This child owns its bridge and a deliberately stalled SSE client.
 * The parent measures the sole child PID, so the result excludes the test
 * runner and remote-model workload. The parent always kills the child.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-slow-reader-'));
process.env.WB_BRIDGE_HOME = path.join(temporary, 'bridge');
const accounts = await import('../../src/accounts.js');
const pool = await import('../../src/pool.js');
const settings = await import('../../src/api-settings.js');
const { startHttpServer } = await import('../../src/http.js');
const { createUpstreamClient } = await import('../../src/upstream-client.js');
const { createResponsesRuntime } = await import('../../src/api-responses.js');
const { createResponsesStore } = await import('../../src/responses-store.js');
const { createHttpEventWriter } = await import('../../src/stream-control.js');

const accountName = `slow-reader-${process.pid}`;
let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
let peakExternalBytes = process.memoryUsage().external;
const baselineRssBytes = peakRssBytes;
const rssSampler = setInterval(() => {
  const current = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, current.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, current.heapUsed);
  peakExternalBytes = Math.max(peakExternalBytes, current.external);
}, 20);
rssSampler.unref();
accounts.ensureAccount(accountName);
fs.mkdirSync(accounts.accountAuthDir(accountName), { recursive: true });
fs.writeFileSync(path.join(accounts.accountAuthDir(accountName), 'auth.info'), JSON.stringify({
  account: { uid: 'slow-reader-uid' },
  auth: {
    accessToken: 'offline-slow-token',
    expiresAt: Math.floor((Date.now() + 3600_000) / 1000),
  },
}), { mode: 0o600 });
pool.updateAccount(accountName, { enabled: true, maxConcurrency: 1 });
settings.updateApiSettings({
  enabled: true,
  openai: true,
  anthropic: false,
  streaming: true,
  tools: true,
  responsesPersistence: true,
  requireApiKey: false,
  remoteRequireKey: false,
  defaultModel: 'deepseek-v4.1-flash',
  firstByteTimeoutMs: 5000,
  idleTimeoutMs: 10000,
  finishGraceMs: 100,
  totalTimeoutMs: 20000,
});

let upstreamClosed = false;
let producedBytes = 0;
let upstreamPeakRssBytes = 0;
const upstreamRssSampler = setInterval(() => {
  upstreamPeakRssBytes = Math.max(upstreamPeakRssBytes, process.memoryUsage().rss);
}, 20);
upstreamRssSampler.unref();
const upstream = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(': initial\n\n');
  res.flushHeaders();
  let stopped = false;
  async function push() {
    if (stopped || res.destroyed) return;
    if (res.writableNeedDrain) {
      await once(res, 'drain');
      setImmediate(push);
      return;
    }
    const part = 'x'.repeat(32 * 1024);
    producedBytes += part.length;
    const accepted = res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`,
    );
    if (producedBytes > 64 * 1024 * 1024) {
      stopped = true;
      res.end('data: [DONE]\n\n');
      return;
    }
    if (accepted) setImmediate(push);
    else res.once('drain', push);
  }
  res.once('close', () => {
    upstreamClosed = true;
  });
  push();
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamClient = createUpstreamClient({
  baseUrl: `http://127.0.0.1:${upstream.address().port}`,
});
const store = createResponsesStore({ directory: path.join(temporary, 'records') });
let writerStats = null;
const responses = createResponsesRuntime({
  upstreamClient,
  store,
  writerFactory(res, options) {
    const writer = createHttpEventWriter(res, options);
    writerStats = writer.stats;
    return writer;
  },
  keepaliveMs: 1000,
  softBytes: 256 * 1024,
  hardBytes: 1024 * 1024,
});
const bridge = await startHttpServer({
  port: 0,
  host: '127.0.0.1',
  apiDeps: { upstreamClient, responsesRuntime: responses },
});

function stalledClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      store: true,
      input: 'produce a large slow stream',
    });
    socket.once('connect', () => {
      socket.write(
        'POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\n'
        + 'Content-Type: application/json\r\nConnection: keep-alive\r\n'
        + `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
    });
    let received = '';
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (received.includes('data:') && socket.isPaused !== true) {
        socket.pause();
        resolve(socket);
      }
    });
    socket.once('error', reject);
    setTimeout(() => reject(new Error('slow client never received its first response')), 3000).unref();
  });
}

const socket = await stalledClient(bridge.port);
await new Promise((resolve) => setTimeout(resolve, 1000));
const result = {
  writerStats: writerStats?.() || null,
  producedBytes,
  cancelled: upstreamClosed && pool.poolView().accounts.find((item) => item.name === accountName)?.inflight === 0,
  upstreamClosed,
  inflight: pool.poolView().accounts.find((item) => item.name === accountName)?.inflight || 0,
  peakRssBytes,
  baselineRssBytes,
  rssGrowthBytes: peakRssBytes - baselineRssBytes,
  peakHeapUsedBytes,
  peakExternalBytes,
  upstreamPeakRssBytes,
};
socket.destroy();
await bridge.close({ graceMs: 500 });
upstream.closeAllConnections?.();
upstream.close();
await store.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!upstreamClosed) process.exitCode = 1;
if (result.inflight !== 0) process.exitCode = 1;
