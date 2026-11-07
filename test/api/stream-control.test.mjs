import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  MAX_RETAINED_TEXT_BYTES,
  PRODUCTION_KEEPALIVE_MS,
  appendTextWithinLimit,
  canWriteHttp,
  createHttpEventWriter,
} from '../../src/stream-control.js';
import { createChatEncoder } from '../../src/protocols/openai.js';
import { createAnthropicEncoder } from '../../src/protocols/anthropic.js';
import {
  compactResponseForStore,
  createDeadLetter,
  createResponsesStore,
} from '../../src/responses-store.js';
import {
  WS_PING_MS,
  WS_PONG_GRACE_MS,
  createWebSocketTransport,
} from '../../src/websocket.js';

function fakeResponse({ fail = false } = {}) {
  const stream = new EventEmitter();
  stream.writable = true;
  stream.destroyed = false;
  stream.writableEnded = false;
  stream.writableLength = 0;
  stream.writableNeedDrain = false;
  stream.raw = '';
  stream.write = function write(value) {
    if (fail) throw Object.assign(new Error('write after end'), {
      code: 'ERR_STREAM_WRITE_AFTER_END',
    });
    this.raw += String(value);
    return true;
  };
  stream.end = function end() {
    this.writableEnded = true;
    this.writable = false;
    this.emit('close');
  };
  return stream;
}

test('生产 keepalive 固定为 15 秒，写入检查同时要求 writable', () => {
  assert.equal(PRODUCTION_KEEPALIVE_MS, 15000);
  const res = fakeResponse();
  assert.equal(canWriteHttp(res), true);
  res.writableEnded = true;
  assert.equal(canWriteHttp(res), false);
  res.writableEnded = false;
  res.destroyed = true;
  assert.equal(canWriteHttp(res), false);
});

test('写入竞态中的 WRITE_AFTER_END 被吸收且不泄漏原始异常', () => {
  const res = fakeResponse({ fail: true });
  const writer = createHttpEventWriter(res);
  assert.equal(writer.writeData('{}'), false);
  assert.equal(writer.failed.code, 'ERR_STREAM_WRITE_AFTER_END');
  assert.equal(writer.writeData('{}'), false);
});

