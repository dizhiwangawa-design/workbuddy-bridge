
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 直接测 /api/pool 与 /api/stats 的成本（面板每 5 秒各轮询一次）
const realHome = path.join(os.homedir(), '.workbuddy-bridge');
const pool = JSON.parse(fs.readFileSync(path.join(realHome, 'pool.json'), 'utf8'));
const { buildStats } = await import('../src/stats.js');

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
function bench(fn, reps = 30) {
  fn();
  const s = [];
  for (let i = 0; i < reps; i++) { const t0 = hr(); fn(); s.push(ms(t0, hr())); }
  s.sort((a, b) => a - b);
  return { medianMs: +s[Math.floor(s.length / 2)].toFixed(2), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2) };
}

const statsToday = bench(() => buildStats(pool, 'today'));
const statsYear = bench(() => buildStats(pool, 'year'));

// 每个账号的 quickAuthCheck 成本（面板刷新时每号一次）
const accounts = await import('../src/accounts.js');
const poolMod = await import('../src/pool.js');
const perAccount = bench(() => { for (const n of Object.keys(pool.accounts)) poolMod.poolView(); }, 10);

console.log(JSON.stringify({
  accountsInPool: Object.keys(pool.accounts).length,
  poolJsonBytes: fs.statSync(path.join(realHome, 'pool.json')).size,
  buildStatsToday: statsToday,
  buildStatsYear: statsYear,
  fullPoolView: perAccount,
  adminPollIntervalSec: 5,
  eventsInSeries: (pool.series?.events || []).length,
  hoursBuckets: Object.keys(pool.series?.hours || {}).length,
  daysBuckets: Object.keys(pool.series?.days || {}).length,
}, null, 1));
