import fs from 'node:fs';
import path from 'node:path';
import { accountAuthDir, getAccount } from './accounts.js';
import { writeJson } from './paths.js';

const SECONDS_CUTOFF = 100_000_000_000;

export function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < SECONDS_CUTOFF ? n * 1000 : n;
}

function jwtExpiresAt(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return normalizeEpochMs(claims.exp);
  } catch {
    return null;
  }
}

export function readAccountCredentials(accountName, {
  now = Date.now(),
  refreshSkewMs = 120_000,
} = {}) {
  if (!getAccount(accountName)) return { ok: false, reason: '账号不存在' };

  const dir = accountAuthDir(accountName);
  if (!fs.existsSync(dir)) return { ok: false, reason: '没有隔离登录凭证' };

  const candidates = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.info'))) {
    try {
      const filePath = path.join(dir, file);
      const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const auth = doc.auth || {};
      if (typeof auth.accessToken !== 'string' || !auth.accessToken) continue;

      const expiresAt = normalizeEpochMs(auth.expiresAt) || jwtExpiresAt(auth.accessToken);
      const refreshExpiresAt = normalizeEpochMs(auth.refreshExpiresAt);
      const refreshToken = typeof auth.refreshToken === 'string' && auth.refreshToken
        ? auth.refreshToken
        : null;
      const usable = expiresAt === null || expiresAt > now;
      const refreshable = refreshToken
        && (refreshExpiresAt === null || refreshExpiresAt > now);
      if (!usable && !refreshable) continue;

      candidates.push({
        ok: true,
        accessToken: auth.accessToken,
        refreshToken,
        uid: String(doc.account?.uid || ''),
        expiresAt,
        refreshExpiresAt,
        needsRefresh: expiresAt !== null && expiresAt - now <= refreshSkewMs,
        filePath,
      });
    } catch {
      // 单个损坏的 .info 不应掩盖同一账号下另一个有效文件。
    }
  }

  candidates.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));
  return candidates[0] || { ok: false, reason: '没有可用登录凭证' };
}

export function saveRefreshedCredentials(credentials, refreshed, {
  now = Date.now(),
} = {}) {
  if (!credentials?.filePath) throw new Error('missing credential file path');
  if (typeof refreshed?.accessToken !== 'string' || !refreshed.accessToken) {
    throw new Error('refreshed access token is missing');
  }

  const current = JSON.parse(fs.readFileSync(credentials.filePath, 'utf8'));
  const auth = current.auth && typeof current.auth === 'object' ? current.auth : {};
  auth.accessToken = refreshed.accessToken;
  if (typeof refreshed.refreshToken === 'string' && refreshed.refreshToken) {
    auth.refreshToken = refreshed.refreshToken;
  }

  const expiresIn = Number(refreshed.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    auth.expiresAt = now + expiresIn * 1000;
  }
  const refreshExpiresIn = Number(refreshed.refreshExpiresIn);
  if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
    auth.refreshExpiresAt = now + refreshExpiresIn * 1000;
  }
  current.auth = auth;
  writeJson(credentials.filePath, current, 0o600);
  return {
    ...credentials,
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken || credentials.refreshToken,
    expiresAt: normalizeEpochMs(auth.expiresAt),
    refreshExpiresAt: normalizeEpochMs(auth.refreshExpiresAt),
    needsRefresh: false,
  };
}
