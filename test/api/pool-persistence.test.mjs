import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-persist-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const pool = await import('../../src/pool.js');
const accounts = await import('../../src/accounts.js');

const POOL_FILE = path.join(process.env.WB_BRIDGE_HOME, 'pool.json');

function cred(name) {
  accounts.ensureAccount(name);
  const dir = accounts.accountAuthDir(name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth_fixture.info'), JSON.stringify({
    account: { uid: `uid-${name}` },
    auth: {
      accessToken: 'fixture-access',
      refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3_600_000,
      refreshExpiresAt: Date.now() + 7_200_000,
    },
    accounts: [],
  }), { mode: 0o600 });
}

/** 在子进程里跑一段脚本，等它报告「已经写进内存但还没落盘」后再发信号。 */
function runChild(script, signal, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, reason) => resolve({ code, signal: reason, stdout, stderr }));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`子进程超时：${stdout}${stderr}`));
    }, 15000);
    timer.unref?.();

    if (signal) {
      const waitFor = setInterval(() => {
        if (!stdout.includes('READY')) return;
        clearInterval(waitFor);
        child.kill(signal);
      }, 20);
      waitFor.unref?.();
    }
  });
}

test('统计只在内存里时，SIGTERM 也会把它写进 pool.json', async () => {
  cred('persist-a');
  pool.updateAccount('persist-a', { maxConcurrency: 2 });
  fs.rmSync(POOL_FILE, { force: true });

  const script = `
    const pool = await import('./src/pool.js');
    const accounts = await import('./src/accounts.js');
    accounts.ensureAccount('persist-a');
    const dir = accounts.accountAuthDir('persist-a');
    (await import('node:fs')).mkdirSync(dir, { recursive: true });
    pool.beginTask('persist-a');
    pool.endTask('persist-a', {
      ok: true,
      durationMs: 321,
      meta: { model: 'deepseek-v4.1-flash', usage: { input_tokens: 4321, output_tokens: 21 } },
    });
    process.stdout.write('READY\\n');
    // 不落盘、不退出：等外部发信号
    setInterval(() => {}, 1000);
  `;
  const result = await runChild(script, 'SIGTERM');
  assert.equal(result.code, 0, `子进程应按正常退出结束：${result.stdout}${result.stderr}`);

  const disk = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  assert.equal(disk.accounts['persist-a'].today.req, 1, '合并窗口里的统计必须落盘');
  assert.equal(disk.accounts['persist-a'].today.tokensIn, 4321);
  assert.equal(disk.accounts['persist-a'].today.peakInflight, 1);
});

test('SIGINT 也一样，且不会因为装了钩子就把进程钉住', async () => {
  cred('persist-b');
  pool.updateAccount('persist-b', { maxConcurrency: 1 });
  fs.rmSync(POOL_FILE, { force: true });

  const script = `
    const pool = await import('./src/pool.js');
    const accounts = await import('./src/accounts.js');
    accounts.ensureAccount('persist-b');
    pool.beginTask('persist-b');
    pool.endTask('persist-b', { ok: true, durationMs: 5, meta: { usage: { input_tokens: 7 } } });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const result = await runChild(script, 'SIGINT');
  assert.equal(result.code, 0, 'SIGINT 应按正常退出结束（我们显式 exit(0)）');
  const disk = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  assert.equal(disk.accounts['persist-b'].today.req, 1);
});

test('进程正常退出时也刷盘（不必等合并窗口）', async () => {
  cred('persist-c');
  pool.updateAccount('persist-c', { maxConcurrency: 1 });
  fs.rmSync(POOL_FILE, { force: true });

  const script = `
    const pool = await import('./src/pool.js');
    const accounts = await import('./src/accounts.js');
    accounts.ensureAccount('persist-c');
    pool.beginTask('persist-c');
    pool.endTask('persist-c', { ok: true, durationMs: 5, meta: { usage: { input_tokens: 11 } } });
    // 立刻正常退出
  `;
  const result = await runChild(script, null);
  assert.equal(result.code, 0, result.stderr);
  const disk = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  assert.equal(disk.accounts['persist-c'].today.req, 1, '正常退出也要把合并窗口写完');
});

test('另一个进程删了账号后，本进程缓存跟着删', () => {
  cred('persist-d');
  pool.updateAccount('persist-d', { maxConcurrency: 1 });
  assert.ok(pool.loadPool().accounts['persist-d'], '先在池里');

  const disk = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  delete disk.accounts['persist-d'];
  fs.writeFileSync(POOL_FILE, JSON.stringify(disk, null, 2));

  assert.equal(pool.loadPool().accounts['persist-d'], undefined, '外部删除应该生效');
});
