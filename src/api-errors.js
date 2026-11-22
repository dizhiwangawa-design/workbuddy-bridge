export class ApiError extends Error {
  constructor(status, message, {
    type = 'invalid_request_error',
    code = '',
    retryable = false,
  } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.retryable = retryable;
  }
}

export function badRequest(message) {
  return new ApiError(400, message);
}

/**
 * 把「什么时候能再来」透给客户端。
 *
 * 只在一个号可用时才有意义：那时代理层换号等于原地重试，除了把限流放大没有别的
 * 作用。客户端拿到 Retry-After 至少可以自己等，而不是反复重试再被拒。秒数向上取整，
 * 不足 1 秒按 1 秒给 —— 0 是合法值但读起来像「立刻可重试」。
 */
export function retryAfterHeaders(error, now = Date.now()) {
  const resetAt = Number(error?.resetAt || 0);
  if (!(resetAt > now)) return {};
  return { 'retry-after': String(Math.max(1, Math.ceil((resetAt - now) / 1000))) };
}

export function sendApiError(res, error, protocol = 'openai') {
  const rawStatus = Number(error.status || 500);
  const status = rawStatus >= 100 && rawStatus <= 599 ? rawStatus : 500;
  const body = protocol === 'anthropic'
    ? {
        type: 'error',
        error: {
          type: error.type || 'api_error',
          message: error.message || 'internal error',
        },
      }
    : {
        error: {
          type: error.type || 'invalid_request_error',
          message: error.message || 'internal error',
          code: error.code || null,
        },
      };
  if (!res || res.destroyed || res.writableEnded) return false;
  if (res.headersSent) {
    try {
      res.end();
    } catch {
      // A transport reset may race the error path. The request is already
      // terminated and must not reach the process-level error handler.
    }
    return false;
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...retryAfterHeaders(error),
    });
    res.end(JSON.stringify(body));
    return true;
  } catch {
    try {
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch {
      // The peer won the teardown race.
    }
    return false;
  }
}
