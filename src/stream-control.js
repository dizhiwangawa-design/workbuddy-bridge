import { encodeSseEvent } from './sse.js';
import { warn } from './log.js';

export const PRODUCTION_KEEPALIVE_MS = Object.freeze(15000);
export const SOFT_WRITE_BYTES = 256 * 1024;
export const HARD_WRITE_BYTES = 1024 * 1024;
export const MAX_RETAINED_TEXT_BYTES = 256 * 1024;
export const UPSTREAM_LENGTH_LIMIT = 'upstream_length_limit';

const WRITE_ERROR_CODES = new Set([
  'ERR_STREAM_WRITE_AFTER_END',
  'ERR_STREAM_DESTROYED',
  'EPIPE',
  'ECONNRESET',
]);

export function isWriteError(error) {
  return WRITE_ERROR_CODES.has(error?.code);
}

export function canWriteHttp(res) {
  return Boolean(
    res
    && res.writable === true
    && !res.destroyed
    && !res.writableEnded,
  );
}

/** Keep a bounded trailing window without starting with a broken UTF-8 code point. */
export function utf8Tail(value, maxBytes = MAX_RETAINED_TEXT_BYTES) {
  const text = String(value ?? '');
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= limit) return text;
  let start = encoded.length - limit;
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

/** Keep a bounded leading window without splitting a UTF-8 code point. */
export function utf8Prefix(value, maxBytes = MAX_RETAINED_TEXT_BYTES) {
  const text = String(value ?? '');
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  const encoded = Buffer.from(text, 'utf8');
  if (encoded.length <= limit) return text;
  let end = 0;
  while (end < encoded.length) {
    const first = encoded[end];
    const width = first < 0x80
      ? 1
      : first < 0xe0
        ? 2
        : first < 0xf0
          ? 3
          : 4;
    if (end + width > limit) break;
    end += width;
  }
  return encoded.subarray(0, end).toString('utf8');
}

export function appendTextWithinLimit(current, delta, {
  maxBytes = MAX_RETAINED_TEXT_BYTES,
  retain = 'tail',
} = {}) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  const next = `${current || ''}${delta || ''}`;
  if (Buffer.byteLength(next, 'utf8') <= limit) return next;
  if (retain === 'tail') return utf8Tail(next, limit);
  if (retain === 'error') {
    throw Object.assign(new Error(`output exceeded ${limit} bytes`), {
      code: 'OUTPUT_TOO_LARGE',
    });
  }
  throw new Error(`unsupported retain mode: ${retain}`);
}

/** Incremental output cache. Tail mode keeps memory bounded without copying
 * the retained window on every token; error mode fails closed on overflow. */
export function createTextCache({
  maxBytes = MAX_RETAINED_TEXT_BYTES,
  retain = 'tail',
} = {}) {
  const limit = Number(maxBytes);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('maxBytes must be a positive integer');
  }
  if (retain !== 'tail' && retain !== 'error') {
    throw new Error(`unsupported retain mode: ${retain}`);
  }
  let chunks = [];
  let head = 0;
  let bytes = 0;
  let cached = null;

  function compact() {
    if (head > 1024 && head * 2 > chunks.length) {
      chunks = chunks.slice(head);
      head = 0;
    }
  }

  function trimTail() {
    while (head < chunks.length && bytes - chunks[head].bytes >= limit) {
      bytes -= chunks[head].bytes;
      head += 1;
    }
    if (bytes > limit) {
      const first = chunks[head];
      const keep = Math.max(0, limit - (bytes - first.bytes));
      const text = utf8Tail(first.text, Math.max(1, keep));
      chunks[head] = { text, bytes: Buffer.byteLength(text, 'utf8') };
      bytes = chunks.slice(head).reduce((total, item) => total + item.bytes, 0);
    }
    compact();
  }

  function append(delta) {
    const text = String(delta ?? '');
    if (!text) return;
    const length = Buffer.byteLength(text, 'utf8');
    if (retain === 'error' && bytes + length > limit) {
      throw Object.assign(new Error(`output exceeded ${limit} bytes`), {
        code: 'OUTPUT_TOO_LARGE',
      });
    }
    chunks.push({ text, bytes: length });
    bytes += length;
    cached = null;
    if (retain === 'tail') trimTail();
  }

  return {
    append,
    set(value) {
      chunks = [];
      head = 0;
      bytes = 0;
      cached = null;
      append(value);
    },
    value() {
      if (cached === null) {
        cached = chunks.slice(head).map((item) => item.text).join('');
      }
      return cached;
    },
    get bytes() {
      return bytes;
    },
  };
}

export function protocolIncompleteReason(finishReason, requestedLimit, atLimit = false) {
  if (finishReason !== 'length') return null;
  return requestedLimit && atLimit ? 'max_output_tokens' : UPSTREAM_LENGTH_LIMIT;
}

