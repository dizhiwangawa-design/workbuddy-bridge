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
import {
  anthropicHasToolLoop,
  chatHasToolLoop,
  continuationNudgeApplies,
  continuationNudgeMode,
} from './continuation-nudge.js';
import { createSseParser, encodeSseEvent } from './sse.js';
import { ApiError, sendApiError } from './api-errors.js';
import { withClientKeyAttribution } from './api-attribution.js';
import { resetAtFromResponse } from './rate-limit.js';
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
import { applyEffortToBody } from './reasoning-effort.js';

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
  const reasoning = source.completion_tokens_details?.reasoning_tokens
    ?? source.reasoning_tokens
    ?? usage.reasoningTokens
    ?? 0;
  // 上游把 prompt 缓存命中放在两个位置之一；缓存读与写入是 Anthropic 的原生字段。
  const cacheRead = source.prompt_cache_hit_tokens
    ?? source.prompt_tokens_details?.cached_tokens
    ?? source.cache_read_input_tokens
    ?? usage.cacheReadTokens
    ?? 0;
  const cacheWrite = source.prompt_cache_write_tokens
    ?? source.cache_creation_input_tokens
    ?? usage.cacheWriteTokens
    ?? 0;
  return {
    inputTokens: Number(source.prompt_tokens ?? source.input_tokens ?? usage.inputTokens ?? 0),
    outputTokens: Number(source.completion_tokens ?? source.output_tokens ?? usage.outputTokens ?? 0),
    reasoningTokens: Math.max(0, Number(reasoning) || 0),
    cacheReadTokens: Math.max(0, Number(cacheRead) || 0),
    cacheWriteTokens: Math.max(0, Number(cacheWrite) || 0),
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

/**
 * 还有没有别的号能接这个模型。
 *
 * 单号部署下 429 换号就是原地重试：同一个号刚被打上冷却，pick 只会返回空，
 * 循环白跑一轮再把同样的错误抛出去。这里提前判定，省掉那次无用重试。
 */
function hasAnotherAccount(tried, model) {
  return Boolean(pickAccount({ exclude: tried, model })?.name);
}

/**
 * 429 会带「什么时候能再来」。把这句解析成 resetAt 挂在失败对象上，
 * endTask 会用它打冷却：按上游给的时刻等，而不是拿指数退避去猜。
 */
function withResetHint(failure, headers, detail = '') {
  const resetAt = resetAtFromResponse(headers, detail);
  if (resetAt) failure.resetAt = resetAt;
  return failure;
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

function normalizeBody(body, config, headers = null) {
  if (body?.stream === true && config.streaming === false) {
    throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
  }
  const candidate = {
    ...body,
    model: body?.model || config.defaultModel,
  };
  const converted = anthropicToOpenAI(candidate, {
    continuationNudge: continuationNudgeApplies({
      mode: continuationNudgeMode(config),
      headers,
      body,
      hasToolLoop: anthropicHasToolLoop(body),
    }),
  });
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
  reasoningCatalogue = null,
  logWarn = warn,
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
    clientKey = null,
    interruptSignal = null,
  }) {
    const requestId = `msg_${randomUUID()}`;
    // body 是 normalizeBody 的返回值，同时挂着 outbound body 与 requestBody 两份请求体；
    // 整个信封序列化会把同一份请求体算两遍，估算值虚高。只估真正发出去的那一份。
    const inputEstimate = estimateAnthropicInputTokens(body.body);
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
    const reasoningText = createRuntimeTextCache({ hardBytes });
    let dsmlCalls = [];
    let structured;
    let scanner;
    let encoder;
    let usage = { inputTokens: inputEstimate, outputTokens: 0 };
    let warnedThinkingWhileDisabled = false;
    // 首个「可见」增量的时刻（正文或推理，非空）。decode 窗口从这里算起，
    // 与 dsh 的 t_firstToken 同口径；工具调用本身也算可见内容。
    let firstVisibleAt = 0;
    const markVisible = () => { if (!firstVisibleAt) firstVisibleAt = now(); };
    // 推理通道单独一把扫描器：模型常把工具调用写进思考里，那条通道以前不过扫描器，
    // 于是原始标记既泄漏给客户端，又少执行一次本该发生的调用。
    const reasoningScanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
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
      end(account, withClientKeyAttribution(result, clientKey, 'anthropic'));
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
        thinkingEnabled: body.normalized.thinkingEnabled,
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
      if (scanned.calls.length) {
        dsmlCalls.push(...scanned.calls);
        markVisible();
      }
      if (scanned.visibleText && stream) {
        markVisible();
        appendRuntimeText(visibleText, scanned.visibleText);
        write(encoder.textDelta(scanned.visibleText));
      } else if (scanned.visibleText) {
        markVisible();
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
        const delta = choice.delta || choice.message || {};
        const messageTools = choice.message?.tool_calls;
        if (Array.isArray(messageTools)) pushStructured(messageTools);
        if (Array.isArray(delta.tool_calls)) pushStructured(delta.tool_calls);
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          applyReasoningDocument(delta.reasoning_content);
        }
        if (delta.content !== undefined) feedContent(delta.content);
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          armFinishGrace();
        }
      }
    }

    /**
     * 推理通道的清洗：只把可见文本交给 thinking 块，DSML 调用合并进 dsmlCalls。
     *
     * 与正文通道的差别在于失败策略——推理是辅助通道，畸形片段只丢不判整轮失败。
     */
    function applyReasoningDocument(text) {
      if (!text) return;
      if (!body.normalized.thinkingEnabled && !warnedThinkingWhileDisabled) {
        warnedThinkingWhileDisabled = true;
        logWarn(
          `Anthropic request ${requestId} received reasoning content while thinking `
          + 'was disabled; the model may not honor none',
        );
      }
      const scannedReasoning = reasoningScanner.push(text);
      if (scannedReasoning.calls.length) dsmlCalls.push(...scannedReasoning.calls);
      if (scannedReasoning.error) {
        logWarn(
          `Anthropic reasoning channel carried malformed DSML: ${scannedReasoning.error.code}`,
        );
        return;
      }
      if (!body.normalized.thinkingEnabled || !scannedReasoning.visibleText) return;
      markVisible();
      appendRuntimeText(reasoningText, scannedReasoning.visibleText);
      ensureStarted();
      if (encoder && !cancelKind) {
        write(encoder.thinkingDelta(scannedReasoning.visibleText));
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

    function applyReasoningEffort(credentials) {
      const declaration = reasoningCatalogue?.getDeclaration({
        accountId: account,
        credentials,
        model: body.normalized.model || body.requestBody.model,
      }) || null;
      const applied = applyEffortToBody(
        body.body,
        body.normalized.requestedEffort,
        declaration,
      );
      // 实际转发值：客户端回显与排查都读它，而不是读请求里的原始值。
      body.forwardedEffort = applied.forwardedEffort;
      body.reasoningSuppressed = applied.suppressed;
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
      applyReasoningEffort(credentials);

      armTotal();
      armFirstByte();
      let response = await requestUpstream(credentials);
      if (response.status === 401 && credentials.refreshToken) {
        credentials = await refreshCredentials(credentials);
        applyReasoningEffort(credentials);
        response = await requestUpstream(credentials);
      }
      if (!response.ok) {
        const detail = await upstreamErrorDetail(response);
        throw withResetHint(upstreamError(response.status, detail), response.headers, detail);
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
        const outputTokens = conservativeTokenEstimate(visibleText.value());
        const reasoningTokens = Math.max(0, Number(usage.reasoningTokens) || 0);
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
          usage: {
            input_tokens: usage.inputTokens || inputEstimate,
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: reasoningTokens },
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
              outputTokens,
              reasoningTokens,
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
      // 推理通道的收尾与正文同口径：补回缓冲里的可见尾巴，把调用交给仲裁。
      const scannedReasoningEnd = reasoningScanner.finish();
      if (scannedReasoningEnd.calls.length) dsmlCalls.push(...scannedReasoningEnd.calls);
      if (scannedReasoningEnd.error) {
        logWarn(`Anthropic reasoning channel ended with ${scannedReasoningEnd.error.code}`);
      } else if (scannedReasoningEnd.visibleText && body.normalized.thinkingEnabled) {
        appendRuntimeText(reasoningText, scannedReasoningEnd.visibleText);
        ensureStarted();
        if (stream) write(encoder.thinkingDelta(scannedReasoningEnd.visibleText));
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
      const reasoningTokens = Math.max(0, Number(usage.reasoningTokens) || 0);
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
          output_tokens_details: {
            reasoning_tokens: reasoningTokens,
          },
          // Anthropic 的原生缓存字段；只在非零时输出，保持既有响应形状。
          ...(Number(usage.cacheReadTokens) > 0
            ? { cache_read_input_tokens: Math.max(0, Number(usage.cacheReadTokens)) }
            : {}),
          ...(Number(usage.cacheWriteTokens) > 0
            ? { cache_creation_input_tokens: Math.max(0, Number(usage.cacheWriteTokens)) }
            : {}),
        },
      };
      if (body.normalized.thinkingEnabled && reasoningText.value()) {
        responseBody.content.push({
          type: 'thinking',
          thinking: reasoningText.value(),
          signature: '',
        });
      }
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
          reasoningTokens,
          cacheReadTokens: Math.max(0, Number(usage.cacheReadTokens) || 0),
          cacheWriteTokens: Math.max(0, Number(usage.cacheWriteTokens) || 0),
          // 上游已经报了真实的 prompt_tokens 就用它收尾，不要再让客户端停在
          // message_start 的 bytes/3 估算上。
          inputTokens: Number.isFinite(Number(usage.inputTokens)) && Number(usage.inputTokens) > 0
            ? Number(usage.inputTokens)
            : null,
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
          // 与 dsh 的 decodeTokens/decodeMs 同口径：首增量 → 结束。
          ttftMs: firstVisibleAt ? firstVisibleAt - startedAt : 0,
          decodeMs: firstVisibleAt ? now() - firstVisibleAt : 0,
          usage: {
            // usage.inputTokens 来自上游 prompt_tokens；只有上游完全没报时才退回估算。
            input_tokens: usage.inputTokens || inputEstimate,
            output_tokens: Math.max(0, outputTokens),
            // 号池按 cache_read_input_tokens / cache_creation_input_tokens 记账；
            // 这里不漏字段，面板的缓存命中率才不会恒为 0。
            cache_read_input_tokens: Math.max(0, Number(usage.cacheReadTokens) || 0),
            cache_creation_input_tokens: Math.max(0, Number(usage.cacheWriteTokens) || 0),
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
        const reasoningTokens = Math.max(0, Number(usage.reasoningTokens) || 0);
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
          usage: {
            input_tokens: usage.inputTokens || inputEstimate,
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: reasoningTokens },
          },
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
            write(encoder.cancel({
              outputTokens,
              reasoningTokens,
              cacheReadTokens: Math.max(0, Number(usage.cacheReadTokens) || 0),
              cacheWriteTokens: Math.max(0, Number(usage.cacheWriteTokens) || 0),
            }));
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
        meta: { model: body.requestBody.model, usage: {}, resetAt: failure.resetAt || 0 },
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

  async function messages({ req, res, body, config, clientKey = null, interruptSignal = null }) {
    const normalized = normalizeBody(body, config, req?.headers || null);
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
        clientKey,
        interruptSignal,
      });
      if (result.ok) return result;
      if (result.started) return result;
      lastFailure = result.error;
      if (!result.error?.retryable) break;
      // 限流且没有别的号可用：换号等于原地重试，只会把 429 放大。
      // 直接把 429 和 Retry-After 透给客户端。
      if (lastFailure.code === 'RATE_LIMITED' && !hasAnotherAccount(tried, normalized.requestBody.model)) break;
    }

    const failure = lastFailure || new RuntimeFailure('all account attempts failed');
    if (!res.headersSent && !res.writableEnded) sendApiError(res, failure, 'anthropic');
    return { ok: false, started: false, error: failure };
  }

  function countTokens({ res, body }) {
    normalizeAnthropicRequest(body, { requireMaxTokens: false });
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
  const reasoning = source?.completion_tokens_details?.reasoning_tokens;
  const reasoningTokens = Number(reasoning);
  // 上游把 prompt 缓存命中放在两个位置之一；只在非零时输出，保持旧响应形状。
  const cached = Number(
    source?.prompt_cache_hit_tokens
    ?? source?.prompt_tokens_details?.cached_tokens
    ?? 0,
  );
  return {
    prompt_tokens: Math.max(0, promptTokens),
    completion_tokens: Math.max(0, completionTokens),
    total_tokens: Number.isFinite(total)
      ? Math.max(0, total)
      : Math.max(0, promptTokens + completionTokens),
    ...(reasoning !== undefined && reasoning !== null && Number.isFinite(reasoningTokens)
      ? {
          completion_tokens_details: {
            reasoning_tokens: Math.max(0, reasoningTokens),
          },
        }
      : {}),
    ...(Number.isFinite(cached) && cached > 0
      ? { prompt_tokens_details: { cached_tokens: Math.max(0, cached) } }
      : {}),
  };
}