test('writer 把同步写失败通知给取消出口，且同一失败只通知一次', async () => {
  const failures = [];
  const res = fakeResponse({ fail: true });
  const writer = createHttpEventWriter(res, {
    onWriteFailure: (error) => failures.push(error),
  });
  assert.equal(writer.writeData('{}'), false);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'ERR_STREAM_WRITE_AFTER_END');
  res.emit('error', Object.assign(new Error('late reset'), { code: 'ECONNRESET' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures.length, 1);
});

test('异步 EPIPE 与 ECONNRESET 被 writer 吸收且不产生未处理异常', async () => {
  const unhandled = [];
  const capture = (error) => unhandled.push(error);
  process.on('uncaughtException', capture);
  process.on('unhandledRejection', capture);
  try {
    for (const code of ['EPIPE', 'ECONNRESET']) {
      const res = fakeResponse();
      res.write = function write() {
        const error = Object.assign(new Error(code), { code });
        setImmediate(() => this.emit('error', error));
        return true;
      };
      const writer = createHttpEventWriter(res);
      assert.equal(writer.writeData('{}'), true);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(writer.failed.code, code);
      assert.equal(writer.stats().failedCode, code);
      assert.equal(writer.writeData('{}'), false);
      res.emit('close');
    }
  } finally {
    process.off('uncaughtException', capture);
    process.off('unhandledRejection', capture);
  }
  assert.deepEqual(unhandled, []);
});

test('writer 捕获写回调错误并只通知一次取消出口', async () => {
  const res = fakeResponse();
  const failures = [];
  res.write = function write(_value, callback) {
    setImmediate(() => callback(Object.assign(new Error('peer reset'), {
      code: 'ECONNRESET',
    })));
    return true;
  };
  const writer = createHttpEventWriter(res, {
    onWriteFailure: (error) => failures.push(error),
  });
  assert.equal(writer.writeData('{}'), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writer.failed.code, 'ECONNRESET');
  assert.equal(failures.length, 1);
  assert.equal(writer.writeData('{}'), false);
});

test('writer.fail 销毁已提交响应的 SSE 连接，避免持久化失败后挂起', () => {
  const res = fakeResponse();
  let destroyError = null;
  res.destroy = function destroy(error) {
    this.destroyed = true;
    destroyError = error;
  };
  const writer = createHttpEventWriter(res);
  const failure = Object.assign(new Error('database failed'), { code: 'DB_FAILED' });
  writer.fail(failure);
  assert.equal(writer.failed, failure);
  assert.equal(writer.ended, true);
  assert.equal(res.destroyed, true);
  assert.equal(destroyError, failure);
});

test('流写入超过硬阈值触发背压并且不无限缓存在 writer 中', () => {
  let overflow = null;
  const res = fakeResponse();
  res.write = function write(value) {
    this.writableLength += value.length;
    this.raw += value;
    return false;
  };
  const writer = createHttpEventWriter(res, {
    softBytes: 64,
    hardBytes: 128,
    onOverflow: (error) => {
      overflow = error;
    },
  });
  assert.equal(writer.writeData('x'.repeat(100)), true);
  assert.equal(writer.stats().backpressureSeen, true);
  assert.equal(writer.writeData('x'.repeat(100)), false);
  assert.equal(overflow.code, 'BACKPRESSURE_OVERFLOW');
  assert.equal(overflow.code, 'BACKPRESSURE_OVERFLOW');
});

test('流式输出缓存只保留有界 UTF-8 尾部且不切断多字节字符', () => {
  let retained = '';
  for (let index = 0; index < 600; index += 1) {
    retained = appendTextWithinLimit(retained, `${index}:可见😀\n`, {
      maxBytes: 4096,
      retain: 'tail',
    });
  }
  assert.ok(Buffer.byteLength(retained, 'utf8') <= 4096);
  assert.match(retained, /599:可见😀\n$/);
  assert.equal(retained.includes('\uFFFD'), false);
  assert.equal(MAX_RETAINED_TEXT_BYTES, 256 * 1024);
});

test('持久化文本截断保持完整 UTF-8 字符且不产生替换字符', () => {
  const text = `${'a'.repeat(256 * 1024 - 1)}😀`;
  const output = compactResponseForStore({
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
  }).output[0].content[0].text;
  assert.equal(output.includes('\uFFFD'), false);
  assert.ok(Buffer.byteLength(output, 'utf8') <= 256 * 1024);
});

test('非流式输出超过硬上限时失败而不是静默截断', () => {
  assert.throws(
    () => appendTextWithinLimit('a'.repeat(15), 'b'.repeat(8), {
      maxBytes: 16,
      retain: 'error',
    }),
    (error) => error.code === 'OUTPUT_TOO_LARGE',
  );
});

test('慢但有进度的读取不因纯时间超过软阈值而取消', async () => {
  const stream = new Writable({ highWaterMark: 1024 });
  let received = 0;
  stream._write = (_chunk, _encoding, callback) => {
    received += 1;
    setTimeout(callback, 300);
  };
  const overflows = [];
  const writer = createHttpEventWriter(stream, {
    softBytes: 64 * 1024,
    hardBytes: 1024 * 1024,
    onOverflow: (error) => overflows.push(error),
  });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(writer.writeRaw(`data: ${String(index).padEnd(8 * 1024, '.')}\n\n`), true);
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(overflows.length, 0);
  assert.equal(received, 5);
  assert.ok(writer.stats().pendingBytes < 1024 * 1024);
  writer.end();
});

test('Chat keepalive 是不伪造完成或工具调用的空 choices chunk', () => {
  const encoder = createChatEncoder({ id: 'chat_keep', model: 'test' });
  const events = [...encoder.start(), ...encoder.ping(), ...encoder.finalize()];
  const ping = events.find((event) => event.data?.choices?.length === 0);
  assert.deepEqual(ping.data.usage, null);
  assert.equal(events.filter((event) => event.data?.choices?.[0]?.finish_reason).length, 1);
  assert.equal(events.at(-1).data, '[DONE]');
});

test('Anthropic 取消事件使用合法 canceled + message_stop 收尾', () => {
  const encoder = createAnthropicEncoder({
    id: 'msg_cancel',
    model: 'test',
    inputTokens: 3,
  });
  const events = [
    ...encoder.start(),
    ...encoder.textDelta('partial'),
    ...encoder.cancel({ outputTokens: 1 }),
  ];
  assert.equal(events.find((item) => item.type === 'message_delta').data.delta.stop_reason, 'canceled');
  assert.equal(events.filter((item) => item.type === 'message_stop').length, 1);
});

test('SQLite 片段存储、过期续接和死信独立写入', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-store-'));
  const letterFile = path.join(directory, 'dead.jsonl');
  const dead = createDeadLetter({ file: letterFile });
  const store = createResponsesStore({
    directory,
    deadLetter: dead,
    failPersist: () => {
      throw Object.assign(new Error('injected database failure'), { code: 'DB_FAILED' });
    },
  });
  const partial = { content: 'kept before disconnect' };
  const failed = await store.save({
    id: 'resp_cancel_failed',
    status: 'incomplete',
    body: { id: 'resp_cancel_failed', status: 'incomplete', output: [] },
    partial,
  }, {
    cancelInfo: { reason: 'client', phase: 'generation' },
    partial,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.deadLetterWritten, true);
  assert.equal(fs.statSync(letterFile).mode & 0o777, 0o600);
  assert.equal(dead.entries().length, 1);
  assert.equal(dead.entries()[0].response_id, 'resp_cancel_failed');
  assert.equal(dead.entries()[0].save_status, 'failed');

  const small = createResponsesStore({
    directory: path.join(directory, 'normal'),
    deadLetter: createDeadLetter({ file: path.join(directory, 'normal-dead.jsonl') }),
  });
  const ok = await small.save({
    id: 'resp_normal',
    status: 'completed',
    body: { id: 'resp_normal', status: 'completed', output: [] },
  });
  assert.equal(ok.ok, true);
  assert.equal((await small.get('resp_normal')).body.status, 'completed');
  assert.equal(small.deadLetter.exists('resp_normal'), false);
  await store.close();
  await small.close();
});

test('SQLite 内存热缓存也严格执行 24 小时过期', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-memory-expiry-'));
  let clock = Date.now();
  const store = createResponsesStore({ directory, now: () => clock });
  const saved = await store.save({
    id: 'resp_memory_expiry',
    createdAt: clock,
    status: 'completed',
    body: {
      id: 'resp_memory_expiry',
      status: 'completed',
      output: [],
    },
  });
  assert.equal(saved.ok, true);
  assert.equal((await store.get('resp_memory_expiry'))?.id, 'resp_memory_expiry');
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await store.get('resp_memory_expiry'), null);
  assert.deepEqual(store.memoryView(), []);
  await store.close();
});

