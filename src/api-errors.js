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
