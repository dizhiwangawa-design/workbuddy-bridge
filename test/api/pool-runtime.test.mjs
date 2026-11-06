import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lease-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const pool = await import('../../src/pool.js');
const accounts = await import('../../src/accounts.js');

test('withAccountLease 在异常后仍释放并发占位', async () => {
  accounts.ensureAccount('lease-a');
  pool.updateAccount('lease-a', { maxConcurrency: 1 });
  await assert.rejects(
    pool.withAccountLease('lease-a', async () => {
      assert.equal(pool.poolView().accounts.find((a) => a.name === 'lease-a').inflight, 1);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(pool.poolView().accounts.find((a) => a.name === 'lease-a').inflight, 0);
});
