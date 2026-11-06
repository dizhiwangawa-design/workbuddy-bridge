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
  'streaming',
  'tools',
  'channelSanitize',
  'requireApiKey',
];

function publicKey(record) {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
  };
}

export function getApiSettings() {
  const config = loadConfig().apiCompat;
  return {
    ...config,
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

  config.apiCompat = next;
  saveConfig(config);
  return getApiSettings();
}

export function publicApiSettings() {
  const config = getApiSettings();
  return {
    ...config,
    keys: config.keys.map(publicKey),
  };
}

export function createApiKey(name) {
  const config = loadConfig();
  const key = `sk-wb_${randomBytes(24).toString('base64url')}`;
  const record = {
    id: randomUUID(),
    name: String(name || 'default').trim().slice(0, 40) || 'default',
    hash: createHash('sha256').update(key).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  config.apiCompat = {
    ...getApiSettings(),
    keys: [...getApiSettings().keys, record],
  };
  saveConfig(config);
  return { key, record: publicKey(record) };
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

export function verifyApiKey(raw) {
  if (!raw) return false;
  const got = createHash('sha256').update(String(raw)).digest();
  return getApiSettings().keys.some((record) => {
    if (!/^[a-f0-9]{64}$/i.test(String(record.hash || ''))) return false;
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === got.length && timingSafeEqual(expected, got);
  });
}
