import { randomUUID } from 'node:crypto';
import {
  anthropicToOpenAI,
  conservativeTokenEstimate,
  createAnthropicEncoder,
  normalizeAnthropicRequest,
} from './protocols/anthropic.js';
import {
  mapModelCatalogue,
  prepareOpenAIRequest,
  toOpenAIResponse,
} from './protocols/openai.js';
import {
  arbitrateToolCalls,
  createStructuredToolAssembler,
} from './protocols/normalize.js';
import {
  createDsmlScanner,
  structuredToolArgumentLimit,
} from './tool-calls.js';
import { createSseParser, encodeSseEvent } from './sse.js';
import { ApiError, sendApiError } from './api-errors.js';
import {
  readAccountCredentials,
  refreshAccountCredentials,
} from './auth-store.js';
import {
  beginTask,
  endTask,
  loadPool,
  pickAccount,
} from './pool.js';
import { createUpstreamClient } from './upstream-client.js';
import { debug, warn } from './log.js';
import {
  HARD_WRITE_BYTES,
  PRODUCTION_KEEPALIVE_MS,
  UPSTREAM_LENGTH_LIMIT,
  canWriteHttp,
  createHttpEventWriter,
  createTextCache,
  isWriteError,
  withTimeout,
} from './stream-control.js';
import { createDeadLetter, createResponsesStore } from './responses-store.js';
import { createChatEncoder } from './protocols/openai.js';

const ANTHROPIC_ESTIMATOR = 'wb-conservative-v1';
const PING_INTERVAL_MS = PRODUCTION_KEEPALIVE_MS;

/** The runtime keeps the production interval unless a test fixture explicitly replaces it. */
export function effectiveKeepaliveMs(injected) {
  return injected === undefined || injected === null ? PING_INTERVAL_MS : Number(injected);
}

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

function clientWriteFailure(error) {
  if (error instanceof RuntimeFailure) return error;
  return new RuntimeFailure('client response write failed', {
    code: 'ABORTED',
    retryable: false,
  });
}

function createRuntimeTextCache({ hardBytes = HARD_WRITE_BYTES } = {}) {
  return createTextCache({
    // Keep the complete successful output only up to the same hard bound as
    // the socket queue. This prevents a fast reader from receiving deltas that
    // disappear from the terminal response while still bounding memory.
    maxBytes: Math.max(1, Number(hardBytes) || HARD_WRITE_BYTES),
    retain: 'error',
  });
}

function appendRuntimeText(cache, delta) {
  try {
    cache.append(delta);
  } catch (error) {
    throw new RuntimeFailure(error.message, {
      status: 502,
      type: 'api_error',
      code: error.code || 'OUTPUT_TOO_LARGE',
      retryable: false,
    });
  }
}

