
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pool = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const ev = (pool.series?.events || []).filter((e) => e.ms > 0);
const xs = ev.map((e) => e.tin);
const ys = ev.map((e) => e.ms);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const mx = mean(xs), my = mean(ys);
let num = 0, dx = 0, dy = 0;
for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
const r = num / Math.sqrt(dx * dy);

// 按输入规模分桶看平均耗时
const buckets = [[0, 50e3], [50e3, 100e3], [100e3, 200e3], [200e3, 400e3], [400e3, Infinity]];
const table = buckets.map(([lo, hi]) => {
  const s = ev.filter((e) => e.tin >= lo && e.tin < hi);
  if (!s.length) return { range: lo + '+' , n: 0 };
  const ms = s.map((e) => e.ms).sort((a, b) => a - b);
  return {
    rangeK: (lo / 1000) + '-' + (hi === Infinity ? 'inf' : hi / 1000),
    n: s.length,
    medianMs: ms[Math.floor(ms.length / 2)],
    p90Ms: ms[Math.floor(ms.length * 0.9)],
    medianTin: Math.round(mean(s.map((e) => e.tin))),
    medianTout: Math.round(mean(s.map((e) => e.tout))),
  };
});

// 输出 token 与耗时的相关性（弱相关说明耗时不在解码）
const rOut = (() => {
  const a = ev.map((e) => e.tout), b = ev.map((e) => e.ms);
  const ma = mean(a), mb = mean(b);
  let n2 = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { n2 += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return n2 / Math.sqrt(da * db);
})();

console.log(JSON.stringify({
  samples: ev.length,
  correlation_tin_vs_ms: +r.toFixed(3),
  correlation_tout_vs_ms: +rOut.toFixed(3),
  buckets: table,
  medianTin: Math.round(mean(xs)),
  medianTout: Math.round(mean(ev.map((e) => e.tout))),
}, null, 1));