test('死信启动重试仅一次，已有记录可安全删除', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dead-letter-'));
  const file = path.join(directory, 'dead.jsonl');
  const dead = createDeadLetter({ file });
  dead.append({
    response_id: 'resp_retry',
    partial: { content: 'recover me' },
    error: { code: 'DB_FAILED' },
  });
  let attempts = 0;
  const first = await dead.retryOnce(async () => {
    attempts += 1;
    return true;
  });
  assert.deepEqual(first, { attempted: 1, recovered: 1 });
  assert.equal(dead.exists('resp_retry'), false);
  dead.append({
    response_id: 'resp_retry_2',
    partial: { content: 'keep me' },
    error: { code: 'DB_FAILED' },
  });
  const second = await dead.retryOnce(async () => {
    attempts += 1;
    throw new Error('still unavailable');
  });
  assert.equal(second.attempted, 0);
  assert.equal(attempts, 1);
  assert.equal(dead.exists('resp_retry_2'), true);
});

test('Responses SQLite 精确保留 256 条且内存历史最多 64 条', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-retention-'));
  const store = createResponsesStore({ directory });
  const createdAtBase = Date.now() - 60_000;
  for (let index = 0; index < 300; index += 1) {
    const id = `resp_retention_${String(index).padStart(3, '0')}`;
    const saved = await store.save({
      id,
      createdAt: createdAtBase + index,
      status: 'completed',
      body: { id, status: 'completed', output: [] },
    });
    assert.equal(saved.ok, true);
  }

  const memoryIds = store.memoryView().map((record) => record.id);
  assert.equal(memoryIds.length, 64);
  assert.equal(memoryIds[0], 'resp_retention_236');
  assert.equal(memoryIds.at(-1), 'resp_retention_299');

  await store.close();
  const database = new DatabaseSync(path.join(directory, 'responses.sqlite'), { readOnly: true });
  try {
    const count = database.prepare('SELECT COUNT(*) AS count FROM responses').get().count;
    const oldest = database.prepare(
      'SELECT id FROM responses ORDER BY created_at ASC, rowid ASC LIMIT 1',
    ).get();
    assert.equal(count, 256);
    assert.equal(oldest.id, 'resp_retention_044');
  } finally {
    database.close();
  }
});

