
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pool = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const ev = (pool.series?.events || []).filter((e) => e.ms > 0 && e.ok);

// 分层：在「输出 token 相近」的样本里看输入 token 是否还影响耗时（偏相关思想）
const buckets = [[0, 60e3], [60e3, 140e3], [140e3, 300e3]];
const byOut = (list) => {
  const s = list.map((e) => e.tout).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const rowsOut = buckets.map(([lo, hi]) => {
  const sub = ev.filter((e) => e.tout >= lo / 10 && e.tout < hi / 10); // 用同一数量级近似：按输出分层不实际
  return null;
}).filter(Boolean);

// 更直接：按输出 token 分箱，看箱内输入与耗时的相关
const outBuckets = [[0, 300], [300, 800], [800, 2000], [2000, 6000]];
function corr(a, b) {
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a), mb = mean(b);
  let n = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? n / Math.sqrt(da * db) : null;
}
const table = outBuckets.map(([lo, hi]) => {
  const s = ev.filter((e) => e.tout >= lo && e.tout < hi);
  if (s.length < 8) return { outRange: lo + '-' + hi, n: s.length, skipped: true };
  const ms = s.map((e) => e.ms).sort((a, b) => a - b);
  return {
    outRange: lo + '-' + hi,
    n: s.length,
    medianOut: byOut(s),
    medianIn: Math.round(s.map((e) => e.tin).sort((a, b) => a - b)[Math.floor(s.length / 2)]),
    medianMs: ms[Math.floor(ms.length / 2)],
    corr_in_vs_ms_withinBucket: +(corr(s.map((e) => e.tin), s.map((e) => e.ms)) ?? 0).toFixed(2),
    tokPerSecEndToEnd: +(byOut(s) / (ms[Math.floor(ms.length / 2)] / 1000)).toFixed(0),
  };
});
console.log(JSON.stringify(table, null, 1));
