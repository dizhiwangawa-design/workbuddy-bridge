import { randomUUID } from 'node:crypto';
import { ApiError } from './api-errors.js';
import { withClientKeyAttribution } from './api-attribution.js';
import {
  readAccountCredentials,
  refreshAccountCredentials,
} from './auth-store.js';
import {
  beginTask,
  endTask,
  loadPool,
  markPoolDirty,
  pickAccount,
} from './pool.js';
import { recordContinuation } from './stats.js';
import { createUpstreamClient } from './upstream-client.js';
import { createSseParser } from './sse.js';
import {
  createDsmlScanner,
  structuredToolArgumentLimit,
} from './tool-calls.js';
import { createStructuredToolAssembler, arbitrateToolCalls } from './protocols/normalize.js';
import { conservativeTokenEstimate } from './protocols/anthropic.js';
import {
  continuationNudgeApplies,
  continuationNudgeMode,
  responsesHasToolLoop,
} from './continuation-nudge.js';
import {
  CONTINUATION_RETRY_PROMPT,
  continuationRetryEnabled,
  mergeReasoning,
  mergeToolCalls,
  mergeUsage,
  shouldContinueTurn,
  stripRepeatedPreamble,
} from './continuation-retry.js';
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
  HARD_WRITE_BYTES,
  PRODUCTION_KEEPALIVE_MS,
  canWriteHttp,
  createHttpEventWriter,
  createTextCache,
  withTimeout,
} from './stream-control.js';
import {
  createResponsesStore,
  mergePartialOutput,
} from './responses-store.js';
import { debug, warn } from './log.js';
import { applyEffortToBody } from './reasoning-effort.js';

function runtimeError(message, code, {
  status = 502,
  type = 'api_error',
  retryable = false,
} = {}) {
  return new ApiError(status, message, { type, code, retryable });
}

function createResponseTextCache({ hardBytes = HARD_WRITE_BYTES } = {}) {
  return createTextCache({
    // The terminal output must remain consistent with every delta already sent
    // to a fast reader. The hard socket budget is the bounded final cache.
    maxBytes: Math.max(1, Number(hardBytes) || HARD_WRITE_BYTES),
    retain: 'error',
  });
}

/**
 * 拼接续跑正文：剥掉第二轮开头重复的说明，剩下的接在第一轮之后。
 *
 * 为什么必须去重：第一轮的「接下来我会补 Sync 路由。」已经流给客户端了，第二轮
 * 又原样写一遍，终态里同一句话出现两次会让客户端以为进度重复了。剥重放在
 * `stripRepeatedPreamble`（纯函数，有单测）。
 */
function joinContinuationText(first, second) {
  const head = String(first ?? '');
  const tail = stripRepeatedPreamble(head, second);
  if (!tail) return head;
  if (!head.trim()) return tail;
  // 中文句子直接接；英文/已有句末标点之间补一个空格，避免粘成一个词。
  const glue = /[。！？.!?;；:：\n]\s*$/.test(head) ? (head.trimEnd().endsWith('.') ? ' ' : '') : '';
  return `${head}${glue}${tail}`;
}