test('Responses SQLite 按 32 MiB 上限淘汰最旧记录', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-size-'));
  const first = createResponsesStore({ directory });
  assert.equal((await first.save({
    id: 'resp_size_seed',
    status: 'completed',
    body: { id: 'resp_size_seed', status: 'completed', output: [] },
  })).ok, true);
  await first.close();

  const database = new DatabaseSync(path.join(directory, 'responses.sqlite'));
  try {
    const insert = database.prepare(`
      INSERT INTO responses(id, created_at, bytes, status, body_json)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 5; index += 1) {
      insert.run(
        `resp_size_${index}`,
        Date.now() + index,
        7 * 1024 * 1024,
        'completed',
        '{}',
      );
    }
  } finally {
    database.close();
  }

  const second = createResponsesStore({ directory });
  try {
    assert.equal((await second.save({
      id: 'resp_size_new',
      status: 'completed',
      body: { id: 'resp_size_new', status: 'completed', output: [] },
    })).ok, true);
  } finally {
    await second.close();
  }

  const check = new DatabaseSync(path.join(directory, 'responses.sqlite'), { readOnly: true });
  try {
    const totals = check.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM responses',
    ).get();
    assert.equal(totals.count, 5);
    assert.ok(totals.bytes <= 32 * 1024 * 1024);
    assert.equal(
      check.prepare('SELECT COUNT(*) AS count FROM responses WHERE id = ?').get('resp_size_0').count,
      0,
    );
  } finally {
    check.close();
  }
});

test('SQLite 同步停顿不阻塞主线程，超时后可重启 worker 保存', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-timeout-'));
  const store = createResponsesStore({
    directory,
    writeTimeoutMs: 60,
    slowForTestMs: 500,
  });
  const started = Date.now();
  let timerFiredAfter = null;
  const timer = setTimeout(() => {
    timerFiredAfter = Date.now() - started;
  }, 20);
  const timedOut = await store.save({
    id: 'resp_timeout',
    status: 'completed',
    body: { id: 'resp_timeout', status: 'completed', output: [] },
  });
  clearTimeout(timer);
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.error.code, 'ETIMEDOUT');
  assert.ok(timerFiredAfter !== null && timerFiredAfter < 200, `timer fired after ${timerFiredAfter}ms`);
  assert.ok(Date.now() - started < 350, 'save waited for the blocked worker');

  const recovered = await store.save({
    id: 'resp_after_timeout',
    status: 'completed',
    body: { id: 'resp_after_timeout', status: 'completed', output: [] },
  }, { slowForTestMs: 0 });
  assert.equal(recovered.ok, true);
  assert.equal((await store.get('resp_after_timeout')).body.status, 'completed');
  await store.close();
});

test('SQLite worker 不从 node --eval 继承无效启动参数', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-responses-eval-'));
  const moduleUrl = new URL('../../src/responses-store.js', import.meta.url).href;
  const script = `
    import { createResponsesStore } from ${JSON.stringify(moduleUrl)};
    const store = createResponsesStore({ directory: ${JSON.stringify(directory)} });
    const result = await store.save({
      id: 'resp_eval_worker',
      status: 'completed',
      body: { id: 'resp_eval_worker', status: 'completed', output: [] },
    });
    await store.close();
    if (!result.ok) {
      console.error(result.error?.code || result.error?.message);
      process.exitCode = 1;
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WB_DEBUG: '' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, stderr);
});

test('死信重复写入幂等、字段完整且已有文件权限会被收紧为 0600', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dead-letter-idempotent-'));
  const file = path.join(directory, 'dead.jsonl');
  fs.writeFileSync(file, '', { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const dead = createDeadLetter({ file, now: () => Date.UTC(2026, 10, 7, 9, 30) });
  const entry = {
    response_id: 'resp_dead_once',
    partial: { content: 'visible text' },
    cancelReason: 'network_reset',
    phase: 'streaming',
    usage: { input_tokens: 3, output_tokens: 2 },
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'remember this' }],
    }],
    previous_response_id: 'resp_prior',
    error: { code: 'DB_FAILED' },
  };
  assert.equal(dead.append(entry), true);
  assert.equal(dead.append(entry), false);
  const rows = dead.entries();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    response_id: 'resp_dead_once',
    partial: { content: 'visible text' },
    cancel_reason: 'network_reset',
    phase: 'streaming',
    usage: { input_tokens: 3, output_tokens: 2 },
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'remember this' }],
    }],
    previous_response_id: 'resp_prior',
    save_status: 'failed',
    db_error: 'DB_FAILED',
    created_at: '2026-11-07T09:30:00.000Z',
  });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('取消死信跨进程重启恢复输入并保留续接关系', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dead-letter-restart-'));
  const file = path.join(directory, 'dead.jsonl');
  const input = [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'remember across restart' }],
  }];
  const partial = { content: 'partial before crash' };
  const first = createResponsesStore({
    directory: path.join(directory, 'sqlite'),
    deadLetter: createDeadLetter({ file }),
    failPersist: () => {
      throw Object.assign(new Error('injected database failure'), { code: 'DB_FAILED' });
    },
  });
  const saved = await first.save({
    id: 'resp_dead_restart',
    status: 'incomplete',
    body: {
      id: 'resp_dead_restart',
      status: 'incomplete',
      incomplete_details: { reason: 'canceled' },
      previous_response_id: 'resp_prior',
      output: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial before crash' }],
      }],
      _bridgeInput: input,
      _bridgeMeta: { version: 1, outputOffset: 0 },
    },
    partial,
  }, {
    cancelInfo: { reason: 'network_disconnect', phase: 'generation' },
    partial,
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.deadLetterWritten, true);
  await first.close();

  const second = createResponsesStore({
    directory: path.join(directory, 'sqlite'),
    deadLetter: createDeadLetter({ file }),
  });
  const recovered = await second.retryDeadLetters();
  assert.deepEqual(recovered, { attempted: 1, recovered: 1 });
  const record = await second.get('resp_dead_restart');
  assert.deepEqual(record.body._bridgeInput, input);
  assert.equal(record.body.previous_response_id, 'resp_prior');
  assert.equal(record.body.output[0].content[0].text, 'partial before crash');
  assert.equal(second.deadLetter.exists('resp_dead_restart'), false);
  await second.close();
});

