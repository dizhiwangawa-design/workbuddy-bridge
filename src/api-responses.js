import { randomUUID } from 'node:crypto';
import { ApiError } from './api-errors.js';
import {
  readAccountCredentials,
  refreshAccountCredentials,
} from './auth-store.js';
import { beginTask, endTask, loadPool, pickAccount } from './pool.js';
import { createUpstreamClient } from './upstream-client.js';
import { createSseParser } from './sse.js';
import { createDsmlScanner } from './tool-calls.js';
import { createStructuredToolAssembler, arbitrateToolCalls } from './protocols/normalize.js';
import { conservativeTokenEstimate } from './protocols/anthropic.js';
import {
  baseResponse,
  completedResponseBody,
  createResponsesStreamEncoder,
  historyForResponse,
  prepareResponsesRequest,
  responseEvents,
  responseUsage,
  resumedPrior,
} from './protocols/responses.js';
import {
  PRODUCTION_KEEPALIVE_MS,
  canWriteHttp,
  createHttpEventWriter,
  withTimeout,
} from './stream-control.js';
import {
  createResponsesStore,
  mergePartialOutput,
} from './responses-store.js';
import { debug, warn } from './log.js';

const MAX_RETAINED_VISIBLE_BYTES = 256 * 1024;

function runtimeError(message, code, {
  status = 502,
  type = 'api_error',
  retryable = false,
} = {}) {
  return new ApiError(status, message, { type, code, retryable });
}

function streamHeaders() {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  };
}

async function upstreamDetail(response) {
  try {
    const raw = (await response.text()).slice(0, 16 * 1024);
    const document = JSON.parse(raw);
    return String(
      document?.error?.message || document?.msg || document?.message || '',
    ).slice(0, 300);
  } catch {
    return '';
  }
}

function parseOptions(options) {
  const config = {
    enabled: options.enabled === true || options.openai === true || options.anthropic === true,
    openai: options.openai === true,
    streaming: options.streaming !== false,
    tools: options.tools !== false,
    responsesPersistence: options.responsesPersistence !== false,
    responsesNudge: options.responsesNudge === true,
    requireApiKey: options.requireApiKey === true,
    remoteRequireKey: options.remoteRequireKey === true,
    trustProxy: options.trustProxy === true,
    channelSanitize: options.channelSanitize !== false,
    defaultModel: String(options.defaultModel || 'deepseek-v4.1-flash'),
    dsmlMaxBufferBytes: Number(options.dsmlMaxBufferBytes || 2 * 1024 * 1024),
    firstByteTimeoutMs: Number(options.firstByteTimeoutMs || 60000),
    idleTimeoutMs: Number(options.idleTimeoutMs || 120000),
    finishGraceMs: Number(options.finishGraceMs || 2000),
    totalTimeoutMs: Number(options.totalTimeoutMs || 600000),
  };
  return config;
}

