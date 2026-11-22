
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const realPool = path.join(os.homedir(), '.workbuddy-bridge', 'pool.json');
const raw = fs.readFileSync(realPool, 'utf8');
const bytes = Buffer.byteLength(raw);

const hr = () => process.hrtime.bigint();
const ms = (a, b) => Number(b - a) / 1e6;
function bench(fn, reps = 40) {
  fn();
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = hr();
    fn();
    samples.push(ms(t0, hr()));
  }
  samples.sort((a, b) => a - b);
  return {
    median: +samples[Math.floor(samples.length / 2)].toFixed(4),
    p95: +samples[Math.floor(samples.length * 0.95)].toFixed(4),
  };
}

const parse = bench(() => JSON.parse(raw));
const stringify = bench(() => JSON.stringify(JSON.parse(raw), null, 2));
const parsed = JSON.parse(raw);
const strOnly = bench(() => JSON.stringify(parsed, null, 2));
const pretty = JSON.stringify(parsed, null, 2);
const write = bench(() => fs.writeFileSync(path.join(os.tmpdir(), 'wbpool-probe.json'), pretty));
const stringifyCompact = bench(() => JSON.stringify(parsed));

// 真实号池的组成占比
const section = (k) => Buffer.byteLength(JSON.stringify(parsed[k], null, 2), 'utf8');
const accountName = Object.keys(parsed.accounts)[0];
const accountBytes = Buffer.byteLength(JSON.stringify(parsed.accounts[accountName], null, 2), 'utf8');

console.log(JSON.stringify({
  poolBytes: bytes,
  loadPool: parse,
  savePool_stringify: stringify,
  savePool_stringifyReuse: strOnly,
  savePool_writeOnly: write,
  stringifyCompact: stringifyCompact,
  accounts: Object.keys(parsed.accounts).length,
  oneAccountBytes: accountBytes,
  seriesBytes: section('series'),
  eventsInSeries: Array.isArray(parsed.series?.events) ? parsed.series.events.length : null,
  hoursInSeries: parsed.series?.hours ? Object.keys(parsed.series.hours).length : null,
  daysInSeries: parsed.series?.days ? Object.keys(parsed.series.days).length : null,
}, null, 1));