export function createHttpEventWriter(res, {
  protocol = 'openai',
  softBytes = SOFT_WRITE_BYTES,
  hardBytes = HARD_WRITE_BYTES,
  onOverflow = null,
  onWriteFailure = null,
  canWrite = () => canWriteHttp(res),
} = {}) {
  let ended = false;
  let failed = null;
  let peakWritableLength = 0;
  let peakPendingBytes = 0;
  let pendingBytes = 0;
  let oldestPendingAt = 0;
  let slowSince = 0;
  let backpressureSeen = false;
  let overflowReported = false;
  let timer = null;
  let writeFailureNotified = false;

  function notifyWriteFailure(error) {
    if (writeFailureNotified || !error) return;
    writeFailureNotified = true;
    try {
      onWriteFailure?.(error);
    } catch (cause) {
      warn(`${protocol} write failure callback failed: ${cause.message}`);
    }
  }

  function markFailure(error) {
    if (!error) return;
    failed ||= error;
    ended = true;
    stopTimer();
    notifyWriteFailure(failed);
  }

  function clientDisconnectedError() {
    return Object.assign(new Error('client response is no longer writable'), {
      code: 'CLIENT_DISCONNECTED',
    });
  }

  function onStreamError(error) {
    if (!isWriteError(error)) warn(`${protocol} stream write failed: ${error.message}`);
    markFailure(error);
  }

  res.on?.('error', onStreamError);
  res.once?.('close', () => {
    res.off?.('error', onStreamError);
  });

  function observe(force = false) {
    const queued = Number(res.writableLength || 0);
    peakWritableLength = Math.max(peakWritableLength, queued);
    peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
    const elapsed = oldestPendingAt ? Date.now() - oldestPendingAt : 0;
    if (force || (
      queued >= Number(hardBytes)
      || pendingBytes >= Number(hardBytes)
      || (pendingBytes > Number(softBytes) && elapsed >= 5000)
    )) {
      if (overflowReported) return false;
      overflowReported = true;
      const error = Object.assign(new Error('client stream paused beyond the hard send limit'), {
        code: 'BACKPRESSURE_OVERFLOW',
      });
      failed ||= error;
      try {
        onOverflow?.(error);
      } catch (cause) {
        warn(`backpressure callback failed: ${cause.message}`);
      }
      return false;
    }
    if (queued >= Number(softBytes) || res.writableNeedDrain === true) backpressureSeen = true;
    if (backpressureSeen && !timer) {
      timer = setTimeout(slowTick, 200);
      timer.unref?.();
    }
    return true;
  }

  function writeRaw(raw) {
    if (ended || failed) return false;
    if (!canWrite()) {
      markFailure(clientDisconnectedError());
      return false;
    }
    const length = Buffer.byteLength(raw);
    // Check the next payload before it enters the socket queue. A stalled
    // socket can expose only a small writableLength while its peer has
    // already accepted megabytes of pending data.
    if (
      Number(res.writableLength || 0) + pendingBytes + length
      > Number(hardBytes)
    ) {
      observe(true);
      return false;
    }
    stopTimer();
    pendingBytes += length;
    if (!oldestPendingAt) oldestPendingAt = Date.now();
    try {
      const accepted = res.write(raw, (error) => {
        if (error) markFailure(error);
        pendingBytes = Math.max(0, pendingBytes - length);
        if (!pendingBytes) {
          oldestPendingAt = 0;
          slowSince = 0;
        }
      });
      if (failed) return false;
      if (accepted === false) {
        normalSince = 0;
        backpressureSeen = true;
      }
      if (accepted === false && !overflowReported && !timer) {
        timer = setTimeout(normalTick, 50);
        timer.unref?.();
      }
      let result = observe();
      if (result && backpressureSeen && !timer) {
        timer = setTimeout(tick, 250);
        timer.unref?.();
      }
      return result;
    } catch (error) {
      pendingBytes = Math.max(0, pendingBytes - length);
      if (!pendingBytes) oldestPendingAt = 0;
      if (!isWriteError(error)) warn(`${protocol} stream write failed: ${error.message}`);
      markFailure(error);
      return false;
    }
  }

  function normalTick() {
    timer = null;
    if (!ended && !failed && !overflowReported) {
      const queued = Number(res.writableLength || 0);
      if (queued > Number(softBytes)) {
        observe();
        return;
      }
      normalSince += 50;
      if (normalSince >= 500) {
        observe();
        return;
      }
      timer = setTimeout(normalTick, 50);
      timer.unref?.();
    }
  }
  let normalSince = 0;
  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function slowTick() {
    timer = null;
    if (ended || failed || overflowReported) return;
    if (!slowSince) slowSince = Date.now();
    const drained = Number(res.writableLength || 0) < Number(softBytes);
    if (drained) {
      slowSince = 0;
      if (pendingBytes) {
        timer = setTimeout(slowTick, 200);
        timer.unref?.();
      }
      return;
    }
    observe();
    if (!failed && !overflowReported) {
      timer = setTimeout(slowTick, 200);
      timer.unref?.();
    }
  }
  function tick() {
    timer = null;
    if (!ended && !failed) {
      observe();
      if (!failed && backpressureSeen) {
        timer = setTimeout(tick, 250);
        timer.unref?.();
      }
    }
  }

  function writeEvent(event) {
    return writeRaw(encodeSseEvent(event.type, event.data));
  }

  function writeData(data) {
    return writeRaw(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }

  function writeComment(text) {
    const safe = String(text || 'canceled').replace(/[\r\n]+/g, ' ');
    return writeRaw(`: ${safe}\n\n`);
  }

  function end() {
    stopTimer();
    if (ended || failed) return false;
    if (!canWrite()) {
      ended = true;
      return false;
    }
    ended = true;
    try {
      res.end();
      return !failed;
    } catch (error) {
      markFailure(error);
      return false;
    }
  }

  return {
    writeEvent,
    writeEvents(events) {
      for (const event of events) if (!writeEvent(event)) return false;
      return true;
    },
    writeData,
    writeComment,
    writeRaw,
    end,
    fail(error) {
      stopTimer();
      failed ||= error;
      ended = true;
      if (!res.destroyed && typeof res.destroy === 'function') {
        try {
          res.destroy(error);
        } catch (destroyError) {
          failed ||= destroyError;
        }
      }
    },
    stats() {
      return {
        peakWritableLength,
        peakPendingBytes,
        pendingBytes,
        backpressureSeen,
        failedCode: failed?.code || null,
      };
    },
    get ended() {
      return ended;
    },
    get failed() {
      return failed;
    },
  };
}

export async function withTimeout(promise, milliseconds, message = 'operation timed out') {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' }));
        }, milliseconds);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
