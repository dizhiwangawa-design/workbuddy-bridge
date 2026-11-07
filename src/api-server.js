import {
  createApiKey,
  deleteApiKey,
  publicApiSettings,
  updateApiSettings,
  getApiSettings,
  verifyApiKey,
  resetApiKey,
} from './api-settings.js';
import { ApiError, sendApiError } from './api-errors.js';
import { createAnthropicRuntime, createOpenAIRuntime } from './api-runtime.js';
import { createResponsesRuntime } from './api-responses.js';
import { pickAccount } from './pool.js';
import { readAccountCredentials } from './auth-store.js';
import { createUpstreamClient } from './upstream-client.js';

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        rejectOnce(new ApiError(413, '请求体过大', {
          code: 'request_too_large',
        }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        settled = true;
        resolve({});
        return;
      }
      try {
        const body = JSON.parse(raw);
        settled = true;
        resolve(body);
      } catch {
        rejectOnce(new ApiError(400, '请求体不是合法 JSON', {
          code: 'invalid_json',
        }));
      }
    });
    req.on('error', rejectOnce);
  });
}

function readClientKey(req) {
  const authorization = String(req.headers.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || String(req.headers['x-api-key'] || '').trim();
}

function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase();
  return value === '::1'
    || value === '127.0.0.1'
    || value.startsWith('127.')
    || value.startsWith('::ffff:127.');
}

export function clientKeyRequired(request, config) {
  if (config.requireApiKey) return true;
  if (!config.remoteRequireKey) return false;
  if (config.trustProxy) return true;
  const address = request?.remoteAddress
    || request?.socket?.remoteAddress
    || request?.connection?.remoteAddress;
  return !isLoopbackAddress(address);
}

function protocolFor(pathname) {
  return pathname === '/v1/messages' || pathname.startsWith('/v1/messages/')
    ? 'anthropic'
    : 'openai';
}

function routeFor(pathname) {
  if (pathname === '/v1/responses' || pathname === '/v1/responses/') {
    return { method: 'POST', operation: 'openai.responses' };
  }
  if (/^\/v1\/responses\/[^/]+$/.test(pathname)) {
    return { method: 'GET', operation: 'openai.response' };
  }
  if (pathname === '/v1/chat/completions') {
    return { method: 'POST', operation: 'openai.chat' };
  }
  if (pathname === '/v1/models') {
    return { method: 'GET', operation: 'openai.models' };
  }
  if (/^\/v1\/models\/[^/]+$/.test(pathname)) {
    return { method: 'GET', operation: 'openai.model' };
  }
  if (pathname === '/v1/messages') {
    return { method: 'POST', operation: 'anthropic.messages' };
  }
  if (pathname === '/v1/messages/count_tokens') {
    return { method: 'POST', operation: 'anthropic.count_tokens' };
  }
  return null;
}

export async function handleApiRequest({ req, res, url, deps = {} }) {
  const pathname = url.pathname;
  const protocol = protocolFor(pathname);
  if (pathname === '/v1/responses' || pathname === '/v1/responses/') {
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (upgrade === 'websocket') {
      return false;
    }
  }

  try {
    const config = getApiSettings();
    if (!config.enabled) {
      sendApiError(res, new ApiError(404, 'API compatibility is disabled', {
        code: 'api_disabled',
      }), protocol);
      return true;
    }

    const protocolEnabled = protocol === 'anthropic' ? config.anthropic : config.openai;
    if (!protocolEnabled) {
      sendApiError(res, new ApiError(404, 'protocol is disabled', {
        code: 'protocol_disabled',
      }), protocol);
      return true;
    }

    if (clientKeyRequired(req, config) && !verifyApiKey(readClientKey(req))) {
      sendApiError(res, new ApiError(401, 'invalid API key', {
        type: 'authentication_error',
        code: 'invalid_api_key',
      }), protocol);
      return true;
    }

    const route = routeFor(pathname);
    if (!route) {
      sendApiError(res, new ApiError(404, 'API route not found', {
        code: 'not_found',
      }), protocol);
      return true;
    }

    if (req.method !== route.method) {
      sendApiError(res, new ApiError(405, 'method not allowed', {
        code: 'method_not_allowed',
      }), protocol);
      return true;
    }

    if (route.operation === 'anthropic.count_tokens') {
      const body = await readBody(req);
      const runtime = deps.anthropicRuntime || deps.runtime || createAnthropicRuntime({
        ...deps,
        cancelPersistence: sharedCancelStore(deps),
      });
      runtime.countTokens({ res, body, config });
      return true;
    }

    if (route.operation === 'anthropic.messages') {
      const body = await readBody(req);
      const runtime = deps.anthropicRuntime || deps.runtime || createAnthropicRuntime({
        ...deps,
        cancelPersistence: sharedCancelStore(deps),
      });
      await runtime.messages({ req, res, body, config });
      return true;
    }

    const responses = deps.responsesRuntime || getResponsesRuntime(deps);
    const runtime = deps.openaiRuntime || createOpenAIRuntime({
      ...deps,
      cancelPersistence: responses.store,
    });
    if (route.operation === 'openai.responses') {
      const body = await readBody(req);
      await responses.create({ req, res, body, config });
      return true;
    }
    if (route.operation === 'openai.response') {
      sendJson(res, 200, await responses.retrieve({
        id: decodeURIComponent(pathname.slice('/v1/responses/'.length)),
        config,
      }));
      return true;
    }
    if (route.operation === 'openai.chat') {
      const body = await readBody(req);
      await runtime.chat({ req, res, body, config });
      return true;
    }
    if (route.operation === 'openai.models') {
      await runtime.models({ req, res, config });
      return true;
    }
    if (route.operation === 'openai.model') {
      await runtime.model({
        req,
        res,
        config,
        id: pathname.slice('/v1/models/'.length),
      });
      return true;
    }

    throw new ApiError(501, 'API route is not implemented yet', {
      type: 'api_error',
      code: 'not_implemented',
    });
  } catch (error) {
    sendApiError(
      res,
      error instanceof ApiError
        ? error
        : new ApiError(500, 'internal error', { type: 'api_error', code: 'internal_error' }),
      protocol,
    );
    return true;
  }
}

