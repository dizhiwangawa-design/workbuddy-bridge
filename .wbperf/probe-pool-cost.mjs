
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bench-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');
fs.mkdirSync(process.env.WB_BRIDGE_HOME, { recursive: true, mode: 0o700 });
const real = path.join(os.homedir(), '.workbuddy-bridge', 'pool.json');
fs.copyFileSync(real, path.join(process.env.WB_BRIDGE_HOME, 'pool.json'));

const pool = await import('/mnt/windata/awa/workbuddy-bridge/src/pool.js');
const fsSize = fs.statSync(path.join(process.env.WB_BRIDGE_HOME, 'pool.json')).size;
console.log('fixture pool.json bytes', fsSize);

const bench = (label, n, fn) => {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn();
  const t1 = process.hrtime.bigint();
  console.log(label.padEnd(28), (Number(t1 - t0) / 1e6 / n).toFixed(3), 'ms/op');
};

bench('loadPool()', 200, () => pool.loadPool());
const p = pool.loadPool();
bench('savePool(pool)', 100, () => pool.savePool(p));
bench('beginTask()', 200, () => pool.beginTask('default'));
bench('endTask(ok)', 200, () => pool.endTask('default', { ok: true, durationMs: 1200, meta: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 1000, output_tokens: 50 } } }));
bench('pickAccount()', 200, () => pool.pickAccount());
bench('poolView()', 50, () => pool.poolView());
const file = path.join(process.env.WB_BRIDGE_HOME, 'pool.json');
bench('statSync', 500, () => fs.statSync(file));
console.log('final size', fs.statSync(file).size);
