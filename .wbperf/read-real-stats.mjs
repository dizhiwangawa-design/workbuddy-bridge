
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pool = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), 'utf8'));
const out = { accounts: {} };
for (const [name, e] of Object.entries(pool.accounts || {})) {
  out.accounts[name] = {
    today: e.today,
    total: e.total,
    lastLatencyMs: e.lastLatencyMs,
    model: e.model,
    status: e.status,
    inflight: e.inflight,
    maxConcurrency: e.maxConcurrency,
  };
}
const hours = Object.entries(pool.series?.hours || {}).sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, 12);
out.recentHours = hours.map(([k, v]) => ({
  hour: k,
  req: v.req,
  ok: v.ok,
  tin: v.tin,
  tout: v.tout,
  ms: v.ms,
  avgMs: v.req ? Math.round(v.ms / v.req) : 0,
  endToEndTokPerSec: v.ms ? +(v.tout / (v.ms / 1000)).toFixed(1) : 0,
  apis: Object.fromEntries(Object.entries(v.apis || {}).map(([a, m]) => [a, { req: m.req, ms: m.ms, tout: m.tout, avgMs: m.req ? Math.round(m.ms / m.req) : 0 }])),
}));
out.events = (pool.series?.events || []).slice(0, 12).map((ev) => ({
  at: new Date(ev.at).toISOString(),
  account: ev.account, ok: ev.ok, code: ev.code,
  tin: ev.tin, tout: ev.tout, ms: ev.ms, api: ev.apiProtocol,
  tokPerSec: ev.ms ? +(ev.tout / (ev.ms / 1000)).toFixed(1) : 0,
}));
const allEvents = pool.series?.events || [];
out.allEventStats = {
  count: allEvents.length,
  msMedian: (() => { const v = allEvents.map((e) => e.ms).filter((x) => x > 0).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; })(),
  msMin: Math.min(...allEvents.map((e) => e.ms)),
  msMax: Math.max(...allEvents.map((e) => e.ms)),
  toutTotal: allEvents.reduce((s, e) => s + (e.tout || 0), 0),
};
console.log(JSON.stringify(out, null, 1));
