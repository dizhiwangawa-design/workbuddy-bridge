import {
  createApiKey,
  deleteApiKey,
  publicApiSettings,
  updateApiSettings,
  getApiSettings,
  verifyApiKey,
} from './api-settings.js';
import { ApiError, sendApiError } from './api-errors.js';

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function readClientKey(req) {
  const authorization = String(req.headers.authorization || '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || String(req.headers['x-api-key'] || '').trim();
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

export async function handleApiRequest({ req, res, url }) {
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

    if (config.requireApiKey && !verifyApiKey(readClientKey(req))) {
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
