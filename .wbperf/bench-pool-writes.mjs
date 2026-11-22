/**
 * 号池落盘次数与耗时。
 *
 * 断言口径：一波 N 并发请求 = 2N 次 begin/end，节流后落盘次数应该只剩个位数，
 * 而不是 2N（旧实现每次 begin/end 都全量重写一份近 100 KB 的 pool.json）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wbperf-writes-'));
process.env.WB_BRIDGE_HOME = path.join(home, 'bridge');
fs.mkdirSync(process.env.WB_BRIDGE_HOME, { recursive: true, mode: 0o700 });

// 用一份真实体量的池当样本：没有真文件就自己造 160 条事件 + 27 个小时桶
const real = path.join(os.homedir(), '.workbuddy-bridge', 'pool.json');
const target = path.join(process.env.WB_BRIDGE_HOME, 'pool.json');
if (fs.existsSync(real)) {
  fs.copyFileSync(real, target);
} else {
  const hours = {};
  for (let i = 0; i < 27; i++) {
    hours['2026-11-' + String(1 + (i % 22)).padStart(2, '0') + 'T' + String(i % 24).padStart(2, '0')] =
      { req: 40, ok: 40, fail: 0, tin: 120000, tout: 800, cacheRead: 90000, cacheWrite: 0, ms: 240000, ttftReq: 40, ttftMs: 16000, decodeMs: 80000, decodeTokens: 800, cost: 0, apis: {}, keys: {} };
  }
  fs.writeFileSync(target, JSON.stringify({
    version: 2, strategy: 'balanced', maxAttempts: 3, rrCursor: 0,
    accounts: { bench: { name: 'bench', enabled: true, weight: 1, maxConcurrency: 4, budgetTokens: 0, day: '2026-11-22', today: { req: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, ms: 0, cost: 0 }, days: {}, total: { req: 0, ok: 0, fail: 0, tokensIn: 0, tokensOut: 0, ms: 0, cost: 0 }, cooldowns: {}, failures: 0 } },
    series: { version: 1, seq: 160, hours, days: {}, events: Array.from({ length: 160 }, (_, i) => ({ seq: i, at: Date.now() - i * 60000, account: 'bench', model: 'deepseek-v4.1-flash', ok: 1, code: '', tin: 12000, tout: 900, cacheRead: 9000, ms: 4200, apiProtocol: 'anthropic', clientKeyId: 'k', clientKeyName: 'panel' })) },
  }, null, 2));
}

const pool = await import('../src/pool.js');
const bytes = fs.statSync(target).size;

let writes = 0;
let bytesWritten = 0;
const origWrite = fs.writeFileSync;
fs.writeFileSync = function (file, data, ...rest) {
  if (String(file).includes('pool.json')) {
    writes += 1;
    bytesWritten += Buffer.byteLength(String(data));
  }
  return origWrite.call(fs, file, data, ...rest);
};

const bench = (label, n, fn) => {
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const t1 = process.hrtime.bigint();
  console.log(label.padEnd(30), (Number(t1 - t0) / 1e6 / n).toFixed(3), 'ms/op');
};

console.log('pool.json', (bytes / 1024).toFixed(1), 'KB');
bench('loadPool()（缓存命中）', 500, () => pool.loadPool());
bench('beginTask()', 500, () => pool.beginTask('bench'));
bench('endTask(ok)', 500, () => pool.endTask('bench', {
  ok: true, durationMs: 1200,
  meta: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 1200, output_tokens: 90 } },
}));

for (const wave of [12, 48]) {
  writes = 0;
  bytesWritten = 0;
  for (let i = 0; i < wave; i++) pool.beginTask('bench');
  for (let i = 0; i < wave; i++) {
    pool.endTask('bench', {
      ok: true, durationMs: 900,
      meta: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 800, output_tokens: 40 } },
    });
  }
  // 合并窗口 500 ms、硬上限 2 s：等 2.5 s 后统计这段时间一共写了几次
  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log(
    `一波 ${wave} 并发（${wave * 2} 次 begin/end）→ 落盘 ${writes} 次，写 ${(bytesWritten / 1024).toFixed(0)} KB` +
    `（旧实现是 ${wave * 2} 次 / ${((wave * 2 * bytes) / 1024 / 1024).toFixed(2)} MB）`,
  );
}

fs.writeFileSync = origWrite;
const disk = JSON.parse(fs.readFileSync(target, 'utf8'));
console.log('落盘统计 today.req =', disk.accounts.bench.today.req, '· peakInflight =', disk.accounts.bench.today.peakInflight);