function structuredRuntimeFailure(error) {
  if (error instanceof RuntimeFailure) return error;
  return new RuntimeFailure(error?.message || 'structured tool arguments are invalid', {
    status: 502,
    type: 'api_error',
    code: error?.code || 'UPSTREAM_INVALID_TOOL_CALL',
    retryable: false,
  });
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

function mapStopReason(finishReason, hasTools, canceled = false) {
  if (canceled) return 'canceled';
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

const RETRY_STATUS = new Set([401, 402, 403, 429, 500, 502, 503, 504]);

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
  if (status === 402 || status === 403) {
    return new RuntimeFailure(`WorkBuddy upstream forbidden or quota exhausted (${status})`, {
      status,
      type: status === 402 ? 'insufficient_quota' : 'permission_error',
      code: 'RATE_LIMITED',
      retryable: true,
    });
  }
  if (status >= 500 || RETRY_STATUS.has(status)) {
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
  if (body?.stream === true && config.streaming === false) {
    throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
  }
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
  pick = pickAccount,
  begin = beginTask,
  end = endTask,
  poolLoader = loadPool,
  now = Date.now,
  keepaliveMs: injectedKeepaliveMs,
  softBytes,
  hardBytes,
  cancelPersistence = createResponsesStore({ now }),
} = {}) {
  const keepaliveMs = effectiveKeepaliveMs(injectedKeepaliveMs);
  async function executeAttempt({
    req,
    res,
    body,
    config,
    stream,
    account,
    interruptSignal = null,
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
    let cancelKind = null;
    let cancelReason = null;
    let cancelPersisted = false;
    let cancelPersistenceResult = null;
    let cancelPromise = null;
    let leaseReleased = false;
    const visibleText = createRuntimeTextCache({ hardBytes });
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
    const writer = stream
      ? createHttpEventWriter(res, {
          protocol: 'anthropic',
          softBytes,
          hardBytes,
          onOverflow: (error) => terminate('backpressure', error),
          onWriteFailure: (error) => {
            if (!responseEnded) terminate('client', clientWriteFailure(error));
          },
        })
      : null;

    function releaseLease(result) {
      if (leaseReleased) return;
      leaseReleased = true;
      end(account, result);
    }

    function write(events) {
      if (!stream || !events.length || responseEnded) return false;
      return writer.writeEvents(events);
    }

    function ensureStarted({ allowCanceled = false } = {}) {
      if (downstreamStarted) return;
      if (!stream || responseEnded || (cancelKind && !allowCanceled)) return;
      if (!canWriteHttp(res)) {
        terminate('client', clientWriteFailure());
        return;
      }
      try {
        res.writeHead(200, streamHeaders());
        res.flushHeaders?.();
      } catch (error) {
        terminate('client', clientWriteFailure(error));
        return;
      }
      downstreamStarted = true;
      encoder = createAnthropicEncoder({
        id: requestId,
        model: body.model,
        inputTokens: inputEstimate,
      });
      write(encoder.start());
      if (writer?.failed || writer?.ended || cancelKind) return;
      pingTimer = setInterval(() => write(encoder.ping()), keepaliveMs);
      pingTimer.unref?.();
    }

    function closeWriter(error = null) {
      if (!writer) return true;
      if (writer.failed) {
        writer.fail(error || writer.failed);
        return false;
      }
      if (writer.ended) return true;
      if (!writer.end()) {
        writer.fail(error || clientWriteFailure());
        return false;
      }
      return true;
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
      if (['interrupt', 'client', 'backpressure'].includes(kind)) cancelKind = kind;
      if (kind === 'client' && !cancelReason) cancelReason = 'network_disconnect';
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
      if (reader && !readerDone) {
        readerDone = true;
        pendingWrites.push(Promise.resolve(reader.cancel(reason)).catch(() => {}));
      }
      controller.abort(reason);
      if (['interrupt', 'client', 'backpressure'].includes(kind)) {
        releaseLease({
          ok: false,
          code: kind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'CANCELED',
          error: kind,
          durationMs: now() - startedAt,
          meta: { model: body.requestBody.model, usage: {} },
        });
      }
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
      if (responseEnded || cancelKind) {
        return;
      }
      cancelKind = 'network_disconnect';
      cancelReason = 'network_disconnect';
      const reason = new RuntimeFailure('client disconnected', {
        code: 'ABORTED',
        retryable: false,
      });
      terminate('client', reason);
    }

    function onAborted() {
      onClientDisconnect();
    }

    function onInterrupt() {
      if (!responseEnded) {
        terminate('interrupt', new RuntimeFailure('client requested cancellation', {
          code: 'CANCELED',
          retryable: false,
        }));
      }
    }

    req.once('aborted', onAborted);
    res.on('close', onClientDisconnect);
    interruptSignal?.addEventListener('abort', onInterrupt, { once: true });

    function throwScannerError(error) {
      throw new RuntimeFailure(`DSML normalization failed: ${error.message}`, {
        status: 502,
        type: 'api_error',
        code: error.code,
      });
    }

    function pushStructured(deltas) {
      try {
        structured.push(deltas);
      } catch (error) {
        throw structuredRuntimeFailure(error);
      }
    }

    function feedContent(content) {
      const text = textDelta(content);
      if (!text) return;
      ensureStarted();
      const scanned = scanner.push(text);
      if (scanned.error) throwScannerError(scanned.error);
      if (scanned.calls.length) dsmlCalls.push(...scanned.calls);
      if (scanned.visibleText && stream) {
        appendRuntimeText(visibleText, scanned.visibleText);
        write(encoder.textDelta(scanned.visibleText));
      } else if (scanned.visibleText) {
        appendRuntimeText(visibleText, scanned.visibleText);
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
        if (Array.isArray(messageTools)) pushStructured(messageTools);
        if (Array.isArray(delta.tool_calls)) pushStructured(delta.tool_calls);
        if (delta.content !== undefined) feedContent(delta.content);
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          armFinishGrace();
        }
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
        const refreshed = await refreshAccountCredentials(account, upstreamClient, {
          now: now(),
          refreshSkewMs: 0,
        });
        if (refreshed?.ok) return refreshed;
        debug(`credential refresh failed: ${refreshed?.reason || 'unknown error'}`);
        return credentials;
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
      structured = createStructuredToolAssembler({
        maxBytes: structuredToolArgumentLimit(
          config.dsmlMaxBufferBytes,
          hardBytes || HARD_WRITE_BYTES,
        ),
      });
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
        if (!cancelKind) processSseEvents(parser.finished());
          break;
        }
      if (cancelKind) break;
        clearTimeout(firstByteTimer);
        resetIdle();
        processSseEvents(parser.feed(read.value));
      }
      if (cancelKind) {
        ensureStarted({ allowCanceled: true });
        const persisted = await cancelPersistence.save({
          id: requestId,
          createdAt: startedAt,
          status: 'incomplete',
          body: {
            id: requestId,
            status: 'incomplete',
            incomplete_details: { reason: 'canceled' },
            output: visibleText.value() ? [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: visibleText.value() }],
            }] : [],
          },
          partial: { content: visibleText.value() },
        }, {
          cancelInfo: { reason: cancelKind, phase: 'generation' },
          partial: { content: visibleText.value() },
        });
        cancelPersisted = true;
        cancelPersistenceResult = persisted;
        if (!persisted.ok) debug(`cancel fragment not durable (${persisted.error?.message || 'storage error'})`);
        if (persisted.ok) {
          ensureStarted({ allowCanceled: true });
          if (encoder && writer && !writer.failed) {
            writer.writeComment('bridge-anthropic-canceled');
            write(encoder.cancel({
              outputTokens: conservativeTokenEstimate(visibleText.value()),
            }));
          }
        } else if (!persisted.ok) {
          writer?.fail(persisted.error);
        }
        responseEnded = true;
        closeWriter(cancelKind === 'backpressure' ? controller.signal.reason : null);
        leaseResult = {
          ok: false,
          code: cancelKind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'ABORTED',
          error: cancelKind,
          durationMs: now() - startedAt,
          meta: { model: body.requestBody.model, usage: {} },
        };
        return {
          ok: false,
          started: true,
          canceled: true,
          kind: cancelKind,
          persistence: persisted,
        };
      }

      if (timeoutKind && timeoutKind !== 'finish_grace') {
        throw controller.signal.reason instanceof RuntimeFailure
          ? controller.signal.reason
          : new TimeoutFailure(timeoutKind, `upstream ${timeoutKind} timeout`);
      }

      const scannedEnd = scanner.finish();
      if (scannedEnd.error) throwScannerError(scannedEnd.error);
      if (scannedEnd.calls.length) dsmlCalls.push(...scannedEnd.calls);
      if (scannedEnd.visibleText) {
        if (!downstreamStarted) ensureStarted();
        appendRuntimeText(visibleText, scannedEnd.visibleText);
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
          text: visibleText.value(),
          tools: arbitration.calls.map((call) => call.input),
        });
      const stopReason = mapStopReason(finishReason, arbitration.calls.length > 0);
      const responseBody = {
        id: requestId,
        type: 'message',
        role: 'assistant',
        model: body.requestBody.model,
        content: [],
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens || inputEstimate,
          output_tokens: Math.max(0, outputTokens),
        },
      };
      if (visibleText.value()) {
        responseBody.content.push({ type: 'text', text: visibleText.value() });
      }
      for (const call of arbitration.calls) {
        responseBody.content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        });
      }
      if (stream) {
        write(encoder.finalize({
          calls: arbitration.calls,
          finishReason,
          outputTokens: Math.max(0, outputTokens),
        }));
        if (!cancelKind && !writer?.failed && writer?.ended) {
          terminate('client', clientWriteFailure());
        }
        if (cancelKind) {
          throw controller.signal.reason instanceof RuntimeFailure
            ? controller.signal.reason
            : clientWriteFailure();
        }
        if (!writer?.end()) {
          terminate('client', clientWriteFailure(writer?.failed));
          throw controller.signal.reason instanceof RuntimeFailure
            ? controller.signal.reason
            : clientWriteFailure();
        }
        responseEnded = true;
      } else {
        sendJson(res, 200, responseBody);
        responseEnded = true;
      }
      if (cancelKind) {
        throw controller.signal.reason instanceof RuntimeFailure
          ? controller.signal.reason
          : clientWriteFailure();
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
      return {
        ok: true,
        account,
        durationMs: now() - startedAt,
        responseBody,
      };
    } catch (error) {
      if (cancelKind) {
        const outputTokens = conservativeTokenEstimate(visibleText.value());
        if (stream) ensureStarted({ allowCanceled: true });
        const persisted = await cancelPersistence.save({
          id: requestId,
          createdAt: startedAt,
          status: 'incomplete',
          body: {
            id: requestId,
            status: 'incomplete',
            incomplete_details: { reason: 'canceled' },
            output: visibleText.value() ? [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: visibleText.value() }],
            }] : [],
          },
          usage: { input_tokens: inputEstimate, output_tokens: outputTokens },
          partial: { content: visibleText.value() },
        }, {
          cancelInfo: { reason: cancelReason || cancelKind, phase: 'generation' },
          partial: { content: visibleText.value() },
        });
        cancelPersisted = true;
        cancelPersistenceResult = persisted;
        if (!persisted.ok) debug(`cancel fragment not durable (${persisted.error?.message || 'storage error'})`);
        if (stream && persisted.ok) {
          ensureStarted({ allowCanceled: true });
          if (encoder && writer && !writer.failed) {
            writer.writeComment('bridge-anthropic-canceled');
            write(encoder.cancel({ outputTokens }));
          }
        } else if (stream && !persisted.ok) {
          writer?.fail(persisted.error);
        }
        if (!responseEnded) {
          responseEnded = true;
          closeWriter(cancelKind === 'backpressure' ? controller.signal.reason : null);
        }
        leaseResult = {
          ok: false,
          code: cancelKind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'ABORTED',
          error: cancelKind,
          durationMs: now() - startedAt,
          meta: { model: body.requestBody.model, usage: {} },
        };
        return {
          ok: false,
          started: true,
          canceled: true,
          kind: cancelReason || cancelKind,
          persistence: persisted,
        };
      }
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure(error.message || 'internal error', {
            code: error?.code || 'INTERNAL_ERROR',
          });
      if (error instanceof ApiError) {
        failure.status = error.status;
        failure.type = error.type;
        failure.code = error.code;
      }
      leaseResult = {
        ok: false,
        code: failure.code,
        error: `${failure.message} ${failure.code}`,
        durationMs: now() - startedAt,
        meta: { model: body.requestBody.model, usage: {} },
      };
      if (downstreamStarted && stream && failure.code !== 'ABORTED') {
        if (!responseEnded) {
          write(encoder.error({ type: failure.type || 'api_error', message: failure.message }));
          responseEnded = true;
          closeWriter(failure);
        }
        return { ok: false, started: true, error: failure };
      }
      return { ok: false, started: false, error: failure };
    } finally {
      stopTimers();
      req.off('aborted', onAborted);
      res.off('close', onClientDisconnect);
      interruptSignal?.removeEventListener?.('abort', onInterrupt);
      if (reader && !readerDone) {
        try {
          await reader.cancel(controller.signal.reason || 'request finished');
        } catch {
          // Best effort.
        }
      }
      await Promise.allSettled(pendingWrites);
      if (cancelKind && !cancelPersisted) {
        const outputTokens = conservativeTokenEstimate(visibleText.value());
        await cancelPersistence.save({
          id: requestId,
          createdAt: startedAt,
          status: 'incomplete',
          body: {
            id: requestId,
            status: 'incomplete',
            incomplete_details: { reason: 'canceled' },
          output: visibleText.value() ? [{
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: visibleText.value() }],
          }] : [],
          },
          usage: { input_tokens: inputEstimate, output_tokens: outputTokens },
          partial: { content: visibleText.value() },
        }, {
          cancelInfo: { reason: cancelReason || cancelKind, phase: 'generation' },
          partial: { content: visibleText.value() },
        });
      }
      releaseLease(leaseResult);
    }
  }

  function probeRequest() {
    return {
      headers: {},
      on() {},
      once() {},
      off() {},
    };
  }

  function probeResponse() {
    return {
      headersSent: false,
      writable: true,
      destroyed: false,
      writableEnded: false,
      writableLength: 0,
      on() {},
      off() {},
      once() {},
      writeHead(status) {
        this.headersSent = true;
        this.statusCode = status;
        return this;
      },
      flushHeaders() {},
      write() {
        return true;
      },
      end() {
        this.writableEnded = true;
        this.destroyed = true;
      },
      destroy() {
        this.destroyed = true;
      },
    };
  }

  function probeTools() {
    return [{
      name: 'probe_echo',
      description: 'Return the provided value unchanged.',
      input_schema: {
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    }];
  }

  async function probeTool(config) {
    if (!config.tools) {
      throw new ApiError(400, 'tool support is disabled', { code: 'tools_disabled' });
    }
    const startedAt = now();
    const pool = poolLoader();
    const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
    const tried = [];
    let lastFailure = null;
    const probeModel = config.defaultModel || 'deepseek-v4.1-flash';

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pick({ exclude: tried, model: probeModel });
      if (!picked.name) break;
      tried.push(picked.name);
      let first;
      try {
        const firstBody = normalizeBody({
          model: probeModel,
          max_tokens: 64,
          stream: false,
          messages: [{ role: 'user', content: 'Use the probe_echo tool with value 7.' }],
          tools: probeTools(),
          tool_choice: { type: 'tool', name: 'probe_echo' },
        }, config);
        first = await executeAttempt({
          req: probeRequest(),
          res: probeResponse(),
          body: firstBody,
          config,
          stream: false,
          account: picked.name,
        });
        if (!first.ok || !first.responseBody) {
          lastFailure = first.error || new Error('Anthropic probe returned no response');
          if (!lastFailure.retryable) break;
          continue;
        }
        // executeAttempt owns and releases the lease for each attempt. The
        // continuation is a separate billable probe request.
        const toolUse = first.responseBody.content?.find((item) => item?.type === 'tool_use');
        if (!toolUse || toolUse.name !== 'probe_echo') {
          lastFailure = new RuntimeFailure('Anthropic probe did not call the probe tool', {
            code: 'PROBE_TOOL_MISSING',
            retryable: false,
          });
          break;
        }

        const secondBody = normalizeBody({
          model: probeModel,
          max_tokens: 64,
          stream: false,
          messages: [
            { role: 'user', content: 'Use the probe_echo tool with value 7.' },
            { role: 'assistant', content: first.responseBody.content },
            {
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: '7',
              }],
            },
          ],
          tools: probeTools(),
        }, config);
        begin(picked.name);
        const second = await executeAttempt({
          req: probeRequest(),
          res: probeResponse(),
          body: secondBody,
          config,
          stream: false,
          account: picked.name,
        });
        if (!second.ok) {
          lastFailure = second.error || new Error('Anthropic probe continuation failed');
          if (!lastFailure.retryable) break;
          continue;
        }
        return {
          ok: true,
          account: picked.name,
          durationMs: now() - startedAt,
          code: 'OK',
        };
      } catch (error) {
        lastFailure = error;
        if (!error?.retryable) break;
      }
    }

    const failure = lastFailure || new ApiError(503, 'no usable account', {
      code: 'POOL_EMPTY',
    });
    failure.account = failure.account || tried.at(-1) || null;
    throw failure;
  }

  async function messages({ req, res, body, config, interruptSignal = null }) {
    const normalized = normalizeBody(body, config);
    const pool = poolLoader();
    const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
    const tried = [];
    let lastFailure = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pick({
        exclude: tried,
        model: normalized.requestBody.model,
      });
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
        interruptSignal,
      });
      if (result.ok) return result;
      if (result.started) return result;
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
    probeTool,
    cancelStore: cancelPersistence,
  };
}

