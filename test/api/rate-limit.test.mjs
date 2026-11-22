import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rate-limit-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const { resetAtFromResponse, resetAtFromText, COOLDOWN_HORIZON_MS } = await import(
  '../../src/rate-limit.js'
);
const { retryAfterHeaders } = await import('../../src/api-errors.js');
const pool = await import('../../src/pool.js');
const accounts = await import('../../src/accounts.js');

const NOW = Date.UTC(2026, 10, 22, 6, 0, 0);
const headers = (record) => ({ get: (name) => record[name] ?? null });

test('Retry-After 秒数换算成绝对时刻', () => {
  assert.equal(
    resetAtFromResponse(headers({ 'retry-after': '120' }), '', NOW),
    NOW + 120_000,
  );
});

test('retry-after-ms 按毫秒处理', () => {
  assert.equal(
    resetAtFromResponse(headers({ 'retry-after-ms': '5000' }), '', NOW),
    NOW + 5_000,
  );
});

test('x-ratelimit-reset 的 epoch 秒与毫秒都能认', () => {
  const epochSec = (NOW + 3_600_000) / 1000;
  assert.equal(resetAtFromResponse(headers({ 'x-ratelimit-reset': String(epochSec) }), '', NOW), NOW + 3_600_000);
  assert.equal(
    resetAtFromResponse(headers({ 'x-ratelimit-reset': String(epochSec * 1000) }), '', NOW),
    NOW + 3_600_000,
  );
});

test('Retry-After 的 HTTP 日期形式也能认', () => {
  const at = new Date(NOW + 90_000).toUTCString();
  assert.equal(resetAtFromResponse(headers({ 'retry-after': at }), '', NOW), NOW + 90_000);
});

test('报文里的「将在 … (UTC+8) 重置」换算成本地时刻', () => {
  // 2026-11-22 15:30:00 UTC+8 == 07:30Z
  assert.equal(
    resetAtFromText('额度将在 2026-11-22 15:30:00 (UTC+8) 重置', NOW),
    Date.UTC(2026, 10, 22, 7, 30, 0),
  );
});

test('多个来源同时存在时取最晚的那个', () => {
  const both = headers({ 'retry-after': '60', 'retry-after-ms': '900000' });
  assert.equal(resetAtFromResponse(both, '', NOW), NOW + 900_000);
});

test('解析不到、已过期、离谱的值都返回 0（退回指数退避）', () => {
  assert.equal(resetAtFromResponse(headers({}), 'rate limit exceeded', NOW), 0);
  assert.equal(resetAtFromResponse(headers({ 'retry-after': '-5' }), '', NOW), 0);
  assert.equal(resetAtFromResponse(headers({ 'retry-after': '0' }), '', NOW), 0);
  // 超过一天的一律当脏数据：宁可退避，也不要把号搁置几天
  assert.equal(
    resetAtFromResponse(headers({ 'retry-after-ms': String(COOLDOWN_HORIZON_MS + 1) }), '', NOW),
    0,
  );
  assert.equal(resetAtFromResponse(headers({}), '随便一句没有日期的报错', NOW), 0);
});

test('Retry-After 响应头把 resetAt 透给客户端', () => {
  const now = Date.now();
  assert.deepEqual(retryAfterHeaders({ resetAt: now + 30_000 }, now), { 'retry-after': '30' });
  // 不足一秒也说 1 秒：0 读起来像「立刻可重试」
  assert.deepEqual(retryAfterHeaders({ resetAt: now + 100 }, now), { 'retry-after': '1' });
  assert.deepEqual(retryAfterHeaders({ resetAt: now - 1 }, now), {});
  assert.deepEqual(retryAfterHeaders({}, now), {});
});

test('endTask 用上游给的恢复时刻打全模型冷却', async () => {
  accounts.ensureAccount('rl-a');
  pool.updateAccount('rl-a', { maxConcurrency: 1 });
  const resetAt = Date.now() + 3 * 3600 * 1000;

  pool.beginTask('rl-a');
  const entry = pool.endTask('rl-a', {
    ok: false,
    code: 'RATE_LIMITED',
    error: 'quota exceeded',
    durationMs: 10,
    meta: { model: 'deepseek-v4.1-flash', resetAt },
  });

  assert.equal(entry.cooldowns['deepseek-v4.1-flash'].until, resetAt);
  assert.equal(entry.today.rateLimited, 1);
  assert.equal(entry.status, 'cooling');
  assert.equal(pool.pickAccount().name, null);

  // 面板显示的是同一份时刻
  const row = pool.poolView().accounts.find((item) => item.name === 'rl-a');
  assert.equal(row.cooldownUntil, resetAt);
  assert.ok(row.cooldownLeftMs > 0);

  pool.resetCooldown('rl-a');
});

test('没有恢复时刻时退回指数退避，且不会超过 30 分钟', async () => {
  accounts.ensureAccount('rl-b');
  pool.updateAccount('rl-b', { maxConcurrency: 1 });

  let last = 0;
  for (let i = 0; i < 8; i += 1) {
    pool.beginTask('rl-b');
    const entry = pool.endTask('rl-b', {
      ok: false,
      code: 'RATE_LIMITED',
      error: 'rate limit',
      durationMs: 1,
      meta: { model: 'm', usage: {} },
    });
    last = entry.cooldowns.m.until - Date.now();
    pool.resetCooldown('rl-b');
  }
  assert.ok(last > 0, '应打上冷却');
  assert.ok(last <= 30 * 60 * 1000 + 1000, '退避上限是 30 分钟');
});
