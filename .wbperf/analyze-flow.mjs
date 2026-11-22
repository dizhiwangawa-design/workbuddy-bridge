
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pool = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const ev = pool.series?.events || [];
const codes = {};
for (const e of ev) codes[e.code || '(none)'] = (codes[e.code || '(none)'] || 0) + 1;

// 连续时间线：找出相邻请求间隔，判断是否串行（maxConcurrency=1）
const sorted = ev.slice().sort((a, b) => a.at - b.at);
const gaps = [];
for (let i = 1; i < sorted.length; i++) {
  const gap = sorted[i].at - (sorted[i - 1].at + sorted[i - 1].ms);
  gaps.push({ gapMs: Math.round(gap), prevMs: sorted[i - 1].ms, nextMs: sorted[i].ms });
}
const overlapping = gaps.filter((g) => g.gapMs < 0).length;

// 每个请求平均「有效输出速度」
const perReq = ev.filter((e) => e.ms > 0 && e.tout > 0).map((e) => ({
  tin: e.tin, tout: e.tout, ms: e.ms, tps: +(e.tout / (e.ms / 1000)).toFixed(0),
}));
const tpsList = perReq.map((r) => r.tps).sort((a, b) => a - b);

// 平均「输入 token 每人次」与「输出 token」
const sum = (k) => ev.reduce((s, e) => s + (e[k] || 0), 0);

console.log(JSON.stringify({
  events: ev.length,
  codeDistribution: codes,
  overlappingPairs: overlapping,
  totalPairs: gaps.length,
  inputTokensTotal: sum('tin'),
  outputTokensTotal: sum('tout'),
  avgInputPerRequest: Math.round(sum('tin') / ev.length),
  avgOutputPerRequest: Math.round(sum('tout') / ev.length),
  perRequestOutputTps: { p10: tpsList[Math.floor(tpsList.length * 0.1)], p50: tpsList[Math.floor(tpsList.length * 0.5)], p90: tpsList[Math.floor(tpsList.length * 0.9)] },
  inputToOutputRatio: +(sum('tin') / sum('tout')).toFixed(1),
}, null, 1));
