export function encodeSseEvent(event, data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  return `event: ${event}\ndata: ${payload}\n\n`;
}

export function createSseParser() {
  const decoder = new TextDecoder('utf-8');
  let textBuffer = '';
  let eventName = '';
  let dataLines = [];

  function dispatch(events) {
    if (dataLines.length) {
      const raw = dataLines.join('\n');
      let data = raw;
      if (raw.startsWith('{') || raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            Object.defineProperty(parsed, 'toString', {
              configurable: true,
              enumerable: false,
              value: () => raw,
            });
            data = parsed;
          }
        } catch {
          // Keep malformed JSON as raw data so the caller can surface a protocol error.
        }
      }
      events.push({
        event: eventName || 'message',
        data,
      });
    }
    eventName = '';
    dataLines = [];
  }

  function consumeLines(events, final = false) {
    let newline;
    while ((newline = textBuffer.search(/\r\n|\n|\r/)) >= 0) {
      // A network chunk may end between CR and LF. Holding the trailing CR
      // prevents an empty-line dispatch from clearing the current event name.
      if (!final && textBuffer[newline] === '\r' && newline === textBuffer.length - 1) break;
      const separatorLength = textBuffer.startsWith('\r\n', newline) ? 2 : 1;
      let line = textBuffer.slice(0, newline);
      textBuffer = textBuffer.slice(newline + separatorLength);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        dispatch(events);
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
      }
    }
    if (final) {
      if (textBuffer.endsWith('\r')) textBuffer = textBuffer.slice(0, -1);
      if (textBuffer) {
        const colon = textBuffer.indexOf(':');
        const field = colon < 0 ? textBuffer : textBuffer.slice(0, colon);
        let value = colon < 0 ? '' : textBuffer.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'event') eventName = value;
        else if (field === 'data') dataLines.push(value);
        textBuffer = '';
      }
      dispatch(events);
    }
  }

  const parser = {
    feed(chunk) {
      const events = [];
      textBuffer += typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
      consumeLines(events);
      Object.defineProperty(events, 'finished', {
        configurable: true,
        enumerable: false,
        value: () => [...events, ...parser.finished()],
      });
      return events;
    },

    finished() {
      const events = [];
      textBuffer += decoder.decode();
      consumeLines(events, true);
      return events;
    },
  };
  return parser;
}
