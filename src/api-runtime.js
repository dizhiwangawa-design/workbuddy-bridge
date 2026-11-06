import { randomUUID } from 'node:crypto';
import {
  anthropicToOpenAI,
  conservativeTokenEstimate,
  createAnthropicEncoder,
  normalizeAnthropicRequest,
} from './protocols/anthropic.js';
import {
  arbitrateToolCalls,
  createStructuredToolAssembler,
} from './protocols/normalize.js';
import { createDsmlScanner } from './tool-calls.js';
import { createSseParser, encodeSseEvent } from './sse.js';
import { ApiError, sendApiError } from './api-errors.js';
import { readAccountCredentials, saveRefreshedCredentials } from './auth-store.js';
import {
  beginTask,
  endTask,
  loadPool,
  pickAccount,
} from './pool.js';
import { createUpstreamClient } from './upstream-client.js';
import { debug, warn } from './log.js';

const ANTHROPIC_ESTIMATOR = 'wb-conservative-v1';
const PING_INTERVAL_MS = 15000;

class RuntimeFailure extends Error {
  constructor(message, {
    status = 502,
    type = 'api_error',
    code = 'upstream_error',
    retryable = false,
    usage = null,
  } = {}) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.retryable = retryable;
    this.usage = usage;
  }
}

class TimeoutFailure extends RuntimeFailure {
  constructor(kind, message) {
    super(message, {
      status: 504,
      type: 'api_error',
      code: `${kind}_timeout`,
      retryable: false,
    });
    this.timeoutKind = kind;
  }
}

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendSseEvents(res, events) {
  if (res.writableEnded || res.destroyed) return;
  for (const event of events) {
    res.write(encodeSseEvent(event.type, event.data));
  }
}