function appendResponseText(cache, delta) {
  try {
    cache.append(delta);
  } catch (error) {
    throw runtimeError(error.message, error.code || 'OUTPUT_TOO_LARGE');
  }
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
    // 环境变量覆盖在判定点（continuationRetryEnabled）里做，这里只做类型归一。
    continuationRetry: typeof options.continuationRetry === 'boolean'
      ? options.continuationRetry
      : true,
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
    reasoningCatalogue = null,
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
    wsCancelWaitMs = 5000,
  } = options;
  const keepaliveMs = injectedKeepaliveMs === undefined
    ? PRODUCTION_KEEPALIVE_MS
    : Number(injectedKeepaliveMs);
  const cancelWaitMs = Math.max(1, Number(wsCancelWaitMs) || 5000);
  const store = options.store || options.cancelPersistence
    || createResponsesStore({ now });
  let retriedDeadLetters = false;

  /**
   * 记一次「回合被截停」的计数。
   *
   * 三个数缺一不可：cut（判定为截停）/ retried（真的又发了一轮）/ rescued
   * （续跑后拿到了工具调用）。没有 rescued/retried 这个比值，就无从判断这次修复
   * 到底有没有用——这正是上一轮误修三次都没发现的原因。
   */
  function countContinuation(delta) {
    try {
      recordContinuation(poolLoader(), delta);
      markPoolDirty();
    } catch (error) {
      // 计数失败不能影响请求本身。
      debug(`continuation counter failed: ${error.message}`);
    }
  }

  function applyReasoningEffort(prepared, account, credentials) {
    const declaration = reasoningCatalogue?.getDeclaration({
      accountId: account,
      credentials,
      model: prepared.model,
    }) || null;
    const applied = applyEffortToBody(
      prepared.body,
      prepared.requestedEffort,
      declaration,
    );
    prepared.forwardedEffort = applied.forwardedEffort;
    // 客户端**显式**要求 none，上游却仍返回 reasoning_content（CHANGELOG 的
    // 已知限制）——此时正文不该透给客户端，与 Anthropic 路径对齐。
    // 只认显式意图：没声明档位（source: 'default'）不是「要求关闭思考」，
    // 那种情况照常透出推理，否则会静默砍掉既有功能。
    prepared.reasoningSuppressed = applied.suppressed;
    return applied.forwardedEffort;
  }

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
    await ensureDeadLetterRetry();
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
    history = [],
    clientKey = null,
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
          onWriteFailure: (error) => {
            if (!finished && !canceling) {
              void cancel('network_disconnect', error instanceof ApiError
                ? error
                : runtimeError(
                    error?.message || 'client response write failed',
                    'CLIENT_DISCONNECTED',
                    { status: 499 },
                  ));
            }
          },
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
    let upstreamAccepted = false;
    let downstreamStarted = false;
    let leaseReleased = false;
    let cancelPromise = null;
    // 续跑丢弃的上一轮 reader：关闭动作是异步的，必须留引用等到 finally 再结算，
    // 否则「发出关闭」和「请求返回」会赛跑，测试里看到的就是连接仍然开着。
    const retiredReaders = [];
    let cancelKind = null;
    let canceling = false;
    let finished = false;
    let sequence = 0;
    let finishReason = null;
    let usage = null;
    let phase = 'opening';
    let sawDone = false;
    let warnedReasoningWhileDisabled = false;
    // 首个「可见」增量的时刻（正文/推理/工具调用任一）。decode 窗口从这里算起，
    // 与 dsh 的 t_firstToken 同口径。
    let firstVisibleAt = 0;
    const markVisible = () => { if (!firstVisibleAt) firstVisibleAt = now(); };
    let parser = null;
    let liveEncoder = null;
    const priorIds = new Set(prior.map((item) => item?.id));

    // 一轮上游请求的累加器：正文/推理缓存、结构化调用装配器、DSML 扫描器。
    // 截停续跑会把它们整组重建（见 resetRound），所以是 let 而不是 const。
    let visibleText = createResponseTextCache({ hardBytes });
    let reasoningText = createResponseTextCache({ hardBytes });
    let structured = createStructuredToolAssembler({
      maxBytes: structuredToolArgumentLimit(config.dsmlMaxBufferBytes, hardBytes),
    });
    let scanner = createDsmlScanner({
      maxBufferBytes: config.dsmlMaxBufferBytes,
    });
    // 推理通道单独一把扫描器：模型常把工具调用写进思考里，那条通道以前不过扫描器，
    // 于是原始标记既泄漏给用户，又少执行一次本该发生的调用。
    let reasoningScanner = createDsmlScanner({
      maxBufferBytes: config.dsmlMaxBufferBytes,
    });
    let dsmlCalls = [];

    /**
     * 重置成「一轮全新的上游请求」。
     *
     * 上面这些累加器原本按「一次请求」写死。截停续跑要再要一轮，而第二轮必须从零
     * 累积（否则 `scanner.finish()` 已经被调用过、正文会被拼进第一轮的缓存里，
     * 去重就无从下手）。第一轮在 `snapshot(true)` 里定格成 `firstResult` 之后调它。
     */
    function resetRound() {
      // 丢弃旧 reader 之前必须真的把它关掉。consumeSse 在 [DONE] 处退出时**不设**
      // readerDone，唯一的兜底是 finally 里的 `if (reader && !readerDone) cancelReader`，
      // 而它只看**当前** reader。这里一旦把引用置空，第一轮的上游 socket 就再没有
      // 任何代码能关，只能等内核回收。cancel 的 promise 单独收着，finally 里一并等待。
      if (reader && !readerDone) {
        const stale = reader;
        retiredReaders.push(
          Promise.resolve().then(() => stale.cancel('continuation round finished')).catch(() => {}),
        );
      }
      continuationRound = true;
      visibleText = createResponseTextCache({ hardBytes });
      reasoningText = createResponseTextCache({ hardBytes });
      structured = createStructuredToolAssembler({
        maxBytes: structuredToolArgumentLimit(config.dsmlMaxBufferBytes, hardBytes),
      });
      scanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
      reasoningScanner = createDsmlScanner({ maxBufferBytes: config.dsmlMaxBufferBytes });
      dsmlCalls = [];
      finishReason = null;
      usage = null;
      sawDone = false;
      parser = null;
      // 上一轮的 reader 已经读完；这一轮会新建一个，所以必须回到「未读完」，
      // 否则 cancelReader 会因为 readerDone 提前返回，取消时上游请求悬挂不关。
      reader = null;
      readerCancellation = null;
      readerDone = false;
    }

    // 已经续跑过的次数。上限 1：第二次仍是纯文字就必须收尾，否则就是死循环。
    let continuationCount = 0;
    /**
     * 当前这一轮是不是「续跑轮」。
     *
     * 续跑轮里正文**不**发 live 增量：第一轮的正文已经逐字流给客户端了，第二轮
     * 又要跟它去重合并（joinContinuationText），逐字再流一遍就是把同一句话发两遍，
     * 而且 settleRound 随后会用「更长的 live」覆盖终态，把去重结果又冲掉。
     * 所以续跑轮里终态是正文的唯一权威来源，由 cancelEvents 一次性补齐
     * （finalDeltas:false 会按 live 已发长度裁剪，这里正好只剩去重后的增量）。
     */
    let continuationRound = false;
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
      end(account, withClientKeyAttribution(result, clientKey, 'openai_responses'));
    }

    /**
     * 清定时器**并把引用置空**。
     *
     * 置空不是洁癖：`applyDocument` 用 `!finishGraceTimer` 判断「这一轮还没武装过
     * finishGrace」。只 clearTimeout 不置空，第二轮看到的是残留的 Timer 对象，
     * 于是永远不再武装 grace —— 上游已经把 finish_reason 发完了，请求却要继续
     * 挂到 idleTimeout 才收尾。凡是靠非空判据的定时器都必须在这里复位。
     */
    function clearTimers() {
      clearTimeout(firstByteTimer);
      clearTimeout(idleTimer);
      clearTimeout(totalTimer);
      clearTimeout(finishGraceTimer);
      clearInterval(pingTimer);
      firstByteTimer = null;
      idleTimer = null;
      totalTimer = null;
      finishGraceTimer = null;
      pingTimer = null;
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
          if (!sendWs(event)) return false;
        } catch (error) {
          if (['ERR_STREAM_WRITE_AFTER_END', 'EPIPE', 'ECONNRESET'].includes(error?.code)) {
            return false;
          }
          return false;
        }
      }
      return true;
    }

    function publishLive(events) {
      if (!events?.length) return true;
      if (transport === 'http') return emit(events);
      if (transport !== 'ws') return true;
      const published = publishWs(events);
      if (!published && !canceling) {
        void cancel('network_disconnect', runtimeError(
          'client websocket stopped accepting Responses events',
          'CLIENT_DISCONNECTED',
          { status: 499 },
        ));
      }
      return published;
    }

    function pushStructured(deltas) {
      try {
        structured.push(deltas);
      } catch (error) {
        throw runtimeError(
          error?.message || 'structured tool arguments are invalid',
          error?.code || 'UPSTREAM_INVALID_TOOL_CALL',
        );
      }
      // 工具调用同样是「可见内容」：dsh 的首 token 判定把它算在内。
      if (Array.isArray(deltas) ? deltas.length : Boolean(deltas)) markVisible();
    }

    function snapshot(final = false) {
      const snapshotValue = final ? structured.finish() : structured.snapshot();
      const calls = Array.isArray(snapshotValue) ? snapshotValue : (snapshotValue.calls || []);
      const invalidCalls = Array.isArray(snapshotValue) ? [] : (snapshotValue.invalid || []);
      const scanned = final ? scanner.finish() : { visibleText: '', calls: [], error: null };
      const scannedReasoning = final
        ? reasoningScanner.finish()
        : { visibleText: '', calls: [], error: null };
      const truncation = scanned.error?.code === 'DSML_TRUNCATED';
      if (scanned.error && !truncation) {
        throw runtimeError('upstream DSML tool call is malformed', scanned.error.code);
      }
      if (final) {
        // 推理通道的收尾与正文同口径：把缓冲里的可见尾巴补回去，把调用交给仲裁。
        if (scannedReasoning.calls.length) dsmlCalls.push(...scannedReasoning.calls);
        if (scannedReasoning.error) {
          warn(`Responses reasoning channel ended with ${scannedReasoning.error.code}`);
        } else if (scannedReasoning.visibleText && !prepared.reasoningSuppressed) {
          appendResponseText(reasoningText, scannedReasoning.visibleText);
        }
      }
      if (
        final
        && invalidCalls.length
        && (calls.length || !dsmlCalls.length)
      ) {
        throw runtimeError(
          'upstream produced an invalid structured tool call',
          'UPSTREAM_INVALID_TOOL_CALL',
        );
      }
      const arbitration = arbitrateToolCalls({
        structured: { calls, invalid: invalidCalls },
        dsml: [...dsmlCalls, ...(scanned.calls || [])],
        toolsDeclared: prepared.toolsDeclared,
        toolChoice: prepared.toolChoice,
        model: prepared.model,
        requestId: responseId,
        account,
        allowedToolNames: prepared.toolNames,
      });
      const selectedCalls = prepared.parallelToolCalls === false
        ? arbitration.calls.slice(0, 1)
        : arbitration.calls;
      if (final && scanned.visibleText) {
        appendResponseText(visibleText, scanned.visibleText);
      }
      const content = visibleText.value();
      const completion = conservativeTokenEstimate({
        text: content,
        tools: selectedCalls.map((call) => call.input),
      });
      return {
        content,
        reasoning: reasoningText.value(),
        calls: selectedCalls,
        callsComplete: !invalidCalls.length,
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
          // 上游把缓存命中放在两个位置之一，取第一个有值的。
          cached_tokens: Number(
            usage?.prompt_cache_hit_tokens
              ?? usage?.prompt_tokens_details?.cached_tokens
              ?? 0,
          ),
        },
        // 信封被截断时仍报 length：半截参数不构成可执行调用，客户端必须看到
        // incomplete 而不是「任务正常完成」——这是既有契约（见 responses.test.mjs
        // 「Responses DSML 流只发送完整工具调用」）。
        // 但 length 会被续跑判定挡在门外（它只认 stop），于是「模型把信封写进正文
        // 却没写完」这条最常见的截停路径既不续跑、又让用户以为回合正常结束。
        // 所以额外把截断这个事实传给判定层，由它决定要不要再要一轮。
        finishReason: truncation ? 'length' : finishReason,
        dsmlTruncated: truncation,
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
            request: prepared,
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
      const closedTypes = new Set(liveEncoder?.closedItemTypes?.() || []);
      const closedIds = new Set(
        (live?.output || [])
          .filter((item) => closedTypes.has(item.type))
          .map((item) => item.id),
      );
      alignLiveOutputIds(finalBody);
      const events = protocolEvents(finalBody, false).slice(2);
      for (const event of events) {
        // live 已经完整关闭的块，终态里的 done 系列一律跳过，避免同一 item 被关闭两次。
        const closedHere = closedIds.has(event.data.item?.id)
          || closedIds.has(event.data.item_id);
        const doneLike = event.type === 'response.output_item.done'
          || event.type.endsWith('_text.done')
          || event.type.endsWith('_part.done')
          || event.type.endsWith('_arguments.done')
          || event.type.endsWith('_input.done');
        if (closedHere && doneLike) {
          event.markRemoved = true;
          continue;
        }
        const duplicateLiveItem = live
          && event.type === 'response.output_item.added'
          && ['message', 'reasoning'].includes(event.data.item?.type);
        const duplicateLiveContent = live && (
          (
            event.type === 'response.content_part.added'
            && live.output.some((item) => item.type === 'message')
          )
          || (
            event.type === 'response.reasoning_summary_part.added'
            && live.output.some((item) => item.type === 'reasoning')
          )
        );
        if (duplicateLiveItem || duplicateLiveContent) {
          event.markRemoved = true;
          continue;
        }
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

    // live 的 output_index 按到达顺序分配，终态必须与它逐项对齐——
    // output_index 等于该 item 在 response.output 里的下标是同一条不变量。
    // 只搬 id 不搬顺序会让「正文先到」的响应出现流与终态错位（正文重复挂载）。
    function alignLiveOutputIds(finalBody) {
      const live = liveEncoder?.snapshot();
      if (!live?.output?.length) return finalBody;
      const head = finalBody.output.slice(0, prior.length);
      const tail = finalBody.output.slice(prior.length);
      // 同类型可能有多个块（并行工具调用），必须按**出现次序**配对，不能只按类型取第一个，
      // 否则两个 function_call 会拿到同一个 live id，身份就串了。
      const queues = new Map();
      for (const [position, liveItem] of live.output.entries()) {
        queueFor(liveItem.type).push({ liveItem, position });
      }
      function queueFor(type) {
        if (!queues.has(type)) queues.set(type, []);
        return queues.get(type);
      }
      // 带 live 身份的块按 live 顺序排在前面，其余（未走 live 的调用）保持原有相对顺序。
      const withLive = [];
      const withoutLive = [];
      for (const item of tail) {
        const queue = queues.get(item.type);
        const match = queue?.shift();
        if (match) withLive.push({ item, liveItem: match.liveItem, index: match.position });
        else withoutLive.push(item);
      }
      withLive.sort((a, b) => a.index - b.index);
      finalBody.output = [
        ...head,
        ...withLive.map((entry) => ({ ...entry.item, id: entry.liveItem.id })),
        ...withoutLive,
      ];
      return finalBody;
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
        if (live?.content) visibleText.set(live.content);
        if (live?.reasoning) reasoningText.set(live.reasoning);
        let retained = {
          content: visibleText.value(),
          reasoning: reasoningText.value(),
          calls: [],
          usage: {},
        };
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
          request: prepared,
        });
        failed.status = 'failed';
        if (transport === 'http' && body.stream === true) {
          if (downstreamStarted && writer && !writer.failed) {
            emit(cancelEvents(failed, {
              finalDeltas: !live?.content,
              finalReasoningDeltas: !live?.reasoning,
            }));
            if (!writer.end()) writer.fail(error);
          } else {
            writer?.fail(error);
          }
        } else if (transport === 'ws') {
          if (ensureWsLifecycle()) {
            publishWs(cancelEvents(failed, {
              finalDeltas: !live?.content,
              finalReasoningDeltas: !live?.reasoning,
            }));
          }
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
      if (downstreamStarted) return true;
      const isStream = body.stream === true || transport === 'ws';
      // ServerResponse emits 'close' once after the request has been read,
      // even when the client is still connected. Only a response that has
      // entered its writable lifecycle can indicate a lost downstream.
      if (transport === 'http') res?.on('close', onClose);
      response ||= initialResponse();
      if (!upstreamAccepted) return false;
      if (transport === 'ws') {
        if (!ensureWsLifecycle()) {
          void cancel('network_disconnect', runtimeError(
            'client websocket closed before Responses lifecycle events',
            'CLIENT_DISCONNECTED',
            { status: 499 },
          ));
          return false;
        }
        liveEncoder = createResponsesStreamEncoder({
          response,
          maxBytes: hardBytes,
          retain: 'error',
        });
        return true;
      }
      if (transport === 'http' && isStream) {
        // Do not commit a success status until the upstream has accepted the
        // request. Before this point a retryable account failure can still be
        // transparently retried by create().
        if (!upstreamAccepted) return;
        if (!canWriteHttp(res)) {
          void cancel('network_disconnect', runtimeError(
            'client disconnected before SSE response',
            'CLIENT_DISCONNECTED',
            { status: 499 },
          ));
          return false;
        }
        try {
          res.writeHead(200, streamHeaders());
        } catch (error) {
          void cancel('network_disconnect', runtimeError(
            error.message || 'client SSE response failed',
            'CLIENT_DISCONNECTED',
            { status: 499 },
          ));
          return false;
        }
        downstreamStarted = true;
        if (!emit(responseEvents({ response }).slice(0, 2))) {
          return false;
        }
        if (writer?.failed || writer?.ended || canceling) return false;
        liveEncoder = createResponsesStreamEncoder({
          response,
          maxBytes: hardBytes,
          retain: 'error',
        });
        pingTimer = setInterval(keepalive, keepaliveMs);
        pingTimer.unref?.();
        return true;
      }
      downstreamStarted = true;
      return true;
    }

    function initialResponse() {
      return baseResponse({
        id: responseId,
        model: prepared.model,
        createdAt,
        output: prior,
        store: body.store === true,
        previousResponseId,
        request: prepared,
      });
    }

    function ensureWsLifecycle() {
      if (transport !== 'ws') return false;
      if (downstreamStarted) return true;
      response ||= initialResponse();
      if (!publishWs(responseEvents({ response }).slice(0, 2))) return false;
      downstreamStarted = true;
      return true;
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

    // 整个请求的总预算到期时刻。续跑复用它，**不是**给第二轮一份新预算：
    // 一次客户端请求只有一个 totalTimeoutMs（handoff §4.2）。
    let totalDeadline = 0;

    function armTotal() {
      if (!config.totalTimeoutMs) return;
      clearTimeout(totalTimer);
      totalTimer = null;
      totalDeadline ||= now() + config.totalTimeoutMs;
      const remaining = Math.max(0, totalDeadline - now());
      totalTimer = setTimeout(() => timeout(
        'total_timeout',
        runtimeError('upstream request exceeded its total timeout', 'UPSTREAM_TIMEOUT', { status: 504 }),
      ), remaining);
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
      const storedInput = Array.isArray(history) ? [...history] : [];
      if (typeof body.instructions === 'string' && body.instructions) {
        storedInput.unshift({
          type: 'message',
          role: 'system',
          content: [{ type: 'input_text', text: body.instructions }],
        });
      }
      if (typeof body.input === 'string') {
        storedInput.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: body.input }],
        });
      } else if (Array.isArray(body.input)) {
        storedInput.push(...body.input);
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
        body: {
          ...finalBody,
          store: true,
          _bridgeInput: storedInput,
          _bridgeMeta: { version: 1, outputOffset: prior.length },
        },
        usage: result.usage,
        partial: { content: result.content, toolCalls: result.calls },
      }, saveOptions);
      return canceled ? {
        ok: persisted.ok,
        ...(persisted.error ? { error: persisted.error } : {}),
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
        if (live?.content) visibleText.set(live.content);
        if (live?.reasoning) reasoningText.set(live.reasoning);
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
              request: prepared,
            });
            cancelBody.output = mergePartialOutput(cancelBody.output, partial);
            alignLiveOutputIds(cancelBody);
            const persisted = await persistFinal(cancelBody, retained, true);
            if (persisted.deadLetterWritten) {
              warn(`canceled Responses fragment written to dead letter: ${responseId}`);
            }
            finished = true;
            writer?.fail(reason || writer?.failed);
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
            writer?.fail(error);
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
      // Network disconnects must stop future writes but a realtime terminal
      // event is only sent after cancellation persistence succeeds. Other
      // explicit interrupts keep the writer usable for the same contract.
      // Abort the upstream first, but keep the writer open until persistence
      // has produced either a durable incomplete record or a failed terminal.
      if (forceWriter && kind === 'backpressure') writer?.fail(reason);
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
            request: prepared,
          });
          cancelBody.reasoning = retained.reasoning || '';
          cancelBody.calls = retained.calls || [];
          cancelBody.output = mergePartialOutput(cancelBody.output, partial);
          alignLiveOutputIds(cancelBody);
          persisted = await persistFinal(cancelBody, retained, true);
          if (!persisted.ok && !persisted.skipped) {
            finished = true;
            const failed = completedResponseBody({
              id: responseId,
              model: prepared.model,
              createdAt,
              prior,
              reasoning: retained.reasoning,
              content: retained.content,
              calls: retained.callsComplete ? retained.calls : [],
              registry: prepared.tools,
              usage: retained.usage,
              error: {
                code: 'CANCELLATION_PERSISTENCE_FAILED',
                message: persisted.error?.message || 'cancellation persistence failed',
              },
              previousResponseId,
              request: prepared,
            });
            failed.status = 'failed';
            if (transport === 'ws') {
              const live = liveEncoder?.snapshot();
              publishWs(cancelEvents(failed, {
                finalDeltas: !live?.content,
                finalReasoningDeltas: !live?.reasoning,
              }));
            } else if (downstreamStarted && canWriteHttp(res)) {
              const failedEvents = protocolEvents(failed, false).slice(2);
              for (const event of failedEvents) {
                emit([event]);
              }
              if (!writer.end()) writer.fail(persisted.error);
            } else {
              writer?.fail(persisted.error);
            }
            return {
              ok: false,
              canceled: true,
              responseId,
              kind,
              persistence: persisted,
            };
          }
          cancelBody = {
            ...cancelBody,
            store: persisted.ok === true,
          };
          if (persisted.deadLetterWritten) {
            warn(`canceled Responses fragment written to dead letter: ${responseId}`);
          }
          finished = true;
          if (transport === 'ws') {
            const live = liveEncoder?.snapshot();
            if (ensureWsLifecycle()) {
              publishWs(cancelEvents(cancelBody, {
                finalDeltas: !live?.content,
                finalReasoningDeltas: !live?.reasoning,
              }));
            }
          } else if (downstreamStarted && writer && !writer.failed && canWriteHttp(res)) {
            emit(cancelEvents(cancelBody, { finalDeltas: true }));
            if (!writer.end()) writer.fail(reason);
          } else {
            writer?.fail(reason);
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
      const signalReason = interruptSignal?.reason;
      const kind = signalReason?.cancelKind || 'interrupt';
      const message = signalReason?.message || 'response interrupted';
      void cancel(kind, runtimeError(String(message), 'CANCELED'));
    };
    req?.once('aborted', onClose);
    interruptSignal?.addEventListener('abort', onAbort, { once: true });
    if (interruptSignal?.aborted) onAbort();

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

    /**
     * 推理通道的清洗：只把可见文本交出去，DSML 调用合并进 dsmlCalls。
     *
     * 与正文通道的差别在于失败策略——推理是辅助通道，畸形片段只丢不判整轮失败，
     * 否则一段跑偏的思考会把本来能成功的回合打成 502。
     */
    function applyReasoningDocument(text) {
      if (!text) return;
      if (prepared.reasoningSuppressed && !warnedReasoningWhileDisabled) {
        warnedReasoningWhileDisabled = true;
        warn(
          `Responses request ${responseId} received reasoning content while `
          + 'reasoning_effort was none; the model may not honor none',
        );
      }
      const scannedReasoning = reasoningScanner.push(text);
      if (scannedReasoning.calls.length) {
        dsmlCalls.push(...scannedReasoning.calls);
        phase = 'tool_call';
      }
      if (scannedReasoning.error) {
        warn(`Responses reasoning channel carried malformed DSML: ${scannedReasoning.error.code}`);
        return;
      }
      if (prepared.reasoningSuppressed || !scannedReasoning.visibleText) return;
      markVisible();
      appendResponseText(reasoningText, scannedReasoning.visibleText);
      // 与正文同口径：续跑轮不发 live 增量，终态是唯一权威来源。
      // 不这样做的话，两轮的推理被 live 首尾相接发出去，而终态是「第一轮\n\n第二轮」，
      // cancelEvents 按 live 长度裁剪终态增量，拼起来就是「…乙。乙。」——增量与终态
      // 对不上，而且 mergeReasoning 那一侧还要再拼一次分隔符。
      if (!continuationRound) {
        publishLive(liveEncoder?.reasoningDelta(scannedReasoning.visibleText));
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
        applyReasoningDocument(payload.reasoning_content);
      }
      if (Array.isArray(payload.tool_calls)) {
        pushStructured(payload.tool_calls);
        phase = 'tool_call';
      }
      const content = typeof payload.content === 'string'
        ? payload.content
        : Array.isArray(payload.content)
          ? payload.content.map((part) => part?.type === 'text' ? part.text || '' : '').join('')
          : '';
      if (content) {
        const scanned = scanner.push(content);
        if (scanned.error) throw runtimeError(
          'upstream DSML tool call is malformed',
          scanned.error.code,
        );
        if (scanned.calls.length) {
          dsmlCalls.push(...scanned.calls);
          phase = 'tool_call';
          markVisible();
        }
        if (scanned.visibleText) {
          markVisible();
          appendResponseText(visibleText, scanned.visibleText);
          // 续跑轮次不发正文 live 增量：第二轮与第一轮的正文要去重合并，逐字流出
          // 会重复，而且会让 settleRound 用更长的 live 覆盖掉去重后的终态。
          if (liveEncoder && !continuationRound) {
            publishLive(liveEncoder.textDelta(scanned.visibleText));
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
        if (cancelKind || controller.signal.aborted) {
          return await (cancelPromise || cancel('interrupt', runtimeError(
            'response canceled before startup',
            'CANCELED',
          )));
        }
        let credentials = readCredentials(account, { now: now() });
        if (!credentials?.ok) throw runtimeError(
          'WorkBuddy account has no usable credentials',
          'AUTH_REQUIRED',
          { status: 401, type: 'authentication_error', retryable: true },
        );
        if (credentials.needsRefresh) credentials = await refresh(account, credentials);
        applyReasoningEffort(prepared, account, credentials);
        armTotal();

        /**
         * 发一轮上游请求并把它读完。
         *
         * 续跑复用这里：**同一账号、同一租约**，绝不重新 pick（那会让号池算错账）。
         * 总预算每一轮都重新武装，但**截止时刻固定**（totalDeadline 只取一次），
         * 所以续跑花的是同一个 totalTimeoutMs 里剩下的时间，而不是一份新预算。
         */
        async function requestRound(body) {
          armFirstByte();
          armTotal();
          let upstream = await upstreamClient.chat({
            accountId: account,
            credentials,
            model: prepared.model,
            body,
            sanitize: config.channelSanitize,
            signal: controller.signal,
          });
          if (upstream.status === 401 && credentials.refreshToken) {
            credentials = await refresh(account, credentials);
            // 换号后目录可能完全不同，档位必须按新账号的模型声明重解析。
            applyReasoningEffort(prepared, account, credentials);
            upstream = await upstreamClient.chat({
              accountId: account,
              credentials,
              model: prepared.model,
              body,
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
          upstreamAccepted = true;
          // A streaming HTTP response becomes visible only after the upstream
          // accepted the request, preserving pre-header failover semantics.
          start();
          if (String(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
            await consumeSse(upstream);
          } else {
            clearTimeout(firstByteTimer);
            let document;
            try {
              document = await upstream.json();
            } catch {
              throw runtimeError(
                'upstream returned invalid completion JSON',
                'UPSTREAM_PROTOCOL_ERROR',
              );
            }
            applyDocument(document);
          }
          if (cancelKind) return 'canceled';
          if (!finishReason && !sawDone) {
            throw runtimeError('upstream ended without a finish reason', 'UPSTREAM_TRUNCATED');
          }
          return 'ok';
        }

        if (await requestRound(prepared.body) === 'canceled') return await cancelPromise;
        clearTimers();
        /**
         * 定稿一轮：scanner.finish() 收尾，取 live 里更长的正文，
         * 再按 parallel_tool_calls 截断。
         */
        function settleRound() {
          const value = snapshot(true);
          // live 只是「已经流出去的那部分」；scanner.finish() 之后的终态可能更长
          // （缓冲区里还有可见尾巴），用它覆盖会把尾巴吞掉，所以只在 live 更长时取 live。
          //
          // 续跑轮次必须跳过正文这一步：liveEncoder 不随轮次重置，它手里的正文是
          // **第一轮**的累积。用它覆盖第二轮，得到的就是第一轮的原文，
          // joinContinuationText 的去重结果被原地冲掉（这正是「流式重复一遍、
          // 非流式不重复」的成因）。
          //
          // 推理通道同理，且**只改终态取值、不改外发的 live 增量**：live 里的推理是
          // 第一轮 + 第二轮首尾相接的累积，拿它盖第二轮的推理，mergeReasoning 拼接时
          // 第一轮那段就会出现两次。
          const live = liveEncoder?.snapshot();
          if (live?.content && !continuationRound && live.content.length > value.content.length) {
            value.content = live.content;
          }
          if (live?.reasoning && !continuationRound && live.reasoning.length > value.reasoning.length) {
            value.reasoning = live.reasoning;
          }
          if (value.calls.length > 1 && prepared.parallelToolCalls === false) {
            value.calls = value.calls.slice(0, 1);
          }
          return value;
        }

        let result = settleRound();

        // ---------------------------------------------------------------- 截停续跑
        //
        // 到这里 finish_reason/正文/工具调用都齐了。如果模型只宣布了下一步却没有发
        // 工具调用，客户端会当作任务结束；判定层级能做的补救就是**再要一轮**。
        // 判定刻意保守（见 continuation-retry.js）：宁可少续一次，也不误续——误续
        // 会让用户永远收不到最终答复。
        const continuation = shouldContinueTurn({
          enabled: continuationRetryEnabled(config),
          finishReason: result.finishReason,
          toolsDeclared: prepared.toolsDeclared,
          toolChoice: prepared.toolChoice,
          callCount: result.calls.length,
          content: result.content,
          retries: continuationCount,
          maxRetries: 1,
          dsmlTruncated: result.dsmlTruncated === true,
        });
        if (continuation.retry) {
          continuationCount += 1;
          countContinuation({ cut: 1 });
          debug(`Responses ${responseId} turn cut after "${result.content.slice(-80)}"; retrying`);
          const first = result;
          // 第二轮从零累积，第一轮的产物先收进 first。
          resetRound();
          prepared.body.messages ??= [];
          prepared.body.messages.push({
            role: 'user',
            content: CONTINUATION_RETRY_PROMPT,
          });
          countContinuation({ retried: 1 });
          const outcome = await requestRound(prepared.body);
          if (outcome === 'canceled') return await cancelPromise;
          clearTimers();
          const second = settleRound();
          // 两轮拼成一份终态：正文去重、推理接续、调用合并、token 累加。
          result = {
            content: joinContinuationText(first.content, second.content),
            reasoning: mergeReasoning(first.reasoning, second.reasoning),
            calls: mergeToolCalls(first.calls, second.calls, { requestId: responseId }),
            callsComplete: first.callsComplete && second.callsComplete,
            usage: mergeUsage(first.usage, second.usage),
            finishReason: second.finishReason,
          };
          if (second.calls.length) countContinuation({ rescued: 1 });
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
          request: prepared,
        });
        // 先关闭 live 的推理块，再对齐终态；终态里同源的 done 事件由 cancelEvents 去掉。
        publishLive(liveEncoder?.reasoningSummaryDone());
        alignLiveOutputIds(finalBody);
        release({
          ok: true,
          code: 'OK',
          durationMs: now() - requestStarted,
          meta: {
            model: prepared.model,
            // 与 dsh 的 decodeTokens/decodeMs 同口径：首增量 → 结束。
            ttftMs: firstVisibleAt ? firstVisibleAt - requestStarted : 0,
            decodeMs: firstVisibleAt ? now() - firstVisibleAt : 0,
            usage: {
              input_tokens: result.usage.prompt_tokens,
              output_tokens: result.usage.completion_tokens,
              // 号池按 cache_read_input_tokens / cache_creation_input_tokens 记账；
              // 这里不漏字段，面板的缓存命中率才不会恒为 0。
              cache_read_input_tokens: Math.max(0, Number(result.usage.cached_tokens) || 0),
              cache_creation_input_tokens: 0,
            },
          },
        });
        if (body.store && config.responsesPersistence) {
          const persisted = await persistFinal(finalBody, result, false);
          if (persisted.ok) finalBody.store = true;
          else if (persisted.skipped) finalBody.store = false;
          else warn(`Responses fragment persistence failed: ${persisted.error?.code || ''}`);
        }
        if (transport === 'http') {
          if (body.stream === true) {
            const emitted = emit(cancelEvents(finalBody, {
              finalDeltas: false,
              finalReasoningDeltas: false,
            }));
            if (cancelKind || canceling) return cancelPromise;
            if (!emitted) {
              return cancel('network_disconnect', runtimeError(
                writer?.failed?.message || 'client disconnected during SSE finish',
                'CLIENT_DISCONNECTED',
                { status: 499 },
              ));
            }
            if (!writer?.end()) {
              if (writer?.failed || !canWriteHttp(res)) {
                return cancel('network_disconnect', runtimeError(
                  writer?.failed?.message || 'client disconnected during SSE finish',
                  'CLIENT_DISCONNECTED',
                  { status: 499 },
                ));
              }
            }
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
          publishWs(cancelEvents(finalBody, {
            finalDeltas: false,
            finalReasoningDeltas: false,
          }));
        }
        finished = true;
        const callback = { ok: true, response: finalBody, responseId };
        try {
          onDone?.(callback);
        } catch (error) {
          warn(`Responses completion callback failed: ${error.message}`);
        }
        return callback;
      } catch (error) {
        if (cancelKind) return cancelPromise;
        if (
          error?.code === 'OUTPUT_TOO_LARGE'
          && (transport === 'ws' || body.stream === true)
        ) {
          return cancel('backpressure', runtimeError(
            'Responses output exceeded the hard send budget',
            'BACKPRESSURE_OVERFLOW',
          ));
        }
        const failureCode = ['SSE_BUFFER_LIMIT', 'OUTPUT_TOO_LARGE', 'TOOL_ARGUMENT_LIMIT']
          .includes(error?.code)
          ? error.code
          : 'INTERNAL_ERROR';
        const failure = error instanceof ApiError
          ? error
          : runtimeError(error.message || 'internal error', failureCode);
        finished = true;
        clearTimers();
        release({
          ok: false,
          code: failure.code || 'INTERNAL_ERROR',
          error: `${failure.message} ${failure.code || ''}`,
          durationMs: now() - requestStarted,
          meta: { model: prepared.model, usage: {} },
        });
        if (upstreamAccepted && body.stream === true && res?.headersSent) {
          const failed = completedResponseBody({
            id: responseId,
            model: prepared.model,
            createdAt,
            prior,
            error: { code: failure.code || 'internal_error', message: failure.message },
            previousResponseId,
            request: prepared,
          });
          failed.status = 'failed';
          // 这里必须走 cancelEvents 而不是裸的 protocolEvents：live 增量早就把
          // output_item.added / content_part.added 发出去了，整段重放会让同一个
          // output_index 出现两次 added（Responses SSE 的不变量要求每个 index 只有
          // 一次），严格客户端会挂两个 item 或直接报协议错。cancelEvents 已有
          // 对 live 已发帧的去重与 output_index 对齐，错误收尾复用同一套。
          emit(cancelEvents(failed, {
            finalDeltas: !liveEncoder?.snapshot().content,
            finalReasoningDeltas: !liveEncoder?.snapshot().reasoning,
          }));
        }
        if (transport === 'ws') {
          const failed = completedResponseBody({
            id: responseId,
            model: prepared.model,
            createdAt,
            prior,
            error: { code: failure.code || 'internal_error', message: failure.message },
            previousResponseId,
            request: prepared,
          });
          failed.status = 'failed';
          publishWs(cancelEvents(failed, {
            finalDeltas: !liveEncoder?.snapshot().content,
            finalReasoningDeltas: !liveEncoder?.snapshot().reasoning,
          }));
        }
        if (res?.headersSent) {
          if (writer?.failed) writer.fail(failure);
          else writer?.end();
        }
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
        interruptSignal?.removeEventListener?.('abort', onAbort);
        if (reader && !readerDone) cancelReader(controller.signal.reason || 'request finished');
        await withTimeout(readerCancellation, 1000, 'upstream reader close timed out').catch(() => {});
        // 续跑丢掉的旧 reader 也要结算，否则第一轮的上游连接会活过这次请求。
        await withTimeout(
          Promise.all(retiredReaders),
          1000,
          'retired upstream reader close timed out',
        ).catch(() => {});
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
      fail: terminalFailure,
      responseId,
    };
  }

  async function execute({
    req,
    res,
    body,
    config,
    account,
    clientKey = null,
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
      continuationNudge: continuationNudgeApplies({
        mode: continuationNudgeMode(config),
        headers: req?.headers || null,
        body,
        hasToolLoop: responsesHasToolLoop(body),
        protocol: 'responses',
      }),
    });
    let attempt;
    try {
      attempt = await setupAttempt({
        onAttempt,
        req,
        res,
        body,
        config,
        account,
        prepared,
        previousResponseId,
        prior,
        history,
        clientKey,
        transport,
        interruptSignal,
        sendWs,
        onDone,
      });
    } catch (error) {
      end(account, withClientKeyAttribution({
        ok: false,
        code: error?.code || 'SETUP_ERROR',
        error: error?.message || 'Responses attempt setup failed',
        durationMs: 0,
        meta: { model: prepared?.model || config?.defaultModel || '', usage: {} },
      }, clientKey, 'openai_responses'));
      throw error;
    }

    return attempt.run();
  }

  async function create({ req, res, body, config, clientKey = null }) {
    await ensureDeadLetterRetry();
    const persistence = Boolean(config.responsesPersistence);
    const previous = await loadHistory(body?.previous_response_id, persistence);
    const prepared = prepareResponsesRequest(body, {
      defaultModel: config.defaultModel,
      toolsEnabled: config.tools,
      history: previous.messages,
      continuationNudge: continuationNudgeApplies({
        mode: continuationNudgeMode(config),
        headers: req?.headers || null,
        body,
        hasToolLoop: responsesHasToolLoop(body),
        protocol: 'responses',
      }),
    });
    if (body?.stream === true && !config.streaming) {
      throw new ApiError(400, 'streaming is disabled', { code: 'streaming_disabled' });
    }
    const pool = poolLoader();
    const tried = [];
    let last = null;
    for (let attempt = 0; attempt < Math.max(1, Math.min(pool.maxAttempts || 3, 5)); attempt += 1) {
      const picked = pick({ exclude: tried, model: prepared.model });
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
        clientKey,
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
    const { _bridgeInput, _bridgeMeta, ...body } = record.body || {};
    return body;
  }

  async function destroy() {
    await store.close?.();
  }

  function wsSession({ ws = null, send, config, onResponse, clientKey = null }) {
    let controller = null;
    let attempt = null;
    let running = null;
    let closed = false;
    let parent = Promise.resolve();

    async function waitForAttempt() {
      if (!running) return true;
      try {
        await withTimeout(running, cancelWaitMs, 'WS response cancellation timed out');
        return true;
      } catch (error) {
        warn(`WS response cancellation did not settle: ${error.message}`);
        return false;
      }
    }

    async function interrupt(reason = 'response.interrupt', kind = 'interrupt') {
      const hasActiveRequest = Boolean(controller || attempt || running);
      const cancellation = attempt?.cancel(kind, runtimeError(
        String(reason),
        kind === 'backpressure' ? 'BACKPRESSURE_OVERFLOW' : 'CANCELED',
      ));
      // Signal setup before the attempt exists as well as the active request.
      // Cancel first so abort listeners observe the precise cancellation kind.
      if (hasActiveRequest) {
        controller?.abort({ cancelKind: kind, message: String(reason) });
      }
      void cancellation;
      const settled = await waitForAttempt();
      if (settled && !running) controller = null;
      return settled;
    }

    async function executeCommand(command) {
      if (closed) return;
      if (running && !(await interrupt('replaced response'))) {
        closed = true;
        send({
          type: 'error',
          error: {
            code: 'cancellation_timeout',
            message: 'previous response cancellation did not settle',
          },
        });
        ws?.close?.(1011, 'cancellation timeout');
        return;
      }
      controller = new AbortController();
      let history;
      try {
        history = await loadHistory(command.previous_response_id, config.responsesPersistence);
      } catch (error) {
        send({ type: 'error', error: { code: error.code || 'invalid_request', message: error.message } });
        return;
      }
      if (closed) return;
      let prepared;
      try {
        prepared = prepareResponsesRequest(command, {
          defaultModel: config.defaultModel,
          toolsEnabled: config.tools,
          history: history.messages,
          // WebSocket 会话拿不到 HTTP 请求头，靠 client_metadata 与工具往返识别。
          continuationNudge: continuationNudgeApplies({
            mode: continuationNudgeMode(config),
            body: command,
            hasToolLoop: responsesHasToolLoop(command),
          }),
        });
      } catch (error) {
        send({ type: 'error', error: { code: error.code || 'invalid_request', message: error.message } });
        return;
      }
      const picked = pick({ exclude: [], model: prepared.model });
      if (!picked.name) {
        send({ type: 'error', error: { code: 'POOL_EMPTY', message: '号池没有可用账号' } });
        return;
      }
      begin(picked.name);
      let current;
      try {
        current = await setupAttempt({
          body: command,
          config,
          account: picked.name,
          prepared,
          previousResponseId: command.previous_response_id || null,
          prior: history.prior,
          history: history.messages,
          clientKey,
          transport: 'ws',
          interruptSignal: controller.signal,
          sendWs: send,
          onDone: (result) => onResponse?.(result),
        });
      } catch (error) {
        end(picked.name, withClientKeyAttribution({
          ok: false,
          code: error?.code || 'SETUP_ERROR',
          error: error?.message || 'Responses WebSocket setup failed',
          durationMs: 0,
          meta: { model: prepared.model, usage: {} },
        }, clientKey, 'openai_responses'));
        throw error;
      }
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
        if (closed) return;
        if (!command || typeof command !== 'object') {
          send({ type: 'error', error: { code: 'invalid_command', message: 'JSON object required' } });
          return;
        }
        const type = command.type || 'response.create';
        if (type !== 'response.create') {
          send({ type: 'error', error: { code: 'unsupported_command', message: `unknown command ${type}` } });
          return;
        }
        void interrupt('replaced response').then((settled) => {
          if (!settled) {
            closed = true;
            send({
              type: 'error',
              error: {
                code: 'cancellation_timeout',
                message: 'previous response cancellation did not settle',
              },
            });
            ws?.close?.(1011, 'cancellation timeout');
            return;
          }
          return enqueue(command);
        }).catch((error) => {
          send({
            type: 'error',
            error: { code: error.code || 'internal_error', message: error.message },
          });
        });
      },
      interrupt() {
        void interrupt().then((settled) => {
          if (!settled) {
            closed = true;
            send({
              type: 'error',
              error: {
                code: 'cancellation_timeout',
                message: 'response cancellation did not settle',
              },
            });
            ws?.close?.(1011, 'cancellation timeout');
          }
        });
      },
      async close(info = {}) {
        closed = true;
        if (info.kind === 'heartbeat_timeout' && attempt?.fail) {
          const failure = runtimeError(
            'WebSocket heartbeat timed out',
            'WEB_SOCKET_HEARTBEAT_TIMEOUT',
            { status: 504 },
          );
          await attempt.fail('heartbeat_timeout', failure);
          await waitForAttempt();
          if (!running) controller = null;
          return;
        }
        const kind = info.kind === 'peer_close' ? 'ws_close' : 'network_disconnect';
        await interrupt('ws close', kind);
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