test('非 observer WS 不启用 Responses 心跳，observer 启用后发 Ping', async () => {
  const { PassThrough } = await import('node:stream');
  const plain = new PassThrough();
  const plainWs = createWebSocketTransport(plain, { pingMs: 20, pongGraceMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  plainWs.terminate();
  assert.equal(plain.destroyed, true);

  const observed = new PassThrough();
  const chunks = [];
  observed.on('data', (chunk) => chunks.push(chunk));
  const observedWs = createWebSocketTransport(observed, {
    observer: true,
    pingMs: 20,
    pongGraceMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  observedWs.terminate();
  assert.equal(chunks.some((chunk) => (chunk[0] & 0x0f) === 0x9), true);
});

test('observer 收到合法 Pong 后继续周期 Ping，随后停止 Pong 会触发超时', async () => {
  const { Duplex } = await import('node:stream');
  const chunks = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const closes = [];
  const ws = createWebSocketTransport(stream, {
    observer: true,
    requireClientPong: true,
    pingMs: 15,
    pongGraceMs: 40,
    onClose: (info) => closes.push(info),
  });

  function clientFrame(opcode, payload = Buffer.alloc(0)) {
    const body = Buffer.from(payload);
    const mask = Buffer.from([1, 2, 3, 4]);
    const header = Buffer.alloc(6 + body.length);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | body.length;
    mask.copy(header, 2);
    body.copy(header, 6);
    for (let index = 6; index < header.length; index += 1) {
      header[index] ^= mask[(index - 6) % 4];
    }
    return header;
  }

  const answeredPings = new Set();
  const answer = setInterval(() => {
    for (let index = 0; index < chunks.length; index += 1) {
      if ((chunks[index][0] & 0x0f) !== 0x9 || answeredPings.has(index)) continue;
      answeredPings.add(index);
      stream.push(clientFrame(0xA));
    }
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 85));
  assert.ok(answeredPings.size >= 3, `expected repeated pings, got ${answeredPings.size}`);
  assert.equal(ws.open, true);
  clearInterval(answer);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(ws.open, false);
  assert.equal(closes.at(-1)?.kind, 'heartbeat_timeout');
});

test('生产 WebSocket 心跳固定为 Ping 15 秒、Pong 宽限 10 秒', () => {
  assert.equal(WS_PING_MS, 15000);
  assert.equal(WS_PONG_GRACE_MS, 10000);
});
