import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const WS_PING_MS = 15000;
export const WS_PONG_GRACE_MS = 10000;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function closePayload(code = 1000, reason = '') {
  const text = Buffer.from(String(reason));
  const body = Buffer.alloc(Math.min(2 + text.length, 123));
  body.writeUInt16BE(code, 0);
  text.copy(body, 2, 0, body.length - 2);
  return body;
}

function transportError(ws, error) {
  try {
    ws.onError?.(error);
  } catch {
    // Closing remains required even when the observer throws.
  }
}

export function createWebSocketTransport(socket, {
  onMessage = null,
  onClose = null,
  pingMs = WS_PING_MS,
  pongGraceMs = WS_PONG_GRACE_MS,
  observer = false,
  requireClientPong = false,
} = {}) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentBytes = 0;
  let open = true;
  let closedNotified = false;
  let pingTimerRef = null;
  let lastPongAt = 0;
  let peerClose = false;
  let pongWaiters = [];

  function deliverText(value) {
    if (!onMessage) return;
    let message;
    try {
      message = JSON.parse(value);
    } catch {
      send({ type: 'error', error: { code: 'invalid_json', message: 'WebSocket frame must be JSON' } });
      return;
    }
    try {
      onMessage(message);
    } catch (error) {
      transportError(ws, error);
    }
  }

  function acceptFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      peerClose = true;
      if (!socket.destroyed) {
        try {
          socket.write(frame(0x8, payload.length ? payload : closePayload(1000, 'closed')));
        } catch {
          // The peer may have reset between the frame and the acknowledgement.
        }
      }
      finish('peer_close', { graceful: true });
      return;
    }
    if (opcode === 0x9) {
      if (!socket.destroyed && socket.writable) {
        try {
          socket.write(frame(0xA, payload));
        } catch (error) {
          transportError(ws, error);
        }
      }
      return;
    }
    if (opcode === 0xA) {
      lastPongAt = Date.now();
      if (!observer) {
        for (const waiter of pongWaiters.splice(0)) waiter();
      }
      return;
    }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (!observer) return;
      fragments.push(payload);
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_MESSAGE_BYTES) {
        close(1009, 'message too large');
        finish('message_too_large');
        return;
      }
      if (!fin) return;
      const full = Buffer.concat(fragments);
      fragments = [];
      fragmentBytes = 0;
      try {
        deliverText(full.toString('utf8'));
      } catch (error) {
        transportError(ws, error);
      }
    }
  }

  function consume() {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          close(1009, 'message too large');
          finish('message_too_large');
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const mask = masked ? buffer.subarray(maskOffset, maskOffset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      buffer = buffer.subarray(offset + length);
      try {
        acceptFrame(first & 0x0f, (first & 0x80) !== 0, payload);
      } catch (error) {
        transportError(ws, error);
        finish('protocol_error');
        return;
      }
      if (!open) return;
    }
  }

  function onData(chunk) {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : Buffer.from(chunk);
    consume();
  }

  function clearHeartbeat() {
    clearTimeout(pingTimerRef);
    pingTimerRef = null;
    pongWaiters = [];
  }

  function finish(kind, info = {}) {
    if (closedNotified) return;
    closedNotified = true;
    if (open) {
      open = false;
      clearHeartbeat();
      socket.off?.('data', onData);
      if (!socket.destroyed) {
        try {
          socket.destroy();
        } catch {
          // Socket teardown is idempotent for the transport contract.
        }
      }
    }
    try {
      onClose?.({ kind, ...info });
    } catch {
      // Cancellation is not allowed to fail during teardown.
    }
  }

  function send(message) {
    if (!open || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(frame(0x1, JSON.stringify(message)));
      return true;
    } catch (error) {
      transportError(ws, error);
      return false;
    }
  }

  function close(code = 1000, reason = 'closed') {
    if (!open) return;
    if (!socket.destroyed && socket.writable) {
      try {
        socket.write(frame(0x8, closePayload(code, reason)));
      } catch (error) {
        transportError(ws, error);
      }
    }
    open = false;
    clearHeartbeat();
    socket.end();
  }

  function ping() {
    if (!socket.destroyed && socket.writable && open) {
      try {
        socket.write(frame(0x9, Buffer.alloc(0)));
        return true;
      } catch (error) {
        transportError(ws, error);
      }
    }
    return false;
  }

  function startHeartbeat() {
    if (!canHeartbeat()) return;
    pingTimerRef = setTimeout(hb, pingMs);
    pingTimerRef.unref?.();
  }

  function canHeartbeat() {
    return Boolean(pingMs && pingMs > 0 && !pingTimerRef && open
      && (requireClientPong || observer));
  }

  function hb() {
    pingTimerRef = null;
    if (!open) return;
    if (pongWaiters.length) return;
    lastPongAt = 0;
    const sent = ping();
    if (!sent) {
      finish('transport_write_failed');
      return;
    }
    const grace = setTimeout(() => {
      if (open && !lastPongAt) finish('heartbeat_timeout');
    }, pongGraceMs);
    grace.unref?.();
    if (!requireClientPong) {
      // The MCP transport has no Responses lease to protect. Autopong remains
      // a connectivity probe, while a Responses observer must prove liveness.
      lastPongAt = Date.now();
      clearTimeout(grace);
    } else {
      const waitForPong = new Promise((resolve) => {
        pongWaiters.push(resolve);
      });
      waitForPong.then(() => clearTimeout(grace));
    }
    startNext();
  }

  function startNext() {
    if (!canHeartbeat()) return;
    pingTimerRef = setTimeout(hb, pingMs);
    pingTimerRef.unref?.();
  }

  const ws = {
    send,
    sendNotification(message) {
      if (!message?.method) return false;
      return send({ jsonrpc: '2.0', method: message.method, params: message.params || {} });
    },
    ping,
    close,
    terminate() {
      finish('terminated');
    },
    finish,
    onError(error) {
      transportError(ws, error);
    },
    get readyState() {
      return open ? 1 : 3;
    },
    get open() {
      return open;
    },
    get peerClose() {
      return peerClose;
    },
  };

  socket.setNoDelay?.(true);
  socket.on('data', onData);
  socket.once('close', () => finish('socket_close'));
  socket.once('end', () => finish('socket_end'));
  socket.once('error', () => finish('socket_error'));
  startHeartbeat();
  return ws;
}

export function assertHandshake(req) {
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    throw new Error('invalid websocket handshake');
  }
  return createHash('sha1').update(key + GUID).digest('base64');
}
