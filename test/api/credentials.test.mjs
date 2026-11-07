import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-'));
process.env.WB_BRIDGE_HOME = path.join(tmp, 'bridge');

const accounts = await import('../../src/accounts.js');
const auth = await import('../../src/auth-store.js');
const pool = await import('../../src/pool.js');

accounts.ensureAccount('cred-a');
const dir = accounts.accountAuthDir('cred-a');
fs.mkdirSync(dir, { recursive: true });

const doc = {
  account: { uid: 'uid-a', nickname: 'A' },
  auth: {
    accessToken: 'access-secret',
    refreshToken: 'refresh-secret',
    expiresAt: 2000000000,
    refreshExpiresAt: 2100000000,
    domain: 'www.codebuddy.cn',
  },
  accounts: [],
};

fs.writeFileSync(
  path.join(dir, 'Tencent-Cloud.coding-copilot.info'),
  JSON.stringify(doc),
  { mode: 0o600 },
);

function writeCredential(name, auth = {}, file = 'auth.info') {
  accounts.ensureAccount(name);
  const authDir = accounts.accountAuthDir(name);
  fs.mkdirSync(authDir, { recursive: true });
  const filePath = path.join(authDir, file);
  fs.writeFileSync(filePath, JSON.stringify({
    account: { uid: `uid-${name}`, nickname: name },
    auth,
    accounts: [],
  }), { mode: 0o600 });
  return filePath;
}

test('读取真实 .info 并把秒归一为毫秒', () => {
  const got = auth.readAccountCredentials('cred-a', { now: 1000 });
  assert.equal(got.ok, true);
  assert.equal(got.uid, 'uid-a');
  assert.equal(got.expiresAt, 2000000000000);
  assert.equal(got.refreshExpiresAt, 2100000000000);
  assert.equal(got.accessToken, 'access-secret');
  assert.equal(
    JSON.stringify(pool.poolView()).includes('access-secret'),
    false,
    'poolView 不得返回 token',
  );
});

test('访问 token 过期但 refresh token 有效时仍可刷新', () => {
  const got = auth.readAccountCredentials('cred-a', { now: 2000000001000 });
  assert.equal(got.ok, true);
  assert.equal(got.needsRefresh, true);
});

test('访问 token 和 refresh token 都过期时不返回可用凭据', () => {
  writeCredential('cred-expired', {
    accessToken: 'expired-access-secret',
    refreshToken: 'expired-refresh-secret',
    expiresAt: 1900000000,
    refreshExpiresAt: 1950000000,
  });

  const got = auth.readAccountCredentials('cred-expired', { now: 2000000001000 });
  assert.equal(got.ok, false);
  assert.equal(got.reason, '没有可用登录凭证');
  assert.equal(JSON.stringify(got).includes('expired-access-secret'), false);
  assert.equal(JSON.stringify(got).includes('expired-refresh-secret'), false);
});

test('同一账号存在多个凭据时选择到期时间最晚的文件', () => {
  writeCredential('cred-latest', {
    accessToken: 'earlier-access-secret',
    expiresAt: 2000000300,
    refreshExpiresAt: 2000000500,
  }, 'earlier.info');
  const latest = writeCredential('cred-latest', {
    accessToken: 'latest-access-secret',
    expiresAt: 2000000400000,
    refreshExpiresAt: 2000000500000,
  }, 'latest.info');

  const got = auth.readAccountCredentials('cred-latest', { now: 2000000000000 });
  assert.equal(got.ok, true);
  assert.equal(got.expiresAt, 2000000400000);
  assert.equal(got.filePath, latest);
});

test('刷新结果以 0600 安全回写原凭据文件并保留其他字段', () => {
  const file = writeCredential('cred-refresh-write', {
    accessToken: 'old-access-secret',
    refreshToken: 'old-refresh-secret',
    expiresAt: 2000000100,
    refreshExpiresAt: 2100000000,
    domain: 'keep.example',
  });
  const before = auth.readAccountCredentials('cred-refresh-write', {
    now: 2000000000000,
  });

  auth.saveRefreshedCredentials(before, {
    accessToken: 'new-access-secret',
    refreshToken: 'new-refresh-secret',
    expiresIn: 3600,
    refreshExpiresIn: 7200,
  }, { now: 2000000000000 });

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.auth.accessToken, 'new-access-secret');
  assert.equal(saved.auth.refreshToken, 'new-refresh-secret');
  assert.equal(saved.auth.domain, 'keep.example');
  assert.equal(saved.account.uid, 'uid-cred-refresh-write');
  assert.equal(saved.auth.expiresAt, 2000003600000);
  assert.equal(saved.auth.refreshExpiresAt, 2000007200000);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});


test('同账号并发刷新只调用一次上游并原子回写', async () => {
  const file = writeCredential('cred-refresh-lock', {
    accessToken: 'lock-old-access',
    refreshToken: 'lock-refresh',
    expiresAt: Math.floor((Date.now() + 500) / 1000),
    refreshExpiresAt: Math.floor((Date.now() + 86400) / 1000),
  });
  let calls = 0;
  const client = {
    async refresh() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { accessToken: 'lock-new-access', expiresIn: 3600 };
    },
  };
  const [first, second] = await Promise.all([
    auth.refreshAccountCredentials('cred-refresh-lock', client),
    auth.refreshAccountCredentials('cred-refresh-lock', client),
  ]);
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.accessToken, 'lock-new-access');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).auth.accessToken, 'lock-new-access');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('刷新期间外部 CLI 写入更新凭据时不反向覆盖', async () => {
  const file = writeCredential('cred-refresh-race', {
    accessToken: 'race-old-access',
    refreshToken: 'race-refresh',
    expiresAt: Math.floor((Date.now() + 500) / 1000),
    refreshExpiresAt: Math.floor((Date.now() + 86400) / 1000),
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    async refresh() {
      await gate;
      return { accessToken: 'race-refreshed-access', expiresIn: 3600 };
    },
  };
  const pending = auth.refreshAccountCredentials('cred-refresh-race', client);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.auth.accessToken = 'race-external-newer';
  doc.auth.expiresAt = Date.now() + 7200000;
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, 'race-external-newer');
  assert.equal(
    JSON.parse(fs.readFileSync(file, 'utf8')).auth.accessToken,
    'race-external-newer',
  );
});


test('刷新失败返回可诊断错误且不泄漏 token', async () => {
  writeCredential('cred-refresh-failure', {
    accessToken: 'failure-old-access',
    refreshToken: 'failure-secret-refresh',
    expiresAt: Math.floor((Date.now() + 500) / 1000),
    refreshExpiresAt: Math.floor((Date.now() + 86400) / 1000),
  });
  const result = await auth.refreshAccountCredentials('cred-refresh-failure', {
    async refresh() {
      throw Object.assign(new Error('refresh rejected'), { code: 'UPSTREAM_401' });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_401');
  assert.equal(result.reason, 'refresh rejected');
  assert.equal(JSON.stringify(result).includes('failure-secret-refresh'), false);
});
