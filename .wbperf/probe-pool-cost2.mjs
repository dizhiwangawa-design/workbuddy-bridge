
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bench2-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
fs.mkdirSync(process.env.WB_BRIDGE_HOME, { recursive: true, mode: 0o700 });
fs.copyFileSync(path.join(os.homedir(), '.workbuddy-bridge', 'pool.json'), path.join(process.env.WB_BRIDGE_HOME, 'pool.json'));

const pool = await import('/mnt/windata/awa/workbuddy-bridge/src/pool.js');
const target = path.join(process.env.WB_BRIDGE_HOME, 'pool.json');
console.log('fixture bytes', fs.statSync(target).size);

const bench = (label, n, fn) => {
  fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const t1 = process.hrtime.bigint();
  console.log(label.padEnd(28), (Number(t1 - t0) / 1e6 / n).toFixed(3), 'ms/op');
};

bench('loadPool()', 500, () => pool.loadPool());
bench('beginTask()', 500, () => pool.beginTask('default'));
bench('endTask(ok)', 500, () => pool.endTask('default', { ok: true, durationMs: 1200, meta: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 1000, output_tokens: 50 } } }));
bench('pickAccount()', 500, () => pool.pickAccount());
bench('poolView()', 100, () => pool.poolView());

// write count during a 12-request wave
let writes = 0;
const origWrite = fs.writeFileSync;
fs.writeFileSync = function (...args) { if (String(args[0]).includes('pool.json')) writes++; return origWrite.apply(fs, args); };
const wave = async () => {
  for (let i = 0; i < 12; i++) pool.beginTask('default');
  await new Promise((r) => setTimeout(r, 2200));
  for (let i = 0; i < 12; i++) pool.endTask('default', { ok: true, durationMs: 900, meta: { model: 'm', usage: { input_tokens: 500, output_tokens: 20 } } });
  await new Promise((r) => setTimeout(r, 2200));
};
writes = 0;
await wave();
console.log('writes during one 12-request wave:', writes);
fs.writeFileSync = origWrite;
console.log('final size', fs.statSync(target).size);
const disk = JSON.parse(fs.readFileSync(target, 'utf8'));
console.log('today.req on disk', disk.accounts.default.today.req, 'peakInflight', disk.accounts.default.today.peakInflight);
