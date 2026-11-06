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