export function createResponsesRuntime(options = {}) {
  const {
    upstreamClient = createUpstreamClient(),
    readCredentials = readAccountCredentials,
    pick = pickAccount,
    begin = beginTask,
    end = endTask,
    poolLoader = loadPool,
    now = Date.now,
    keepaliveMs: injectedKeepaliveMs,
    softBytes = 256 * 1024,
    hardBytes = 1024 * 1024,
    writerFactory = createHttpEventWriter,
    persistTimeoutMs = 2000,
  } = options;
  const keepaliveMs = injectedKeepaliveMs === undefined
    ? PRODUCTION_KEEPALIVE_MS
    : Number(injectedKeepaliveMs);
  const store = options.store || options.cancelPersistence
    || createResponsesStore({ now });
  let retriedDeadLetters = false;

  async function ensureDeadLetterRetry() {
    if (retriedDeadLetters) return;
    retriedDeadLetters = true;
    try {
      await store.retryDeadLetters?.();
    } catch (error) {
      warn(`dead-letter startup retry failed: ${error.code || error.message}`);
    }
  }

  async function refresh(account, credentials) {
    if (!credentials?.refreshToken) return credentials;
    try {
      const refreshed = await refreshAccountCredentials(account, upstreamClient, {
        now: now(),
        refreshSkewMs: 0,
      });
      if (refreshed?.ok) return refreshed;
      debug(`Responses credential refresh failed: ${refreshed?.reason || 'unknown error'}`);
      return credentials;
    } catch (error) {
      debug(`Responses credential refresh failed: ${error.message}`);
      return credentials;
    }
  }

  async function loadHistory(previousResponseId, persistence) {
    if (!previousResponseId) return { messages: [], prior: [] };
    if (!persistence) throw new ApiError(
      400,
      'previous_response_id requires Responses persistence',
      { code: 'persistence_disabled' },
    );
    if (!store.get) return { messages: [], prior: [] };
    const record = await store.get(previousResponseId);
    if (!record) throw new ApiError(404, 'previous response was not found or expired', {
      code: 'previous_response_not_found',
    });
    return {
      messages: historyForResponse(record),
      prior: resumedPrior(record),
    };
  }

  async function setupAttempt({
    req,
    res,
    body,
    config: rawConfig,
    account,
    prepared,
    previousResponseId,
    prior,
    transport = 'http',
    interruptSignal = null,
    sendWs = null,
    onAttempt = null,
    onDone = null,
  }) {
    const config = parseOptions(rawConfig || {});
    const requestStarted = now();
    const responseId = `resp_${randomUUID().replaceAll('-', '')}`;
    const createdAt = Math.floor(now() / 1000);
    const controller = new AbortController();
    const writer = transport === 'http'
      ? writerFactory(res, {
          protocol: 'responses',
          // The HTTP stream may already be ended when a queued cancel is
          // observed. The writer must stay one terminal resource per request.
          canWrite: () => canWriteHttp(res),
          softBytes,
          hardBytes,
          onOverflow: (error) => cancel('backpressure', error, { forceWriter: false }),
        })
      : null;
    let reader = null;
    let readerDone = false;
    let readerCancellation = null;
    let firstByteTimer = null;
    let idleTimer = null;
    let totalTimer = null;
    let finishGraceTimer = null;
    let pingTimer = null;
    let response = null;
    let leaseReleased = false;
    let cancelPromise = null;
    let cancelKind = null;
    let canceling = false;
    let finished = false;
    let sequence = 2;
    let finishReason = null;
    let visibleText = '';
    let reasoningText = '';
    let usage = null;
    let phase = 'opening';
    let sawDone = false;
    let lineBytes = 0;
    let parser = null;
    let liveEncoder = null;
    const structured = createStructuredToolAssembler();
    const scanner = createDsmlScanner({
      maxBufferBytes: config.dsmlMaxBufferBytes,
    });
    const dsmlCalls = [];
    const priorIds = new Set(prior.map((item) => item?.id));
    const resumedRecord = config.responsesNudge && previousResponseId
      ? await store.get(previousResponseId).catch(() => null)
      : null;
    const canResume = resumedRecord?.status === 'incomplete'
      && resumedRecord.body?.incomplete_details?.reason === 'canceled';
    const persistedPrompt = canResume
      ? [
          '[Responses continuation] The previous response was truncated by cancellation.',
          'Continue from the persisted context without repeating completed work.',
        ].join(' ')
      : null;
    if (persistedPrompt) {
      prepared.body.messages ??= [];
      prepared.body.messages.push({ role: 'system', content: persistedPrompt });
    }

    function release(result) {
      if (leaseReleased) return;
      leaseReleased = true;
      end(account, result);
    }

    function clearTimers() {
      clearTimeout(firstByteTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearTimeout(finishGraceTimer);
      clearInterval(pingTimer);
    }

    function cancelReader(reason) {
      if (!reader || readerDone) return;
      if (!readerCancellation) {
        readerCancellation = Promise.resolve()
          .then(() => reader.cancel(reason))
          .catch(() => {});
      }
    }

    function transform(event) {
      const copy = (value) => {
        if (Array.isArray(value)) return value.map(copy);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
      };
      const data = copy(event.data);
      if (data.response && ![
        'response.completed',
        'response.incomplete',
        'response.failed',
        'response.created',
        'response.in_progress',
      ].includes(event.type)) {
        data.response.output = data.response.output?.filter((item) => (
          item?.id && !priorIds.has(item.id)
        )) || [];
      }
      return {
        type: event.type,
        data: { ...data, sequence_number: sequence++ },
      };
    }

    function emit(events) {
      if (!writer || writer.ended || writer.failed) return false;
      return writer.writeEvents((events || []).map(transform));
    }

    function publishWs(events) {
      if (transport !== 'ws' || typeof sendWs !== 'function') return false;
      for (const event of (events || []).map(transform)) {
        try {
          sendWs(event);
        } catch (error) {
          if (['ERR_STREAM_WRITE_AFTER_END', 'EPIPE', 'ECONNRESET'].includes(error?.code)) {
            return false;
          }
          throw error;
        }
      }
      return true;
    }

    function snapshot(final = false) {
      const calls = final ? structured.finish() : structured.snapshot();
      const scanned = final ? scanner.finish() : { visibleText: '', calls: [], error: null };
      const truncation = scanned.error?.code === 'DSML_TRUNCATED';
      if (scanned.error && !truncation) {
        throw runtimeError('upstream DSML tool call is malformed', scanned.error.code);
      }
      const arbitration = arbitrateToolCalls({
        structured: { calls: calls.calls || [], invalid: [] },
        dsml: [...dsmlCalls, ...(scanned.calls || [])],
        toolsDeclared: prepared.toolsDeclared,
        toolChoice: prepared.toolChoice,
        model: prepared.model,
        requestId: responseId,
        account,
        allowedToolNames: prepared.toolNames,
      });
      const content = visibleText + (final ? scanned.visibleText : '');
      const completion = conservativeTokenEstimate({
        text: content,
        tools: arbitration.calls.map((call) => call.input),
      });
      return {
        content,
        reasoning: reasoningText,
        calls: arbitration.calls,
        callsComplete: !calls.invalid?.length,
        usage: {
          prompt_tokens: Number(usage?.prompt_tokens ?? usage?.input_tokens ?? inputTokens),
          completion_tokens: Number(
            usage?.completion_tokens ?? usage?.output_tokens ?? completion,
          ),
          reasoning_tokens: Number(
            usage?.completion_tokens_details?.reasoning_tokens
              ?? usage?.reasoning_tokens
              ?? 0,
          ),
        },
        finishReason: truncation ? 'length' : finishReason,
      };
    }

    const inputTokens = conservativeTokenEstimate(prepared.body);

    function keepalive() {
      if (finished || writer?.failed || writer?.ended) return;
      const snapshotValue = snapshot(false);
      emit([{
        type: 'response.in_progress',
        data: {
          type: 'response.in_progress',
          response: baseResponse({
            id: responseId,
            model: prepared.model,
            createdAt,
            output: prior,
            store: body.store === true,
            previousResponseId,
            status: 'in_progress',
            usage: responseUsage(
              snapshotValue.usage.prompt_tokens,
              snapshotValue.usage.completion_tokens,
            ),
          }),
        },
      }]);
    }

    function protocolEvents(finalBody, retainItemIdentity = true) {
      // Continuations include prior output in the response body. Protocol
      // events describe only the current turn; IDs, indexes and item payloads
      // must therefore come from output after the resumed prefix.
      const currentOutput = finalBody.output.slice(prior.length);
      const message = currentOutput.find((item) => item.type === 'message');
      const reasoning = currentOutput.find((item) => item.type === 'reasoning');
      const callOutputs = currentOutput.filter((item) => (
        item.type !== 'message' && item.type !== 'reasoning'
      ));
      const calls = callOutputs.map((item) => {
        let input = {};
        try {
          input = item.type === 'custom_tool_call'
            ? { input: item.input }
            : JSON.parse(item.arguments || '{}');
        } catch {
          input = {};
        }
        return { id: item.call_id, name: item.name, input };
      });
      const registry = new Map(calls.map((call) => {
        const item = callOutputs.find((candidate) => candidate.call_id === call.id);
        return [call.name, {
          kind: item?.type === 'custom_tool_call' ? 'custom' : 'function',
          name: call.name,
          flattened: call.name,
        }];
      }));
      const events = responseEvents({
        // Build events against this turn's output only. prior items remain in
        // finalBody.output and are included in the terminal response, but they
        // must never be selected as the identity/index of a resumed delta.
        response: { ...finalBody, output: currentOutput },
        reasoning: reasoning?.summary?.map((part) => part.text).join('') || '',
        content: message?.content?.map((part) => part.text).join('') || '',
        calls,
        registry,
        finishType: finalBody.status === 'incomplete'
          ? 'response.incomplete'
          : finalBody.status === 'failed'
            ? 'response.failed'
            : 'response.completed',
      });
      for (const item of events.slice(2)) {
        if (item.data.response) item.data.response = finalBody;
        if (typeof item.data.output_index === 'number') {
          item.data.output_index += prior.length;
        }
        if (item.data.item && retainItemIdentity) {
          const finalItem = finalBody.output[item.data.output_index];
          if (finalItem) item.data.item = finalItem;
        }
      }
      return events;
    }

    function cancelEvents(finalBody, {
      finalDeltas = false,
      finalReasoningDeltas = false,
    } = {}) {
      const live = liveEncoder?.snapshot();
      const oldMessage = live?.output.find((item) => item.type === 'message');
      const oldReasoning = live?.output.find((item) => item.type === 'reasoning');
      finalBody.output = finalBody.output.map((item) => {
        if (item.type === 'message' && oldMessage) return { ...item, id: oldMessage.id };
        if (item.type === 'reasoning' && oldReasoning) return { ...item, id: oldReasoning.id };
        return item;
      });
      const events = protocolEvents(finalBody, false).slice(2);
      for (const event of events) {
        if (event.data.item) {
          const liveItem = live?.output.find((item) => item.type === event.data.item.type);
          if (liveItem) event.data.item = { ...event.data.item, id: liveItem.id };
        }
        if (event.type === 'response.output_text.delta' && event.data.delta) {
          event.data.delta = finalDeltas
            ? event.data.delta
            : event.data.delta.slice((live?.content || '').length);
          if (!event.data.delta) {
            event.markRemoved = true;
            continue;
          }
        }
        if (event.type === 'response.reasoning_summary_text.delta' && event.data.delta) {
          event.data.delta = finalReasoningDeltas
            ? event.data.delta
            : event.data.delta.slice((live?.reasoning || '').length);
          if (!event.data.delta) {
            event.markRemoved = true;
            continue;
          }
        }
      }
      return events
        .filter((event) => !event.markRemoved)
        .map((event) => {
          delete event.markRemoved;
          return event;
        });
    }
    async function terminalFailure(kind, error) {
      if (finished) return cancelPromise;
      finished = true;
      canceling = true;
      cancelKind = kind;
      controller.abort(error);
      clearTimers();
      cancelReader(error);
      cancelPromise = (async () => {
        const live = liveEncoder?.snapshot();
        if (live?.content) visibleText = live.content;
        if (live?.reasoning) reasoningText = live.reasoning;
        let retained = { content: visibleText, reasoning: reasoningText, calls: [], usage: {} };
        try {
          retained = snapshot(false);
        } catch (snapshotError) {
          debug(`Responses terminal snapshot failed: ${snapshotError.message}`);
        }
        release({
          ok: false,
          code: error.code || 'UPSTREAM_ERROR',
          error: `${kind} ${error.message || ''}`.trim(),
          durationMs: now() - requestStarted,
          meta: { model: prepared.model, usage: {} },
        });
        const failed = completedResponseBody({
          id: responseId,
          model: prepared.model,
          createdAt,
          prior,
          reasoning: retained.reasoning,
          content: retained.content,
          calls: retained.calls,
          registry: prepared.tools,
          error: { code: error.code || 'UPSTREAM_ERROR', message: error.message },
          previousResponseId,
        });
        failed.status = 'failed';
        if (transport === 'http' && body.stream === true && writer && !writer.failed) {
          emit(cancelEvents(failed, {
            finalDeltas: !live?.content,
            finalReasoningDeltas: !live?.reasoning,
          }));
          writer.end();
        } else if (transport === 'ws') {
          publishWs(protocolEvents(failed, false));
        }
        return {
          ok: false,
          error,
          failure: true,
          started: transport === 'http' ? Boolean(res?.headersSent) : Boolean(response),
          responseId,
        };
      })();
      return cancelPromise;
    }

    function start() {
      if (response) return;
      const isStream = body.stream === true || transport === 'ws';
      // ServerResponse emits 'close' once after the request has been read,
      // even when the client is still connected. Only a response that has
      // entered its writable lifecycle can indicate a lost downstream.
      if (transport === 'http') res?.on('close', onClose);
      response = baseResponse({
        id: responseId,
        model: prepared.model,
        createdAt,
        output: prior,
        store: body.store === true,
        previousResponseId,
      });
      if (transport === 'http' && isStream) {
        res.writeHead(200, streamHeaders());
        emit(responseEvents({ response }).slice(0, 2));
        liveEncoder = createResponsesStreamEncoder({ response });
        pingTimer = setInterval(keepalive, keepaliveMs);
        pingTimer.unref?.();
      }
    }

    function timeout(kind, error) {
      if (cancelKind) return;
      void terminalFailure(kind, error);
    }

    function armFirstByte() {
      if (!config.firstByteTimeoutMs) return;
      firstByteTimer = setTimeout(() => timeout(
        'first_byte_timeout',
        runtimeError('upstream first byte timed out', 'UPSTREAM_FIRST_BYTE_TIMEOUT', { status: 504 }),
      ), config.firstByteTimeoutMs);
      firstByteTimer.unref?.();
    }

    function armTotal() {
      if (!config.totalTimeoutMs) return;
      totalTimer = setTimeout(() => timeout(
        'total_timeout',
        runtimeError('upstream request exceeded its total timeout', 'UPSTREAM_TIMEOUT', { status: 504 }),
      ), config.totalTimeoutMs);
      totalTimer.unref?.();
    }

    function resetIdle() {
      clearTimeout(idleTimer);
      if (!config.idleTimeoutMs) return;
      idleTimer = setTimeout(() => timeout(
        'idle_timeout',
        runtimeError('upstream stream became idle', 'UPSTREAM_IDLE_TIMEOUT', { status: 504 }),
      ), config.idleTimeoutMs);
      idleTimer.unref?.();
    }

    async function persistFinal(finalBody, result, canceled = false) {
      if (!config.responsesPersistence || body.store === false) {
        return { ok: false, skipped: true };
      }
      const saveOptions = {
        timeoutMs: persistTimeoutMs,
        marker: body.input,
        ...(canceled ? {
          cancelInfo: { reason: cancelKind, phase },
          partial: { content: result.content, toolCalls: result.calls },
        } : {}),
      };
      const persisted = await store.save({
        id: responseId,
        createdAt: requestStarted,
        status: finalBody.status,
        body: { ...finalBody, store: true },
        usage: result.usage,
        partial: { content: result.content, toolCalls: result.calls },
      }, saveOptions);
      return canceled ? {
        persisted: persisted.ok,
        deadLetterWritten: persisted.deadLetterWritten === true,
      } : persisted;
    }

    async function cancel(kind, reason, { forceWriter = true } = {}) {
      if (canceling) return cancelPromise;
      if (kind === 'backpressure') {
        canceling = true;
        cancelKind = kind;
        finishReason = 'cancel';
        controller.abort(reason);
        clearTimers();
        cancelReader(reason);
        const live = liveEncoder?.snapshot();
        if (live?.content) visibleText = live.content;
        if (live?.reasoning) reasoningText = live.reasoning;
        release({
          ok: false,
          code: 'BACKPRESSURE_OVERFLOW',
          error: `${kind} ${reason?.message || reason || ''}`.trim(),
          durationMs: now() - requestStarted,
          meta: { model: prepared.model, usage: {} },
        });
        cancelPromise = (async () => {
          try {
            const retained = snapshot(false);
            const partial = {
              content: retained.content,
              toolCalls: retained.callsComplete ? retained.calls : [],
            };
            let cancelBody = completedResponseBody({
              id: responseId,
              model: prepared.model,
              createdAt,
              prior,
              reasoning: retained.reasoning,
              content: retained.content,
              calls: retained.calls,
              registry: prepared.tools,
              usage: retained.usage,
              canceled: true,
              previousResponseId,
            });
            cancelBody.output = mergePartialOutput(cancelBody.output, partial);
            const persisted = await persistFinal(cancelBody, retained, true);
            if (persisted.deadLetterWritten) {
              warn(`canceled Responses fragment written to dead letter: ${responseId}`);
            }
            finished = true;
            writer?.end();
            return {
              ok: false,
              canceled: true,
              responseId,
              kind,
              persistence: persisted,
            };
          } catch (error) {
            warn(`Responses backpressure persistence failed: ${error.message}`);
            finished = true;
            writer?.end();
            return {
              ok: false,
              canceled: true,
              responseId,
              kind,
              persistence: { ok: false, error },
            };
          }
        })();
        return cancelPromise;
      }
      canceling = true;
      cancelKind = kind;
      finishReason = 'cancel';
      if (forceWriter) writer?.fail(reason);
      controller.abort(reason);
      clearTimers();
      cancelPromise = (async () => {
        let persisted = { ok: false, skipped: true };
        try {
          cancelReader(reason);
          release({
            ok: false,
            code: kind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'CANCELED',
            error: `${kind} ${reason?.message || reason || ''}`.trim(),
            durationMs: now() - requestStarted,
            meta: { model: prepared.model, usage: {} },
          });
          const retained = snapshot(false);
          const partial = {
            content: retained.content,
            toolCalls: retained.callsComplete ? retained.calls : [],
          };
          let cancelBody = completedResponseBody({
            id: responseId,
            model: prepared.model,
            createdAt,
            prior,
            reasoning: retained.reasoning,
            content: retained.content,
            calls: retained.calls,
            registry: prepared.tools,
            usage: retained.usage,
            canceled: true,
            previousResponseId,
          });
          cancelBody.output = mergePartialOutput(cancelBody.output, partial);
          persisted = await persistFinal(cancelBody, retained, true);
          cancelBody = {
            ...cancelBody,
            store: persisted.ok === true,
          };
          if (persisted.deadLetterWritten) {
            warn(`canceled Responses fragment written to dead letter: ${responseId}`);
          }
          finished = true;
          if (transport === 'ws') {
            publishWs(protocolEvents(cancelBody, false));
          } else if (writer && !writer.failed && canWriteHttp(res)) {
            emit(cancelEvents(cancelBody, { finalDeltas: true }));
            writer.end();
          } else {
            writer?.end();
          }
          const callback = {
            ok: false,
            canceled: true,
            responseId,
            kind,
            persistence: persisted,
          };
          try {
            onDone?.(callback);
          } catch (error) {
            warn(`Responses cancel callback failed: ${error.message}`);
          }
          return callback;
        } catch (error) {
          warn(`Responses cancellation persistence failed: ${error.message}`);
          finished = true;
          const callback = {
            ok: false,
            canceled: true,
            responseId,
            kind,
            persistence: { ok: false, error },
          };
          if (transport === 'http' && body.stream === true) writer?.end();
          return callback;
        }
      })();
      return cancelPromise;
    }

    const onClose = () => {
      if (finished) return;
      if (!res?.headersSent && !res?.destroyed) return;
      if (res?.writableEnded) return;
      void cancel('network_disconnect', runtimeError(
        'client disconnected',
        'CLIENT_DISCONNECTED',
        { status: 499 },
      ));
    };
    const onAbort = () => {
      if (finished) return;
      void cancel('interrupt', runtimeError('response interrupted', 'CANCELED'));
    };
    req?.once('aborted', onClose);
    interruptSignal?.addEventListener('abort', onAbort, { once: true });

    async function consumeSse(upstream) {
      if (!upstream.body) throw runtimeError('upstream response has no body', 'UPSTREAM_PROTOCOL_ERROR');
      reader = upstream.body.getReader();
      resetIdle();
      parser = createSseParser();
      while (!sawDone && !cancelKind && !writer?.failed) {
        const pending = reader.read();
        const outcome = await Promise.race([
          pending.then((value) => ({ value })),
          new Promise((resolve) => controller.signal.addEventListener(
            'abort',
            () => resolve({ canceled: true }),
            { once: true },
          )),
        ]);
        if (outcome.canceled) {
          void pending.catch(() => {});
          return;
        }
        const read = outcome.value;
        if (controller.signal.aborted || cancelKind) {
          readerDone = true;
          return;
        }
        if (read.done) {
          readerDone = true;
          for (const event of parser.finished()) {
            if (event.data === '[DONE]') sawDone = true;
            else applyDocument(event.data);
          }
          return;
        }
        clearTimeout(firstByteTimer);
        resetIdle();
        for (const event of parser.feed(read.value)) {
          if (event.data === '[DONE]') {
            sawDone = true;
            break;
          }
          applyDocument(event.data);
        }
      }
    }

    function applyDocument(rawDocument) {
      let document = rawDocument;
      if (typeof document === 'string') {
        try {
          document = JSON.parse(document);
        } catch {
          throw runtimeError('upstream returned malformed SSE JSON', 'UPSTREAM_PROTOCOL_ERROR');
        }
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw runtimeError('upstream returned invalid Responses chat data', 'UPSTREAM_PROTOCOL_ERROR');
      }
      if (document.error) throw runtimeError(
        String(document.error.message || 'WorkBuddy error').slice(0, 300),
        'UPSTREAM_ERROR',
      );
      if (document.usage) usage = document.usage;
      const choice = Array.isArray(document.choices) ? document.choices[0] : null;
      if (!choice) return;
      finishReason = choice.finish_reason || finishReason;
      phase = 'generation';
      const payload = choice.delta || choice.message || {};
      if (typeof payload.reasoning_content === 'string') {
        reasoningText += payload.reasoning_content;
        if (payload.reasoning_content) emit(liveEncoder?.reasoningDelta(payload.reasoning_content));
      }
      if (Array.isArray(payload.tool_calls)) {
        structured.push(payload.tool_calls);
        phase = 'tool_call';
      }
      const content = typeof payload.content === 'string'
        ? payload.content
        : Array.isArray(payload.content)
          ? payload.content.map((part) => part?.type === 'text' ? part.text || '' : '').join('')
          : '';
      if (content) {
        lineBytes += content.length;
        const scanned = scanner.push(content);
        if (scanned.error) throw runtimeError(
          'upstream DSML tool call is malformed',
          scanned.error.code,
        );
        if (scanned.calls.length) {
          dsmlCalls.push(...scanned.calls);
          phase = 'tool_call';
        }
        if (scanned.visibleText) {
          visibleText = scanner.hasPendingCall()
            ? (visibleText + scanned.visibleText).slice(-MAX_RETAINED_VISIBLE_BYTES)
            : `${visibleText + scanned.visibleText}`.slice(-MAX_RETAINED_VISIBLE_BYTES);
          if (transport === 'http' && body.stream === true && liveEncoder) {
            emit(liveEncoder.textDelta(scanned.visibleText));
          }
        }
      }
      if (finishReason && !finishGraceTimer) {
        finishGraceTimer = setTimeout(() => {
          void reader?.cancel('finish grace').catch(() => {});
        }, config.finishGraceMs);
        finishGraceTimer.unref?.();
      }
    }

    async function run() {
      try {
        start();
        let credentials = readCredentials(account, { now: now() });
        if (!credentials?.ok) throw runtimeError(
          'WorkBuddy account has no usable credentials',
          'AUTH_REQUIRED',
          { status: 401, type: 'authentication_error', retryable: true },
        );
        if (credentials.needsRefresh) credentials = await refresh(account, credentials);
        armFirstByte();
        armTotal();
        let upstream = await upstreamClient.chat({
          accountId: account,
          credentials,
          model: prepared.model,
          body: prepared.body,
          sanitize: config.channelSanitize,
          signal: controller.signal,
        });
        if (upstream.status === 401 && credentials.refreshToken) {
          credentials = await refresh(account, credentials);
          upstream = await upstreamClient.chat({
            accountId: account,
            credentials,
            model: prepared.model,
            body: prepared.body,
            sanitize: config.channelSanitize,
            signal: controller.signal,
          });
        }
        if (!upstream.ok) {
          const detail = await upstreamDetail(upstream);
          throw runtimeError(
            detail || `WorkBuddy upstream HTTP ${upstream.status}`,
            upstream.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR',
            {
              status: upstream.status === 429 ? 429 : 502,
              type: upstream.status === 429 ? 'rate_limit_error' : 'api_error',
              retryable: upstream.status === 429 || upstream.status >= 500,
            },
          );
        }
        if (String(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
          await consumeSse(upstream);
        } else {
          clearTimeout(firstByteTimer);
          let document;
          try {
            document = await upstream.json();
          } catch {
            throw runtimeError('upstream returned invalid completion JSON', 'UPSTREAM_PROTOCOL_ERROR');
          }
          applyDocument(document);
        }
        if (cancelKind) return await cancelPromise;
        if (!finishReason && !sawDone) {
          throw runtimeError('upstream ended without a finish reason', 'UPSTREAM_TRUNCATED');
        }
        clearTimers();
        const result = snapshot(true);
        if (liveEncoder?.snapshot().content) {
          result.content = liveEncoder.snapshot().content.slice(-MAX_RETAINED_VISIBLE_BYTES);
        }
        if (result.calls.length > 1 && prepared.parallelToolCalls === false) {
          result.calls = result.calls.slice(0, 1);
        }
        const finalBody = completedResponseBody({
          id: responseId,
          model: prepared.model,
          createdAt,
          prior,
          reasoning: result.reasoning,
          content: result.content,
          calls: result.calls,
          registry: prepared.tools,
          usage: result.usage,
          finishReason: result.finishReason,
          requestedMax: prepared.requestedMax,
          actuallyLimited: result.usage.completion_tokens >= Number(prepared.maxOutputTokens),
          previousResponseId,
        });
        release({
          ok: true,
          code: 'OK',
          durationMs: now() - requestStarted,
          meta: {
            model: prepared.model,
            usage: {
              input_tokens: result.usage.prompt_tokens,
              output_tokens: result.usage.completion_tokens,
            },
          },
        });
        if (body.store && config.responsesPersistence) {
          const persisted = await persistFinal(finalBody, result, false);
          if (persisted.ok) finalBody.store = true;
          else if (persisted.skipped) finalBody.store = false;
          else warn(`Responses fragment persistence failed: ${persisted.error?.code || ''}`);
        }
        finished = true;
        if (transport === 'http') {
          if (body.stream === true) {
            emit(cancelEvents(finalBody, {
              finalDeltas: false,
              finalReasoningDeltas: false,
            }));
            writer.end();
          } else {
            if (!res.writable || res.destroyed || res.writableEnded) return await cancel(
              'network_disconnect',
              runtimeError('client disconnected before JSON response', 'CLIENT_DISCONNECTED'),
            );
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
            });
            res.end(JSON.stringify(finalBody));
          }
        } else {
          publishWs(protocolEvents(finalBody));
        }
        const callback = { ok: true, response: finalBody, responseId };
        try {
          onDone?.(callback);
        } catch (error) {
          warn(`Responses completion callback failed: ${error.message}`);
        }
        return callback;
      } catch (error) {
        if (cancelKind) return cancelPromise;
        const failure = error instanceof ApiError
          ? error
          : runtimeError(error.message || 'internal error', 'INTERNAL_ERROR');
        finished = true;
        clearTimers();
        release({
          ok: false,
          code: failure.code || 'INTERNAL_ERROR',
          error: `${failure.message} ${failure.code || ''}`,
          durationMs: now() - requestStarted,
          meta: { model: prepared.model, usage: {} },
        });
        if (response && body.stream === true) {
          const failed = completedResponseBody({
            id: responseId,
            model: prepared.model,
            createdAt,
            prior,
            error: { code: failure.code || 'internal_error', message: failure.message },
            previousResponseId,
          });
          failed.status = 'failed';
          emit(protocolEvents(failed).slice(2));
        }
        writer?.end();
        return {
          ok: false,
          error: failure,
          started: transport === 'http' ? Boolean(res?.headersSent) : Boolean(response),
          responseId,
        };
      } finally {
        clearTimers();
        req?.off('aborted', onClose);
        res?.off('close', onClose);
        interruptSignal?.off('abort', onAbort);
        if (reader && !readerDone) cancelReader(controller.signal.reason || 'request finished');
        await withTimeout(readerCancellation, 1000, 'upstream reader close timed out').catch(() => {});
        if (!leaseReleased) release({
          ok: false,
          code: 'ABORTED',
          error: 'request did not complete',
          durationMs: now() - requestStarted,
          meta: { model: prepared.model, usage: {} },
        });
      }
    }

    return {
      run,
      writer,
      streamStats: () => writer?.stats() || null,
      cancel,
      responseId,
    };
  }

  async function execute({
    req,
    res,
    body,
    config,
    account,
    previousResponseId = null,
    prior = [],
    history = [],
    transport = 'http',
    interruptSignal = null,
    onAttempt = null,
    onDone = null,
    sendWs = null,
  }) {
    const prepared = prepareResponsesRequest(body, {
      defaultModel: config.defaultModel,
      toolsEnabled: config.tools,
      history,
    });
    const attempt = await setupAttempt({ onAttempt,
      req,
      res,
      body,
      config,
      account,
      prepared,
      previousResponseId,
      prior,
      transport,
      interruptSignal,
      sendWs,
      onDone,
    });

    return attempt.run();
  }

  async function create({ req, res, body, config }) {
    await ensureDeadLetterRetry();
    const persistence = Boolean(config.responsesPersistence);
    const previous = await loadHistory(body?.previous_response_id, persistence);
    prepareResponsesRequest(body, {
      defaultModel: config.defaultModel,
      toolsEnabled: config.tools,
      history: previous.messages,
    });
    if (body?.stream === true && !config.streaming) {
      throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
    }
    const pool = poolLoader();
    const tried = [];
    let last = null;
    for (let attempt = 0; attempt < Math.max(1, Math.min(pool.maxAttempts || 3, 5)); attempt += 1) {
      const picked = pick({ exclude: tried });
      if (!picked.name) {
        if (!tried.length) throw new ApiError(503, '号池没有可用账号', {
          type: 'service_unavailable',
          code: 'POOL_EMPTY',
        });
        break;
      }
      tried.push(picked.name);
      begin(picked.name);
      let attempt = null;
      const result = await execute({
        req,
        res,
        body,
        config,
        account: picked.name,
        previousResponseId: body?.previous_response_id || null,
        prior: previous.prior,
        history: previous.messages,
        onAttempt: (value) => {
          attempt = value;
        },
      });
      if (result.ok || result.started || result.canceled) {
        return {
          ...result,
          streamStats: attempt?.streamStats?.() || null,
        };
      }
      last = result.error;
        if (result.failure || !last?.retryable) break;
    }
    throw last || new ApiError(502, 'all account attempts failed', { code: 'UPSTREAM_ERROR' });
  }

  async function retrieve({ id, config }) {
    if (!config.responsesPersistence) throw new ApiError(404, 'Responses persistence is disabled', {
      code: 'persistence_disabled',
    });
    await ensureDeadLetterRetry();
    const record = await store.get(id);
    if (!record) throw new ApiError(404, 'response not found', { code: 'not_found' });
    return record.body;
  }

  async function destroy() {
    await store.close?.();
  }

  function wsSession({ ws = null, send, config, onResponse }) {
    let controller = null;
    let attempt = null;
    let running = null;
    let closed = false;
    let parent = Promise.resolve();

    async function waitForAttempt() {
      await withTimeout(running, 3000, 'WS response cancellation timed out').catch(() => {});
    }

    async function interrupt(reason = 'response.interrupt') {
      controller?.abort(reason);
      void attempt?.cancel('interrupt', runtimeError(
        String(reason),
        'CANCELED',
      ));
      await waitForAttempt();
      if (!running) controller = null;
    }

    async function executeCommand(command) {
      if (closed) return;
      if (running) await interrupt('replaced response');
      controller = new AbortController();
      let history;
      try {
        history = await loadHistory(command.previous_response_id, config.responsesPersistence);
      } catch (error) {
        send({ type: 'error', error: { code: error.code || 'invalid_request', message: error.message } });
        return;
      }
      if (closed) return;
      const picked = pick({ exclude: [] });
      if (!picked.name) {
        send({ type: 'error', error: { code: 'POOL_EMPTY', message: '号池没有可用账号' } });
        return;
      }
      begin(picked.name);
      let prepared;
      try {
        prepared = prepareResponsesRequest(command, {
          defaultModel: config.defaultModel,
          toolsEnabled: config.tools,
          history: history.messages,
        });
      } catch (error) {
        end(picked.name, {
          ok: false,
          code: 'INVALID_REQUEST',
          error: error.message,
          durationMs: 0,
          meta: { model: config.defaultModel, usage: {} },
        });
        send({ type: 'error', error: { code: error.code || 'invalid_request', message: error.message } });
        return;
      }
      const current = await setupAttempt({
        body: command,
        config,
        account: picked.name,
        prepared,
        previousResponseId: command.previous_response_id || null,
        prior: history.prior,
        history: history.messages,
        transport: 'ws',
        interruptSignal: controller.signal,
        sendWs: send,
        onDone: (result) => onResponse?.(result),
      });
      attempt = current;
      const currentRun = current.run();
      running = currentRun.then((result) => {
        if (running === settled) running = null;
        if (attempt === current) attempt = null;
        return result;
      }).catch((error) => {
        send({ type: 'error', error: { code: error.code || 'internal_error', message: error.message } });
        if (running === settled) running = null;
        if (attempt === current) attempt = null;
      });
      const settled = running;
      await running;
    }

    function enqueue(command) {
      const next = parent.then(() => executeCommand(command)).catch((error) => {
        if (!closed) send({
          type: 'error',
          error: { code: error.code || 'internal_error', message: error.message },
        });
      });
      parent = next;
      return next;
    }

    return {
      create(command) {
        if (!command || typeof command !== 'object') {
          send({ type: 'error', error: { code: 'invalid_command', message: 'JSON object required' } });
          return;
        }
        const type = command.type || 'response.create';
        if (type !== 'response.create') {
          send({ type: 'error', error: { code: 'unsupported_command', message: `unknown command ${type}` } });
          return;
        }
        void interrupt('replaced response').then(() => enqueue(command));
      },
      interrupt() {
        void interrupt().then(() => {
          if (closed) return;
          if (ws?.send({ type: 'response.cancelled' }) === false) {
            ws.close?.(1000, 'interrupted');
          }
        });
      },
      close() {
        closed = true;
        void interrupt('ws close');
      },
    };
  }

  return {
    create,
    retrieve,
    store,
    destroy,
    wsSession,
    execute,
    ensureDeadLetterRetry,
  };
}
