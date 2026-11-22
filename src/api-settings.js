import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { loadConfig, saveConfig } from './paths.js';

const BOOLEAN_FIELDS = [
  'enabled',
  'openai',
  'anthropic',
  'anthropicEnabled',
  'streaming',
  'tools',
  'responsesPersistence',
  'responsesNudge',
  'continuationNudge',
  'channelSanitize',
  'requireApiKey',
  'remoteRequireKey',
  'trustProxy',
];

const POSITIVE_INTEGER_FIELDS = {
  dsmlMaxBufferBytes: 64 * 1024 * 1024,
  firstByteTimeoutMs: 24 * 60 * 60 * 1000,
  idleTimeoutMs: 24 * 60 * 60 * 1000,
  finishGraceMs: 60 * 1000,
  totalTimeoutMs: 24 * 60 * 60 * 1000,
};

/** 本机/内网地址判断：上游地址指向这些就等于把 accessToken 交给本地进程或同网段。 */
function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  // IPv6 唯一本地地址 (fc00::/7) 与链路本地 (fe80::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地，含云厂商元数据地址
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * 上游地址白名单。
 *
 * 这个值直接决定 accessToken 发往哪里（upstream-client 会带 authorization: Bearer），
 * 所以只校验「是不是 http(s)」远远不够：把它改成 attacker.example 就等于把账号
 * token 送出去。这里禁止私有网段与链路本地地址；确实需要连自建网关的部署，
 * 用 WB_ALLOW_PRIVATE_UPSTREAM=1 显式放行。
 */
function assertUpstreamHost(url) {
  const allowPrivate = /^(1|true|yes)$/i.test(String(process.env.WB_ALLOW_PRIVATE_UPSTREAM || ''));
  // 可选的域名白名单：设了就只认列出的主机（逗号分隔，支持 *.example.com）。
  // 不设时保持「任意公网 https 主机」，避免把自建网关的用户挡在门外。
  const allowList = String(process.env.WB_UPSTREAM_ALLOW_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowList.length) {
    const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    const ok = allowList.some((pattern) => (pattern.startsWith('*.') 
      ? host.endsWith(pattern.slice(1))
      : host === pattern));
    if (!ok) {
      throw new Error(
        'upstreamBaseUrl 的主机不在 WB_UPSTREAM_ALLOW_HOSTS 白名单里（' + host + '）。',
      );
    }
  }
  if (allowPrivate) return;
  if (isPrivateHostname(url.hostname)) {
    throw new Error(
      'upstreamBaseUrl 不能指向本机或内网地址（' + url.hostname + '）：'
      + '上游请求会携带账号 accessToken。确需自建网关时设 WB_ALLOW_PRIVATE_UPSTREAM=1。',
    );
  }
}

function publicKey(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
  };
}

export function getApiSettings() {
  const config = loadConfig().apiCompat;
  const anthropicEnabled = Object.hasOwn(config, 'anthropicEnabled')
    ? Boolean(config.anthropicEnabled)
    : Boolean(config.anthropic);
  return {
    ...config,
    anthropic: anthropicEnabled,
    anthropicEnabled,
    keys: Array.isArray(config.keys) ? config.keys : [],
  };
}