export function createOpenAIRuntime({
  upstreamClient = createUpstreamClient(),
  reasoningCatalogue = null,
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
    clientKey = null,
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
    // 推理通道单独一把扫描器：模型常把工具调用写进思考里，那条通道以前不过扫描器，
    // 于是原始标记既泄漏给用户，又少执行一次本该发生的调用。
    const reasoningScanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
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
    let warnedReasoningWhileDisabled = false;
    // 首个「可见」增量的时刻（正文/推理/工具调用任一）。decode 窗口从这里算起。
    let firstVisibleAt = 0;
    const markVisible = () => { if (!firstVisibleAt) firstVisibleAt = now(); };
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
      end(account, withClientKeyAttribution(result, clientKey, 'openai_chat'));
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
      // 工具调用同样是「可见内容」：dsh 的首 token 判定把它算在内。
      if (Array.isArray(deltas) ? deltas.length : Boolean(deltas)) markVisible();
    }

    function feedContent(content) {
      const text = textDelta(content);
      if (!text) return '';
      const scanned = scanner.push(text);
      if (scanned.error) scannerError(scanned.error);
      if (scanned.calls.length) {
        dsmlCalls.push(...scanned.calls);
        markVisible();
      }
      if (scanned.visibleText) {
        markVisible();
        appendRuntimeText(visibleText, scanned.visibleText);
      }
      return scanned.visibleText;
    }

    /**
     * 推理通道的清洗：只把可见文本交出去，DSML 调用合并进 dsmlCalls。
     *
     * 与正文通道的差别在于失败策略——推理是辅助通道，畸形片段只丢不判整轮失败，
     * 否则一段跑偏的思考会把本来能成功的回合打成错误。
     */
    function applyReasoningDocument(text) {
      if (!text) return;
      if (body.reasoningSuppressed && !warnedReasoningWhileDisabled) {
        warnedReasoningWhileDisabled = true;
        warn(
          `Chat request ${chatResponseId} received reasoning content while `
          + 'reasoning_effort was none; the model may not honor none',
        );
      }
      const scannedReasoning = reasoningScanner.push(text);
      if (scannedReasoning.calls.length) dsmlCalls.push(...scannedReasoning.calls);
      if (scannedReasoning.error) {
        warn(`Chat reasoning channel carried malformed DSML: ${scannedReasoning.error.code}`);
        return;
      }
      if (body.reasoningSuppressed || !scannedReasoning.visibleText) return;
      markVisible();
      appendRuntimeText(reasoningText, scannedReasoning.visibleText);
      if (body.stream) {
        ensureStreamStarted();
        if (!encoder || cancelKind) return;
        emit(encoder.reasoningDelta(scannedReasoning.visibleText));
      }
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
        applyReasoningDocument(payload.reasoning_content);
      }
      if (typeof payload.refusal === 'string') {
        appendRuntimeText(refusalText, payload.refusal);
      }
      // 上游这条路径是「一次性返回完整 JSON 文档」，工具调用没有增量可言：
      // 统一交给装配器收下，由 finalize 按仲裁结果发一次。
      // 在这里再 emit 一次 toolDelta 会让同一条调用拿到两个 index（toolIndex 自增），
      // 客户端会执行两次；顺带也避免了在此裸 JSON.parse（参数被截断时抛错泄给客户端）。
      if (Array.isArray(payload.tool_calls)) pushStructured(payload.tool_calls);
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
      const applyChatEffort = () => {
        const declaration = reasoningCatalogue?.getDeclaration({
          accountId: account,
          credentials,
          model: body.model,
        }) || null;
        const applied = applyEffortToBody(body.body, body.requestedEffort, declaration);
        body.forwardedEffort = applied.forwardedEffort;
        // 客户端**显式**要求 none，上游却仍返回 reasoning_content（CHANGELOG 的
        // 已知限制）——此时正文不该透给客户端，与 Anthropic 路径对齐。
        // 只认显式意图：没声明档位（source: 'default'）不是「要求关闭思考」，
        // 那种情况照常透出推理，否则会静默砍掉既有功能。
        body.reasoningSuppressed = applied.suppressed;
      };
      applyChatEffort();

      armTotal();
      armFirstByte();
      let response = await requestUpstream(credentials);
      if (response.status === 401 && credentials.refreshToken) {
        credentials = await refreshCredentials(credentials);
        // 换号后目录可能完全不同（另一个账号的模型声明），档位必须按新目录重解析。
        applyChatEffort();
        response = await requestUpstream(credentials);
      }
      if (!response.ok) {
        const detail = await upstreamErrorDetail(response);
        throw withResetHint(upstreamError(response.status, detail), response.headers, detail);
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
      // 缓冲里可能留着一截「看着像 DSML 开头」的可见尾巴（例如正文以 "<" 结尾）。
      // 非流式靠 visibleText 收尾即可，流式必须把它补发一次，否则客户端字面上丢字符。
      if (scannedEnd.visibleText) {
        appendRuntimeText(visibleText, scannedEnd.visibleText);
        if (body.stream && encoder && !cancelKind) {
          ensureStreamStarted();
          emit(encoder.textDelta(scannedEnd.visibleText));
        }
      }
      // 推理通道的收尾与正文同口径：补回缓冲里的可见尾巴，把调用交给仲裁。
      const scannedReasoningEnd = reasoningScanner.finish();
      if (scannedReasoningEnd.calls.length) dsmlCalls.push(...scannedReasoningEnd.calls);
      if (scannedReasoningEnd.error) {
        warn(`Chat reasoning channel ended with ${scannedReasoningEnd.error.code}`);
      } else if (scannedReasoningEnd.visibleText && !body.reasoningSuppressed) {
        appendRuntimeText(reasoningText, scannedReasoningEnd.visibleText);
        if (body.stream && encoder && !cancelKind) {
          ensureStreamStarted();
          emit(encoder.reasoningDelta(scannedReasoningEnd.visibleText));
        }
      }
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
          // 与 dsh 的 decodeTokens/decodeMs 同口径：首增量 → 结束。
          ttftMs: firstVisibleAt ? firstVisibleAt - startedAt : 0,
          decodeMs: firstVisibleAt ? now() - firstVisibleAt : 0,
          usage: {
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            // 号池按 cache_read_input_tokens / cache_creation_input_tokens 记账；
            // 这里不漏字段，面板的缓存命中率才不会恒为 0。
            cache_read_input_tokens: Math.max(0, Number(usage.prompt_tokens_details?.cached_tokens) || 0),
            cache_creation_input_tokens: 0,
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
        meta: { model: body.model, usage: {}, resetAt: failure.resetAt || 0 },
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

  async function chat({ req, res, body, config, clientKey = null }) {
    return chatWithCancellation({ req, res, body, config, clientKey });
  }

  async function chatWithCancellation({
    req,
    res,
    body,
    config,
    clientKey = null,
    interruptSignal = null,
  }) {
    if (body?.stream === true && config.streaming === false) {
      throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
    }
    const normalized = prepareOpenAIRequest(body, {
      defaultModel: config.defaultModel,
      toolsEnabled: config.tools,
      continuationNudge: continuationNudgeApplies({
        mode: continuationNudgeMode(config),
        headers: req?.headers || null,
        body,
        hasToolLoop: chatHasToolLoop(body),
      }),
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
        clientKey,
      });
      if (result.ok || result.started) return result;
      lastFailure = result.error;
      if (!result.error?.retryable) break;
      // 见 anthropic 同名逻辑：只有一个号时限流不该触发换号重试
      if (lastFailure.code === 'RATE_LIMITED' && !hasAnotherAccount(tried, normalized.model)) break;
    }

    const failure = lastFailure || new RuntimeFailure('all account attempts failed');
    if (!res.headersSent && !res.writableEnded) sendApiError(res, failure, 'openai');
    return { ok: false, error: failure };
  }

  async function catalogue(config, { refresh = false } = {}) {
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
        const snapshot = reasoningCatalogue
          ? await reasoningCatalogue.snapshot({
              accountId: picked.name,
              credentials,
              refresh,
            })
          : null;
        const payload = snapshot ? { models: snapshot.models } : await upstreamClient.models(credentials);
        const models = mapModelCatalogue(payload, {
          defaultModel: config.defaultModel,
        });
        end(picked.name, {
          ok: true,
          code: 'OK',
          durationMs: now() - startedAt,
          meta: { model: '', usage: {} },
        });
        return {
          models,
          source: models.some((model) => model.wb_source === 'fallback')
            ? 'fallback'
            : snapshot?.stale
              ? 'stale'
              : 'upstream',
        };
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

  async function models({ res, config, refresh = false }) {
    const result = await catalogue(config, { refresh });
    sendJson(res, 200, {
      object: 'list',
      data: result.models,
    }, {
      'x-wb-model-source': result.source,
    });
  }

  async function model({ res, config, id, refresh = false }) {
    const result = await catalogue(config, { refresh });
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
