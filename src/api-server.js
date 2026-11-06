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
import { createAnthropicRuntime } from './api-runtime.js';

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

    if (clientKeyRequired(req.socket || req, config) && !verifyApiKey(readClientKey(req))) {
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
      const runtime = deps.runtime || createAnthropicRuntime(deps);
      runtime.countTokens({ res, body, config });
      return true;
    }

    if (route.operation === 'anthropic.messages') {
      const body = await readBody(req);
      const runtime = deps.runtime || createAnthropicRuntime(deps);
      await runtime.messages({ req, res, body, config });
      return true;
    }

    sendApiError(res, new ApiError(501, 'API route is not implemented yet', {
      type: 'api_error',
      code: 'not_implemented',
    }), protocol);
    return true;
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