export function updateApiSettings(patch = {}) {
  const config = loadConfig();
  const next = { ...getApiSettings() };

  for (const field of BOOLEAN_FIELDS) {
    if (Object.hasOwn(patch, field)) {
      if (typeof patch[field] !== 'boolean') throw new Error(`${field} must be boolean`);
      next[field] = patch[field];
      if (field === 'anthropic') next.anthropicEnabled = patch[field];
      if (field === 'anthropicEnabled') next.anthropic = patch[field];
      if (
        (field === 'anthropic' || field === 'anthropicEnabled')
        && patch[field]
        && !Object.hasOwn(patch, 'enabled')
      ) {
        next.enabled = true;
      }
      if (field === 'responsesPersistence' && patch[field] && !next.openai) {
        throw new Error('responsesPersistence requires OpenAI to be enabled');
      }
      if (field === 'openai' && !patch[field] && !Object.hasOwn(patch, 'responsesPersistence')) {
        next.responsesPersistence = false;
        next.responsesNudge = false;
      }
      if (field === 'responsesPersistence' && !patch[field]) {
        next.responsesNudge = false;
      }
      if (field === 'responsesNudge' && patch[field] && !next.responsesPersistence) {
        throw new Error('responsesNudge requires Responses persistence to be enabled');
      }
    }
  }

  if (Object.hasOwn(patch, 'upstreamBaseUrl')) {
    const value = String(patch.upstreamBaseUrl || '').trim();
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error('upstreamBaseUrl must be a valid URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('upstreamBaseUrl must use http or https');
    }
    assertUpstreamHost(url);
    next.upstreamBaseUrl = value.replace(/\/+$/, '');
  }

  if (Object.hasOwn(patch, 'defaultModel')) {
    const value = String(patch.defaultModel || '').trim();
    if (!value) throw new Error('defaultModel must not be empty');
    next.defaultModel = value.slice(0, 200);
  }

  if (Object.hasOwn(patch, 'timeoutMs')) {
    const timeoutMs = Number(patch.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('timeoutMs must be a positive number');
    }
    next.timeoutMs = Math.round(timeoutMs);
  }

  for (const [field, maximum] of Object.entries(POSITIVE_INTEGER_FIELDS)) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = Number(patch[field]);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`${field} must be an integer between 1 and ${maximum}`);
    }
    next[field] = value;
  }

  config.apiCompat = next;
  saveConfig(config);
  return getApiSettings();
}

export function publicApiSettings() {
  const config = getApiSettings();
  return {
    ...config,
    clientKeyConfigured: config.keys.length > 0,
    keys: config.keys.map(publicKey),
  };
}

export function createApiKey(name) {
  const config = loadConfig();
  const current = getApiSettings();
  const created = makeApiKey(uniqueKeyName(name || 'dashboard', current.keys));
  config.apiCompat = {
    ...current,
    keys: [...current.keys, created.record],
  };
  saveConfig(config);
  return {
    key: created.key,
    record: publicKey(created.record),
  };
}

function uniqueKeyName(name, records = []) {
  const base = String(name || 'dashboard').trim().slice(0, 40) || 'dashboard';
  const used = new Set(records.map((record) => String(record?.name || '')));
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function makeApiKey(name) {
  const key = `sk-wb_${randomBytes(24).toString('base64url')}`;
  const record = {
    id: randomUUID(),
    name: String(name || 'default').trim().slice(0, 40) || 'default',
    hash: createHash('sha256').update(key).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  return { key, record };
}

export function resetApiKey(name) {
  const config = loadConfig();
  const created = makeApiKey(name || 'dashboard');
  config.apiCompat = {
    ...getApiSettings(),
    keys: [created.record],
  };
  saveConfig(config);
  return {
    key: created.key,
    record: publicKey(created.record),
  };
}

export function deleteApiKey(id) {
  const config = loadConfig();
  const before = getApiSettings().keys;
  const after = before.filter((record) => record.id !== id);
  if (after.length === before.length) return false;
  config.apiCompat = { ...getApiSettings(), keys: after };
  saveConfig(config);
  return true;
}

export function resolveApiKey(raw) {
  if (!raw) return null;
  const got = createHash('sha256').update(String(raw)).digest();
  const record = getApiSettings().keys.find((candidate) => {
    const expected = Buffer.from(String(candidate.hash || ''), 'hex');
    return got.length === expected.length && timingSafeEqual(expected, got);
  });
  return record ? publicKey(record) : null;
}

export function verifyApiKey(raw) {
  if (!raw) return false;
  const got = createHash('sha256').update(String(raw)).digest();
  return getApiSettings().keys.some((record) => {
    if (!/^[a-f0-9]{64}$/i.test(String(record.hash || ''))) return false;
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
}