const responsesRuntimes = new WeakMap();
function sharedCancelStore(deps) {
  return deps.cancelPersistence || sharedResponsesRuntime(deps).store;
}

function sharedResponsesRuntime(deps) {
  if (deps.responsesRuntime) return deps.responsesRuntime;
  return getResponsesRuntime(deps);
}

function getResponsesRuntime(deps) {
  if (!responsesRuntimes.has(deps)) responsesRuntimes.set(deps, createResponsesRuntime(deps));
  return responsesRuntimes.get(deps);
}

export function createApiAuthCheck(deps = {}) {
  return function check(req) {
    const config = getApiSettings();
    if (!config.enabled) return { ok: false, status: 404, code: 'api_disabled', message: 'API compatibility is disabled' };
    if (!config.openai) return { ok: false, status: 404, code: 'protocol_disabled', message: 'OpenAI protocol is disabled' };
    if (clientKeyRequired(req, config) && !verifyApiKey(readClientKey(req))) {
      return { ok: false, status: 401, code: 'invalid_api_key', message: 'invalid API key' };
    }
    return { ok: true, config, responses: getResponsesRuntime(deps) };
  };
}

function connectionProbeResult(protocol, startedAt, result = {}, error = null) {
  const account = result?.account || error?.account || null;
  return {
    ok: Boolean(result?.ok) && !error,
    protocol,
    account,
    durationMs: Math.max(0, Number(result?.durationMs) || Date.now() - startedAt),
    code: error?.code || result?.code || (error ? 'INTERNAL_ERROR' : 'OK'),
  };
}

/** Run a minimal protocol probe through the same direct upstream runtime.
 * The caller only receives an operational summary; prompts and credentials
 * stay inside this function. */
export async function probeApiConnection({ protocol, config, runtime, now = Date.now }) {
  const startedAt = now();
  try {
    const result = await runtime.chat({
      body: { prompt: 'Reply with exactly: ok', stream: false },
      config,
    });
    return connectionProbeResult(protocol, startedAt, result);
  } catch (error) {
    return connectionProbeResult(protocol, startedAt, {},
      Object.assign({}, error, {
        code: error?.code || 'UPSTREAM_ERROR',
        account: error?.account || null,
      }));
  }
}

export async function handleApiSettingsApi(req, res, url) {
  const pathname = url.pathname;
  try {
    if (pathname === '/api/api-compat') {
      if (req.method === 'GET') {
        sendJson(res, 200, publicApiSettings());
        return true;
      }
      if (req.method === 'PATCH') {
        updateApiSettings(await readBody(req));
        sendJson(res, 200, publicApiSettings());
        return true;
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return true;
    }

    if (pathname === '/api/api-compat/test') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return true;
      }
      const body = await readBody(req);
      if (!['openai', 'anthropic'].includes(body.protocol)) {
        sendJson(res, 400, { ok: false, error: 'protocol must be openai or anthropic' });
        return true;
      }
      const config = getApiSettings();
      const result = await probeApiConnection({
        protocol: body.protocol,
        config,
        runtime: {
          async chat({ body: probeBody, config: probeConfig }) {
            const pool = pickAccount();
            if (!pool.name) {
              const error = new ApiError(503, 'no usable account', { code: 'POOL_EMPTY' });
              error.account = null;
              throw error;
            }
            const credentials = readAccountCredentials(pool.name);
            if (!credentials?.ok) {
              const error = new ApiError(401, 'no usable credentials', { code: 'AUTH_REQUIRED' });
              error.account = pool.name;
              throw error;
            }
            const started = Date.now();
            const chat = await createUpstreamClient();
            const response = await chat.chat({
              accountId: pool.name,
              credentials,
              model: probeConfig.defaultModel,
              body: {
                messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
                stream: true,
              },
              sanitize: probeConfig.channelSanitize,
            });
            if (!response.ok) {
              const error = new ApiError(
                response.status === 429 ? 429 : 502,
                `upstream HTTP ${response.status}`,
                { code: response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR' },
              );
              error.account = pool.name;
              throw error;
            }
            const text = await response.text();
            return {
              ok: text.includes('data:') || text.length > 0,
              account: pool.name,
              durationMs: Date.now() - started,
              code: 'OK',
            };
          },
        },
      });
      sendJson(res, 200, result);
      return true;
    }

    if (pathname === '/api/api-compat/keys') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return true;
      }
      const body = await readBody(req);
      sendJson(res, 200, { ok: true, ...createApiKey(body.name) });
      return true;
    }

    if (pathname === '/api/api-compat/keys/reset') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return true;
      }
      const body = await readBody(req);
      sendJson(res, 200, { ok: true, ...resetApiKey(body.name) });
      return true;
    }

    const keyMatch = pathname.match(/^\/api\/api-compat\/keys\/([^/]+)$/);
    if (keyMatch) {
      if (req.method !== 'DELETE') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' });
        return true;
      }
      const deleted = deleteApiKey(decodeURIComponent(keyMatch[1]));
      sendJson(res, 200, { ok: true, deleted });
      return true;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
    return true;
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
    return true;
  }
}