function mapStopReason(finishReason, hasTools) {
  if (hasTools) return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'refusal' || finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function textDelta(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item?.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
}

function usageFromChunk(chunk, usage) {
  const source = chunk?.usage || chunk?.message?.usage;
  if (!source) return usage;
  return {
    inputTokens: Number(source.prompt_tokens ?? source.input_tokens ?? usage.inputTokens ?? 0),
    outputTokens: Number(source.completion_tokens ?? source.output_tokens ?? usage.outputTokens ?? 0),
  };
}

function upstreamError(status, detail = '') {
  if (detail) debug(`WorkBuddy upstream HTTP ${status}: ${String(detail).slice(0, 500)}`);
  if (status === 401) {
    return new RuntimeFailure('WorkBuddy account authorization failed', {
      status: 401,
      type: 'authentication_error',
      code: 'AUTH_REQUIRED',
      retryable: true,
    });
  }
  if (status === 429) {
    return new RuntimeFailure('WorkBuddy upstream rate limit or quota exceeded (429)', {
      status: 429,
      type: 'rate_limit_error',
      code: 'RATE_LIMITED',
      retryable: true,
    });
  }
  if (status >= 500) {
    return new RuntimeFailure(`WorkBuddy upstream HTTP ${status}`, {
      status: 502,
      type: 'api_error',
      code: 'UPSTREAM_ERROR',
      retryable: true,
    });
  }
  return new RuntimeFailure(`WorkBuddy upstream HTTP ${status}`, {
    status: status === 400 ? 400 : 502,
    type: status === 400 ? 'invalid_request_error' : 'api_error',
    code: 'UPSTREAM_ERROR',
    retryable: false,
  });
}

async function upstreamErrorDetail(response) {
  try {
    const raw = await response.text();
    if (!raw || raw.length > 16 * 1024) return '';
    try {
      const document = JSON.parse(raw);
      const value = document?.error?.message
        || document?.msg
        || document?.message
        || document?.error?.code
        || document?.code
        || document?.displayMsg?.zh;
      return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
    } catch {
      return '';
    }
  } catch {
    return '';
  }
}

function anthropicErrorBody(error) {
  return {
    type: 'error',
    error: {
      type: error.type || 'api_error',
      message: error.message || 'internal error',
    },
  };
}

function streamHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

function normalizeBody(body, config) {
  const candidate = {
    ...body,
    model: body?.model || config.defaultModel,
  };
  const converted = anthropicToOpenAI(candidate);
  for (const warning of converted.warnings) {
    warn(
      `Anthropic request warning: ${warning.code}`
      + (Number.isInteger(warning.messageIndex)
        ? ` at messages[${warning.messageIndex}]`
        : ''),
    );
  }
  if (converted.normalized.tools.length && !config.tools) {
    throw new ApiError(400, 'tool support is disabled', {
      code: 'tools_disabled',
    });
  }
  return {
    ...converted,
    requestBody: candidate,
    stream: body?.stream === true,
  };
}

export function estimateAnthropicInputTokens(body) {
  return conservativeTokenEstimate(body);
}

export function createAnthropicRuntime({
  upstreamClient = createUpstreamClient(),
  readCredentials = readAccountCredentials,
  saveCredentials = saveRefreshedCredentials,
  pick = pickAccount,
  begin = beginTask,
  end = endTask,
  poolLoader = loadPool,
  now = Date.now,
} = {}) {
  async function executeAttempt({
    req,
    res,
    body,
    config,
    stream,
    account,
  }) {
    const requestId = `msg_${randomUUID()}`;
    const inputEstimate = estimateAnthropicInputTokens(body);
    const controller = new AbortController();
    let reader = null;
    let readerDone = false;
    let timeoutKind = null;
    let firstByteTimer = null;
    let idleTimer = null;
    let totalTimer = null;
    let graceTimer = null;
    let pingTimer = null;
    let downstreamStarted = false;
    let responseEnded = false;
    let visibleText = '';
    let dsmlCalls = [];
    let structured;
    let scanner;
    let encoder;
    let usage = { inputTokens: inputEstimate, outputTokens: 0 };
    let finishReason = null;
    let sawDone = false;
    let leaseResult = {
      ok: false,
      code: 'ABORTED',
      error: 'client disconnected',
      durationMs: 0,
    };
    const startedAt = now();
    const pendingWrites = [];

    function write(events) {
      if (!stream || !events.length || responseEnded) return;
      sendSseEvents(res, events);
    }

    function ensureStarted() {
      if (downstreamStarted) return;
      downstreamStarted = true;
      if (!stream) return;
      res.writeHead(200, streamHeaders());
      encoder = createAnthropicEncoder({
        id: requestId,
        model: body.model,
        inputTokens: inputEstimate,
      });
      write(encoder.start());
      pingTimer = setInterval(() => write(encoder.ping()), PING_INTERVAL_MS);
      pingTimer.unref?.();
    }

    function stopTimers() {
      clearTimeout(firstByteTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearTimeout(graceTimer);
      clearInterval(pingTimer);
    }

    function terminate(kind, error) {
      if (timeoutKind) return;
      timeoutKind = kind;
      const reason = error || new TimeoutFailure(
        kind,
        kind === 'first_byte'
          ? 'upstream first byte timed out'
          : kind === 'idle'
            ? 'upstream stream became idle'
            : kind === 'total'
              ? 'upstream request exceeded the total timeout'
              : 'upstream finish grace expired',
      );
      if (reader) pendingWrites.push(Promise.resolve(reader.cancel(reason)).catch(() => {}));
      controller.abort(reason);
    }

    function resetIdle() {
      clearTimeout(idleTimer);
      if (!config.idleTimeoutMs) return;
      idleTimer = setTimeout(() => terminate(
        'idle',
        new TimeoutFailure('idle', 'upstream stream became idle'),
      ), config.idleTimeoutMs);
      idleTimer.unref?.();
    }

    function armFirstByte() {
      clearTimeout(firstByteTimer);
      if (!config.firstByteTimeoutMs) return;
      firstByteTimer = setTimeout(() => terminate(
        'first_byte',
        new TimeoutFailure('first_byte', 'upstream first byte timed out'),
      ), config.firstByteTimeoutMs);
      firstByteTimer.unref?.();
    }

    function armTotal() {
      if (!config.totalTimeoutMs) return;
      totalTimer = setTimeout(() => terminate(
        'total',
        new TimeoutFailure('total', 'upstream request exceeded the total timeout'),
      ), config.totalTimeoutMs);
      totalTimer.unref?.();
    }

    function armFinishGrace() {
      if (graceTimer || !config.finishGraceMs) return;
      graceTimer = setTimeout(() => terminate('finish_grace'), config.finishGraceMs);
      graceTimer.unref?.();
    }

    function onClientDisconnect() {
      if (!res.writableEnded) {
        terminate('client', new RuntimeFailure('client disconnected', {
          code: 'ABORTED',
          retryable: false,
        }));
      }
    }

    function onAborted() {
      onClientDisconnect();
    }

    req.once('aborted', onAborted);
    res.once('close', onClientDisconnect);

    function throwScannerError(error) {
      throw new RuntimeFailure(`DSML normalization failed: ${error.message}`, {
        status: 502,
        type: 'api_error',
        code: error.code,
      });
    }

    function feedContent(content) {
      const text = textDelta(content);
      if (!text) return;
      ensureStarted();
      const scanned = scanner.push(text);
      if (scanned.error) throwScannerError(scanned.error);
      if (scanned.calls.length) dsmlCalls.push(...scanned.calls);
      if (scanned.visibleText && stream) {
        visibleText += scanned.visibleText;
        write(encoder.textDelta(scanned.visibleText));
      } else if (scanned.visibleText) {
        visibleText += scanned.visibleText;
      }
    }

    function processDocument(document) {
      if (!document || typeof document !== 'object') {
        throw new RuntimeFailure('upstream returned an invalid SSE JSON document', {
          code: 'UPSTREAM_PROTOCOL_ERROR',
        });
      }
      if (document.error) {
        const message = String(document.error.message || 'WorkBuddy upstream error').slice(0, 300);
        throw new RuntimeFailure(message, {
          status: 502,
          type: 'api_error',
          code: 'UPSTREAM_ERROR',
          retryable: false,
        });
      }

      usage = usageFromChunk(document, usage);
      const choice = Array.isArray(document.choices) ? document.choices[0] : null;
      if (choice) {
        const delta = choice.delta || {};
        const messageTools = choice.message?.tool_calls;
        if (Array.isArray(messageTools)) structured.push(messageTools);
        if (Array.isArray(delta.tool_calls)) structured.push(delta.tool_calls);
        if (delta.content !== undefined) feedContent(delta.content);
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          armFinishGrace();
        }
      } else if (document.choices === undefined && document.data?.error) {
        throw new RuntimeFailure('WorkBuddy upstream returned an error', {
          code: 'UPSTREAM_ERROR',
        });
      }
    }

    function processSseEvents(events) {
      for (const item of events) {
        const data = item.data;
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        if (typeof data === 'string') {
          try {
            processDocument(JSON.parse(data));
          } catch (error) {
            if (error instanceof RuntimeFailure) throw error;
            throw new RuntimeFailure('upstream returned malformed SSE JSON', {
              code: 'UPSTREAM_PROTOCOL_ERROR',
            });
          }
        } else {
          processDocument(data);
        }
      }
    }

    async function refreshCredentials(credentials) {
      if (!credentials.refreshToken) return credentials;
      try {
        const refreshed = await upstreamClient.refresh(credentials);
        return saveCredentials(credentials, refreshed, { now: now() });
      } catch (error) {
        debug(`credential refresh failed: ${error.message}`);
        return credentials;
      }
    }

    async function requestUpstream(credentials) {
      return upstreamClient.chat({
        accountId: account,
        credentials,
        model: body.normalized.model || body.requestBody.model,
        body: body.body,
        sanitize: config.channelSanitize,
        signal: controller.signal,
      });
    }

    try {
      structured = createStructuredToolAssembler();
      scanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
      let credentials = readCredentials(account, { now: now() });
      if (!credentials?.ok) {
        throw new RuntimeFailure('WorkBuddy account has no usable credentials', {
          status: 401,
          type: 'authentication_error',
          code: 'AUTH_REQUIRED',
          retryable: true,
        });
      }
      if (credentials.needsRefresh) credentials = await refreshCredentials(credentials);

      armTotal();
      armFirstByte();
      let response = await requestUpstream(credentials);
      if (response.status === 401 && credentials.refreshToken) {
        credentials = await refreshCredentials(credentials);
        response = await requestUpstream(credentials);
      }
      if (!response.ok) {
        throw upstreamError(response.status, await upstreamErrorDetail(response));
      }
      if (!response.body) throw new RuntimeFailure('upstream response has no body');

      reader = response.body.getReader();
      resetIdle();
      const parser = createSseParser();
      let cleanEof = false;
      while (!sawDone) {
        const read = await reader.read();
        if (read.done) {
          readerDone = true;
          cleanEof = true;
          processSseEvents(parser.finished());
          break;
        }
        clearTimeout(firstByteTimer);
        resetIdle();
        processSseEvents(parser.feed(read.value));
      }

      if (timeoutKind && timeoutKind !== 'finish_grace') {
        throw controller.signal.reason instanceof RuntimeFailure
          ? controller.signal.reason
          : new TimeoutFailure(timeoutKind, `upstream ${timeoutKind} timeout`);
      }
      if (timeoutKind === 'client') {
        throw new RuntimeFailure('client disconnected', {
          code: 'ABORTED',
          retryable: false,
        });
      }

      const scannedEnd = scanner.finish();
      if (scannedEnd.error) throwScannerError(scannedEnd.error);
      if (scannedEnd.calls.length) dsmlCalls.push(...scannedEnd.calls);
      if (scannedEnd.visibleText) {
        if (!downstreamStarted) ensureStarted();
        visibleText += scannedEnd.visibleText;
        if (stream) write(encoder.textDelta(scannedEnd.visibleText));
      }
      const structuredEnd = structured.finish();
      if (
        structuredEnd.invalid.length > 0
        && (structuredEnd.calls.length > 0 || dsmlCalls.length === 0)
      ) {
        throw new RuntimeFailure('upstream produced an invalid structured tool call', {
          code: 'UPSTREAM_INVALID_TOOL_CALL',
        });
      }
      if (
        !finishReason
        && !sawDone
        && structuredEnd.invalid.length
        && dsmlCalls.length === 0
      ) {
        throw new RuntimeFailure('upstream ended with an incomplete tool call', {
          code: 'UPSTREAM_TRUNCATED_TOOL_CALL',
        });
      }
      const arbitration = arbitrateToolCalls({
        structured: structuredEnd,
        dsml: dsmlCalls,
        toolsDeclared: body.normalized.tools.length > 0,
        toolChoice: body.normalized.toolChoice || 'auto',
        model: body.requestBody.model,
        requestId,
        account,
        allowedToolNames: body.normalized.toolNames,
      });
      if (arbitration.warning) warn(`duplicate tool formats: ${JSON.stringify(arbitration.warning)}`);
      ensureStarted();

      const outputTokens = usage.outputTokens
        || conservativeTokenEstimate({
          text: visibleText,
          tools: arbitration.calls.map((call) => call.input),
        });
      const stopReason = mapStopReason(finishReason, arbitration.calls.length > 0);
      if (stream) {
        write(encoder.finalize({
          calls: arbitration.calls,
          finishReason,
          outputTokens: Math.max(0, outputTokens),
        }));
        if (!responseEnded) {
          responseEnded = true;
          res.end();
        }
      } else {
        const content = [];
        if (visibleText) content.push({ type: 'text', text: visibleText });
        for (const call of arbitration.calls) {
          content.push({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          });
        }
        sendJson(res, 200, {
          id: requestId,
          type: 'message',
          role: 'assistant',
          model: body.requestBody.model,
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: usage.inputTokens || inputEstimate,
            output_tokens: Math.max(0, outputTokens),
          },
        });
        responseEnded = true;
      }

      leaseResult = {
        ok: true,
        code: 'OK',
        durationMs: now() - startedAt,
        meta: {
          model: body.requestBody.model,
          usage: {
            input_tokens: usage.inputTokens || inputEstimate,
            output_tokens: Math.max(0, outputTokens),
          },
        },
      };
      return { ok: true };
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure(error.message || 'internal error', {
            code: 'INTERNAL_ERROR',
          });
      leaseResult = {
        ok: false,
        code: failure.code,
        error: `${failure.message} ${failure.code}`,
        durationMs: now() - startedAt,
        meta: { model: body.requestBody.model, usage: {} },
      };
      if (downstreamStarted && stream) {
        if (!responseEnded) {
          write(encoder.error({ type: failure.type || 'api_error', message: failure.message }));
          responseEnded = true;
          res.end();
        }
        return { ok: false, started: true, error: failure };
      }
      return { ok: false, started: false, error: failure };
    } finally {
      stopTimers();
      req.off('aborted', onAborted);
      res.off('close', onClientDisconnect);
      if (reader && !readerDone) {
        try {
          await reader.cancel(controller.signal.reason || 'request finished');
        } catch {
          // Best effort.
        }
      }
      await Promise.allSettled(pendingWrites);
      end(account, leaseResult);
    }
  }

  async function messages({ req, res, body, config }) {
    const normalized = normalizeBody(body, config);
    const pool = poolLoader();
    const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
    const tried = [];
    let lastFailure = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pick({ exclude: tried });
      if (!picked.name) {
        if (!tried.length) {
          throw new ApiError(503, `号池里没有可用账号（${picked.reason}）`, {
            type: 'overloaded_error',
            code: 'POOL_EMPTY',
          });
        }
        break;
      }
      tried.push(picked.name);
      debug(`anthropic api → ${picked.name}（第 ${attempt + 1} 次）`);
      begin(picked.name);
      const result = await executeAttempt({
        req,
        res,
        body: normalized,
        config,
        stream: normalized.stream,
        account: picked.name,
      });
      if (result.ok || result.started) return result;
      lastFailure = result.error;
      if (!result.error?.retryable) break;
    }

    const failure = lastFailure || new RuntimeFailure('all account attempts failed');
    if (!res.headersSent && !res.writableEnded) sendApiError(res, failure, 'anthropic');
    return { ok: false, started: false, error: failure };
  }

  function countTokens({ res, body }) {
    normalizeAnthropicRequest(body);
    const inputTokens = estimateAnthropicInputTokens(body);
    sendJson(res, 200, {
      input_tokens: inputTokens,
      estimated: true,
      estimator: ANTHROPIC_ESTIMATOR,
    }, {
      'x-wb-token-estimate': ANTHROPIC_ESTIMATOR,
    });
    return inputTokens;
  }

  return {
    messages,
    countTokens,
  };
}
