import { encodeSseEvent } from './sse.js';
import { warn } from './log.js';

export const PRODUCTION_KEEPALIVE_MS = Object.freeze(15000);
export const SOFT_WRITE_BYTES = 256 * 1024;
export const HARD_WRITE_BYTES = 1024 * 1024;
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

export function protocolIncompleteReason(finishReason, requestedLimit, atLimit = false) {
  if (finishReason !== 'length') return null;
  return requestedLimit && atLimit ? 'max_output_tokens' : UPSTREAM_LENGTH_LIMIT;
}

export function createHttpEventWriter(res, {
  protocol = 'openai',
  softBytes = SOFT_WRITE_BYTES,
  hardBytes = HARD_WRITE_BYTES,
  onOverflow = null,
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
      ended = true;
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
      const accepted = res.write(raw, () => {
        pendingBytes = Math.max(0, pendingBytes - length);
        if (!pendingBytes) {
          oldestPendingAt = 0;
          slowSince = 0;
        }
      });
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
      failed ||= error;
      stopTimer();
      ended = true;
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
      return true;
    } catch (error) {
      failed ||= error;
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
