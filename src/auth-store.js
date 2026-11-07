import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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

  const timestamp = typeof now === 'function' ? now() : Number(now);
  const expiresIn = Number(refreshed.expiresIn);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    auth.expiresAt = timestamp + expiresIn * 1000;
  }
  const refreshExpiresIn = Number(refreshed.refreshExpiresIn);
  if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
    auth.refreshExpiresAt = timestamp + refreshExpiresIn * 1000;
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


const refreshLocks = new Map();

/** Refresh one account's access token, sharing one in-flight request with callers
 * for the same account so concurrent API requests cannot stampede the auth service. */
export function refreshAccountCredentials(accountName, client, {
  now: nowValue = Date.now(),
  refreshSkewMs = 0,
} = {}) {
  const now = () => (typeof nowValue === 'function' ? nowValue() : Number(nowValue));
  const key = String(accountName);
  const existing = refreshLocks.get(key);
  if (existing) return existing;

  const task = (async () => {
    const current = readAccountCredentials(key, { now: now(), refreshSkewMs });
    if (!current.ok) return current;
    if (!current.refreshToken) return { ok: false, reason: '账号没有可用的 refresh token' };

    let refreshed;
    try {
      refreshed = await client.refresh(current);
    } catch (error) {
      return { ok: false, reason: error?.message || '凭据刷新失败', code: error?.code };
    }
    if (typeof refreshed?.accessToken !== 'string' || !refreshed.accessToken) {
      return { ok: false, reason: '刷新响应缺少 accessToken', code: 'INVALID_REFRESH_RESPONSE' };
    }

    // A separate CLI login may have produced a newer token while refresh was in
    // flight. Never replace that newer credential with our older response.
    const latest = readAccountCredentials(key, { now: now(), refreshSkewMs: 0 });
    if (
      latest.ok
      && latest.accessToken !== current.accessToken
      && (latest.expiresAt || 0) >= (current.expiresAt || 0)
    ) {
      return latest;
    }

    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(current.filePath, 'utf8'));
    } catch (error) {
      return { ok: false, reason: error?.message || '凭据文件读取失败', code: error?.code };
    }
    const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : {};
    auth.accessToken = refreshed.accessToken;
    if (typeof refreshed.refreshToken === 'string' && refreshed.refreshToken) {
      auth.refreshToken = refreshed.refreshToken;
    }
    const expiresIn = Number(refreshed.expiresIn);
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      auth.expiresAt = now() + expiresIn * 1000;
    }
    const refreshExpiresIn = Number(refreshed.refreshExpiresIn);
    if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) {
      auth.refreshExpiresAt = now() + refreshExpiresIn * 1000;
    }
    doc.auth = auth;

    const temporary = `${current.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(doc, null, 2), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, current.filePath);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Ignore cleanup failure; the original credential remains authoritative.
      }
      return { ok: false, reason: error?.message || '凭据文件写入失败', code: error?.code };
    }
    return readAccountCredentials(key, { now: now(), refreshSkewMs: 0 });
  })().finally(() => {
    refreshLocks.delete(key);
  });

  refreshLocks.set(key, task);
  return task;
}
