export class ApiError extends Error {
  constructor(status, message, { type = 'invalid_request_error', code = '' } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}