function openAIUsage(source, fallbackInput = 0, fallbackOutput = 0) {
  const prompt = Number(source?.prompt_tokens ?? source?.input_tokens);
  const completion = Number(source?.completion_tokens ?? source?.output_tokens);
  const total = Number(source?.total_tokens);
  const promptTokens = Number.isFinite(prompt) ? prompt : fallbackInput;
  const completionTokens = Number.isFinite(completion) ? completion : fallbackOutput;
  return {
    prompt_tokens: Math.max(0, promptTokens),
    completion_tokens: Math.max(0, completionTokens),
    total_tokens: Number.isFinite(total)
      ? Math.max(0, total)
      : Math.max(0, promptTokens + completionTokens),
  };
}

export function createOpenAIRuntime({
  upstreamClient = createUpstreamClient(),
  readCredentials = readAccountCredentials,
  pick = pickAccount,
  begin = beginTask,
  end = endTask,
  poolLoader = loadPool,
  now = Date.now,
  keepaliveMs: injectedKeepaliveMs,
  softBytes,
  hardBytes,
  cancelPersistence = createResponsesStore({ now }),
} = {}) {
  const keepaliveMs = effectiveKeepaliveMs(injectedKeepaliveMs);

  async function executeAttempt({
    req,
    res,
    body,
    config,
    account,
    interruptSignal = null,
  }) {
    const startedAt = now();
    const inputEstimate = conservativeTokenEstimate(body.body);
    const controller = new AbortController();
    const pendingWrites = [];
    let reader = null;
    let readerDone = false;
    let firstByteTimer = null;
    let idleTimer = null;
    let totalTimer = null;
    let timeoutKind = null;
    let cancelKind = null;
    let cancelReason = null;
    let cancelPersisted = false;
    let cancelPersistenceResult = null;
    let finishReason = null;
    let upstreamId = null;
    let chatResponseId = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
    let upstreamCreated = null;
    let upstreamUsage = null;
    let sawDone = false;
    let structured = createStructuredToolAssembler({
      maxBytes: structuredToolArgumentLimit(
        config.dsmlMaxBufferBytes,
        hardBytes || HARD_WRITE_BYTES,
      ),
    });
    let dsmlCalls = [];
    const visibleText = createRuntimeTextCache({ hardBytes });
    const reasoningText = createRuntimeTextCache({ hardBytes });
    const refusalText = createRuntimeTextCache({ hardBytes });
    const scanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
    const writer = body.stream
      ? createHttpEventWriter(res, {
          protocol: 'openai',
          softBytes,
          hardBytes,
          onOverflow: (error) => terminate('backpressure', error),
          onWriteFailure: (error) => {
            if (!responseEnded) terminate('client', clientWriteFailure(error));
          },
        })
      : null;
    let encoder = null;
    let pingTimer = null;
    let responseEnded = false;
    let leaseResult = {
      ok: false,
      code: 'ABORTED',
      error: 'client disconnected',
      durationMs: 0,
    };
    let leaseReleased = false;

    function terminate(kind, error) {
      if (timeoutKind) return;
      timeoutKind = kind;
      if (['interrupt', 'client', 'backpressure'].includes(kind)) cancelKind = kind;
      if (kind === 'client' && !cancelReason) cancelReason = 'network_disconnect';
      const reason = error || new TimeoutFailure(
        kind,
        kind === 'first_byte'
          ? 'upstream first byte timed out'
          : kind === 'idle'
            ? 'upstream stream became idle'
            : 'upstream request exceeded the total timeout',
      );
      if (reader && !readerDone) {
        readerDone = true;
        pendingWrites.push(Promise.resolve(reader.cancel(reason)).catch(() => {}));
      }
      controller.abort(reason);
      req.unpipe?.(res);
      if (['interrupt', 'client', 'backpressure'].includes(kind)) {
        releaseLease({
          ok: false,
          code: kind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'CANCELED',
          error: kind,
          durationMs: now() - startedAt,
          meta: { model: body.model, usage: {} },
        });
      }
    }

    function releaseLease(result) {
      if (leaseReleased) return;
      leaseReleased = true;
      end(account, result);
    }

    function onClientDisconnect() {
      if (!cancelKind) {
        terminate('client', new RuntimeFailure('client disconnected', {
          code: 'ABORTED',
          retryable: false,
        }));
      }
    }

    function onAborted() {
      onClientDisconnect();
    }

    function onInterrupt() {
      if (!responseEnded) {
        terminate('interrupt', new RuntimeFailure('client requested cancellation', {
          code: 'CANCELED',
          retryable: false,
        }));
      }
    }

    function stopTimers() {
      clearTimeout(firstByteTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearInterval(pingTimer);
    }

    function emit(events) {
      if (!writer || responseEnded || !events?.length || writer.failed) return false;
      return writer.writeEvents(events);
    }

    function ensureStreamStarted({ allowCanceled = false } = {}) {
      if (!body.stream || encoder || responseEnded || (cancelKind && !allowCanceled)) return;
      if (!canWriteHttp(res)) {
        terminate('client', clientWriteFailure());
        return;
      }
      try {
        res.writeHead(200, streamHeaders());
        res.flushHeaders?.();
      } catch (error) {
        terminate('client', clientWriteFailure(error));
        return;
      }
      encoder = createChatEncoder({
        id: upstreamId || undefined,
        model: body.model,
        created: upstreamCreated || Math.floor(now() / 1000),
      });
      emit(encoder.start());
      if (writer?.failed || writer?.ended || cancelKind) return;
      pingTimer = setInterval(() => emit(encoder.ping()), keepaliveMs);
      pingTimer.unref?.();
    }

    function closeWriter(error = null) {
      if (!writer) return true;
      if (writer.failed) {
        writer.fail(error || writer.failed);
        return false;
      }
      if (writer.ended) return true;
      if (!writer.end()) {
        writer.fail(error || clientWriteFailure());
        return false;
      }
      return true;
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

    function scannerError(error) {
      throw new RuntimeFailure(`DSML normalization failed: ${error.message}`, {
        status: 502,
        type: 'api_error',
        code: error.code,
      });
    }

    function pushStructured(deltas) {
      try {
        structured.push(deltas);
      } catch (error) {
        throw structuredRuntimeFailure(error);
      }
    }

    function feedContent(content) {
      const text = textDelta(content);
      if (!text) return '';
      const scanned = scanner.push(text);
      if (scanned.error) scannerError(scanned.error);
      dsmlCalls.push(...scanned.calls);
      if (scanned.visibleText) {
        appendRuntimeText(visibleText, scanned.visibleText);
      }
      return scanned.visibleText;
    }

    function processDocument(document) {
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new RuntimeFailure('upstream returned an invalid OpenAI SSE document', {
          code: 'UPSTREAM_PROTOCOL_ERROR',
        });
      }
      if (document.error) {
        throw new RuntimeFailure(
          String(document.error.message || 'WorkBuddy upstream error').slice(0, 300),
          { code: 'UPSTREAM_ERROR' },
        );
      }
      upstreamId ||= document.id;
      if (upstreamId) chatResponseId = upstreamId;
      if (upstreamCreated === null && Number.isFinite(Number(document.created))) {
        upstreamCreated = Number(document.created);
      }
      if (document.usage) upstreamUsage = document.usage;

      const choice = Array.isArray(document.choices) ? document.choices[0] : null;
      if (!choice) return;
      finishReason = choice.finish_reason || finishReason;
      const payload = choice.delta || choice.message || {};
      if (typeof payload.reasoning_content === 'string') {
        appendRuntimeText(reasoningText, payload.reasoning_content);
        if (body.stream) {
          ensureStreamStarted();
          if (!encoder || cancelKind) return;
          emit(encoder.reasoningDelta(payload.reasoning_content));
        }
      }
      if (typeof payload.refusal === 'string') {
        appendRuntimeText(refusalText, payload.refusal);
      }
      if (Array.isArray(payload.tool_calls)) pushStructured(payload.tool_calls);
      if (
        body.stream
        && Array.isArray(choice.message?.tool_calls)
      ) {
        ensureStreamStarted();
        if (!encoder || cancelKind) return;
        emit(encoder.toolDelta(choice.message.tool_calls.map((call, index) => ({
          id: call.id,
          name: call.function?.name,
          input: JSON.parse(call.function?.arguments || '{}'),
          index,
        }))));
      }
      if (payload.content !== undefined) {
        ensureStreamStarted();
        if (body.stream && (!encoder || cancelKind)) return;
        const emittedText = feedContent(payload.content);
        if (body.stream && emittedText) {
          emit(encoder.textDelta(emittedText));
        }
      }
    }

    async function refreshCredentials(credentials) {
      if (!credentials.refreshToken) return credentials;
      try {
        const refreshed = await refreshAccountCredentials(account, upstreamClient, {
          now: now(),
          refreshSkewMs: 0,
        });
        if (refreshed?.ok) return refreshed;
        debug(`OpenAI credential refresh failed: ${refreshed?.reason || 'unknown error'}`);
        throw new RuntimeFailure('WorkBuddy account authorization failed', {
          status: 401,
          type: 'authentication_error',
          code: 'AUTH_REQUIRED',
          retryable: true,
        });
      } catch (error) {
        if (error instanceof RuntimeFailure) throw error;
        debug(`OpenAI credential refresh failed: ${error.message}`);
        throw new RuntimeFailure('WorkBuddy account authorization failed', {
          status: 401,
          type: 'authentication_error',
          code: 'AUTH_REQUIRED',
          retryable: true,
        });
      }
    }

    async function requestUpstream(credentials) {
      return upstreamClient.chat({
        accountId: account,
        credentials,
        model: body.model,
        body: body.body,
        sanitize: config.channelSanitize,
        signal: controller.signal,
      });
    }

    req.once('aborted', onAborted);
    res.on('close', onClientDisconnect);
    interruptSignal?.addEventListener('abort', onInterrupt, { once: true });

    try {
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

      const contentType = String(response.headers.get('content-type') || '');
      if (!contentType.includes('text/event-stream')) {
        clearTimeout(firstByteTimer);
        let payload;
        try {
          payload = await response.json();
        } catch {
          throw new RuntimeFailure('upstream returned a non-JSON completion', {
            code: 'UPSTREAM_PROTOCOL_ERROR',
          });
        }
        processDocument(payload);
      } else {
        if (!response.body) throw new RuntimeFailure('upstream response has no body');
        reader = response.body.getReader();
        resetIdle();
        const parser = createSseParser();
        while (!sawDone) {
          const read = await reader.read();
          if (read.done) {
            readerDone = true;
            if (!cancelKind) {
              for (const event of parser.finished()) processDocument(event.data);
            }
            break;
          }
          if (cancelKind) break;
          clearTimeout(firstByteTimer);
          resetIdle();
          for (const event of parser.feed(read.value)) {
            if (event.data === '[DONE]') {
              sawDone = true;
              continue;
            }
            let document = event.data;
            if (typeof document === 'string') {
              try {
                document = JSON.parse(document);
              } catch {
                throw new RuntimeFailure('upstream returned malformed OpenAI SSE JSON', {
                  code: 'UPSTREAM_PROTOCOL_ERROR',
                });
              }
            }
            processDocument(document);
          }
        }
      }

      const scannedEnd = scanner.finish();
      if (scannedEnd.error) scannerError(scannedEnd.error);
      dsmlCalls.push(...scannedEnd.calls);
      appendRuntimeText(visibleText, scannedEnd.visibleText);
      if (cancelKind) {
        const outputTokens = conservativeTokenEstimate(visibleText.value());
        const usage = openAIUsage(upstreamUsage, inputEstimate, outputTokens);
        const persisted = await cancelPersistence.save({
          id: chatResponseId,
          createdAt: startedAt,
          status: 'incomplete',
          body: {
            id: chatResponseId,
            status: 'incomplete',
            incomplete_details: { reason: 'canceled' },
            output: visibleText.value() ? [{
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: visibleText.value() }],
            }] : [],
          },
          usage,
          partial: { content: visibleText.value() },
        }, {
          cancelInfo: { reason: cancelReason || cancelKind, phase: 'generation' },
          partial: { content: visibleText.value() },
        });
        cancelPersisted = true;
        cancelPersistenceResult = persisted;
        if (!persisted.ok) debug(`cancel fragment not durable (${persisted.error?.message || 'storage error'})`);
        if (body.stream && persisted.ok) {
          ensureStreamStarted({ allowCanceled: true });
          if (encoder && !writer.failed) {
            writer?.writeComment('bridge-chat-canceled');
            emit(encoder.finalize({ finishReason, canceled: true }));
          }
          if (!responseEnded) {
            responseEnded = true;
            closeWriter(controller.signal.reason);
          }
        } else if (body.stream && !persisted.ok) {
          writer?.fail(persisted.error);
          if (!responseEnded) {
            responseEnded = true;
            closeWriter(persisted.error);
          }
        }
        leaseResult = {
          ok: false,
          code: cancelKind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'ABORTED',
          error: cancelKind,
          durationMs: now() - startedAt,
          meta: { model: body.model, usage: {} },
        };
        return {
          ok: false,
          started: true,
          canceled: true,
          kind: cancelReason || cancelKind,
          persistence: persisted,
        };
      }
      if (timeoutKind) {
        throw controller.signal.reason instanceof RuntimeFailure
          ? controller.signal.reason
          : new TimeoutFailure(timeoutKind, `upstream ${timeoutKind} timeout`);
      }
      if (!finishReason) {
        const completedTool = structured.hasPending() || dsmlCalls.length > 0;
        if (!completedTool) {
          throw new RuntimeFailure('upstream ended without a finish reason', {
            code: 'UPSTREAM_TRUNCATED',
          });
        }
      }
      const structuredEnd = structured.finish();
      if (
        structuredEnd.invalid.length > 0
        && (structuredEnd.calls.length > 0 || dsmlCalls.length === 0)
      ) throw scannerError({
        code: 'UPSTREAM_INVALID_TOOL_CALL',
        message: 'upstream returned an invalid structured tool call',
      });
      const arbitration = arbitrateToolCalls({
        structured: structuredEnd,
        dsml: dsmlCalls,
        toolsDeclared: body.toolsDeclared,
        toolChoice: body.toolChoice,
        model: body.model,
        requestId: upstreamId || `chatcmpl-${randomUUID()}`,
        account,
        allowedToolNames: body.toolNames,
      });
      if (arbitration.warning) {
        warn(`duplicate tool formats: ${JSON.stringify(arbitration.warning)}`);
      }

      const usage = openAIUsage(
        upstreamUsage,
        inputEstimate,
        conservativeTokenEstimate({
          text: visibleText.value(),
          tools: arbitration.calls.map((call) => call.input),
        }),
      );
      const responseBody = toOpenAIResponse({
        id: upstreamId,
        created: upstreamCreated,
        content: visibleText.value(),
        reasoning: reasoningText.value(),
        refusal: refusalText.value(),
        toolCalls: new Map(arbitration.calls.map((call, index) => [
          index,
          {
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(call.input),
          },
        ])),
        finishReason,
        usage,
      }, body.model, { now });
      if (body.stream) {
        ensureStreamStarted();
        if (!encoder || cancelKind) {
          throw controller.signal.reason instanceof RuntimeFailure
            ? controller.signal.reason
            : clientWriteFailure();
        }
        emit(encoder.finalize({
          calls: arbitration.calls,
          finishReason,
          usage,
        }));
        if (!cancelKind && !writer?.failed && writer?.ended) {
          terminate('client', clientWriteFailure());
        }
        if (cancelKind) {
          throw controller.signal.reason instanceof RuntimeFailure
            ? controller.signal.reason
            : clientWriteFailure();
        }
        if (!writer.end()) {
          terminate('client', clientWriteFailure(writer?.failed));
          throw controller.signal.reason instanceof RuntimeFailure
            ? controller.signal.reason
            : clientWriteFailure();
        }
        responseEnded = true;
      } else {
        sendJson(res, 200, responseBody);
      }

      leaseResult = {
        ok: true,
        code: 'OK',
        durationMs: now() - startedAt,
        meta: {
          model: body.model,
          usage: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
          },
        },
      };
      return {
        ok: true,
        started: body.stream,
        account,
        durationMs: now() - startedAt,
        code: 'OK',
        responseBody,
      };
    } catch (error) {
      const failure = error instanceof RuntimeFailure
        ? error
        : new RuntimeFailure(error.message || 'internal error', {
            code: error?.code || 'INTERNAL_ERROR',
          });
      if (error instanceof ApiError) {
        failure.status = error.status;
        failure.type = error.type;
        failure.code = error.code;
      }
      leaseResult = {
        ok: false,
        code: failure.code,
        error: `${failure.message} ${failure.code}`,
        durationMs: now() - startedAt,
        meta: { model: body.model, usage: {} },
      };
      if (cancelKind) {
        leaseResult = {
          ok: false,
          code: cancelKind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'ABORTED',
          error: cancelKind,
          durationMs: now() - startedAt,
          meta: { model: body.model, usage: {} },
        };
        return {
          ok: false,
          started: true,
          canceled: true,
          kind: cancelReason || cancelKind,
        };
      }
      if (body.stream && res.headersSent && !responseEnded && failure.code !== 'ABORTED') {
        emit(encoder?.error(failure));
        responseEnded = true;
        closeWriter(failure);
        return { ok: false, started: true, error: failure };
      }
      return { ok: false, started: false, error: failure };
    } finally {
      stopTimers();
      req.off('aborted', onAborted);
      res.off('close', onClientDisconnect);
      interruptSignal?.removeEventListener('abort', onInterrupt);
      if (reader && !readerDone) {
        try {
          await reader.cancel(controller.signal.reason || 'request finished');
        } catch {
          // Best effort.
        }
      }
      await Promise.allSettled(pendingWrites);
      if (cancelKind && !cancelPersisted) {
        const output = visibleText.value() ? [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: visibleText.value() }],
        }] : [];
        const persisted = await cancelPersistence.save({
          id: chatResponseId,
          createdAt: startedAt,
          status: 'incomplete',
          body: {
            id: chatResponseId,
            status: 'incomplete',
            incomplete_details: { reason: 'canceled' },
            output,
          },
          partial: { content: visibleText.value() },
        }, {
          cancelInfo: { reason: cancelReason || cancelKind, phase: 'generation' },
          partial: { content: visibleText.value() },
        });
        cancelPersisted = true;
        cancelPersistenceResult = persisted;
        if (body.stream && !responseEnded) {
          if (persisted.ok) {
            ensureStreamStarted({ allowCanceled: true });
            if (encoder && !writer.failed) {
              writer?.writeComment('bridge-chat-canceled');
              emit(encoder.finalize({ finishReason, canceled: true }));
            }
          } else if (!persisted.ok) {
            writer?.fail(persisted.error);
          }
          responseEnded = true;
          closeWriter(cancelKind === 'backpressure' ? controller.signal.reason : null);
        }
      }
      if (cancelPersistenceResult?.deadLetterWritten) {
        warn(`canceled Chat fragment written to dead letter: ${chatResponseId}`);
      }
      releaseLease(leaseResult);
    }
  }

  async function chat({ req, res, body, config }) {
    return chatWithCancellation({ req, res, body, config });
  }

  async function chatWithCancellation({ req, res, body, config, interruptSignal = null }) {
    if (body?.stream === true && config.streaming === false) {
      throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
    }
    const normalized = prepareOpenAIRequest(body, {
      defaultModel: config.defaultModel,
      toolsEnabled: config.tools,
    });
    const pool = poolLoader();
    const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
    const tried = [];
    let lastFailure = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pick({ exclude: tried, model: normalized.model });
      if (!picked.name) {
        if (!tried.length) {
          throw new ApiError(503, `号池里没有可用账号（${picked.reason}）`, {
            type: 'service_unavailable',
            code: 'POOL_EMPTY',
          });
        }
        break;
      }
      tried.push(picked.name);
      debug(`openai api → ${picked.name}（第 ${attempt + 1} 次）`);
      begin(picked.name);
      const result = await executeAttempt({
        interruptSignal,
        req,
        res,
        body: normalized,
        config,
        account: picked.name,
      });
      if (result.ok || result.started) return result;
      lastFailure = result.error;
      if (!result.error?.retryable) break;
    }

    const failure = lastFailure || new RuntimeFailure('all account attempts failed');
    if (!res.headersSent && !res.writableEnded) sendApiError(res, failure, 'openai');
    return { ok: false, error: failure };
  }

  async function catalogue(config) {
    const pool = poolLoader();
    const maxAttempts = Math.max(1, Math.min(Number(pool.maxAttempts) || 3, 5));
    const tried = [];

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const picked = pick({ exclude: tried });
      if (!picked.name) break;
      tried.push(picked.name);
      begin(picked.name);
      const startedAt = now();
      try {
        let credentials = readCredentials(picked.name, { now: now() });
        if (!credentials?.ok) throw new Error('no credentials');
        if (credentials.needsRefresh) {
          const refreshed = await refreshAccountCredentials(picked.name, upstreamClient, {
            now: now(),
            refreshSkewMs: 0,
          });
          if (refreshed?.ok) credentials = refreshed;
        }
        const payload = await upstreamClient.models(credentials);
        const models = mapModelCatalogue(payload, {
          defaultModel: config.defaultModel,
        });
        end(picked.name, {
          ok: true,
          code: 'OK',
          durationMs: now() - startedAt,
          meta: { model: '', usage: {} },
        });
        return { models, source: models.some((model) => model.wb_source === 'fallback')
          ? 'fallback'
          : 'upstream' };
      } catch (error) {
        debug(`OpenAI model catalogue from ${picked.name} failed: ${error.message}`);
        end(picked.name, {
          ok: false,
          code: 'UPSTREAM_ERROR',
          error: error.message,
          durationMs: now() - startedAt,
          meta: { model: '', usage: {} },
        });
      }
    }

    return {
      models: mapModelCatalogue(null, { defaultModel: config.defaultModel }),
      source: 'fallback',
    };
  }

  async function models({ res, config }) {
    const result = await catalogue(config);
    sendJson(res, 200, {
      object: 'list',
      data: result.models,
    }, {
      'x-wb-model-source': result.source,
    });
  }

  async function model({ res, config, id }) {
    const result = await catalogue(config);
    const modelId = decodeURIComponent(String(id || ''));
    const found = result.models.find((item) => item.id === modelId);
    if (!found) {
      throw new ApiError(404, `model not found: ${modelId}`, {
        type: 'invalid_request_error',
        code: 'model_not_found',
      });
    }
    sendJson(res, 200, found);
  }

  return {
    chat,
    chatWithCancellation,
    cancelStore: cancelPersistence,
    models,
    model,
  };
}
