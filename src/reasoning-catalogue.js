import { reasoningDeclaration } from './reasoning-effort.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CATALOGUE_KEYS = ['data', 'models', 'list', 'result'];

function normalizeEndpoint(endpoint) {
  return String(endpoint || '').replace(/\/+$/, '');
}

function extractModels(value) {
  if (Array.isArray(value)) {
    return value.filter((model) => model && typeof model === 'object' && !Array.isArray(model));
  }
  if (!value || typeof value !== 'object') return [];
  for (const key of CATALOGUE_KEYS) {
    if (Object.hasOwn(value, key)) {
      return extractModels(value[key]);
    }
  }
  return [];
}

function modelId(model) {
  const id = model?.id ?? model?.name;
  return typeof id === 'string' ? id : null;
}

function declarationMap(models) {
  const declarations = new Map();
  for (const model of models) {
    const id = modelId(model);
    if (id) declarations.set(id, reasoningDeclaration(model));
  }
  return declarations;
}

function snapshotResult(entry, { stale = false, error = null } = {}) {
  return {
    models: entry.models,
    fetchedAt: entry.fetchedAt,
    stale,
    error,
  };
}

export function createReasoningCatalogue({
  endpoint,
  load,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
} = {}) {
  if (typeof load !== 'function') {
    throw new TypeError('reasoning catalogue requires a load function');
  }

  const configuredEndpoint = normalizeEndpoint(endpoint);
  const entries = new Map();
  const inFlight = new Map();

  function cacheKey(credentials, accountId, name = configuredEndpoint) {
    const uid = String(credentials?.uid || '').trim();
    const owner = uid || `account:${accountId ?? ''}`;
    return `${normalizeEndpoint(name)}\0${owner}`;
  }

  function getEntry(credentials, accountId, name) {
    return entries.get(cacheKey(credentials, accountId, name)) || null;
  }

  async function loadSnapshot({ accountId, credentials, key }) {
    const previous = entries.get(key);
    const loadedAt = Number(now());
    try {
      const payload = await load({ accountId, credentials });
      const models = extractModels(payload);
      if (!models.length) {
        throw new Error('upstream model catalogue was empty');
      }
      const entry = {
        models,
        fetchedAt: loadedAt,
        declarations: declarationMap(models),
      };
      entries.set(key, entry);
      return snapshotResult(entry);
    } catch (error) {
      if (previous) {
        return snapshotResult(previous, { stale: true, error });
      }
      throw error;
    }
  }

  return {
    async snapshot({ accountId, credentials, refresh = false }) {
      const key = cacheKey(credentials, accountId);
      const cached = entries.get(key);
      if (!refresh && cached && now() - cached.fetchedAt < ttlMs) {
        return snapshotResult(cached);
      }

      const pending = inFlight.get(key);
      if (pending) return pending;

      const loading = loadSnapshot({ accountId, credentials, key })
        .finally(() => {
          if (inFlight.get(key) === loading) inFlight.delete(key);
        });
      inFlight.set(key, loading);
      return loading;
    },

    getDeclaration({ accountId, credentials, model }) {
      const entry = getEntry(credentials, accountId);
      if (!entry || typeof model !== 'string') return null;
      return entry.declarations.get(model) || null;
    },

    invalidate({ credentials, endpoint: invalidatedEndpoint = configuredEndpoint }) {
      entries.delete(cacheKey(credentials, undefined, invalidatedEndpoint));
    },
  };
}
